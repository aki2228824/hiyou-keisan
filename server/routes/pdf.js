const express = require('express');
const router = express.Router();
const puppeteer = require('puppeteer');
const db = require('../database');

router.get('/', async (req, res) => {
  const { patient_id, year, month } = req.query;
  const from = `${year}-${String(month).padStart(2,'0')}-01`;
  const to   = `${year}-${String(month).padStart(2,'0')}-31`;

  const patient = db.query(
    'SELECT p.*, w.name as ward_name FROM patients p JOIN wards w ON p.ward_id=w.id WHERE p.id=?',
    [patient_id]
  )[0];
  if (!patient) return res.status(404).json({ error: '患者が見つかりません' });

  const items = db.query('SELECT * FROM items WHERE active=1 ORDER BY sort_order, id');

  // 単価取得
  const priceMap = {};
  for (const item of items) {
    const p = db.query(
      'SELECT unit_price FROM prices WHERE item_id=? AND year=? AND month=?',
      [item.id, year, month]
    )[0];
    priceMap[item.id] = p ? p.unit_price : 0;
  }

  // 日次実績
  const rawRecords = db.query(
    'SELECT record_date, item_id, quantity FROM records WHERE patient_id=? AND record_date BETWEEN ? AND ? ORDER BY record_date',
    [patient_id, from, to]
  );
  const recordMap = {};
  for (const r of rawRecords) {
    if (!recordMap[r.record_date]) recordMap[r.record_date] = {};
    recordMap[r.record_date][r.item_id] = r.quantity;
  }

  // 食事実績
  const mealMap = {};
  const meals = db.query(
    'SELECT record_date, breakfast, lunch, dinner, service_status, hospital_addition, hospital_special FROM meal_records WHERE patient_id=? AND record_date BETWEEN ? AND ? ORDER BY record_date',
    [patient_id, from, to]
  );
  for (const m of meals) mealMap[m.record_date] = m;

  // 月の日数を算出
  const daysInMonth = new Date(year, month, 0).getDate();
  const dayNames = ['日','月','火','水','木','金','土'];
  const days = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dow = new Date(dateStr).getDay();
    days.push({ dateStr, day: d, dow: dayNames[dow] });
  }

  // 集計
  const itemTotals = {};
  for (const item of items) itemTotals[item.id] = 0;
  for (const { dateStr } of days) {
    for (const item of items) {
      itemTotals[item.id] += recordMap[dateStr]?.[item.id] ?? 0;
    }
  }
  const grandTotal = items.reduce((s, item) => s + itemTotals[item.id] * priceMap[item.id], 0);
  const mealTotal = meals.reduce((s, m) => s + m.breakfast + m.lunch + m.dinner, 0);

  const html = buildHtml({ patient, items, priceMap, recordMap, mealMap, days, itemTotals, grandTotal, mealTotal, year, month });

  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  const pdf = await page.pdf({ format: 'A3', landscape: true, printBackground: true });
  await browser.close();

  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="seikyu_${patient_id}_${year}${month}.pdf"` });
  res.send(pdf);
});

function buildHtml({ patient, items, priceMap, recordMap, mealMap, days, itemTotals, grandTotal, mealTotal, year, month }) {
  const reiwa = year - 2018;

  const itemHeaders = items.map(i =>
    `<th class="item-h">${i.name}<br><span class="price">${priceMap[i.id].toLocaleString()}円</span></th>`
  ).join('');

  const dataRows = days.map(({ dateStr, day, dow }) => {
    const meal = mealMap[dateStr] || {};
    const itemCells = items.map(item => {
      const q = recordMap[dateStr]?.[item.id] ?? 0;
      return `<td class="num">${q || ''}</td>`;
    }).join('');
    const isWeekend = dow === '土' || dow === '日';
    return `<tr class="${isWeekend ? 'weekend' : ''}">
      <td class="center">${day}</td>
      <td class="center">${dow}</td>
      <td class="center">${meal.service_status || ''}</td>
      <td class="num">${meal.hospital_addition || ''}</td>
      <td class="num">${meal.hospital_special || ''}</td>
      <td class="num">${meal.breakfast || ''}</td>
      <td class="num">${meal.lunch || ''}</td>
      <td class="num">${meal.dinner || ''}</td>
      ${itemCells}
    </tr>`;
  }).join('');

  const totalItemCells = items.map(item => `<td class="num total">${itemTotals[item.id] || ''}</td>`).join('');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: "MS Gothic", "Meiryo", monospace; font-size: 8px; }
  .page { padding: 8mm; }
  h1 { text-align: center; font-size: 13px; margin-bottom: 4px; }
  .meta { display: flex; gap: 20px; margin-bottom: 4px; font-size: 8px; }
  .meta span { border-bottom: 1px solid #000; min-width: 80px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #666; padding: 1px 2px; white-space: nowrap; }
  th { background: #e8e8e8; text-align: center; font-size: 7px; }
  th.item-h { writing-mode: vertical-rl; text-orientation: mixed; min-width: 18px; height: 60px; }
  .price { font-size: 6px; color: #555; }
  td.num { text-align: right; }
  td.center { text-align: center; }
  tr.weekend { background: #fafafa; }
  tr:hover { background: #f0f4ff; }
  .total { font-weight: bold; background: #e8f0e8; }
  .grand-total { text-align: right; margin-top: 4px; font-size: 11px; font-weight: bold; border-top: 2px solid #000; padding-top: 3px; }
</style>
</head>
<body>
<div class="page">
  <h1>療養介護サービス提供実績記録票</h1>
  <div class="meta">
    <div>令和 <span>${reiwa}</span> 年 <span>${month}</span> 月分</div>
    <div>氏名：<span>${patient.name}</span></div>
    <div>病棟：<span>${patient.ward_name}</span></div>
    <div>部屋：<span>${patient.room || ''}</span></div>
    <div>受給者証番号：<span>${patient.beneficiary_no || ''}</span></div>
  </div>
  <table>
    <thead>
      <tr>
        <th rowspan="2">日</th>
        <th rowspan="2">曜</th>
        <th rowspan="2">サービス提供の状況</th>
        <th rowspan="2">入院・外泊時加算</th>
        <th rowspan="2">入院時支援特別加算</th>
        <th colspan="3">食事回数</th>
        ${items.map(i => `<th class="item-h" rowspan="2">${i.name}<br><span class="price">${priceMap[i.id].toLocaleString()}円</span></th>`).join('')}
      </tr>
      <tr>
        <th>朝食</th><th>昼食</th><th>夕食</th>
      </tr>
    </thead>
    <tbody>
      ${dataRows}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="5" class="center total">合　計</td>
        <td class="num total">${meals.reduce((s,m)=>s+(m.breakfast||0),0)||''}</td>
        <td class="num total">${meals.reduce((s,m)=>s+(m.lunch||0),0)||''}</td>
        <td class="num total">${meals.reduce((s,m)=>s+(m.dinner||0),0)||''}</td>
        ${totalItemCells}
      </tr>
    </tfoot>
  </table>
  <div class="grand-total">日用品費合計：${grandTotal.toLocaleString()} 円</div>
</div>
</body>
</html>`;
}

module.exports = router;
