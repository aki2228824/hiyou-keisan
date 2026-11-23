// 操作ログ（アクセスログ）。「いつ・だれが・どの端末から・どの患者の情報に・何をしたか」を1行ずつ残す。
//
// ・保存先は DB とは別のファイル: <保存先フォルダ>/audit-YYYY-MM.jsonl（1か月1ファイル、1行＝1件の JSON）。
//   保存先フォルダは .env の AUDIT_LOG_DIR、無指定なら「DBファイルと同じフォルダの audit」。
//   DBに入れない理由: sql.js は更新のたびにDB全体をファイルへ書き出すので、表示のたびに増える記録をDBに入れると
//   保存がどんどん遅くなる。また、ログイン失敗のように未ログインの人が起こせる記録でDBを書き換えさせないため。
// ・追記するだけで、書き換え・削除の機能は持たない。自動では消さない（保存期間は施設の決まりに合わせて手で整理する）。
// ・書き込みに失敗しても業務は止めない（エラーログに出し、操作ログの画面にも表示する）。
//   ただし起動時に保存先を使えない場合は、設定の誤りなので起動を止める。
// ・パスワードは記録しない（本文の password などの項目は *** に置き換える）。
const fs = require('fs');
const net = require('net');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const MAX_STRING = 200;      // 1つの文字列の上限（超えた分は切る）
const MAX_DETAIL = 2000;     // detail 全体の上限（JSON にしたときのバイト数）
const ANON_PER_MINUTE = 120; // 未ログインの要求について、1分間に1件ずつ記録する上限（超えた分は件数だけを残す）
// ログイン済みのユーザー1人が、記録の対象になる要求を1分間に出せる上限（超えた分は処理せずに断り、断った件数だけを残す）。
// 月次集計の画面は、表示のたびに「患者数＋1」件の要求を出す（120人なら121件）。全病棟の集計を3秒に1回のペースで
// 1分間切り替え続けても届かない数（患者200人で約4,000件）より大きくしてある。.env の AUDIT_USER_PER_MINUTE で変えられる（600〜60000）。
const DEFAULT_USER_PER_MINUTE = 6000;
const USER_PER_MINUTE = (() => {
  const raw = String(process.env.AUDIT_USER_PER_MINUTE ?? '').trim();
  const n = raw === '' ? NaN : Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.min(Math.max(n, 600), 60000) : DEFAULT_USER_PER_MINUTE;
})();
let checkIntervalMs = 5000;    // 「ファイルがまだあるか」を確かめる間隔

let dir = null;              // 保存先フォルダ（init() で決まる。それまでは何も書かない）
let fd = null;               // いま追記しているファイル
let fdName = '';             // そのファイル名
let lastCheckedAt = 0;       // ファイルがまだそこにあるかを最後に確かめた時刻
let syncTimer = null;
let failedCount = 0;         // 起動してから書き込めなかった件数
let unreportedFailures = 0;  // そのうち、まだ操作ログに「記録できなかった」と残していない件数
let lastError = null;        // 直近の失敗 { at, message }
let lastReportedAt = 0;
let knownFile = '';          // いちど開いた（＝在ることが分かっている）月のファイル名
let writtenSinceCheck = 0;   // 最後に「ファイルが在る」と確かめたあとに書いた件数
let removedSince = null;     // 今月のファイルが無くなっていた・置き換えられていた・短くなっていたのを見つけたとき { lost, how }。次の1行を書くときに記録へ残す
let expectedSize = 0n;       // 開いているファイルの、自分が書いた分までの大きさ（バイト）
let unknownChecks = 0;       // ファイルの状態を確かめられなかった回数（続けて）

