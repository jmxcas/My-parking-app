'use strict';

/* ── Constants ────────────────────────────────────────────── */
const CATEGORIES = [
  { key: 'top',    label: 'Top',         placeholder: 'White linen shirt' },
  { key: 'bottom', label: 'Bottom',      placeholder: 'Navy chinos' },
  { key: 'outer',  label: 'Outerwear',   placeholder: 'Denim jacket' },
  { key: 'shoes',  label: 'Shoes',       placeholder: 'White sneakers' },
  { key: 'acc',    label: 'Accessories', placeholder: 'Watch, cap' },
];
const CAT_LABEL = Object.fromEntries(CATEGORIES.map(c => [c.key, c.label]));
const OCCASIONS = ['Work', 'Church', 'Casual', 'Date', 'Gym', 'Event', 'Travel', 'Home'];

/* ── Storage (IndexedDB) ──────────────────────────────────── */
// Entries (with a small thumbnail) live in "outfits"; full photos live in
// "photos" and are only loaded when viewed, so startup stays fast.
const DB = (() => {
  let dbPromise;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('worn', 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore('outfits', { keyPath: 'id' });
          req.result.createObjectStore('photos');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function run(stores, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result;
      fn(tx, r => { result = r; });
      tx.oncomplete = () => resolve(result);
      tx.onerror    = () => reject(tx.error);
      tx.onabort    = () => reject(tx.error);
    });
  }

  function getAll(store) {
    return run(store, 'readonly', (tx, set) => {
      const s = tx.objectStore(store);
      const vals = s.getAll();
      const keys = s.getAllKeys();
      keys.onsuccess = () => set(keys.result.map((k, i) => [k, vals.result[i]]));
    });
  }

  return {
    entries: () => getAll('outfits').then(rows => rows.map(r => r[1])),
    photos:  () => getAll('photos'),
    photo: id => run('photos', 'readonly', (tx, set) => {
      const r = tx.objectStore('photos').get(id);
      r.onsuccess = () => set(r.result || null);
    }),
    // photo: undefined = leave as is, null = remove, string = replace
    put: (entry, photo) => run(['outfits', 'photos'], 'readwrite', tx => {
      tx.objectStore('outfits').put(entry);
      if (photo === null) tx.objectStore('photos').delete(entry.id);
      else if (photo)     tx.objectStore('photos').put(photo, entry.id);
    }),
    remove: id => run(['outfits', 'photos'], 'readwrite', tx => {
      tx.objectStore('outfits').delete(id);
      tx.objectStore('photos').delete(id);
    }),
  };
})();

/* ── Helpers ──────────────────────────────────────────────── */
const $ = id => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const norm = s => s.trim().toLowerCase().replace(/\s+/g, ' ');
const uid  = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ── Dates (local "YYYY-MM-DD" keys) ──────────────────────── */
const pad     = n => String(n).padStart(2, '0');
const toKey   = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const todayKey = () => toKey(new Date());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const daysBetween = (a, b) => Math.round((fromKey(b) - fromKey(a)) / 86400000);

function lastSundayKey() {
  const t = new Date();
  return toKey(addDays(t, -(t.getDay() || 7)));
}

function longDate(key) {
  return fromKey(key).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

function shortDate(key) {
  const d = fromKey(key);
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

function ago(key) {
  const n = daysBetween(key, todayKey());
  if (n < 0)   return 'upcoming';
  if (n === 0) return 'today';
  if (n === 1) return 'yesterday';
  if (n < 14)  return `${n} days ago`;
  if (n < 60)  return `${Math.round(n / 7)} weeks ago`;
  if (n < 365) return `${Math.round(n / 30)} months ago`;
  const y = Math.round(n / 365);
  return y === 1 ? 'a year ago' : `${y} years ago`;
}

/* ── State ────────────────────────────────────────────────── */
const state = {
  entries: [],          // sorted newest first
  tab: 'today',
  calMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  closetSort: 'recent',
  closetQuery: '',
  stack: [],            // open screen ids, top last
  dayKey: null,
  itemKey: null,
  log: null,
};

function sortEntries() {
  state.entries.sort((a, b) =>
    a.date === b.date ? b.createdAt.localeCompare(a.createdAt) : b.date.localeCompare(a.date));
}

const entriesOn = key => state.entries.filter(e => e.date === key);

// Map of normalised item name → { name, cat, wears: [{date, id}] newest first }
function buildIndex() {
  const map = new Map();
  for (const e of state.entries) {
    for (const it of e.items) {
      const k = norm(it.name);
      let rec = map.get(k);
      if (!rec) map.set(k, rec = { key: k, name: it.name, cat: it.cat, wears: [] });
      rec.wears.push({ date: e.date, id: e.id });
    }
  }
  return map;
}

function streak() {
  const logged = new Set(state.entries.map(e => e.date));
  let d = new Date();
  if (!logged.has(toKey(d))) d = addDays(d, -1);
  let n = 0;
  while (logged.has(toKey(d))) { n++; d = addDays(d, -1); }
  return n;
}

/* ── Image processing ─────────────────────────────────────── */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
    img.src = url;
  });
}

