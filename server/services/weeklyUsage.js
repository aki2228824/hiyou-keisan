const fs = require('fs');
const path = require('path');
const db = require('../database');

// ---- しきい値・設定（変更しやすいようにここへ集約） ----
const SPIKE_PCT   = 30;   // 「急増」と判定する増減率（%以上）
const SPIKE_MIN   = 10;   // 「急増」と判定する先週合計の下限
const RETRY_DELAYS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000]; // 1分→5分→15分
const LOG_PATH = path.join(__dirname, '..', '..', 'data', 'export.log');

// ---- 日付ユーティリティ（TEXT型 YYYY-MM-DD を UTC基準で計算する） ----
function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDate(dt) {
  return dt.toISOString().slice(0, 10);
}

function addDays(dt, days) {
  return new Date(dt.getTime() + days * 86400000);
}

/** JSTの「今日」を YYYY-MM-DD で返す */
function todayJst() {
  const jst = new Date(Date.now() + 9 * 3600000);
  return jst.toISOString().slice(0, 10);
}

/** JSTの現在時刻を ISO 8601（+09:00）で返す */
function nowJstIso() {
  const jst = new Date(Date.now() + 9 * 3600000);
  return jst.toISOString().replace('Z', '+09:00');
}

/** 基準日を含む週の月曜を返す */
function mondayOf(dt) {
  const dow = dt.getUTCDay();            // 0=日曜
  const diff = dow === 0 ? -6 : 1 - dow; // 月曜まで戻す
  return addDays(dt, diff);
}

/** 基準日から見た「前週の月〜日」「前々週の月〜日」を求める */
function weekRanges(baseDate) {
  const base = parseDate(baseDate || todayJst());
  const start = addDays(mondayOf(base), -7);
  const end = addDays(start, 6);
  const prevStart = addDays(start, -7);
  const prevEnd = addDays(start, -1);
  return {
    start: formatDate(start),
    end: formatDate(end),
    prev_start: formatDate(prevStart),
    prev_end: formatDate(prevEnd),
  };
}

/** 「8/17〜8/23」形式のラベル */
function periodLabel(period) {
  const s = parseDate(period.start);
  const e = parseDate(period.end);
  return `${s.getUTCMonth() + 1}/${s.getUTCDate()}〜${e.getUTCMonth() + 1}/${e.getUTCDate()}`;
}

// ---- 集計 ----
/**
 * 前週の日用品使用量を品目別・病棟別に集計する（読み取りのみ）。
 * 個人情報（患者名・patient_id・受給者証番号・部屋番号）は一切含めない。
 */
