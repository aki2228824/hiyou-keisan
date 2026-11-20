const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database');
const { requireRole } = require('../middleware/auth');

const ROLES = ['admin', 'staff', 'viewer'];

// 指定ユーザー以外に、有効な管理者が残っているか
function hasOtherActiveAdmin(exceptId) {
  const row = db.query("SELECT COUNT(*) as cnt FROM users WHERE role='admin' AND active=1 AND id<>?", [exceptId])[0];
  return (row?.cnt ?? 0) > 0;
}

router.get('/', requireRole('admin'), (req, res) => {
  const users = db.query('SELECT id, username, role, active FROM users ORDER BY id');
  res.json(users);
});

router.post('/', requireRole('admin'), (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: '必須項目が未入力です' });
  if (role != null && !ROLES.includes(role))
    return res.status(400).json({ error: 'ロールの指定が正しくありません' });
  const hash = bcrypt.hashSync(String(password), 10);
  db.run('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)', [username, hash, role || 'staff']);
  res.json({ ok: true });
});

router.put('/:id', requireRole('admin'), (req, res) => {
  const { username, role, active, password } = req.body;
  if (!username || !String(username).trim())
    return res.status(400).json({ error: 'ユーザーIDは必須です' });
  if (!ROLES.includes(role))
    return res.status(400).json({ error: 'ロールの指定が正しくありません' });

  const target = db.query('SELECT id FROM users WHERE id=?', [req.params.id])[0];
  if (!target) return res.status(404).json({ error: 'ユーザーが見つかりません' });

  // 有効な管理者が1人もいなくなる変更は不可
  const newActive = Number(active ?? 1) ? 1 : 0;
  if ((role !== 'admin' || !newActive) && !hasOtherActiveAdmin(target.id))
    return res.status(400).json({ error: '有効な管理者が1人もいなくなるため変更できません' });

  db.run('UPDATE users SET username=?, role=?, active=? WHERE id=?',
    [String(username).trim(), role, newActive, target.id]);
  if (password) {
    const hash = bcrypt.hashSync(String(password), 10);
    db.run('UPDATE users SET password_hash=? WHERE id=?', [hash, target.id]);
  }
  res.json({ ok: true });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  if (req.session.user.id == req.params.id)
    return res.status(400).json({ error: '自分自身は削除できません' });
  if (!db.query('SELECT id FROM users WHERE id=?', [req.params.id])[0])
    return res.status(404).json({ error: 'ユーザーが見つかりません' });
  if (!hasOtherActiveAdmin(req.params.id))
    return res.status(400).json({ error: '有効な管理者が1人もいなくなるため削除できません' });
  db.run('DELETE FROM users WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