function resize(img, max, quality) {
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width  = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

function openPhotoPicker(callback) {
  const input = document.createElement('input');
  input.type   = 'file';
  input.accept = 'image/*';
  // appended to body — display:none blocks the picker on iOS Safari
  input.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;top:0;left:0;';
  document.body.appendChild(input);
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.remove();
    if (!file) return;
    try {
      const img = await loadImage(file);
      callback({ full: resize(img, 1280, 0.8), thumb: resize(img, 360, 0.7) });
    } catch {
      showToast("Couldn't read that photo");
    }
  });
  input.click();
}

/* ── Toast & photo viewer ─────────────────────────────────── */
let toastTimer;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('visible'), 2200);
}

async function openPhotoViewer(id) {
  const entry = state.entries.find(e => e.id === id);
  const img = $('photo-viewer-img');
  img.src = entry?.thumb || '';
  $('photo-viewer').classList.add('visible');
  const full = await DB.photo(id);
  if (full) img.src = full;
}

$('photo-viewer').addEventListener('click', () => $('photo-viewer').classList.remove('visible'));

/* ── Navigation ───────────────────────────────────────────── */
function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.id === `tab-${tab}`));
  document.querySelectorAll('.tabbar-btn').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  $(`tab-${tab}`).querySelector('.tab-body').scrollTop = 0;
}

function pushScreen(id) {
  const el = $(id);
  el.style.zIndex = 20 + state.stack.length;
  el.querySelector('.screen-body').scrollTop = 0;
  // force layout so the slide-in transition runs from off-screen
  void el.offsetWidth;
  el.classList.add('open');
  state.stack.push(id);
}

function popScreen() {
  const id = state.stack.pop();
  if (id) $(id).classList.remove('open');
}

function popAll() {
  while (state.stack.length) popScreen();
}

/* ── Shared renderers ─────────────────────────────────────── */
function itemsList(e, linkItems = false) {
  const rows = CATEGORIES.flatMap(c => {
    const names = e.items.filter(it => it.cat === c.key).map(it => it.name);
    if (!names.length) return [];
    const val = linkItems
      ? names.map(n => `<button class="item-link" data-open-item="${esc(norm(n))}">${esc(n)}</button>`).join(', ')
      : esc(names.join(', '));
    return [`<li><span class="cat">${c.label}</span><span class="val">${val}</span></li>`];
  });
  return rows.length ? `<ul class="item-list">${rows.join('')}</ul>` : '';
}

function outfitCard(e) {
  return `
    <article class="outfit-card" data-open-day="${e.date}">
      ${e.thumb
        ? `<img class="outfit-thumb" src="${e.thumb}" alt="" data-photo="${e.id}">`
        : `<div class="outfit-thumb placeholder">${hangerSvg}</div>`}
      <div class="outfit-info">
        ${e.occasion ? `<span class="tag">${esc(e.occasion)}</span>` : ''}
        ${itemsList(e) || '<p class="muted">Photo only</p>'}
        ${e.note ? `<p class="note">${esc(e.note)}</p>` : ''}
      </div>
    </article>`;
}

const hangerSvg = '<svg viewBox="0 0 24 24"><path d="M12 5a2 2 0 1 1 2 2c-1 0-2 .6-2 1.5V9"/><path d="M12 9 3 15.5c-.8.6-.4 1.5.5 1.5h17c.9 0 1.3-.9.5-1.5Z"/></svg>';

