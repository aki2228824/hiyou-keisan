const express = require('express');
const router = express.Router();
const db = require('../database');
const { requireRole } = require('../middleware/auth');

router.get('/', (req, res) => {
  const rows = db.query('SELECT * FROM wards ORDER BY id');
  res.json(rows);
});

router.post('/', requireRole('admin'), (req, res) => {
  const { name } = req.body;
  if (typeof name !== 'string' || !name.trim())
    return res.status(400).json({ error: '病棟名は必須です' });
  db.run('INSERT INTO wards (name) VALUES (?)', [name.trim()]);
  res.json({ ok: true });
});

router.put('/:id', requireRole('admin'), (req, res) => {
  const { name } = req.body;
  if (typeof name !== 'string' || !name.trim())
    return res.status(400).json({ error: '病棟名は必須です' });
  db.run('UPDATE wards SET name=? WHERE id=?', [name.trim(), req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
