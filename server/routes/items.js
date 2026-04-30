const express = require('express');
const router = express.Router();
const db = require('../database');

router.get('/', (req, res) => {
  res.json(db.query('SELECT * FROM items ORDER BY sort_order, id'));
});

router.post('/', (req, res) => {
  const { name, sort_order } = req.body;
  const maxSort = db.query('SELECT MAX(sort_order) as m FROM items')[0]?.m ?? 0;
  db.run('INSERT INTO items (name, sort_order) VALUES (?,?)', [name, sort_order ?? maxSort + 1]);
  res.json({ ok: true });
});

router.put('/:id', (req, res) => {
  const { name, sort_order, active } = req.body;
  db.run('UPDATE items SET name=?, sort_order=?, active=? WHERE id=?',
    [name, sort_order, active ?? 1, req.params.id]);
  res.json({ ok: true });
});

// 単価一覧取得
router.get('/prices', (req, res) => {
  const { year, month } = req.query;
  const rows = db.query(`
    SELECT i.id, i.name, i.sort_order, i.active,
           COALESCE(p.unit_price, 0) as unit_price
    FROM items i
    LEFT JOIN prices p ON p.item_id=i.id AND p.year=? AND p.month=?
    ORDER BY i.sort_order, i.id
  `, [year, month]);
  res.json(rows);
});

// 単価を設定（UPSERT）
router.post('/prices', (req, res) => {
  const { item_id, year, month, unit_price } = req.body;
  db.run(`
    INSERT INTO prices (item_id, year, month, unit_price) VALUES (?,?,?,?)
    ON CONFLICT(item_id, year, month) DO UPDATE SET unit_price=excluded.unit_price
  `, [item_id, year, month, unit_price]);
  res.json({ ok: true });
});

module.exports = router;
