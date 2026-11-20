const express = require('express');
const router = express.Router();
const db = require('../database');
const { getItemPriceMap, getMealPrices } = require('../services/prices');
const { requireRole } = require('../middleware/auth');

// 一覧・集計の検索条件チェック。問題があればエラーメッセージを返す
function checkPeriodQuery({ patient_id, year, month }) {
  if (!/^\d+$/.test(String(patient_id ?? '')) || Number(patient_id) <= 0)
    return 'patient_id が正しくありません';
  if (!/^\d{4}$/.test(String(year ?? '')))
    return 'year が正しくありません';
  if (!/^\d{1,2}$/.test(String(month ?? '')) || Number(month) < 1 || Number(month) > 12)
    return 'month が正しくありません';
  return null;
}

// 実在する日付か（2026-13-45 や 2026-02-30 を弾く）
function isRealDate(str) {
  const d = new Date(str + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === str;
}

// 数量・回数を数値にそろえる。未入力は 0、数値として読めないものは null
function toCount(value) {
  if (value == null || value === '') return 0;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

router.get('/', (req, res) => {
  const { patient_id, year, month } = req.query;
  const queryError = checkPeriodQuery(req.query);
  if (queryError) return res.status(400).json({ error: queryError });
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

// 実績の保存 ※閲覧のみロールは不可
router.post('/', requireRole('admin', 'staff'), (req, res) => {
  const { patient_id, record_date, items, meal } = req.body;

  // 入力チェック（不正なリクエストは例外にせず 400 で返す）
  const pid = typeof patient_id === 'number' || typeof patient_id === 'string' ? Number(patient_id) : NaN;
  if (!Number.isInteger(pid) || pid <= 0)
    return res.status(400).json({ error: 'patient_id が正しくありません' });
  if (typeof record_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record_date))
    return res.status(400).json({ error: 'record_date は YYYY-MM-DD 形式で指定してください' });
  if (!Array.isArray(items))
    return res.status(400).json({ error: 'items は配列で指定してください' });
  if (items.some(it => !it || typeof it !== 'object' || !Number.isInteger(Number(it.item_id)) || Number(it.item_id) <= 0))
    return res.status(400).json({ error: 'items の内容が正しくありません' });
  if (meal != null && (typeof meal !== 'object' || Array.isArray(meal)))
    return res.status(400).json({ error: 'meal の内容が正しくありません' });
  if (!isRealDate(record_date))
    return res.status(400).json({ error: 'record_date が実在しない日付です' });

  // 数量は数値にそろえてから保存する（数値以外は 400）
  const rows = items.map(it => ({ item_id: Number(it.item_id), quantity: toCount(it.quantity) }));
  if (rows.some(r => r.quantity === null))
    return res.status(400).json({ error: '数量は0以上の数値で指定してください' });

  let mealRow = null;
  if (meal) {
    const status = meal.service_status ?? '';
    if (typeof status !== 'string' && typeof status !== 'number')
      return res.status(400).json({ error: 'meal の内容が正しくありません' });
    mealRow = [
      toCount(meal.breakfast), toCount(meal.lunch), toCount(meal.dinner),
      String(status),
      toCount(meal.hospital_addition), toCount(meal.hospital_special),
    ];
    if (mealRow.some(v => v === null))
      return res.status(400).json({ error: '食事回数・加算は0以上の数値で指定してください' });
  }

  // 存在しない患者・物品への登録を防ぐ（sql.js では外部キー制約が効かないため）
  if (!db.query('SELECT id FROM patients WHERE id=?', [pid])[0])
    return res.status(404).json({ error: '患者が見つかりません' });
  const itemIds = new Set(db.query('SELECT id FROM items').map(i => i.id));
  if (rows.some(r => !itemIds.has(r.item_id)))
    return res.status(400).json({ error: '登録されていない物品が含まれています' });

  for (const { item_id, quantity } of rows) {
    if (quantity > 0) {
      db.run(`
        INSERT INTO records (patient_id, record_date, item_id, quantity) VALUES (?,?,?,?)
        ON CONFLICT(patient_id, record_date, item_id) DO UPDATE SET quantity=excluded.quantity
      `, [pid, record_date, item_id, quantity]);
    } else {
      db.run('DELETE FROM records WHERE patient_id=? AND record_date=? AND item_id=?',
        [pid, record_date, item_id]);
    }
  }

  if (mealRow) {
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
    `, [pid, record_date, ...mealRow]);
  }

  res.json({ ok: true });
});

router.get('/summary', (req, res) => {
  const { patient_id, year, month } = req.query;
  const queryError = checkPeriodQuery(req.query);
  if (queryError) return res.status(400).json({ error: queryError });
  const from = `${year}-${String(month).padStart(2,'0')}-01`;
  const to   = `${year}-${String(month).padStart(2,'0')}-31`;

  // 単価は当月に設定が無ければ直近の過去月から引き継ぐ（マスタ画面の表示と揃える）
  const priceMap = getItemPriceMap(year, month);
  const totals = db.query(`
    SELECT r.item_id, i.name, SUM(r.quantity) as total_qty
    FROM records r
    JOIN items i ON i.id = r.item_id
    WHERE r.patient_id=? AND r.record_date BETWEEN ? AND ?
    GROUP BY r.item_id
    ORDER BY i.sort_order, i.id
  `, [patient_id, from, to]).map(row => {
    // DBに数値以外が入っていても合計が null/NaN にならないよう、数値にそろえる
    const unit_price = Number(priceMap[row.item_id]) || 0;
    const total_qty = Number(row.total_qty) || 0;
    return { ...row, total_qty, unit_price, subtotal: total_qty * unit_price };
  });

  const mealTotals = db.query(`
    SELECT SUM(breakfast) as breakfast, SUM(lunch) as lunch, SUM(dinner) as dinner,
           SUM(hospital_addition) as hospital_addition,
           SUM(hospital_special) as hospital_special
    FROM meal_records
    WHERE patient_id=? AND record_date BETWEEN ? AND ?
  `, [patient_id, from, to])[0] || { breakfast: 0, lunch: 0, dinner: 0, hospital_addition: 0, hospital_special: 0 };

  const mealPrices = getMealPrices(patient_id, year, month);

  const rawMealCost =
    (Number(mealTotals.breakfast) || 0) * (Number(mealPrices.breakfast_price) || 0) +
    (Number(mealTotals.lunch)     || 0) * (Number(mealPrices.lunch_price)     || 0) +
    (Number(mealTotals.dinner)    || 0) * (Number(mealPrices.dinner_price)    || 0);

  const mealCap = Number(mealPrices.meal_cap) || 0;
  const mealCost = mealCap > 0 ? Math.min(rawMealCost, mealCap) : rawMealCost;

  const itemTotal  = totals.reduce((s, r) => s + (r.subtotal || 0), 0);
  const grandTotal = itemTotal + mealCost;

  res.json({ totals, mealTotals, mealPrices, rawMealCost, mealCost, mealCap, itemTotal, grandTotal });
});

module.exports = router;
