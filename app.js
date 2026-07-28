// app.js — My BioScan: локальний трекер медичних записів (усі дані лишаються на пристрої)

const DB_NAME = 'health_vault';
const DB_VERSION = 3;
let db;

const DEFAULT_TESTS = [
  { key: 'blood_general', label: 'Загальний аналіз крові', freq: 180 },
  { key: 'biochem', label: 'Біохімія крові', freq: 365 },
  { key: 'tsh', label: 'ТТГ (щитоподібна)', freq: 365 },
  { key: 'vitd', label: 'Вітамін D', freq: 365 },
  { key: 'gyn_exam', label: 'Огляд гінеколога', freq: 365 },
  { key: 'dentist', label: 'Огляд стоматолога', freq: 180 },
];

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('records')) {
        d.createObjectStore('records', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('measurements')) {
        const s = d.createObjectStore('measurements', { keyPath: 'id' });
        s.createIndex('by_key', 'key');
      }
      if (!d.objectStoreNames.contains('trackedTests')) {
        d.createObjectStore('trackedTests', { keyPath: 'key' });
      }
      if (!d.objectStoreNames.contains('customMarkers')) {
        d.createObjectStore('customMarkers', { keyPath: 'key' });
      }
      if (!d.objectStoreNames.contains('settings')) {
        d.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(storeNames, mode = 'readonly') {
  return db.transaction(storeNames, mode);
}
function store(name, mode = 'readonly') {
  return tx([name], mode).objectStore(name);
}
function reqToPromise(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function dbGetAll(name) {
  return reqToPromise(store(name).getAll());
}
async function dbPut(name, obj) {
  return reqToPromise(store(name, 'readwrite').put(obj));
}
async function dbDelete(name, key) {
  return reqToPromise(store(name, 'readwrite').delete(key));
}

// Комбінований словник: базові показники + ті, що додаток "вивчив" раніше
// з попередніх фото/PDF. customMarkers зберігає pat як рядок (не RegExp),
// бо RegExp незручно тримати в об'єктах, з якими працюємо як зі звичайними даними.
async function loadCombinedDictionary() {
  const custom = await dbGetAll('customMarkers');
  return [...OCR.dictionary, ...custom];
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function fmtDate(d) {
  const dt = new Date(d);
  return dt.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// data: URL → Blob. Надійніше для великих PDF, ніж пряме href="data:..." —
// у Safari/PWA такі посилання інколи відкриваються порожньою сторінкою.
function dataURLtoBlob(dataurl) {
  const [header, base64] = dataurl.split(',');
  const mimeMatch = header.match(/data:(.*?);base64/);
  const mime = mimeMatch ? mimeMatch[1] : 'application/pdf';
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

function toast(msg) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

function openSheet(innerHtml) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="overlay" id="overlay"><div class="sheet">${innerHtml}</div></div>`;
  document.getElementById('overlay').addEventListener('click', (e) => {
    if (e.target.id === 'overlay') closeSheet();
  });
}
function closeSheet() {
  document.getElementById('modal-root').innerHTML = '';
}

// ---------- Router ----------
let currentTab = 'home';

document.getElementById('tabbar').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  btn.classList.add('active');
  currentTab = btn.dataset.tab;
  render();
});

async function render() {
  const root = document.getElementById('view-root');
  removeFab();
  if (currentTab === 'home') root.innerHTML = await viewHome();
  else if (currentTab === 'records') { root.innerHTML = await viewRecords(); addFab('＋', openAddRecordSheet); }
  else if (currentTab === 'trends') root.innerHTML = await viewTrends();
  else if (currentTab === 'reminders') { root.innerHTML = await viewReminders(); addFab('＋', openAddTestSheet); }
  attachViewHandlers();
}

function addFab(label, onClick) {
  removeFab();
  const b = document.createElement('button');
  b.className = 'fab';
  b.id = 'fab';
  b.textContent = label;
  b.addEventListener('click', onClick);
  document.body.appendChild(b);
}
function removeFab() {
  const f = document.getElementById('fab');
  if (f) f.remove();
}

// ---------- HOME ----------
async function viewHome() {
  const tests = await dbGetAll('trackedTests');
  const withStatus = tests.map((t) => statusOf(t)).sort((a, b) => a.daysLeft - b.daysLeft);
  const overdue = withStatus.filter((t) => t.status === 'overdue');
  const soon = withStatus.filter((t) => t.status === 'soon');

  const records = await dbGetAll('records');
  const measurements = await dbGetAll('measurements');

  let html = `<h1>Вітаю 👋</h1>`;

  if (overdue.length) {
    html += `<div class="card alert"><h2>Прострочено</h2>`;
    overdue.forEach((t) => html += reminderLine(t));
    html += `</div>`;
  }
  if (soon.length) {
    html += `<div class="card"><h2>Скоро час</h2>`;
    soon.forEach((t) => html += reminderLine(t));
    html += `</div>`;
  }
  if (!overdue.length && !soon.length && tests.length) {
    html += `<div class="card ok"><p>Усі аналізи під контролем ✓</p></div>`;
  }
  if (!tests.length) {
    html += `<div class="card"><p class="muted">Ще не додано жодного аналізу для відстеження. Перейди на вкладку «Нагадування», щоб додати перший.</p></div>`;
  }

  html += `<div class="card"><h2>Коротко</h2>
    <p class="muted">${records.length} записів · ${measurements.length} збережених показників</p>
  </div>`;

  return html;
}

function statusOf(t) {
  const nextDue = t.lastDate ? daysBetween(t.lastDate, todayISO()) : null;
  const daysSince = t.lastDate ? daysBetween(t.lastDate, todayISO()) : null;
  const daysLeft = t.lastDate ? t.freq - daysSince : -9999;
  let status = 'ok';
  if (!t.lastDate) status = 'overdue';
  else if (daysLeft < 0) status = 'overdue';
  else if (daysLeft <= 21) status = 'soon';
  return { ...t, daysLeft, status };
}

function reminderLine(t) {
  const badgeClass = t.status === 'overdue' ? 'overdue' : t.status === 'soon' ? 'soon' : 'ok';
  const text = !t.lastDate
    ? 'ще не позначено'
    : t.daysLeft < 0
      ? `прострочено на ${Math.abs(t.daysLeft)} дн.`
      : `через ${t.daysLeft} дн.`;
  return `<div class="row" style="padding:8px 0;border-bottom:1px solid var(--line)">
    <div><strong>${t.label}</strong><br><span class="muted">${text}</span></div>
    <span class="badge ${badgeClass}">${t.status === 'overdue' ? 'Час!' : t.status === 'soon' ? 'Скоро' : 'ОК'}</span>
  </div>`;
}

// ---------- RECORDS ----------
async function viewRecords() {
  const records = (await dbGetAll('records')).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!records.length) {
    return `<h1>Записи</h1><div class="empty"><img src="assets/empty-illustration.svg" class="empty-illustration" alt=""><p>Тут з'являться фото висновків та PDF з результатами аналізів.<br>Натисни «＋», щоб додати перший запис.</p></div>`;
  }
  let html = `<h1>Записи</h1><div class="card">`;
  records.forEach((r) => {
    html += `<div class="list-item" data-open-record="${r.id}" style="cursor:pointer">
      <div class="thumb">${r.type === 'photo' && r.thumb ? `<img src="${r.thumb}">` : r.type === 'pdf' ? '📄' : '✍️'}</div>
      <div style="flex:1">
        <strong>${r.title || (r.type === 'photo' ? 'Фото висновку' : r.type === 'pdf' ? 'PDF аналізів' : 'Ручний запис')}</strong><br>
        <span class="muted">${fmtDate(r.createdAt)}${r.markerCount ? ` · ${r.markerCount} показників` : ''}</span>
      </div>
    </div>`;
  });
  html += `</div>`;
  return html;
}

async function openAddRecordSheet() {
  openSheet(`
    <div class="sheet-handle"></div>
    <h2>Додати запис</h2>
    <p class="muted">Обери, що хочеш зберегти.</p>
    <div class="btn-row" style="flex-direction:column">
      <button class="btn" id="btn-photo">📷 Сфотографувати висновок</button>
      <button class="btn secondary" id="btn-pdf">📄 Завантажити PDF з аналізами</button>
      <button class="btn secondary" id="btn-manual">✍️ Внести дані вручну</button>
    </div>
    <input type="file" id="file-photo" accept="image/*" capture="environment" style="display:none">
    <input type="file" id="file-pdf" accept="application/pdf" style="display:none">
  `);
  document.getElementById('btn-photo').onclick = () => document.getElementById('file-photo').click();
  document.getElementById('btn-pdf').onclick = () => document.getElementById('file-pdf').click();
  document.getElementById('btn-manual').onclick = () => openManualEntrySheet();
  document.getElementById('file-photo').onchange = (e) => handleFile(e.target.files[0], 'photo');
  document.getElementById('file-pdf').onchange = (e) => handleFile(e.target.files[0], 'pdf');
}

function fileToDataUrl(file) {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(file);
  });
}
function fileToArrayBuffer(file) {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsArrayBuffer(file);
  });
}

