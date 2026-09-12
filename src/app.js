/* img-taggr — wiring: folder loading, filmstrip, inspector, save. */

import {
  state, on, emit, selected, editedPhotos, isEdited, commit, undo, redo,
  dtToMs, msToDt, normDt, roundCoord,
} from './state.js';
import * as MapView from './map.js';
import * as TL from './timeline.js';
import { createBackend } from './backend.js';

/** Desktop or browser engine — chosen once, at boot. */
const backend = await createBackend();
const $ = (id) => document.getElementById(id);

/* ── Toast ─────────────────────────────────────────────────────── */
let toastTimer;
function toast(msg, isErr = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), isErr ? 7000 : 3800);
}

/* ── Loading a folder ──────────────────────────────────────────── */
async function openFolder() {
  $('btnOpen').disabled = true;
  const prevLabel = $('folderLabel').textContent;
  try {
    $('folderLabel').textContent = 'Reading…';
    const res = await backend.pickSource();
    if (!res) { $('folderLabel').textContent = prevLabel; return; }
    state.folder = res.label;
    state.selection.clear();
    state.undo.length = 0;
    state.redo.length = 0;
    state.photos = res.photos.map((p) => ({
      ...p,
      id: p.path,
      thumb: null,
      // Keep the as-read values so "edited" is always a real comparison rather
      // than a flag we have to remember to set.
      orig: { datetime: p.datetime, offset: p.offset, lat: roundCoord(p.lat), lon: roundCoord(p.lon) },
      lat: roundCoord(p.lat),
      lon: roundCoord(p.lon),
    }));

    $('folderLabel').textContent = res.label.length > 44 ? `…${res.label.slice(-43)}` : res.label;
    $('folderLabel').title = res.label;
    buildStrip();
    emit('change');
    MapView.fit();
    toast(
      `${state.photos.length} photo${state.photos.length === 1 ? '' : 's'}` +
      (res.unreadable ? ` · ${res.unreadable} unreadable` : '')
    );
    loadThumbs();
  } catch (e) {
    toast(String(e), true);
    $('folderLabel').textContent = '';
  } finally {
    $('btnOpen').disabled = false;
  }
}

