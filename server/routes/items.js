const express = require('express');
const router = express.Router();
const db = require('../database');
const { getItemPriceMap, toPrice, toPositiveInt, parseYearMonth } = require('../services/prices');
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
  const priceMap = getItemPriceMap(year, month);
  const rows = db.query('SELECT id, name, sort_order, active FROM items ORDER BY sort_order, id')
    .map(r => ({ ...r, unit_price: priceMap[r.id] ?? 0 }));
  res.json(rows);
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const id = req.params.id;
  if (!db.query('SELECT id FROM items WHERE id=?', [id])[0])
    return res.status(404).json({ error: '物品が見つかりません' });
  db.run('DELETE FROM records WHERE item_id=?', [id]);
  db.run('DELETE FROM prices WHERE item_id=?', [id]);
  db.run('DELETE FROM items WHERE id=?', [id]);
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
  const price = unit_price == null || unit_price === '' ? null : toPrice(unit_price);
  if (price === null)
    return res.status(400).json({ error: '単価は0以上の数値で指定してください' });

  db.run(`
    INSERT INTO prices (item_id, year, month, unit_price) VALUES (?,?,?,?)
    ON CONFLICT(item_id, year, month) DO UPDATE SET unit_price=excluded.unit_price
  `, [itemId, ym.year, ym.month, price]);
  res.json({ ok: true });
});

module.exports = router;
