const express = require('express');
const router = express.Router();
const db = require('../database');

// 特定患者・日付範囲の実績取得
router.get('/', (req, res) => {
  const { patient_id, year, month } = req.query;
  const from = `${year}-${String(month).padStart(2,'0')}-01`;
  const to   = `${year}-${String(month).padStart(2,'0')}-31`;

  const records = db.query(`
    SELECT record_date, item_id, quantity FROM records
    WHERE patient_id=? AND record_date BETWEEN ? AND ?
    ORDER BY record_date
  `, [patient_id, from, to]);

  const meals = db.query(`
    SELECT record_date, breakfast, lunch, dinner, note FROM meal_records
    WHERE patient_id=? AND record_date BETWEEN ? AND ?
    ORDER BY record_date
  `, [patient_id, from, to]);

  res.json({ records, meals });
});

// 実績を保存（日付・患者ごとに一括保存）
router.post('/', (req, res) => {
  const { patient_id, record_date, items, meal } = req.body;

  for (const { item_id, quantity } of items) {
    if (quantity > 0) {
      db.run(`
        INSERT INTO records (patient_id, record_date, item_id, quantity) VALUES (?,?,?,?)
        ON CONFLICT(patient_id, record_date, item_id) DO UPDATE SET quantity=excluded.quantity
      `, [patient_id, record_date, item_id, quantity]);
    } else {
      db.run('DELETE FROM records WHERE patient_id=? AND record_date=? AND item_id=?',
        [patient_id, record_date, item_id]);
    }
  }

  if (meal) {
    db.run(`
      INSERT INTO meal_records (patient_id, record_date, breakfast, lunch, dinner, note)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(patient_id, record_date) DO UPDATE SET
        breakfast=excluded.breakfast, lunch=excluded.lunch,
        dinner=excluded.dinner, note=excluded.note
    `, [patient_id, record_date, meal.breakfast ?? 0, meal.lunch ?? 0, meal.dinner ?? 0, meal.note ?? '']);
  }

  res.json({ ok: true });
});

// 月次集計
router.get('/summary', (req, res) => {
  const { patient_id, year, month } = req.query;
  const from = `${year}-${String(month).padStart(2,'0')}-01`;
  const to   = `${year}-${String(month).padStart(2,'0')}-31`;

  const totals = db.query(`
    SELECT r.item_id, i.name, SUM(r.quantity) as total_qty,
           COALESCE(p.unit_price, 0) as unit_price,
           SUM(r.quantity) * COALESCE(p.unit_price, 0) as subtotal
    FROM records r
    JOIN items i ON i.id = r.item_id
    LEFT JOIN prices p ON p.item_id=r.item_id AND p.year=? AND p.month=?
    WHERE r.patient_id=? AND r.record_date BETWEEN ? AND ?
    GROUP BY r.item_id
    ORDER BY i.sort_order, i.id
  `, [year, month, patient_id, from, to]);

  const mealTotals = db.query(`
    SELECT SUM(breakfast) as breakfast, SUM(lunch) as lunch, SUM(dinner) as dinner
    FROM meal_records
    WHERE patient_id=? AND record_date BETWEEN ? AND ?
  `, [patient_id, from, to])[0] || { breakfast: 0, lunch: 0, dinner: 0 };

  const grandTotal = totals.reduce((s, r) => s + (r.subtotal || 0), 0);

  res.json({ totals, mealTotals, grandTotal });
});

module.exports = router;
