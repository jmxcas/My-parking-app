/* ── Storage helpers ──────────────────────────────────────── */
const STORAGE_KEY = 'parked_entries';

function loadEntries() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { return []; }
}

function saveEntries(entries) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

function addEntry(direction, level, side, photo) {
  const entries = loadEntries();
  const entry = {
    id: Date.now(),
    direction,
    level,
    side,
    photo: photo || null,
    timestamp: new Date().toISOString()
  };
  entries.unshift(entry);
  try {
    saveEntries(entries);
  } catch {
    // localStorage quota hit — save without photo
    entry.photo = null;
    saveEntries(entries);
    showToast('Storage full — saved without photo');
  }
  return entry;
}

function deleteEntry(id) {
  const entries = loadEntries().filter(e => e.id !== id);
  saveEntries(entries);
}

function formatTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diffMins  = Math.floor((now - d) / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays  = Math.floor(diffHours / 24);

  if (diffMins < 1)   return 'Just now';
  if (diffMins < 60)  return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'Yesterday';

  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/* ── Image compression ────────────────────────────────────── */
function compressImage(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const MAX = 900;
        let w = img.width, h = img.height;
        if (w > h && w > MAX) { h = Math.round(h * MAX / w); w = MAX; }
        else if (h > MAX)     { w = Math.round(w * MAX / h); h = MAX; }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.72));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ── Photo viewer ─────────────────────────────────────────── */
const photoViewer    = document.getElementById('photo-viewer');
const photoViewerImg = document.getElementById('photo-viewer-img');

function openPhotoViewer(src) {
  photoViewerImg.src = src;
  photoViewer.classList.add('visible');
}

function closePhotoViewer() {
  photoViewer.classList.remove('visible');
}

document.getElementById('photo-viewer-close').addEventListener('click', closePhotoViewer);
photoViewer.addEventListener('click', e => {
  if (e.target === photoViewer || e.target === photoViewerImg) closePhotoViewer();
});

/* ── Screen management ────────────────────────────────────── */
const screens = {
  home:    document.getElementById('screen-home'),
  log:     document.getElementById('screen-log'),
  history: document.getElementById('screen-history'),
};

let currentScreen = 'home';

function navigate(to) {
  const from = currentScreen;
  if (from === to) return;

  const fromEl = screens[from];
  const toEl   = screens[to];
  const goingBack = (to === 'home');

  if (goingBack) {
    fromEl.classList.remove('active');
    fromEl.classList.add('slide-out');
    toEl.classList.remove('slide-out');
    toEl.classList.add('active');
  } else {
    fromEl.classList.add('slide-out');
    fromEl.classList.remove('active');
    toEl.classList.add('active');
  }

  fromEl.addEventListener('transitionend', function handler() {
    fromEl.classList.remove('slide-out');
    fromEl.removeEventListener('transitionend', handler);
  });

  currentScreen = to;
}

/* ── Toast ────────────────────────────────────────────────── */
const toastEl = document.getElementById('toast');
let toastTimer = null;