/* ── Today tab ────────────────────────────────────────────── */
function renderToday() {
  const tk = todayKey();
  const todays = entriesOn(tk);
  const s = streak();

  let html = `
    <div class="today-head">
      <p class="eyebrow">${esc(longDate(tk))}</p>
      ${s > 1 ? `<span class="streak">${s}-day streak</span>` : ''}
    </div>`;

  if (todays.length) {
    html += todays.map(outfitCard).join('');
    html += `<button class="btn-secondary" data-log-date="${tk}">Add another look</button>`;
  } else {
    html += `
      <button class="log-cta" data-log-date="${tk}">
        <div class="log-cta-icon"><svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></div>
        <strong>What are you wearing today?</strong>
        <span>Tap to log your outfit</span>
      </button>`;
  }

  const ls = lastSundayKey();
  const sundays = entriesOn(ls);
  html += `<div class="section-label">Last Sunday · ${esc(shortDate(ls))}</div>`;
  html += sundays.length
    ? sundays.map(outfitCard).join('')
    : `<button class="empty-row" data-log-date="${ls}">Nothing logged — add it now<span class="chev">›</span></button>`;

  html += `<div class="section-label">Past two weeks</div><div class="strip">`;
  for (let i = 1; i <= 14; i++) {
    const key = toKey(addDays(new Date(), -i));
    const e = entriesOn(key)[0];
    const d = fromKey(key);
    html += `
      <button class="strip-day${e ? ' has' : ''}" data-open-day="${key}">
        <div class="strip-img">${e?.thumb ? `<img src="${e.thumb}" alt="">` : e ? hangerSvg : ''}</div>
        <span class="strip-wd">${d.toLocaleDateString(undefined, { weekday: 'short' })}</span>
        <span class="strip-d">${d.getDate()}</span>
      </button>`;
  }
  html += `</div>`;

  $('today-body').innerHTML = html;
}

/* ── Calendar tab ─────────────────────────────────────────── */
function renderCalendar() {
  const m = state.calMonth;
  $('cal-title').textContent = m.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const byDate = new Map();
  for (const e of state.entries) {
    const cur = byDate.get(e.date);
    // prefer an entry with a photo for the tile
    if (!cur || (!cur.thumb && e.thumb)) byDate.set(e.date, e);
  }

  const tk = todayKey();
  const lead = m.getDay();
  const days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
  let html = '<div class="cal-cell blank"></div>'.repeat(lead);
  for (let d = 1; d <= days; d++) {
    const key = toKey(new Date(m.getFullYear(), m.getMonth(), d));
    const e = byDate.get(key);
    const cls = ['cal-cell'];
    if (key === tk) cls.push('today');
    if (key > tk)   cls.push('future');
    if (e)          cls.push('has');
    html += `
      <button class="${cls.join(' ')}" data-open-day="${key}" ${key > tk ? 'disabled' : ''}>
        ${e?.thumb ? `<img src="${e.thumb}" alt="">` : ''}
        <span class="cal-num">${d}</span>
        ${e && !e.thumb ? '<span class="cal-dot"></span>' : ''}
      </button>`;
  }
  $('cal-grid').innerHTML = html;
}

$('cal-weekdays').innerHTML = [...Array(7)].map((_, i) =>
  `<span>${new Date(2023, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'narrow' })}</span>`).join('');

$('cal-prev').addEventListener('click', () => {
  state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1);
  renderCalendar();
});
$('cal-next').addEventListener('click', () => {
  state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1);
  renderCalendar();
});
$('cal-today').addEventListener('click', () => {
  const t = new Date();
  state.calMonth = new Date(t.getFullYear(), t.getMonth(), 1);
  renderCalendar();
});