// 「記録の欠落」として残す文（操作ログの画面では、このあとに「：N件」が付く）
const GAP_NOTES = {
  missing: '今月の操作ログのファイルが無くなっていたので、作り直した（消されたか、名前を変えられた）。これより前の今月の記録は、このファイルに残っていない（バックアップを確認する）。無くなる直前に書いた件数',
  replaced: '今月の操作ログのファイルが、同じ名前の別のファイルに置き換えられていた。これより前の今月の記録が、このファイルには欠けていることがある（バックアップを確認する）。置き換えに気づく直前に書いた件数',
  shrunk: '今月の操作ログのファイルが、短くなっていた（中身を消されたか、切り詰められた）。これより前の今月の記録が欠けている（バックアップを確認する）。短くなったことに気づく直前に書いた件数',
  unknown: '今月の操作ログのファイルが、いまもそこに在るかを確かめられない状態が続いている（フォルダの権限、ほかのプログラムを確認する）。記録は書き続けているが、画面から見えるファイルに入っているとは限らない。最後に確かめられたあとに書いた件数',
};

const pad = (n, len = 2) => String(n).padStart(len, '0');

// 行の区切りとして扱われることのある文字: U+0080〜U+009F（U+0085 を含む制御文字）と、U+2028・U+2029（行区切り・段落区切り）。
// JSON.stringify はこれらをそのまま出す。これらでも行を分ける読み手（Node の readline など）で読むと、1件の記録が途中で
// 2つに割れて、どちらも読めなくなる（URL にこの文字を1つ混ぜるだけで、その閲覧の記録を操作ログの画面から消せた）。
// 書くときは必ず「バックスラッシュ + u + 4桁」の形にする（JSON として読めば元の文字に戻る）。
const LINE_BREAKERS = new RegExp('[' + String.fromCharCode(0x80) + '-' + String.fromCharCode(0x9f) + String.fromCharCode(0x2028) + String.fromCharCode(0x2029) + ']', 'g');
const toLine = obj => JSON.stringify(obj).replace(LINE_BREAKERS, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '\n';

// 記録の行は、必ずこの形で始まる（{"t":"YYYY-MM-DDT…）。違う行は、途中で切れたか、書き換えられたもの
const LINE_HEAD = /^\{"t":"\d{4}-\d{2}-\d{2}T/;

// ファイルを1行ずつ読む。行の区切りは改行（LF）だけ
// （readline は U+2028・U+2029 でも行を分けるので使わない。以前に書かれた、その文字がそのまま入っている行も読めるようにする）
async function* linesOf(file) {
  let rest = '';
  let first = true;
  for await (const chunk of fs.createReadStream(file, { encoding: 'utf8' })) {
    let text = rest + chunk;
    // ファイルの先頭に BOM（メモ帳などで保存し直すと付くことがある目印）があれば、読み飛ばす
    // （そのままだと、最初の1件が「読めない行」になる）
    if (first && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    first = false;
    let start = 0;
    for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', start)) {
      yield text.slice(start, at);
      start = at + 1;
    }
    rest = text.slice(start);
  }
  if (rest) yield rest;
}

// サーバーの現地時刻を、時差つきの ISO 形式にする（例 2026-11-21T10:23:45.123+09:00）
function localIso(d) {
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${off >= 0 ? '+' : '-'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

const fileNameFor = d => `audit-${d.getFullYear()}-${pad(d.getMonth() + 1)}.jsonl`;

function resolveDir(dbPath) {
  const custom = String(process.env.AUDIT_LOG_DIR ?? '').trim();
  return custom ? path.resolve(PROJECT_ROOT, custom) : path.join(path.dirname(dbPath), 'audit');
}

function closeFile() {
  if (fd === null) return;
  try { fs.closeSync(fd); } catch (_) { /* 既に閉じている */ }
  fd = null;
  fdName = '';
}

// 開いているファイルが、いまもその名前でそこに在る「同じファイル」かを確かめる。
// 'same' = そのまま / 'missing' = 無くなった / 'replaced' = 同じ名前の別のファイルに置き換えられた / 'shrunk' = 短くなった（中身を消された）
function checkOpenFile(file) {
  let onDisk, mine;
  try {
    onDisk = fs.statSync(file, { bigint: true });
  } catch (err) {
    // 「無い」と分かったときだけ、無くなったものとして扱う。それ以外の理由（ほかのプログラムが一時的に掴んでいる、
    // フォルダの権限を変えられた、など）で確かめられなかったときは 'unknown'（「無くなっていた」と誤って記録しないため）
    return err && (err.code === 'ENOENT' || err.code === 'ENOTDIR') ? 'missing' : 'unknown';
  }
  try { mine = fs.fstatSync(fd, { bigint: true }); } catch (_) { return 'missing'; }
  // ファイルの番号（NTFS のファイル ID、Linux の i ノード番号）が違えば、別のファイル。番号を返さない保存先（0 になる）では比べない
  if (onDisk.ino !== 0n && mine.ino !== 0n && (onDisk.ino !== mine.ino || onDisk.dev !== mine.dev)) return 'replaced';
  if (onDisk.size < expectedSize) return 'shrunk';
  return 'same';
}

// その時刻の月のファイルを追記用に開く（開いたままにして使い回す。月が変わったら開き直す）
function openFor(d) {
  const name = fileNameFor(d);
  const now = Date.now();
  if (fd !== null && name === fdName) {
    // 開いている間にファイルを消されたり、名前を変えられたり、別のファイルに置き換えられたりすると、
    // 画面からは見えないファイルへ書き続けてしまう。ときどき確かめて、変わっていたら開き直す
    if (now - lastCheckedAt < checkIntervalMs) return;
    lastCheckedAt = now;
    const state = checkOpenFile(path.join(dir, name));
    if (state === 'same') { writtenSinceCheck = 0; unknownChecks = 0; return; }
    if (state === 'unknown') {
      // 確かめられなかった。開いているファイルへ書き続けるが、「在る」と確かめたことにはしない（writtenSinceCheck は戻さない）。
      // 3回続いたら、確かめられない状態が続いていることを、エラーログと操作ログに1回だけ残す
      if (++unknownChecks === 3) {
        console.error(`操作ログのファイルの状態を確かめられません（${path.join(dir, name)}）。フォルダの権限と、ほかのプログラムがファイルを掴んでいないかを確認してください。`);
        if (!removedSince) removedSince = { lost: writtenSinceCheck, how: 'unknown' };
      }
      return;
    }
    unknownChecks = 0;
    // 置き換えられた・短くなった場合は、ファイルは在るので、下の「無くなっていた」の判定には掛からない。ここで控える
    if (state !== 'missing' && !removedSince) removedSince = { lost: writtenSinceCheck, how: state };
  }
  closeFile();
  const file = path.join(dir, name);
  let size = -1;   // -1 = 無い（これから作られる） / -2 = 在るかどうかを確かめられなかった
  try { size = fs.statSync(file).size; } catch (err) { if (!err || (err.code !== 'ENOENT' && err.code !== 'ENOTDIR')) size = -2; }
  // いちど開いた月のファイルが無くなっていたら、消された（または名前を変えられた・フォルダごと移された）ということ。
  // 作り直して続けるが、「無くなっていた」ことを新しいファイルの先頭に残す（黙って作り直すと、消されたことが分からない）。
  // lost は、最後に「在る」と確かめたあとに書いた件数（無くなったファイルへ書いた分を含む）
  if (size === -1 && knownFile === name && !removedSince) removedSince = { lost: writtenSinceCheck, how: 'missing' };
  writtenSinceCheck = 0;
  let needsNewline = false;
  if (size > 0) {
    try {
      const last = Buffer.alloc(1);
      const rfd = fs.openSync(file, 'r');
      try { fs.readSync(rfd, last, 0, 1, size - 1); } finally { fs.closeSync(rfd); }
      needsNewline = last[0] !== 0x0a;
    } catch (_) { /* 読めなければ、そのまま続きに書く */ }
  }
  try {
    fd = fs.openSync(file, 'a');
  } catch (err) {
    // 動いている間に保存先のフォルダごと消された・移された場合は、作り直して続ける
    // （作り直さないと、だれかがフォルダを戻すまで、表示も保存も記録されないまま処理され続ける）
    if (err.code !== 'ENOENT') throw err;
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(file, 'a');
  }
  fdName = name;
  knownFile = name;
  lastCheckedAt = now;
  // 最後の行が途中で切れていたら（停電の瞬間など）、改行を足してから続きを書く（次の記録が、切れた行とつながって読めなくなるのを防ぐ）
  if (needsNewline) fs.writeSync(fd, '\n');
  // いまの大きさを控える。以後は書いた分だけ足していき、ファイルがこれより短くなっていたら「中身を消された」と分かる
  try { expectedSize = fs.fstatSync(fd, { bigint: true }).size; } catch (_) { expectedSize = 0n; }
}

// 書き込んだ内容を1秒以内にディスクへ確定させる（1行ごとに確定させると遅いので、まとめて行う）
function scheduleSync() {
  if (syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    try { if (fd !== null) fs.fsyncSync(fd); } catch (_) { /* 次の書き込みで分かる */ }
  }, 1000);
  syncTimer.unref();
}

function noteFailure(err) {
  failedCount++;
  unreportedFailures++;
  lastError = { at: localIso(new Date()), message: String(err && (err.code || err.message) || err) };
  if (Date.now() - lastReportedAt > 60000) {   // 同じエラーでログを埋めない（1分に1回まで）
    lastReportedAt = Date.now();
    console.error(`操作ログを書き込めません（${dir}）: ${lastError.message} / 起動後に記録できなかった件数 ${failedCount}`);
  }
}

/**
 * 起動時に1回呼ぶ。保存先フォルダを作り、今月のファイルを開けることを確かめる。
 * 使えないときは例外を投げる（設定の誤りに気づかないまま、記録なしで動き続けないようにするため）。
 */
function init(dbPath) {
  dir = resolveDir(dbPath);
  knownFile = '';
  writtenSinceCheck = 0;
  removedSince = null;
  expectedSize = 0n;
  unknownChecks = 0;
  try {
    fs.mkdirSync(dir, { recursive: true });
    openFor(new Date());
  } catch (err) {
    const where = dir;
    dir = null;
    throw new Error(
      `操作ログの保存先を使えません: ${where}（${err.code || err.message}）\n` +
      'フォルダを作成できること・書き込めることを確認してください。保存先は .env の AUDIT_LOG_DIR で変えられます' +
      '（無指定のときは、DBファイルと同じフォルダの audit）。');
  }
  return dir;
}

// 1件を追記する。成功したら true。失敗しても例外は投げない（d は自己テスト用。通常は現在時刻）
function write(entry, d = new Date()) {
  if (!dir) return false;
  try {
    let line = toLine({ t: localIso(d), ...entry });
    openFor(d);
    if (unreportedFailures) {
      // 書けない状態から戻った最初の1行の前に、「この間の記録が残っていない」ことを書いておく
      line = toLine({ t: localIso(d), user: null, action: 'audit.gap', detail: { count: unreportedFailures, note: '保存先に書き込めず、記録できなかった件数', last_error: lastError && lastError.message } }) + line;
    }
    if (removedSince) {
      // 今月のファイルが無くなっていた・別のファイルに置き換えられていた・短くなっていた、という記録を先に置く
      line = toLine({ t: localIso(d), user: null, action: 'audit.gap', detail: { removed: removedSince.how !== 'unknown', how: removedSince.how, count: removedSince.lost, note: GAP_NOTES[removedSince.how] || GAP_NOTES.missing } }) + line;
    }
    fs.writeSync(fd, line);
    expectedSize += BigInt(Buffer.byteLength(line, 'utf8'));
    writtenSinceCheck++;
    removedSince = null;
    unreportedFailures = 0;
    scheduleSync();
    return true;
  } catch (err) {
    noteFailure(err);
    closeFile();   // 次の書き込みで開き直す
    return false;
  }
}

// ---------------------------------------------------------------- 記録する内容の組み立て

// 接続元のIPアドレス（IPv4 が IPv6 の書き方 ::ffff:192.168.1.5 で届くことがあるので、そろえる）
// TRUST_PROXY の設定によっては、req.ip に利用者が送ったヘッダー（X-Forwarded-For）の文字列がそのまま入ることがある。
// IPアドレスの形をしていないものは採用せず、実際につながっている相手のアドレスを使う。
function clientIp(req) {
  const strip = v => (typeof v === 'string' && v.startsWith('::ffff:') ? v.slice(7) : v);
  const viaProxy = strip(req.ip);
  if (typeof viaProxy === 'string' && net.isIP(viaProxy)) return viaProxy;
  const direct = strip(req.socket && req.socket.remoteAddress);
  return typeof direct === 'string' && net.isIP(direct) ? direct : '';
}

function cut(str, max = MAX_STRING) {
  return str.length > max ? str.slice(0, max) + '…' : str;
}

// リクエストの本文などを、記録してよい形にする（パスワードを伏せ、長すぎるものを切る）
function sanitize(value, depth = 0) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return cut(value);
  if (depth >= 4) return '…';
  if (Array.isArray(value)) {
    const out = value.slice(0, 50).map(v => sanitize(v, depth + 1));
    if (value.length > 50) out.push(`…（ほか ${value.length - 50} 件）`);
    return out;
  }
  if (typeof value === 'object') {
    const out = {};
    let n = 0;
    for (const [key, v] of Object.entries(value)) {
      if (++n > 50) { out['…'] = '（以下省略）'; break; }
      // パスワードらしい名前の項目は、値を記録しない（このアプリが使うのは password だけだが、pwd・token のような名前で送られた値も伏せる）
      out[cut(key, 50)] = /pass|pwd|secret|token/i.test(key) ? '***' : sanitize(v, depth + 1);
    }
    return out;
  }
  return cut(String(value));
}

function limitDetail(detail) {
  if (detail == null) return undefined;
  const clean = sanitize(detail);
  if (clean && typeof clean === 'object' && !Object.keys(clean).length) return undefined;
  const json = JSON.stringify(clean);
  if (Buffer.byteLength(json, 'utf8') <= MAX_DETAIL) return clean;
  // 文字数ではなくバイト数で切る（日本語は1文字3バイトなので、文字数で切ると1行が数KBになる）
  const head = Buffer.from(json, 'utf8').subarray(0, MAX_DETAIL).toString('utf8').replace(/\uFFFD+$/, '');
  return { 省略: true, 先頭: head };
}

// どんな値でも例外を出さずに、記録用の短い文字列にする
// （{ toString: 1 } のような値を String() に渡すと例外になり、記録の処理ごと止まってしまうため）
function safeText(value, max = MAX_STRING) {
  if (value == null) return '';
  if (typeof value === 'string') return cut(value, max);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return cut(JSON.stringify(value) ?? '', max); } catch (_) { return '（文字にできない値）'; }
}

// 未ログインの要求は、だれでも好きなだけ送れる。1件ずつ記録するのは1分間に ANON_PER_MINUTE 件までにして、
// 超えた分は件数だけを数え、あとでまとめて1行（audit.skipped）にする（でたらめな要求の連打でディスクを埋められないように）。
let anonWindowStart = 0, anonUsed = 0, anonSkipped = 0, anonTimer = null;
function flushAnonSkipped() {
  if (anonTimer) { clearTimeout(anonTimer); anonTimer = null; }
  if (!anonSkipped) return;
  const count = anonSkipped;
  anonSkipped = 0;
  write({ user: null, action: 'audit.skipped', detail: { count, note: '未ログインの要求が多すぎたため、1件ずつの記録を省略した件数' } });
}
// ログイン済みのユーザーは、記録の対象になる要求を1分間に USER_PER_MINUTE 件まで出せる（人が画面を操作して届く数ではない）。
// 超えた分は、middleware/audit.js が処理に入る前に断る（429）。こうしておくと、
//   ・処理された要求は、必ず1件ずつ記録に残る（要求を連打して「どの患者を見たか」を記録から消すことができない）
//   ・1人のユーザーが増やせるログの量に上限がある
// 断った件数は、操作の種類ごとにまとめて1行（audit.skipped）にする。断った要求では、データの表示も変更も行われていない。
//
// 以前は、超えた分も処理したうえで「操作の種類ごとの件数と、対象の患者ID（500件まで）」を1行にまとめていた。
// それだと、関係のない患者IDを500件以上送ってから本命の患者を開けば、その患者のIDが記録に残らなかった
// （2026-11-22 の点検で確認。動作検証.md の S-04）。記録に残せない要求は、処理しないのが確実。
const userWindows = new Map();   // uid → { start, used, skipped, actions: {種類: 件数}, name, timer }
function flushUser(uid) {
  const w = userWindows.get(uid);
  if (!w || !w.skipped) return;
  write({
    user: w.name, uid, action: 'audit.skipped',
    detail: { count: w.skipped, actions: w.actions, refused: true,
      note: '同じユーザーの要求が1分間に多すぎたため、処理せずに断った件数（断った要求では、データの表示・変更は行われていない）' },
  });
  w.skipped = 0; w.actions = {};
}
/**
 * ログイン済みのユーザーの要求を、処理に進めてよいか。進めてよければ、1分間の枠を1つ使って true を返す。
 * 枠を使い切っていたら、断った件数として数えて false を返す（呼び出し側は、その要求を処理せずに断ること）。
 * @param {{ id: any, username?: string }} actor  セッションのユーザー
 * @param {string} action  操作の種類（断った件数の内訳に使う）
 */
function reserveUser(actor, action, now = Date.now()) {
  let w = userWindows.get(actor.id);
  // now < w.start: サーバーの時計が戻された場合。数え直さないと、戻された時間のあいだ枠が回復せず、普通の利用まで断ってしまう
  if (!w || now - w.start >= 60000 || now < w.start) {
    flushUser(actor.id);   // 前の1分間に断った分があれば、ここで書き出す
    if (w && w.timer) clearTimeout(w.timer);
    w = { start: now, used: 0, skipped: 0, actions: {}, name: actor.username, timer: null };
    userWindows.set(actor.id, w);
    if (userWindows.size > 1000) for (const [id, x] of userWindows) if (now - x.start >= 120000 && !x.skipped) userWindows.delete(id);
  }
  if (w.used < USER_PER_MINUTE) { w.used++; return true; }
  w.skipped++;
  w.actions[action] = (w.actions[action] || 0) + 1;
  // 続きの要求が来なくても、断った件数は必ず残す
  if (!w.timer) { w.timer = setTimeout(() => { w.timer = null; flushUser(actor.id); }, 60000); w.timer.unref(); }
  return false;
}

function allowAnonymous(now = Date.now()) {
  if (now - anonWindowStart >= 60000 || now < anonWindowStart) {   // 後ろの条件は、サーバーの時計が戻された場合
    flushAnonSkipped();
    anonWindowStart = now;
    anonUsed = 0;
  }
  if (anonUsed < ANON_PER_MINUTE) { anonUsed++; return true; }
  anonSkipped++;
  if (!anonTimer) { anonTimer = setTimeout(flushAnonSkipped, 60000); anonTimer.unref(); }   // 続きの要求が来なくても、件数は必ず残す
  return false;
}

/**
 * 1件を記録する。
 * @param {object} req      Express のリクエスト
 * @param {string} action   出来事の種類（login.success、records.save など）
 * @param {object} [fields] status / ms / patient_id / target / detail / user（ログイン失敗時の「入力されたユーザーID」など、
 *                          セッションのユーザーと違う名前を記録したいとき）/ actor（{id, username, role}。セッションが無いとき用）
 *                          / patient_id_raw・target_raw（IDが普通の数字の書き方でなかったときの、送られてきたままの値）
 * @returns {boolean} 書き込んだら true（未ログインの要求が多すぎて省略したとき、書き込みに失敗したときは false）
 */
function record(req, action, fields = {}) {
  const actor = req.session?.user || fields.actor || null;
  // fields.user（ログイン画面に入力されたユーザーIDなど）を記録するときは、uid とロールを付けない。
  // 別の人がログイン済みのブラウザーから試した場合に、その人の uid・ロールが「入力されたID」のものに見えてしまうため
  const named = fields.user !== undefined;
  // 件数の上限で省略するのは、だれでも好きなだけ起こせる記録（未ログインの要求と、ログイン画面に入力されたIDの記録）だけ。
  // ログイン済みのユーザーの操作は、ここでは省略しない（多すぎる要求は、処理に入る前に middleware/audit.js が
  // reserveUser() で断っている。処理した操作の記録を省くと、「だれが・どの患者に・何をしたか」が残らなくなる）。
  // fields.always: 上限にかかわらず必ず残す記録（ロックの仕組みで回数が限られている、実在するユーザーへのログイン失敗など）
  if (!fields.always && (!actor || named) && !allowAnonymous()) return false;
  const entry = {
    user: named ? (fields.user === null ? null : safeText(fields.user, 64)) : (actor ? actor.username : null),
    uid: !named && actor ? actor.id : undefined,
    role: !named && actor ? actor.role : undefined,
    session_user: named && actor ? actor.username : undefined,
    ip: typeof fields.ip === 'string' && fields.ip ? fields.ip : clientIp(req),
    action,
    method: req.method,
    path: cut(String(req.originalUrl || req.url || '').split('?')[0]),
    status: fields.status,
    ms: fields.ms,
    patient_id: fields.patient_id,
    patient_id_raw: fields.patient_id_raw === undefined ? undefined : safeText(fields.patient_id_raw, 100),
    target: fields.target,
    target_raw: fields.target_raw === undefined ? undefined : safeText(fields.target_raw, 100),
    detail: limitDetail(fields.detail),
  };
  if (fields.aborted) entry.aborted = true;
  return write(entry);
}

// リクエストに結び付かない出来事（サーバーの起動など）
function recordSystem(action, detail) {
  return write({ user: null, action, detail: limitDetail(detail) });
}

// ---------------------------------------------------------------- 読み出し（操作ログの画面用）

// 記録の分類（画面の絞り込み用）。1件が複数の分類に入ることがある
function kindsOf(row) {
  const action = String(row.action || '');
  const kinds = [];
  const offlineReset = action === 'users.password_reset_offline';   // サーバー上のツール（tools/reset-password.js）によるパスワードの再設定
  if (action.startsWith('login.') || action === 'logout' || action === 'users.unlock' || offlineReset) kinds.push('auth');
  if (/\.(view|list)$/.test(action) || action === 'pdf.export') kinds.push('view');
  if (/\.(create|update|delete|save|unlock|run)$/.test(action) || action === 'other' || offlineReset) kinds.push('change');
  // 記録の欠落（audit.gap）とサーバーの警告には状態コードが無いので、種類で「断られた操作・エラー」に入れる
  if (Number(row.status) >= 400 || ['audit.skipped', 'audit.gap', 'server.warning'].includes(action)) kinds.push('denied');
  // サーバー側の出来事（利用者の画面操作ではないもの）: 起動・警告・記録の省略と欠落・ツールによる再設定。
  // 月次の確認で「心当たりのない起動や再設定が無いか」を見るための分類（以前はどの分類にも入らず、絞り込むと表示されなかった）
  if (action.startsWith('server.') || action === 'audit.skipped' || action === 'audit.gap' || offlineReset) kinds.push('system');
  return kinds;
}

// from 月〜 to 月の 'YYYY-MM' を順に並べる
function monthsBetween(from, to) {
  const months = [];
  let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4)), endM = Number(to.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    months.push(`${y}-${pad(m)}`);
    if (++m > 12) { m = 1; y++; }
    if (months.length > 240) break;   // 念のための上限（20年分）
  }
  return months;
}

