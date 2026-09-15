/* img-taggr — wiring: folder loading, inspector, previews, keyboard, save. */

import {
  state, setOnChange, emit, selected, editedPhotos, isEdited, commit, undo, redo,
  normDt, roundCoord, dayOf, timeOf, seedDay, photoCount, fmtDur,
  EDITABLE, rebase, revertToBaseline, resetHistory, sortPhotos,
} from './state.js';
import * as MapView from './map.js';
import * as TL from './timeline.js';
import { createBackend } from './backend.js';
import { dateTimeField, calendar } from './datetime.js';
import * as Strip from './strip.js';
import { initSearch } from './search.js';
import { hoverPreview, initLightbox, openLightbox } from './preview.js';
import * as Stage from './stage.js';
import { stored, store, replay } from './dom.js';

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

/* ── Confirmation ──────────────────────────────────────────────── */
/** An in-page yes/no, so nothing blocks the page the way confirm() does.
 *  Cancel has the focus: the destructive answer must be chosen on purpose. */
function confirmDialog({ title, body, yes }) {
  return new Promise((resolve) => {
    const wrap = $('confirm');
    $('confirmTitle').textContent = title;
    $('confirmBody').textContent = body;
    $('confirmYes').textContent = yes;
    wrap.classList.remove('hidden');
    const back = document.activeElement;
    $('confirmNo').focus();
    const done = (answer) => {
      wrap.classList.add('hidden');
      wrap.removeEventListener('keydown', onKey);
      $('confirmYes').onclick = $('confirmNo').onclick = null;
      if (back instanceof HTMLElement) back.focus();
      resolve(answer);
    };
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') done(false);
    };
    wrap.addEventListener('keydown', onKey);
    $('confirmYes').onclick = () => done(true);
    $('confirmNo').onclick = () => done(false);
  });
}

async function confirmDiscard(action) {
  const n = editedPhotos().length;
  if (!n) return true;
  return confirmDialog({
    title: `Discard ${n} unsaved change${n === 1 ? '' : 's'}?`,
    body: `${action} throws away edits that have not been saved.`,
    yes: 'Discard changes',
  });
}

/* ── Loading a folder ──────────────────────────────────────────── */
/** `pending` is whatever the backend is producing — a picker or a drop — so
 *  both routes share one loading path. */