async function handleFile(file, type) {
  if (!file) return;
  openSheet(`
    <div class="sheet-handle"></div>
    <h2>Розпізнаю текст…</h2>
    <p class="muted" id="ocr-progress">0%</p>
  `);
  try {
    let dataUrl, text;
    if (type === 'photo') {
      dataUrl = await fileToDataUrl(file);
      text = await OCR.recognizeImage(dataUrl, (p) => {
        const el = document.getElementById('ocr-progress');
        if (el) el.textContent = p + '%';
      });
    } else {
      const buf = await fileToArrayBuffer(file);
      dataUrl = null;
      text = await OCR.extractPdf(buf, (p) => {
        const el = document.getElementById('ocr-progress');
        if (el) el.textContent = p + '%';
      });
    }
    const dict = await loadCombinedDictionary();
    const found = OCR.findMarkers(text, dict);
    const candidates = OCR.findGenericCandidates(text, dict);
    let pdfDataUrl = null;
    if (type === 'pdf') pdfDataUrl = await fileToDataUrl(file);
    openConfirmMarkersSheet({ type, thumb: dataUrl, pdfDataUrl, text, found, candidates });
  } catch (err) {
    closeSheet();
    toast('Не вдалося розпізнати файл: ' + (err.message || err));
  }
}

