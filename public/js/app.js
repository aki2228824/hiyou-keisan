// --- ページ切り替え ---
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + name).classList.remove('hidden');
  document.getElementById('nav-' + name).classList.add('active');
  if (name === 'input') initInputPage();
  if (name === 'summary') initSummaryPage();
  if (name === 'master') initMasterPage();
}

// --- API ヘルパー ---
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json();
}

// ============================================================
// 日次入力
// ============================================================
let selectedWardId    = null;
let selectedPatientId = null;

const DOW = ['日','月','火','水','木','金','土'];

async function initInputPage() {
  const wards = await api('/wards');

  const now = new Date();
  const defaultMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  if (!document.getElementById('sel-month').value)
    document.getElementById('sel-month').value = defaultMonth;

  document.getElementById('ward-buttons').innerHTML = wards.map(w => `
    <button class="ward-btn ${selectedWardId==w.id?'active':''}"
            onclick="selectWard(${w.id})">${w.name}</button>
  `).join('');

  if (selectedWardId) await loadPatients();
}

async function selectWard(wardId) {
  selectedWardId = wardId;
  selectedPatientId = null;
  document.getElementById('input-form').innerHTML = '';
  document.querySelectorAll('.ward-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.ward-btn[onclick="selectWard(${wardId})"]`).classList.add('active');
  await loadPatients();
}

async function loadPatients() {
  if (!selectedWardId) return;
  const patients = await api('/patients?ward_id=' + selectedWardId);
  const active = patients.filter(p => p.active);

  document.getElementById('patient-list').innerHTML = active.length
    ? active.map(p => `
        <button class="patient-btn ${selectedPatientId==p.id?'active':''}"
                onclick="selectPatient(${p.id})">${p.name}</button>
      `).join('')
    : '<p class="no-patient">患者が登録されていません</p>';
}

async function selectPatient(patientId) {
  selectedPatientId = patientId;
  document.querySelectorAll('.patient-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.patient-btn[onclick="selectPatient(${patientId})"]`).classList.add('active');
  await loadInputForm();
}

async function loadInputForm() {
  const patientId = selectedPatientId;
  const ym = document.getElementById('sel-month').value;
  if (!patientId || !ym) return;

  const [year, month] = ym.split('-');
  const [itemsWithPrices, existing] = await Promise.all([
    api(`/items/prices?year=${year}&month=${month}`),
    api(`/records?patient_id=${patientId}&year=${year}&month=${month}`)
  ]);

  const activeItems = itemsWithPrices.filter(i => i.active);

  // 既存データをマップ化
  const recMap = {};   // recMap[date][item_id] = quantity
  for (const r of existing.records) {
    if (!recMap[r.record_date]) recMap[r.record_date] = {};
    recMap[r.record_date][r.item_id] = r.quantity;
  }
  const mealMap = {};  // mealMap[date] = {breakfast, lunch, dinner, note}
  for (const m of existing.meals) mealMap[m.record_date] = m;

  // 月の日数
  const daysInMonth = new Date(year, month, 0).getDate();
  const days = Array.from({ length: daysInMonth }, (_, i) => {
    const d = i + 1;
    const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dow = new Date(dateStr).getDay();
    return { d, dateStr, dow };
  });

  // ヘッダー
  const itemHeaders = activeItems.map(item =>
    `<th class="col-item" title="${item.unit_price.toLocaleString()}円">${item.name}</th>`
  ).join('');

  // 行
  const rows = days.map(({ d, dateStr, dow }) => {
    const meal = mealMap[dateStr] || {};
    const isWeekend = dow === 0 || dow === 6;
    const itemCells = activeItems.map(item => {
      const val = recMap[dateStr]?.[item.id] ?? 0;
      return `<td><input type="number" min="0" class="cell-input" value="${val||''}"
               data-date="${dateStr}" data-item="${item.id}"></td>`;
    }).join('');
    return `<tr class="${isWeekend?'weekend':''}">
      <td class="col-day">${d}</td>
      <td class="col-dow ${dow===0?'sun':dow===6?'sat':''}">${DOW[dow]}</td>
      <td><input type="number" min="0" max="1" class="cell-input meal-input" value="${meal.breakfast??''}"
           data-date="${dateStr}" data-meal="breakfast" placeholder="0"></td>
      <td><input type="number" min="0" max="1" class="cell-input meal-input" value="${meal.lunch??''}"
           data-date="${dateStr}" data-meal="lunch" placeholder="0"></td>
      <td><input type="number" min="0" max="1" class="cell-input meal-input" value="${meal.dinner??''}"
           data-date="${dateStr}" data-meal="dinner" placeholder="0"></td>
      <td><input type="text" class="cell-input note-input" value="${meal.note??''}"
           data-date="${dateStr}" data-meal="note"></td>
      ${itemCells}
    </tr>`;
  }).join('');

  document.getElementById('input-form').innerHTML = `
    <div class="monthly-card">
      <div class="monthly-header">
        <span class="monthly-title">${year}年${Number(month)}月　実績入力</span>
        <button onclick="saveAllRecords()" class="btn-primary">一括保存</button>
      </div>
      <div class="table-scroll">
        <table class="monthly-table">
          <thead>
            <tr>
              <th class="col-day">日</th>
              <th class="col-dow">曜</th>
              <th class="col-meal">朝</th>
              <th class="col-meal">昼</th>
              <th class="col-meal">夕</th>
              <th class="col-note">備考</th>
              ${itemHeaders}
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

async function saveAllRecords() {
  const patientId = selectedPatientId;
  if (!patientId) return;

  // 日付ごとにまとめる
  const byDate = {};

  document.querySelectorAll('.cell-input[data-item]').forEach(el => {
    const date = el.dataset.date;
    const itemId = Number(el.dataset.item);
    const qty = Number(el.value) || 0;
    if (!byDate[date]) byDate[date] = { items: [], meal: {} };
    byDate[date].items.push({ item_id: itemId, quantity: qty });
  });

  document.querySelectorAll('.cell-input[data-meal]').forEach(el => {
    const date = el.dataset.date;
    const field = el.dataset.meal;
    if (!byDate[date]) byDate[date] = { items: [], meal: {} };
    byDate[date].meal[field] = field === 'note' ? el.value : (Number(el.value) || 0);
  });

  for (const [date, data] of Object.entries(byDate)) {
    await api('/records', { method: 'POST', body: {
      patient_id: patientId,
      record_date: date,
      items: data.items,
      meal: data.meal,
    }});
  }
  showToast('保存しました');
}

// ============================================================
// 月次集計
// ============================================================
async function initSummaryPage() {
  const wards = await api('/wards');
  const sel = document.getElementById('sum-ward');
  const cur = sel.value;
  sel.innerHTML = '<option value="">病棟を選択</option>' +
    wards.map(w => `<option value="${w.id}" ${w.id==cur?'selected':''}>${w.name}</option>`).join('');

  if (!document.getElementById('sum-month').value) {
    const now = new Date();
    document.getElementById('sum-month').value =
      `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  }
}

async function loadSummaryPatients() { /* ward変更時 */ }

async function loadSummary() {
  const wardId = document.getElementById('sum-ward').value;
  const ym     = document.getElementById('sum-month').value;
  if (!ym) return;
  const [year, month] = ym.split('-');

  let patients = await api('/patients' + (wardId ? `?ward_id=${wardId}` : ''));
  patients = patients.filter(p => p.active);

  const summaries = await Promise.all(patients.map(p =>
    api(`/records/summary?patient_id=${p.id}&year=${year}&month=${month}`)
      .then(s => ({ ...p, ...s }))
  ));

  const thead = `<tr>
    <th>病棟</th><th>患者名</th>
    <th>朝食</th><th>昼食</th><th>夕食</th>
    <th>日用品費合計</th><th>PDF</th>
  </tr>`;

  const tbody = summaries.map(s => `
    <tr>
      <td>${s.ward_name}</td>
      <td>${s.name}</td>
      <td class="num">${s.mealTotals?.breakfast||0}</td>
      <td class="num">${s.mealTotals?.lunch||0}</td>
      <td class="num">${s.mealTotals?.dinner||0}</td>
      <td class="num grand">${(s.grandTotal||0).toLocaleString()} 円</td>
      <td><a class="pdf-btn" href="/api/pdf?patient_id=${s.id}&year=${year}&month=${month}" target="_blank">PDF</a></td>
    </tr>`).join('');

  document.getElementById('summary-table').innerHTML = `
    <div class="summary-wrap">
      <table class="summary-table">
        <thead>${thead}</thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>`;
}

// ============================================================
// マスタ管理
// ============================================================
function showMasterTab(name) {
  document.querySelectorAll('.master-tab').forEach(t => t.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('master-' + name).classList.remove('hidden');
  document.getElementById('mtab-' + name).classList.add('active');
  if (name === 'patients') renderMasterPatients();
  if (name === 'items')    renderMasterItems();
  if (name === 'prices')   renderMasterPrices();
}

async function initMasterPage() {
  showMasterTab('patients');
}

// --- 患者管理 ---
async function renderMasterPatients() {
  const [wards, patients] = await Promise.all([api('/wards'), api('/patients')]);
  const wardOpts = wards.map(w => `<option value="${w.id}">${w.name}</option>`).join('');

  const rows = patients.map(p => `
    <tr>
      <td><select onchange="updatePatient(${p.id},'ward_id',this.value)">${
        wards.map(w=>`<option value="${w.id}" ${w.id==p.ward_id?'selected':''}>${w.name}</option>`).join('')
      }</select></td>
      <td><input value="${p.name}" onblur="updatePatient(${p.id},'name',this.value)"></td>
      <td><input value="${p.room||''}" onblur="updatePatient(${p.id},'room',this.value)" style="width:60px"></td>
      <td><input value="${p.beneficiary_no||''}" onblur="updatePatient(${p.id},'beneficiary_no',this.value)"></td>
      <td><label><input type="checkbox" ${p.active?'checked':''} onchange="updatePatient(${p.id},'active',this.checked?1:0)"> 有効</label></td>
    </tr>`).join('');

  document.getElementById('master-patients').innerHTML = `
    <table class="master-table">
      <thead><tr><th>病棟</th><th>氏名</th><th>部屋</th><th>受給者証番号</th><th>状態</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="add-row">
      <select id="new-p-ward">${wardOpts}</select>
      <input id="new-p-name" placeholder="氏名" style="width:120px">
      <input id="new-p-room" placeholder="部屋" style="width:60px">
      <input id="new-p-bno"  placeholder="受給者証番号" style="width:120px">
      <button onclick="addPatient()" class="btn-primary">追加</button>
    </div>`;
}

async function updatePatient(id, field, value) {
  const patients = await api('/patients');
  const p = patients.find(x => x.id == id);
  if (!p) return;
  p[field] = value;
  await api(`/patients/${id}`, { method: 'PUT', body: p });
}

async function addPatient() {
  const ward_id      = document.getElementById('new-p-ward').value;
  const name         = document.getElementById('new-p-name').value.trim();
  const room         = document.getElementById('new-p-room').value.trim();
  const beneficiary_no = document.getElementById('new-p-bno').value.trim();
  if (!name) return alert('氏名を入力してください');
  await api('/patients', { method: 'POST', body: { ward_id, name, room, beneficiary_no } });
  renderMasterPatients();
}

// --- 物品管理 ---
async function renderMasterItems() {
  const items = await api('/items');
  const rows = items.map(item => `
    <tr>
      <td><input type="number" value="${item.sort_order}" style="width:50px"
           onblur="updateItem(${item.id},'sort_order',this.value)"></td>
      <td><input value="${item.name}" onblur="updateItem(${item.id},'name',this.value)"></td>
      <td><label><input type="checkbox" ${item.active?'checked':''} onchange="updateItem(${item.id},'active',this.checked?1:0)"> 有効</label></td>
    </tr>`).join('');

  document.getElementById('master-items').innerHTML = `
    <table class="master-table">
      <thead><tr><th>順序</th><th>物品名</th><th>状態</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="add-row">
      <input id="new-item-name" placeholder="物品名" style="width:150px">
      <button onclick="addItem()" class="btn-primary">追加</button>
    </div>`;
}

async function updateItem(id, field, value) {
  const items = await api('/items');
  const item = items.find(x => x.id == id);
  if (!item) return;
  item[field] = value;
  await api(`/items/${id}`, { method: 'PUT', body: item });
}

async function addItem() {
  const name = document.getElementById('new-item-name').value.trim();
  if (!name) return alert('物品名を入力してください');
  await api('/items', { method: 'POST', body: { name } });
  renderMasterItems();
}

// --- 単価設定 ---
async function renderMasterPrices() {
  const now = new Date();
  const defaultYM = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;

  document.getElementById('master-prices').innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px">
      <label>対象年月：<input type="month" id="price-ym" value="${defaultYM}"></label>
      <button onclick="loadPriceTable()" class="btn-secondary">表示</button>
      <button onclick="savePrices()" class="btn-success">一括保存</button>
    </div>
    <div id="price-table"></div>`;

  loadPriceTable();
}

async function loadPriceTable() {
  const ym = document.getElementById('price-ym').value;
  if (!ym) return;
  const [year, month] = ym.split('-');
  const items = await api(`/items/prices?year=${year}&month=${month}`);

  const rows = items.map(item => `
    <tr>
      <td>${item.name} ${item.active?'':'<span class="badge-inactive">（無効）</span>'}</td>
      <td><input type="number" min="0" value="${item.unit_price}"
           id="price-${item.id}" data-id="${item.id}" style="width:90px;text-align:right"> 円</td>
    </tr>`).join('');

  document.getElementById('price-table').innerHTML = `
    <table class="master-table">
      <thead><tr><th>物品名</th><th>単価</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function savePrices() {
  const ym = document.getElementById('price-ym').value;
  const [year, month] = ym.split('-');
  const inputs = document.querySelectorAll('#price-table [data-id]');
  for (const el of inputs) {
    await api('/items/prices', { method: 'POST', body: {
      item_id: Number(el.dataset.id), year: Number(year), month: Number(month),
      unit_price: Number(el.value) || 0
    }});
  }
  showToast('単価を保存しました');
}

// ============================================================
// ユーティリティ
// ============================================================
function showToast(msg) {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#28a745;color:white;padding:10px 20px;border-radius:6px;font-size:14px;z-index:200;';
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden');
}

// 初期表示
showPage('input');
