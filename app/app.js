/* img-taggr — wiring: folder loading, inspector, previews, keyboard, save. */

import {
  state, setOnChange, emit, selected, editedPhotos, isEdited, applyEdit, undo, redo,
  roundCoord, dayOf, photoCount, fmtDur, dtToMs, msToDt,
  isUndated, isUnplaced, folderStats,
  EDITABLE, rebase, revertToBaseline, resetHistory, setPhotos,
} from './state.js';
import * as MapView from './map.js';
import * as TL from './timeline.js';
import { createBackend, saveMode, modesFor } from './backend.js';
import { dateTimeField, calendar } from './datetime.js';
import * as Strip from './strip.js';
import { initSearch } from './search.js';
import { hoverPreview, initLightbox, openLightbox } from './preview.js';
import * as Stage from './stage.js';
import { stored, store, replay, withCode } from './dom.js';
import { MULTI, common, mergeDateTime, parseShift, seedDateTime } from './edits.js';

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
    const session = setPhotos(res.photos.map((p) => {
      const photo = { ...p, id: p.path, thumb: null,
        lat: roundCoord(p.lat), lon: roundCoord(p.lon) };
      // Keep the as-read values so "edited" is always a real comparison rather
      // than a flag we have to remember to set.
      rebase(photo);
      return photo;
    }));

    savedOnce = false;
    $('folderLabel').textContent = res.label.length > 44 ? `…${res.label.slice(-43)}` : res.label;
    $('folderLabel').title = res.label;
    Strip.build();
    emit('photos');
    MapView.fit();
    TL.fit();
    toast(photoCount(state.photos.length)
      + (res.unreadable ? ` · ${res.unreadable} unreadable` : ''));
    loadThumbs(session);
  } catch (e) {
    toast(String(e), true);
    $('folderLabel').textContent = '';
  } finally {
    $('btnOpen').disabled = false;
  }
}

/** Fetch thumbnails with bounded concurrency so a big folder stays responsive.
 *  `token` is the session this batch belongs to: when a second folder is opened
 *  the token moves on and these workers stop rather than decoding images for
 *  photos nobody can see any more. */
