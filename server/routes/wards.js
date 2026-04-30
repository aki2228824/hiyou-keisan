const express = require('express');
const router = express.Router();
const db = require('../database');

router.get('/', (req, res) => {
  const rows = db.query('SELECT * FROM wards ORDER BY id');
  res.json(rows);
});

router.post('/', (req, res) => {
  const { name } = req.body;
  db.run('INSERT INTO wards (name) VALUES (?)', [name]);
  res.json({ ok: true });
});

router.put('/:id', (req, res) => {
  const { name } = req.body;
  db.run('UPDATE wards SET name=? WHERE id=?', [name, req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
