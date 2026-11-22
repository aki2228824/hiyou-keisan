const crypto = require('crypto');
const db = require('../database');

// パスワード（のハッシュ）の目印。ログインしたときにセッションへ控えておき、あとでパスワードが変更されたら
// （＝目印が変わったら）、そのログイン状態を無効にする。漏れたかもしれないパスワードを変えたのに、
// 古いパスワードでログインした画面がそのまま使い続けられる、ということを防ぐ。
function passwordMark(hash) {
  return crypto.createHash('sha256').update(String(hash)).digest('hex').slice(0, 16);
}

// セッションのユーザーを毎回DBで確認し直す。
// ログイン後に無効化・削除・ロール変更されたユーザーへ、すぐに反映させるため。
function loadSessionUser(req) {
  const sessionUser = req.session?.user;
  if (!sessionUser) return null;
  if (req.userChecked) return sessionUser; // 同じリクエスト内での再確認は省略

  const row = db.query('SELECT username, role, active, password_hash FROM users WHERE id=?', [sessionUser.id])[0];
  if (!row || !row.active || (sessionUser.pw && sessionUser.pw !== passwordMark(row.password_hash))) {
    delete req.session.user;
    return null;
  }
  sessionUser.username = row.username;
  sessionUser.role = row.role;
  req.userChecked = true;
  return sessionUser;
}

function requireAuth(req, res, next) {
  if (!loadSessionUser(req)) return res.status(401).json({ error: 'ログインが必要です' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    const user = loadSessionUser(req);
    if (!user) return res.status(401).json({ error: 'ログインが必要です' });
    if (!roles.includes(user.role))
      return res.status(403).json({ error: '権限がありません' });
    next();
  };
}

module.exports = { requireAuth, requireRole, loadSessionUser, passwordMark };