async function loadThumbs(token) {
  const queue = state.photos.slice();
  let dirty = false;
  const flush = () => { if (dirty) { dirty = false; renderAll('thumbs'); } };
  const ticker = setInterval(flush, 220);

  const worker = async () => {
    while (queue.length) {
      if (state.session !== token) return;
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

/** Nothing selected: say what the folder still needs and offer a way in. */
function renderIdle(stats) {
  const { total, done, undated, unplaced, percent } = stats;
  $('statCount').textContent = String(total);
  $('statBar').style.width = `${percent}%`;
  $('statLine').textContent = !total ? 'Open a folder to start.'
    : `${done} tagged · ${total - done} still need a date or a location`;
  $('cUndated').textContent = String(undated);
  $('cUnplaced').textContent = String(unplaced);
  $('btnPickUndated').disabled = !undated;
  $('btnPickUnplaced').disabled = !unplaced;
}

/** The strip of what is selected, up to a row's worth. Each one opens the
 *  lightbox on that photo, so it is a button and not a decorated div. */
function renderThumbs(sel) {
  const box = $('insThumbs');
  box.replaceChildren();
  for (const p of sel.slice(0, 8)) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'insThumb';
    el.dataset.id = p.id;
    if (p.thumb) el.style.backgroundImage = `url('${p.thumb}')`;
    else el.dataset.ext = p.ext || '?';
    el.title = `${p.name} — enlarge`;
    el.setAttribute('aria-label', `Enlarge ${p.name}`);
    box.appendChild(el);
  }
  if (sel.length > 8) {
    const more = document.createElement('div');
    more.className = 'insThumb more';
    more.textContent = `+${sel.length - 8}`;
    more.title = `${sel.length - 8} more selected`;
    box.appendChild(more);
  }
}

/**
 * What a mixed selection is hiding, as a span between its two extremes. The
 * ends are compared as instants, not as clock strings: two photos a day apart
 * at the same minute are a range, and 23:50–00:10 must not read backwards.
 */
function timeRange(sel) {
  const dated = sel.filter((p) => p.datetime);
  if (dated.length < 2) return '';
  const ms = dated.map((p) => dtToMs(p.datetime));
  const lo = msToDt(Math.min(...ms));
  const hi = msToDt(Math.max(...ms));
  if (lo === hi) return '';
  return dayOf(lo) === dayOf(hi)
    ? `Mixed · ${lo.slice(11, 16)}–${hi.slice(11, 16)}`
    : `Mixed · ${lo.slice(0, 16).replace('T', ' ')} – ${hi.slice(0, 16).replace('T', ' ')}`;
}

function renderInspector(edited = editedPhotos().length, stats = folderStats()) {
  const sel = selected();
  const has = sel.length > 0;
  $('insIdle').classList.toggle('hidden', has);
  $('insSel').classList.toggle('hidden', !has);
  $('insBody').classList.toggle('idle', !has);
  if (!has) renderIdle(stats);

  for (const id of ['fDt', 'btnCal', 'fTz', 'fShift', 'fLat', 'fLon']) $(id).disabled = !has;
  $('btnRevert').disabled = !sel.some(isEdited);
  $('btnClearGps').disabled = !sel.some((p) => p.lat != null);
  $('btnShowMap').disabled = !sel.some((p) => p.lat != null);
  $('btnShowTime').disabled = !sel.some((p) => p.datetime);
  $('gpsHelp').classList.toggle('hidden', !has || sel.some((p) => p.lat != null));

  $('selLabel').textContent = !has
    ? 'Nothing selected'
    : sel.length === 1 ? sel[0].name : `${sel.length} photos selected`;
  $('selLabel').title = sel.length === 1 ? sel[0].name : '';
  renderThumbs(sel);

  $('editLabel').classList.toggle('hidden', edited === 0);
  $('editLabel').textContent = `${edited} unsaved`;

  const range = has ? timeRange(sel) : '';
  $('dtRange').textContent = range;
  $('dtRange').classList.toggle('hidden', !range);

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
    fallback: seedDateTime(sel[0]),
  });
  setField($('fTz'), common(sel, (p) => p.offset ?? null));
  setField($('fLat'), common(sel, (p) => p.lat ?? null), (v) => v.toFixed(6));
  setField($('fLon'), common(sel, (p) => p.lon ?? null), (v) => v.toFixed(6));
}

/**
 * Apply `fn` to every selected photo that `filter` accepts, as one undo step.
 * Returns how many photos it actually changed, so callers can report it.
 */
function applyField(fn, filter = () => true) {
  return applyEdit(selected().filter(filter), (ps) => { for (const p of ps) fn(p); });
}

/** Set the date and/or time of the selection; a null half is left as it is. */
function applyDateTime({ date, time }) {
  applyField((p) => { p.datetime = mergeDateTime(p, { date, time }); });
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

$('fShift').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.target.value = ''; return; }
  if (e.key !== 'Enter') return;
  const sec = parseShift(e.target.value);
  if (sec === null) { toast('Shift must look like +3h47m, -15s or -0:15', true); return; }
  if (!sec) return;
  const undated = selected().filter(isUndated).length;
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
  const safe = modesFor(backend.caps).every((m) => !m.writesOriginals);
  $('modalSummary').textContent = `${photoCount(n)} changed.`
    + (safe ? ' Originals are never modified.' : '');
  if (!$('fOut').value && state.folder) {
    $('fOut').value = await backend.suggestOutput(state.folder);
  }
  $('modal').classList.remove('hidden');
}

