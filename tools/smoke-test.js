// 回帰テスト（スモークテスト）。現在のDBの「コピー」でサーバーを一時的に起動し、主な機能が動くことを確かめる。
// コードを変更したあと、push する前に実行する。
//
// 使い方（プロジェクトのフォルダで）:
//   node tools/smoke-test.js                    … .env の DB_PATH、無ければ data/hiyou.db のコピーで実行
//   node tools/smoke-test.js D:\somewhere\x.db  … 指定したDBのコピーで実行
//
// ・元のDBファイルには書き込まない（OSの一時フォルダへコピーして使い、終わったら消す）。
//   対象のDBが無いときは、新規のDBで実行する。
// ・コピーにテスト用の管理者を追加してログインするので、実際のユーザーのパスワードは使わない。
// ・操作ログも一時フォルダへ書く（本番の操作ログには何も書かない）。
// ・週次レポートは送信しない（EXPORT_ENABLED=false で起動し、ドライランだけを呼ぶ）。
// ・ポート 3150 を使う（変えるときは環境変数 SMOKE_PORT）。本番のサーバーが動いていても実行できる。
// ・請求書PDFも1枚作るので、Chrome が入っていること（npm ci 済みであること）。所要 20〜30 秒。
// 終了コード: 0 = 全項目合格 / 1 = 不合格あり
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.SMOKE_PORT) || 3150;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_ADMIN = 'smoke_admin';
const TEST_WEAK = 'smoke_weak';                 // 基準を満たさないパスワードのユーザー（コピーのDBへ直接入れる）
const WEAK_PASSWORD = 'weakpass1';
const TEST_PASSWORD = 'Kensa-you-9w3x7k2m';     // テスト中に作るユーザー用。パスワードの基準を満たすもの
const NEW_PASSWORD = 'Henkou-go-5t2r8y4u';      // パスワード変更の確認用
const WRONG_PASSWORD = 'chigau-pasuwa-do-0000';
const MAX_FAILURES = 5;                         // このテストで起動するサーバーの設定（下の env で指定する）
const USER_PER_MINUTE = 1200;                   // 同上。同じユーザーが1分間に出せる要求の上限（既定は 6000。テストを短くするために下げる）

// 動作検証.md の P-02 に記録した金額（開発用テストデータの 2026年8月分）
const RECORDED = [
  { id: 8, name: 'ううう', item: 85321, meal: 3800, grand: 89121 },
  { id: 1, name: 'てすと2', item: 11645, meal: 3000, grand: 14645 },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
};

// 途中で止まっても（Ctrl+C、出力先が閉じられた場合など）、起動したサーバーとDBのコピーを残さない
let server = null, work = null, tidied = false;
function tidyUp() {
  if (tidied) return;
  tidied = true;
  try { if (server && server.exitCode === null) server.kill(); } catch (_) { /* 既に終了している */ }
  try { if (work) fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (_) { /* 消せなかった場合は最後に案内する */ }
}
process.on('exit', tidyUp);
process.on('SIGINT', () => process.exit(1));
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

// 対象のDB: 引数 → .env の DB_PATH → data/hiyou.db
function sourceDbPath() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  try {
    const env = require('dotenv').parse(fs.readFileSync(path.join(APP, '.env')));
    if (env.DB_PATH) return path.resolve(APP, env.DB_PATH);
  } catch (_) { /* .env が無ければ既定の場所を使う */ }
  return path.join(APP, 'data', 'hiyou.db');
}

// DBをコピーし、コピーにテスト用のユーザーを追加する。戻り値はログインに使うIDとパスワード
async function prepareCopy(src, copy) {
  fs.copyFileSync(src, copy);
  const SQL = await require('sql.js')();
  const db = new SQL.Database(fs.readFileSync(copy));
  const hasUsers = db.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").length > 0;
  if (!hasUsers) { db.close(); return { username: 'admin', password: 'admin123' }; } // 起動時に初期管理者が作られる
  const bcrypt = require('bcryptjs');
  const password = crypto.randomBytes(12).toString('hex');
  db.run("DELETE FROM users WHERE username LIKE 'smoke\\_%' ESCAPE '\\'");   // 前回の実行の残りがあれば消す（コピーの中だけ）
  db.run("INSERT INTO users (username, password_hash, role, active) VALUES (?, ?, 'admin', 1)",
    [TEST_ADMIN, bcrypt.hashSync(password, 10)]);
  db.run("INSERT INTO users (username, password_hash, role, active) VALUES (?, ?, 'viewer', 1)",
    [TEST_WEAK, bcrypt.hashSync(WEAK_PASSWORD, 10)]);
  fs.writeFileSync(copy, Buffer.from(db.export()));
  db.close();
  return { username: TEST_ADMIN, password };
}

// ログイン状態（Cookie）を保持する簡易クライアント。
// ip を渡すと、その接続元から来たことにする（サーバーを TRUST_PROXY=loopback で起動し、X-Forwarded-For で伝える）。
// ロックと試行回数の上限は接続元ごとに数えるので、利用者ごとに別の接続元を使う。
function client(ip, headers = {}) {
  let cookie = '';
  const fixed = { ...(ip ? { 'X-Forwarded-For': ip } : {}), ...headers };
  const call = async (method, url, body) => {
    const res = await fetch(BASE + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...fixed, ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) { cookie = set.split(';')[0]; call.lastSetCookie = set; }
    return res;
  };
  call.lastSetCookie = '';
  call.cookie = () => cookie;
  return call;
}
// 指定した Cookie をそのまま付けて送る（ログアウト後・ログインし直した後に、古い Cookie が使えないことを確かめる用）
const withCookie = (cookie, url) => fetch(BASE + url, { headers: { Cookie: cookie } });
const loginAs = (c, username, password) => c('POST', '/api/auth/login', { username, password });

// 非常用のパスワード再設定ツール（tools/reset-password.js）を、指定した設定で実行する。stdin に流した文字が入力になる
function runResetTool(args, env, input = '') {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(APP, 'tools', 'reset-password.js'), ...args], { cwd: APP, env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (out += d));
    child.on('exit', code => resolve({ code, out }));
    child.stdin.end(input);
  });
}