/* ── Closet tab ───────────────────────────────────────────── */
function renderCloset() {
  const q = norm(state.closetQuery);
  let items = [...buildIndex().values()];
  if (q) items = items.filter(r => r.key.includes(q) || norm(CAT_LABEL[r.cat]).includes(q));

  const last = r => r.wears[0].date;
  if (state.closetSort === 'recent') items.sort((a, b) => last(b).localeCompare(last(a)));
  if (state.closetSort === 'oldest') items.sort((a, b) => last(a).localeCompare(last(b)));
  if (state.closetSort === 'most')   items.sort((a, b) => b.wears.length - a.wears.length || last(b).localeCompare(last(a)));

  if (!items.length) {
    $('closet-list').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">${hangerSvg}</div>
        <h2>${q ? 'No matches' : 'Your closet is empty'}</h2>
        <p>${q ? 'Try another word, like “shirt” or a colour.' : 'Items you log will show up here, with when you last wore them.'}</p>
      </div>`;
    return;
  }

  $('closet-list').innerHTML = `<div class="group">${items.map(r => `
    <button class="group-row closet-row" data-open-item="${esc(r.key)}">
      <div>
        <strong>${esc(r.name)}</strong>
        <small>${CAT_LABEL[r.cat] || ''} · worn ${r.wears.length}×</small>
      </div>
      <span class="closet-last">${esc(ago(last(r)))}</span>
      <span class="chev">›</span>
    </button>`).join('')}</div>`;
}

$('closet-search').addEventListener('input', e => {
  state.closetQuery = e.target.value;
  renderCloset();
});

$('closet-sort').addEventListener('click', e => {
  const btn = e.target.closest('[data-sort]');
  if (!btn) return;
  state.closetSort = btn.dataset.sort;
  document.querySelectorAll('#closet-sort .seg-btn').forEach(b => b.classList.toggle('active', b === btn));
  renderCloset();
});

/* ── Day screen ───────────────────────────────────────────── */
function renderDay() {
  const key = state.dayKey;
  if (!key) return;
  $('day-title').textContent = shortDate(key);
  const list = entriesOn(key);

  if (!list.length) {
    $('day-body').innerHTML = `
      <p class="eyebrow">${esc(longDate(key))}</p>
      <div class="empty-state">
        <div class="empty-icon">${hangerSvg}</div>
        <h2>Nothing logged</h2>
        <p>Remember what you wore? You can still add it.</p>
      </div>
      <button class="btn-primary" data-log-date="${key}">Log Outfit for This Day</button>`;
    return;
  }

  const index = buildIndex();
  $('day-body').innerHTML = `<p class="eyebrow">${esc(longDate(key))} · ${esc(ago(key))}</p>` + list.map(e => {
    // for each item: when was it worn before this day?
    const repeats = e.items.map(it => {
      const prev = index.get(norm(it.name))?.wears.find(w => w.date < key);
      return prev ? `<li>${esc(it.name)} — also worn ${esc(shortDate(prev.date))}</li>` : '';
    }).join('');
    return `
      <article class="day-entry">
        ${e.thumb ? `<img class="day-photo" src="${e.thumb}" alt="" data-photo="${e.id}" data-full="${e.id}">` : ''}
        <div class="day-card">
          ${e.occasion ? `<span class="tag">${esc(e.occasion)}</span>` : ''}
          ${itemsList(e, true) || '<p class="muted">No items listed</p>'}
          ${e.note ? `<p class="note">${esc(e.note)}</p>` : ''}
          ${repeats ? `<ul class="repeats">${repeats}</ul>` : ''}
        </div>
        <button class="btn-secondary" data-edit="${e.id}">Edit</button>
      </article>`;
  }).join('') + `<button class="link-btn" data-log-date="${key}">Add another look for this day</button>`;

  // swap thumbnails for full-resolution photos
  $('day-body').querySelectorAll('[data-full]').forEach(async img => {
    const full = await DB.photo(img.dataset.full);
    if (full) img.src = full;
  });
}

function openDay(key) {
  state.dayKey = key;
  renderDay();
  pushScreen('screen-day');
}

/* ── Item screen ──────────────────────────────────────────── */
function renderItem() {
  const rec = buildIndex().get(state.itemKey);
  if (!rec) { $('item-body').innerHTML = ''; return; }
  $('item-title').textContent = rec.name;

  const first = rec.wears[rec.wears.length - 1].date;
  const byId = new Map(state.entries.map(e => [e.id, e]));
  $('item-body').innerHTML = `
    <div class="stats">
      <div><strong>${rec.wears.length}</strong><span>times worn</span></div>
      <div><strong>${esc(ago(rec.wears[0].date))}</strong><span>last worn</span></div>
      <div><strong>${esc(fromKey(first).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }))}</strong><span>first logged</span></div>
    </div>
    <div class="section-label">${esc(CAT_LABEL[rec.cat] || 'Item')} · every time you wore it</div>
    <div class="group">${rec.wears.map(w => {
      const e = byId.get(w.id);
      return `
        <button class="group-row wear-row" data-open-day="${w.date}">
          <div class="wear-thumb">${e?.thumb ? `<img src="${e.thumb}" alt="">` : hangerSvg}</div>
          <div>
            <strong>${esc(shortDate(w.date))}</strong>
            <small>${esc(ago(w.date))}${e?.occasion ? ' · ' + esc(e.occasion) : ''}</small>
          </div>
          <span class="chev">›</span>
        </button>`;
    }).join('')}</div>`;
}

function openItem(key) {
  state.itemKey = key;
  renderItem();
  pushScreen('screen-item');
}

/* ── Log / edit screen ────────────────────────────────────── */
function openLog({ entry = null, date = todayKey() } = {}) {
  state.log = {
    id: entry?.id || null,
    photo: undefined,           // undefined = unchanged
    thumb: entry?.thumb || null,
    occasion: entry?.occasion || null,
  };

  $('log-title').textContent = entry ? 'Edit Outfit' : 'Log Outfit';
  $('log-date').value = entry?.date || date;
  $('log-date').max = todayKey();
  $('log-note').value = entry?.note || '';
  $('log-delete').classList.toggle('hidden', !entry);

  const index = [...buildIndex().values()];
  $('log-items').innerHTML = CATEGORIES.map(c => {
    const val = entry ? entry.items.filter(it => it.cat === c.key).map(it => it.name).join(', ') : '';
    const opts = index.filter(r => r.cat === c.key).map(r => `<option value="${esc(r.name)}">`).join('');
    return `
      <div class="item-field">
        <label class="group-row">
          <span>${c.label}</span>
          <input type="text" data-cat="${c.key}" list="dl-${c.key}" placeholder="${esc(c.placeholder)}"
                 value="${esc(val)}" autocomplete="off" autocapitalize="sentences">
        </label>
        <datalist id="dl-${c.key}">${opts}</datalist>
        <p class="item-hint" data-hint="${c.key}"></p>
      </div>`;
  }).join('');
  $('log-items').querySelectorAll('input').forEach(updateHint);

  renderOccasions();
  renderLogPhoto(state.log.thumb);
  pushScreen('screen-log');
}

function renderOccasions() {
  $('log-occasions').innerHTML = OCCASIONS.map(o =>
    `<button class="chip${state.log.occasion === o ? ' active' : ''}" data-occasion="${o}">${o}</button>`).join('');
}

function renderLogPhoto(src) {
  const slot = $('log-photo');
  const img = slot.querySelector('img');
  slot.classList.toggle('filled', !!src);
  img.classList.toggle('hidden', !src);
  slot.querySelector('.photo-empty').classList.toggle('hidden', !!src);
  $('log-photo-remove').classList.toggle('hidden', !src);
  img.src = src || '';
}

const splitItems = s => s.split(',').map(x => x.trim()).filter(Boolean);

// "Last worn Sun, Sep 20 · 7 days ago" under an item field, to help avoid repeats
function updateHint(input) {
  const hint = $('log-items').querySelector(`[data-hint="${input.dataset.cat}"]`);
  const date = $('log-date').value;
  const index = buildIndex();
  const msgs = splitItems(input.value).flatMap(name => {
    const prev = index.get(norm(name))?.wears.find(w => w.id !== state.log.id && w.date <= date);
    return prev ? [`${name}: last worn ${shortDate(prev.date)} (${ago(prev.date)})`] : [];
  });
  hint.textContent = msgs.join(' · ');
}

$('log-items').addEventListener('input', e => {
  if (e.target.matches('input[data-cat]')) updateHint(e.target);
});

$('log-date').addEventListener('change', () => {
  $('log-items').querySelectorAll('input').forEach(updateHint);
});

$('log-occasions').addEventListener('click', e => {
  const btn = e.target.closest('[data-occasion]');
  if (!btn) return;
  state.log.occasion = state.log.occasion === btn.dataset.occasion ? null : btn.dataset.occasion;
  renderOccasions();
});

$('log-photo').addEventListener('click', e => {
  if (e.target.closest('#log-photo-remove')) return;
  openPhotoPicker(({ full, thumb }) => {
    state.log.photo = full;
    state.log.thumb = thumb;
    renderLogPhoto(full);
  });
});

$('log-photo-remove').addEventListener('click', () => {
  state.log.photo = null;
  state.log.thumb = null;
  renderLogPhoto(null);
});

$('log-cancel').addEventListener('click', popScreen);

$('log-save').addEventListener('click', async () => {
  const log = state.log;
  const date = $('log-date').value;
  if (!date) { showToast('Pick a date'); return; }

  const items = [...$('log-items').querySelectorAll('input[data-cat]')].flatMap(input =>
    splitItems(input.value).map(name => ({ cat: input.dataset.cat, name })));
  if (!items.length && !log.thumb) {
    showToast('Add a photo or at least one item');
    return;
  }

  const existing = log.id && state.entries.find(e => e.id === log.id);
  const now = new Date().toISOString();
  const entry = {
    id: log.id || uid(),
    date,
    items,
    occasion: log.occasion,
    note: $('log-note').value.trim(),
    thumb: log.thumb,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  try {
    await DB.put(entry, log.photo);
  } catch {
    showToast("Couldn't save — storage may be full");
    return;
  }

  state.entries = state.entries.filter(e => e.id !== entry.id).concat(entry);
  refresh();
  popScreen();
  showToast(existing ? 'Changes saved' : 'Outfit logged');
});

$('log-delete').addEventListener('click', async () => {
  if (!confirm('Delete this outfit? This can’t be undone.')) return;
  await DB.remove(state.log.id);
  state.entries = state.entries.filter(e => e.id !== state.log.id);
  refresh();
  popScreen();
  showToast('Outfit deleted');
});

/* ── Backup ───────────────────────────────────────────────── */
$('btn-export').addEventListener('click', async () => {
  const photos = Object.fromEntries(await DB.photos());
  const data = { app: 'worn', version: 1, exportedAt: new Date().toISOString(), entries: state.entries, photos };
  const name = `worn-backup-${todayKey()}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });

  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Worn backup' }); } catch { /* cancelled */ }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('btn-import').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;top:0;left:0;';
  document.body.appendChild(input);
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.remove();
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'worn' || !Array.isArray(data.entries)) throw new Error('not a backup');
      const valid = data.entries.filter(e =>
        e && typeof e.id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && Array.isArray(e.items));
      for (const e of valid) await DB.put(e, data.photos?.[e.id]);
      state.entries = await DB.entries();
      refresh();
      showToast(`Imported ${valid.length} outfit${valid.length === 1 ? '' : 's'}`);
    } catch {
      showToast("That file isn't a Worn backup");
    }
  });
  input.click();
});

