// API へのリクエストを操作ログに記録する（services/auditLog.js）。
//
// 記録するもの:
//   ・GET 以外のすべての API（登録・変更・削除・出力の実行）。断られたもの（400 / 401 / 403 / 404 / 409 / 500）も含む
//   ・GET のうち、患者の情報・ユーザーの一覧・操作ログそのものを表示／出力するもの（下の表で GET になっているもの）
// 記録しないもの:
//   ・画面のファイル（HTML / CSS / JS）、病棟・物品・単価の一覧のような参照用データの GET
//   ・/api/auth/…（ログイン・ログアウトは routes/auth.js が、入力されたユーザーIDなどを選んで記録する）
//
// この処理は応答を返したあとに動くので、ここで例外が出ると受け止める場所が無く、サーバー全体が止まる。
// 送られてくる値は何が入っているか分からない（?patient_id[toString]=1 のような細工もできる）ので、
// 値を文字列や数値に変えるところは例外が出ない書き方にし、さらに全体を try / catch で囲んでいる。
const audit = require('../services/auditLog');

// [メソッド, パスの形, 記録する種類]。Express は既定で大文字・小文字と末尾の / を区別しないので、ここでも区別しない。
// ID の部分は数字に限らない（/api/users/1.0 のような書き方でもルートに届くので、その場合も同じ種類として記録する）。
const RULES = [
  ['GET',    /^\/api\/patients\/?$/i,                      'patients.list'],
  ['POST',   /^\/api\/patients\/?$/i,                      'patients.create'],
  ['PUT',    /^\/api\/patients\/([^/]+)\/?$/i,             'patients.update'],
  ['DELETE', /^\/api\/patients\/([^/]+)\/?$/i,             'patients.delete'],
  ['GET',    /^\/api\/records\/?$/i,                       'records.view'],
  ['POST',   /^\/api\/records\/?$/i,                       'records.save'],
  ['GET',    /^\/api\/records\/summary\/?$/i,              'summary.view'],
  ['GET',    /^\/api\/meal-prices\/?$/i,                   'mealprices.view'],
  ['GET',    /^\/api\/meal-prices\/bulk\/?$/i,             'mealprices.list'],
  ['POST',   /^\/api\/meal-prices\/?$/i,                   'mealprices.save'],
  ['GET',    /^\/api\/pdf\/?$/i,                           'pdf.export'],
  ['POST',   /^\/api\/items\/?$/i,                         'items.create'],
  ['POST',   /^\/api\/items\/prices\/?$/i,                 'prices.save'],
  ['PUT',    /^\/api\/items\/([^/]+)\/?$/i,                'items.update'],
  ['DELETE', /^\/api\/items\/([^/]+)\/?$/i,                'items.delete'],
  ['POST',   /^\/api\/wards\/?$/i,                         'wards.create'],
  ['PUT',    /^\/api\/wards\/([^/]+)\/?$/i,                'wards.update'],
  ['GET',    /^\/api\/users\/?$/i,                         'users.list'],
  ['POST',   /^\/api\/users\/?$/i,                         'users.create'],
  ['POST',   /^\/api\/users\/([^/]+)\/unlock\/?$/i,        'users.unlock'],
  ['PUT',    /^\/api\/users\/([^/]+)\/?$/i,                'users.update'],
  ['DELETE', /^\/api\/users\/([^/]+)\/?$/i,                'users.delete'],
  ['POST',   /^\/api\/export\/weekly-usage\/run\/?$/i,     'export.run'],
  ['GET',    /^\/api\/audit\/?$/i,                         'audit.view'],
];

/**
 * 送られてきたIDを数値にする。ルート側が受け付ける書き方（"1.0"、" 1"、"0001" など。Number() や SQLite の比較は
 * これらを 1 と同じに扱う）も同じ数値にそろえ、「どの患者か」が記録から抜けないようにする。
 * @returns {{ id?: number, raw?: any }} id = 数値として読めたときのID / raw = 普通の数字の書き方でなかったときの、送られてきたままの値
 */
