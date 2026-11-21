// Node.js の版の確認。請求書PDFに使う Puppeteer 25 が 22.12 以上を必要とする。
// 古い Node.js のままだと、分かりにくいエラーで起動に失敗するので、最初に確かめて理由を表示する。
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 12)) {
  console.error(`このアプリには Node.js 22.12 以上が必要です（現在 ${process.version}）。Node.js を更新してから起動してください。`);
  process.exit(1);
}

// .env はプロジェクト直下のものを読む（起動時の作業フォルダに左右されないよう、場所を固定する。
// サービスやタスクとして起動すると作業フォルダが変わり、.env が読まれずに既定値で動いてしまうため）
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// 請求書PDFで使う Chrome の置き場所も、プロジェクト内（.cache/puppeteer）に固定する（.puppeteerrc.cjs と同じ場所）。
// 設定ファイルは起動時の作業フォルダから探されるため、作業フォルダやアカウントが違っても見つかるよう環境変数でも指定する。
// （PUPPETEER_EXECUTABLE_PATH でブラウザを直接指定している場合と、.env 等で指定済みの場合は何もしない）
if (!process.env.PUPPETEER_CACHE_DIR && !process.env.PUPPETEER_EXECUTABLE_PATH)
  process.env.PUPPETEER_CACHE_DIR = require('path').join(__dirname, '..', '.cache', 'puppeteer');

const express = require('express');
const path = require('path');
const session = require('express-session');
const db = require('./database');
const audit = require('./services/auditLog');
const { auditMiddleware } = require('./middleware/audit');
const { requireAuth, requireRole } = require('./middleware/auth');

// 各ルートのプログラムを先に読み込む。読み込めないのは「npm ci が済んでいない」「ファイルが欠けている」など
// プログラム側の問題なので、DB のエラー（下の「DB初期化エラー」）と区別して表示する。
let routes;
try {
  routes = {
    auth: require('./routes/auth'),
    wards: require('./routes/wards'),
    patients: require('./routes/patients'),
    items: require('./routes/items'),
    records: require('./routes/records'),
    mealPrices: require('./routes/mealprices'),
    pdf: require('./routes/pdf'),
    users: require('./routes/users'),
    exportRoute: require('./routes/export'),
    audit: require('./routes/audit'),
    scheduler: require('./jobs/scheduler'),
  };
} catch (err) {
  console.error('プログラムの読み込みエラー（npm ci が済んでいるか、ファイルが欠けていないかを確認してください）:', err);
  process.exit(1);
}

// .env の TRUST_PROXY を Express の 'trust proxy' の値にする。未設定・空・false・0 は「信用しない」（undefined を返す）。
//   loopback … 同じ機械の上のリバースプロキシ（Caddy など）から受けるとき
//   1        … 1段だけ手前にあるプロキシ（NAS内蔵のリバースプロキシ → コンテナ）から受けるとき
// true は受け付けない（どこから来た要求でも、ヘッダーに書かれた接続元とHTTPSの情報を信用してしまうため）。
function parseTrustProxy(raw) {
  const value = String(raw ?? '').trim();
  if (!value || value === '0' || value.toLowerCase() === 'false') return undefined;
  if (value.toLowerCase() === 'true')
    throw new Error('TRUST_PROXY=true は使えません。loopback（同じ機械のプロキシ）か 1（1段手前のプロキシ）を指定してください。');
  return /^\d+$/.test(value) ? Number(value) : value;
}

const app = express();

// リバースプロキシ（HTTPS終端）の背後で動かすとき用。.env に TRUST_PROXY を書いたときだけ有効になる。
// 有効にすると、プロキシが付けた「HTTPSで届いた」「本当の接続元」という情報を信用する
// （ログイン用 Cookie に Secure 属性が付き、操作ログにはプロキシではなく利用者のPCのIPアドレスが残る）。
let trustProxy;
try {
  trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
} catch (err) {
  console.error(`.env の TRUST_PROXY の値が正しくありません（${process.env.TRUST_PROXY}）: ${err.message}`);
  process.exit(1);
}

// 操作ログの保存先を、DB を開く前に用意する。使えないときは、記録なしで動き続けないよう、ここで起動を止める
// （DB を開いたあとで止めると、起動に失敗するたびに DB ファイルを書き直してしまう）。
let auditDir;
try {
  auditDir = audit.init(db.dbPath);
} catch (err) {
  console.error('操作ログの初期化エラー:', err.message);
  process.exit(1);
}

app.use(session({
  secret: process.env.SESSION_SECRET || 'hiyou-keisan-secret-2026',
  resave: false,
  saveUninitialized: false,
  // sameSite:'lax' = ほかのサイトのページから送らせた要求（POST など）にはログイン状態を付けない
  // secure:'auto'  = HTTPS で届いた要求にだけ Secure 属性を付ける（HTTP での直接アクセスも従来どおり動く）
  cookie: { maxAge: 8 * 60 * 60 * 1000, sameSite: 'lax', secure: 'auto' }, // 8時間
}));

