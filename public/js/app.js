// ============================================================
// 認証
// ============================================================
let currentUser = null;

async function initAuth() {
  const res = await fetch('/api/auth/me');
  if (res.ok) {
    currentUser = await res.json();
    onLoggedIn();
  } else {
    showLoginOverlay();
  }
}

function showLoginOverlay() {
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('login-username').focus();
  document.getElementById('login-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });
}

async function doLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');

  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (res.ok) {
    currentUser = await res.json();
    document.getElementById('login-overlay').classList.add('hidden');
    onLoggedIn();
  } else {
    const data = await res.json();
    errEl.textContent = data.error || 'ログインに失敗しました';
    errEl.classList.remove('hidden');
  }
}

async function doLogout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  currentUser = null;
  location.reload();
}

function onLoggedIn() {
  document.getElementById('header-username').textContent = `${currentUser.username}（${roleName(currentUser.role)}）`;
  setupRoleUI();
  const defaultPage = currentUser.role === 'viewer' ? 'summary' : 'input';
  showPage(defaultPage);
}

function roleName(role) {
  return { admin: '管理者', staff: '一般スタッフ', viewer: '閲覧のみ' }[role] ?? role;
}

function setupRoleUI() {
  const role = currentUser.role;
  // 日次入力：viewer は非表示
  document.getElementById('nav-input').classList.toggle('hidden', role === 'viewer');
  // マスタ管理：admin のみ
  document.getElementById('nav-master').classList.toggle('hidden', role !== 'admin');
}

