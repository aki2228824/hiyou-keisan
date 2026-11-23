// 同じ DB ファイルを、2つのプロセスが同時に開かないようにする（1つの DB につき、開いて書き込むプロセスは1つだけ）。
//
// このアプリは DB 全体をメモリに持ち、保存のたびにファイル全体を書き出す。2つのプロセスが同じファイルを開くと、
// 後から保存した側が、相手の保存した内容を黙って消してしまう（例: サービスが動いているのに、別のポートで手動起動した。
// アプリが動いている間に、パスワードの再設定ツールを実行した）。
//
// しくみ: DB ファイルの場所から決まる名前で、「名前付きパイプ」（Windows）またはソケット（Linux など）を待ち受ける。
// 同じ名前で待ち受けられるのは1つのプロセスだけで、プロセスが終われば（強制終了でも）OS が片付けるので、
// 「前回の異常終了のあと、鍵が残って起動できない」ということが起きない（Linux などではファイルが残るが、
// つないでみて相手がいなければ片付けてから使う）。HTTP のポート番号や .env の設定には関係なく働く。
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PROBE_TIMEOUT_MS = 3000;
const held = new Map();   // 名前 → このプロセスが待ち受けているサーバー

// DB ファイルの実際の場所（リンクや別の書き方をたどった先）
function realPathOf(dbPath) {
  let real = path.resolve(dbPath);
  try {
    real = fs.realpathSync.native(real);
  } catch (_) {
    // まだ無いファイル（新規の DB）は、フォルダの実際の場所 + ファイル名
    try { real = path.join(fs.realpathSync.native(path.dirname(real)), path.basename(real)); } catch (_e) { /* フォルダもまだ無い */ }
  }
  return real;
}

// Windows で、ネットワーク上の場所（\\サーバー\共有\… の形）を指しているか。
// 共有フォルダ越しの DB は、同じファイルでも機械や書き方によって別の名前になるので、二重に開くことを防げない
// （例: \\localhost\C$\hiyou\data\hiyou.db と C:\hiyou\data\hiyou.db。ほかの PC からは、名前付きパイプそのものが届かない）
function isNetworkPath(real) {
  if (process.platform !== 'win32') return false;
  if (/^\\\\[?.]\\UNC\\/i.test(real)) return true;    // \\?\UNC\サーバー\共有\… と \\.\UNC\サーバー\共有\…
  return /^\\\\[^?.\\]/.test(real);                   // \\サーバー\共有\…（\\?\C:\… と \\.\… は、この機械の中の場所）
}

function networkPathError(dbPath) {
  const err = new Error(
    `DB の場所が、ネットワーク上（共有フォルダ）を指しています: ${dbPath}\n` +
    'DB は、アプリを動かす機械のローカルディスクに置いてください（例: DB_PATH=C:/hiyou/data/hiyou.db）。\n' +
    '共有フォルダに置くと、同じ DB を2つのプロセスで開くことを防げず、互いの保存を上書きして入力が消えます。何も変更していません。');
  err.code = 'DB_ON_NETWORK';
  return err;
}

// DB ファイルの場所から、待ち受ける名前を決める（同じファイルなら、書き方が違っても同じ名前になるようにする）
function nameFor(dbPath) {
  let real = realPathOf(dbPath);
  if (process.platform === 'win32') real = real.toLowerCase();
  const id = crypto.createHash('sha256').update(real).digest('hex').slice(0, 24);
  return process.platform === 'win32'
    ? '\\\\?\\pipe\\hiyou-keisan-db-' + id
    : path.join(os.tmpdir(), `hiyou-keisan-db-${id}.sock`);
}

/**
 * その名前で待ち受けているプロセスがいるかを確かめる。
 * @returns {Promise<{ held: boolean, stale?: boolean, info?: object|null }>}
 *   held = だれかが使っている / stale = 前のプロセスが残したファイルだけがある（Linux など） / info = 相手が名乗った内容
 */