function showToast(msg) {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

/* ── Home screen ──────────────────────────────────────────── */
const homeEmpty     = document.getElementById('home-empty');
const homeCard      = document.getElementById('home-card');
const cardDirection = document.getElementById('card-direction');
const cardLevel     = document.getElementById('card-level');
const cardSide      = document.getElementById('card-side');
const cardTime      = document.getElementById('card-time');
const cardPhotoWrap = document.getElementById('card-photo-wrap');
const cardPhotoImg  = document.getElementById('card-photo');

function renderHome() {
  const entries = loadEntries();
  if (entries.length === 0) {
    homeEmpty.classList.remove('hidden');
    homeCard.classList.add('hidden');
    return;
  }

  homeEmpty.classList.add('hidden');
  homeCard.classList.remove('hidden');
  const e = entries[0];
  cardDirection.textContent = e.direction;
  cardLevel.textContent     = `L${e.level}`;
  cardSide.textContent      = e.side;
  cardTime.textContent      = 'Logged ' + formatTime(e.timestamp);

  if (e.photo) {
    cardPhotoImg.src = e.photo;
    cardPhotoImg.onclick = () => openPhotoViewer(e.photo);
    cardPhotoWrap.classList.remove('hidden');
  } else {
    cardPhotoWrap.classList.add('hidden');
    cardPhotoImg.src = '';
    cardPhotoImg.onclick = null;
  }
}

document.getElementById('btn-log-new').addEventListener('click', () => {
  resetLog();
  navigate('log');
});

document.getElementById('btn-history').addEventListener('click', () => {
  renderHistory();
  navigate('history');
});

/* ── Log screen ───────────────────────────────────────────── */
let logState = { direction: null, level: null, side: null, step: 1, photo: null };

const stepEls = [
  document.getElementById('step-1'),
  document.getElementById('step-2'),
  document.getElementById('step-3'),
  document.getElementById('step-confirm'),
];

const dotEls = [
  document.getElementById('dot-1'),
  document.getElementById('dot-2'),
  document.getElementById('dot-3'),
];

const btnAddPhoto      = document.getElementById('btn-add-photo');
const photoPreviewWrap = document.getElementById('photo-preview-wrap');
const photoPreviewImg  = document.getElementById('photo-preview-img');

function openCameraPicker(callback) {
  const input = document.createElement('input');
  input.type   = 'file';
  input.accept = 'image/*';
  // appended to body — display:none blocks the picker on iOS Safari
  input.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;top:0;left:0;';
  document.body.appendChild(input);
  input.addEventListener('change', async () => {
    const file = input.files[0];
    document.body.removeChild(input);
    if (!file) return;
    callback(await compressImage(file));
  });
  input.click();
}

function resetLog() {
  logState = { direction: null, level: null, side: null, step: 1, photo: null };
  btnAddPhoto.classList.remove('hidden');
  photoPreviewWrap.classList.add('hidden');
  photoPreviewImg.src = '';
  showStep(1);
}

function showStep(n) {
  logState.step = n;
  stepEls.forEach((el, i) => el.classList.toggle('visible', i === n - 1));
  dotEls.forEach((dot, i) => {
    dot.classList.remove('active', 'done');
    if (i + 1 === n)    dot.classList.add('active');
    else if (i + 1 < n) dot.classList.add('done');
  });
}

// Step 1 – direction
document.querySelectorAll('[data-dir]').forEach(btn => {
  btn.addEventListener('click', () => {
    logState.direction = btn.dataset.dir;
    showStep(2);
  });
});

// Step 2 – level
document.querySelectorAll('[data-level]').forEach(btn => {
  btn.addEventListener('click', () => {
    logState.level = btn.dataset.level;
    showStep(3);
  });
});

// Step 3 – side
document.querySelectorAll('[data-side]').forEach(btn => {
  btn.addEventListener('click', () => {
    logState.side = btn.dataset.side;
    document.getElementById('confirm-text').innerHTML =
      `${logState.direction}<span> · </span>L${logState.level}<span> · </span>${logState.side}`;
    showStep(4);
  });
});

// Camera
btnAddPhoto.addEventListener('click', () => {
  openCameraPicker(dataUrl => {
    logState.photo = dataUrl;
    photoPreviewImg.src = dataUrl;
    btnAddPhoto.classList.add('hidden');
    photoPreviewWrap.classList.remove('hidden');
  });
});

document.getElementById('btn-retake').addEventListener('click', () => {
  openCameraPicker(dataUrl => {
    logState.photo = dataUrl;
    photoPreviewImg.src = dataUrl;
  });
});

document.getElementById('btn-save').addEventListener('click', () => {
  addEntry(logState.direction, logState.level, logState.side, logState.photo);
  renderHome();
  navigate('home');
  showToast('Spot saved');
});

document.getElementById('btn-start-over').addEventListener('click', resetLog);
document.getElementById('btn-log-back').addEventListener('click', () => navigate('home'));

/* ── History screen ───────────────────────────────────────── */
const historyList  = document.getElementById('history-list');
const historyEmpty = document.getElementById('history-empty');
const historyHint  = document.getElementById('history-hint');

let activeSwiped = null;

function renderHistory() {
  const entries = loadEntries().slice(0, 10);
  historyList.innerHTML = '';

  if (entries.length === 0) {
    historyEmpty.classList.remove('hidden');
    historyHint.classList.add('hidden');
    return;
  }

  historyEmpty.classList.add('hidden');
  historyHint.classList.remove('hidden');

  entries.forEach(entry => {
    const wrapper = document.createElement('div');
    wrapper.className = 'history-item-wrapper';
    wrapper.dataset.id = entry.id;

    const bg = document.createElement('div');
    bg.className = 'history-delete-bg';
    bg.innerHTML = '<span>Delete</span>';

    const card = document.createElement('div');
    card.className = 'history-card';
    card.innerHTML = `
      <div class="history-spot">
        <span class="history-direction">${entry.direction}</span>
        <span class="history-sep">·</span>
        <span class="history-level-side">L${entry.level}</span>
        <span class="history-sep">·</span>
        <span class="history-level-side">${entry.side}</span>
      </div>
      <div class="history-right">
        <div class="history-time">${formatTime(entry.timestamp)}</div>
      </div>
    `;

    if (entry.photo) {
      const thumb = document.createElement('img');
      thumb.className = 'history-thumb';
      thumb.src = entry.photo;
      thumb.alt = 'Spot photo';
      thumb.addEventListener('click', e => {
        e.stopPropagation();
        openPhotoViewer(entry.photo);
      });
      card.querySelector('.history-right').prepend(thumb);
    }

    wrapper.appendChild(bg);
    wrapper.appendChild(card);
    historyList.appendChild(wrapper);

    attachSwipe(wrapper, card, bg, entry.id);
  });
}

function attachSwipe(wrapper, card, bg, id) {
  let startX = 0, startY = 0;
  let dragging = false, verticalLock = false, currentX = 0;
  const SNAP_THRESHOLD = 40;
  const SNAP_OPEN = 90;

  card.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    dragging = false;
    verticalLock = false;
    currentX = card.classList.contains('is-swiped') ? -SNAP_OPEN : 0;
  }, { passive: true });

  card.addEventListener('touchmove', e => {
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;

    if (!dragging && !verticalLock) {
      if (Math.abs(dy) > Math.abs(dx) + 4) { verticalLock = true; return; }
      if (Math.abs(dx) > 6) dragging = true;
    }
    if (verticalLock || !dragging) return;

    e.preventDefault();
    let targetX = currentX + dx;
    if (targetX > 0) targetX = 0;
    if (targetX < -SNAP_OPEN) targetX = -(SNAP_OPEN + ((-targetX) - SNAP_OPEN) * 0.25);

    card.style.transition = 'none';
    card.style.transform  = `translateX(${targetX}px)`;
  }, { passive: false });

  card.addEventListener('touchend', e => {
    if (verticalLock) return;
    const totalDrag = currentX + (e.changedTouches[0].clientX - startX);
    card.style.transition = '';
    card.style.transform  = '';
    totalDrag < -SNAP_THRESHOLD ? openCard(card) : closeCard(card);
  }, { passive: true });

  bg.addEventListener('click', () => performDelete(wrapper, id));
}

