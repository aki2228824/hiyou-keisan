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
async function initInputPage() {
  const wards = await api('/wards');
  const sel = document.getElementById('sel-ward');
  const cur = sel.value;
  sel.innerHTML = '<option value="">病棟を選択</option>' +
    wards.map(w => `<option value="${w.id}" ${w.id==cur?'selected':''}>${w.name}</option>`).join('');

  const today = new Date().toISOString().slice(0,10);
  if (!document.getElementById('sel-date').value)
    document.getElementById('sel-date').value = today;

  if (cur) await loadPatients();
}

async function loadPatients() {
  const wardId = document.getElementById('sel-ward').value;
  if (!wardId) return;
  const patients = await api('/patients?ward_id=' + wardId);
  const sel = document.getElementById('sel-patient');
  const cur = sel.value;
  sel.innerHTML = '<option value="">患者を選択</option>' +
    patients.filter(p=>p.active).map(p =>
      `<option value="${p.id}" ${p.id==cur?'selected':''}>${p.name}</option>`
    ).join('');
}

async function loadInputForm() {
  const patientId = document.getElementById('sel-patient').value;
  const date      = document.getElementById('sel-date').value;
  if (!patientId || !date) return;

  const [y, m] = date.split('-');
  const [itemsWithPrices, existing] = await Promise.all([
    api(`/items/prices?year=${y}&month=${m}`),
    api(`/records?patient_id=${patientId}&year=${y}&month=${m}`)
  ]);

  const recMap = {};
  for (const r of existing.records) {
    if (r.record_date === date) recMap[r.item_id] = r.quantity;
  }
  const meal = existing.meals.find(m => m.record_date === date) || {};

  const activeItems = itemsWithPrices.filter(i => i.active);

  const itemsHtml = activeItems.map(item => `
    <div class="item-cell">
      <label>${item.name}</label>
      <span class="price-hint">${item.unit_price.toLocaleString()}円/回</span>
      <input type="number" min="0" value="${recMap[item.id] ?? 0}"
             id="item-${item.id}" data-id="${item.id}">
    </div>`).join('');

  document.getElementById('input-form').innerHTML = `
    <div class="input-card">
      <h2>${date} の実績入力</h2>
      <div class="meal-section">
        <strong>食事回数：</strong>
        <label>朝 <input type="number" min="0" max="1" id="m-breakfast" value="${meal.breakfast??0}"></label>
        <label>昼 <input type="number" min="0" max="1" id="m-lunch" value="${meal.lunch??0}"></label>
        <label>夕 <input type="number" min="0" max="1" id="m-dinner" value="${meal.dinner??0}"></label>
        <label>備考 <input type="text" id="m-note" value="${meal.note??''}" style="width:100px"></label>
      </div>
      <div class="items-grid">${itemsHtml}</div>
      <div class="save-row">
        <button onclick="saveRecord('${patientId}','${date}')" class="btn-primary">保存</button>
      </div>
    </div>`;
}

async function saveRecord(patientId, date) {
  const items = [...document.querySelectorAll('[data-id]')].map(el => ({
    item_id: Number(el.dataset.id),
    quantity: Number(el.value) || 0
  }));
  const meal = {
    breakfast: Number(document.getElementById('m-breakfast').value)||0,
    lunch:     Number(document.getElementById('m-lunch').value)||0,
    dinner:    Number(document.getElementById('m-dinner').value)||0,
    note:      document.getElementById('m-note').value,
  };
  await api('/records', { method: 'POST', body: { patient_id: patientId, record_date: date, items, meal } });
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