function openConfirmMarkersSheet(data) {
  const rows = data.found.map((m, i) => `
    <div class="row" style="gap:8px;margin-bottom:8px">
      <input type="checkbox" checked data-idx="${i}" class="marker-check" style="width:auto;margin:0">
      <span style="flex:1">${m.label}${m.ref ? `<br><span class="muted" style="font-size:12px">референс: ${m.ref[0]}–${m.ref[1] >= 999 ? '∞' : m.ref[1]}</span>` : ''}</span>
      <input type="number" step="0.01" value="${m.value}" data-idx="${i}" class="marker-value" style="width:90px;margin:0">
      <span class="muted" style="width:70px">${m.unit}</span>
    </div>`).join('');

  const candidates = data.candidates || [];
  const candRows = candidates.map((c, i) => `
    <div class="row" style="gap:8px;margin-bottom:8px;align-items:center">
      <input type="checkbox" data-cidx="${i}" class="cand-check" style="width:auto;margin:0">
      <input value="${c.label}" data-cidx="${i}" class="cand-label" style="flex:1;margin:0">
      <input type="number" step="0.01" value="${c.value}" data-cidx="${i}" class="cand-value" style="width:80px;margin:0">
      <input value="${c.unit}" data-cidx="${i}" class="cand-unit" placeholder="од." style="width:60px;margin:0">
    </div>
    ${c.ref ? `<p class="muted" style="margin:-6px 0 8px 32px;font-size:12px">референс з бланка: ${c.ref[0]}–${c.ref[1]}</p>` : ''}`).join('');

  openSheet(`
    <div class="sheet-handle"></div>
    <h2>Перевір показники</h2>
    <p class="muted">Розпізнавання не ідеальне — перевір цифри перед збереженням.</p>
    <label>Назва запису</label>
    <input id="rec-title" value="${data.type === 'photo' ? 'Фото висновку' : 'PDF аналізів'}">
    <label>Дата</label>
    <input id="rec-date" type="date" value="${todayISO()}">
    ${data.found.length ? `<h2 style="margin-top:14px">Знайдені показники (${data.found.length})</h2>${rows}` : `<p class="muted">Відомих показників у тексті не знайдено.</p>`}
    ${candidates.length ? `
      <h2 style="margin-top:14px">Схожі на показники — додатку ще невідомі</h2>
      <p class="muted">Онови назву/одиницю, якщо потрібно, і познач ✓ — показник запам'ятається й наступного разу розпізнаватиметься сам.</p>
      ${candRows}
    ` : ''}
    <div class="btn-row">
      <button class="btn" id="btn-save-record">Зберегти</button>
      <button class="btn ghost" id="btn-cancel-record">Скасувати</button>
    </div>
  `);
  document.getElementById('btn-cancel-record').onclick = closeSheet;
  document.getElementById('btn-save-record').onclick = async () => {
    const title = document.getElementById('rec-title').value;
    const date = document.getElementById('rec-date').value || todayISO();

    const selected = [];
    document.querySelectorAll('.marker-check').forEach((c) => {
      if (c.checked) {
        const idx = c.dataset.idx;
        const valInput = document.querySelector(`.marker-value[data-idx="${idx}"]`);
        const m = data.found[idx];
        selected.push({ ...m, value: parseFloat(valInput.value) });
      }
    });

    const newMarkers = [];
    document.querySelectorAll('.cand-check').forEach((c) => {
      if (c.checked) {
        const idx = c.dataset.cidx;
        const label = document.querySelector(`.cand-label[data-cidx="${idx}"]`).value.trim();
        const value = parseFloat(document.querySelector(`.cand-value[data-cidx="${idx}"]`).value);
        const unit = document.querySelector(`.cand-unit[data-cidx="${idx}"]`).value.trim();
        const ref = (data.candidates[idx] && data.candidates[idx].ref) || null;
        if (label && !isNaN(value)) newMarkers.push({ label, value, unit, ref });
      }
    });

    // Кожен підтверджений новий показник — запам'ятовуємо в словник назавжди,
    // щоб наступного разу він знаходився автоматично, без ручного підтвердження.
    for (const nm of newMarkers) {
      const key = OCR.keyFromLabel(nm.label);
      await dbPut('customMarkers', {
        key,
        label: nm.label,
        pat: OCR.escapeRegExp(nm.label),
        unit: nm.unit,
        ref: nm.ref,
      });
      selected.push({ key, label: nm.label, unit: nm.unit, value: nm.value, ref: nm.ref });
    }

    await saveRecord({ type: data.type, title, date, thumb: data.thumb, pdfDataUrl: data.pdfDataUrl, text: data.text, markers: selected });
    closeSheet();
    toast(newMarkers.length ? `Збережено. Додано ${newMarkers.length} нов. показник(ів) в автопошук.` : 'Запис збережено');
    render();
  };
}

