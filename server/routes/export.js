const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/auth');
const { aggregateWeeklyUsage, runWeeklyExport, periodLabel } = require('../services/weeklyUsage');

/**
 * POST /api/export/weekly-usage/run  週次使用量レポートの手動実行（管理者のみ）
 *   ?dry=1            Difyへ送らず集計JSONをそのまま返す
 *   ?date=YYYY-MM-DD  基準日を指定して過去週を集計する
 */
router.post('/weekly-usage/run', requireRole('admin'), (req, res) => {
  const baseDate = req.query.date || undefined;
  if (baseDate && !/^\d{4}-\d{2}-\d{2}$/.test(baseDate))
    return res.status(400).json({ error: 'date は YYYY-MM-DD 形式で指定してください' });

  const dry = req.query.dry === '1';

  let payload;
  try {
    payload = aggregateWeeklyUsage(baseDate);
  } catch (err) {
    console.error('週次使用量の集計に失敗:', err);
    return res.status(500).json({ error: '集計に失敗しました' });
  }

  // ドライランは同期で集計結果をそのまま返す
  if (dry) return res.json(payload);

  // 送信はリトライで最大21分かかるためバックグラウンドで実行し、結果は data/export.log に記録する
  runWeeklyExport({ payload, trigger: 'manual' }).catch(err => {
    console.error('週次使用量レポートの送信でエラー:', err);
  });

  res.status(202).json({
    accepted: true,
    period: payload.period,
    period_label: periodLabel(payload.period),
    item_count: payload.items.length,
    message: '集計してDifyへ送信中です。結果は data/export.log を確認してください。',
  });
});

module.exports = router;
