// 非常用: サーバー機の上で、ユーザーのパスワードを直接設定し直す。
// 「管理者がパスワードを忘れた」ときに使う（ログインの失敗によるロックだけなら、アプリを起動し直せば消える）。
//
// 使い方（サーバー機で、新しく開いた管理者 PowerShell から。必ずアプリを止めてから）:
//   Stop-Service hiyoukeisan
//   node C:\hiyou\app\tools\reset-password.js --list        … ユーザーの一覧を表示する（パスワードは変えない）
//   node C:\hiyou\app\tools\reset-password.js <ユーザーID>   … 新しいパスワードを2回入力する（打った文字は画面に表示されない）
//   Start-Service hiyoukeisan
//
// ・アプリが動いている間は実行できない（動いているアプリは、メモリ上の内容でDBを上書きするので、
//   ここでの変更が消えたり、逆に利用者の入力を消したりするため）。
//   動いているかどうかは、2つの方法で確かめる。
//   (1) このPC自身（127.0.0.1 と ::1）と .env の HOST の、.env の PORT 番へつないでみる。どこかが応答すれば中止する。
//       時間内に応答も拒否も無いとき（重い処理中など）も、動いているものとして中止する。
//   (2) この DB を開いているプロセスがほかにいないかを確かめる（server/services/singleInstance.js）。
//       アプリが .env とは違うポートで動いていても、これで分かる。
//   パスワードの入力を待っている間にアプリが起動した・DBが書き換えられた場合に備えて、書き込む直前にもう一度確かめる
//   （このツールが DB を使っている間は、アプリを起動しても、アプリの側が起動を中止する）。
// ・一覧の表示（--list）や、途中で中止した場合は、DB ファイルを書き換えない（読むだけ）。
// ・DB の場所は、アプリと同じく .env の DB_PATH（無ければ data/hiyou.db）。その場所に DB が無いときは中止する
//   （DB を新しく作ることはしない。最初に表示される「DBファイル:」の行で、場所を確かめられる）。
// ・新しいパスワードは、アプリと同じ基準（13文字以上・英字と数字の両方、など）を満たす必要がある。
//   忘れたときに使う道具なので、「現在のパスワードと同じものは不可」の確認だけは行わない。
// ・対象のユーザーが無効になっていたら、有効に戻す（入力の前に知らせる）。ロールは変えない。
// ・操作ログに「サーバー上のツールでパスワードを再設定した」と残す（だれが実行したかは Windows のユーザー名で記録する）。
// 終了コード: 0 = 完了 / 1 = 中止・失敗
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const readline = require('readline');

// Windows では、だれも待ち受けていないポートへの接続が「拒否」と分かるまでに2秒ほどかかる。それより十分長く待つ
const PROBE_TIMEOUT_MS = 8000;
const NOT_LISTENING = ['ECONNREFUSED', 'EADDRNOTAVAIL', 'ENETUNREACH', 'EHOSTUNREACH', 'EAFNOSUPPORT', 'ENOTFOUND'];
const CANCELLED = 'CANCELLED';

/**
 * 1つの接続先へつないでみる。
 * @returns {Promise<'open'|'closed'|'unknown'>} open = 何かが待ち受けている / closed = 待ち受けていない / unknown = 時間内に分からなかった
 */
function probe(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise(resolve => {
    let socket = null, done = false;
    const finish = result => {
      if (done) return;
      done = true;
      try { if (socket) socket.destroy(); } catch (_) { /* 既に閉じている */ }
      resolve(result);
    };
    try {
      socket = net.connect({ host, port });
      socket.setTimeout(timeoutMs, () => finish('unknown'));
      socket.once('connect', () => finish('open'));
      socket.once('error', err => finish(NOT_LISTENING.includes(err && err.code) ? 'closed' : 'unknown'));
    } catch (_) {
      finish('unknown');   // ポート番号が不正、など
    }
  });
}

/**
 * アプリ（または同じポートを使うほかのプログラム）が動いているかを確かめる。
 * @returns {Promise<{ running: boolean, unsure: boolean, where: string, checked: string }>}
 *   running = どこかが応答した / unsure = 応答は無いが、動いていないとも言い切れない / where = その接続先 / checked = 確かめた接続先の一覧
 */