async function saveRecord({ type, title, date, thumb, pdfDataUrl, text, markers }) {
  const recordId = uid();
  const record = {
    id: recordId,
    type,
    title,
    createdAt: date,
    thumb: type === 'photo' ? thumb : null,
    fileData: type === 'pdf' ? pdfDataUrl : null,
    extractedText: text || '',
    markerCount: markers.length,
  };
  await dbPut('records', record);
  for (const m of markers) {
    await dbPut('measurements', {
      id: uid(),
      recordId,
      key: m.key,
      label: m.label,
      unit: m.unit,
      value: m.value,
      ref: m.ref,
      date,
    });
  }
}

async function openManualEntrySheet() {
  const dict = await loadCombinedDictionary();
  const options = dict.map((t) => `<option value="${t.key}">${t.label}</option>`).join('');
  openSheet(`
    <div class="sheet-handle"></div>
    <h2>Внести дані вручну</h2>
    <label>Показник</label>
    <select id="man-key">${options}</select>
    <label>Значення</label>
    <input id="man-value" type="number" step="0.01">
    <label>Дата</label>
    <input id="man-date" type="date" value="${todayISO()}">
    <div class="btn-row">
      <button class="btn" id="man-save">Зберегти</button>
      <button class="btn ghost" id="man-cancel">Скасувати</button>
    </div>
  `);
  document.getElementById('man-cancel').onclick = closeSheet;
  document.getElementById('man-save').onclick = async () => {
    const key = document.getElementById('man-key').value;
    const value = parseFloat(document.getElementById('man-value').value);
    const date = document.getElementById('man-date').value || todayISO();
    if (isNaN(value)) { toast('Введи число'); return; }
    const dict = await loadCombinedDictionary();
    const test = dict.find((t) => t.key === key);
    const recordId = uid();
    await dbPut('records', { id: recordId, type: 'manual', title: `Вручну: ${test.label}`, createdAt: date, markerCount: 1 });
    await dbPut('measurements', { id: uid(), recordId, key: test.key, label: test.label, unit: test.unit, value, ref: test.ref, date });
    closeSheet();
    toast('Збережено');
    render();
  };
}

async function openRecordDetail(id) {
  const rec = (await dbGetAll('records')).find((r) => r.id === id);
  if (!rec) return;
  const measurements = (await dbGetAll('measurements')).filter((m) => m.recordId === id);
  let media = '';
  if (rec.type === 'photo' && rec.thumb) media = `<img src="${rec.thumb}" style="width:100%;border-radius:12px;margin-bottom:12px">`;
  if (rec.type === 'pdf' && rec.fileData) media = `<button class="btn secondary" id="btn-open-pdf" style="display:inline-block;margin-bottom:12px">⬇ Відкрити PDF</button>`;

  let markerRows = measurements.map((m) => `<tr><td>${m.label}</td><td>${m.value} ${m.unit}</td></tr>`).join('');

  openSheet(`
    <div class="sheet-handle"></div>
    <h2>${rec.title}</h2>
    <p class="muted">${fmtDate(rec.createdAt)}</p>
    ${media}
    ${measurements.length ? `<table class="marker-table">${markerRows}</table>` : ''}
    <div class="btn-row">
      <button class="btn" id="btn-edit-record">✏️ Редагувати</button>
      <button class="btn danger" id="btn-delete-record">Видалити запис</button>
      <button class="btn ghost" id="btn-close-record">Закрити</button>
    </div>
  `);
  document.getElementById('btn-close-record').onclick = closeSheet;
  const openPdfBtn = document.getElementById('btn-open-pdf');
  if (openPdfBtn) {
    openPdfBtn.onclick = () => {
      const blob = dataURLtoBlob(rec.fileData);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    };
  }
  document.getElementById('btn-edit-record').onclick = () => openEditRecordSheet(id);
  document.getElementById('btn-delete-record').onclick = async () => {
    await dbDelete('records', id);
    const all = await dbGetAll('measurements');
    for (const m of all.filter((x) => x.recordId === id)) await dbDelete('measurements', m.id);
    closeSheet();
    toast('Запис видалено');
    render();
  };
}

