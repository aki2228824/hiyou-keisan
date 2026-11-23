// 初期パスワード（admin123）や「ユーザーIDと同じパスワード」のままのユーザーが残っていないか確認する。
// 読み取りのみ（DBファイルをメモリに読み込むだけで、書き込みは一切しない）。サーバーの起動中でも実行できる。
//
// 使い方（プロジェクトのフォルダで）:
//   node tools/check-default-password.js                 … .env の DB_PATH、無ければ data/hiyou.db を調べる
//   node tools/check-default-password.js D:\hiyou-data\hiyou.db
// 終了コード: 0 = 問題なし / 1 = 要対応のユーザーあり / 2 = ファイルが読めない
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');

// 引数で指定したファイルは、いまのフォルダから見た場所。.env の DB_PATH は、アプリ（server/database.js）と同じく
// プロジェクトのフォルダから見た場所（別のフォルダから実行しても、アプリと同じファイルを調べるように）
const PROJECT_ROOT = path.join(__dirname, '..');
const envPath = String(process.env.DB_PATH ?? '').trim();
const file = process.argv[2] ? path.resolve(process.argv[2])
  : envPath ? path.resolve(PROJECT_ROOT, envPath) : path.join(PROJECT_ROOT, 'data', 'hiyou.db');

(async () => {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    console.error(`DBファイルが見つからないか、0バイトです: ${file}`);
    process.exit(2);
  }
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(file));
  const rows = db.exec('SELECT username, role, active, password_hash FROM users ORDER BY id')[0]?.values ?? [];
  console.log(`DBファイル: ${file}`);
  let bad = 0;
  for (const [username, role, active, hash] of rows) {
    const weak = [];
    if (bcrypt.compareSync('admin123', hash)) weak.push('初期パスワード admin123 のまま');
    if (bcrypt.compareSync(String(username), hash)) weak.push('パスワードがユーザーIDと同じ');
    const state = active ? '有効' : '無効';
    if (weak.length && active) bad++;
    console.log(`  ${weak.length ? (active ? '[要対応]' : '[無効ユーザー]') : '[OK]    '} ${username}（${role}・${state}）${weak.length ? ' … ' + weak.join(' / ') : ''}`);
  }
  if (bad) {
    console.log(`\n要対応: ${bad} 件。管理者でログインし、マスタ管理 → ユーザー管理 でパスワードを変更してください。`);
    process.exit(1);
  }
  console.log('\n問題なし: 初期パスワードのままの有効ユーザーはいません。');
})().catch(err => { console.error('確認に失敗しました:', err.message); process.exit(2); });
