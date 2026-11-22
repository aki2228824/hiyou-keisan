const express = require('express');
const router = express.Router();
const db = require('../database');
const { getMealPrices, getMealPriceMap, toPrice, toPositiveInt, parseYearMonth, isPlainValue } = require('../services/prices');
const { requireRole } = require('../middleware/auth');

// 患者の食事単価取得（指定年月、なければ直近の設定を返す）
router.get('/', (req, res) => {
  const { patient_id, year, month } = req.query;
  if (![patient_id, year, month].every(isPlainValue))
    return res.status(400).json({ error: '検索条件の指定が正しくありません' });
  // 指定が欠けていると、DB への問い合わせが例外になり 500 を返してしまうので、先に断る
  if ([patient_id, year, month].some(v => v === undefined || v === ''))
    return res.status(400).json({ error: 'patient_id・year・month を指定してください' });

  res.json(getMealPrices(patient_id, year, month));
});

// 複数患者の食事単価を一括取得（月次集計用）
router.get('/bulk', (req, res) => {
  const { year, month } = req.query;
  if (![year, month].every(isPlainValue))
    return res.status(400).json({ error: '検索条件の指定が正しくありません' });
  if ([year, month].some(v => v === undefined || v === ''))
    return res.status(400).json({ error: 'year・month を指定してください' });
  res.json(getMealPriceMap(year, month));
});

// 単価を保存（UPSERT）※閲覧のみロールは不可
router.post('/', requireRole('admin', 'staff'), (req, res) => {
  const { patient_id, year, month, breakfast_price, lunch_price, dinner_price, meal_cap } = req.body;

  // 入力チェック（不正なリクエストは例外にせず 400 で返す）
  const pid = toPositiveInt(patient_id);
  if (pid === null) return res.status(400).json({ error: 'patient_id が正しくありません' });
  const ym = parseYearMonth(year, month);
  if (ym.error) return res.status(400).json({ error: ym.error });

  // 単価・上限は数値にそろえてから保存する（未入力は 0、数値以外は 400）
  const prices = [breakfast_price, lunch_price, dinner_price, meal_cap].map(toPrice);
  if (prices.some(v => v === null))
    return res.status(400).json({ error: '食事単価・上限は0以上の数値で指定してください' });

  // 存在しない患者への登録を防ぐ（sql.js では外部キー制約が効かないため）
  if (!db.query('SELECT id FROM patients WHERE id=?', [pid])[0])
    return res.status(404).json({ error: '患者が見つかりません' });

  db.run(`
    INSERT INTO patient_meal_prices (patient_id, year, month, breakfast_price, lunch_price, dinner_price, meal_cap)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(patient_id, year, month) DO UPDATE SET
      breakfast_price=excluded.breakfast_price,
      lunch_price=excluded.lunch_price,
      dinner_price=excluded.dinner_price,
      meal_cap=excluded.meal_cap
  `, [pid, ym.year, ym.month, ...prices]);
  res.json({ ok: true });
});

module.exports = router;
