const cron = require('node-cron');
const { runWeeklyExport } = require('../services/weeklyUsage');

const DEFAULT_CRON = '0 6 * * 1'; // 毎週月曜 06:00 JST

/**
 * EXPORT_ENABLED=true のときだけ週次ジョブを登録する。
 * ※ PM2等で複数プロセス起動すると重複実行されるため、単一インスタンス運用を前提とする。
 */
function initScheduler() {
  if (String(process.env.EXPORT_ENABLED).toLowerCase() !== 'true') {
    console.log('週次使用量レポート: EXPORT_ENABLED が true でないため無効');
    return null;
  }

  const expression = process.env.EXPORT_CRON || DEFAULT_CRON;
  if (!cron.validate(expression)) {
    console.error(`週次使用量レポート: EXPORT_CRON の書式が不正です (${expression})`);
    return null;
  }

  const dryRun = String(process.env.EXPORT_DRY_RUN).toLowerCase() === 'true';

  const task = cron.schedule(expression, () => {
    runWeeklyExport({ dryRun, trigger: 'cron' }).catch(err => {
      console.error('週次使用量レポートのジョブでエラー:', err);
    });
  }, { timezone: 'Asia/Tokyo' });

  console.log(`週次使用量レポート: cron登録 (${expression} / Asia/Tokyo${dryRun ? ' / ドライラン' : ''})`);
  return task;
}

module.exports = { initScheduler };
