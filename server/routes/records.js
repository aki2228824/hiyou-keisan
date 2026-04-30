const express = require('express');
const router = express.Router();
const db = require('../database');

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
    SELECT record_date, breakfast, lunch, dinner,
           service_status, hospital_addition, hospital_special
    FROM meal_records
    WHERE patient_id=? AND record_date BETWEEN ? AND ?
    ORDER BY record_date
  `, [patient_id, from, to]);

  res.json({ records, meals });
});

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
      INSERT INTO meal_records
        (patient_id, record_date, breakfast, lunch, dinner,
         service_status, hospital_addition, hospital_special)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(patient_id, record_date) DO UPDATE SET
        breakfast=excluded.breakfast, lunch=excluded.lunch, dinner=excluded.dinner,
        service_status=excluded.service_status,
        hospital_addition=excluded.hospital_addition,
        hospital_special=excluded.hospital_special
    `, [
      patient_id, record_date,
      meal.breakfast ?? 0, meal.lunch ?? 0, meal.dinner ?? 0,
      meal.service_status ?? '',
      meal.hospital_addition ?? 0,
      meal.hospital_special ?? 0,
    ]);
  }

  res.json({ ok: true });
});

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
    SELECT SUM(breakfast) as breakfast, SUM(lunch) as lunch, SUM(dinner) as dinner,
           SUM(hospital_addition) as hospital_addition,
           SUM(hospital_special) as hospital_special
    FROM meal_records
    WHERE patient_id=? AND record_date BETWEEN ? AND ?
  `, [patient_id, from, to])[0] || { breakfast: 0, lunch: 0, dinner: 0, hospital_addition: 0, hospital_special: 0 };

  const mealPrices = db.query(
    'SELECT * FROM patient_meal_prices WHERE patient_id=? AND year=? AND month=?',
    [patient_id, year, month]
  )[0] || { breakfast_price: 0, lunch_price: 0, dinner_price: 0, meal_cap: 0 };

  const rawMealCost =
    (mealTotals.breakfast || 0) * (mealPrices.breakfast_price || 0) +
    (mealTotals.lunch    || 0) * (mealPrices.lunch_price    || 0) +
    (mealTotals.dinner   || 0) * (mealPrices.dinner_price   || 0);

  const mealCap = mealPrices.meal_cap || 0;
  const mealCost = mealCap > 0 ? Math.min(rawMealCost, mealCap) : rawMealCost;

  const itemTotal  = totals.reduce((s, r) => s + (r.subtotal || 0), 0);
  const grandTotal = itemTotal + mealCost;

  res.json({ totals, mealTotals, mealPrices, rawMealCost, mealCost, mealCap, itemTotal, grandTotal });
});

module.exports = router;
