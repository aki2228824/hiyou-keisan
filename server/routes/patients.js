const express = require('express');
const router = express.Router();
const db = require('../database');
const { requireRole } = require('../middleware/auth');
const { toPositiveInt } = require('../services/prices');

// 実在する病棟のIDなら数値で返す。存在しなければ null
function findWardId(ward_id) {
  const id = toPositiveInt(ward_id);
  return id !== null && db.query('SELECT id FROM wards WHERE id=?', [id])[0] ? id : null;
}

router.get('/', (req, res) => {
  const { ward_id } = req.query;
  let sql = `SELECT p.*, w.name as ward_name FROM patients p JOIN wards w ON p.ward_id=w.id`;
  const params = [];
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
  if (!db.query('SELECT id FROM patients WHERE id=?', [id])[0])
    return res.status(404).json({ error: '患者が見つかりません' });
  db.run('DELETE FROM records WHERE patient_id=?', [id]);
  db.run('DELETE FROM meal_records WHERE patient_id=?', [id]);
  db.run('DELETE FROM patient_meal_prices WHERE patient_id=?', [id]);
  db.run('DELETE FROM patients WHERE id=?', [id]);
  res.json({ ok: true });
});

module.exports = router;