async function openEditRecordSheet(id) {
  const rec = (await dbGetAll('records')).find((r) => r.id === id);
  if (!rec) return;
  const measurements = (await dbGetAll('measurements')).filter((m) => m.recordId === id);
  const dict = await loadCombinedDictionary();
  const options = dict.map((t) => `<option value="${t.key}">${t.label}</option>`).join('');

  const rows = measurements.map((m) => `
    <div class="row" style="gap:8px;margin-bottom:8px;align-items:center" data-existing-row="${m.id}">
      <input type="checkbox" checked class="edit-keep" data-mid="${m.id}" style="width:auto;margin:0">
      <span style="flex:1">${m.label}</span>
      <input type="number" step="0.01" value="${m.value}" class="edit-value" data-mid="${m.id}" style="width:90px;margin:0">
      <span class="muted" style="width:60px">${m.unit || ''}</span>
    </div>`).join('');

  openSheet(`
    <div class="sheet-handle"></div>
    <h2>Редагувати запис</h2>
    <label>Назва запису</label>
    <input id="edit-title" value="${rec.title}">
    <label>Дата</label>
    <input id="edit-date" type="date" value="${rec.createdAt}">
    ${measurements.length ? `<h2 style="margin-top:14px">Показники</h2><p class="muted">Зніми ✓, щоб видалити показник із запису.</p>${rows}` : ''}
    <h2 style="margin-top:14px">Додати показник</h2>
    <div id="edit-new-rows"></div>
    <button class="btn ghost" id="btn-add-row" type="button">＋ Додати рядок</button>
    <div class="btn-row">
      <button class="btn" id="btn-save-edit">Зберегти</button>
      <button class="btn ghost" id="btn-cancel-edit">Скасувати</button>
    </div>
  `);

  const newRowsEl = document.getElementById('edit-new-rows');
  function addNewRow() {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.cssText = 'gap:8px;margin-bottom:8px;align-items:center';
    row.innerHTML = `
      <select class="new-key" style="flex:1;margin:0">${options}</select>
      <input type="number" step="0.01" placeholder="значення" class="new-value" style="width:90px;margin:0">
      <button class="btn ghost" type="button" style="padding:6px 10px" data-remove-row="1">✕</button>`;
    row.querySelector('[data-remove-row]').onclick = () => row.remove();
    newRowsEl.appendChild(row);
  }
  document.getElementById('btn-add-row').onclick = addNewRow;

  document.getElementById('btn-cancel-edit').onclick = closeSheet;
  document.getElementById('btn-save-edit').onclick = async () => {
    const title = document.getElementById('edit-title').value.trim() || rec.title;
    const date = document.getElementById('edit-date').value || rec.createdAt;

    let keptCount = 0;
    for (const m of measurements) {
      const keepBox = document.querySelector(`.edit-keep[data-mid="${m.id}"]`);
      if (keepBox.checked) {
        const valInput = document.querySelector(`.edit-value[data-mid="${m.id}"]`);
        await dbPut('measurements', { ...m, value: parseFloat(valInput.value), date });
        keptCount++;
      } else {
        await dbDelete('measurements', m.id);
      }
    }

    const newRows = [...newRowsEl.querySelectorAll('.row')];
    for (const row of newRows) {
      const key = row.querySelector('.new-key').value;
      const value = parseFloat(row.querySelector('.new-value').value);
      if (isNaN(value)) continue;
      const test = dict.find((t) => t.key === key);
      if (!test) continue;
      await dbPut('measurements', { id: uid(), recordId: id, key: test.key, label: test.label, unit: test.unit, value, ref: test.ref || null, date });
      keptCount++;
    }

    await dbPut('records', { ...rec, title, createdAt: date, markerCount: keptCount });
    closeSheet();
    toast('Зміни збережено');
    render();
  };
}

// ---------- TRENDS ----------
let trendCharts = {}; // key -> Chart instance, одна картка/графік на показник
let selectedMarkerKeys = new Set();

async function loadPinnedMarkers() {
  try {
    const s = await reqToPromise(store('settings').get('pinnedMarkers'));
    return (s && s.value) || null;
  } catch { return null; }
}
async function savePinnedMarkers(keys) {
  await dbPut('settings', { key: 'pinnedMarkers', value: keys });
}

async function viewTrends() {
  const measurements = await dbGetAll('measurements');
  if (!measurements.length) {
    return `<h1>Динаміка</h1><div class="empty"><img src="assets/empty-illustration.svg" class="empty-illustration" alt=""><p>Як тільки з'являться збережені показники з фото, PDF або ручного вводу — тут з'являться графіки.</p></div>`;
  }
  // Показники в чіпах — лише ті, для яких реально є хоч один збережений результат.
  const keys = [...new Set(measurements.map((m) => m.key))];

  if (selectedMarkerKeys.size === 0) {
    const pinned = await loadPinnedMarkers();
    if (pinned && pinned.length) {
      selectedMarkerKeys = new Set(pinned.filter((k) => keys.includes(k)));
    }
    if (selectedMarkerKeys.size === 0) selectedMarkerKeys = new Set([keys[0]]);
  } else {
    // прибираємо з вибору показники, яких вже не існує (запис видалили)
    selectedMarkerKeys = new Set([...selectedMarkerKeys].filter((k) => keys.includes(k)));
    if (selectedMarkerKeys.size === 0) selectedMarkerKeys = new Set([keys[0]]);
  }

  const chips = keys.map((k) => {
    const label = measurements.find((m) => m.key === k).label;
    return `<button class="chip ${selectedMarkerKeys.has(k) ? 'active' : ''}" data-marker="${k}">${label}</button>`;
  }).join('');

  // Кожен обраний показник — окрема картка зі своєю шкалою. Показники мають
  // різні одиниці виміру (г/л, ммоль/л, ×10⁹/л...), тому накладати їх на один
  // спільний графік з однією віссю було б оманливо.
  const dashboards = [...selectedMarkerKeys].map((k) => `
    <div class="card">
      <canvas id="trend-canvas-${k}" height="200"></canvas>
      <div id="trend-info-${k}" style="margin-top:10px"></div>
    </div>
  `).join('');

  return `<h1>Динаміка</h1>
    <p class="muted">Обери один або кілька показників — кожен матиме свій графік.</p>
    <div class="chip-row">${chips}</div>
    <div class="btn-row" style="margin-top:-8px;margin-bottom:14px">
      <button class="btn ghost" id="btn-pin-markers">📌 Закріпити цей вибір</button>
    </div>
    ${dashboards}`;
}