function aggregateWeeklyUsage(baseDate) {
  const period = weekRanges(baseDate);

  // 先週：品目×病棟
  const curRows = db.query(`
    SELECT i.id AS item_id, i.name AS name, i.sort_order AS sort_order,
           w.name AS ward, SUM(r.quantity) AS qty
    FROM records r
    JOIN items    i ON i.id = r.item_id
    JOIN patients p ON p.id = r.patient_id
    JOIN wards    w ON w.id = p.ward_id
    WHERE r.record_date BETWEEN ? AND ? AND i.active = 1
    GROUP BY i.id, w.id
  `, [period.start, period.end]);

  // 前々週：品目合計
  const prevRows = db.query(`
    SELECT i.id AS item_id, i.name AS name, i.sort_order AS sort_order,
           SUM(r.quantity) AS qty
    FROM records r
    JOIN items    i ON i.id = r.item_id
    JOIN patients p ON p.id = r.patient_id
    WHERE r.record_date BETWEEN ? AND ? AND i.active = 1
    GROUP BY i.id
  `, [period.prev_start, period.prev_end]);

  const items = new Map();
  const pick = (row) => {
    if (!items.has(row.item_id)) {
      items.set(row.item_id, {
        item_id: row.item_id, name: row.name, sort_order: row.sort_order,
        total: 0, prev: 0, by_ward: [],
      });
    }
    return items.get(row.item_id);
  };

  for (const row of curRows) {
    const item = pick(row);
    item.total += row.qty;
    if (row.qty > 0) item.by_ward.push({ ward: row.ward, qty: row.qty });
  }
  for (const row of prevRows) pick(row).prev = row.qty;

  const result = [];
  for (const item of items.values()) {
    // 先週・前々週とも0の品目は出力しない
    if (item.total === 0 && item.prev === 0) continue;

    const diff = item.total - item.prev;
    // 前々週0（新規使用）は増減率が計算できないため null・フラグなし
    const pct = item.prev > 0 ? Math.round((diff / item.prev) * 1000) / 10 : null;

    let flag = '';
    if (item.prev > 0 && item.total === 0) flag = '使用停止';
    else if (pct !== null && pct >= SPIKE_PCT && item.total >= SPIKE_MIN) flag = '急増';

    item.by_ward.sort((a, b) => b.qty - a.qty);
    result.push({
      item_id: item.item_id, name: item.name,
      total: item.total, prev: item.prev, diff, pct, flag,
      by_ward: item.by_ward,
      _sort_order: item.sort_order,
    });
  }

  // 使用量の多い順（同数はマスタの表示順）
  result.sort((a, b) => b.total - a.total || a._sort_order - b._sort_order);
  for (const item of result) delete item._sort_order;

  // 参考情報：病棟別の在院患者数（現在値）
  const wardCounts = db.query(`
    SELECT w.name AS ward,
           COUNT(CASE WHEN p.active = 1 THEN 1 END) AS patients
    FROM wards w
    LEFT JOIN patients p ON p.ward_id = w.id
    GROUP BY w.id
    ORDER BY w.name
  `);

  return {
    period,
    generated_at: nowJstIso(),
    ward_patient_counts: wardCounts,
    items: result,
  };
}

// ---- ログ ----
function writeLog(line) {
  const dir = path.dirname(LOG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(LOG_PATH, `[${nowJstIso()}] ${line}\n`, 'utf8');
}

// ---- Dify送信 ----
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Difyワークフローへ送信する。失敗時は 1分→5分→15分 でリトライ。 */
async function sendToDify(payload) {
  const url = process.env.DIFY_API_URL;
  const key = process.env.DIFY_API_KEY;
  if (!url || !key) throw new Error('DIFY_API_URL / DIFY_API_KEY が未設定です');

  const body = JSON.stringify({
    inputs: {
      usage_json: JSON.stringify(payload),
      period_label: periodLabel(payload.period),
    },
    response_mode: 'blocking',
    user: 'hiyou-keisan-weekly',
  });

  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    if (attempt > 0) {
      const wait = RETRY_DELAYS[attempt - 1];
      writeLog(`リトライ待機 ${Math.round(wait / 1000)}秒（${attempt}回目）: ${lastError.message}`);
      await sleep(wait);
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
      }
      return true;
    } catch (err) {
      const cause = err.cause?.code ? ` (${err.cause.code})` : '';
      lastError = new Error(`${err.message}${cause}`);
    }
  }
  throw lastError;
}

/**
 * 集計→送信→ログ記録。サーバー本体は落とさず、失敗はログに残して終了する。
 * @returns {Promise<{payload: object, sent: boolean, error?: string}>}
 */
async function runWeeklyExport({ baseDate, dryRun = false, trigger = 'manual', payload: prepared } = {}) {
  const payload = prepared || aggregateWeeklyUsage(baseDate);
  const label = `${payload.period.start}〜${payload.period.end} 品目${payload.items.length}件`;

  if (dryRun) {
    writeLog(`[${trigger}] ドライラン: ${label}（Difyへは送信していません）`);
    return { payload, sent: false };
  }

  try {
    await sendToDify(payload);
    writeLog(`[${trigger}] 送信成功: ${label}`);
    return { payload, sent: true };
  } catch (err) {
    console.error('週次使用量レポートのDify送信に失敗しました:', err);
    writeLog(`[${trigger}] 送信失敗: ${label} / ${err.message}`);
    return { payload, sent: false, error: err.message };
  }
}

module.exports = {
  aggregateWeeklyUsage,
  sendToDify,
  runWeeklyExport,
  periodLabel,
  weekRanges,
  RETRY_DELAYS,
  SPIKE_PCT,
  SPIKE_MIN,
};