/** Fetch thumbnails with bounded concurrency so a big folder stays responsive. */
async function loadThumbs() {
  const queue = state.photos.slice();
  const token = state.folder;
  let dirty = false;
  const flush = () => { if (dirty) { dirty = false; syncStrip(); MapView.render(); TL.render(); } };
  const ticker = setInterval(flush, 220);

  const worker = async () => {
    while (queue.length) {
      if (state.folder !== token) return;
      const p = queue.shift();
      try {
        p.thumb = await backend.loadThumb(p);
        if (p.thumb) dirty = true;
      } catch { /* a thumbnail is a nicety; never let it break the session */ }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  clearInterval(ticker);
  flush();
}

/* ── Filmstrip ─────────────────────────────────────────────────── */
let lastClicked = null;

function buildStrip() {
  const list = $('stripList');
  const frag = document.createDocumentFragment();
  for (const p of state.photos) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = p.id;
    card.innerHTML =
      '<div class="th"></div><div class="meta">' +
      '<div class="nm"></div><div class="sub"></div>' +
      '<div class="flags"><i class="flag" title="has date"></i><i class="flag" title="has location"></i></div>' +
      '</div>';
    card.querySelector('.nm').textContent = p.name;
    card.querySelector('.th').dataset.ext = p.ext || '?';
    p._el = card;
    frag.appendChild(card);
  }
  list.replaceChildren(frag);
}

function syncStrip() {
  for (const p of state.photos) {
    const el = p._el;
    if (!el) continue;
    el.classList.toggle('sel', state.selection.has(p.id));
    el.classList.toggle('edited', isEdited(p));
    if (p.thumb && el._thumb !== p.thumb) {
      el.querySelector('.th').style.backgroundImage = `url('${p.thumb}')`;
      el._thumb = p.thumb;
    }
    el.querySelector('.sub').textContent = p.datetime
      ? p.datetime.slice(0, 16).replace('T', ' ')
      : 'no date';
    const flags = el.querySelectorAll('.flag');
    flags[0].classList.toggle('on', !!p.datetime);
    flags[1].classList.toggle('on', p.lat != null);
  }
  const n = state.photos.length;
  $('stripCount').textContent = n
    ? `${state.selection.size ? `${state.selection.size} of ${n}` : n} photo${n === 1 ? '' : 's'}`
    : 'No photos';
  $('btnSelectAll').disabled = !n;
}

$('stripList').addEventListener('click', (ev) => {
  const card = ev.target.closest('.card');
  if (!card) return;
  const id = card.dataset.id;
  const idx = state.photos.findIndex((p) => p.id === id);

  if (ev.shiftKey && lastClicked !== null) {
    const [a, b] = [lastClicked, idx].sort((x, y) => x - y);
    for (let i = a; i <= b; i++) state.selection.add(state.photos[i].id);
  } else if (ev.ctrlKey || ev.metaKey) {
    state.selection.has(id) ? state.selection.delete(id) : state.selection.add(id);
    lastClicked = idx;
  } else {
    state.selection.clear();
    state.selection.add(id);
    lastClicked = idx;
  }
  emit('change');
});

$('btnSelectAll').addEventListener('click', () => {
  const all = state.selection.size === state.photos.length;
  state.selection.clear();
  if (!all) for (const p of state.photos) state.selection.add(p.id);
  emit('change');
});

/* ── Inspector ─────────────────────────────────────────────────── */
/** Shared value across a selection, or the MULTI sentinel. */
const MULTI = Symbol('multiple');
function common(sel, fn) {
  if (!sel.length) return null;
  const first = fn(sel[0]);
  return sel.every((p) => fn(p) === first) ? first : MULTI;
}

function setField(el, val, fmt = (v) => v) {
  el.classList.toggle('multi', val === MULTI);
  if (val === MULTI) {
    el.value = '';
    el.placeholder = 'multiple';
  } else {
    el.value = val == null ? '' : fmt(val);
    el.placeholder = '—';
  }
}

function renderInspector() {
  const sel = selected();
  const has = sel.length > 0;
  for (const id of ['fDate', 'fTime', 'fTz', 'fLat', 'fLon']) $(id).disabled = !has;
  $('btnRevert').disabled = !sel.some(isEdited);

  $('selLabel').textContent = !has
    ? 'Nothing selected'
    : sel.length === 1 ? sel[0].name : `${sel.length} photos selected`;

  const edited = editedPhotos().length;
  $('editLabel').classList.toggle('hidden', edited === 0);
  $('editLabel').textContent = `${edited} unsaved`;

  if (!has) {
    for (const id of ['fDate', 'fTime', 'fTz', 'fLat', 'fLon']) setField($(id), null);
    return;
  }
  setField($('fDate'), common(sel, (p) => (p.datetime ? p.datetime.slice(0, 10) : null)));
  setField($('fTime'), common(sel, (p) => (p.datetime ? p.datetime.slice(11, 19) : null)));
  setField($('fTz'), common(sel, (p) => p.offset ?? null));
  setField($('fLat'), common(sel, (p) => p.lat ?? null), (v) => v.toFixed(6));
  setField($('fLon'), common(sel, (p) => p.lon ?? null), (v) => v.toFixed(6));
}

/** Apply an inspector field to the whole selection. */
function applyField(fn) {
  const sel = selected();
  if (!sel.length) return;
  commit();
  for (const p of sel) fn(p);
  emit('change');
}

$('fDate').addEventListener('change', (e) => {
  const d = e.target.value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
  applyField((p) => { p.datetime = normDt(`${d}T${p.datetime ? p.datetime.slice(11, 19) : '12:00:00'}`); });
});

$('fTime').addEventListener('change', (e) => {
  let t = e.target.value;
  if (!t) return;
  if (t.length === 5) t += ':00';
  if (!/^\d{2}:\d{2}:\d{2}$/.test(t)) return;
  applyField((p) => {
    // A photo with no date at all needs one before a time means anything; fall
    // back to its file mtime, then to today.
    const day = p.datetime ? p.datetime.slice(0, 10)
      : (p.file_modified ? p.file_modified.slice(0, 10) : new Date().toISOString().slice(0, 10));
    p.datetime = normDt(`${day}T${t}`);
  });
});

$('fTz').addEventListener('change', (e) => {
  const v = e.target.value.trim();
  if (v && !/^[+-]\d{2}:\d{2}$/.test(v)) { toast('UTC offset must look like +02:00', true); renderInspector(); return; }
  applyField((p) => { p.offset = v || null; });
});

for (const [id, key, lim] of [['fLat', 'lat', 90], ['fLon', 'lon', 180]]) {
  $(id).addEventListener('change', (e) => {
    const raw = e.target.value.trim();
    if (raw === '') { applyField((p) => { p[key] = null; }); return; }
    const v = Number(raw);
    if (!Number.isFinite(v) || Math.abs(v) > lim) { toast(`${key} must be a number within ±${lim}`, true); renderInspector(); return; }
    applyField((p) => { p[key] = roundCoord(v); });
  });
}

$('btnRevert').addEventListener('click', () => {
  const sel = selected().filter(isEdited);
  if (!sel.length) return;
  commit();
  for (const p of sel) Object.assign(p, { ...p.orig });
  emit('change');
  toast(`Reverted ${sel.length} photo${sel.length > 1 ? 's' : ''}`);
});

/* ── Filmstrip sizing ──────────────────────────────────────────── */
/* One drag handle instead of a size menu: "too small" depends on the screen,
   and the thumbnails scale with the panel so widening it actually shows more. */
const MIN_STRIP = 180;
const MAX_STRIP = 460;

function setStripWidth(px) {
  const w = Math.round(Math.max(MIN_STRIP, Math.min(MAX_STRIP, px)));
  const root = document.documentElement;
  root.style.setProperty('--strip', `${w}px`);
  root.style.setProperty('--thumb', `${Math.round(Math.max(56, Math.min(132, w * 0.31)))}px`);
  return w;
}

try {
  const saved = Number(localStorage.getItem('stripWidth'));
  if (Number.isFinite(saved) && saved > 0) setStripWidth(saved);
} catch { /* private mode or blocked storage: the defaults are fine */ }

$('stripResize').addEventListener('pointerdown', (ev) => {
  ev.preventDefault();
  const handle = ev.currentTarget;
  handle.classList.add('on');
  let width = 0;
  let queued = false;

  const move = (e) => {
    width = setStripWidth(e.clientX);
    // Both views size themselves from the pane, so keep them in step — but only
    // once per frame, since a re-render per pointermove is far too much work.
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      MapView.invalidate();
      if (state.view === 'time') TL.render();
    });
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    handle.classList.remove('on');
    try { if (width) localStorage.setItem('stripWidth', String(width)); } catch { /* ignore */ }
    MapView.invalidate();
    if (state.view === 'time') TL.render();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up, { once: true });
});

