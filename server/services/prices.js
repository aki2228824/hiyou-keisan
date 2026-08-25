const db = require('../database');

/**
 * 単価の参照を一箇所にまとめたヘルパー。
 * どの画面でも「指定年月に設定が無ければ直近の過去月から引き継ぐ」で統一する
 * （月次集計・請求書PDFが当月ちょうどの行しか見ず0円になっていた不具合の対策）。
 */

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
  for (const r of rows) map[r.id] = r.unit_price;
  return map;
}

/** 患者ごとの食事単価：指定年月、なければ直近の過去月の設定を返す */
function getMealPrices(patientId, year, month) {
  const y = Number(year);
  const m = Number(month);
  return db.query(`
    SELECT * FROM patient_meal_prices
    WHERE patient_id=? AND (year*100+month) <= ?*100+?
    ORDER BY year DESC, month DESC LIMIT 1
  `, [patientId, y, m])[0]
    || { breakfast_price: 0, lunch_price: 0, dinner_price: 0, meal_cap: 0 };
}

/** 全患者の食事単価：patient_id → 単価 のマップを返す（月次集計用） */
function getMealPriceMap(year, month) {
  const map = {};
  for (const { id } of db.query('SELECT id FROM patients')) {
    map[id] = getMealPrices(id, year, month);
  }
  return map;
}

module.exports = { getItemPriceMap, getMealPrices, getMealPriceMap };