/** The chosen mode, as its entry in SAVE_MODES rather than a bare string. */
function currentMode() {
  return saveMode($('modeRadios').querySelector('input[name=mode]:checked').value);
}
$('modeRadios').addEventListener('change', () => {
  $('outRow').classList.toggle('hidden', !currentMode().needsOutDir);
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
  if (mode.needsOutDir && !outDir) { toast('Choose an output folder', true); return; }

  const items = editedPhotos().map((p) => ({
    path: p.path,
    // Send the full current state, not a diff. Every write starts from the
    // pristine source — copy mode re-copies the original, and the browser
    // re-reads the picked File — so sending only what changed since the last
    // save would silently drop edits written in an earlier save.
    ...Object.fromEntries(EDITABLE.map((k) => [k, p[k]])),
    // Distinguish "remove the location" from "there was never one".
    clear_gps: isUnplaced(p) && p.orig.lat != null,
  }));

  $('btnConfirm').disabled = true;
  $('btnConfirm').textContent = 'Writing…';
  try {
    const { results, destination } = await backend.save(items, { mode: mode.id, outDir });
    const ok = results.filter((r) => r.ok);
    const bad = results.filter((r) => !r.ok);

    // Written photos become the new baseline, so the edited markers clear.
    const okSet = new Set(ok.map((r) => r.path));
    for (const p of state.photos) if (okSet.has(p.path)) rebase(p);
    resetHistory();
    savedOnce = true;
    $('modal').classList.add('hidden');
    emit('edits');

    if (bad.length) {
      console.error('img-taggr write failures', bad);
      toast(`${ok.length} written · ${bad.length} failed — first error: ${bad[0].error}`, true);
    } else {
      toast(describeSave(ok.length, destination));
    }
  } catch (e) {
    toast(String(e), true);
  } finally {
    $('btnConfirm').disabled = false;
    $('btnConfirm').textContent = 'Write files';
  }
});

/** One save-mode radio, built from its entry in SAVE_MODES. */
function modeRadio(mode) {
  const label = document.createElement('label');
  label.className = 'radio';
  label.classList.toggle('danger', mode.destructive);

  const input = document.createElement('input');
  input.type = 'radio';
  input.name = 'mode';
  input.value = mode.id;

  const text = document.createElement('div');
  const name = document.createElement('b');
  name.textContent = mode.label;
  const hint = document.createElement('span');
  hint.className = 'muted';
  hint.append(withCode(mode.hint));
  text.append(name, hint);

  label.append(input, text);
  return label;
}

/** Where the files ended up — which is not always where they were asked to go,
 *  so this reads the destination the backend reports rather than the mode. */
function describeSave(n, { kind, label }) {
  if (kind === 'download') return `Downloaded ${photoCount(n)} as ${label}`;
  if (kind === 'folder') return `Wrote ${photoCount(n)} to ${label}`;
  return `Updated ${photoCount(n)}`;
}

/** Offer exactly the save modes this backend can perform, rather than showing
 *  controls that would fail. */
function applyCaps() {
  const modes = modesFor(backend.caps);
  $('modeRadios').replaceChildren(...modes.map(modeRadio));
  $('modeRadios').querySelector('input[name=mode]').checked = true;
  $('outRow').classList.toggle('hidden', !currentMode().needsOutDir);
  // With nothing to choose between, the radio list is noise.
  $('modeRadios').classList.toggle('hidden', modes.length === 1);

  $('btnPickOut').classList.toggle('hidden', !backend.caps.outputFolder);
  $('outRow').querySelector('span').textContent = backend.caps.outputFolder
    ? 'Output folder' : 'Download as';
}