async function openFolder(pending) {
  $('btnOpen').disabled = true;
  const prevLabel = $('folderLabel').textContent;
  try {
    $('folderLabel').textContent = 'Reading…';
    const res = await pending;
    if (!res) { $('folderLabel').textContent = prevLabel; return; }
    res.activate?.();
    state.folder = res.label;
    state.selection.clear();
    resetHistory();
    state.photos = res.photos.map((p) => {
      const photo = { ...p, id: p.path, thumb: null,
        lat: roundCoord(p.lat), lon: roundCoord(p.lon) };
      // Keep the as-read values so "edited" is always a real comparison rather
      // than a flag we have to remember to set.
      rebase(photo);
      return photo;
    });

    $('folderLabel').textContent = res.label.length > 44 ? `…${res.label.slice(-43)}` : res.label;
    $('folderLabel').title = res.label;
    sortPhotos();
    Strip.build();
    emit();
    MapView.fit();
    TL.fit();
    toast(photoCount(state.photos.length)
      + (res.unreadable ? ` · ${res.unreadable} unreadable` : ''));
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
  const flush = () => { if (dirty) { dirty = false; renderAll(); } };
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

/* ── Inspector ─────────────────────────────────────────────────── */
/** Shared value across a selection, or the MULTI sentinel. */
const MULTI = Symbol('multiple');
function common(sel, fn) {
  if (!sel.length) return null;
  const first = fn(sel[0]);
  return sel.every((p) => fn(p) === first) ? first : MULTI;
}

function setField(el, val, fmt = (v) => v) {
  // A re-render must never wipe what someone is typing. Once they commit, the
  // field is fair game again: bad input resets, good input is reformatted.
  if (el.dataset.typing) return;
  el.classList.toggle('multi', val === MULTI);
  if (val === MULTI) {
    el.value = '';
    el.placeholder = 'multiple';
  } else {
    el.value = val == null ? '' : fmt(val);
    el.placeholder = '—';
  }
}

function renderInspector(edited = editedPhotos().length) {
  const sel = selected();
  const has = sel.length > 0;
  for (const id of ['fDt', 'btnCal', 'fTz', 'fShift', 'fLat', 'fLon']) $(id).disabled = !has;
  $('btnRevert').disabled = !sel.some(isEdited);
  $('btnClearGps').disabled = !sel.some((p) => p.lat != null);
  $('btnShowMap').disabled = !sel.some((p) => p.lat != null);
  $('btnShowTime').disabled = !sel.some((p) => p.datetime);

  $('selLabel').textContent = !has
    ? 'Nothing selected'
    : sel.length === 1 ? sel[0].name : `${sel.length} photos selected`;
  const thumb = $('insThumb');
  const shown = sel.find((p) => p.thumb) ?? sel[0];
  thumb.style.backgroundImage = shown?.thumb ? `url('${shown.thumb}')` : '';
  thumb.dataset.ext = shown && !shown.thumb ? (shown.ext || '?') : '';
  thumb.dataset.count = sel.length > 1 ? String(sel.length) : '';
  thumb.classList.toggle('hidden', !has);

  $('editLabel').classList.toggle('hidden', edited === 0);
  $('editLabel').textContent = `${edited} unsaved`;

  if (!has) {
    dtField.set(null);
    for (const id of ['fTz', 'fLat', 'fLon']) setField($(id), null);
    return;
  }
  // Editing a mixed selection starts from its first photo; only the halves
  // actually changed are applied, so each photo keeps the rest of its own.
  const first = sel.find((p) => p.datetime);
  dtField.set(first?.datetime ?? null, {
    mixed: common(sel, (p) => p.datetime) === MULTI,
    fallback: `${seedDay(sel[0])}T12:00:00`,
  });
  setField($('fTz'), common(sel, (p) => p.offset ?? null));
  setField($('fLat'), common(sel, (p) => p.lat ?? null), (v) => v.toFixed(6));
  setField($('fLon'), common(sel, (p) => p.lon ?? null), (v) => v.toFixed(6));
}

/**
 * Apply `fn` to every selected photo that `filter` accepts, as one undo step.
 * Returns how many were touched so callers can report it.
 */
function applyField(fn, filter = () => true) {
  const sel = selected().filter(filter);
  if (!sel.length) return 0;
  commit();
  for (const p of sel) fn(p);
  emit();
  return sel.length;
}

/** Set the date and/or time of the selection; a null half is left as it is. */
function applyDateTime({ date, time }) {
  applyField((p) => {
    // A photo with no date at all needs both halves before either means anything.
    const d = date ?? dayOf(p.datetime) ?? seedDay(p);
    const t = time ?? timeOf(p.datetime) ?? '12:00:00';
    p.datetime = normDt(`${d}T${t}`);
  });
}

const dtField = dateTimeField($('fDt'), { onCommit: applyDateTime });
calendar($('btnCal'), {
  current: () => {
    const days = selected().map((p) => dayOf(p.datetime)).filter(Boolean);
    return days.length ? days[0] : null;
  },
  onPick: (day) => applyDateTime({ date: day, time: null }),
  absorbIn: [$('map')],
});

for (const id of ['fTz', 'fLat', 'fLon']) {
  $(id).addEventListener('input', (e) => { e.target.dataset.typing = '1'; });
  $(id).addEventListener('blur', (e) => { delete e.target.dataset.typing; });
}

$('fTz').addEventListener('change', (e) => {
  delete e.target.dataset.typing;
  const v = e.target.value.trim();
  if (v && !/^[+-]\d{2}:\d{2}$/.test(v)) { toast('UTC offset must look like +02:00', true); renderInspector(); return; }
  applyField((p) => { p.offset = v || null; });
});

for (const [id, key, lim] of [['fLat', 'lat', 90], ['fLon', 'lon', 180]]) {
  $(id).addEventListener('change', (e) => {
    delete e.target.dataset.typing;
    const raw = e.target.value.trim();
    if (raw === '') { applyField((p) => { p[key] = null; }); return; }
    const v = Number(raw);
    if (!Number.isFinite(v) || Math.abs(v) > lim) { toast(`${key} must be a number within ±${lim}`, true); renderInspector(); return; }
    applyField((p) => { p[key] = roundCoord(v); });
  });
}

/** "+3h47m", "-15s", "1d 2h", "-0:15" → seconds, or null if unreadable. */
function parseShift(text) {
  const t = text.replace(/−/g, '-').replace(/\s+/g, '');
  let m = /^([+-]?)(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(t);
  if (m) return (m[1] === '-' ? -1 : 1) * (+m[2] * 3600 + +m[3] * 60 + +(m[4] ?? 0));
  m = /^([+-]?)(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(t);
  if (!m || !(m[2] || m[3] || m[4] || m[5])) return null;
  return (m[1] === '-' ? -1 : 1)
    * ((+m[2] || 0) * 86400 + (+m[3] || 0) * 3600 + (+m[4] || 0) * 60 + (+m[5] || 0));
}

$('fShift').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.target.value = ''; return; }
  if (e.key !== 'Enter') return;
  const sec = parseShift(e.target.value);
  if (sec === null) { toast('Shift must look like +3h47m, -15s or -0:15', true); return; }
  if (!sec) return;
  const undated = selected().filter((p) => !p.datetime).length;
  const n = TL.shiftSelection(sec);
  if (!n) { toast('None of the selected photos has a date to shift', true); return; }
  e.target.value = '';
  toast(`Shifted ${photoCount(n)} by ${fmtDur(sec)}`
    + (undated ? ` · ${undated} without a date left alone` : ''));
});

$('btnRevert').addEventListener('click', () => {
  const n = applyField(revertToBaseline, isEdited);
  if (n) toast(`Reverted ${photoCount(n)}`);
});

/* ── Reveal ────────────────────────────────────────────────────── */
/* Views never follow the selection on their own — that makes the map jump
   while you work. Double-click, or the inspector buttons, ask for it. */
function reveal(ids, { map = false, time = false }) {
  Stage.show({ map, time });
  if (map) MapView.reveal(ids);
  if (time) TL.reveal(ids);
}
$('btnShowMap').addEventListener('click', () => reveal([...state.selection], { map: true }));
$('btnShowTime').addEventListener('click', () => reveal([...state.selection], { time: true }));

/* ── Map tools ─────────────────────────────────────────────────── */
$('btnInterp').addEventListener('click', () => {
  const r = MapView.interpolate();
  toast(r.msg, !r.ok);
});
$('btnClearGps').addEventListener('click', () => {
  const n = applyField((p) => { p.lat = null; p.lon = null; }, (p) => p.lat != null);
  if (n) toast(`Cleared location on ${photoCount(n)}`);
});
function showBasemap(name) {
  for (const b of $('basemapSeg').children) {
    b.setAttribute('aria-checked', String(b.dataset.basemap === name));
  }
}
$('basemapSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-basemap]');
  if (!b) return;
  showBasemap(MapView.setBasemap(b.dataset.basemap));
  store('basemap', b.dataset.basemap);
});
$('chkPath').addEventListener('change', (e) => MapView.setShowRoute(e.target.checked));