/* ── Views ─────────────────────────────────────────────────────── */
function setView(v) {
  state.view = v;
  $('mapView').classList.toggle('hidden', v !== 'map');
  $('timeView').classList.toggle('hidden', v !== 'time');
  for (const t of $('viewTabs').children) t.classList.toggle('on', t.dataset.view === v);
  if (v === 'map') MapView.invalidate();
  else TL.render();
}
$('viewTabs').addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (t) setView(t.dataset.view);
});

/* ── Map tools ─────────────────────────────────────────────────── */
$('btnInterp').addEventListener('click', () => {
  const r = MapView.interpolate();
  toast(r.msg, !r.ok);
});
$('btnClearGps').addEventListener('click', () => {
  const sel = selected().filter((p) => p.lat != null);
  if (!sel.length) return;
  commit();
  for (const p of sel) { p.lat = null; p.lon = null; }
  emit('change');
  toast(`Cleared location on ${sel.length} photo${sel.length > 1 ? 's' : ''}`);
});
$('chkPath').addEventListener('change', (e) => MapView.setShowRoute(e.target.checked));

/* ── Timeline tools ────────────────────────────────────────────── */
$('btnSeedDates').addEventListener('click', () => {
  // Dragging hundreds of undated photos one by one is not a workflow. File
  // mtime is a rough but honest starting point that can then be shifted as a
  // group; it is offered explicitly rather than applied behind the user's back.
  const undated = state.photos.filter((p) => !p.datetime && p.file_modified);
  if (!undated.length) {
    toast('These photos have no file date to fall back on', true);
    return;
  }
  commit();
  for (const p of undated) p.datetime = normDt(p.file_modified);
  emit('change');
  toast(`Dated ${undated.length} photo${undated.length > 1 ? 's' : ''} from file timestamps — now drag to correct them`);
});


