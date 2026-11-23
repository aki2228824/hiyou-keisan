// 画面の回帰テスト。新規の DB でサーバーを一時的に起動し、実際の画面（public/index.html と app.js）を、
// 請求書 PDF にも使っている Chrome で動かして確かめる。
// API だけのテスト（tools/smoke-test.js）では見つけられない、画面の中での取り違えを見つけるためのもの
// （例: 患者の切り替えに失敗したあと、前の患者の表が残ったまま、別の患者として保存される）。
// 画面のコード（public/js/app.js）や、金額の計算にかかわるコードを変更したら、push の前に実行する。
//
// 使い方（プロジェクトのフォルダで）:
//   node tools/ui-test.js
//
// ・本番の DB と操作ログには触れない（OS の一時フォルダに新規の DB を作って使い、終わったら消す）。
// ・ポート 3160 を使う（変えるときは環境変数 UI_TEST_PORT）。本番のサーバーが動いていても実行できる。
// ・Chrome が入っていること（npm ci 済みであること）。所要 30〜60 秒。
// 終了コード: 0 = 全項目合格 / 1 = 不合格あり
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.UI_TEST_PORT) || 3160;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'Gamen-kensa-7k3m9x2q';
const YEAR = 2026, MONTH = 11, YM = '2026-11';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
};

let server = null, browser = null, work = null, tidied = false;
function tidyUp() {
  if (tidied) return;
  tidied = true;
  try { if (server && server.exitCode === null) server.kill(); } catch (_) { /* 既に終了している */ }
  try { if (work) fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (_) { /* 消せなければ最後に案内する */ }
}
process.on('exit', tidyUp);
process.on('SIGINT', () => process.exit(1));

// ログイン状態（Cookie）を保持する簡易クライアント（準備と、保存された内容の確認に使う）
function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(BASE + url, {
      method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  };
  call.json = async (method, url, body) => (await call(method, url, body)).json();
  return call;
}
async function waitFor(test, ms = 6000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) if (await test()) return true;
  return false;
}

