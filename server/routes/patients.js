const express = require('express');
const router = express.Router();
const db = require('../database');
const { requireRole } = require('../middleware/auth');
const { toPositiveInt, isPlainValue, parseYearMonth } = require('../services/prices');

// 実在する病棟のIDなら数値で返す。存在しなければ null
function findWardId(ward_id) {
  const id = toPositiveInt(ward_id);
  return id !== null && db.query('SELECT id FROM wards WHERE id=?', [id])[0] ? id : null;
}

router.get('/', (req, res) => {
  const { ward_id, activity_year, activity_month } = req.query;
  if (!isPlainValue(ward_id) || !isPlainValue(activity_year) || !isPlainValue(activity_month))
    return res.status(400).json({ error: '検索条件の指定が正しくありません' });

  // ?activity_year=YYYY&activity_month=M を付けると、その月に実績（数量が 1 以上の日用品、または食事・加算・
  // サービス提供の状況の入力）がある患者に has_records = 1 を付けて返す。
  // 月次集計で、無効にした患者（退院など）のうち、その月に実績がある人を出すために使う
  let activity = '';
  const params = [];
  if ((activity_year ?? '') !== '' || (activity_month ?? '') !== '') {
    const ym = parseYearMonth(activity_year, activity_month);
    if (ym.error) return res.status(400).json({ error: '年月の指定が正しくありません' });
    const from = `${ym.year}-${String(ym.month).padStart(2, '0')}-01`;
    const to = `${ym.year}-${String(ym.month).padStart(2, '0')}-31`;
    activity = `,
      (EXISTS (SELECT 1 FROM records r WHERE r.patient_id=p.id AND r.record_date BETWEEN ? AND ? AND r.quantity > 0)
       OR EXISTS (SELECT 1 FROM meal_records m WHERE m.patient_id=p.id AND m.record_date BETWEEN ? AND ?
                  AND (m.breakfast > 0 OR m.lunch > 0 OR m.dinner > 0 OR m.hospital_addition > 0 OR m.hospital_special > 0
                       OR COALESCE(m.service_status, '') <> ''))) AS has_records`;
    params.push(from, to, from, to);
  }
  let sql = `SELECT p.*, w.name as ward_name${activity} FROM patients p JOIN wards w ON p.ward_id=w.id`;
  if (ward_id) { sql += ' WHERE p.ward_id=?'; params.push(ward_id); }
  sql += ' ORDER BY w.id, p.name';
  res.json(db.query(sql, params));
});

router.post('/', requireRole('admin'), (req, res) => {
  const { ward_id, name, room, beneficiary_no } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: '氏名は必須です' });
  const wardId = findWardId(ward_id);
  if (wardId === null) return res.status(400).json({ error: '病棟の指定が正しくありません' });
  db.run('INSERT INTO patients (ward_id, name, room, beneficiary_no) VALUES (?,?,?,?)',
    [wardId, String(name).trim(), room || '', beneficiary_no || '']);
  res.json({ ok: true });
});

router.put('/:id', requireRole('admin'), (req, res) => {
  const { ward_id, name, room, beneficiary_no, active } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: '氏名は必須です' });
  if (!db.query('SELECT id FROM patients WHERE id=?', [req.params.id])[0])
    return res.status(404).json({ error: '患者が見つかりません' });
  const wardId = findWardId(ward_id);
  if (wardId === null) return res.status(400).json({ error: '病棟の指定が正しくありません' });
  db.run('UPDATE patients SET ward_id=?, name=?, room=?, beneficiary_no=?, active=? WHERE id=?',
    [wardId, String(name).trim(), room || '', beneficiary_no || '', active ?? 1, req.params.id]);
  res.json({ ok: true });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const id = req.params.id;
  const target = db.query('SELECT id, name FROM patients WHERE id=?', [id])[0];
  if (!target) return res.status(404).json({ error: '患者が見つかりません' });
  // 関連データごと「全部消す／何も消さない」のどちらかにする（途中で止まって一部だけ消えた状態を残さない）
  db.transaction(() => {
    db.run('DELETE FROM records WHERE patient_id=?', [id]);
    db.run('DELETE FROM meal_records WHERE patient_id=?', [id]);
    db.run('DELETE FROM patient_meal_prices WHERE patient_id=?', [id]);
    db.run('DELETE FROM patients WHERE id=?', [id]);
  });
  // 操作ログに、削除した患者の氏名を残す（削除後は患者IDから氏名を引けなくなるため）
  res.locals.auditDetail = { name: target.name };
  res.json({ ok: true });
});

module.exports = router;