/* ── Global events ────────────────────────────────────────── */
document.addEventListener('click', e => {
  const t = e.target;
  let el;
  if ((el = t.closest('[data-photo]')))      { openPhotoViewer(el.dataset.photo); return; }
  if ((el = t.closest('[data-open-item]')))  { openItem(el.dataset.openItem); return; }
  if ((el = t.closest('[data-log-date]')))   { openLog({ date: el.dataset.logDate }); return; }
  if ((el = t.closest('[data-edit]')))       { openLog({ entry: state.entries.find(x => x.id === el.dataset.edit) }); return; }
  if ((el = t.closest('[data-open-day]')))   { openDay(el.dataset.openDay); return; }
  if (t.closest('[data-back]'))              { popScreen(); return; }
  if ((el = t.closest('[data-tab]')))        { popAll(); switchTab(el.dataset.tab); }
});

$('btn-add').addEventListener('click', () => openLog());

// Re-render when the app comes back so "today" rolls over at midnight
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') renderToday();
});

function refresh() {
  sortEntries();
  renderToday();
  renderCalendar();
  renderCloset();
  if (state.stack.includes('screen-day'))  renderDay();
  if (state.stack.includes('screen-item')) renderItem();
}

/* ── Boot ─────────────────────────────────────────────────── */
(async () => {
  try {
    state.entries = await DB.entries();
  } catch {
    showToast('Storage unavailable — outfits won’t be saved');
  }
  refresh();
})();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
