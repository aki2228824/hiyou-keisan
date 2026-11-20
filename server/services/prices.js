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

/** 単価・金額の入力値を数値にそろえる。未入力は 0、0以上の数値として読めないものは null */
function toPrice(value) {
  if (value == null || value === '') return 0;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** ID・年・月の入力値を正の整数にそろえる。読めないものは null */
function toPositiveInt(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
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

module.exports = { getItemPriceMap, getMealPrices, getMealPriceMap, toPrice, toPositiveInt, parseYearMonth };
