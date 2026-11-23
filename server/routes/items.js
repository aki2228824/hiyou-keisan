const express = require('express');
const router = express.Router();
const db = require('../database');
const { getItemPriceMap, toPrice, toPositiveInt, parseYearMonth, isPlainValue } = require('../services/prices');
const { requireRole } = require('../middleware/auth');

router.get('/', (req, res) => {
  res.json(db.query('SELECT * FROM items ORDER BY sort_order, id'));
});

router.post('/', requireRole('admin'), (req, res) => {
  const { name, sort_order } = req.body;
  if (typeof name !== 'string' || !name.trim())
    return res.status(400).json({ error: '物品名は必須です' });
  const maxSort = db.query('SELECT MAX(sort_order) as m FROM items')[0]?.m ?? 0;
  db.run('INSERT INTO items (name, sort_order) VALUES (?,?)', [name.trim(), sort_order ?? maxSort + 1]);
  res.json({ ok: true });
});

router.put('/:id', requireRole('admin'), (req, res) => {
  const { name, sort_order, active } = req.body;
  if (typeof name !== 'string' || !name.trim())
    return res.status(400).json({ error: '物品名は必須です' });
  if (!db.query('SELECT id FROM items WHERE id=?', [req.params.id])[0])
    return res.status(404).json({ error: '物品が見つかりません' });
  db.run('UPDATE items SET name=?, sort_order=?, active=? WHERE id=?',
    [name.trim(), sort_order ?? 0, active ?? 1, req.params.id]);
  res.json({ ok: true });
});

// 単価一覧取得（指定月になければ直近の設定を引き継ぐ）
router.get('/prices', (req, res) => {
  const { year, month } = req.query;
  if (![year, month].every(isPlainValue))
    return res.status(400).json({ error: '検索条件の指定が正しくありません' });
  const priceMap = getItemPriceMap(year, month);
  const rows = db.query('SELECT id, name, sort_order, active FROM items ORDER BY sort_order, id')
    .map(r => ({ ...r, unit_price: priceMap[r.id] ?? 0 }));
  res.json(rows);
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const id = req.params.id;
  const target = db.query('SELECT id, name FROM items WHERE id=?', [id])[0];
  if (!target) return res.status(404).json({ error: '物品が見つかりません' });
  // 関連データごと「全部消す／何も消さない」のどちらかにする（途中で止まって一部だけ消えた状態を残さない）
  db.transaction(() => {
    db.run('DELETE FROM records WHERE item_id=?', [id]);
    db.run('DELETE FROM prices WHERE item_id=?', [id]);
    db.run('DELETE FROM items WHERE id=?', [id]);
  });
  res.locals.auditDetail = { name: target.name };   // 操作ログに、削除した物品名を残す
  res.json({ ok: true });
});

// 単価を設定（UPSERT）
router.post('/prices', requireRole('admin'), (req, res) => {
  const { item_id, year, month, unit_price } = req.body;

  // 入力チェック（不正なリクエストは例外にせず 400 で返す）
  const itemId = toPositiveInt(item_id);
  if (itemId === null || !db.query('SELECT id FROM items WHERE id=?', [itemId])[0])
    return res.status(400).json({ error: '登録されていない物品です' });
  const ym = parseYearMonth(year, month);
  if (ym.error) return res.status(400).json({ error: ym.error });
  // 実績と同じく、ありえない年（年を打っている途中の 0002 年など）には保存しない
  if (ym.year < 2000 || ym.year > 2100) return res.status(400).json({ error: 'year が正しくありません' });
  const price = unit_price == null || unit_price === '' ? null : toPrice(unit_price);
  if (price === null)
    return res.status(400).json({ error: '単価は、0〜9,999,999 の整数（円）で入力してください（小数は使えません）' });

  db.run(`
    INSERT INTO prices (item_id, year, month, unit_price) VALUES (?,?,?,?)
    ON CONFLICT(item_id, year, month) DO UPDATE SET unit_price=excluded.unit_price
  `, [itemId, ym.year, ym.month, price]);
  res.json({ ok: true });
});

module.exports = router;
