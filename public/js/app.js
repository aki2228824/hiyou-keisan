// ============================================================
// 認証
// ============================================================
let currentUser = null;

async function initAuth() {
  let res;
  try {
    res = await fetch('/api/auth/me');
  } catch (e) {
    showLoginError('サーバーに接続できません。ネットワークとサーバーの状態を確認してください。');
    showLoginOverlay();
    return;
  }
  if (res.ok) {
    currentUser = await res.json();
    onLoggedIn();
  } else {
    showLoginOverlay();
  }
}

function showLoginError(message) {
  const errEl = document.getElementById('login-error');
  errEl.textContent = message;
  errEl.classList.remove('hidden');
}

function showLoginOverlay() {
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('login-username').focus();
  // 複数回呼ばれても二重登録にならないよう onkeydown で設定する
  document.getElementById('login-password').onkeydown = e => {
    if (e.key === 'Enter') doLogin();
  };
}

let loggingIn = false; // ログインの問い合わせ中か（二重送信の防止。失敗は1回ごとにロックまでの回数に数えられるため）

async function doLogin() {
  if (loggingIn) return;
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');

  const button = document.querySelector('#login-overlay .login-btn');
  loggingIn = true;
  if (button) button.disabled = true;
  try {
    let res;
    try {
      res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
    } catch (e) {
      showLoginError('サーバーに接続できません。ネットワークとサーバーの状態を確認してください。');
      return;
    }
    if (res.ok) {
      currentUser = await res.json();
      // パスワードが現在の基準を満たしていないときは、サーバーが注意の文を付けて返す
      const warning = currentUser.password_warning;
      delete currentUser.password_warning;
      document.getElementById('login-overlay').classList.add('hidden');
      document.getElementById('login-password').value = '';
      hideNotice();
      onLoggedIn();
      if (warning) showNotice(warning);
    } else {
      // パスワードの誤り（401）のほか、続けて失敗したときのロック（429）もここでメッセージを表示する
      const data = await res.json().catch(() => ({}));
      errEl.textContent = data.error || 'ログインに失敗しました';
      errEl.classList.remove('hidden');
    }
  } finally {
    loggingIn = false;
    if (button) button.disabled = false;
  }
}

// 画面上部のお知らせ（閉じるまで表示）
function showNotice(message) {
  document.getElementById('notice-text').textContent = message;
  document.getElementById('notice-bar').classList.remove('hidden');
}

function hideNotice() {
  document.getElementById('notice-bar').classList.add('hidden');
}

async function doLogout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (e) {
    // サーバーに届かなくても画面は読み込み直す
  }
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
// 失敗（2xx以外・通信不能）のときはサーバーのエラーメッセージを持つ Error を投げる。
// 呼び出し側で catch しなかったものは、下の unhandledrejection でまとめて画面に表示する。
async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch('/api' + path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    throw new ApiError('サーバーに接続できません。ネットワークとサーバーの状態を確認してください。', 0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(data?.error || `処理に失敗しました（エラー ${res.status}）`, res.status);
  }
  return data;
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// API エラーの共通表示。成功トーストの代わりにエラー内容を知らせる。
window.addEventListener('unhandledrejection', e => {
  if (!(e.reason instanceof ApiError)) return;
  e.preventDefault();
  if (e.reason.status === 401) {
    // セッション切れ（サーバー再起動など）→ ログイン画面へ戻す
    const overlay = document.getElementById('login-overlay');
    if (overlay.classList.contains('hidden')) {
      currentUser = null;
      showLoginError('セッションが切れました。もう一度ログインしてください。');
      showLoginOverlay();
    }
    return;
  }
  // 同じエラーを続けて何度も表示しない（閉じた直後の同一メッセージは省略）
  if (e.reason.message === lastAlert.message && Date.now() - lastAlert.closedAt < 1000) return;
  alert(e.reason.message);
  lastAlert = { message: e.reason.message, closedAt: Date.now() };
});
let lastAlert = { message: '', closedAt: 0 };

// ============================================================
// 日次入力
// ============================================================
let selectedWardId    = null;
let selectedPatientId = null;
let loadedMonth       = null;  // いま表示している入力表の対象月（月の切替を取りやめたときに戻す値）
let savingRecords     = false; // 一括保存の実行中か（二重クリック防止）

const DOW = ['日','月','火','水','木','金','土'];

// 入力表に、まだ保存していない変更があるか（変更した欄には data-dirty の印が付く）
function hasUnsavedInput() {
  return !!document.querySelector('#monthly-tbl .cell-input[data-dirty]');
}

// 未保存の変更があるときは、表を切り替える前に確認する。切り替えてよければ true
function confirmDiscardUnsaved() {
  return !hasUnsavedInput() || confirm('保存していない入力があります。\n保存せずに切り替えますか？（入力した内容は消えます）');
}

// 未保存の変更があるまま、タブを閉じる・再読み込み・ログアウトしようとしたらブラウザの確認を出す
window.addEventListener('beforeunload', e => {
  if (!hasUnsavedInput()) return;
  e.preventDefault();
  e.returnValue = '';
});

async function initInputPage() {
  const wards = await api('/wards');

  const now = new Date();
  const defaultMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  if (!document.getElementById('sel-month').value)
    document.getElementById('sel-month').value = defaultMonth;

  document.getElementById('ward-buttons').innerHTML = wards.map(w => `
    <button class="ward-btn ${selectedWardId==w.id?'active':''}"
            onclick="selectWard(${w.id})">${esc(w.name)}</button>
  `).join('');

  if (selectedWardId) await loadPatients();
}

async function selectWard(wardId) {
  if (!confirmDiscardUnsaved()) return;
  selectedWardId = wardId;
  selectedPatientId = null;
  loadedMonth = null;
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
                onclick="selectPatient(${p.id})">${esc(p.name)}</button>
      `).join('')
    : '<p class="no-patient">患者が登録されていません</p>';
}

async function selectPatient(patientId) {
  if (!confirmDiscardUnsaved()) return;
  selectedPatientId = patientId;
  loadedMonth = null; // 上で確認済みなので、loadInputForm では重ねて確認しない
  document.querySelectorAll('.patient-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.patient-btn[onclick="selectPatient(${patientId})"]`).classList.add('active');
  await loadInputForm();
}