(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'hiyou-ui-'));
  console.log(`作業用フォルダ: ${work} / ポート ${PORT} / Node ${process.version}\n`);
  let portBusy = false;
  try { await fetch(BASE + '/', { signal: AbortSignal.timeout(1500) }); portBusy = true; } catch (_) { /* 空いている */ }
  if (portBusy) { console.error(`ポート ${PORT} は使用中です。環境変数 UI_TEST_PORT で別の番号を指定してください。`); process.exit(1); }

  server = spawn(process.execPath, [path.join(APP, 'server', 'index.js')], {
    cwd: APP,
    env: { ...process.env, DB_PATH: path.join(work, 'hiyou.db'), AUDIT_LOG_DIR: path.join(work, 'audit'), PORT: String(PORT), HOST: '127.0.0.1', EXPORT_ENABLED: 'false' },
  });
  let log = '', exited = false;
  server.stdout.on('data', d => (log += d));
  server.stderr.on('data', d => (log += d));
  server.on('exit', () => { exited = true; });

  try {
    const up = await waitFor(async () => { if (exited) return true; try { await fetch(BASE + '/'); return true; } catch (_) { return false; } }, 20000);
    check('サーバー起動', up && !exited);
    if (!up || exited) throw new Error('サーバーが起動しないため以降を省略');

    // ---------------------------------------------------------------- 準備（API で、テスト用のデータを入れる）
    const api = client();
    await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
    await api('POST', '/api/users', { username: 'ui_admin', password: PASSWORD, role: 'admin' });
    await api('POST', '/api/users', { username: 'ui_staff', password: PASSWORD, role: 'staff' });
    const wards = await api.json('GET', '/api/wards');
    for (const name of ['AAA', 'BBB', 'CCC']) await api('POST', '/api/patients', { ward_id: wards[0].id, name, room: '1', beneficiary_no: '' });
    const patients = await api.json('GET', '/api/patients');
    const A = patients.find(p => p.name === 'AAA').id, B = patients.find(p => p.name === 'BBB').id, C = patients.find(p => p.name === 'CCC').id;
    const items = await api.json('GET', '/api/items');
    const item0 = items[0], item2 = items[2];   // 入浴、小タオル（初期の物品）
    const priceRows = await api.json('GET', `/api/items/prices?year=${YEAR}&month=${MONTH}`);
    const priceOf = id => Number(priceRows.find(p => p.id === id).unit_price);
    await api('POST', '/api/records', { patient_id: A, record_date: '2026-11-03', items: [{ item_id: item0.id, quantity: 7 }, { item_id: item2.id, quantity: 1 }], meal: { breakfast: 1 } });
    await api('POST', '/api/meal-prices', { patient_id: A, year: YEAR, month: MONTH, breakfast_price: 300, lunch_price: 0, dinner_price: 0, meal_cap: 0 });
    const expectedItemTotal = 7 * priceOf(item0.id) + 1 * priceOf(item2.id);
    const mealPrice = async id => api.json('GET', `/api/meal-prices?patient_id=${id}&year=${YEAR}&month=${MONTH}`);
    const recordsOf = async id => (await api.json('GET', `/api/records?patient_id=${id}&year=${YEAR}&month=${MONTH}`)).records;

    // ---------------------------------------------------------------- 画面
    browser = await puppeteer.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const dialogs = [];
    let dialogAction = 'accept';
    page.on('dialog', async d => { dialogs.push(d.message()); await (dialogAction === 'dismiss' ? d.dismiss() : d.accept()).catch(() => {}); });
    const login = async () => {
      await page.waitForSelector('#login-overlay:not(.hidden)');
      await page.$eval('#login-username', el => { el.value = 'ui_admin'; });
      await page.$eval('#login-password', (el, pw) => { el.value = pw; }, PASSWORD);
      await page.click('#login-overlay .login-btn');
      await page.waitForSelector('#login-overlay.hidden');
    };
    const patientBtn = id => `.patient-btn[onclick="selectPatient(${id})"]`;
    const cell = (date, itemId) => `#monthly-tbl [data-date="${date}"][data-item="${itemId}"]`;
    const SAVE_ALL = '#input-form .monthly-header button';
    const state = () => page.evaluate((date, itemId) => ({
      highlighted: document.querySelector('.patient-btn.active')?.textContent.trim() ?? null,
      hasTable: !!document.getElementById('monthly-tbl'),
      title: document.querySelector('.monthly-title')?.textContent ?? '',
      cell: document.querySelector(`#monthly-tbl [data-date="${date}"][data-item="${itemId}"]`)?.value ?? null,
      mealButton: document.querySelector('.meal-price-bar button')?.getAttribute('onclick') ?? null,
      mpLunch: document.getElementById('mp-lunch')?.value ?? null,
      itemCost: document.getElementById('item-cost-total')?.textContent ?? null,
      headers: [...document.querySelectorAll('#monthly-tbl thead th')].map(th => th.textContent).join('|'),
    }), '2026-11-03', item0.id);
    const typeInto = async (selector, text) => {
      await page.$eval(selector, el => { el.value = ''; });
      await page.type(selector, text);
    };
    const openPatient = async id => {
      await page.click(patientBtn(id));
      return waitFor(async () => { const s = await state(); return s.hasTable && s.mealButton === `saveMealPrices(${id},${YEAR},${MONTH})`; });
    };

    await page.goto(BASE + '/');
    await login();
    await page.$eval('#sel-month', (el, ym) => { el.value = ym; }, YM);
    await page.waitForSelector('#ward-buttons .ward-btn');
    await page.click('#ward-buttons .ward-btn');
    await page.waitForSelector(patientBtn(A));
    const opened = await openPatient(A);
    let s = await state();
    check('日次入力：患者を選ぶと、その患者の表が出て、見出しに氏名が出る',
      opened && s.title.includes('AAA') && s.cell === '7' && s.highlighted === 'AAA', `見出し「${s.title}」`);

    // 患者の切り替えに失敗したとき（ここでは、ログインが切れた状態を作る。サーバーの再起動・通信エラー・要求が多すぎる、でも同じ）
    await page.deleteCookie(...(await page.cookies()));
    await page.click(patientBtn(B));
    await page.waitForSelector('#login-overlay:not(.hidden)');
    const afterFail = await state();
    await login();
    await sleep(800);
    const afterRelogin = await state();
    check('日次入力：患者の切り替えに失敗したら、前の患者の表は残らない（前の患者の表に入力して、別の患者に保存されることが無い）',
      !afterFail.hasTable && !afterRelogin.hasTable && afterRelogin.highlighted === null,
      `失敗の直後: 表${afterFail.hasTable ? 'あり' : 'なし'} / ログインし直したあと: 表${afterRelogin.hasTable ? 'あり' : 'なし'}・選択中 ${afterRelogin.highlighted}`);

    // 前の患者の応答が遅れて届いたとき（患者を続けてクリックした、回線が遅い、など）
    await page.setRequestInterception(true);
    const delayA = req => {
      if (req.url().includes(`/api/records?patient_id=${A}&`)) setTimeout(() => req.continue().catch(() => {}), 1500);
      else req.continue().catch(() => {});
    };
    page.on('request', delayA);
    await page.click(patientBtn(A));
    await sleep(150);
    await page.click(patientBtn(B));
    await sleep(2800);
    s = await state();
    page.off('request', delayA);
    await page.setRequestInterception(false);
    check('日次入力：前の患者の応答が遅れて届いても、表は「選択中の患者」のもの（表と選択中の患者が食い違わない）',
      s.hasTable && s.highlighted === 'BBB' && s.title.includes('BBB') && s.cell === '' && s.mealButton === `saveMealPrices(${B},${YEAR},${MONTH})`,
      `選択中 ${s.highlighted} / 見出し「${s.title}」 / 単価保存の対象 ${s.mealButton}`);

    // 食事単価を入れて「一括保存」だけを押す
    await typeInto('#mp-breakfast', '250');
    await page.click(SAVE_ALL);
    const priceSaved = await waitFor(async () => Number((await mealPrice(B)).breakfast_price) === 250);
    check('日次入力：食事単価を入れて「一括保存」を押すと、単価も保存される（ほかの患者の単価は変わらない）',
      priceSaved && Number((await mealPrice(A)).breakfast_price) === 300, `BBB ${(await mealPrice(B)).breakfast_price} 円 / AAA ${(await mealPrice(A)).breakfast_price} 円`);

    // 食事単価を保存しないまま、患者を切り替えようとする
    await typeInto('#mp-lunch', '100');
    dialogs.length = 0;
    dialogAction = 'dismiss';
    await page.click(patientBtn(A));
    await sleep(600);
    s = await state();
    dialogAction = 'accept';
    check('日次入力：食事単価を保存しないまま患者を切り替えようとすると、確認が出る（取りやめれば、入力はそのまま残る）',
      dialogs.some(m => /保存していない入力/.test(m)) && s.title.includes('BBB') && s.mpLunch === '100', `確認 ${dialogs.length} 回`);

    // 表に入力して保存した内容は、表に出ている患者に保存される
    await page.type(cell('2026-11-05', item0.id), '2');
    await page.click(SAVE_ALL);
    const saved = await waitFor(async () => (await recordsOf(B)).some(r => r.record_date === '2026-11-05' && Number(r.quantity) === 2));
    check('日次入力：表に入力して保存した内容は、表に出ている患者に保存される',
      saved && !(await recordsOf(A)).some(r => r.record_date === '2026-11-05') && Number((await mealPrice(B)).lunch_price) === 100);

    // 無効にした物品（月の途中で取り扱いをやめた、など）に実績があるとき: 入力画面・月次集計・請求書 PDF の金額が同じ
    await api('PUT', `/api/items/${item2.id}`, { name: item2.name, sort_order: item2.sort_order, active: 0 });
    const reopened = await openPatient(A);
    s = await state();
    const summaryA = await api.json('GET', `/api/records/summary?patient_id=${A}&year=${YEAR}&month=${MONTH}`);
    const pdfText = await (await api('GET', `/api/pdf?patient_id=${A}&year=${YEAR}&month=${MONTH}&format=html`)).text();
    const pdfTotal = Number(((/日用品費合計[：:]\s*([\d,]+)\s*円/.exec(pdfText.replace(/<[^>]*>/g, '')) || [])[1] || 'NaN').replace(/,/g, ''));
    const screenTotal = Number(String(s.itemCost).replace(/,/g, ''));
    check('無効にした物品に実績があるとき、日用品費の合計は 入力画面・月次集計・請求書 PDF で同じ（画面には「（無効）」と出る）',
      reopened && summaryA.itemTotal === expectedItemTotal && screenTotal === expectedItemTotal && pdfTotal === expectedItemTotal && s.headers.includes(item2.name + '（無効）'),
      `月次集計 ${summaryA.itemTotal} 円 / 入力画面 ${screenTotal} 円 / PDF ${pdfTotal} 円（正しい値 ${expectedItemTotal} 円）`);
    await openPatient(B);
    s = await state();
    check('無効にした物品は、実績の無い患者の表には出ない', s.hasTable && !s.headers.includes(item2.name));

    // 月次集計: 無効にした患者（退院など）も、その月に実績があれば出る
    await api('PUT', `/api/patients/${A}`, { ward_id: wards[0].id, name: 'AAA', room: '1', beneficiary_no: '', active: 0 });
    await api('PUT', `/api/patients/${C}`, { ward_id: wards[0].id, name: 'CCC', room: '1', beneficiary_no: '', active: 0 });
    await page.click('#nav-summary');
    await page.$eval('#sum-month', (el, ym) => { el.value = ym; }, YM);
    await page.click('#page-summary .toolbar button');
    await waitFor(() => page.evaluate(() => !!document.querySelector('#summary-table .summary-table')));
    const summaryText = await page.evaluate(() => document.getElementById('summary-table').textContent.replace(/\s+/g, ' '));
    check('月次集計：無効にした患者も、その月に実績があれば出る（実績の無い無効の患者は出ない）。表の上に年月が出る',
      summaryText.includes('AAA（無効）') && summaryText.includes('BBB') && !summaryText.includes('CCC') && summaryText.includes('2026年11月'),
      summaryText.slice(0, 60));

    // 月次集計: 読み込みに失敗したら、前に表示した月の表を残さない
    await page.setRequestInterception(true);
    const failOne = req => {
      if (req.url().includes(`/api/records/summary?patient_id=${B}&`)) req.abort().catch(() => {});
      else req.continue().catch(() => {});
    };
    page.on('request', failOne);
    await page.$eval('#sum-month', el => { el.value = '2026-10'; });
    await page.click('#page-summary .toolbar button');
    await sleep(1200);
    const afterFailedSummary = await page.evaluate(() => ({
      table: !!document.querySelector('#summary-table .summary-table'), text: document.getElementById('summary-table').textContent.trim(),
    }));
    page.off('request', failOne);
    await page.setRequestInterception(false);
    check('月次集計：読み込みに失敗したら、前に表示した月の表は残らない', !afterFailedSummary.table && /読み込めませんでした/.test(afterFailedSummary.text), afterFailedSummary.text.slice(0, 40));

    // ユーザー管理: ほかの行に入力中の内容は、「追加」で一覧を読み直しても残る
    const staffId = (await api.json('GET', '/api/users')).find(u => u.username === 'ui_staff').id;
    await page.click('#nav-master');
    await page.click('#mtab-users');
    await page.waitForSelector(`#u-pass-${staffId}`);
    await page.type(`#u-pass-${staffId}`, 'nyuuryoku-chuu-no-moji');
    await page.type('#new-u-name', 'ui_new');
    await page.type('#new-u-pass', PASSWORD);
    await page.click('#master-users .add-row button');
    const added = await waitFor(async () => (await api.json('GET', '/api/users')).some(u => u.username === 'ui_new'));
    await sleep(600);
    const kept = await page.$eval(`#u-pass-${staffId}`, el => el.value);
    check('ユーザー管理：ユーザーを追加しても、ほかの行に入力中の内容は残る', added && kept === 'nyuuryoku-chuu-no-moji');

    // 数量・単価は整数だけ（小数や、指数・16進の書き方は受け付けない）
    const post = (url, body) => api('POST', url, body).then(r => r.status);
    const rec = quantity => ({ patient_id: B, record_date: '2026-11-06', items: [{ item_id: item0.id, quantity }] });
    const statuses = [
      await post('/api/records', rec(1.5)), await post('/api/records', rec('1e2')), await post('/api/records', rec('0x10')), await post('/api/records', rec(10000)),
      await post('/api/records', { ...rec(0), meal: { breakfast: 0.5 } }),
      await post('/api/items/prices', { item_id: item0.id, year: YEAR, month: MONTH, unit_price: 0.1 }),
      await post('/api/meal-prices', { patient_id: B, year: YEAR, month: MONTH, breakfast_price: 12.5, lunch_price: 0, dinner_price: 0, meal_cap: 0 }),
    ];
    const whole = [await post('/api/records', rec('3')), await post('/api/records', rec(4))];
    check('数量・回数・単価は、整数だけを受け付ける（小数や "1e2"・"0x10" のような書き方、大きすぎる値は 400）',
      statuses.every(x => x === 400) && whole.every(x => x === 200), `断るべきもの ${statuses.join(',')} / 受け付けるべきもの ${whole.join(',')}`);

    // ユーザーIDを変えたら、古いIDに付いていたロックは残らない
    await api('POST', '/api/users', { username: 'ui_lock', password: PASSWORD, role: 'viewer' });
    const other = client();
    for (let i = 0; i < 5; i++) await other('POST', '/api/auth/login', { username: 'ui_lock', password: 'machigai-' + i });
    const lockedRow = (await api.json('GET', '/api/users')).find(u => u.username === 'ui_lock');
    await api('PUT', `/api/users/${lockedRow.id}`, { username: 'ui_lock_kai', role: 'viewer', active: 1 });
    await api('POST', '/api/users', { username: 'ui_lock', password: PASSWORD, role: 'viewer' });
    const reused = (await api.json('GET', '/api/users')).find(u => u.username === 'ui_lock');
    check('ロック中のユーザーIDを変えたあと、同じIDを別のユーザーに付けても、最初からロック中にならない',
      lockedRow.locked_seconds > 0 && reused && reused.locked_seconds === 0 && (await other('POST', '/api/auth/login', { username: 'ui_lock', password: PASSWORD })).status === 200,
      `変更前のロック 残り ${lockedRow.locked_seconds} 秒 / 付け直したID 残り ${reused && reused.locked_seconds} 秒`);
  } catch (e) {
    check('例外なく完了', false, e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
    await waitFor(async () => exited, 5000);
    tidyUp();
    if (fs.existsSync(work)) console.log(`     作業用フォルダを消せませんでした。手で削除してください: ${work}`);
    if (!results.every(Boolean)) console.log('\n--- サーバーのログ ---\n' + log.trim());
    console.log(`\n結果: 合格 ${results.filter(Boolean).length} / ${results.length}${results.every(Boolean) ? '（全項目合格）' : ''}`);
    process.exit(results.every(Boolean) ? 0 : 1);
  }
})();
