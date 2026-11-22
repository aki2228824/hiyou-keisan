const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database');
const lockout = require('../services/loginLockout');
const passwordPolicy = require('../services/passwordPolicy');
const { requireRole, passwordMark } = require('../middleware/auth');

const ROLES = ['admin', 'staff', 'viewer'];
const MAX_USERNAME = 64;   // ログイン側（routes/auth.js）も、これより長いIDは受け付けない

// 指定ユーザー以外に、有効な管理者が残っているか
function hasOtherActiveAdmin(exceptId) {
  const row = db.query("SELECT COUNT(*) as cnt FROM users WHERE role='admin' AND active=1 AND id<>?", [exceptId])[0];
  return (row?.cnt ?? 0) > 0;
}

// ユーザーIDの入力チェック。問題があればエラーメッセージ、無ければ null
function checkUsername(name) {
  if (!name) return 'ユーザーIDは必須です';
  if (name.length > MAX_USERNAME) return `ユーザーIDは${MAX_USERNAME}文字以内にしてください`;
  if (/[\x00-\x1f\x7f]/.test(name)) return 'ユーザーIDに使えない文字が含まれています';
  return null;
}

router.get('/', requireRole('admin'), (req, res) => {
  // locked_seconds: ログイン失敗の連続でロック中なら、解除までの残り秒数（ロックされていなければ 0）
  const users = db.query('SELECT id, username, role, active FROM users ORDER BY id')
    // locked_everywhere: true = どのPCからもログインできない / false = 一部のPC（接続元）だけがロック中
    .map(u => ({ ...u, locked_seconds: lockout.lockedSeconds(u.username), locked_everywhere: lockout.lockedEverywhere(u.username) }));
  res.json(users);
});

// パスワードの基準とロックの設定（ユーザー管理の画面に説明を出すため）
router.get('/password-policy', requireRole('admin'), (req, res) => {
  res.json({
    min_length: passwordPolicy.minLength(),
    description: passwordPolicy.describe(),
    max_failures: lockout.maxFailures,       // 同じ接続元（PC）から続けて失敗できる回数
    global_failures: lockout.globalLimit,    // すべての接続元の合計で、この回数に達するとどこからも入れなくなる
    lock_minutes: lockout.lockMinutes,
  });
});

router.post('/', requireRole('admin'), (req, res) => {
  const { username, password, role } = req.body;
  const name = typeof username === 'string' ? username.trim() : '';
  if (!name || typeof password !== 'string' || !password)
    return res.status(400).json({ error: '必須項目が未入力です' });
  const nameError = checkUsername(name);
  if (nameError) return res.status(400).json({ error: nameError });
  if (role != null && !ROLES.includes(role))
    return res.status(400).json({ error: 'ロールの指定が正しくありません' });
  const weak = passwordPolicy.check(password, { username: name });
  if (weak.length) return res.status(400).json({ error: passwordPolicy.errorMessage(weak) });

  const hash = bcrypt.hashSync(password, 10);
  db.run('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)', [name, hash, role || 'staff']);
  res.json({ ok: true });
});

router.put('/:id', requireRole('admin'), (req, res) => {
  const { username, role, active, password } = req.body;
  const name = typeof username === 'string' ? username.trim() : '';
  const nameError = checkUsername(name);
  if (nameError) return res.status(400).json({ error: nameError });
  if (!ROLES.includes(role))
    return res.status(400).json({ error: 'ロールの指定が正しくありません' });
  // オブジェクトや配列を Number() に渡すと例外になることがある（{ toString: 1 } など）ので、先に断る
  if (active != null && typeof active === 'object')
    return res.status(400).json({ error: '状態の指定が正しくありません' });

  const target = db.query('SELECT id, username, password_hash FROM users WHERE id=?', [req.params.id])[0];
  if (!target) return res.status(404).json({ error: 'ユーザーが見つかりません' });

  // 有効な管理者が1人もいなくなる変更は不可
  const newActive = Number(active ?? 1) ? 1 : 0;
  if ((role !== 'admin' || !newActive) && !hasOtherActiveAdmin(target.id))
    return res.status(400).json({ error: '有効な管理者が1人もいなくなるため変更できません' });

  // パスワードは、入力されたときだけ変更する。基準を満たさないものは登録しない
  let hash = null;
  if (password != null && password !== '') {
    if (typeof password !== 'string')
      return res.status(400).json({ error: 'パスワードの指定が正しくありません' });
    const weak = passwordPolicy.check(password, { username: name });
    if (!weak.length && bcrypt.compareSync(password, target.password_hash))
      weak.push('現在のパスワードと同じです。別のパスワードにしてください');
    if (weak.length) return res.status(400).json({ error: passwordPolicy.errorMessage(weak) });
    hash = bcrypt.hashSync(password, 10);
  }

  // ユーザー情報とパスワードの変更をひとまとまりで確定する（ID重複などで失敗したら両方とも変更しない）
  db.transaction(() => {
    db.run('UPDATE users SET username=?, role=?, active=? WHERE id=?', [name, role, newActive, target.id]);
    if (hash) db.run('UPDATE users SET password_hash=? WHERE id=?', [hash, target.id]);
  });

  if (hash) {
    // パスワードを決め直したら、ログイン失敗によるロックも解除する
    lockout.unlock(target.username);
    lockout.unlock(name);
    // そのユーザーの、古いパスワードでログインした画面は次の操作から使えなくなる（middleware/auth.js）。
    // 管理者が自分自身のパスワードを変えた場合だけは、いま操作しているこの画面を引き続き使えるようにする
    if (target.id === req.session.user.id) req.session.user.pw = passwordMark(hash);
  }
  res.json({ ok: true });
});

// ログイン失敗の連続によるロックを、管理者が解除する
router.post('/:id/unlock', requireRole('admin'), (req, res) => {
  const target = db.query('SELECT id, username FROM users WHERE id=?', [req.params.id])[0];
  if (!target) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  const wasLocked = lockout.unlock(target.username);
  res.locals.auditDetail = { username: target.username, was_locked: wasLocked };
  res.json({ ok: true, was_locked: wasLocked });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  if (req.session.user.id == req.params.id)
    return res.status(400).json({ error: '自分自身は削除できません' });
  const target = db.query('SELECT id, username FROM users WHERE id=?', [req.params.id])[0];
  if (!target) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  if (!hasOtherActiveAdmin(req.params.id))
    return res.status(400).json({ error: '有効な管理者が1人もいなくなるため削除できません' });
  db.run('DELETE FROM users WHERE id=?', [req.params.id]);
  res.locals.auditDetail = { username: target.username };   // 操作ログに、削除したユーザーIDを残す
  res.json({ ok: true });
});

module.exports = router;