/* ── Timeline tools ────────────────────────────────────────────── */
$('btnFit').addEventListener('click', () => TL.fit());

/* ── Save ──────────────────────────────────────────────────────── */
async function openSave() {
  const n = editedPhotos().length;
  if (!n) return;
  $('modalSummary').textContent = `${photoCount(n)} changed.`
    + (backend.caps.saveModes.includes('inplace') ? '' : ' Originals are never modified.');
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
    ...Object.fromEntries(EDITABLE.map((k) => [k, p[k]])),
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
    for (const p of state.photos) if (okSet.has(p.path)) rebase(p);
    resetHistory();
    $('modal').classList.add('hidden');
    emit();

    if (bad.length) {
      console.error('img-taggr write failures', bad);
      toast(`${ok.length} written · ${bad.length} failed — first error: ${bad[0].error}`, true);
    } else {
      toast(mode === 'copy'
        ? `Wrote ${photoCount(ok.length)} to ${outDir}`
        : `Updated ${photoCount(ok.length)}`);
    }
  } catch (e) {
    toast(String(e), true);
  } finally {
    $('btnConfirm').disabled = false;
    $('btnConfirm').textContent = 'Write files';
  }
});

/** Offer exactly the save modes this backend can perform, rather than showing
 *  controls that would fail. */