// Плагін Chart.js: малює заливку-смугу референтного діапазону на фоні графіка.
// На відміну від лінії-датасета, працює навіть коли є лише ОДНА точка даних —
// саме тому попередня версія "губила" референс на свіжододаних показниках.
function refBandPlugin(ref) {
  return {
    id: 'refBand',
    beforeDatasetsDraw(chart) {
      if (!ref) return;
      const { ctx, chartArea, scales } = chart;
      if (!chartArea) return;
      const yTop = scales.y.getPixelForValue(ref[1]);
      const yBottom = scales.y.getPixelForValue(ref[0]);
      ctx.save();
      ctx.fillStyle = 'rgba(15,110,106,0.09)';
      ctx.fillRect(chartArea.left, yTop, chartArea.right - chartArea.left, yBottom - yTop);
      ctx.restore();
    }
  };
}

function drawTrendChart() {
  dbGetAll('measurements').then((all) => {
    const keys = [...selectedMarkerKeys];

    // прибираємо графіки показників, які більше не обрані
    Object.keys(trendCharts).forEach((k) => {
      if (!keys.includes(k)) { trendCharts[k].destroy(); delete trendCharts[k]; }
    });

    keys.forEach((k) => {
      const points = all.filter((m) => m.key === k).sort((a, b) => a.date.localeCompare(b.date));
      const ctx = document.getElementById(`trend-canvas-${k}`);
      if (!points.length || !ctx) return;
      if (trendCharts[k]) trendCharts[k].destroy();

      const ref = points[0].ref;
      const label = points[0].label + (points[0].unit ? ` (${points[0].unit})` : '');
      // Трохи розширюємо межі шкали за референс, щоб смуга норми була видна
      // цілком, навіть якщо всі значення лежать глибоко всередині діапазону.
      const values = points.map((p) => p.value);
      let yMin, yMax;
      const allVals = ref ? [...values, ref[0], ref[1]] : values;
      const lo = Math.min(...allVals), hi = Math.max(...allVals);
      const pad = Math.max((hi - lo) * 0.15, 1);
      yMin = lo - pad; yMax = hi + pad;

      trendCharts[k] = new Chart(ctx, {
        type: 'line',
        data: {
          labels: points.map((p) => fmtDate(p.date)),
          datasets: [{
            label,
            data: values,
            borderColor: '#0F6E6A',
            backgroundColor: 'rgba(15,110,106,0.12)',
            tension: 0.25,
            fill: true,
            pointRadius: points.length === 1 ? 5 : 4,
          }]
        },
        options: {
          plugins: { legend: { display: true } },
          scales: { y: { min: yMin, max: yMax } }
        },
        plugins: [refBandPlugin(ref)]
      });

      const infoEl = document.getElementById(`trend-info-${k}`);
      if (infoEl) {
        infoEl.innerHTML = ref
          ? `<p class="muted">Заштрихована смуга — орієнтовна норма ${ref[0]}–${ref[1] >= 999 ? '∞' : ref[1]}. Це загальний довідковий діапазон, не заміна оцінки лікаря.</p>`
          : `<p class="muted">Референс невідомий (власний показник).</p>`;
      }
    });
  });
}

// ---------- REMINDERS ----------
async function viewReminders() {
  const tests = await dbGetAll('trackedTests');
  const pushCard = await renderPushCard();
  if (!tests.length) {
    // засіяти дефолтний набір при першому відкритті
    return `<h1>Нагадування</h1><div class="empty"><img src="assets/empty-illustration.svg" class="empty-illustration" alt=""><p>Додай аналізи, за якими хочеш стежити регулярно.</p>
    <button class="btn" id="btn-seed-defaults" style="margin-top:14px">Додати типовий набір</button></div>${pushCard}`;
  }
  const withStatus = tests.map(statusOf).sort((a, b) => a.daysLeft - b.daysLeft);
  let html = `<h1>Нагадування</h1><div class="card">`;
  withStatus.forEach((t) => {
    const badgeClass = t.status === 'overdue' ? 'overdue' : t.status === 'soon' ? 'soon' : 'ok';
    const text = !t.lastDate ? 'ще не позначено' : `востаннє: ${fmtDate(t.lastDate)} · раз на ${t.freq} дн.`;
    html += `<div class="list-item" style="align-items:center">
      <div style="flex:1">
        <strong>${t.label}</strong> <span class="badge ${badgeClass}">${t.status === 'overdue' ? 'Час!' : t.status === 'soon' ? 'Скоро' : 'ОК'}</span><br>
        <span class="muted">${text}</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <button class="btn ghost" data-done="${t.key}">Виконано</button>
        <button class="btn ghost" data-ics="${t.key}">📅 .ics</button>
      </div>
    </div>`;
  });
  html += `</div>${pushCard}`;
  return html;
}