function probe(name, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise(resolve => {
    let done = false, text = '';
    const socket = net.connect(name);
    const finish = result => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch (_) { /* 既に閉じている */ }
      resolve(result);
    };
    const parsed = () => { try { return JSON.parse(text); } catch (_) { return null; } };
    socket.setTimeout(timeoutMs, () => finish({ held: true, info: parsed() }));   // つながったが、名乗らない相手
    socket.on('data', chunk => { text += chunk; if (text.includes('\n')) finish({ held: true, info: parsed() }); });
    socket.once('end', () => finish({ held: true, info: parsed() }));
    socket.once('error', err => {
      const code = err && err.code;
      if (code === 'ENOENT') return finish({ held: false });                       // その名前で待ち受けているものは無い
      if (code === 'ECONNREFUSED') return finish({ held: false, stale: true });    // ファイルだけが残っている（Linux など）
      finish({ held: true, info: parsed() });   // 在るが、つなげない（権限など）。使われているものとして扱う
    });
  });
}

function listen(name, role) {
  return new Promise((resolve, reject) => {
    const since = new Date().toISOString();
    const server = net.createServer(socket => {
      socket.on('error', () => { /* 相手が先に切った */ });
      socket.end(JSON.stringify({ pid: process.pid, role, since }) + '\n');
    });
    server.unref();   // これを待ち受けていることを理由に、プロセスを生かし続けない
    server.once('error', reject);
    server.listen(name, () => {
      server.removeListener('error', reject);
      server.on('error', () => { /* 待ち受け中のエラーでプロセスを止めない */ });
      resolve(server);
    });
  });
}

function busyError(dbPath, info) {
  const who = info && info.pid ? `（${info.role === 'tool' ? 'パスワードの再設定ツール' : 'アプリ'}、プロセスID ${info.pid}）` : '';
  const err = new Error(
    `このDBファイルは、ほかのプロセスが使用中です${who}: ${dbPath}\n` +
    '同じDBを2つのプロセスで開くと、互いの保存を上書きして入力が消えるため、中止しました。何も変更していません。\n' +
    '（アプリが動いているときは、サービスを止めてから実行してください。試験用に起動するときは、別の DB_PATH を指定してください）');
  err.code = 'DB_IN_USE';
  return err;
}

/**
 * その DB を、このプロセスが使うことを宣言する。ほかのプロセスが使用中なら例外（code = 'DB_IN_USE'）。
 * 同じプロセスからの2回目以降は、何もしない。
 * 確かめる仕組みそのものが使えない場合（名前付きパイプ・ソケットを作れない環境）は、注意を表示して続ける
 * （この仕組みが原因で、アプリが起動できなくなることを避ける）。
 * @param {string} dbPath
 * @param {'app'|'tool'} role  相手に名乗る種類
 */
async function acquire(dbPath, role = 'app') {
  // ネットワーク上の場所（共有フォルダ）の DB は開かない。例外の code は 'DB_ON_NETWORK'
  if (isNetworkPath(realPathOf(dbPath)) || isNetworkPath(path.resolve(dbPath))) throw networkPathError(dbPath);
  const name = nameFor(dbPath);
  if (held.has(name)) return true;
  for (let attempt = 0; attempt < 3; attempt++) {
    const other = await probe(name);
    if (other.held) throw busyError(dbPath, other.info);
    if (other.stale) { try { fs.unlinkSync(name); } catch (_) { /* 消せなければ、次の待ち受けで分かる */ } }
    try {
      held.set(name, await listen(name, role));
      return true;
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') continue;   // 同時に起動した相手が先に取った。もう一度確かめる
      console.error(`（注意）DBファイルの二重使用を確かめる仕組みを使えませんでした（${err && (err.code || err.message)}）。確認なしで続けます。`);
      return false;
    }
  }
  throw busyError(dbPath, null);
}

// 使用の宣言をやめる（自己テスト用。通常は、プロセスの終了と同時に OS が片付ける）
function release(dbPath) {
  const name = nameFor(dbPath);
  const server = held.get(name);
  if (!server) return Promise.resolve();
  held.delete(name);
  return new Promise(resolve => server.close(() => resolve()));
}

/** その DB を、ほかのプロセス（またはこのプロセス）が使用中かを調べる（宣言はしない） */
async function inUse(dbPath) {
  const name = nameFor(dbPath);
  if (held.has(name)) return { held: true, info: { pid: process.pid, role: 'self' } };
  const other = await probe(name);
  return { held: other.held, info: other.info || null };
}

module.exports = { acquire, release, inUse, nameFor, isNetworkPath };