function applyCaps() {
  const modes = backend.caps.saveModes;
  for (const input of $('modeRadios').querySelectorAll('input[name=mode]')) {
    input.closest('.radio').classList.toggle('hidden', !modes.includes(input.value));
  }
  $('modeRadios').querySelector(`input[value="${modes[0]}"]`).checked = true;
  // With nothing to choose between, the radio list is noise.
  $('modeRadios').classList.toggle('hidden', modes.length === 1);

  $('btnPickOut').classList.toggle('hidden', !backend.caps.outputFolder);
  $('outRow').querySelector('span').textContent = backend.caps.outputFolder
    ? 'Output folder' : 'Download as';
}

/* ── Previews ────────────────────────────────────────────────── */
/** Full-size view of the selection's first photo, stepping through them all. */
function preview() {
  if (!state.photos.length) return;
  const ids = state.photos.map((p) => p.id);
  openLightbox(ids, state.photos.find((p) => state.selection.has(p.id))?.id ?? ids[0]);
}
initLightbox({ loadPreview: (p) => backend.loadPreview(p) });
hoverPreview($('stripList'), '.card .th', (el) => el.closest('.card').dataset.id);
hoverPreview($('tlTrack'), '.chip', (el) => el.dataset.id);
hoverPreview($('map'), '.leaflet-marker-icon', MapView.photoIdOf);
$('insThumb').addEventListener('click', preview);

/* ── Keyboard ──────────────────────────────────────────────────── */
window.addEventListener('keydown', (e) => {
  if (e.target instanceof Element && e.target.matches('input, textarea')) return;
  const mod = e.ctrlKey || e.metaKey;

  if (e.key === '?') { e.preventDefault(); showKeys(true); return; }
  // Space on a focused button presses it; anywhere else it opens the preview.
  if (e.key === ' ' && !mod && !(e.target instanceof Element && e.target.closest('button, a, [role="radio"]'))) {
    e.preventDefault();
    preview();
    return;
  }
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    const did = e.shiftKey ? redo() : undo();
    if (did) emit(); else toast(e.shiftKey ? 'Nothing to redo' : 'Nothing to undo');
    return;
  }
  if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); Strip.selectAll(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); openSave(); return; }
  if (e.key === 'Escape') {
    if (!$('modal').classList.contains('hidden')) { $('modal').classList.add('hidden'); return; }
    state.selection.clear(); emit(); return;
  }
  const pane = !mod && !e.altKey && Stage.paneForKey(e.key);
  if (pane) { Stage.toggleMax(pane); return; }
  // Arrow keys nudge time: a minute a press, ten seconds with Shift.
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const step = (e.shiftKey ? 10 : 60) * (e.key === 'ArrowLeft' ? -1 : 1);
    if (!TL.shiftSelection(step)) toast('Select photos that already have a date first', true);
  }
});

