// お試し用のフォルダを作る。
// このアプリを、Node.js を入れていない別の PC で、そのまま動かして画面を見てもらうためのもの
// （Wi-Fi が機器どうしの通信を止めていて、ほかの PC からこの PC のアプリを開けないとき、など）。
//
// 使い方（プロジェクトのフォルダで）:
//   node tools/make-trial-package.js                      … 空の DB のお試し用フォルダを、プロジェクトの隣に作る（<プロジェクト名>-otameshi）
//   node tools/make-trial-package.js --with-data          … いまの DB の写しを入れる（テスト用のデータしか入っていない DB で使うこと）
//   node tools/make-trial-package.js --out D:\somewhere   … 作る場所を指定する
//
// できるもの（フォルダごと、相手の PC にコピーして使う）:
//   start-trial.cmd … ダブルクリックで起動する（その PC の中だけで動き、ブラウザーが自動で開く）
//   使い方.txt       … 使い方と、お試し用のログイン（ユーザーID とパスワード）
//   そのほか         … アプリの本体、Node.js（node.exe）、請求書 PDF 用の Chrome、DB
//
// ・.env は入れない（API キーを持ち出さない。お試し用のフォルダからは、週次レポートは送信されない）。
// ・待ち受けは 127.0.0.1 だけにする（その PC の中からしか開けない。Windows の警告も出ない）。
// ・本物の患者の情報が入った DB では、--with-data を使わない（患者の情報を、別の PC へ持ち出すことになる）。
// ・元の DB には書き込まない（--with-data のときも、読むだけ）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const withData = args.includes('--with-data');
const outAt = args.indexOf('--out');
const OUT = path.resolve(outAt >= 0 && args[outAt + 1] ? args[outAt + 1] : path.join(ROOT, '..', path.basename(ROOT) + '-otameshi'));
const TRIAL_USER = 'otameshi';
const APP_PATHS = ['server', 'public', 'tools', 'package.json', 'package-lock.json', '.puppeteerrc.cjs'];

const fail = message => { console.error(message); process.exit(1); };
const sizeOf = target => {
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return stat.size;
  return fs.readdirSync(target).reduce((sum, name) => sum + sizeOf(path.join(target, name)), 0);
};

// いまの DB の場所（アプリと同じ読み方: .env の DB_PATH をプロジェクトのフォルダから見る。無ければ data/hiyou.db）
function sourceDbPath() {
  try {
    const env = require('dotenv').parse(fs.readFileSync(path.join(ROOT, '.env')));
    if (String(env.DB_PATH ?? '').trim()) return path.resolve(ROOT, String(env.DB_PATH).trim());
  } catch (_) { /* .env が無ければ既定の場所 */ }
  return path.join(ROOT, 'data', 'hiyou.db');
}

// パスワードの基準を満たす、お試し用のパスワードを作る（読み間違えやすい 0・O・1・l・I は使わない）
function makePassword(policy) {
  const letters = 'abcdefghjkmnpqrstuvwxyz', digits = '23456789';
  for (let attempt = 0; attempt < 200; attempt++) {
    const bytes = crypto.randomBytes(16);
    let password = '';
    for (let i = 0; i < 16; i++) password += i % 4 === 3 ? digits[bytes[i] % digits.length] : letters[bytes[i] % letters.length];
    if (!policy.check(password, { username: TRIAL_USER }).length) return password;
  }
  throw new Error('お試し用のパスワードを作れませんでした');
}

