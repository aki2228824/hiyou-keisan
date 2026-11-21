const express = require('express');
const router = express.Router();
const db = require('../database');
const audit = require('../services/auditLog');
const { requireRole } = require('../middleware/auth');

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;
const MAX_RANGE_DAYS = 366;
const KINDS = ['auth', 'view', 'change', 'denied'];

// 'YYYY-MM-DD' で、実在する日付か
function isRealDate(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(str + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === str;
}

/**
 * GET /api/audit  操作ログの表示（管理者のみ）。新しい順に返す。
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD  期間（両端を含む。省略時はサーバーの今日）
 *   ?user=ユーザーID                 そのユーザーの記録だけ
 *   ?kind=auth|view|change|denied    ログイン・認証／表示・出力／登録・変更・削除／断られた操作・エラー
 *   ?q=文字列                        その文字列を含む記録だけ（大文字・小文字は区別しない）
 *   ?limit=件数                      既定 500、最大 5000
 */
router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const today = audit.localIso(new Date()).slice(0, 10);
    const from = req.query.from == null || req.query.from === '' ? today : req.query.from;
    const to = req.query.to == null || req.query.to === '' ? from : req.query.to;
    if (!isRealDate(from) || !isRealDate(to))
      return res.status(400).json({ error: '日付は YYYY-MM-DD 形式で指定してください' });
    if (from > to)
      return res.status(400).json({ error: '期間の開始日が終了日より後になっています' });
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > MAX_RANGE_DAYS)
      return res.status(400).json({ error: '期間は1年以内で指定してください' });

    const kind = req.query.kind == null || req.query.kind === '' ? '' : req.query.kind;
    if (kind && !KINDS.includes(kind))
      return res.status(400).json({ error: '種類の指定が正しくありません' });
    for (const name of ['user', 'q']) {
      const v = req.query[name];
      if (v != null && (typeof v !== 'string' || v.length > 100))
        return res.status(400).json({ error: `${name} の指定が正しくありません` });
    }
    // 文字列以外（?limit[a]=1 のような指定）を Number() に渡すと例外になることがあるので、先に形を確かめる
    const limitText = req.query.limit == null || req.query.limit === '' ? String(DEFAULT_LIMIT) : req.query.limit;
    if (typeof limitText !== 'string' || !/^\d{1,6}$/.test(limitText) || Number(limitText) < 1)
      return res.status(400).json({ error: 'limit が正しくありません' });
    const limitRaw = Number(limitText);
    const limit = Math.min(limitRaw, MAX_LIMIT);

    const result = await audit.read({ from, to, user: req.query.user || '', kind, q: req.query.q || '', limit });

    // 患者IDには、いまの氏名を付けて返す（ログには氏名を重ねて持たせない。削除済みの患者は氏名なし）
    const names = new Map(db.query('SELECT id, name FROM patients').map(p => [p.id, p.name]));
    for (const row of result.rows) {
      if (row.patient_id != null && names.has(row.patient_id)) row.patient_name = names.get(row.patient_id);
    }

    res.json({ from, to, ...result, writer: audit.status() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
