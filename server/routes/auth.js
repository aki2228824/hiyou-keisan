const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../database');
const audit = require('../services/auditLog');
const lockout = require('../services/loginLockout');
const passwordPolicy = require('../services/passwordPolicy');
const { loadSessionUser } = require('../middleware/auth');

const MAX_USERNAME = 64;    // これより長い入力は照合せずに断る（ユーザー管理でも64文字までしか登録できない）
const MAX_PASSWORD = 200;

// 実在しない（または無効の）ユーザーIDのときに照合する、だれのものでもないハッシュ。
// 実在するIDのときだけ照合に時間がかかると、応答の速さから「そのIDが実在するか」が分かってしまうため。
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

const lockedMessage = seconds =>
  `このユーザーIDは、ログインに続けて失敗したため一時的にロックされています。約${Math.ceil(seconds / 60)}分後にもう一度お試しください。`;

// ログインの失敗は、未ログインの人が好きなだけ起こせる。audit.record() は、未ログインの要求の記録が1分間に
// 一定の件数を超えると、超えた分を件数だけにまとめる（でたらめなログインの連打で操作ログを膨らませられないように）。

router.get('/me', (req, res) => {
  // 無効化・削除されたユーザーは未ログイン扱い、ロール変更は最新を返す
  const user = loadSessionUser(req);
  if (!user) return res.status(401).json({ error: '未ログイン' });
  res.json(user);
});

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password)
      return res.status(400).json({ error: 'ユーザーIDとパスワードを入力してください' });
    if (username.length > MAX_USERNAME || password.length > MAX_PASSWORD) {
      audit.record(req, 'login.failure', { user: username, status: 400, detail: { reason: '入力が長すぎる' } });
      return res.status(400).json({ error: 'ユーザーIDまたはパスワードが長すぎます' });
    }

    const user = db.query('SELECT * FROM users WHERE username=? AND active=1', [username])[0];

    // 照合の前に「1回試した」と数える（ロック中、または同時に送られた要求が上限を超えた分は、照合せずに断る）
    const gate = lockout.begin(username, !!user);
    if (!gate.allowed) {
      audit.record(req, 'login.locked', { user: username, status: 429 });
      return res.status(429).json({ error: lockedMessage(gate.seconds) });
    }

    // 同期版（compareSync）は照合のあいだサーバー全体が止まるので、非同期版を使う
    const matched = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !matched) {
      const state = lockout.fail(username);
      audit.record(req, 'login.failure', {
        user: username,
        status: state.locked ? 429 : 401,
        detail: state.locked ? { locked: true, minutes: lockout.lockMinutes } : undefined,
      });
      if (state.locked) return res.status(429).json({ error: lockedMessage(state.seconds) });
      return res.status(401).json({
        error: `ユーザーIDまたはパスワードが違います（${lockout.maxFailures}回続けて間違えると、${lockout.lockMinutes}分間ログインできなくなります）`,
      });
    }

    lockout.succeed(username);

    // ログイン前から持っていたセッションIDは捨てて、新しいIDを発行する（セッション固定攻撃の対策）
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.user = { id: user.id, username: user.username, role: user.role };

      // いまのパスワードが現在の基準を満たしていなければ、画面で知らせる（初期パスワードや、基準ができる前に決めたもの）
      const weak = passwordPolicy.check(password, { username: user.username }).length > 0;
      audit.record(req, 'login.success', { status: 200, detail: weak ? { weak_password: true } : undefined });

      const body = { ...req.session.user };
      if (weak) {
        body.password_warning = 'このパスワードは、現在のパスワードの基準を満たしていません。' +
          (user.role === 'admin'
            ? 'マスタ管理 → ユーザー管理 で、早めに変更してください。'
            : '管理者に依頼して、早めに変更してください。') +
          `\n（基準：${passwordPolicy.describe()}）`;
      }
      res.json(body);
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res, next) => {
  const actor = req.session?.user ? { ...req.session.user } : null;
  req.session.destroy(err => {
    if (err) return next(err);
    if (actor) audit.record(req, 'logout', { actor, status: 200 });
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

module.exports = router;