$('shiftBar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-shift]');
  if (!b) return;
  const n = TL.shiftSelection(+b.dataset.shift);
  if (!n) toast('Select photos that already have a date first', true);
});
$('zoomBar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-zoom]');
  if (!b) return;
  for (const x of $('zoomBar').querySelectorAll('[data-zoom]')) x.classList.toggle('on', x === b);
  TL.setZoom(+b.dataset.zoom);
});

/* ── Save ──────────────────────────────────────────────────────── */
async function openSave() {
  const n = editedPhotos().length;
  if (!n) return;
  $('modalSummary').textContent = `${n} photo${n === 1 ? '' : 's'} changed.`
    + (backend.caps.inPlace ? '' : ' Originals are never modified in the browser.');
  if (!$('fOut').value && state.folder) {
    $('fOut').value = await backend.suggestOutput(state.folder);
  }
  $('modal').classList.remove('hidden');
}

function currentMode() {
  return $('modeRadios').querySelector('input[name=mode]:checked').value;
}
$('modeRadios').addEventListener('change', () => {
  $('outRow').classList.toggle('hidden', currentMode() !== 'copy');
});
$('btnPickOut').addEventListener('click', async () => {
  const d = await backend.pickOutput();
  if (d) $('fOut').value = d;
});
$('btnCancel').addEventListener('click', () => $('modal').classList.add('hidden'));
$('btnSave').addEventListener('click', openSave);

$('btnConfirm').addEventListener('click', async () => {
  const mode = currentMode();
  const outDir = $('fOut').value.trim();
  if (mode === 'copy' && !outDir) { toast('Choose an output folder', true); return; }

  const items = editedPhotos().map((p) => ({
    path: p.path,
    // Send the full current state, not a diff. Every write starts from the
    // pristine source — copy mode re-copies the original, and the browser
    // re-reads the picked File — so sending only what changed since the last
    // save would silently drop edits written in an earlier save.
    datetime: p.datetime,
    offset: p.offset,
    lat: p.lat, lon: p.lon, alt: null,
    // Distinguish "remove the location" from "there was never one".
    clear_gps: p.lat == null && p.orig.lat != null,
  }));

  $('btnConfirm').disabled = true;
  $('btnConfirm').textContent = 'Writing…';
  try {
    const results = await backend.save(items, { mode, outDir });
    const ok = results.filter((r) => r.ok);
    const bad = results.filter((r) => !r.ok);

    // Written photos become the new baseline, so the edited markers clear.
    const okSet = new Set(ok.map((r) => r.path));
    for (const p of state.photos) {
      if (okSet.has(p.path)) p.orig = { datetime: p.datetime, offset: p.offset, lat: p.lat, lon: p.lon };
    }
    state.undo.length = 0;
    state.redo.length = 0;
    $('modal').classList.add('hidden');
    emit('change');

    if (bad.length) {
      console.error('img-taggr write failures', bad);
      toast(`${ok.length} written · ${bad.length} failed — first error: ${bad[0].error}`, true);
    } else {
      toast(mode === 'copy' ? `Wrote ${ok.length} tagged copies to ${outDir}` : `Updated ${ok.length} files`);
    }
  } catch (e) {
    toast(String(e), true);
  } finally {
    $('btnConfirm').disabled = false;
    $('btnConfirm').textContent = 'Write files';
  }
});

