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
// ・週次レポートは送信しない（EXPORT_ENABLED=false で起動し、ドライランだけを呼ぶ）。
// ・ポート 3150 を使う（変えるときは環境変数 SMOKE_PORT）。本番のサーバーが動いていても実行できる。
// ・請求書PDFも1枚作るので、Chrome が入っていること（npm ci 済みであること）。所要 10〜20 秒。
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

// DBをコピーし、コピーにテスト用の管理者を追加する。戻り値はログインに使うIDとパスワード
async function prepareCopy(src, copy) {
  fs.copyFileSync(src, copy);
  const SQL = await require('sql.js')();
  const db = new SQL.Database(fs.readFileSync(copy));
  const hasUsers = db.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").length > 0;
  if (!hasUsers) { db.close(); return { username: 'admin', password: 'admin123' }; } // 起動時に初期管理者が作られる
  const password = crypto.randomBytes(12).toString('hex');
  db.run('DELETE FROM users WHERE username=?', [TEST_ADMIN]);
  db.run("INSERT INTO users (username, password_hash, role, active) VALUES (?, ?, 'admin', 1)",
    [TEST_ADMIN, require('bcryptjs').hashSync(password, 10)]);
  fs.writeFileSync(copy, Buffer.from(db.export()));
  db.close();
  return { username: TEST_ADMIN, password };
}

// ログイン状態（Cookie）を保持する簡易クライアント
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(BASE + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  };
}

(async () => {
  const src = sourceDbPath();
  const hasSource = fs.existsSync(src) && fs.statSync(src).size > 0;
  const before = hasSource ? sha256(src) : null;
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'hiyou-smoke-'));
  const copy = path.join(work, 'hiyou.db');
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

  server = spawn(process.execPath, [path.join(APP, 'server', 'index.js')], {
    cwd: APP,
    env: { ...process.env, DB_PATH: copy, PORT: String(PORT), EXPORT_ENABLED: 'false' },
  });
  let log = '', exited = false;
  server.stdout.on('data', d => (log += d));
  server.stderr.on('data', d => (log += d));
  server.on('exit', () => { exited = true; });

  try {
    let up = false;
    for (let i = 0; i < 80 && !up && !exited; i++) {
      try { await fetch(BASE + '/'); up = true; } catch (_) { await sleep(250); }
    }
    check('サーバー起動', up);
    if (!up) throw new Error('サーバーが起動しないため以降を省略');

    const anon = client();
    check('GET / → 200', (await anon('GET', '/')).status === 200);
    check('未ログイン /api/auth/me → 401', (await anon('GET', '/api/auth/me')).status === 401);
    check('未ログイン /api/patients → 401', (await anon('GET', '/api/patients')).status === 401);

    const admin = client();
    const res = await admin('POST', '/api/auth/login', login);
    const asTestAdmin = login.username === TEST_ADMIN;
    check(`管理者でログイン（${asTestAdmin ? 'テスト用のユーザー' : '新規DBの初期管理者'}）`, res.status === 200, `status ${res.status}`);
    if (res.status !== 200) throw new Error('ログインできないため以降を省略');

    const wards = await (await admin('GET', '/api/wards')).json();
    let patients = await (await admin('GET', '/api/patients')).json();
    const users = await (await admin('GET', '/api/users')).json();
    console.log(`     病棟 ${wards.length} 件 / 患者 ${patients.length} 名 / ユーザー ${users.length} 件${asTestAdmin ? '（テスト用の管理者を含む）' : ''}`);

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
      pdf.status === 200 && buf.subarray(0, 4).toString() === '%PDF', `status ${pdf.status}, ${buf.length} バイト`);
    check('PDF出力後もサーバーが動作', (await admin('GET', '/api/wards')).status === 200);

    // 権限（コピー上に「閲覧のみ」「一般スタッフ」を作って確認）
    const mk = async (username, role) => (await admin('POST', '/api/users', { username, password: 'Test-pass-1', role })).status;
    check('閲覧のみユーザー作成', (await mk('smoke_viewer', 'viewer')) === 200);
    check('一般スタッフ作成', (await mk('smoke_staff', 'staff')) === 200);
    const viewer = client(), staff = client();
    await viewer('POST', '/api/auth/login', { username: 'smoke_viewer', password: 'Test-pass-1' });
    await staff('POST', '/api/auth/login', { username: 'smoke_staff', password: 'Test-pass-1' });
    const rec = { patient_id: patients[0].id, record_date: '2026-11-01', items: [], meal: { breakfast: 1 } };
    check('閲覧のみ：実績保存は 403', (await viewer('POST', '/api/records', rec)).status === 403);
    check('閲覧のみ：月次集計は 200', (await viewer('GET', `/api/records/summary?patient_id=${patients[0].id}&year=2026&month=8`)).status === 200);
    check('一般スタッフ：実績保存は 200', (await staff('POST', '/api/records', rec)).status === 200);
    check('一般スタッフ：病棟追加は 403', (await staff('POST', '/api/wards', { name: 'x' })).status === 403);
    check('一般スタッフ：ユーザー一覧は 403', (await staff('GET', '/api/users')).status === 403);
    check('不正な日付の実績保存は 400', (await admin('POST', '/api/records', { ...rec, record_date: '2026-02-30' })).status === 400);
    check('週次レポートのドライラン（送信なし）は 200', (await admin('POST', '/api/export/weekly-usage/run?dry=1')).status === 200);
  } catch (e) {
    check('例外なく完了', false, e.message);
  } finally {
    server.kill();
    for (let i = 0; i < 40 && !exited; i++) await sleep(125);
    if (hasSource) check('元のDBファイルは変更されていない', sha256(src) === before);
    tidyUp();
    if (fs.existsSync(work)) console.log(`     作業用フォルダを消せませんでした。手で削除してください: ${work}`);
    if (!results.every(Boolean)) console.log('\n--- サーバーのログ ---\n' + log.trim());
    console.log(`\n結果: 合格 ${results.filter(Boolean).length} / ${results.length}${results.every(Boolean) ? '（全項目合格）' : ''}`);
    process.exit(results.every(Boolean) ? 0 : 1);
  }
})();
