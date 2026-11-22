const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../database');
const audit = require('../services/auditLog');
const lockout = require('../services/loginLockout');
const passwordPolicy = require('../services/passwordPolicy');
const { loadSessionUser, passwordMark } = require('../middleware/auth');

const MAX_USERNAME = 64;    // これより長い入力は照合せずに断る（ユーザー管理でも64文字までしか登録できない）
const MAX_PASSWORD = 200;

// 実在しない（または無効の）ユーザーIDのときに照合する、だれのものでもないハッシュ。
// 実在するIDのときだけ照合に時間がかかると、応答の速さから「そのIDが実在するか」が分かってしまうため。
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

const lockedMessage = seconds =>
  `このユーザーIDは、ログインに続けて失敗したため一時的にロックされています。約${Math.ceil(seconds / 60)}分後にもう一度お試しください。`;

router.get('/me', (req, res) => {
  // 無効化・削除されたユーザーは未ログイン扱い、ロール変更は最新を返す
  const user = loadSessionUser(req);
  if (!user) return res.status(401).json({ error: '未ログイン' });
  res.json({ id: user.id, username: user.username, role: user.role });
});

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password)
      return res.status(400).json({ error: 'ユーザーIDとパスワードを入力してください' });
    if (username.length > MAX_USERNAME || password.length > MAX_PASSWORD) {
      audit.record(req, 'login.failure', { user: null, status: 400, detail: { reason: '入力が長すぎる' } });
      return res.status(400).json({ error: 'ユーザーIDまたはパスワードが長すぎます' });
    }
    // 改行などの制御文字を含むユーザーIDは登録できない（routes/users.js の checkUsername）ので、照合せずに断る。
    // 通してしまうと、「実在のID＋改行＋…」という文字列で失敗を重ねて、その実在のIDがロック中であるかのように見せかけられる
    if (/[\x00-\x1f\x7f]/.test(username)) {
      audit.record(req, 'login.failure', { user: null, status: 400, detail: { reason: 'ユーザーIDに使えない文字' } });
      return res.status(400).json({ error: 'ユーザーIDに使えない文字が含まれています' });
    }

    const ip = audit.clientIp(req);
    const account = db.query('SELECT * FROM users WHERE username=?', [username])[0];   // 無効のユーザーも含めて探す
    const user = account && account.active ? account : null;

    // 操作ログに残す名前。登録されているユーザーIDなら、そのIDを残す。登録されていない文字列は残さない
    // （ユーザーIDの欄にまちがえてパスワードを打ってしまうことがあり、それがそのまま記録・バックアップされるのを避ける）。
    const who = account
      ? { user: account.username, detail: account.active ? undefined : { inactive: true } }
      : { user: null, detail: { unknown_id: true, length: username.length } };

    // パスワードの照合に進める回数には上限がある（接続元ごとと全体。services/loginLockout.js の createAttemptLimiter）。
    // でたらめなログインを連打されても、照合の計算でほかの人の操作が待たされないようにするため
    if (!lockout.attempts.allow(ip)) {
      audit.record(req, 'login.locked', { ...who, status: 429, detail: { ...(who.detail || {}), reason: 'ログインの試行が多すぎる' } });
      return res.status(429).json({ error: 'ログインの試行が多すぎます。1分ほど待ってから、もう一度お試しください。' });
    }

    // 照合の前に「1回試した」と数える（ロック中、または同時に送られた要求が上限を超えた分は、照合せずに断る）
    const gate = lockout.begin(username, ip);
    if (!gate.allowed) {
      audit.record(req, 'login.locked', { ...who, status: 429 });
      return res.status(429).json({ error: lockedMessage(gate.seconds) });
    }

    // 同期版（compareSync）は照合のあいだサーバー全体が止まるので、非同期版を使う
    const matched = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !matched) {
      const state = lockout.fail(username, ip);
      // 実在する有効なユーザーへの失敗と、それによってロックがかかった瞬間は、必ず記録する（always）。
      // ロックの仕組みで回数が限られているので、記録が増えすぎることはない。でたらめな要求を連打して
      // 「未ログインの要求の記録の枠」を使い切ってから本命のユーザーIDを試す、という隠し方をさせないため。
      audit.record(req, 'login.failure', {
        ...who,
        status: state.locked ? 429 : 401,
        detail: { ...(who.detail || {}), ...(state.locked ? { locked: true, minutes: lockout.lockMinutes } : {}) },
        always: !!user,
      });
      if (state.locked) return res.status(429).json({ error: lockedMessage(state.seconds) });
      return res.status(401).json({
        error: `ユーザーIDまたはパスワードが違います（${lockout.maxFailures}回続けて間違えると、${lockout.lockMinutes}分間ログインできなくなります）`,
      });
    }

    lockout.succeed(username, ip, gate.token);

    // ログイン前から持っていたセッションIDは捨てて、新しいIDを発行する（セッション固定攻撃の対策）
    // この中（コールバック）は、外側の try / catch の外で、あとから呼ばれる。ここで例外が外へ出るとサーバー全体が止まるので、
    // 中でも受け止めてエラー処理（next）へ回す
    req.session.regenerate(err => {
      if (err) return next(err);
      try {
        // pw: ログインした時点のパスワードの目印。あとでパスワードが変更されたら、このログイン状態を無効にするために使う
        req.session.user = { id: user.id, username: user.username, role: user.role, pw: passwordMark(user.password_hash) };

        // いまのパスワードが現在の基準を満たしていなければ、画面で知らせる（初期パスワードや、基準ができる前に決めたもの）
        const weak = passwordPolicy.check(password, { username: user.username }).length > 0;
        audit.record(req, 'login.success', { status: 200, detail: weak ? { below_standard: true } : undefined });

        const body = { id: user.id, username: user.username, role: user.role };
        if (weak) {
          body.password_warning = 'このパスワードは、現在のパスワードの基準を満たしていません。' +
            (user.role === 'admin'
              ? 'マスタ管理 → ユーザー管理 で、早めに変更してください。'
              : '管理者に依頼して、早めに変更してください。') +
            `\n（基準：${passwordPolicy.describe()}）`;
        }
        res.json(body);
      } catch (e) {
        next(e);
      }
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res, next) => {
  const actor = req.session?.user ? { ...req.session.user } : null;
  req.session.destroy(err => {
    if (err) return next(err);
    try {   // ここも、あとから呼ばれるコールバックの中。例外を外へ出さない（ログインのところの説明と同じ）
      if (actor) audit.record(req, 'logout', { actor, status: 200 });
      res.clearCookie('connect.sid');
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
});

module.exports = router;
