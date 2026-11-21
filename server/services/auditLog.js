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
const path = require('path');
const readline = require('readline');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const MAX_STRING = 200;      // 1つの文字列の上限（超えた分は切る）
const MAX_DETAIL = 2000;     // detail 全体の上限（JSON にしたときのバイト数）
const ANON_PER_MINUTE = 120; // 未ログインの要求について、1分間に1件ずつ記録する上限（超えた分は件数だけを残す）
let checkIntervalMs = 5000;    // 「ファイルがまだあるか」を確かめる間隔

let dir = null;              // 保存先フォルダ（init() で決まる。それまでは何も書かない）
let fd = null;               // いま追記しているファイル
let fdName = '';             // そのファイル名
let lastCheckedAt = 0;       // ファイルがまだそこにあるかを最後に確かめた時刻
let syncTimer = null;
let failedCount = 0;         // 起動してから書き込めなかった件数
let lastError = null;        // 直近の失敗 { at, message }
let lastReportedAt = 0;

const pad = (n, len = 2) => String(n).padStart(len, '0');

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

// その時刻の月のファイルを追記用に開く（開いたままにして使い回す。月が変わったら開き直す）
function openFor(d) {
  const name = fileNameFor(d);
  const now = Date.now();
  if (fd !== null && name === fdName) {
    // 開いている間にファイルを消されたり名前を変えられたりすると、見えないファイルへ書き続けてしまう。
    // ときどき確かめて、無くなっていたら作り直す
    if (now - lastCheckedAt < checkIntervalMs) return;
    lastCheckedAt = now;
    if (fs.existsSync(path.join(dir, name))) return;
  }
  closeFile();
  fd = fs.openSync(path.join(dir, name), 'a');
  fdName = name;
  lastCheckedAt = now;
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
    const line = JSON.stringify({ t: localIso(d), ...entry }) + '\n';
    openFor(d);
    fs.writeSync(fd, line);
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
function clientIp(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || '');
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
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
      out[cut(key, 50)] = /pass/i.test(key) ? '***' : sanitize(v, depth + 1);
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
function allowAnonymous(now = Date.now()) {
  if (now - anonWindowStart >= 60000) {
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
  if (!actor && !allowAnonymous()) return false;
  const entry = {
    user: fields.user !== undefined ? safeText(fields.user, 64) : (actor ? actor.username : null),
    uid: actor ? actor.id : undefined,
    role: actor ? actor.role : undefined,
    ip: clientIp(req),
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
  if (action.startsWith('login.') || action === 'logout' || action === 'users.unlock') kinds.push('auth');
  if (/\.(view|list)$/.test(action) || action === 'pdf.export') kinds.push('view');
  if (/\.(create|update|delete|save|unlock|run)$/.test(action) || action === 'other') kinds.push('change');
  if (Number(row.status) >= 400 || action === 'audit.skipped') kinds.push('denied');
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
 * @returns {Promise<{ rows: object[], total: number, truncated: boolean }>} total = 条件に合った件数
 */
async function read({ from, to, user, kind, q, limit }) {
  if (!dir) return { rows: [], total: 0, truncated: false };
  const needle = q ? String(q).toLowerCase() : '';
  const ring = new Array(limit);   // 条件に合ったもののうち、新しい limit 件だけを覚えておく
  let total = 0;

  for (const month of monthsBetween(from, to)) {
    const file = path.join(dir, `audit-${month}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      const day = line.slice(6, 16);   // 行頭は必ず {"t":"YYYY-MM-DD…
      if (day < from || day > to) continue;
      if (needle && !line.toLowerCase().includes(needle)) continue;
      let row;
      try { row = JSON.parse(line); } catch (_) { continue; }   // 途中で切れた行（停電の瞬間など）は飛ばす
      if (!row || typeof row !== 'object') continue;
      if (user && row.user !== user) continue;
      if (kind && !kindsOf(row).includes(kind)) continue;
      ring[total % limit] = row;
      total++;
    }
  }

  const count = Math.min(total, limit);
  const rows = [];
  for (let i = 1; i <= count; i++) rows.push(ring[(total - i) % limit]);   // 新しい順
  return { rows, total, truncated: total > limit };
}

// 書き込みの状態（操作ログの画面に「記録できていない」ことを出すため）
function status() {
  return { dir, failedCount, lastError };
}

module.exports = {
  init, write, record, recordSystem, read, status, clientIp, localIso, kindsOf,
  // 自己テスト（tools/selftest-security.js）用
  safeText, ANON_PER_MINUTE,
  _test: {
    sanitize, setCheckInterval: ms => { checkIntervalMs = ms; }, close: closeFile, allowAnonymous, flushAnonSkipped,
    resetAnonymous: () => { anonWindowStart = 0; anonUsed = 0; anonSkipped = 0; if (anonTimer) { clearTimeout(anonTimer); anonTimer = null; } },
  },
};