/* ── Render loop ───────────────────────────────────────────────── */
function renderAll() {
  const edited = editedPhotos().length;
  $('welcome').classList.toggle('hidden', state.photos.length > 0);
  sortPhotos();
  Strip.sync();
  renderInspector(edited);
  // A hidden pane is redrawn when it comes back, through toggleMax.
  if (Stage.mapShown()) MapView.render();
  if (Stage.timeShown()) TL.render();

  const sel = selected();
  let placed = 0;
  for (const p of state.photos) if (p.lat != null && ++placed >= 2) break;

  MapView.setPlacing(sel.length > 0);
  $('mapHint').textContent = !state.photos.length ? 'Search for a place, or open a folder of photos'
    : sel.length ? `Click the map to place ${sel.length === 1 ? sel[0].name : `${sel.length} photos`}`
      : 'Select photos, then click the map or drag them here';
  $('btnInterp').disabled = placed < 2;
  $('btnUndo').disabled = state.undo.length === 0;
  $('btnRedo').disabled = state.redo.length === 0;
  $('btnSave').disabled = edited === 0;
  $('btnSave').textContent = edited ? `Save ${edited}` : 'Save';
}
setOnChange(renderAll);

async function onOpenClick() {
  // The picker needs a user gesture; the confirm's own click provides a fresh one.
  if (await confirmDiscard('Opening another folder')) openFolder(backend.pickSource());
}
$('btnOpen').addEventListener('click', onOpenClick);
$('btnWelcomeOpen').addEventListener('click', onOpenClick);
$('btnUndo').addEventListener('click', () => { if (undo()) emit(); });
$('btnRedo').addEventListener('click', () => { if (redo()) emit(); });

/* ── Shortcut list ─────────────────────────────────────────────── */
function showKeys(on) {
  $('keys').classList.toggle('hidden', !on);
  if (on) $('keys').querySelector('.modal').focus(); else $('btnKeys').focus();
}
$('btnKeys').addEventListener('click', () => showKeys(true));
$('keysClose').addEventListener('click', () => showKeys(false));
$('keys').addEventListener('click', (e) => { if (e.target === $('keys')) showKeys(false); });
$('keys').addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); showKeys(false); }
});

/* ── Inspector panel ───────────────────────────────────────────── */
function setInspectorOpen(open) {
  $('inspector').classList.toggle('collapsed', !open);
  const b = $('btnIns');
  b.setAttribute('aria-expanded', String(open));
  b.setAttribute('aria-label', open ? 'Hide inspector' : 'Show inspector');
  b.title = open ? 'Hide inspector' : 'Show inspector';
  store('inspector', open ? 'open' : 'closed');
  Stage.resizeViews();
}
$('btnIns').addEventListener('click', () => {
  setInspectorOpen($('inspector').classList.contains('collapsed'));
});
if (stored('inspector') === 'closed') setInspectorOpen(false);

/* ── Boot ──────────────────────────────────────────────────────── */
Stage.initStage();
Strip.initStrip({
  toast,
  onResize: Stage.resizeViews,
  onReveal: (ids) => reveal(ids, { map: true, time: true }),
  dropTargets: [MapView.dropTarget, TL.dropTarget],
});
MapView.initMap($('map'), {
  basemap: stored('basemap'),
  // Say why nothing happened rather than silently ignoring the click.
  onClickEmpty: () => replay($('mapHint'), 'nudge'),
  onReveal: (id) => reveal([id], { time: true }),
});
TL.initTimeline({
  root: $('tl'),
  axis: $('tlAxis'),
  track: $('tlTrack'),
  hint: (msg) => { $('timeHint').textContent = msg; },
  onReveal: (id) => reveal([id], { map: true }),
});
window.addEventListener('resize', () => { if (Stage.timeShown()) TL.render(); });
showBasemap(MapView.basemapName());
initSearch({
  input: $('searchInput'),
  list: $('searchResults'),
  center: MapView.center,
  onPick: MapView.showPlace,
  onClear: MapView.clearPlace,
});
applyCaps();
backend.watchDrop({
  hover: (on) => $('dropZone').classList.toggle('hidden', !on),
  drop: async (pending) => {
    if (await confirmDiscard('Opening these photos')) openFolder(pending);
  },
});
backend.guardClose({
  dirty: () => editedPhotos().length > 0,
  confirm: () => confirmDiscard('Closing img-taggr'),
});
renderAll();

backend.envWarning().then((msg) => { if (msg) toast(msg, true); });