(async () => {
  if (fs.existsSync(OUT)) fail(`作る場所に、同じ名前のフォルダ・ファイルが既にあります: ${OUT}\n上書きはしません。前に作ったものが不要なら、削除してから実行してください（--out で別の場所を指定することもできます）。`);
  if ((OUT + path.sep).toLowerCase().startsWith((path.resolve(ROOT) + path.sep).toLowerCase())) fail('作る場所は、プロジェクトのフォルダの外にしてください。');
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'express'))) fail('node_modules がありません。先に npm ci を実行してください。');

  console.log(`お試し用のフォルダを作ります: ${OUT}`);

  // DB の写しを入れる場合は、何が入るかを先に示す
  let dataNote = '入っているのは、空の DB です（病棟 3 つと物品の初期値だけ。患者は、マスタ管理 → 患者管理 で登録して試せます）。';
  const src = sourceDbPath();
  if (withData) {
    if (!fs.existsSync(src) || fs.statSync(src).size === 0) fail(`DB が見つかりません: ${src}`);
    const SQL = await require('sql.js')();
    const mem = new SQL.Database(fs.readFileSync(src));
    const count = table => mem.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0];
    const patients = count('patients'), records = count('records'), users = count('users');
    mem.close();
    console.log(`いまの DB の写しを入れます: ${src}`);
    console.log(`  患者 ${patients} 名、実績 ${records} 件、ユーザー ${users} 件が、お試し用のフォルダに入ります。`);
    console.log('  （本物の患者の情報が入っている場合は、このフォルダを別の PC へ持ち出さないでください）');
    const at = new Date();
    const stamp = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    dataNote = `入っているのは、作成元の PC の DB の写しです（${stamp} 時点。患者 ${patients} 名）。`;
  }

  // 1. アプリの本体と、依存ライブラリ
  fs.mkdirSync(OUT, { recursive: true });
  for (const name of APP_PATHS) {
    const from = path.join(ROOT, name);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(OUT, name), { recursive: true });
  }
  console.log('  アプリの本体をコピーしました');
  fs.cpSync(path.join(ROOT, 'node_modules'), path.join(OUT, 'node_modules'), { recursive: true });
  console.log('  依存ライブラリ（node_modules）をコピーしました');

  // 2. 請求書 PDF 用の Chrome（いま使っている版だけ）
  const cacheDir = process.env.PUPPETEER_CACHE_DIR || path.join(ROOT, '.cache', 'puppeteer');
  process.env.PUPPETEER_CACHE_DIR = cacheDir;
  let hasChrome = false;
  try {
    const chrome = await require('puppeteer').executablePath();
    const relative = path.relative(cacheDir, chrome).split(path.sep);   // chrome / win64-版 / chrome-win64 / chrome.exe
    if (fs.existsSync(chrome) && relative.length >= 2 && !relative[0].startsWith('..')) {
      const versionDir = path.join(relative[0], relative[1]);
      fs.cpSync(path.join(cacheDir, versionDir), path.join(OUT, '.cache', 'puppeteer', versionDir), { recursive: true });
      hasChrome = true;
      console.log(`  請求書 PDF 用の Chrome をコピーしました（${relative[1]}）`);
    }
  } catch (_) { /* 下で知らせる */ }
  if (!hasChrome) console.log('  （注意）請求書 PDF 用の Chrome が見つからないので、入れていません。お試し用のフォルダでは、PDF を出力できません。');

  // 3. Node.js そのもの（相手の PC に Node.js を入れなくても動くように）
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
  fs.copyFileSync(process.execPath, path.join(OUT, nodeName));
  console.log(`  Node.js（${process.version}）をコピーしました`);

  // 4. DB（写し、または新規）。お試し用のユーザーを 1 つ足す。元の DB には書き込まない
  const outDb = path.join(OUT, 'data', 'hiyou.db');
  fs.mkdirSync(path.dirname(outDb), { recursive: true });
  if (withData) fs.copyFileSync(src, outDb);
  process.env.DB_PATH = outDb;                       // server/database.js は、読み込まれるときにこの値を見る
  const realLog = console.log;
  console.log = () => {};                            // 「DBファイル: …」の表示は、ここでは出さない
  let password;
  try {
    const db = require('../server/database');
    if (path.resolve(db.dbPath) !== path.resolve(outDb)) throw new Error('DB の場所を切り替えられませんでした（お試し用のフォルダの DB だけを書き換えるための確認）');
    await db.getDb();
    const policy = require('../server/services/passwordPolicy');
    password = makePassword(policy);
    const hash = require('bcryptjs').hashSync(password, 10);
    if (db.query('SELECT id FROM users WHERE username=?', [TRIAL_USER]).length)
      db.run("UPDATE users SET password_hash=?, role='admin', active=1 WHERE username=?", [hash, TRIAL_USER]);
    else
      db.run("INSERT INTO users (username, password_hash, role, active) VALUES (?, ?, 'admin', 1)", [TRIAL_USER, hash]);
  } finally {
    console.log = realLog;
  }
  console.log(`  DB を用意しました（${withData ? 'いまの DB の写し' : '新規'}。お試し用のユーザー「${TRIAL_USER}」を追加）`);

  // 5. 起動用のファイルと、使い方
  const cmd = [
    '@echo off',
    'rem Trial launcher: runs the application on this PC only (127.0.0.1) and opens the browser.',
    'cd /d "%~dp0"',
    'if not exist "%~dp0node.exe" (',
    '  echo node.exe was not found in this folder. Copy the whole folder again.',
    '  pause',
    '  exit /b 1',
    ')',
    'set "HOST=127.0.0.1"',
    'set "EXPORT_ENABLED=false"',
    'if not defined PORT set "PORT=3000"',
    'if not defined HIYOU_TRIAL_NO_BROWSER start "" /min cmd /c "ping -n 5 127.0.0.1 >nul & start http://localhost:%PORT%/"',
    '"%~dp0node.exe" server\\index.js',
    'echo.',
    'echo ----------------------------------------------------------------',
    'echo  The application has stopped. You can close this window.',
    'echo  If it stopped at once, the reason is in the lines above.',
    'echo ----------------------------------------------------------------',
    'pause >nul',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(OUT, 'start-trial.cmd'), cmd, 'ascii');

  const guide = [
    '療養介護サービス提供実績記録票　お試し用フォルダ',
    '',
    'このフォルダだけで、アプリを動かして画面を確認できます（インストールは不要です）。',
    'この PC の中だけで動き、ほかの PC からは見えません。',
    '',
    '■ 使い方',
    '1. このフォルダを、フォルダごと PC の中（デスクトップなど）にコピーします。',
    '2. フォルダの中の「start-trial.cmd」をダブルクリックします。',
    '   黒い画面が開き、数秒後にブラウザーでログインの画面が開きます。',
    '   開かないときは、ブラウザー（Edge や Chrome）で http://localhost:3000 を開いてください。',
    '3. 次のユーザーID とパスワードでログインします（お試し用。すべての画面を使えます）。',
    `     ユーザーID: ${TRIAL_USER}`,
    `     パスワード: ${password}`,
    '4. 終わるときは、黒い画面を閉じます（閉じると、アプリが止まります）。',
    '',
    '■ 知っておくこと',
    `・${dataNote}`,
    '・ここで入力した内容は、このフォルダの中にだけ保存されます。元の PC や、本番の環境には反映されません。',
    hasChrome ? '・請求書 PDF も出力できます（月次集計 → PDF）。' : '・このフォルダでは、請求書 PDF は出力できません（PDF 用の部品を入れていないため）。',
    '・週次レポートは送信されません。',
    '・「Windows によって PC が保護されました」と出た場合は、「詳細情報」→「実行」を押します。',
    '・黒い画面に EADDRINUSE と出てすぐに止まる場合は、3000 番を別のプログラムが使っています。',
    '  そのプログラムを止めるか、作成した人に知らせてください。',
    '・確認が終わったら、このフォルダを削除してください。',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(OUT, '使い方.txt'), '\uFEFF' + guide, 'utf8');

  const megabytes = Math.round(sizeOf(OUT) / 1024 / 1024);
  console.log(`\nできました: ${OUT}（約 ${megabytes} MB）`);
  console.log('このフォルダを、フォルダごと相手の PC へコピーして（USB メモリなど）、中の start-trial.cmd をダブルクリックしてもらってください。');
  console.log(`ログインは、ユーザーID「${TRIAL_USER}」・パスワード「${password}」（フォルダの中の 使い方.txt にも書いてあります）。`);
  if (withData) console.log('（このフォルダには DB の写しが入っています。確認が終わったら、相手の PC とコピーに使った USB メモリから削除してください）');
  process.exit(0);
})().catch(err => fail('失敗しました: ' + err.message));