function openCard(card) {
  if (activeSwiped && activeSwiped !== card) closeCard(activeSwiped);
  card.classList.add('is-swiped');
  activeSwiped = card;
}

function closeCard(card) {
  card.classList.remove('is-swiped');
  if (activeSwiped === card) activeSwiped = null;
}

function performDelete(wrapper, id) {
  const card = wrapper.querySelector('.history-card');
  card.style.transition = 'transform 280ms cubic-bezier(0.4,0,1,1)';
  card.style.transform  = 'translateX(-110%)';
  wrapper.style.transition = 'max-height 300ms ease, opacity 300ms ease, margin-bottom 300ms ease';
  wrapper.style.overflow   = 'hidden';
  wrapper.style.maxHeight  = wrapper.offsetHeight + 'px';

  card.addEventListener('transitionend', function h() {
    card.removeEventListener('transitionend', h);
    wrapper.style.maxHeight    = '0';
    wrapper.style.opacity      = '0';
    wrapper.style.marginBottom = '0';
    wrapper.addEventListener('transitionend', function done() {
      wrapper.removeEventListener('transitionend', done);
      wrapper.remove();
      deleteEntry(id);
      renderHome();
      showToast('Entry deleted');
      if (historyList.children.length === 0) {
        historyEmpty.classList.remove('hidden');
        historyHint.classList.add('hidden');
      }
    });
  });
}

document.getElementById('screen-history').addEventListener('touchstart', e => {
  if (!activeSwiped) return;
  const wrapper = activeSwiped.closest('.history-item-wrapper');
  if (wrapper && !wrapper.contains(e.target)) closeCard(activeSwiped);
}, { passive: true });

document.getElementById('btn-history-back').addEventListener('click', () => navigate('home'));

/* ── Init ─────────────────────────────────────────────────── */
renderHome();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