// 操作ログ。JSON の読み取りに失敗した要求（400）も記録できるよう、express.json() より前に置く
app.use(auditMiddleware);
app.use(express.json());

app.use(express.static(path.join(__dirname, '..', 'public')));

db.getDb().then(() => {
  console.log(`操作ログ: ${auditDir}`);

  // 認証（ログイン不要）
  app.use('/api/auth', routes.auth);

  // 認証が必要なルート
  app.use('/api/wards',       requireAuth, routes.wards);
  app.use('/api/patients',    requireAuth, routes.patients);
  app.use('/api/items',       requireAuth, routes.items);
  app.use('/api/records',     requireAuth, routes.records);
  app.use('/api/meal-prices', requireAuth, routes.mealPrices);
  app.use('/api/pdf',         requireAuth, routes.pdf);
  app.use('/api/users',       requireAuth, routes.users);
  app.use('/api/export',      requireAuth, routes.exportRoute);
  app.use('/api/audit',       requireAuth, routes.audit);

  // ロールごとの書き込み制限は各ルート内で制御（requireRole）

  // 週次使用量レポートのcron登録（EXPORT_ENABLED=true のときのみ）
  routes.scheduler.initScheduler();

  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  // エラーハンドラ（スタックトレースのページを返さず JSON で返す）
  app.use((err, req, res, next) => {
    // 名前の重複は入力ミスなので、サーバー障害（500）ではなく 409 で返し、ログも1行にとどめる
    if (/UNIQUE constraint/i.test(String(err.message))) {
      console.warn(`重複エラー: ${req.method} ${req.originalUrl} (${err.message})`);
      if (res.headersSent) return next(err);
      return res.status(409).json({ error: '同じ名前（ID）が既に登録されています' });
    }
    // リクエスト本文の不正（JSONの書式誤りなど）は 4xx のまま返す。
    // このエラーには、送られてきた本文そのもの（ログインの要求ならパスワード）が入っているので、
    // エラーログには種類だけを残す（中身を丸ごと出力しない）。
    if (err.status >= 400 && err.status < 500) {
      console.warn(`リクエストの形式エラー: ${req.method} ${String(req.originalUrl).split('?')[0]} (${err.type || err.status})`);
      if (res.headersSent) return next(err);
      return res.status(err.status).json({ error: 'リクエストの形式が正しくありません' });
    }
    console.error('サーバーエラー:', err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'サーバーでエラーが発生しました' });
  });

  const PORT = process.env.PORT || 3000;
  // HOST=127.0.0.1 にすると、同じ機械のリバースプロキシ経由でしか接続できなくなる（未設定なら従来どおり全インターフェース）
  const HOST = String(process.env.HOST ?? '').trim() || undefined;
  app.listen(PORT, HOST, () => {
    console.log(`療養介護サービス提供実績記録票 起動: http://localhost:${PORT}` +
      (HOST ? `（待ち受けは ${HOST} のみ）` : ''));
    if (trustProxy !== undefined)
      console.log(`リバースプロキシ: TRUST_PROXY=${trustProxy}（プロキシが伝える接続元と HTTPS の情報を信用します）`);
    if (db.wasInitialAdminCreated())
      console.log('初期管理者を作成しました: admin / admin123（ログイン後にパスワードを変更してください）');
    audit.recordSystem('server.start', {
      node: process.version, port: String(PORT), host: HOST || '(すべて)',
      trust_proxy: trustProxy === undefined ? '(なし)' : String(trustProxy),
    });

    // 請求書PDF用の Chrome があるかを確かめる。Puppeteer 25 では、npm ci のときに Chrome を取得できなくても
    // npm ci 自体は成功したように見えるので、ここで気づけるようにする（無くても起動は続ける。PDF 以外は使える）。
    (async () => {
      const chrome = process.env.PUPPETEER_EXECUTABLE_PATH || await require('puppeteer').executablePath();
      if (!require('fs').existsSync(chrome)) {
        console.error(`請求書PDF用の Chrome が見つかりません: ${chrome}\n` +
          'このままでは請求書PDFを出力できません。プロジェクトのフォルダで「npx.cmd puppeteer browsers install chrome」を実行してください' +
          '（インターネットに出られる必要があります）。');
        audit.recordSystem('server.warning', { message: '請求書PDF用の Chrome が見つからない', path: chrome });
      }
    })().catch(err => console.error('Chrome の確認に失敗しました:', err.message));
  });
}).catch(err => {
  console.error('DB初期化エラー:', err);
  process.exit(1);
});
