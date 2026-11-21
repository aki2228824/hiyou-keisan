// 非常用: サーバー機の上で、ユーザーのパスワードを直接設定し直す。
// 「管理者がパスワードを忘れた」「管理者が全員ロックされていて、画面から解除できない」ときに使う。
//
// 使い方（サーバー機の管理者 PowerShell で。必ずアプリを止めてから）:
//   Stop-Service hiyoukeisan
//   node C:\hiyou\app\tools\reset-password.js --list        … ユーザーの一覧を表示する（パスワードは変えない）
//   node C:\hiyou\app\tools\reset-password.js <ユーザーID>   … 新しいパスワードを2回入力する（画面には表示されない）
//   Start-Service hiyoukeisan
//
// ・アプリが動いている間は実行できない（動いているアプリは、メモリ上の内容でDBを上書きするので、
//   ここでの変更が消えたり、逆に利用者の入力を消したりするため。応答があれば何もせずに終了する）。
// ・DB の場所は、アプリと同じく .env の DB_PATH（無ければ data/hiyou.db）。
// ・新しいパスワードは、アプリと同じ基準（13文字以上・英字と数字の両方、など）を満たす必要がある。
// ・対象のユーザーが無効になっていたら、有効に戻す。ロールは変えない。
// ・操作ログに「サーバー上のツールでパスワードを再設定した」と残す（だれが実行したかは Windows のユーザー名で記録する）。
// 終了コード: 0 = 完了 / 1 = 中止・失敗
const os = require('os');
const path = require('path');
const readline = require('readline');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const db = require('../server/database');
const audit = require('../server/services/auditLog');
const passwordPolicy = require('../server/services/passwordPolicy');
const bcrypt = require('bcryptjs');

// アプリが動いていないことを確かめる（.env の PORT。HOST を指定していても、サーバー自身からは 127.0.0.1 でつながる）
async function serverIsRunning() {
  const port = process.env.PORT || 3000;
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch (_) {
    return false;
  }
}

// パスワードの入力。画面（端末）から入力するときは、打った文字を表示しない。
// 端末でないとき（ほかのプログラムから文字を流し込むとき）は、1行ずつ読む。
function createAsker() {
  if (!process.stdin.isTTY) {
    const lines = [];
    let waiting = null, ended = false;
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', l => { if (waiting) { const w = waiting; waiting = null; w(l); } else lines.push(l); });
    rl.on('close', () => { ended = true; if (waiting) { const w = waiting; waiting = null; w(''); } });
    return { ask: () => new Promise(resolve => { if (lines.length) resolve(lines.shift()); else if (ended) resolve(''); else waiting = resolve; }), close: () => rl.close() };
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let muted = false;
  rl._writeToOutput = text => { if (!muted) rl.output.write(text); };
  return {
    ask: prompt => new Promise(resolve => {
      process.stdout.write(prompt);
      muted = true;
      rl.question('', answer => { muted = false; process.stdout.write('\n'); resolve(answer); });
    }),
    close: () => rl.close(),
  };
}

(async () => {
  const target = process.argv[2];
  if (!target) {
    console.error('使い方: node tools/reset-password.js <ユーザーID>   （一覧を見るには --list）');
    process.exitCode = 1;
    return;
  }
  if (await serverIsRunning()) {
    console.error('アプリが動いています。先に止めてから実行してください（例: Stop-Service hiyoukeisan）。何も変更していません。');
    process.exitCode = 1;
    return;
  }

  await db.getDb();
  const users = db.query('SELECT id, username, role, active FROM users ORDER BY id');
  const show = () => { for (const u of users) console.log(`  ${u.username}（${u.role}・${u.active ? '有効' : '無効'}）`); };
  if (target === '--list') { console.log('登録されているユーザー:'); show(); return; }

  const user = users.find(u => u.username === target);
  if (!user) {
    console.error(`ユーザーID「${target}」は登録されていません。登録されているユーザー:`);
    show();
    process.exitCode = 1;
    return;
  }

  console.log(`ユーザー「${user.username}」（${user.role}）のパスワードを設定し直します。`);
  console.log(`基準: ${passwordPolicy.describe()}`);
  const asker = createAsker();
  let password;
  try {
    password = await asker.ask('新しいパスワード: ');
    const again = await asker.ask('もう一度: ');
    if (password !== again) {
      console.error('2回の入力が一致しません。何も変更していません。');
      process.exitCode = 1;
      return;
    }
  } finally {
    asker.close();
  }
  const problems = passwordPolicy.check(password, { username: user.username });
  if (problems.length) {
    console.error(passwordPolicy.errorMessage(problems) + '\n何も変更していません。');
    process.exitCode = 1;
    return;
  }

  db.run('UPDATE users SET password_hash=?, active=1 WHERE id=?', [bcrypt.hashSync(password, 10), user.id]);
  try {
    audit.init(db.dbPath);
    audit.recordSystem('users.password_reset_offline', {
      username: user.username, reactivated: user.active ? undefined : true, windows_user: os.userInfo().username, computer: os.hostname(),
    });
    audit._test.close();
  } catch (err) {
    console.error('（注意）操作ログに記録できませんでした: ' + err.message);
  }
  console.log(`ユーザー「${user.username}」のパスワードを変更しました${user.active ? '' : '（無効になっていたので、有効に戻しました）'}。`);
  console.log('アプリを起動してください（例: Start-Service hiyoukeisan）。ログインの失敗によるロックは、起動し直すと消えます。');
})().catch(err => {
  console.error('失敗しました: ' + err.message);
  process.exitCode = 1;
});
