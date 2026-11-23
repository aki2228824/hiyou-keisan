const db = require('../database');

/**
 * 単価の参照を一箇所にまとめたヘルパー。
 * どの画面でも「指定年月に設定が無ければ直近の過去月から引き継ぐ」で統一する
 * （月次集計・請求書PDFが当月ちょうどの行しか見ず0円になっていた不具合の対策）。
 */

// DBに数値以外が入っていても集計が null/NaN にならないよう、数値にそろえる
function num(value) {
  return Number(value) || 0;
}

const MAX_COUNT = 9999;      // 1日・1品目あたりの数量、1日の食事回数・加算の上限
const MAX_PRICE = 9999999;   // 単価・上限額（円）の上限

/**
 * 数量・回数・金額の入力値を「0 以上 max 以下の整数」にそろえる。未入力は 0、それ以外で読めないものは null。
 * 小数（1.5）、指数や16進の書き方（"1e2"・"0x10"）、上限を超える値は受け付けない
 * （以前は受け付けていたので、単価 0.1 × 数量 3 = 0.30000000000000004 円のように、金額に端数が出た）。
 */
function toWholeNumber(value, max) {
  if (value == null || value === '') return 0;
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^\d{1,9}$/.test(value.trim())) n = Number(value.trim());
  else return null;
  return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
}

/** 単価・金額の入力値を整数（円）にそろえる。未入力は 0、0〜9,999,999 の整数として読めないものは null */
function toPrice(value) {
  return toWholeNumber(value, MAX_PRICE);
}

/** 数量・回数の入力値を整数にそろえる。未入力は 0、0〜9,999 の整数として読めないものは null */
function toCount(value) {
  return toWholeNumber(value, MAX_COUNT);
}

/** ID・年・月の入力値を正の整数にそろえる。読めないものは null */
function toPositiveInt(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * 検索条件の値が、文字列か数値（または未指定）か。
 * ?year[a]=1 のような指定で届くオブジェクトや配列は false（そのまま Number() やDBへ渡すと例外になるため、先に弾く）
 */
function isPlainValue(value) {
  return value == null || typeof value === 'string' || typeof value === 'number';
}

/** 年月の入力チェック。正しければ { year, month }、問題があれば { error } を返す */
function parseYearMonth(year, month) {
  const y = toPositiveInt(year);
  const m = toPositiveInt(month);
  if (y === null || y < 1000 || y > 9999) return { error: 'year が正しくありません' };
  if (m === null || m > 12) return { error: 'month が正しくありません' };
  return { year: y, month: m };
}

/** 日用品単価：item_id → unit_price のマップを返す */
function getItemPriceMap(year, month) {
  const y = Number(year);
  const m = Number(month);
  const rows = db.query(`
    SELECT i.id,
           COALESCE(
             (SELECT unit_price FROM prices
              WHERE item_id=i.id AND year=? AND month=?),
             (SELECT unit_price FROM prices
              WHERE item_id=i.id AND (year*100+month) < ?*100+?
              ORDER BY year DESC, month DESC LIMIT 1),
             0
           ) AS unit_price
    FROM items i
  `, [y, m, y, m]);

  const map = {};
  for (const r of rows) map[r.id] = num(r.unit_price);
  return map;
}

/** 患者ごとの食事単価：指定年月、なければ直近の過去月の設定を返す */
function getMealPrices(patientId, year, month) {
  const y = Number(year);
  const m = Number(month);
  const row = db.query(`
    SELECT * FROM patient_meal_prices
    WHERE patient_id=? AND (year*100+month) <= ?*100+?
    ORDER BY year DESC, month DESC LIMIT 1
  `, [patientId, y, m])[0];
  if (!row) return { breakfast_price: 0, lunch_price: 0, dinner_price: 0, meal_cap: 0 };
  return {
    ...row,
    breakfast_price: num(row.breakfast_price),
    lunch_price: num(row.lunch_price),
    dinner_price: num(row.dinner_price),
    meal_cap: num(row.meal_cap),
  };
}

/** 全患者の食事単価：patient_id → 単価 のマップを返す（月次集計用） */
function getMealPriceMap(year, month) {
  const map = {};
  for (const { id } of db.query('SELECT id FROM patients')) {
    map[id] = getMealPrices(id, year, month);
  }
  return map;
}

module.exports = { getItemPriceMap, getMealPrices, getMealPriceMap, toPrice, toCount, toPositiveInt, parseYearMonth, isPlainValue, MAX_COUNT, MAX_PRICE };