(async () => {
  const src = sourceDbPath();
  const hasSource = fs.existsSync(src) && fs.statSync(src).size > 0;
  const before = hasSource ? sha256(src) : null;
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'hiyou-smoke-'));
  const copy = path.join(work, 'hiyou.db');
  const auditDir = path.join(work, 'audit');
  console.log(`対象: ${hasSource ? src + ' のコピー' : '新規のDB（' + src + ' が無いため）'}`);
  console.log(`作業用フォルダ: ${work} / ポート ${PORT} / Node ${process.version}\n`);

  // ほかのプログラムが同じポートを使っていると、そちらを相手にテストしてしまうので先に確かめる
  let portBusy = false;
  try { await fetch(BASE + '/', { signal: AbortSignal.timeout(1500) }); portBusy = true; } catch (_) { /* 空いている */ }
  if (portBusy) {
    console.error(`ポート ${PORT} は使用中です。環境変数 SMOKE_PORT で別の番号を指定してください。`);
    process.exit(1);   // 作業用フォルダは終了時に片付く
  }

  const login = hasSource ? await prepareCopy(src, copy) : { username: 'admin', password: 'admin123' };

  // .env より環境変数が優先されるので、ここで指定した値でテストできる（本番の設定には影響しない）
  server = spawn(process.execPath, [path.join(APP, 'server', 'index.js')], {
    cwd: APP,
    env: {
      ...process.env, DB_PATH: copy, PORT: String(PORT), HOST: '127.0.0.1', EXPORT_ENABLED: 'false',
      AUDIT_LOG_DIR: auditDir, TRUST_PROXY: 'loopback',
      PASSWORD_MIN_LENGTH: '13', LOGIN_MAX_FAILURES: String(MAX_FAILURES), LOGIN_LOCK_MINUTES: '15',
      AUDIT_USER_PER_MINUTE: String(USER_PER_MINUTE),
    },
  });
  let log = '', exited = false;
  server.stdout.on('data', d => (log += d));
  server.stderr.on('data', d => (log += d));
  server.on('exit', () => { exited = true; });
  const readAudit = () => (fs.existsSync(auditDir) ? fs.readdirSync(auditDir).filter(f => /^audit-\d{4}-\d{2}\.jsonl$/.test(f)) : [])
    .map(f => fs.readFileSync(path.join(auditDir, f), 'utf8')).join('');

  try {
    let up = false;
    for (let i = 0; i < 80 && !up && !exited; i++) {
      try { await fetch(BASE + '/'); up = true; } catch (_) { await sleep(250); }
    }
    check('サーバー起動', up);
    if (!up) throw new Error('サーバーが起動しないため以降を省略');
    check('起動時に、請求書PDF用の Chrome が見つからないという警告が出ていない', !/Chrome が見つかりません/.test(log));

    const anon = client();
    check('GET / → 200', (await anon('GET', '/')).status === 200);
    check('未ログイン /api/auth/me → 401', (await anon('GET', '/api/auth/me')).status === 401);
    check('未ログイン /api/patients → 401', (await anon('GET', '/api/patients')).status === 401);

    const admin = client('10.9.0.1');
    const res = await loginAs(admin, login.username, login.password);
    const asTestAdmin = login.username === TEST_ADMIN;
    check(`管理者でログイン（${asTestAdmin ? 'テスト用のユーザー' : '新規DBの初期管理者'}）`, res.status === 200, `status ${res.status}`);
    if (res.status !== 200) throw new Error('ログインできないため以降を省略');
    const loginBody = await res.json();
    check('ログイン用 Cookie は HttpOnly・SameSite=Lax（HTTP では Secure なし）',
      /HttpOnly/i.test(admin.lastSetCookie) && /SameSite=Lax/i.test(admin.lastSetCookie) && !/;\s*Secure/i.test(admin.lastSetCookie));
    if (!asTestAdmin)
      check('初期パスワードでのログインには「基準を満たしていない」注意が付く', typeof loginBody.password_warning === 'string');

    const wards = await (await admin('GET', '/api/wards')).json();
    let patients = await (await admin('GET', '/api/patients')).json();
    const users = await (await admin('GET', '/api/users')).json();
    console.log(`     病棟 ${wards.length} 件 / 患者 ${patients.length} 名 / ユーザー ${users.length} 件${asTestAdmin ? '（テスト用のユーザー2件を含む）' : ''}`);

    // 患者が1人もいないDB（新規など）では、コピー上にテスト用の患者を作って続ける
    if (!patients.length) {
      await admin('POST', '/api/patients', { ward_id: wards[0].id, name: 'スモークテスト', room: '', beneficiary_no: '' });
      patients = await (await admin('GET', '/api/patients')).json();
    }

    // 月次集計: 開発用テストデータなら動作検証.md の金額と照合。それ以外のDBでは合計と内訳の整合を確認
    const isDevData = RECORDED.every(e => patients.some(p => p.id === e.id && p.name === e.name));
    const now = new Date();
    let pdfTarget = { id: patients[0].id, year: now.getFullYear(), month: now.getMonth() + 1 };
    if (isDevData) {
      for (const e of RECORDED) {
        const r = await admin('GET', `/api/records/summary?patient_id=${e.id}&year=2026&month=8`);
        const s = r.status === 200 ? await r.json() : {};
        check(`月次集計 患者ID=${e.id} 2026年8月が検証記録と一致`,
          s.itemTotal === e.item && s.mealCost === e.meal && s.grandTotal === e.grand,
          `日用品 ${s.itemTotal} / 食事 ${s.mealCost} / 合計 ${s.grandTotal}（記録 ${e.item} / ${e.meal} / ${e.grand}）`);
      }
      pdfTarget = { id: 8, year: 2026, month: 8 };
    } else {
      const r = await admin('GET', `/api/records/summary?patient_id=${pdfTarget.id}&year=${pdfTarget.year}&month=${pdfTarget.month}`);
      const s = r.status === 200 ? await r.json() : {};
      const sum = Array.isArray(s.totals) ? s.totals.reduce((a, t) => a + t.subtotal, 0) : NaN;
      check(`月次集計 患者ID=${pdfTarget.id} ${pdfTarget.year}年${pdfTarget.month}月の合計が内訳と一致`,
        r.status === 200 && s.itemTotal === sum && s.grandTotal === s.itemTotal + s.mealCost,
        `日用品 ${s.itemTotal} / 食事 ${s.mealCost} / 合計 ${s.grandTotal}`);
    }

    const pdf = await admin('GET', `/api/pdf?patient_id=${pdfTarget.id}&year=${pdfTarget.year}&month=${pdfTarget.month}`);
    const buf = Buffer.from(await pdf.arrayBuffer());
    check(`請求書PDF 患者ID=${pdfTarget.id} ${pdfTarget.year}年${pdfTarget.month}月`,
      pdf.status === 200 && buf.subarray(0, 4).toString() === '%PDF' && /application\/pdf/.test(pdf.headers.get('content-type') || ''),
      `status ${pdf.status}, ${buf.length} バイト`);
    check('PDF出力後もサーバーが動作', (await admin('GET', '/api/wards')).status === 200);

    // パスワードの基準（弱いパスワードは登録できない）
    const mk = async (username, role, password = TEST_PASSWORD) => (await admin('POST', '/api/users', { username, password, role })).status;
    check('短いパスワード（11文字）のユーザー作成は 400', (await mk('smoke_short', 'viewer', 'Test-pass-1')) === 400);
    check('数字の無いパスワードのユーザー作成は 400', (await mk('smoke_nodigit', 'viewer', 'kensa-you-pasu-wo-kimeru')) === 400);
    check('ユーザーIDを含むパスワードのユーザー作成は 400', (await mk('smoke_viewer', 'viewer', 'smoke_viewer-9w3x7k2m')) === 400);
    check('繰り返し・数字での置き換え（abc123abc123a、Pa55word-2026）のユーザー作成は 400',
      (await mk('smoke_rep', 'viewer', 'abc123abc123a')) === 400 && (await mk('smoke_leet', 'viewer', 'Pa55word-2026')) === 400);

    // 権限（コピー上に「閲覧のみ」「一般スタッフ」を作って確認）
    check('閲覧のみユーザー作成', (await mk('smoke_viewer', 'viewer')) === 200);
    check('一般スタッフ作成', (await mk('smoke_staff', 'staff')) === 200);
    const viewer = client('10.9.0.2'), staff = client('10.9.0.3');
    const viewerLogin = await loginAs(viewer, 'smoke_viewer', TEST_PASSWORD);
    check('基準を満たすパスワードでのログインには注意が付かない', viewerLogin.status === 200 && !('password_warning' in await viewerLogin.json()));
    await loginAs(staff, 'smoke_staff', TEST_PASSWORD);
    const rec = { patient_id: patients[0].id, record_date: '2026-11-01', items: [], meal: { breakfast: 1 } };
    check('閲覧のみ：実績保存は 403', (await viewer('POST', '/api/records', rec)).status === 403);
    check('閲覧のみ：月次集計は 200', (await viewer('GET', `/api/records/summary?patient_id=${patients[0].id}&year=2026&month=8`)).status === 200);
    check('一般スタッフ：実績保存は 200', (await staff('POST', '/api/records', rec)).status === 200);
    check('一般スタッフ：病棟追加は 403', (await staff('POST', '/api/wards', { name: 'x' })).status === 403);
    check('一般スタッフ：ユーザー一覧は 403', (await staff('GET', '/api/users')).status === 403);
    check('一般スタッフ：操作ログは 403', (await staff('GET', '/api/audit')).status === 403);
    check('未ログイン：操作ログは 401', (await anon('GET', '/api/audit')).status === 401);
    check('不正な日付の実績保存は 400', (await admin('POST', '/api/records', { ...rec, record_date: '2026-02-30' })).status === 400);
    check('週次レポートのドライラン（送信なし）は 200', (await admin('POST', '/api/export/weekly-usage/run?dry=1')).status === 200);

    // パスワードの変更（基準と「現在と同じものは不可」）
    const userRows = await (await admin('GET', '/api/users')).json();
    const viewerRow = userRows.find(u => u.username === 'smoke_viewer');
    const staffRow = userRows.find(u => u.username === 'smoke_staff');
    const put = body => admin('PUT', `/api/users/${viewerRow.id}`, { username: 'smoke_viewer', role: 'viewer', active: 1, ...body });
    check('パスワード変更：弱いものは 400', (await put({ password: 'abc' })).status === 400);
    check('パスワード変更：現在と同じものは 400', (await put({ password: TEST_PASSWORD })).status === 400);
    check('パスワードを入力しない更新は 200（パスワードは変わらず、ログイン中の画面もそのまま使える）',
      (await put({})).status === 200 && (await viewer('GET', '/api/wards')).status === 200);

    // 基準を満たさないパスワードのユーザー（基準ができる前に登録されたユーザーに相当）
    if (asTestAdmin) {
      const r = await loginAs(client('10.9.0.4'), TEST_WEAK, WEAK_PASSWORD);
      check('基準を満たさないパスワードでもログインでき、注意が付く', r.status === 200 && typeof (await r.json()).password_warning === 'string');
    }

    // ログインし直すとセッションIDが変わり、古い Cookie は使えなくなる。ログアウトした Cookie も使えない
    const relog = client('10.9.0.5');
    await loginAs(relog, 'smoke_staff', TEST_PASSWORD);
    const cookie1 = relog.cookie();
    await loginAs(relog, 'smoke_staff', TEST_PASSWORD);
    const cookie2 = relog.cookie();
    check('ログインし直すとセッションIDが変わり、古い Cookie では 401',
      cookie1 && cookie2 && cookie1 !== cookie2 && (await withCookie(cookie1, '/api/wards')).status === 401 && (await withCookie(cookie2, '/api/wards')).status === 200);
    check('ログアウトは 200。ログアウトした Cookie をそのまま送っても 401',
      (await relog('POST', '/api/auth/logout')).status === 200 && (await withCookie(cookie2, '/api/wards')).status === 401);

    // ログイン失敗の連続によるロック（接続元ごと）
    const attacker = client('10.9.0.66');
    const statuses = [];
    for (let i = 0; i < MAX_FAILURES; i++) statuses.push((await loginAs(attacker, 'smoke_viewer', WRONG_PASSWORD)).status);
    check(`間違ったパスワード ${MAX_FAILURES} 回：${MAX_FAILURES - 1} 回目までは 401、${MAX_FAILURES} 回目でロック（429）`,
      statuses.slice(0, -1).every(s => s === 401) && statuses[statuses.length - 1] === 429, statuses.join(','));
    check('ロックされた接続元からは、正しいパスワードでも 429', (await loginAs(client('10.9.0.66'), 'smoke_viewer', TEST_PASSWORD)).status === 429);
    check('ほかの接続元からは、同じユーザーIDでログインできる（1台からの嫌がらせで本人を締め出せない）',
      (await loginAs(client('10.9.0.2'), 'smoke_viewer', TEST_PASSWORD)).status === 200);
    check('ロック中でも、ログイン済みの画面はそのまま使える', (await viewer('GET', '/api/wards')).status === 200);
    const lockedRow = (await (await admin('GET', '/api/users')).json()).find(u => u.username === 'smoke_viewer');
    check('ユーザー一覧にロックの残り時間が出る', lockedRow && lockedRow.locked_seconds > 0, `残り ${lockedRow && lockedRow.locked_seconds} 秒`);
    check('一般スタッフ：ロック解除は 403', (await staff('POST', `/api/users/${viewerRow.id}/unlock`)).status === 403);
    check('管理者：ロック解除は 200', (await admin('POST', `/api/users/${viewerRow.id}/unlock`)).status === 200);
    check('解除後は、ロックされていた接続元からもログインできる', (await loginAs(client('10.9.0.66'), 'smoke_viewer', TEST_PASSWORD)).status === 200);

    // 接続元を変えながら試し続けると、ユーザーID全体がロックされる（接続元ごとの上限のすり抜け防止）
    for (let ipNo = 1; ipNo <= 4; ipNo++) {
      const c = client('10.9.1.' + ipNo);
      for (let i = 0; i < MAX_FAILURES; i++) await loginAs(c, 'smoke_viewer', WRONG_PASSWORD);
    }
    check(`接続元を変えて合計 ${MAX_FAILURES * 4} 回失敗すると、どの接続元からも 429（正しいパスワードでも）`,
      (await loginAs(client('10.9.2.1'), 'smoke_viewer', TEST_PASSWORD)).status === 429);
    check('管理者が解除すると、ログインできる',
      (await admin('POST', `/api/users/${viewerRow.id}/unlock`)).status === 200 && (await loginAs(client('10.9.2.1'), 'smoke_viewer', TEST_PASSWORD)).status === 200);

    // 実在しないユーザーIDでも同じ応答になる（IDが実在するかを外から調べられない）
    const ghost = [], ghostClient = client('10.9.0.67');
    for (let i = 0; i < MAX_FAILURES + 1; i++) ghost.push((await loginAs(ghostClient, 'smoke_no_such_user', WRONG_PASSWORD)).status);
    check('実在しないユーザーIDでも、同じ回数でロックの応答になる',
      ghost.slice(0, MAX_FAILURES - 1).every(s => s === 401) && ghost.slice(MAX_FAILURES - 1).every(s => s === 429), ghost.join(','));

    // 登録できない文字（改行など）を含むユーザーIDは、照合せずに断る。
    // 「実在のID＋改行＋…」で失敗を重ねても、その実在のIDがロック中と表示されることはない
    const crafted = client('10.9.0.68'), craftedStatuses = [];
    for (let i = 0; i < MAX_FAILURES + 1; i++) craftedStatuses.push((await loginAs(crafted, 'smoke_staff\nJUNK', WRONG_PASSWORD)).status);
    const staffNow = (await (await admin('GET', '/api/users')).json()).find(u => u.username === 'smoke_staff');
    check('改行を含むユーザーIDでのログインは 400 で断られ、元のユーザーが「ロック中」と表示されることもない',
      craftedStatuses.every(s => s === 400) && staffNow && staffNow.locked_seconds === 0, craftedStatuses.join(','));

    // 非常用のパスワード再設定ツールは、アプリが動いている間は何も変更しない
    const toolEnv = { DB_PATH: copy, PORT: String(PORT), HOST: '127.0.0.1', AUDIT_LOG_DIR: auditDir, EXPORT_ENABLED: 'false' };
    const whileRunning = await runResetTool([login.username], toolEnv, `${NEW_PASSWORD}\n${NEW_PASSWORD}\n`);
    check('再設定ツール：アプリが動いている間は、実行を断る（終了コード 1）', whileRunning.code === 1 && /アプリが動いています/.test(whileRunning.out),
      whileRunning.out.trim().split('\n')[0]);

    // .env のポート番号とは違うポートでアプリが動いていると、ポートへつないでみる確認では見つけられない。
    // その場合でも、同じ DB を開いていることに気づいて断る（以前は「変更しました」と表示し、動いているアプリの次の保存で変更が消えた）
    const otherPort = String(PORT + 7);
    const dbWhileRunning = sha256(copy);
    const startsBefore = (readAudit().match(/"server\.start"/g) || []).length;
    const undetected = await runResetTool([login.username], { ...toolEnv, PORT: otherPort }, `${NEW_PASSWORD}\n${NEW_PASSWORD}\n`);
    check('再設定ツール：アプリが別のポートで動いていても、同じ DB を開いていることに気づいて断る（DB は書き換えない）',
      undetected.code === 1 && /ほかのプロセスが使用中/.test(undetected.out) && sha256(copy) === dbWhileRunning, undetected.out.trim().split('\n')[0]);
    // 同じ DB を使う2つ目のアプリは、ポート番号が違っていても起動しない
    // （2つのプロセスが同じ DB を開くと、それぞれがファイル全体を書き出すので、互いの保存を上書きして入力が消える）
    const second = await new Promise(resolve => {
      const child = spawn(process.execPath, [path.join(APP, 'server', 'index.js')], {
        cwd: APP, env: { ...process.env, DB_PATH: copy, PORT: otherPort, HOST: '127.0.0.1', EXPORT_ENABLED: 'false', AUDIT_LOG_DIR: auditDir },
      });
      let out = '';
      child.stdout.on('data', d => (out += d));
      child.stderr.on('data', d => (out += d));
      const timer = setTimeout(() => child.kill(), 20000);   // 起動してしまった場合は、止めて不合格にする
      child.on('exit', code => { clearTimeout(timer); resolve({ code, out }); });
    });
    check('同じ DB を使う2つ目のアプリは、別のポートを指定しても起動しない（DB も操作ログも書き換えない）。動いているアプリは、そのまま使える',
      second.code === 1 && /起動を中止しました/.test(second.out) && /ほかのプロセスが使用中/.test(second.out) && sha256(copy) === dbWhileRunning &&
      (readAudit().match(/"server\.start"/g) || []).length === startsBefore && (await admin('GET', '/api/wards')).status === 200,
      second.out.trim().split('\n')[0]);

    // リバースプロキシ（HTTPS終端）経由を模した要求では、Cookie に Secure が付く
    const viaProxy = client('192.168.1.77', { 'X-Forwarded-Proto': 'https' });
    const proxied = await loginAs(viaProxy, 'smoke_staff', TEST_PASSWORD);
    check('HTTPS のプロキシ経由（X-Forwarded-Proto: https）のログインは Cookie に Secure が付く',
      proxied.status === 200 && /;\s*Secure/i.test(viaProxy.lastSetCookie), viaProxy.lastSetCookie.replace(/=[^;]*/, '=…'));
    check('ログアウトは 200、その後は 401', (await viaProxy('POST', '/api/auth/logout')).status === 200 && (await viaProxy('GET', '/api/patients')).status === 401);

    // 細工した値を送られても、サーバーが止まらない（操作ログの記録は応答を返したあとに動くので、そこで例外が出ると全体が止まる）
    const odd = [];
    odd.push((await anon('POST', '/api/records?patient_id[toString]=1')).status);
    odd.push((await anon('GET', '/api/patients?patient_id[toString]=x')).status);
    odd.push((await anon('POST', '/api/records', { patient_id: { toString: 1 }, record_date: '2026-11-01', items: [] })).status);
    odd.push((await staff('POST', '/api/records', { patient_id: { toString: 1 }, record_date: '2026-11-01', items: [] })).status);
    odd.push((await admin('GET', '/api/records?patient_id[toString]=1&year=2026&month=8')).status);
    odd.push((await admin('GET', '/api/meal-prices?patient_id[toString]=1&year[a]=2026&month=8')).status);
    odd.push((await admin('GET', '/api/pdf?patient_id[toString]=1&year=2026&month=8')).status);
    odd.push((await admin('GET', '/api/meal-prices/bulk?year[a]=2026&month=8')).status);
    odd.push((await admin('GET', '/api/items/prices?year[a]=2026&month=8')).status);
    odd.push((await admin('GET', '/api/patients?ward_id[a]=1')).status);
    odd.push((await admin('GET', '/api/audit?limit[a]=1')).status);
    odd.push((await admin('PUT', '/api/users/%E0%A4%A', { username: 'x', role: 'viewer' })).status);
    await sleep(300);
    check('細工した値（patient_id[toString]=1 など）を送られてもサーバーが止まらず、500 にもならない',
      !exited && (await admin('GET', '/api/wards')).status === 200 && odd.every(s => s >= 400 && s < 500), odd.join(','));

    // IDを変則的な書き方（0 を並べる、小数点を付ける）にしても、どの患者・どのユーザーかが操作ログに残る
    const pidText = String(patients[0].id);
    const paddedId = '0'.repeat(16 - pidText.length) + pidText;
    const oddIds = [
      (await viewer('GET', `/api/records?patient_id=${paddedId}&year=2026&month=8`)).status,
      (await viewer('GET', `/api/meal-prices?patient_id=${pidText}.0&year=2026&month=8`)).status,
      (await admin('PUT', `/api/users/${viewerRow.id}.0`, { username: 'smoke_viewer', role: 'viewer', active: 1 })).status,
    ];
    // 検索条件（URL）と本文に別々の患者IDを書いても、記録されるのは実際に保存された患者
    const decoy = await staff('POST', '/api/records?patient_id=999999', { ...rec, record_date: '2026-11-02' });

    // 細工した書き方のURL: / を重ねる（以前は、記録が1行も残らないまま患者の情報が返った）、%00 を付ける（以前は、記録から患者IDが抜けた）
    const pidQuery = `patient_id=${patients[0].id}&year=2026&month=8`;
    const oddUrls = [
      await viewer('GET', `/api/records//?${pidQuery}`), await viewer('GET', `/api/records//summary?${pidQuery}`),
      await viewer('GET', `/api/pdf//?${pidQuery}`), await viewer('GET', '/api/patients//'), await admin('GET', '/api/users//'),
    ];
    const oddBodies = await Promise.all(oddUrls.map(r => r.text()));
    check('/ を重ねたURL（/api/records//、/api/pdf// など）は 404 で断られ、患者の情報は返らない',
      oddUrls.every(r => r.status === 404) && oddBodies.every(b => b.length < 200 && !b.startsWith('%PDF')), oddUrls.map(r => r.status).join(','));
    const nulUrl = await viewer('GET', `/api/meal-prices?patient_id=${patients[0].id}%00x&year=2026&month=8`);
    const noPatient = await viewer('GET', '/api/meal-prices?year=2026&month=8');
    const oddActive = await admin('PUT', `/api/users/${viewerRow.id}`, { username: 'smoke_viewer', role: 'viewer', active: { toString: 1 } });
    check('%00 を含むURL・指定の欠けた食事単価の要求・状態にオブジェクトを指定した更新は 400（データを返さず、500 にもならない）',
      nulUrl.status === 400 && noPatient.status === 400 && oddActive.status === 400, [nulUrl.status, noPatient.status, oddActive.status].join(','));
    const headView = await viewer('HEAD', `/api/records?${pidQuery}`);
    // URL に行区切りの文字（U+2028・U+2029）を混ぜた表示。以前は、ファイルには書かれるのに操作ログの画面では読めず、
    // 閲覧のみのユーザーでも、自分が患者の記録を見たことを一覧から消せた
    const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
    const sepViews = [
      await viewer('GET', `/api/records?${pidQuery}&z=${encodeURIComponent(LS)}`),
      await viewer('GET', `/api/records/summary?${pidQuery}&z=${encodeURIComponent('x' + LS + 'y' + PS)}`),
    ];

    // 無効にしたユーザーは、ログイン中の画面も新しいログインも使えなくなる。成功するログインを続けても、失敗の回数にはならない
    check('確認用のユーザー作成', (await mk('smoke_off', 'viewer')) === 200);
    const offClient = client('10.9.5.1'), offLogins = [];
    for (let i = 0; i < MAX_FAILURES + 1; i++) offLogins.push((await loginAs(offClient, 'smoke_off', TEST_PASSWORD)).status);
    const offRow = (await (await admin('GET', '/api/users')).json()).find(u => u.username === 'smoke_off');
    check(`成功するログインを ${MAX_FAILURES + 1} 回続けても、ロックされない`, offLogins.every(s => s === 200) && offRow.locked_seconds === 0, offLogins.join(','));
    check('ユーザーを無効にすると、そのユーザーのログイン中の画面は 401 になり、新しいログインもできない',
      (await admin('PUT', `/api/users/${offRow.id}`, { username: 'smoke_off', role: 'viewer', active: 0 })).status === 200 &&
      (await offClient('GET', '/api/wards')).status === 401 && (await loginAs(client('10.9.5.2'), 'smoke_off', TEST_PASSWORD)).status === 401);
    // 患者の削除の記録には、削除した患者の氏名が残る
    await admin('POST', '/api/patients', { ward_id: wards[0].id, name: 'スモーク削除確認', room: '', beneficiary_no: '' });
    const doomed = (await (await admin('GET', '/api/patients')).json()).find(p => p.name === 'スモーク削除確認');
    const deleted = doomed ? await admin('DELETE', `/api/patients/${doomed.id}`) : { status: 0 };

    // 書式の壊れたログインの要求を送っても、サーバーのエラーログにパスワードが出ない
    const broken = await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: '{"username":"smoke_staff","password":"Morenai-pasuwa-do-77',
    });
    await sleep(200);
    check('書式の壊れた要求（400）を送っても、サーバーのログにパスワードが出ない', broken.status === 400 && !log.includes('Morenai-pasuwa-do-77'));

    // パスワードを変更すると、そのユーザーのログイン中の画面は使えなくなる。自分のパスワードを変えた管理者の画面は続けて使える
    check('ほかのユーザーのパスワードを変更すると、そのユーザーのログイン中の画面は 401 になる',
      (await staff('GET', '/api/wards')).status === 200 &&
      (await admin('PUT', `/api/users/${staffRow.id}`, { username: 'smoke_staff', role: 'staff', active: 1, password: NEW_PASSWORD })).status === 200 &&
      (await staff('GET', '/api/wards')).status === 401 && (await loginAs(client('10.9.0.3'), 'smoke_staff', NEW_PASSWORD)).status === 200);
    if (asTestAdmin) {
      const me = (await (await admin('GET', '/api/users')).json()).find(u => u.username === TEST_ADMIN);
      check('管理者が自分のパスワードを変更しても、操作中の画面はそのまま使える',
        (await admin('PUT', `/api/users/${me.id}`, { username: TEST_ADMIN, role: 'admin', active: 1, password: NEW_PASSWORD })).status === 200 &&
        (await admin('GET', '/api/users')).status === 200);
    }

    // 操作ログ
    const auditRes = await admin('GET', '/api/audit?limit=5000');
    const audit = auditRes.status === 200 ? await auditRes.json() : { rows: [] };
    const has = (action, cond = () => true) => audit.rows.some(r => r.action === action && cond(r));
    check('操作ログ：ログイン成功・失敗・ロック・ログアウトが記録されている',
      has('login.success', r => r.user === login.username && r.ip === '10.9.0.1') &&
      has('login.failure', r => r.user === 'smoke_viewer' && r.status === 401 && r.ip === '10.9.0.66') &&
      has('login.failure', r => r.user === 'smoke_viewer' && r.status === 429) && has('login.locked', r => r.user === 'smoke_viewer') &&
      has('logout', r => r.user === 'smoke_staff'));
    check('操作ログ：登録されていないユーザーIDの文字列は記録しない（打ち間違えたパスワードを残さないため）',
      has('login.failure', r => r.user === null && r.detail && r.detail.unknown_id === true && r.detail.length === 'smoke_no_such_user'.length) &&
      !readAudit().includes('smoke_no_such_user'));
    check('操作ログ：実績の保存・断られた保存・表示・PDF出力が、ユーザーと患者つきで記録されている',
      has('records.save', r => r.user === 'smoke_staff' && r.status === 200 && r.patient_id === patients[0].id) &&
      has('records.save', r => r.user === 'smoke_viewer' && r.status === 403) &&
      has('summary.view', r => r.user === 'smoke_viewer') &&
      has('pdf.export', r => r.user === login.username && r.patient_id === pdfTarget.id && r.status === 200));
    check('操作ログ：ユーザーの追加・ロック解除、未ログインでのアクセスが記録されている',
      has('users.create', r => r.status === 200) && has('users.create', r => r.status === 400) &&
      has('users.unlock', r => r.status === 200) && has('patients.list', r => r.user === null && r.status === 401));
    check('操作ログ：プロキシが伝えた接続元（192.168.1.77）が記録されている', has('login.success', r => r.ip === '192.168.1.77'));
    check('操作ログ：IDを変則的な書き方にしても、患者・対象が記録される（送られてきた値も残る）',
      oddIds.every(s => s === 200) &&
      has('records.view', r => r.patient_id === patients[0].id && r.patient_id_raw === paddedId) &&
      has('mealprices.view', r => r.patient_id === patients[0].id && r.patient_id_raw === pidText + '.0') &&
      has('users.update', r => r.target === viewerRow.id && r.target_raw === viewerRow.id + '.0'), oddIds.join(','));
    check('操作ログ：URL と本文に別々の患者IDを書いても、実際に保存された患者が記録される（URL の値も残る）',
      decoy.status === 200 && has('records.save', r => r.patient_id === patients[0].id && r.detail && r.detail.record_date === '2026-11-02' &&
        r.detail._query && r.detail._query.patient_id === '999999'));
    check('操作ログ：/ を重ねたURLの要求は「断った」こととして、操作の種類と患者IDつきで残る。HEAD での表示、削除した患者の氏名も残る',
      has('records.view', r => r.status === 404 && r.patient_id === patients[0].id && r.path === '/api/records//') &&
      has('pdf.export', r => r.status === 404 && r.patient_id === patients[0].id) && has('users.list', r => r.status === 404) &&
      has('mealprices.view', r => r.status === 400 && r.patient_id === patients[0].id) &&
      headView.status === 200 && has('records.view', r => r.method === 'HEAD' && r.status === 200 && r.patient_id === patients[0].id) &&
      deleted.status === 200 && has('patients.delete', r => r.status === 200 && r.patient_id === doomed.id && r.detail && r.detail.name === 'スモーク削除確認'));
    check('操作ログ：URL に行区切りの文字（U+2028・U+2029）を混ぜた表示も、操作ログの画面に出る（その文字で自分の閲覧を隠せない）。読めない行は無い',
      sepViews.every(r => r.status === 200) &&
      has('records.view', r => r.user === 'smoke_viewer' && r.patient_id === patients[0].id && r.detail && r.detail.z === LS) &&
      has('summary.view', r => r.user === 'smoke_viewer' && r.patient_id === patients[0].id && r.detail && r.detail.z === 'x' + LS + 'y' + PS) &&
      audit.unreadable === 0 && !readAudit().includes(LS) && !readAudit().includes(PS),
      `状態 ${sepViews.map(r => r.status).join(',')} / 読めない行 ${audit.unreadable}`);
    check('操作ログ：患者IDでの絞り込み、期間・件数の上限', await (async () => {
      const byPatient = await (await admin('GET', `/api/audit?limit=5000&patient_id=${doomed.id}`)).json();
      const none = await (await admin('GET', '/api/audit?from=2020-01-01&to=2020-01-02')).json();
      const tooLong = await admin('GET', '/api/audit?from=2024-01-01&to=2026-01-01');
      const badPid = await admin('GET', '/api/audit?patient_id=abc');
      const capped = await (await admin('GET', '/api/audit?limit=999999')).json();
      return byPatient.rows.length >= 1 && byPatient.rows.every(x => x.patient_id === doomed.id) && none.rows.length === 0 &&
        tooLong.status === 400 && badPid.status === 400 && capped.rows.length <= 5000;
    })());
    check('操作ログ：絞り込み（断られた操作・エラーだけ）', await (async () => {
      const r = await (await admin('GET', '/api/audit?kind=denied&limit=5000')).json();
      return r.rows.length > 0 && r.rows.every(x => x.status >= 400);
    })());
    check('操作ログ：絞り込み（サーバーの出来事）に、サーバーの起動が出る', await (async () => {
      const r = await (await admin('GET', '/api/audit?kind=system&limit=5000')).json();
      return r.rows.some(x => x.action === 'server.start') && r.rows.every(x => !/^(login|records|patients)\./.test(x.action));
    })());
    check('操作ログ：キーワードに患者の氏名を入れると、その患者の表示・保存の記録が見つかる', await (async () => {
      const r = await (await admin('GET', '/api/audit?limit=5000&q=' + encodeURIComponent(patients[0].name))).json();
      return r.rows.some(x => x.action === 'records.save' && x.patient_id === patients[0].id) && r.rows.every(x => x.action !== 'audit.view');
    })(), patients[0].name);
    check('操作ログ：書き込みの失敗なし', audit.writer && audit.writer.failedCount === 0);
    const auditText = readAudit();
    check('操作ログ：ファイルにパスワードが書かれていない',
      auditText.length > 0 && ![TEST_PASSWORD, NEW_PASSWORD, login.password, WEAK_PASSWORD, WRONG_PASSWORD, 'Test-pass-1', 'Morenai-pasuwa-do-77'].some(p => auditText.includes(p)),
      `${auditText.split('\n').length - 1} 行`);

    // ログイン済みのユーザーが要求を連打しても、「記録に残らない表示・出力」は起きない。
    // 1分あたりの上限までは1件ずつ記録され、超えた分は処理されずに断られる（429）。
    // （以前は、超えた分も処理して「まとめて1行」にしていたため、連打のあとで開いた患者が記録に残らなかった。動作検証.md の S-04）
    check('連打の確認に使うユーザー作成', (await mk('smoke_flood', 'viewer')) === 200);
    const flooder = client('10.9.4.1');
    await loginAs(flooder, 'smoke_flood', TEST_PASSWORD);
    let listOk = 0, sent = 0;
    await Promise.all(Array.from({ length: 30 }, async () => {
      while (sent < USER_PER_MINUTE) {
        sent++;
        const r = await flooder('GET', '/api/patients');
        if (r.status === 200) listOk++;
        await r.arrayBuffer();
      }
    }));
    const target = `patient_id=${pdfTarget.id}&year=${pdfTarget.year}&month=${pdfTarget.month}`;
    const refused = [
      await flooder('GET', '/api/records?' + target),
      await flooder('GET', '/api/records/summary?' + target),
      await flooder('GET', '/api/pdf?' + target),
    ];
    const refusedBodies = await Promise.all(refused.map(r => r.text()));
    await sleep(1300);   // 書き込みがファイルに確定するのを待つ
    const floodLog = readAudit().split('\n').filter(l => l.includes('"smoke_flood"'))
      .map(l => { try { return JSON.parse(l); } catch (_) { return {}; } }).filter(r => r.user === 'smoke_flood');
    check(`同じユーザーが1分間に ${USER_PER_MINUTE} 件を超える要求を送ると、超えた分は処理されずに断られる（429。実績・月次集計・PDF は返らない）`,
      listOk === USER_PER_MINUTE && refused.every(r => r.status === 429) && refusedBodies.every(b => b.length < 300 && !b.startsWith('%PDF')),
      `一覧 ${listOk} 件は成功 → その後の3件は ${refused.map(r => r.status).join(',')}`);
    check('受け付けた要求はすべて1件ずつ記録され、断った要求は「表示した」と記録されない（記録に残らない表示・出力は起きない）',
      floodLog.filter(r => r.action === 'patients.list' && r.status === 200).length === USER_PER_MINUTE &&
      !floodLog.some(r => ['records.view', 'summary.view', 'pdf.export'].includes(r.action)),
      `一覧の記録 ${floodLog.filter(r => r.action === 'patients.list').length} 行`);
    check('連打したユーザー以外は、その間も普通に使える', (await admin('GET', '/api/patients')).status === 200);

    // 未ログインの要求を大量に送られても、1件ずつ記録するのは1分あたり一定の件数までで、本文は記録しない
    // （だれでも送れる要求でディスクを埋められないように）。この確認は記録の枠を使い切るので、最後に行う。
    const floodBody = { marker: 'FLOOD-MARKER-' + 'x'.repeat(2000) };
    const flood = await Promise.all(Array.from({ length: 400 }, () => anon('POST', '/api/smoke-flood', floodBody).then(r => r.status)));
    // 記録の枠を使い切ったあとでも、実在するユーザーへのログイン失敗は必ず記録される（連打で本命の攻撃を隠せない）
    const hidden = await loginAs(client('10.9.3.1'), 'smoke_viewer', WRONG_PASSWORD);
    await sleep(1300);   // 書き込みがファイルに確定するのを待つ
    const afterFlood = readAudit();
    const floodLines = afterFlood.split('\n').filter(l => l.includes('/api/smoke-flood')).length;
    check('未ログインの要求を 400 件送っても、記録は1分あたりの上限（120 件）までで、本文は記録されない',
      flood.every(s => s === 404) && floodLines <= 120 && !afterFlood.includes('FLOOD-MARKER') && (await admin('GET', '/api/wards')).status === 200,
      `記録 ${floodLines} 行 / 送信 ${flood.length} 件`);
    check('記録の枠を使い切ったあとでも、実在するユーザーへのログイン失敗は記録される',
      hidden.status === 401 && afterFlood.split('\n').some(l => l.includes('"login.failure"') && l.includes('"smoke_viewer"') && l.includes('"10.9.3.1"')));
  } catch (e) {
    check('例外なく完了', false, e.message);
  } finally {
    server.kill();
    for (let i = 0; i < 40 && !exited; i++) await sleep(125);

    // 非常用のパスワード再設定ツール（アプリを止めた状態で実行する道具なので、サーバーを止めたあとに確かめる）
    try {
      const toolEnv = { DB_PATH: copy, PORT: String(PORT), HOST: '127.0.0.1', AUDIT_LOG_DIR: auditDir, EXPORT_ENABLED: 'false' };
      const missing = path.join(work, 'no-such-folder', 'hiyou.db');
      const noDb = await runResetTool(['admin'], { ...toolEnv, DB_PATH: missing }, 'x\nx\n');
      check('再設定ツール：DB が見つからないときは中止し、DB を新しく作らない',
        noDb.code === 1 && /DBファイルが見つかりません/.test(noDb.out) && !fs.existsSync(path.dirname(missing)), noDb.out.trim().split('\n')[0]);
      const RESET_PASSWORD = 'Saisettei-4n8v2c6x1';
      // 一覧の表示や、途中で中止になる場合は、DB ファイルを書き換えない（以前は、開いただけでファイルを書き直していた）
      const dbStopped = sha256(copy), mtimeStopped = fs.statSync(copy).mtimeMs;
      const listed = await runResetTool(['--list'], toolEnv);
      const unknown = await runResetTool(['smoke_touroku_nashi'], toolEnv, 'x\nx\n');
      const mismatch = await runResetTool([login.username], toolEnv, `${RESET_PASSWORD}\nchigau-${RESET_PASSWORD}\n`);
      check('再設定ツール：一覧の表示・登録されていないID・入力の不一致では、DB ファイルを書き換えない',
        listed.code === 0 && listed.out.includes(login.username) && unknown.code === 1 && mismatch.code === 1 && /一致しません/.test(mismatch.out) &&
        sha256(copy) === dbStopped && fs.statSync(copy).mtimeMs === mtimeStopped, `終了コード ${listed.code},${unknown.code},${mismatch.code}`);
      const reset = await runResetTool([login.username], toolEnv, `${RESET_PASSWORD}\n${RESET_PASSWORD}\n`);
      const SQL = await require('sql.js')();
      const after = new SQL.Database(fs.readFileSync(copy));
      const hash = after.exec('SELECT password_hash FROM users WHERE username=?', [login.username])[0].values[0][0];
      after.close();
      check('再設定ツール：アプリを止めた状態では、パスワードを設定し直せる（操作ログにも残り、パスワードは書かれない）',
        reset.code === 0 && require('bcryptjs').compareSync(RESET_PASSWORD, hash) &&
        readAudit().includes('"users.password_reset_offline"') && !readAudit().includes(RESET_PASSWORD),
        reset.out.trim().split('\n').slice(-2)[0]);
    } catch (e) {
      check('再設定ツールの確認が例外なく完了', false, e.message);
    }

    if (hasSource) check('元のDBファイルは変更されていない', sha256(src) === before);
    tidyUp();
    if (fs.existsSync(work)) console.log(`     作業用フォルダを消せませんでした。手で削除してください: ${work}`);
    if (!results.every(Boolean)) console.log('\n--- サーバーのログ ---\n' + log.trim());
    console.log(`\n結果: 合格 ${results.filter(Boolean).length} / ${results.length}${results.every(Boolean) ? '（全項目合格）' : ''}`);
    process.exit(results.every(Boolean) ? 0 : 1);
  }
})();
