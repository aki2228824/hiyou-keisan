const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database');
const { loadSessionUser } = require('../middleware/auth');

router.get('/me', (req, res) => {
  // 無効化・削除されたユーザーは未ログイン扱い、ロール変更は最新を返す
  const user = loadSessionUser(req);
  if (!user) return res.status(401).json({ error: '未ログイン' });
  res.json(user);
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password)
    return res.status(400).json({ error: 'ユーザー名とパスワードを入力してください' });

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
