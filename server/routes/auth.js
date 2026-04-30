const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database');

router.get('/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: '未ログイン' });
  res.json(req.session.user);
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.query('SELECT * FROM users WHERE username=? AND active=1', [username])[0];
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });

  req.session.user = { id: user.id, username: user.username, role: user.role };
  res.json(req.session.user);
});

router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

module.exports = router;