/** Hide save modes this backend cannot perform, rather than offering controls
 *  that would fail. The browser has no access to the originals at all. */
function applyCaps() {
  for (const [mode, ok] of [['backup', backend.caps.backups], ['inplace', backend.caps.inPlace]]) {
    const input = $('modeRadios').querySelector(`input[value="${mode}"]`);
    if (input) input.closest('.radio').classList.toggle('hidden', !ok);
  }
  const copy = $('modeRadios').querySelector('input[value="copy"]');
  if (copy && !backend.caps.inPlace) {
    copy.checked = true;
    // With nothing to choose between, the radio list is noise.
    $('modeRadios').classList.add('hidden');
  }
  $('btnPickOut').classList.toggle('hidden', !backend.caps.outputFolder);
  $('outRow').querySelector('span').textContent = backend.caps.outputFolder
    ? 'Output folder' : 'Download as';
}

/* ── Keyboard ──────────────────────────────────────────────────── */
window.addEventListener('keydown', (e) => {
  if (e.target instanceof Element && e.target.matches('input, textarea')) return;
  const mod = e.ctrlKey || e.metaKey;

  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    const did = e.shiftKey ? redo() : undo();
    if (did) emit('change'); else toast(e.shiftKey ? 'Nothing to redo' : 'Nothing to undo');
    return;
  }
  if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); $('btnSelectAll').click(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); openSave(); return; }
  if (e.key === 'Escape') {
    if (!$('modal').classList.contains('hidden')) { $('modal').classList.add('hidden'); return; }
    state.selection.clear(); emit('change'); return;
  }
  if (e.key === 'Tab') { e.preventDefault(); setView(state.view === 'map' ? 'time' : 'map'); return; }
  // Arrow keys nudge time: a minute a press, ten seconds with Shift.
  if (state.view === 'time' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    const step = (e.shiftKey ? 10 : 60) * (e.key === 'ArrowLeft' ? -1 : 1);
    if (!TL.shiftSelection(step)) toast('Select photos that already have a date first', true);
  }
});

/* ── Render loop ───────────────────────────────────────────────── */
function renderAll() {
  syncStrip();
  renderInspector();
  MapView.render();
  if (state.view === 'time') TL.render();

  const sel = selected();
  $('btnClearGps').disabled = !sel.some((p) => p.lat != null);
  $('btnInterp').disabled = state.photos.filter((p) => p.lat != null).length < 2;
  $('btnUndo').disabled = state.undo.length === 0;
  $('btnSave').disabled = editedPhotos().length === 0;
  const n = editedPhotos().length;
  $('btnSave').textContent = n ? `Save ${n}` : 'Save';
}
on('change', renderAll);

$('btnOpen').addEventListener('click', openFolder);
$('btnUndo').addEventListener('click', () => { if (undo()) emit('change'); });

/* ── Boot ──────────────────────────────────────────────────────── */
MapView.initMap($('map'));
TL.initTimeline({
  days: $('days'),
  tray: $('tray'),
  trayWrap: $('trayWrap'),
  trayCount: $('trayCount'),
  hint: (msg) => {
    $('timeHint').textContent = msg ||
      'Drag a photo along its day to set the time. With several selected, they all shift together.';
  },
});
window.addEventListener('resize', () => { if (state.view === 'time') TL.render(); });
applyCaps();
renderAll();

backend.envWarning().then((msg) => { if (msg) toast(msg, true); });