async function renderPushCard() {
  const settings = await getPushSettings();
  if (settings.subscribed) {
    return `<div class="card ok">
      <h2>🔔 Сповіщення</h2>
      <p class="muted">Увімкнено. Прийде push, навіть якщо додаток закритий.</p>
      <div class="btn-row">
        <button class="btn ghost" id="btn-test-push">Надіслати тестове</button>
        <button class="btn ghost" id="btn-disable-push">Вимкнути</button>
      </div>
    </div>`;
  }
  return `<div class="card">
    <h2>🔔 Сповіщення</h2>
    <p class="muted">Щоб нагадування приходили як справжній push, навіть коли додаток закритий, потрібен окремий невеликий сервер (розгортається безкоштовно на Cloudflare — інструкція в README, файл server/worker.js).</p>
    <label>Адреса сервера сповіщень</label>
    <input id="push-server-url" placeholder="https://....workers.dev" value="${settings.serverUrl || ''}">
    <div class="btn-row">
      <button class="btn" id="btn-enable-push">Увімкнути сповіщення</button>
    </div>
  </div>`;
}

async function openAddTestSheet() {
  openSheet(`
    <div class="sheet-handle"></div>
    <h2>Додати аналіз для відстеження</h2>
    <label>Назва</label>
    <input id="test-label" placeholder="Напр. Загальний аналіз крові">
    <label>Періодичність (днів)</label>
    <input id="test-freq" type="number" value="365">
    <label>Дата останнього разу (якщо відомо)</label>
    <input id="test-last" type="date">
    <div class="btn-row">
      <button class="btn" id="test-save">Зберегти</button>
      <button class="btn ghost" id="test-cancel">Скасувати</button>
    </div>
  `);
  document.getElementById('test-cancel').onclick = closeSheet;
  document.getElementById('test-save').onclick = async () => {
    const label = document.getElementById('test-label').value.trim();
    const freq = parseInt(document.getElementById('test-freq').value, 10) || 365;
    const last = document.getElementById('test-last').value || null;
    if (!label) { toast('Введи назву'); return; }
    await dbPut('trackedTests', { key: uid(), label, freq, lastDate: last });
    const ps = await getPushSettings();
    if (ps.subscribed) syncRemindersToServer(ps.serverUrl).catch(() => {});
    closeSheet();
    render();
  };
}

function icsFor(test) {
  const nextDue = test.lastDate ? new Date(new Date(test.lastDate).getTime() + test.freq * 86400000) : new Date();
  const dt = nextDue.toISOString().slice(0, 10).replace(/-/g, '');
  const uidStr = 'mybioscan-' + test.key + '@local';
  return `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//My BioScan//UK
BEGIN:VEVENT
UID:${uidStr}
DTSTAMP:${dt}T090000Z
DTSTART;VALUE=DATE:${dt}
SUMMARY:${test.label} — час пройти обстеження
DESCRIPTION:Нагадування зі мого особистого додатку My BioScan.
BEGIN:VALARM
ACTION:DISPLAY
DESCRIPTION:${test.label}
TRIGGER:-P0D
END:VALARM
END:VEVENT
END:VCALENDAR`;
}

