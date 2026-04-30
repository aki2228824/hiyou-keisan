const express = require('express');
const router = express.Router();
const db = require('../database');

// 患者の食事単価取得（指定年月、なければ直近の設定を返す）
router.get('/', (req, res) => {
  const { patient_id, year, month } = req.query;

  let row = db.query(
    'SELECT * FROM patient_meal_prices WHERE patient_id=? AND year=? AND month=?',
    [patient_id, year, month]
  )[0];

  if (!row) {
    // 直近の設定を取得
    row = db.query(
      'SELECT * FROM patient_meal_prices WHERE patient_id=? ORDER BY year DESC, month DESC LIMIT 1',
      [patient_id]
    )[0];
  }

  res.json(row || { breakfast_price: 0, lunch_price: 0, dinner_price: 0 });
});

// 複数患者の食事単価を一括取得（月次集計用）
router.get('/bulk', (req, res) => {
  const { year, month } = req.query;
  const rows = db.query(
    'SELECT * FROM patient_meal_prices WHERE year=? AND month=?',
    [year, month]
  );
  // patient_id → prices のマップで返す
  const map = {};
  for (const r of rows) map[r.patient_id] = r;
  res.json(map);
});

// 単価を保存（UPSERT）
router.post('/', (req, res) => {
  const { patient_id, year, month, breakfast_price, lunch_price, dinner_price } = req.body;
  db.run(`
    INSERT INTO patient_meal_prices (patient_id, year, month, breakfast_price, lunch_price, dinner_price)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(patient_id, year, month) DO UPDATE SET
      breakfast_price=excluded.breakfast_price,
      lunch_price=excluded.lunch_price,
      dinner_price=excluded.dinner_price
  `, [patient_id, year, month, breakfast_price ?? 0, lunch_price ?? 0, dinner_price ?? 0]);
  res.json({ ok: true });
});

module.exports = router;
