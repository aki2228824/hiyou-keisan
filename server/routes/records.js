const express = require('express');
const router = express.Router();
const db = require('../database');
const { getItemPriceMap, getMealPrices, toCount } = require('../services/prices');
const { requireRole } = require('../middleware/auth');

// 一覧・集計の検索条件チェック。問題があればエラーメッセージを返す
function checkPeriodQuery({ patient_id, year, month }) {
  // 文字列以外（?patient_id[a]=1 のような指定で届くオブジェクトや配列）は、文字列に直さずに不正として扱う
  if ([patient_id, year, month].some(v => v != null && typeof v !== 'string' && typeof v !== 'number'))
    return '検索条件の指定が正しくありません';
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

// 数量・回数は、0〜9,999 の整数だけを受け付ける（services/prices.js の toCount。未入力は 0、読めないものは null）

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
    return res.status(400).json({ error: `${record_date} の数量は、0〜9999 の整数で入力してください（小数は使えません）` });

  // 食事・サービスの欄（1日分が1行）は、送られてきた項目だけを変える。送られてこなかった項目は、いまの値のまま残す。
  // 以前は、1つでも変えると6項目をまとめて上書きしていた。そのため、
  //  ・同じ日を2人が開いていて、片方が朝食を、もう片方が昼食を入れると、あとから保存した人の画面の値になり、先に入れた分が消えた
  //  ・項目の無い meal（{}）が届くと、その日の食事・サービスがすべて 0 と空欄で上書きされた
  const MEAL_FIELDS = ['breakfast', 'lunch', 'dinner', 'service_status', 'hospital_addition', 'hospital_special'];
  const mealGiven = {};
  if (meal) {
    for (const field of MEAL_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(meal, field) || meal[field] === undefined) continue;
      if (field === 'service_status') {
        const status = meal.service_status ?? '';
        if (typeof status !== 'string' && typeof status !== 'number')
          return res.status(400).json({ error: 'meal の内容が正しくありません' });
        mealGiven[field] = String(status);
      } else {
        const count = toCount(meal[field]);
        if (count === null)
          return res.status(400).json({ error: `${record_date} の食事回数・加算は、0〜9999 の整数で入力してください（小数は使えません）` });
        mealGiven[field] = count;
      }
    }
  }
  // 年の打ち間違い（月の欄に年を打っている途中の 0002 年など）で、ありえない年の実績が入らないようにする
  const recordYear = Number(record_date.slice(0, 4));
  if (recordYear < 2000 || recordYear > 2100)
    return res.status(400).json({ error: `日付の年が正しくありません（${record_date}）` });

  // 存在しない患者・物品への登録を防ぐ（sql.js では外部キー制約が効かないため）
  if (!db.query('SELECT id FROM patients WHERE id=?', [pid])[0])
    return res.status(404).json({ error: '患者が見つかりません' });
  const itemIds = new Set(db.query('SELECT id FROM items').map(i => i.id));
  if (rows.some(r => !itemIds.has(r.item_id)))
    return res.status(400).json({ error: '登録されていない物品が含まれています' });

  // 1日分（物品の全行＋食事）をひとまとまりで確定し、ファイルへの保存は最後の1回だけにする。
  // （以前は1行ごとにDB全体を書き出していたため、DBが大きくなると保存が極端に遅くなっていた）
  db.transaction(() => {
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

    if (Object.keys(mealGiven).length) {
      // いまの値に、送られてきた項目だけを重ねる
      const current = db.query(
        'SELECT breakfast, lunch, dinner, service_status, hospital_addition, hospital_special FROM meal_records WHERE patient_id=? AND record_date=?',
        [pid, record_date])[0] || {};
      const mealRow = MEAL_FIELDS.map(field => {
        if (field in mealGiven) return mealGiven[field];
        return field === 'service_status' ? String(current.service_status ?? '') : (Number(current[field]) || 0);
      });
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
  });

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
