// API へのリクエストを操作ログに記録する（services/auditLog.js）。
//
// 記録するもの:
//   ・GET 以外のすべての API（登録・変更・削除・出力の実行）。断られたもの（400 / 401 / 403 / 404 / 409 / 500）も含む
//   ・GET のうち、患者の情報・ユーザーの一覧・操作ログそのものを表示／出力するもの（下の LOGGED_GET）
// 記録しないもの:
//   ・画面のファイル（HTML / CSS / JS）、病棟・物品・単価の一覧のような参照用データの GET
//   ・/api/auth/…（ログイン・ログアウトは routes/auth.js が、入力されたユーザーIDなどを選んで記録する）
const audit = require('../services/auditLog');

// [メソッド, パスの形, 記録する種類]。Express は既定で大文字・小文字と末尾の / を区別しないので、ここでも区別しない
const RULES = [
  ['GET',    /^\/api\/patients\/?$/i,                  'patients.list'],
  ['POST',   /^\/api\/patients\/?$/i,                  'patients.create'],
  ['PUT',    /^\/api\/patients\/(\d+)\/?$/i,           'patients.update'],
  ['DELETE', /^\/api\/patients\/(\d+)\/?$/i,           'patients.delete'],
  ['GET',    /^\/api\/records\/?$/i,                   'records.view'],
  ['POST',   /^\/api\/records\/?$/i,                   'records.save'],
  ['GET',    /^\/api\/records\/summary\/?$/i,          'summary.view'],
  ['GET',    /^\/api\/meal-prices\/?$/i,               'mealprices.view'],
  ['GET',    /^\/api\/meal-prices\/bulk\/?$/i,         'mealprices.list'],
  ['POST',   /^\/api\/meal-prices\/?$/i,               'mealprices.save'],
  ['GET',    /^\/api\/pdf\/?$/i,                       'pdf.export'],
  ['POST',   /^\/api\/items\/?$/i,                     'items.create'],
  ['PUT',    /^\/api\/items\/(\d+)\/?$/i,              'items.update'],
  ['DELETE', /^\/api\/items\/(\d+)\/?$/i,              'items.delete'],
  ['POST',   /^\/api\/items\/prices\/?$/i,             'prices.save'],
  ['POST',   /^\/api\/wards\/?$/i,                     'wards.create'],
  ['PUT',    /^\/api\/wards\/(\d+)\/?$/i,              'wards.update'],
  ['GET',    /^\/api\/users\/?$/i,                     'users.list'],
  ['POST',   /^\/api\/users\/?$/i,                     'users.create'],
  ['PUT',    /^\/api\/users\/(\d+)\/?$/i,              'users.update'],
  ['DELETE', /^\/api\/users\/(\d+)\/?$/i,              'users.delete'],
  ['POST',   /^\/api\/users\/(\d+)\/unlock\/?$/i,      'users.unlock'],
  ['POST',   /^\/api\/export\/weekly-usage\/run\/?$/i, 'export.run'],
  ['GET',    /^\/api\/audit\/?$/i,                     'audit.view'],
];

// そのリクエストが記録の対象なら { action, target }、対象外なら null
function classify(method, path) {
  if (!/^\/api\//i.test(path) || /^\/api\/auth\//i.test(path)) return null;
  const m = method === 'HEAD' ? 'GET' : method;
  for (const [ruleMethod, pattern, action] of RULES) {
    if (ruleMethod !== m) continue;
    const match = pattern.exec(path);
    if (match) return { action, target: match[1] ? Number(match[1]) : undefined };
  }
  // 上の表に無い GET（参照用データ）は記録しない。GET 以外は、表に無くても「その他」として残す
  return m === 'GET' || m === 'OPTIONS' ? null : { action: 'other' };
}

function toId(value) {
  return /^\d{1,15}$/.test(String(value ?? '')) ? Number(value) : undefined;
}

function auditMiddleware(req, res, next) {
  const kind = classify(req.method, req.path);
  if (!kind) return next();

  const startedAt = process.hrtime.bigint();
  // ログアウトやユーザーの無効化で、応答を返す時点ではセッションからユーザーが消えていることがあるので、先に控えておく
  const actorAtStart = req.session?.user ? { ...req.session.user } : null;

  // 'close' は、応答を返し終えたときにも、途中で接続が切れたとき（PDFの作成中にタブを閉じた等）にも1回だけ起きる
  res.once('close', () => {
    const query = req.query || {};
    const body = req.body && typeof req.body === 'object' ? req.body : null;
    const isPatientRoute = kind.action.startsWith('patients.') && kind.target !== undefined;
    const patientId = isPatientRoute ? kind.target : toId(query.patient_id ?? body?.patient_id);

    let detail;
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
    if (res.locals.auditDetail) detail = { ...(detail || {}), ...res.locals.auditDetail };

    audit.record(req, kind.action, {
      actor: actorAtStart,
      status: res.statusCode,
      ms: Number((process.hrtime.bigint() - startedAt) / 1000000n),
      patient_id: patientId,
      target: isPatientRoute ? undefined : kind.target,
      detail,
      aborted: !res.writableFinished,
    });
  });
  next();
}

module.exports = { auditMiddleware, classify };
