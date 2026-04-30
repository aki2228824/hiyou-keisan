const express = require('express');
const router = express.Router();
const db = require('../database');
const { requireRole } = require('../middleware/auth');

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
  db.run('INSERT INTO patients (ward_id, name, room, beneficiary_no) VALUES (?,?,?,?)',
    [ward_id, name, room || '', beneficiary_no || '']);
  res.json({ ok: true });
});

router.put('/:id', requireRole('admin'), (req, res) => {
  const { ward_id, name, room, beneficiary_no, active } = req.body;
  db.run('UPDATE patients SET ward_id=?, name=?, room=?, beneficiary_no=?, active=? WHERE id=?',
    [ward_id, name, room || '', beneficiary_no || '', active ?? 1, req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