function downloadText(filename, content) {
  const blob = new Blob([content], { type: 'text/calendar' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- глобальні обробники подій усередині view ----------
function attachViewHandlers() {
  document.querySelectorAll('[data-open-record]').forEach((el) => {
    el.addEventListener('click', () => openRecordDetail(el.dataset.openRecord));
  });
  document.querySelectorAll('[data-marker]').forEach((el) => {
    el.addEventListener('click', () => {
      const k = el.dataset.marker;
      if (selectedMarkerKeys.has(k)) {
        if (selectedMarkerKeys.size > 1) selectedMarkerKeys.delete(k); // хоч один показник має лишитись обраним
      } else {
        selectedMarkerKeys.add(k);
      }
      render();
    });
  });
  const pinBtn = document.getElementById('btn-pin-markers');
  if (pinBtn) {
    pinBtn.addEventListener('click', async () => {
      await savePinnedMarkers([...selectedMarkerKeys]);
      toast('Вибір закріплено — відкриється таким самим наступного разу');
    });
  }
  if (currentTab === 'trends' && selectedMarkerKeys.size) drawTrendChart();

  document.querySelectorAll('[data-done]').forEach((el) => {
    el.addEventListener('click', async () => {
      const tests = await dbGetAll('trackedTests');
      const t = tests.find((x) => x.key === el.dataset.done);
      t.lastDate = todayISO();
      await dbPut('trackedTests', t);
      const ps = await getPushSettings();
      if (ps.subscribed) syncRemindersToServer(ps.serverUrl).catch(() => {});
      toast('Позначено виконаним');
      render();
    });
  });
  document.querySelectorAll('[data-ics]').forEach((el) => {
    el.addEventListener('click', async () => {
      const tests = await dbGetAll('trackedTests');
      const t = tests.find((x) => x.key === el.dataset.ics);
      downloadText(`${t.label}.ics`, icsFor(t));
    });
  });
  const seedBtn = document.getElementById('btn-seed-defaults');
  if (seedBtn) {
    seedBtn.addEventListener('click', async () => {
      for (const t of DEFAULT_TESTS) {
        await dbPut('trackedTests', { key: uid(), label: t.label, freq: t.freq, lastDate: null });
      }
      const ps = await getPushSettings();
      if (ps.subscribed) syncRemindersToServer(ps.serverUrl).catch(() => {});
      render();
    });
  }

  const enableBtn = document.getElementById('btn-enable-push');
  if (enableBtn) {
    enableBtn.addEventListener('click', async () => {
      const url = document.getElementById('push-server-url').value.trim();
      if (!url) { toast('Встав адресу сервера'); return; }
      enableBtn.textContent = 'Вмикаю…';
      try {
        await enablePush(url);
        toast('Сповіщення увімкнено ✓');
        render();
      } catch (e) {
        toast('Не вдалось: ' + e.message);
        enableBtn.textContent = 'Увімкнути сповіщення';
      }
    });
  }
  const disableBtn = document.getElementById('btn-disable-push');
  if (disableBtn) {
    disableBtn.addEventListener('click', async () => {
      await disablePush();
      toast('Сповіщення вимкнено');
      render();
    });
  }
  const testBtn = document.getElementById('btn-test-push');
  if (testBtn) {
    testBtn.addEventListener('click', async () => {
      testBtn.textContent = 'Надсилаю…';
      try {
        await sendTestPush();
        toast('Тестове сповіщення надіслано — має прийти за кілька секунд');
      } catch (e) {
        toast('Помилка: ' + e.message);
      }
      testBtn.textContent = 'Надіслати тестове';
    });
  }
}

// ---------- PUSH-СПОВІЩЕННЯ (опційно, через власний сервер) ----------
// Публічний VAPID-ключ — не секрет, безпечно тримати в коді.
const VAPID_PUBLIC_KEY = 'BNwlB4UxR7eKB4SwHNnI8ZWJccDdWtVyGxWoGaIlc6AFONbhXuiNXlr28Cetsz5LbM1COBn4ond5hr-BYirLzRE';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function getPushSettings() {
  try {
    const s = await reqToPromise(store('settings').get('push'));
    return (s && s.value) || { serverUrl: '', subscribed: false };
  } catch { return { serverUrl: '', subscribed: false }; }
}
async function savePushSettings(val) {
  await dbPut('settings', { key: 'push', value: val });
}

async function enablePush(serverUrl) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('Цей браузер не підтримує push-сповіщення');
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Дозвіл на сповіщення не надано');

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }

  await syncRemindersToServer(serverUrl, sub);
  await savePushSettings({ serverUrl, subscribed: true });
}

async function disablePush() {
  const settings = await getPushSettings();
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    if (settings.serverUrl) {
      try {
        await fetch(settings.serverUrl.replace(/\/$/, '') + '/unsubscribe', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
      } catch {}
    }
    await sub.unsubscribe();
  }
  await savePushSettings({ serverUrl: settings.serverUrl, subscribed: false });
}

// Надсилає серверу лише назви аналізів, періодичність і дати — без жодних
// медичних даних (без результатів, без фото/PDF).
async function syncRemindersToServer(serverUrl, subOverride) {
  const settings = subOverride ? { serverUrl, subscribed: true } : await getPushSettings();
  if (!settings.subscribed && !subOverride) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = subOverride || await reg.pushManager.getSubscription();
  if (!sub) return;
  const tests = await dbGetAll('trackedTests');
  const reminders = tests.map((t) => ({ key: t.key, label: t.label, freq: t.freq, lastDate: t.lastDate || null }));
  await fetch(serverUrl.replace(/\/$/, '') + '/subscribe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: sub.toJSON(), reminders }),
  });
}

async function sendTestPush() {
  const settings = await getPushSettings();
  if (!settings.serverUrl) throw new Error('Спершу вкажи адресу сервера');
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) throw new Error('Підписки ще немає');
  const res = await fetch(settings.serverUrl.replace(/\/$/, '') + '/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: sub.toJSON() }),
  });
  if (!res.ok) throw new Error('Сервер відповів помилкою');
}

// ---------- init ----------
(async function init() {
  db = await openDb();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  render();
})();