function parseId(value) {
  if (value === undefined || value === null || value === '') return {};
  let id;
  if (typeof value === 'number') id = value;
  else if (typeof value === 'string' && value.trim() !== '') id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) return { raw: value };   // 数値として読めない（文字・配列・オブジェクトなど）
  return typeof value === 'number' || /^[1-9]\d{0,14}$/.test(value) ? { id } : { id, raw: value };
}

function decodeSegment(text) {
  try { return decodeURIComponent(text); } catch (_) { return text; }
}

// そのリクエストが記録の対象なら { action, target, targetRaw }、対象外なら null
function classify(method, path) {
  if (typeof path !== 'string' || !/^\/api\//i.test(path) || /^\/api\/auth(\/|$)/i.test(path)) return null;
  const m = method === 'HEAD' ? 'GET' : method;
  for (const [ruleMethod, pattern, action] of RULES) {
    if (ruleMethod !== m) continue;
    const match = pattern.exec(path);
    if (!match) continue;
    if (match[1] === undefined) return { action };
    const { id, raw } = parseId(decodeSegment(match[1]));
    return { action, target: id, targetRaw: raw };
  }
  // 上の表に無い GET（参照用データ）は記録しない。GET 以外は、表に無くても「その他」として残す
  return m === 'GET' || m === 'OPTIONS' ? null : { action: 'other' };
}

let lastErrorReportedAt = 0;

function auditMiddleware(req, res, next) {
  let kind = null;
  try { kind = classify(req.method, req.path); } catch (_) { kind = null; }
  if (!kind) return next();

  const startedAt = process.hrtime.bigint();
  // ログアウトやユーザーの無効化で、応答を返す時点ではセッションからユーザーが消えていることがあるので、先に控えておく
  const actorAtStart = req.session?.user ? { ...req.session.user } : null;

  // 'close' は、応答を返し終えたときにも、途中で接続が切れたとき（PDFの作成中にタブを閉じた等）にも1回だけ起きる
  res.once('close', () => {
    try {
      const actor = req.session?.user || actorAtStart;
      const query = req.query && typeof req.query === 'object' ? req.query : {};
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
      const isPatientRoute = kind.action.startsWith('patients.') && (kind.target !== undefined || kind.targetRaw !== undefined);
      const patient = isPatientRoute
        ? { id: kind.target, raw: kind.targetRaw }
        : parseId(query.patient_id !== undefined ? query.patient_id : body ? body.patient_id : undefined);

      // 未ログインの要求は、内容（本文・検索条件）を記録しない。だれでも送れるので、大きな本文を送り付けてログを膨らませられるため
      let detail;
      if (actor) {
        if (req.method === 'GET' || req.method === 'HEAD') {
          const { patient_id, ...rest } = query;   // patient_id は別の欄に出すので、detail からは外す
          detail = rest;
        } else if (body) {
          const { patient_id, ...rest } = body;
          detail = Object.keys(query).length ? { ...rest, _query: query } : rest;
        } else if (Object.keys(query).length) {
          detail = { _query: query };
        }
        // ルート側で付け足した内容（削除した患者の氏名など）
        if (res.locals && res.locals.auditDetail) detail = { ...(detail || {}), ...res.locals.auditDetail };
      }

      audit.record(req, kind.action, {
        actor: actorAtStart,
        status: res.statusCode,
        ms: Number((process.hrtime.bigint() - startedAt) / 1000000n),
        patient_id: patient.id,
        patient_id_raw: patient.raw,
        target: isPatientRoute ? undefined : kind.target,
        target_raw: isPatientRoute ? undefined : kind.targetRaw,
        detail,
        aborted: !res.writableFinished,
      });
    } catch (err) {
      // ここで例外を外へ出すとサーバーが止まる。記録できなかったことだけをエラーログに残す（1分に1回まで）
      if (Date.now() - lastErrorReportedAt > 60000) {
        lastErrorReportedAt = Date.now();
        console.error('操作ログの記録中にエラー:', err && err.message);
      }
    }
  });
  next();
}

module.exports = { auditMiddleware, classify, parseId };