async function checkServer(env = process.env, timeoutMs = PROBE_TIMEOUT_MS) {
  const port = Number(env.PORT) || 3000;
  const hosts = ['127.0.0.1', '::1'];
  const own = String(env.HOST ?? '').trim();
  // HOST に、このPCの特定のアドレス（LAN のアドレスなど）が書かれていると、アプリは 127.0.0.1 では応答しない。そのアドレスも確かめる
  if (own && !['0.0.0.0', '::', '[::]', 'localhost', ...hosts].includes(own.toLowerCase())) hosts.push(own);
  const results = await Promise.all(hosts.map(h => probe(h, port, timeoutMs)));
  const label = i => `${hosts[i].includes(':') ? `[${hosts[i]}]` : hosts[i]}:${port}`;
  const open = results.indexOf('open');
  const unknown = results.indexOf('unknown');
  return {
    running: open >= 0,
    unsure: open < 0 && unknown >= 0,
    where: label(open >= 0 ? open : Math.max(unknown, 0)),
    checked: hosts.map((_, i) => label(i)).join('、'),
  };
}

/**
 * パスワードの入力。
 * 画面（端末）から入力するときは、「新しいパスワード: 」などの案内は表示し、打った文字は表示しない。
 * 端末でないとき（ほかのプログラムから文字を流し込むとき）は、1行ずつ読む。
 * ask() は、入力の途中で中止されたら（Ctrl+C など）Error('CANCELLED') で失敗する。
 */
function createAsker(input = process.stdin, output = process.stdout) {
  if (!input.isTTY) {
    const lines = [];
    let waiting = null, ended = false;
    const rl = readline.createInterface({ input });
    rl.on('line', l => { if (waiting) { const w = waiting; waiting = null; w(l); } else lines.push(l); });
    rl.on('close', () => { ended = true; if (waiting) { const w = waiting; waiting = null; w(''); } });
    return { ask: () => new Promise(resolve => { if (lines.length) resolve(lines.shift()); else if (ended) resolve(''); else waiting = resolve; }), close: () => rl.close() };
  }

  // historySize: 0 … 入力したパスワードを、上矢印キーで呼び出せる履歴に残さない
  const rl = readline.createInterface({ input, output, terminal: true, historySize: 0 });
  let hidden = false, label = '', cancel = null;
  // readline が画面に書こうとする文字を、ここで選別する。入力中は「案内の文字」と「改行」だけを通す。
  // （案内を自分で書いてから rl.question('') を呼ぶ方法だと、readline が行を描き直すときに案内ごと消してしまう）
  rl._writeToOutput = text => {
    if (!hidden) { output.write(text); return; }
    if (label && text.startsWith(label)) output.write(label);            // 行の描き直し（案内＋入力済みの文字）→ 案内だけを出す
    else if (text === '\r\n' || text === '\n') output.write(text);       // Enter
    // それ以外（打った文字）は表示しない
  };
  rl.on('close', () => { if (cancel) { const c = cancel; cancel = null; c(); } });
  return {
    ask: prompt => new Promise((resolve, reject) => {
      label = prompt;
      hidden = true;
      cancel = () => { hidden = false; reject(new Error(CANCELLED)); };
      rl.question(prompt, answer => { hidden = false; cancel = null; resolve(answer); });
    }),
    close: () => { cancel = null; rl.close(); },
  };
}

// DB を読むだけで、ユーザーの一覧を取り出す（ファイルには何も書かない）
async function readUsers(dbPath) {
  const SQL = await require('sql.js')();
  const file = fs.readFileSync(dbPath);
  if (file.length === 0) throw new Error('0バイトです。破損の可能性があります');
  const mem = new SQL.Database(file);
  try {
    const res = mem.exec('SELECT id, username, role, active FROM users ORDER BY id');
    return res.length ? res[0].values.map(([id, username, role, active]) => ({ id, username, role, active })) : [];
  } finally {
    mem.close();
  }
}

