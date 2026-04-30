const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database');
const { requireRole } = require('../middleware/auth');

router.get('/', requireRole('admin'), (req, res) => {
  const users = db.query('SELECT id, username, role, active FROM users ORDER BY id');
  res.json(users);
});

router.post('/', requireRole('admin'), (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: '必須項目が未入力です' });
  const hash = bcrypt.hashSync(password, 10);
  db.run('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)', [username, hash, role || 'staff']);
  res.json({ ok: true });
});

router.put('/:id', requireRole('admin'), (req, res) => {
  const { username, role, active, password } = req.body;
  db.run('UPDATE users SET username=?, role=?, active=? WHERE id=?',
    [username, role, active ?? 1, req.params.id]);
  if (password) {
    const hash = bcrypt.hashSync(password, 10);
    db.run('UPDATE users SET password_hash=? WHERE id=?', [hash, req.params.id]);
  }
  res.json({ ok: true });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  if (req.session.user.id == req.params.id)
    return res.status(400).json({ error: '自分自身は削除できません' });
  db.run('DELETE FROM users WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