/* ── Previews ────────────────────────────────────────────────── */
/** Full-size view of the selection's first photo, stepping through them all. */
function preview(startId) {
  if (!state.photos.length) return;
  const ids = state.photos.map((p) => p.id);
  openLightbox(ids, startId ?? state.photos.find((p) => state.selection.has(p.id))?.id ?? ids[0]);
}
initLightbox({ loadPreview: (p) => backend.loadPreview(p) });
hoverPreview($('stripList'), '.card .th', (el) => el.closest('.card').dataset.id);
hoverPreview($('tlTrack'), '.chip', (el) => el.dataset.id);
hoverPreview($('map'), '.leaflet-marker-icon', MapView.photoIdOf);
$('insThumbs').addEventListener('click', (ev) => {
  const el = ev.target.closest('.insThumb[data-id]');
  if (el) preview(el.dataset.id);
});
$('btnPickUndated').addEventListener('click', () => selectWhere(isUndated));
$('btnPickUnplaced').addEventListener('click', () => selectWhere(isUnplaced));

/** Select every photo the test accepts, as one step. */
function selectWhere(test) {
  state.selection.clear();
  for (const p of state.photos) if (test(p)) state.selection.add(p.id);
  emit('selection');
}

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
    if (did) emit('edits'); else toast(e.shiftKey ? 'Nothing to redo' : 'Nothing to undo');
    return;
  }
  if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); Strip.selectAll(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); openSave(); return; }
  if (e.key === 'Escape') {
    if (!$('modal').classList.contains('hidden')) { $('modal').classList.add('hidden'); return; }
    state.selection.clear(); emit('selection'); return;
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
/** "Saved" only means something once something has actually been written. */
let savedOnce = false;

function renderProgress(edited, { total, done, percent }) {
  $('progress').classList.toggle('hidden', total === 0);
  $('progressText').textContent = `${done} of ${total} tagged`;
  $('progressBar').style.width = `${percent}%`;
  $('savedPill').classList.toggle('hidden', !savedOnce || edited > 0 || total === 0);
}

function renderAll(reason) {
  const edited = editedPhotos().length;
  // One pass over the photos; the top bar and the inspector both read it.
  const stats = folderStats();
  renderProgress(edited, stats);
  $('welcome').classList.toggle('hidden', state.photos.length > 0);
  Strip.sync();
  renderInspector(edited, stats);
  // A hidden pane is redrawn when it comes back, through toggleMax. The reason
  // rides along so a view can patch itself instead of laying out again.
  if (Stage.mapShown()) MapView.render(reason);
  if (Stage.timeShown()) TL.render(reason);

  const sel = selected();
  let placed = 0;
  for (const p of state.photos) if (p.lat != null && ++placed >= 2) break;

  MapView.setPlacing(sel.length > 0);
  // The intro card and the banner say the same thing at different volumes, so
  // only the card shows while the folder is still entirely unplaced.
  // The card and the banner say the same thing at different volumes, so
  // exactly one of them is up at a time.
  const introUp = Boolean(state.photos.length) && placed === 0 && !sel.length;
  $('mapIntro').classList.toggle('hidden', !introUp);
  $('mapHint').classList.toggle('hidden', introUp);
  $('mapHint').textContent = !state.photos.length ? 'Search for a place, or open a folder of photos'
    : sel.length ? `${sel.length === 1 ? sel[0].name : `${sel.length} photos`} selected — click the map or drag them here to place them`
      : 'Select photos, then click the map or drag them here';
  $('mapHint').classList.toggle('on', sel.length > 0);
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
$('btnUndo').addEventListener('click', () => { if (undo()) emit('edits'); });
$('btnRedo').addEventListener('click', () => { if (redo()) emit('edits'); });

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
  year: $('tlYear'),
  date: $('tlDate'),
  spread: $('btnSpread'),
  batch: $('batch'),
  batchWhy: $('batchWhy'),
  batchStart: $('fBatchStart'),
  batchCal: $('btnBatchCal'),
  batchGap: $('fBatchGap'),
  batchApply: $('btnBatch'),
  batchSeed: $('btnSeedDates'),
  batchOpen: $('btnBatchOpen'),
  batchClose: $('btnBatchClose'),
  toast,
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
