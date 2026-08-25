const express = require('express');
const router = express.Router();
const db = require('../database');
const { getMealPrices, getMealPriceMap } = require('../services/prices');

// 患者の食事単価取得（指定年月、なければ直近の設定を返す）
router.get('/', (req, res) => {
  const { patient_id, year, month } = req.query;

  res.json(getMealPrices(patient_id, year, month));
});

// 複数患者の食事単価を一括取得（月次集計用）
router.get('/bulk', (req, res) => {
  const { year, month } = req.query;
  res.json(getMealPriceMap(year, month));
});

// 単価を保存（UPSERT）
router.post('/', (req, res) => {
  const { patient_id, year, month, breakfast_price, lunch_price, dinner_price, meal_cap } = req.body;
  db.run(`
    INSERT INTO patient_meal_prices (patient_id, year, month, breakfast_price, lunch_price, dinner_price, meal_cap)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(patient_id, year, month) DO UPDATE SET
      breakfast_price=excluded.breakfast_price,
      lunch_price=excluded.lunch_price,
      dinner_price=excluded.dinner_price,
      meal_cap=excluded.meal_cap
  `, [patient_id, year, month, breakfast_price ?? 0, lunch_price ?? 0, dinner_price ?? 0, meal_cap ?? 0]);
  res.json({ ok: true });
});

module.exports = router;