async function main() {
  // .env は、アプリと同じくプロジェクト直下のものを読む（DB の場所とポートを、アプリと同じにするため）
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
  const db = require('../server/database');
  const audit = require('../server/services/auditLog');
  const passwordPolicy = require('../server/services/passwordPolicy');
  const guard = require('../server/services/singleInstance');
  const bcrypt = require('bcryptjs');

  const target = process.argv[2];
  if (!target) {
    console.error('使い方: node tools/reset-password.js <ユーザーID>   （一覧を見るには --list）');
    process.exitCode = 1;
    return;
  }

  // アプリが動いていたら（または、動いていないと言い切れなければ）、理由を表示して true を返す
  const refuseIfRunning = async () => {
    const state = await checkServer();
    if (state.running) {
      console.error(`アプリが動いています（${state.where} が応答しました）。先に止めてから実行してください（例: Stop-Service hiyoukeisan）。何も変更していません。\n` +
        '（ほかのプログラムが同じ番号のポートを使っている場合も、この表示になります）');
      return true;
    }
    if (state.unsure) {
      console.error(`アプリが動いているかどうかを確かめられませんでした（${state.where} が、時間内に応答も拒否もしませんでした）。` +
        '動いているものとして中止します。何も変更していません。\n' +
        'アプリが止まっていること（例: Get-Service hiyoukeisan の Status が Stopped）を確かめてから、もう一度実行してください。');
      return true;
    }
    return false;
  };
  if (await refuseIfRunning()) { process.exitCode = 1; return; }

  // DB を新しく作ることはしない。.env の DB_PATH の誤りや、作業フォルダの違いで別の場所を見ていると、
  // 空の DB を新しく作って「変更しました」と表示してしまう（本物の DB は変わらず、ログインできないままになる）
  if (!fs.existsSync(db.dbPath)) {
    console.error(`DBファイルが見つかりません: ${db.dbPath}\n` +
      '.env の DB_PATH を確認してください（このツールは、DB を新しく作ることはしません）。何も変更していません。');
    process.exitCode = 1;
    return;
  }

  // この DB を、このツールが使うことを宣言する。アプリがこの DB を開いていれば、ポート番号が .env と違っていても
  // （上の確認では見つけられなくても）ここで分かる。宣言している間にアプリを起動しても、アプリの側が「使用中」として
  // 起動を中止するので、入力を待っている間に内容が食い違うこともない
  try {
    await guard.acquire(db.dbPath, 'tool');
  } catch (err) {
    if (!err || err.code !== 'DB_IN_USE') throw err;
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  // ユーザーの一覧は、DB を読むだけで調べる。ここではまだファイルを書き直さない
  // （一覧の表示や、途中で中止した場合に、DB ファイルを書き換えないため）
  const opened = fs.statSync(db.dbPath);
  let users;
  try {
    users = await readUsers(db.dbPath);
  } catch (err) {
    console.error(`DBファイルを読めません: ${db.dbPath}（${err.message}）\n何も変更していません。`);
    process.exitCode = 1;
    return;
  }
  console.log(`DBファイル: ${db.dbPath}（${opened.size.toLocaleString()} バイト）`);
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
  if (!user.active) {
    console.log('（注意）このユーザーは「無効」になっています。パスワードを設定し直すと「有効」に戻り、ログインできるようになります。\n' +
      '        無効のままにしておくユーザー（退職した人のIDなど）の場合は、Ctrl+C で中止してください。');
  }
  console.log(`基準: ${passwordPolicy.describe()}`);
  if (process.stdin.isTTY) console.log('入力した文字は画面に表示されません。打ち終えたら Enter を押してください（中止するときは Ctrl+C）。');
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
  } catch (err) {
    if (!err || err.message !== CANCELLED) throw err;
    console.error('\n中止しました。何も変更していません。');
    process.exitCode = 1;
    return;
  } finally {
    asker.close();
  }
  const problems = passwordPolicy.check(password, { username: user.username });
  if (problems.length) {
    console.error(passwordPolicy.errorMessage(problems) + '\n何も変更していません。');
    process.exitCode = 1;
    return;
  }

  // 入力を待っている間にアプリが起動した・DBが書き換えられた場合は、変更しない
  // （例: サービスを止めずにプロセスだけを終了させた場合、サービスの仕組みが10秒後に起動し直す）
  if (await refuseIfRunning()) { process.exitCode = 1; return; }
  const before = fs.statSync(db.dbPath);
  if (before.mtimeMs !== opened.mtimeMs || before.size !== opened.size) {
    console.error('DBファイルが、このツールの起動後に書き換えられています（アプリが動いている可能性があります）。何も変更していません。\n' +
      'アプリが止まっていることを確かめてから、もう一度実行してください。');
    process.exitCode = 1;
    return;
  }

  // ここで初めて、アプリと同じ方法で DB を開く（開くとファイルを書き直す）。場所は上で表示済みなので、ここでの表示は省く
  const realLog = console.log;
  console.log = () => {};
  try { await db.getDb(); } finally { console.log = realLog; }
  if (!db.query('SELECT id FROM users WHERE id=? AND username=?', [user.id, user.username]).length) {
    console.error(`ユーザー「${user.username}」が見つからなくなりました。何も変更していません。もう一度実行してください。`);
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
}

// 自己テスト（tools/selftest-security.js）から部品を呼べるようにする。直接実行されたときだけ、本体を動かす
module.exports = { probe, checkServer, createAsker };
if (require.main === module) {
  main().catch(err => {
    console.error('失敗しました: ' + err.message);
    process.exitCode = 1;
  });
}