/**
 * 期間内の記録を、新しい順に最大 limit 件返す。
 * @param {{ from: string, to: string, user?: string, kind?: string, q?: string, limit: number }} cond  from / to は 'YYYY-MM-DD'（両端を含む）
 * @returns {Promise<{ rows: object[], total: number, truncated: boolean, unreadable: number }>}
 *   total = 条件に合った件数 / unreadable = 読めなかった行の数（途中で切れた行・書き換えられた行。絞り込みの条件には関係なく数える）
 */
async function read({ from, to, user, kind, q, limit, patientIds, patientId }) {   // patientId: その患者IDの記録だけ（数値）
  if (!dir) return { rows: [], total: 0, truncated: false, unreadable: 0 };
  const needle = q ? String(q).toLowerCase() : '';
  const ring = new Array(limit);   // 条件に合ったもののうち、新しい limit 件だけを覚えておく
  let total = 0;
  let unreadable = 0;

  for (const month of monthsBetween(from, to)) {
    const file = path.join(dir, `audit-${month}.jsonl`);
    if (!fs.existsSync(file)) continue;
    for await (const line of linesOf(file)) {
      if (!line.trim()) continue;
      // 読めない行は、黙って飛ばさずに数える（画面に「読めない行がある」と出す）。
      // 行頭が決まった形でない行は日付も分からないので、期間に関係なく数える
      if (!LINE_HEAD.test(line)) { unreadable++; continue; }
      const day = line.slice(6, 16);   // 行頭は {"t":"YYYY-MM-DD…
      if (day < from || day > to) continue;
      let row;
      try { row = JSON.parse(line); } catch (_) { unreadable++; continue; }   // 途中で切れた行（停電の瞬間など）
      if (!row || typeof row !== 'object') { unreadable++; continue; }
      const textHit = !needle || line.toLowerCase().includes(needle);
      if (!textHit && !(patientIds && patientIds.size)) continue;
      if (needle) {
        // キーワードは、行の文字のほかに「患者の氏名」でも探す（行には患者IDしか入っていないため）。
        // 操作ログを表示した記録そのもの（検索に使った言葉が入っている）は、キーワードでは拾わない
        if (row.action === 'audit.view') {
          // 検索した言葉そのもの（detail.q）に当たっただけなら拾わない。それ以外の部分（ユーザーID・接続元など）に当たった記録は拾う
          // （以前は、キーワードを入れると操作ログの表示の記録がすべて消えていた。接続元で調べたときに、件数が合わなくなる）
          const { q: _q, ...rest } = row.detail && typeof row.detail === 'object' ? row.detail : {};
          if (!JSON.stringify({ ...row, detail: rest }).toLowerCase().includes(needle)) continue;
        } else if (!textHit && !(patientIds && patientIds.has(row.patient_id))) continue;
      }
      if (patientId !== undefined && row.patient_id !== patientId) continue;
      if (user && row.user !== user) continue;
      if (kind && !kindsOf(row).includes(kind)) continue;
      ring[total % limit] = row;
      total++;
    }
  }

  const count = Math.min(total, limit);
  const rows = [];
  for (let i = 1; i <= count; i++) rows.push(ring[(total - i) % limit]);   // 新しい順
  return { rows, total, truncated: total > limit, unreadable };
}

// 書き込みの状態（操作ログの画面に「記録できていない」ことを出すため）
function status() {
  return { dir, failedCount, lastError };
}

module.exports = {
  init, write, record, recordSystem, read, status, clientIp, localIso, kindsOf, reserveUser,
  // 自己テスト（tools/selftest-security.js）用
  safeText, ANON_PER_MINUTE, USER_PER_MINUTE,
  _test: {
    sanitize, setCheckInterval: ms => { checkIntervalMs = ms; }, close: closeFile, allowAnonymous, flushAnonSkipped,
    resetAnonymous: () => { anonWindowStart = 0; anonUsed = 0; anonSkipped = 0; if (anonTimer) { clearTimeout(anonTimer); anonTimer = null; } },
    flushUser, resetUsers: () => { for (const w of userWindows.values()) if (w.timer) clearTimeout(w.timer); userWindows.clear(); },
  },
};