async function loadInputForm() {
  const patientId = selectedPatientId;
  const monthEl = document.getElementById('sel-month');
  // 対象月を切り替えたとき：未保存の変更があれば確認し、取りやめるなら月の表示を元に戻す
  if (loadedMonth && monthEl.value !== loadedMonth && !confirmDiscardUnsaved()) {
    monthEl.value = loadedMonth;
    return;
  }
  const ym = monthEl.value;
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
    `<th class="col-item g-item">${esc(item.name)}<br><span class="item-price-sub">${esc(item.unit_price.toLocaleString())}円</span></th>`
  ).join('');

  // 行
  const rows = days.map(({ d, dateStr, dow }) => {
    const meal = mealMap[dateStr] || {};
    const isWeekend = dow === 0 || dow === 6;
    const itemCells = activeItems.map(item => {
      const val = recMap[dateStr]?.[item.id] ?? 0;
      return `<td class="g-item"><input type="number" min="0" class="cell-input" value="${esc(val||'')}"
               data-date="${dateStr}" data-item="${item.id}"></td>`;
    }).join('');
    return `<tr class="${isWeekend?'weekend':''}">
      <td class="col-day">${d}</td>
      <td class="col-dow ${dow===0?'sun':dow===6?'sat':''}">${DOW[dow]}</td>
      <td class="g-svc"><input type="text" class="cell-input svc-input" value="${esc(meal.service_status||'')}"
           data-date="${dateStr}" data-meal="service_status"></td>
      <td class="g-svc"><input type="number" min="0" class="cell-input" value="${esc(meal.hospital_addition||'')}"
           data-date="${dateStr}" data-meal="hospital_addition"></td>
      <td class="g-svc"><input type="number" min="0" class="cell-input" value="${esc(meal.hospital_special||'')}"
           data-date="${dateStr}" data-meal="hospital_special"></td>
      <td class="g-meal"><input type="number" min="0" class="cell-input meal-input" value="${esc(meal.breakfast||'')}"
           data-date="${dateStr}" data-meal="breakfast"></td>
      <td class="g-meal"><input type="number" min="0" class="cell-input meal-input" value="${esc(meal.lunch||'')}"
           data-date="${dateStr}" data-meal="lunch"></td>
      <td class="g-meal"><input type="number" min="0" class="cell-input meal-input" value="${esc(meal.dinner||'')}"
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
    `<td class="num subtotal-cell g-item" id="tot-item-${item.id}">${initItemTotals[item.id] || ''}</td>`
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
        <span class="monthly-title">${esc(year)}年${Number(month)}月　実績入力</span>
        <button onclick="saveAllRecords()" class="btn-primary">一括保存</button>
      </div>
      <div class="meal-price-bar">
        <span class="meal-price-label">食事単価</span>
        <label>朝食 <input type="number" min="0" id="mp-breakfast" value="${esc(mealPrices.breakfast_price||'')}" placeholder="0"> 円</label>
        <label>昼食 <input type="number" min="0" id="mp-lunch"     value="${esc(mealPrices.lunch_price||'')}"     placeholder="0"> 円</label>
        <label>夕食 <input type="number" min="0" id="mp-dinner"    value="${esc(mealPrices.dinner_price||'')}"    placeholder="0"> 円</label>
        <label>食事費上限 <input type="number" min="0" id="mp-cap" value="${esc(mealPrices.meal_cap||'')}" placeholder="上限なし" style="width:90px"> 円</label>
        <button onclick="saveMealPrices(${Number(patientId)},${Number(year)},${Number(month)})" class="btn-sm">単価保存</button>
        <span class="item-cost-disp">日用品費合計：<strong id="item-cost-total">${initItemCost.toLocaleString()}</strong> 円</span>
        <span class="meal-cost-disp">食事費合計：<strong id="meal-cost-total">${initMealCost.toLocaleString()}</strong> 円<span id="meal-cap-label" class="cap-label"></span></span>
      </div>
      <div class="table-scroll">
        <table class="monthly-table" id="monthly-tbl">
          <thead>
            <tr>
              <th class="col-day">日</th>
              <th class="col-dow">曜</th>
              <th class="col-svc g-svc">サービス提供の状況</th>
              <th class="col-hadd g-svc">入院・外泊時加算</th>
              <th class="col-hadd g-svc">入院時支援特別加算</th>
              <th class="col-meal g-meal">朝食</th>
              <th class="col-meal g-meal">昼食</th>
              <th class="col-meal g-meal">夕食</th>
              ${itemHeaders}
            </tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr class="subtotal-row">
              <td colspan="2" class="subtotal-label">小　計</td>
              <td class="subtotal-cell g-svc"></td>
              <td class="num subtotal-cell g-svc" id="tot-hadd">${initMealTotals.hospital_addition || ''}</td>
              <td class="num subtotal-cell g-svc" id="tot-hsp">${initMealTotals.hospital_special || ''}</td>
              <td class="num subtotal-cell g-meal" id="tot-breakfast">${initMealTotals.breakfast || ''}</td>
              <td class="num subtotal-cell g-meal" id="tot-lunch">${initMealTotals.lunch || ''}</td>
              <td class="num subtotal-cell g-meal" id="tot-dinner">${initMealTotals.dinner || ''}</td>
              ${totalItemCells}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>`;

  loadedMonth = ym;

  // 入力のたびに、変更した欄へ「未保存」の印を付けて小計を再計算する（保存時は印の付いた欄だけを送る）
  document.getElementById('monthly-tbl').addEventListener('input', e => {
    if (e.target.classList.contains('cell-input')) e.target.dataset.dirty = '1';
    updateSubtotals(activeItems);
  });

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
  if (!patientId || savingRecords) return;

  // 変更した欄だけを送る。
  // 表の全部の欄を送り直すと、この画面を開いた後にほかの人が保存した内容を、
  // 自分が触っていない欄の古い値で上書きして消してしまうため。
  const dirty = [...document.querySelectorAll('#monthly-tbl .cell-input[data-dirty]')];
  if (!dirty.length) { showToast('変更はありません'); return; }
  const dates = [...new Set(dirty.map(el => el.dataset.date))].sort();

  const button = document.querySelector('#input-form button[onclick="saveAllRecords()"]');
  savingRecords = true;
  if (button) { button.disabled = true; button.textContent = '保存中…'; }
  try {
    for (const date of dates) {
      const changed = dirty.filter(el => el.dataset.date === date).map(el => ({ el, sent: el.value }));
      const body = {
        patient_id: patientId,
        record_date: date,
        items: changed.filter(c => c.el.dataset.item)
          .map(c => ({ item_id: Number(c.el.dataset.item), quantity: Number(c.sent) || 0 })),
      };
      // 食事・サービスの欄は1日分が1行で保存されるので、どれかを変更した日は6欄をまとめて送る
      if (changed.some(c => c.el.dataset.meal)) {
        body.meal = {};
        document.querySelectorAll(`#monthly-tbl .cell-input[data-meal][data-date="${date}"]`).forEach(el => {
          const field = el.dataset.meal;
          body.meal[field] = field === 'service_status' ? el.value : (Number(el.value) || 0);
        });
      }
      await api('/records', { method: 'POST', body });
      // 保存できた欄から印を外す（途中で失敗した場合、残りの欄は未保存のまま再度保存できる）。
      // 送信中に打ち直された欄は、まだ保存されていないので印を残す。
      for (const c of changed) if (c.el.value === c.sent) delete c.el.dataset.dirty;
    }
    showToast('保存しました');
  } finally {
    savingRecords = false;
    if (button) { button.disabled = false; button.textContent = '一括保存'; }
  }
}

// ============================================================
// 月次集計
// ============================================================
let selectedSummaryWardId = null;

async function initSummaryPage() {
  const wards = await api('/wards');

  if (!document.getElementById('sum-month').value) {
    const now = new Date();
    document.getElementById('sum-month').value =
      `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  }

  document.getElementById('sum-ward-buttons').innerHTML = wards.map(w => `
    <button class="ward-btn ${selectedSummaryWardId==w.id?'active':''}"
            onclick="selectSummaryWard(${w.id})">${esc(w.name)}</button>
  `).join('');
}

function selectSummaryWard(wardId) {
  selectedSummaryWardId = wardId;
  document.querySelectorAll('#sum-ward-buttons .ward-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`#sum-ward-buttons .ward-btn[onclick="selectSummaryWard(${wardId})"]`).classList.add('active');
}

async function loadSummary() {
  const ym = document.getElementById('sum-month').value;
  if (!ym) return;
  const [year, month] = ym.split('-');

  let patients = await api('/patients' + (selectedSummaryWardId ? `?ward_id=${selectedSummaryWardId}` : ''));
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
      <td>${esc(s.ward_name)}</td>
      <td>${esc(s.name)}</td>
      <td class="num">${esc(s.mealTotals?.breakfast||0)}</td>
      <td class="num">${esc(s.mealTotals?.lunch||0)}</td>
      <td class="num">${esc(s.mealTotals?.dinner||0)}</td>
      <td class="num">${esc((s.mealCost||0).toLocaleString())} 円</td>
      <td class="num">${esc((s.itemTotal||0).toLocaleString())} 円</td>
      <td class="num grand">${esc((s.grandTotal||0).toLocaleString())} 円</td>
      <td><a class="pdf-btn" href="/api/pdf?patient_id=${Number(s.id)}&year=${Number(year)}&month=${Number(month)}" target="_blank">PDF</a></td>
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

// 表示中の一覧データ（削除確認で名前を引くために保持する）
let masterPatients = [];
let masterItems    = [];
let masterUsers    = [];

function showMasterTab(name) {
  document.querySelectorAll('.master-tab').forEach(t => t.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('master-' + name).classList.remove('hidden');
  document.getElementById('mtab-' + name).classList.add('active');
  if (name === 'patients') renderMasterPatients();
  if (name === 'items')    renderMasterItems();
  if (name === 'prices')   renderMasterPrices();
  if (name === 'users')    renderMasterUsers();
  if (name === 'audit')    renderMasterAudit();
}

async function initMasterPage() {
  showMasterTab('patients');
}

// --- 患者管理 ---
async function renderMasterPatients() {
  const [wards, patients] = await Promise.all([api('/wards'), api('/patients')]);
  masterPatients = patients;
  const wardBtns = wards.map(w => `
    <button class="ward-btn ${selectedMasterWardId==w.id?'active':''}"
            onclick="selectMasterWard(${w.id})">${esc(w.name)}</button>
  `).join('');

  const filtered = selectedMasterWardId
    ? patients.filter(p => p.ward_id == selectedMasterWardId)
    : [];

  const rows = filtered.map(p => `
    <tr>
      <td><select onchange="updatePatient(${p.id},'ward_id',this.value)">${
        wards.map(w=>`<option value="${w.id}" ${w.id==p.ward_id?'selected':''}>${esc(w.name)}</option>`).join('')
      }</select></td>
      <td><input value="${esc(p.name)}" onblur="updatePatient(${p.id},'name',this.value)"></td>
      <td><input value="${esc(p.room||'')}" onblur="updatePatient(${p.id},'room',this.value)" style="width:60px"></td>
      <td><input value="${esc(p.beneficiary_no||'')}" onblur="updatePatient(${p.id},'beneficiary_no',this.value)"></td>
      <td><label><input type="checkbox" ${p.active?'checked':''} onchange="updatePatient(${p.id},'active',this.checked?1:0)"> 有効</label></td>
      <td><button onclick="deletePatient(${p.id})" class="btn-danger">削除</button></td>
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
  try {
    await api(`/patients/${id}`, { method: 'PUT', body: p });
  } catch (e) {
    renderMasterPatients().catch(() => {}); // 保存できなかった入力を元の値に戻す
    throw e;
  }
}

async function deletePatient(id) {
  const name = masterPatients.find(x => x.id == id)?.name ?? '';
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
  masterItems = items;
  const rows = items.map(item => `
    <tr>
      <td><input type="number" value="${esc(item.sort_order)}" style="width:50px"
           onblur="updateItem(${item.id},'sort_order',this.value)"></td>
      <td><input value="${esc(item.name)}" onblur="updateItem(${item.id},'name',this.value)"></td>
      <td><label><input type="checkbox" ${item.active?'checked':''} onchange="updateItem(${item.id},'active',this.checked?1:0)"> 有効</label></td>
      <td><button onclick="deleteItem(${item.id})" class="btn-danger">削除</button></td>
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
  try {
    await api(`/items/${id}`, { method: 'PUT', body: item });
  } catch (e) {
    renderMasterItems().catch(() => {}); // 保存できなかった入力を元の値に戻す
    throw e;
  }
}

async function deleteItem(id) {
  const name = masterItems.find(x => x.id == id)?.name ?? '';
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
      <td>${esc(item.name)} ${item.active?'':'<span class="badge-inactive">（無効）</span>'}</td>
      <td><input type="number" min="0" value="${esc(item.unit_price)}"
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
// opts.keepInputsExcept: 一覧を読み直しても、このID以外の行に入力中の内容（まだ登録していない変更）を残す。
//   1人を「登録」しただけで、ほかの行に打ちかけていたパスワードやロールの変更が消えてしまわないようにするため
async function renderMasterUsers(opts = {}) {
  const typed = {};
  if (opts.keepInputsExcept !== undefined) {
    for (const u of masterUsers) {
      const field = part => document.getElementById(`u-${part}-${u.id}`);
      if (u.id == opts.keepInputsExcept || !field('name')) continue;
      typed[u.id] = { name: field('name').value, role: field('role').value, pass: field('pass').value, active: field('active').checked };
    }
  }
  // policy: パスワードの基準と、ログイン失敗時のロックの設定（説明の表示用）
  const [users, policy] = await Promise.all([api('/users'), api('/users/password-policy')]);
  masterUsers = users;
  const roleOpts = (cur) => ['admin','staff','viewer'].map(r =>
    `<option value="${r}" ${r===cur?'selected':''}>${esc(roleName(r))}</option>`
  ).join('');

  // locked_seconds > 0 のユーザーは、ログインに続けて失敗してロック中（残り秒数）
  const rows = users.map(u => `
    <tr>
      <td><input id="u-name-${u.id}" value="${esc(u.username)}" style="width:110px"></td>
      <td><select id="u-role-${u.id}">${roleOpts(u.role)}</select></td>
      <td><input type="password" id="u-pass-${u.id}" placeholder="変更する場合のみ入力" style="width:150px" autocomplete="new-password"></td>
      <td><label><input type="checkbox" id="u-active-${u.id}" ${u.active?'checked':''}> 有効</label>${
        u.locked_seconds > 0 ? `<div class="lock-note">${u.locked_everywhere === false ? '一部のPCでロック中' : 'ロック中'}（あと約${Math.ceil(u.locked_seconds / 60)}分）
          <button onclick="unlockUser(${u.id})" class="btn-sm">ロック解除</button></div>` : ''
      }</td>
      <td><button onclick="saveUser(${u.id})" class="btn-sm btn-register">登録</button></td>
      <td><button onclick="deleteUser(${u.id})" class="btn-danger">削除</button></td>
    </tr>`).join('');

  document.getElementById('master-users').innerHTML = `
    <div class="add-row" style="justify-content:flex-end">
      <input id="new-u-name" placeholder="ユーザーID" style="width:120px">
      <input type="password" id="new-u-pass" placeholder="パスワード" style="width:160px" autocomplete="new-password">
      <select id="new-u-role">${roleOpts('staff')}</select>
      <button onclick="addUser()" class="btn-primary">追加</button>
    </div>
    <p class="policy-note">パスワードの基準：${esc(policy.description)}<br>
      同じPCからログインに${esc(policy.max_failures)}回続けて失敗すると、そのPCからは${esc(policy.lock_minutes)}分間、そのユーザーIDでログインできなくなります（ほかのPCからはログインできます。
      PCを変えながら合計${esc(policy.global_failures ?? policy.max_failures * 4)}回失敗すると、どのPCからもログインできなくなります）。この画面の「ロック解除」で、すぐに戻せます。</p>
    <table class="master-table">
      <thead><tr><th>ユーザーID</th><th>ロール</th><th>パスワード（変更する場合のみ入力）</th><th>状態</th><th>操作</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  // 読み直す前に入力中だった内容を戻す（その間に削除されたユーザーの分は捨てる）
  for (const [uid, v] of Object.entries(typed)) {
    const field = part => document.getElementById(`u-${part}-${uid}`);
    if (!field('name')) continue;
    field('name').value = v.name; field('role').value = v.role; field('pass').value = v.pass; field('active').checked = v.active;
  }
}

async function saveUser(id) {
  const username = document.getElementById(`u-name-${id}`).value.trim();
  const password = document.getElementById(`u-pass-${id}`).value;
  const role     = document.getElementById(`u-role-${id}`).value;
  const active   = document.getElementById(`u-active-${id}`).checked ? 1 : 0;
  if (!username) return alert('ユーザーIDを入力してください');

  const body = { username, role, active };
  if (password) body.password = password;

  try {
    await api(`/users/${id}`, { method: 'PUT', body });
  } catch (e) {
    renderMasterUsers({ keepInputsExcept: id }).catch(() => {}); // 保存できなかった行の入力を元の値に戻す（ほかの行の入力は残す）
    throw e;
  }
  showToast(`「${username}」の情報を更新しました${password ? '（パスワードも変更しました）' : '（パスワードは変更していません）'}`);
  // 一覧を読み直す（パスワードを設定し直すとロックも解除されるので、「ロック中」の表示を消すため）。ほかの行に入力中の内容は残す
  renderMasterUsers({ keepInputsExcept: id });
}

async function deleteUser(id) {
  const username = masterUsers.find(x => x.id == id)?.username ?? '';
  if (!confirm(`ユーザー「${username}」を削除しますか？`)) return;
  // 失敗時のメッセージ表示・セッション切れの処理は api() の共通処理に任せる
  await api(`/users/${id}`, { method: 'DELETE' });
  renderMasterUsers();
}

async function addUser() {
  const username = document.getElementById('new-u-name').value.trim();
  const password = document.getElementById('new-u-pass').value;
  const role     = document.getElementById('new-u-role').value;
  if (!username || !password) return alert('ユーザーIDとパスワードを入力してください');
  // パスワードが基準を満たさないときは、サーバーが理由を返す（共通のエラー表示に出る。入力欄はそのまま残る）
  await api('/users', { method: 'POST', body: { username, password, role } });
  showToast(`ユーザー「${username}」を追加しました`);
  renderMasterUsers();
}

// ログイン失敗の連続によるロックを解除する
async function unlockUser(id) {
  const username = masterUsers.find(x => x.id == id)?.username ?? '';
  await api(`/users/${id}/unlock`, { method: 'POST' });
  showToast(`「${username}」のロックを解除しました`);
  renderMasterUsers();
}

// --- 操作ログ ---
// サーバーが記録する出来事の種類（server/middleware/audit.js、server/routes/auth.js）と、画面での呼び名
const AUDIT_ACTIONS = {
  'login.success': 'ログイン', 'login.failure': 'ログイン失敗', 'login.locked': 'ログイン拒否（ロック中）',
  'audit.skipped': '多すぎた要求（件数だけを記録）', 'audit.gap': '記録の欠落',
  'users.password_reset_offline': 'パスワードの再設定（サーバー上のツール）', 'logout': 'ログアウト',
  'records.view': '実績の表示', 'records.save': '実績の保存', 'summary.view': '月次集計の表示',
  'mealprices.view': '食事単価の表示', 'mealprices.list': '食事単価の一覧表示', 'mealprices.save': '食事単価の保存',
  'pdf.export': '請求書PDFの出力',
  'patients.list': '患者一覧の表示', 'patients.create': '患者の追加', 'patients.update': '患者の変更', 'patients.delete': '患者の削除',
  'items.create': '物品の追加', 'items.update': '物品の変更', 'items.delete': '物品の削除', 'prices.save': '日用品単価の保存',
  'wards.create': '病棟の追加', 'wards.update': '病棟の変更',
  'users.list': 'ユーザー一覧の表示', 'users.create': 'ユーザーの追加', 'users.update': 'ユーザーの変更',
  'users.delete': 'ユーザーの削除', 'users.unlock': 'ロックの解除',
  'export.run': '週次レポートの手動実行', 'audit.view': '操作ログの表示', 'server.start': 'サーバーの起動', 'server.warning': 'サーバーの警告',
  'other': 'その他の操作',
};

let auditCondition = '';   // 表示中の一覧の検索条件（CSV保存で同じ条件を使う）

function auditTime(row) {
  const t = String(row.t || '');
  return t.slice(0, 10) + ' ' + t.slice(11, 19);
}

function auditUser(row) {
  if (['server.start', 'server.warning', 'audit.gap', 'users.password_reset_offline'].includes(row.action)) return '（サーバー）';
  if (row.user == null) return '（未ログイン）';
  const name = row.role ? `${row.user}（${roleName(row.role)}）` : String(row.user);
  // ほかの人がログインしている画面から試したログインは、その画面の持ち主も出す
  return row.session_user ? `${name}［${row.session_user} がログイン中の画面から］` : name;
}

function auditTarget(row) {
  const parts = [];
  if (row.patient_id != null)
    parts.push(row.patient_name ? `${row.patient_name}（患者ID ${row.patient_id}）` : `患者ID ${row.patient_id}`);
  if (row.target != null) parts.push(`ID ${row.target}`);
  // ID が普通の数字の書き方で送られてこなかったとき（"1.0" や "0001" など）は、送られてきたままの値も出す
  const raw = auditRawIds(row);
  if (raw) parts.push(`［送られてきた値: ${raw}］`);
  return parts.join(' ');
}

function auditRawIds(row) {
  return [row.patient_id_raw, row.target_raw].filter(v => v != null && v !== '').join(' / ');
}

function auditResult(row) {
  if (row.aborted) return '中断';
  const status = Number(row.status);
  if (!status) return '';
  if (status < 400) return '成功';
  const names = { 400: '入力の誤り', 401: '未ログイン・認証失敗', 403: '権限なし', 404: '対象なし', 409: '重複', 429: 'ロック' };
  return `${names[status] || 'エラー'}（${status}）`;
}

// 記録の内容（detail）を読みやすい文にする。決まった形のもの以外は、そのままの形（JSON）で出す
function auditDetail(row) {
  const detail = row.detail;
  if (detail == null) return '';
  if (typeof detail !== 'object') return String(detail);
  const rest = { ...detail };
  const parts = [];
  if (rest.year != null && rest.month != null) { parts.push(`${rest.year}年${Number(rest.month)}月分`); delete rest.year; delete rest.month; }
  if (rest.record_date != null) { parts.push(`${rest.record_date} の分`); delete rest.record_date; }
  if (rest.below_standard) { parts.push('パスワードが基準を満たしていない'); delete rest.below_standard; }
  if (rest.unknown_id) { parts.push(`登録されていないユーザーID（${rest.length}文字）`); delete rest.unknown_id; delete rest.length; }
  if (rest.inactive) { parts.push('無効になっているユーザーID'); delete rest.inactive; }
  if (rest.locked) { parts.push(`この失敗でロック（${rest.minutes}分間）`); delete rest.locked; delete rest.minutes; }
  // 多すぎた要求のまとめ: 件数と、操作の種類ごとの内訳を文にする
  // （未ログインの要求は「1件ずつの記録を省略した件数」、ログイン済みのユーザーの要求は「処理せずに断った件数」）
  if (row.action === 'audit.skipped' && rest.count != null) {
    const kinds = rest.actions && typeof rest.actions === 'object'
      ? Object.entries(rest.actions).map(([action, n]) => `${AUDIT_ACTIONS[action] ?? action} ${n}件`).join('、') : '';
    parts.push(`${rest.note ?? '多すぎた要求の件数'}：${rest.count}件${kinds ? `（${kinds}）` : ''}`);
    delete rest.count; delete rest.note; delete rest.actions; delete rest.refused;
  }
  // 記録の欠落: 保存先に書き込めなかった件数、または「今月のファイルが無くなっていたので作り直した」こと
  if (row.action === 'audit.gap') {
    parts.push(`${rest.note ?? '記録できなかった件数'}：${rest.count ?? '?'}件${rest.last_error ? `（${rest.last_error}）` : ''}`);
    delete rest.count; delete rest.note; delete rest.last_error; delete rest.removed;
  }
  if (Object.keys(rest).length) parts.push(JSON.stringify(rest));
  return parts.join(' ／ ');
}

function renderMasterAudit() {
  // 期間は空のまま最初の表示を行い、サーバーが返した「サーバーの今日」を入れる
  // （このPCの時計やタイムゾーンがサーバーと違っていても、今日の記録が表示されるように）
  document.getElementById('master-audit').innerHTML = `
    <div class="audit-toolbar">
      <label>期間 <input type="date" id="audit-from"> 〜 <input type="date" id="audit-to"></label>
      <label>ユーザーID <input type="text" id="audit-user" list="audit-user-list" placeholder="すべて" style="width:120px"></label>
      <datalist id="audit-user-list"></datalist>
      <label>種類 <select id="audit-kind">
        <option value="">すべて</option>
        <option value="auth">ログイン・ログアウト</option>
        <option value="view">表示・出力</option>
        <option value="change">登録・変更・削除</option>
        <option value="denied">断られた操作・エラー</option>
        <option value="system">サーバーの出来事</option>
      </select></label>
      <label>キーワード <input type="text" id="audit-q" placeholder="患者の氏名、IPアドレスなど" style="width:180px"></label>
      <label>患者ID <input type="text" id="audit-pid" inputmode="numeric" placeholder="すべて" style="width:70px"
        title="削除した患者や、氏名を変える前の記録は、氏名では探せません。患者ID（患者の削除・変更の記録の「対象」に出ています）で探してください"></label>
      <button onclick="loadAuditLog()" class="btn-primary">表示</button>
      <button onclick="downloadAuditCsv()" class="btn-secondary">CSV保存</button>
    </div>
    <p class="policy-note">ログイン・ログアウト、患者の情報の表示と出力、登録・変更・削除の操作を、サーバーが自動で記録しています（新しい順に表示）。
      月に1回は「断られた操作・エラー」「ログイン・ログアウト」「サーバーの出来事」（起動、サーバー上のツールによるパスワードの再設定、記録の欠落）を確認してください。</p>
    <div id="audit-status"></div>
    <div id="audit-table"></div>`;
  return loadAuditLog();
}

// 画面の検索条件を、API のクエリ文字列にする
function auditQuery(limit) {
  const params = new URLSearchParams();
  for (const [key, id] of [['from', 'audit-from'], ['to', 'audit-to'], ['user', 'audit-user'], ['kind', 'audit-kind'], ['q', 'audit-q'], ['patient_id', 'audit-pid']]) {
    const value = document.getElementById(id).value.trim();
    if (value) params.set(key, value);
  }
  params.set('limit', String(limit));
  return params.toString();
}

async function loadAuditLog() {
  const data = await api('/audit?' + auditQuery(1000));
  // 期間が空だった（最初の表示）ときは、サーバーが使った日付を入れておく
  for (const [id, value] of [['audit-from', data.from], ['audit-to', data.to]]) {
    const el = document.getElementById(id);
    if (!el.value) el.value = value;
  }
  auditCondition = auditQuery(5000);

  // ユーザーIDの入力候補（表示中の記録に出てくるID）
  const names = [...new Set(data.rows.map(r => r.user).filter(u => u != null))].sort();
  document.getElementById('audit-user-list').innerHTML = names.map(n => `<option value="${esc(n)}">`).join('');

  const failed = data.writer && data.writer.failedCount > 0;
  document.getElementById('audit-status').innerHTML = `
    ${failed ? `<div class="audit-warning">サーバーの起動後、操作ログに書き込めなかった記録が ${esc(data.writer.failedCount)} 件あります
      （最後のエラー: ${esc(data.writer.lastError?.at)} ${esc(data.writer.lastError?.message)}）。
      サーバーのディスクの空き容量と、保存先フォルダ（${esc(data.writer.dir)}）の権限を確認してください。</div>` : ''}
    ${data.unreadable > 0 ? `<div class="audit-warning">この期間の操作ログのファイルに、読めない行が ${esc(Number(data.unreadable).toLocaleString())} 行あります
      （下の一覧にも件数にも入っていません）。停電などで途中で切れた行か、ファイルが書き換えられた可能性があります。
      保存先フォルダ（${esc(data.writer?.dir ?? '')}）のファイルを、バックアップと見比べて確認してください。</div>` : ''}
    <p class="audit-count">${esc(data.from)} 〜 ${esc(data.to)}：${esc(data.total.toLocaleString())} 件${
      data.truncated ? `（新しい ${esc(data.rows.length.toLocaleString())} 件を表示しています。期間や条件を絞ると、残りを確認できます）` : ''}</p>`;

  const rows = data.rows.map(row => `
    <tr class="${Number(row.status) >= 400 ? 'audit-denied' : ''}">
      <td>${esc(auditTime(row))}</td>
      <td>${esc(auditUser(row))}</td>
      <td>${esc(row.ip ?? '')}</td>
      <td>${esc(AUDIT_ACTIONS[row.action] ?? row.action)}</td>
      <td>${esc(auditTarget(row))}</td>
      <td>${esc(auditResult(row))}</td>
      <td class="audit-detail">${esc(auditDetail(row))}</td>
    </tr>`).join('');

  document.getElementById('audit-table').innerHTML = data.rows.length ? `
    <div class="audit-wrap">
      <table class="master-table audit-table">
        <thead><tr><th>日時（サーバーの時刻）</th><th>ユーザー</th><th>接続元</th><th>操作</th><th>対象</th><th>結果</th><th>内容</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>` : '<p class="no-patient">この条件に合う記録はありません</p>';
}

// CSV の1項目。= + - @ で始まる値は、表計算ソフトで数式として実行されないよう先頭に ' を付ける
// （ログイン失敗の記録には、だれかが入力した文字列がそのまま入っているため）
function csvCell(value) {
  let text = value == null ? '' : String(value);
  // 全角の ＝ ＋ － ＠ で始まる値も数式として扱われるので、半角にそろえ、先頭の空白を除いた形で調べる
  if (/^[=+\-@\t\r]/.test(text.normalize('NFKC').trimStart())) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

// 表示中の条件に合う記録を CSV で保存する（最大 5,000 件。Excel で開ける形式）
async function downloadAuditCsv() {
  const data = await api('/audit?' + (auditCondition || auditQuery(5000)));
  const header = ['日時', 'ユーザーID', 'ロール', '接続元', '操作', '対象の患者', '患者ID', '対象ID', '結果', '内容', '操作の種類', '状態コード', '送られてきたID'];
  const lines = data.rows.map(row => [
    auditTime(row), row.user ?? '', row.role ? roleName(row.role) : '', row.ip ?? '',
    AUDIT_ACTIONS[row.action] ?? row.action, row.patient_name ?? '', row.patient_id ?? '', row.target ?? '',
    auditResult(row), auditDetail(row), row.action ?? '', row.status ?? '', auditRawIds(row),
  ].map(csvCell).join(','));
  const csv = '﻿' + [header.map(csvCell).join(','), ...lines].join('\r\n') + '\r\n';
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `sousa-log_${data.from}_${data.to}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`${data.rows.length.toLocaleString()} 件を CSV に保存しました` + (data.truncated ? '（条件に合う記録の一部です）' : '') +
    (data.unreadable > 0 ? `（このほかに、読めない行が ${Number(data.unreadable).toLocaleString()} 行あります）` : ''));
}

// ============================================================
// ユーティリティ
// ============================================================
// HTMLに埋め込む文字列のエスケープ（DBや入力由来の値は必ずこれを通す）
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