// --- ページ切り替え ---
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + name).classList.remove('hidden');
  document.getElementById('nav-' + name)?.classList.add('active');
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
    `<th class="col-item">${item.name}<br><span class="item-price-sub">${item.unit_price.toLocaleString()}円</span></th>`
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
      <td><input type="text" class="cell-input svc-input" value="${meal.service_status||''}"
           data-date="${dateStr}" data-meal="service_status"></td>
      <td><input type="number" min="0" class="cell-input" value="${meal.hospital_addition||''}"
           data-date="${dateStr}" data-meal="hospital_addition"></td>
      <td><input type="number" min="0" class="cell-input" value="${meal.hospital_special||''}"
           data-date="${dateStr}" data-meal="hospital_special"></td>
      <td><input type="number" min="0" class="cell-input meal-input" value="${meal.breakfast||''}"
           data-date="${dateStr}" data-meal="breakfast"></td>
      <td><input type="number" min="0" class="cell-input meal-input" value="${meal.lunch||''}"
           data-date="${dateStr}" data-meal="lunch"></td>
      <td><input type="number" min="0" class="cell-input meal-input" value="${meal.dinner||''}"
           data-date="${dateStr}" data-meal="dinner"></td>
      ${itemCells}
    </tr>`;
  }).join('');

  // 食事単価を取得
  const mealPrices = await api(`/meal-prices?patient_id=${patientId}&year=${year}&month=${month}`);

  // 小計行（初期値）
  const initMealTotals = { hospital_addition: 0, hospital_special: 0, breakfast: 0, lunch: 0, dinner: 0 };
  for (const m of Object.values(mealMap)) {
    for (const f of Object.keys(initMealTotals)) initMealTotals[f] += Number(m[f]) || 0;
  }
  const initItemTotals = {};
  for (const item of activeItems) {
    initItemTotals[item.id] = Object.values(recMap).reduce((s, d) => s + (Number(d[item.id]) || 0), 0);
  }

  const totalItemCells = activeItems.map(item =>
    `<td class="num subtotal-cell" id="tot-item-${item.id}">${initItemTotals[item.id] || ''}</td>`
  ).join('');

  const initMealCost =
    initMealTotals.breakfast * (mealPrices.breakfast_price || 0) +
    initMealTotals.lunch     * (mealPrices.lunch_price    || 0) +
    initMealTotals.dinner    * (mealPrices.dinner_price   || 0);

  const initItemCost = activeItems.reduce((sum, item) =>
    sum + (initItemTotals[item.id] || 0) * (item.unit_price || 0), 0);

  document.getElementById('input-form').innerHTML = `
    <div class="monthly-card">
      <div class="monthly-header">
        <span class="monthly-title">${year}年${Number(month)}月　実績入力</span>
        <button onclick="saveAllRecords()" class="btn-primary">一括保存</button>
      </div>
      <div class="meal-price-bar">
        <span class="meal-price-label">食事単価（この患者・この月）</span>
        <label>朝食 <input type="number" min="0" id="mp-breakfast" value="${mealPrices.breakfast_price||''}" placeholder="0"> 円</label>
        <label>昼食 <input type="number" min="0" id="mp-lunch"     value="${mealPrices.lunch_price||''}"     placeholder="0"> 円</label>
        <label>夕食 <input type="number" min="0" id="mp-dinner"    value="${mealPrices.dinner_price||''}"    placeholder="0"> 円</label>
        <label>食事費上限 <input type="number" min="0" id="mp-cap" value="${mealPrices.meal_cap||''}" placeholder="上限なし" style="width:90px"> 円</label>
        <button onclick="saveMealPrices('${patientId}','${year}','${month}')" class="btn-sm">単価保存</button>
        <span class="item-cost-disp">日用品費合計：<strong id="item-cost-total">${initItemCost.toLocaleString()}</strong> 円</span>
        <span class="meal-cost-disp">食事費合計：<strong id="meal-cost-total">${initMealCost.toLocaleString()}</strong> 円<span id="meal-cap-label" class="cap-label"></span></span>
      </div>
      <div class="table-scroll">
        <table class="monthly-table" id="monthly-tbl">
          <thead>
            <tr>
              <th class="col-day">日</th>
              <th class="col-dow">曜</th>
              <th class="col-svc">サービス提供の状況</th>
              <th class="col-hadd">入院・外泊時加算</th>
              <th class="col-hadd">入院時支援特別加算</th>
              <th class="col-meal">朝食</th>
              <th class="col-meal">昼食</th>
              <th class="col-meal">夕食</th>
              ${itemHeaders}
            </tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr class="subtotal-row">
              <td colspan="2" class="subtotal-label">小　計</td>
              <td class="subtotal-cell"></td>
              <td class="num subtotal-cell" id="tot-hadd">${initMealTotals.hospital_addition || ''}</td>
              <td class="num subtotal-cell" id="tot-hsp">${initMealTotals.hospital_special || ''}</td>
              <td class="num subtotal-cell" id="tot-breakfast">${initMealTotals.breakfast || ''}</td>
              <td class="num subtotal-cell" id="tot-lunch">${initMealTotals.lunch || ''}</td>
              <td class="num subtotal-cell" id="tot-dinner">${initMealTotals.dinner || ''}</td>
              ${totalItemCells}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>`;

  // 入力のたびに小計を再計算
  document.getElementById('monthly-tbl').addEventListener('input', () => updateSubtotals(activeItems));

  // Enterキーで次の入力欄へ移動
  document.getElementById('monthly-tbl').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const inputs = [...document.querySelectorAll('#monthly-tbl .cell-input')];
    const idx = inputs.indexOf(e.target);
    if (idx >= 0 && idx < inputs.length - 1) inputs[idx + 1].focus();
  });

  // 食事単価・上限変更時に食事費合計を即時更新
  ['mp-breakfast', 'mp-lunch', 'mp-dinner', 'mp-cap'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', updateMealCostTotal);
  });

  // 初期表示で上限ラベルを更新
  updateMealCostTotal();
}

function updateSubtotals(activeItems) {
  const mealFields = ['hospital_addition', 'hospital_special', 'breakfast', 'lunch', 'dinner'];
  const mealIds    = ['tot-hadd', 'tot-hsp', 'tot-breakfast', 'tot-lunch', 'tot-dinner'];

  mealFields.forEach((field, i) => {
    let sum = 0;
    document.querySelectorAll(`[data-meal="${field}"]`).forEach(el => { sum += Number(el.value) || 0; });
    document.getElementById(mealIds[i]).textContent = sum || '';
  });

  let itemCostTotal = 0;
  for (const item of activeItems) {
    let sum = 0;
    document.querySelectorAll(`[data-item="${item.id}"]`).forEach(el => { sum += Number(el.value) || 0; });
    const cell = document.getElementById(`tot-item-${item.id}`);
    if (cell) cell.textContent = sum || '';
    itemCostTotal += sum * (item.unit_price || 0);
  }
  const itemCostEl = document.getElementById('item-cost-total');
  if (itemCostEl) itemCostEl.textContent = itemCostTotal.toLocaleString();

  updateMealCostTotal();
}

function updateMealCostTotal() {
  const bPrice = Number(document.getElementById('mp-breakfast')?.value) || 0;
  const lPrice = Number(document.getElementById('mp-lunch')?.value)     || 0;
  const dPrice = Number(document.getElementById('mp-dinner')?.value)    || 0;
  const cap    = Number(document.getElementById('mp-cap')?.value)       || 0;

  const bCount = Number(document.getElementById('tot-breakfast')?.textContent) || 0;
  const lCount = Number(document.getElementById('tot-lunch')?.textContent)     || 0;
  const dCount = Number(document.getElementById('tot-dinner')?.textContent)    || 0;

  const rawCost = bCount * bPrice + lCount * lPrice + dCount * dPrice;
  const cost = cap > 0 ? Math.min(rawCost, cap) : rawCost;

  const el = document.getElementById('meal-cost-total');
  if (el) el.textContent = cost.toLocaleString();

  const capLabel = document.getElementById('meal-cap-label');
  if (capLabel) capLabel.textContent = (cap > 0 && rawCost > cap) ? '（上限適用）' : '';
}

async function saveMealPrices(patientId, year, month) {
  await api('/meal-prices', { method: 'POST', body: {
    patient_id: Number(patientId),
    year: Number(year),
    month: Number(month),
    breakfast_price: Number(document.getElementById('mp-breakfast').value) || 0,
    lunch_price:     Number(document.getElementById('mp-lunch').value)     || 0,
    dinner_price:    Number(document.getElementById('mp-dinner').value)    || 0,
    meal_cap:        Number(document.getElementById('mp-cap').value)       || 0,
  }});
  updateMealCostTotal();
  showToast('食事単価を保存しました');
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
    byDate[date].meal[field] = field === 'service_status' ? el.value : (Number(el.value) || 0);
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
    <th>朝食回数</th><th>昼食回数</th><th>夕食回数</th>
    <th>食事費合計</th><th>日用品費合計</th><th>合計金額</th><th>PDF</th>
  </tr>`;

  const tbody = summaries.map(s => `
    <tr>
      <td>${s.ward_name}</td>
      <td>${s.name}</td>
      <td class="num">${s.mealTotals?.breakfast||0}</td>
      <td class="num">${s.mealTotals?.lunch||0}</td>
      <td class="num">${s.mealTotals?.dinner||0}</td>
      <td class="num">${(s.mealCost||0).toLocaleString()} 円</td>
      <td class="num">${(s.itemTotal||0).toLocaleString()} 円</td>
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
let selectedMasterWardId = null;

function showMasterTab(name) {
  document.querySelectorAll('.master-tab').forEach(t => t.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('master-' + name).classList.remove('hidden');
  document.getElementById('mtab-' + name).classList.add('active');
  if (name === 'patients') renderMasterPatients();
  if (name === 'items')    renderMasterItems();
  if (name === 'prices')   renderMasterPrices();
  if (name === 'users')    renderMasterUsers();
}

async function initMasterPage() {
  showMasterTab('patients');
}

// --- 患者管理 ---
async function renderMasterPatients() {
  const [wards, patients] = await Promise.all([api('/wards'), api('/patients')]);
  const wardBtns = wards.map(w => `
    <button class="ward-btn ${selectedMasterWardId==w.id?'active':''}"
            onclick="selectMasterWard(${w.id})">${w.name}</button>
  `).join('');

  const filtered = selectedMasterWardId
    ? patients.filter(p => p.ward_id == selectedMasterWardId)
    : [];

  const rows = filtered.map(p => `
    <tr>
      <td><select onchange="updatePatient(${p.id},'ward_id',this.value)">${
        wards.map(w=>`<option value="${w.id}" ${w.id==p.ward_id?'selected':''}>${w.name}</option>`).join('')
      }</select></td>
      <td><input value="${p.name}" onblur="updatePatient(${p.id},'name',this.value)"></td>
      <td><input value="${p.room||''}" onblur="updatePatient(${p.id},'room',this.value)" style="width:60px"></td>
      <td><input value="${p.beneficiary_no||''}" onblur="updatePatient(${p.id},'beneficiary_no',this.value)"></td>
      <td><label><input type="checkbox" ${p.active?'checked':''} onchange="updatePatient(${p.id},'active',this.checked?1:0)"> 有効</label></td>
      <td><button onclick="deletePatient(${p.id},'${p.name.replace(/'/g,'&#39;')}')" class="btn-danger">削除</button></td>
    </tr>`).join('');

  const mainContent = selectedMasterWardId ? `
    <div class="add-row" style="justify-content:flex-end">
      <input id="new-p-name" placeholder="氏名" style="width:120px">
      <input id="new-p-room" placeholder="部屋" style="width:60px">
      <input id="new-p-bno"  placeholder="受給者証番号" style="width:120px">
      <button onclick="addPatient()" class="btn-primary">追加</button>
    </div>
    <table class="master-table">
      <thead><tr><th>病棟</th><th>氏名</th><th>部屋</th><th>受給者証番号</th><th>状態</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>` : '<p class="no-patient">病棟を選択してください</p>';

  document.getElementById('master-patients').innerHTML = `
    <div class="input-layout">
      <div class="input-sidebar">
        <div class="ward-buttons">${wardBtns}</div>
      </div>
      <div class="input-main">${mainContent}</div>
    </div>`;
}

function selectMasterWard(wardId) {
  selectedMasterWardId = selectedMasterWardId == wardId ? null : wardId;
  renderMasterPatients();
}

async function updatePatient(id, field, value) {
  const patients = await api('/patients');
  const p = patients.find(x => x.id == id);
  if (!p) return;
  p[field] = value;
  await api(`/patients/${id}`, { method: 'PUT', body: p });
}

async function deletePatient(id, name) {
  if (!confirm(`「${name}」を削除しますか？\nこの患者の全実績データも削除されます。`)) return;
  await api(`/patients/${id}`, { method: 'DELETE' });
  renderMasterPatients();
}

async function addPatient() {
  const name           = document.getElementById('new-p-name').value.trim();
  const room           = document.getElementById('new-p-room').value.trim();
  const beneficiary_no = document.getElementById('new-p-bno').value.trim();
  if (!name) return alert('氏名を入力してください');
  await api('/patients', { method: 'POST', body: { ward_id: selectedMasterWardId, name, room, beneficiary_no } });
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
      <td><button onclick="deleteItem(${item.id},'${item.name.replace(/'/g,'&#39;')}')" class="btn-danger">削除</button></td>
    </tr>`).join('');

  document.getElementById('master-items').innerHTML = `
    <div class="add-row" style="justify-content:flex-end">
      <input id="new-item-name" placeholder="物品名" style="width:150px">
      <button onclick="addItem()" class="btn-primary">追加</button>
    </div>
    <table class="master-table">
      <thead><tr><th>順序</th><th>物品名</th><th>状態</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function updateItem(id, field, value) {
  const items = await api('/items');
  const item = items.find(x => x.id == id);
  if (!item) return;
  item[field] = value;
  await api(`/items/${id}`, { method: 'PUT', body: item });
}

async function deleteItem(id, name) {
  if (!confirm(`「${name}」を削除しますか？\nこの物品の全実績データも削除されます。`)) return;
  await api(`/items/${id}`, { method: 'DELETE' });
  renderMasterItems();
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

// --- ユーザー管理 ---
async function renderMasterUsers() {
  const users = await api('/users');
  const roleOpts = (cur) => ['admin','staff','viewer'].map(r =>
    `<option value="${r}" ${r===cur?'selected':''}>${roleName(r)}</option>`
  ).join('');

  const rows = users.map(u => `
    <tr>
      <td><input id="u-name-${u.id}" value="${u.username}" style="width:110px"></td>
      <td><select id="u-role-${u.id}">${roleOpts(u.role)}</select></td>
      <td><input type="password" id="u-pass-${u.id}" placeholder="変更する場合のみ入力" style="width:150px"></td>
      <td><label><input type="checkbox" id="u-active-${u.id}" ${u.active?'checked':''}> 有効</label></td>
      <td><button onclick="saveUser(${u.id})" class="btn-sm btn-register">登録</button></td>
      <td><button onclick="deleteUser(${u.id},'${u.username.replace(/'/g,'&#39;')}')" class="btn-danger">削除</button></td>
    </tr>`).join('');

  document.getElementById('master-users').innerHTML = `
    <div class="add-row" style="justify-content:flex-end">
      <input id="new-u-name" placeholder="ユーザーID" style="width:120px">
      <input type="password" id="new-u-pass" placeholder="パスワード" style="width:120px">
      <select id="new-u-role">${roleOpts('staff')}</select>
      <button onclick="addUser()" class="btn-primary">追加</button>
    </div>
    <table class="master-table">
      <thead><tr><th>ユーザーID</th><th>ロール</th><th>パスワード（変更する場合のみ入力）</th><th>状態</th><th>操作</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function saveUser(id) {
  const username = document.getElementById(`u-name-${id}`).value.trim();
  const password = document.getElementById(`u-pass-${id}`).value;
  const role     = document.getElementById(`u-role-${id}`).value;
  const active   = document.getElementById(`u-active-${id}`).checked ? 1 : 0;
  if (!username) return alert('ユーザーIDを入力してください');

  const body = { username, role, active };
  if (password) body.password = password;

  await api(`/users/${id}`, { method: 'PUT', body });
  document.getElementById(`u-pass-${id}`).value = '';
  showToast(`「${username}」の情報を更新しました`);
}

async function deleteUser(id, username) {
  if (!confirm(`ユーザー「${username}」を削除しますか？`)) return;
  const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
  if (!res.ok) { const d = await res.json(); return alert(d.error); }
  renderMasterUsers();
}

async function addUser() {
  const username = document.getElementById('new-u-name').value.trim();
  const password = document.getElementById('new-u-pass').value;
  const role     = document.getElementById('new-u-role').value;
  if (!username || !password) return alert('ユーザーIDとパスワードを入力してください');
  await api('/users', { method: 'POST', body: { username, password, role } });
  renderMasterUsers();
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

// 初期表示（認証確認）
initAuth();
