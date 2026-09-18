/* img-taggr wiring: adding photos, inspector, previews, keyboard, save. */

import {
  state, setOnChange, emit, selected, editedPhotos, isEdited, applyEdit, undo, redo,
  roundCoord, dayOf, photoCount, fmtDur, dtToMs, msToDt,
  isUndated, isUnplaced, folderStats,
  EDITABLE, rebase, revertToBaseline, resetHistory,
  addPhotos, removePhotos, clearPhotos,
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
import { MULTI, common, mergeDateTime, parseShift, seedDateTime } from './edits.js';

/** Desktop or browser engine, chosen once at boot. */
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
/** An in-page yes/no dialog, resolving true for yes. Cancel has the focus. */
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

/* ── Adding photos ─────────────────────────────────────────────── */
/** Add the photos `pending` resolves to, from a picker or a drop, to what is
 *  already loaded. Adding never loses an edit, so it never asks. */
async function addSource(pending) {
  for (const b of ADD_BUTTONS) $(b.id).disabled = true;
  try {
    $('folderLabel').textContent = 'Reading…';
    const res = await pending;
    if (!res) return;

    res.activate?.();
    const added = addPhotos(res.photos.map((p) => {
      const photo = { ...p, id: p.path, thumb: null,
        lat: roundCoord(p.lat), lon: roundCoord(p.lon) };
      rebase(photo);
      return photo;
    }), res.label);

    const known = res.photos.length - added.length;
    if (!added.length) {
      toast(known ? 'Already loaded · nothing to add'
        : `Nothing to add${res.unreadable ? ` · ${res.unreadable} unreadable` : ''}`, true);
      return;
    }

    Strip.build();
    emit('photos');
    MapView.fit();
    TL.fit();
    toast(`Added ${photoCount(added.length)}`
      + (known ? ` · ${known} already loaded` : '')
      + (res.unreadable ? ` · ${res.unreadable} unreadable` : ''));
    loadThumbs(added, state.session);
  } catch (e) {
    toast(String(e), true);
  } finally {
    // Replaces the "Reading…" label, whatever happened.
    renderSources();
    for (const b of ADD_BUTTONS) $(b.id).disabled = false;
  }
}

/** Every button that starts an add, and the picker it opens. */
const ADD_BUTTONS = [
  { id: 'btnAddFolder', pick: 'pickFolder' },
  { id: 'btnWelcomeFolder', pick: 'pickFolder' },
  { id: 'btnAddFiles', pick: 'pickFiles' },
  { id: 'btnWelcomeFiles', pick: 'pickFiles' },
];

/** The last segment of a path, whichever separator it uses. */
const baseName = (label) => label.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || label;

/** The bar's source line: the first source, plus how many joined it. */
function renderSources() {
  const { sources, photos } = state;
  const label = !sources.length ? ''
    : sources.length === 1 ? baseName(sources[0])
      : `${baseName(sources[0])} +${sources.length - 1}`;
  $('folderLabel').textContent = label.length > 44 ? `…${label.slice(-43)}` : label;
  $('folderLabel').title = sources.join('\n');
  $('btnClearAll').classList.toggle('hidden', !photos.length);
}

/** Everything that has to happen once the list is empty, wherever it was
 *  emptied from. */
function endSession() {
  backend.reset();
  clearPhotos();
  savedOnce = false;
  Strip.build({ reset: true });
  // The output folder was suggested from a source that is no longer loaded.
  $('fOut').value = '';
}

/** Empty the session, after asking about unsaved edits. */
async function clearAll() {
  if (!state.photos.length) return;
  if (!(await confirmDiscard('Removing every photo'))) return;
  endSession();
  emit('photos');
  toast('Removed every photo');
}

/** Take the selection out of the session, edits and all. */
async function removeSelected() {
  const sel = selected();
  if (!sel.length) return;
  const edited = sel.filter(isEdited).length;
  if (edited && !(await confirmDialog({
    title: `Remove ${photoCount(sel.length)}?`,
    body: `${edited} of them ${edited === 1 ? 'has unsaved changes' : 'have unsaved changes'}, `
      + 'which go with them.',
    yes: 'Remove',
  }))) return;

  const ids = sel.map((p) => p.id);
  const n = removePhotos(ids);
  backend.forget(ids);
  // Removing the last photo ends the session the same way Clear does.
  if (!state.photos.length) endSession();
  emit('photos');
  toast(`Removed ${photoCount(n)} from the list`);
}

/** Fetch thumbnails with bounded concurrency. The workers stop once `token`,
 *  the session this batch belongs to, is no longer current. */
async function loadThumbs(photos, token) {
  const queue = photos.slice();
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
  // Never overwrite a field mid-typing; it is refreshed once committed.
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

/** Inspector content with nothing selected: progress, and the undated and
 *  unplaced counts with their select buttons. */
function renderIdle(stats) {
  const { total, done, undated, unplaced, percent } = stats;
  $('statCount').textContent = String(total);
  $('statBar').style.width = `${percent}%`;
  $('statLine').textContent = !total ? 'Add a folder or a few photos to start.'
    : `${done} tagged · ${total - done} still need a date or a location`;
  $('cUndated').textContent = String(undated);
  $('cUnplaced').textContent = String(unplaced);
  $('btnPickUndated').disabled = !undated;
  $('btnPickUnplaced').disabled = !unplaced;
}

/** The strip of selected photos, up to a row's worth. Each opens the lightbox
 *  on its photo. */
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
    el.title = `Enlarge ${p.name}`;
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
 * What a mixed selection spans, from its earliest to its latest instant. The
 * ends are compared as instants, not clock strings, so 23:50–00:10 across
 * midnight reads the right way round.
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
  $('btnRemove').disabled = !has;
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
  // Editing a mixed selection starts from its first photo, and only the halves
  // that moved reach the others, so each photo keeps the rest of its own.
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
 * Returns how many photos it changed.
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
/** Bring `ids` into view on the map and/or timeline. Views never follow the
 *  selection on their own; a double-click or the inspector buttons call this. */
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
/* One way to save: tagged copies into a folder of their own. Sources are never
   opened for writing. */

async function openSave() {
  const n = editedPhotos().length;
  if (!n) return;
  $('modalSummary').textContent =
    `${photoCount(n)} changed. The tagged copies go to a new folder; your originals are untouched.`;
  if (!$('fOut').value && state.sources.length) {
    $('fOut').value = await backend.suggestOutput(state.sources[0]);
  }
  renderOutput();
  $('modal').classList.remove('hidden');
}

/** The output location shown in the save sheet: a full path on desktop, or a
 *  folder name and its parent folder in a browser. */
function renderOutput() {
  const { outputFolder, outputPaths } = backend.caps;
  $('outLabel').textContent = outputPaths ? 'Output folder'
    : outputFolder ? 'New folder' : 'Download as';
  $('btnPickOut').classList.toggle('hidden', !outputFolder);
  const parent = backend.outputParent();
  $('outWhere').textContent = parent ? `Created inside ${parent}.` : '';
  $('outWhere').classList.toggle('hidden', !parent);
}

$('btnPickOut').addEventListener('click', async () => {
  const picked = await backend.pickOutput();
  if (!picked) return;
  if (picked.path) $('fOut').value = picked.path;
  renderOutput();
});
$('btnCancel').addEventListener('click', () => $('modal').classList.add('hidden'));
$('btnSave').addEventListener('click', openSave);

$('btnConfirm').addEventListener('click', async () => {
  const outDir = $('fOut').value.trim();
  if (!outDir) { toast('Name the folder to save into', true); return; }

  const items = editedPhotos().map((p) => ({
    path: p.path,
    // The full state, not a diff: every save writes from the pristine source,
    // so a diff would drop edits written by an earlier save.
    ...Object.fromEntries(EDITABLE.map((k) => [k, p[k]])),
    // Distinguish "remove the location" from "there was never one".
    clear_gps: isUnplaced(p) && p.orig.lat != null,
  }));

  $('btnConfirm').disabled = true;
  $('btnConfirm').textContent = 'Writing…';
  try {
    const { results, destination } = await backend.save(items, { outDir });
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
      toast(`${ok.length} written · ${bad.length} failed. First error: ${bad[0].error}`, true);
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

/** The message after a save, naming the destination the backend reports. */
function describeSave(n, { kind, label }) {
  if (kind === 'download') return `Downloaded ${photoCount(n)} as ${label}`;
  return `Wrote ${photoCount(n)} to ${label}`;
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
  if (e.key === 'Delete') { e.preventDefault(); removeSelected(); return; }
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
/** Whether a save has written anything this session. */
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
  renderSources();
  $('welcome').classList.toggle('hidden', state.photos.length > 0);
  Strip.sync();
  renderInspector(edited, stats);
  // A hidden pane is redrawn by toggleMax when it is shown again. The reason is
  // passed through so a view can update its nodes instead of re-laying out.
  if (Stage.mapShown()) MapView.render(reason);
  if (Stage.timeShown()) TL.render(reason);

  const sel = selected();
  let placed = 0;
  for (const p of state.photos) if (p.lat != null && ++placed >= 2) break;

  MapView.setPlacing(sel.length > 0);
  // The intro card and the banner show the same message, so at most one is visible.
  const introUp = Boolean(state.photos.length) && placed === 0 && !sel.length;
  $('mapIntro').classList.toggle('hidden', !introUp);
  $('mapHint').classList.toggle('hidden', introUp);
  $('mapHint').textContent = !state.photos.length ? 'Search for a place, or open a folder of photos'
    : sel.length ? `${sel.length === 1 ? sel[0].name : `${sel.length} photos`} selected. Click the map, or drag them here`
      : 'Select photos, then click the map or drag them here';
  $('mapHint').classList.toggle('on', sel.length > 0);
  $('btnInterp').disabled = placed < 2;
  $('btnUndo').disabled = state.undo.length === 0;
  $('btnRedo').disabled = state.redo.length === 0;
  $('btnSave').disabled = edited === 0;
  $('btnSave').textContent = edited ? `Save ${edited}` : 'Save';
}
setOnChange(renderAll);

for (const { id, pick } of ADD_BUTTONS) {
  $(id).addEventListener('click', () => addSource(backend[pick]()));
}
$('btnClearAll').addEventListener('click', clearAll);
$('btnRemove').addEventListener('click', removeSelected);
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
  // A map click with nothing selected shows the hint instead of doing nothing.
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
renderOutput();
backend.watchDrop({
  hover: (on) => $('dropZone').classList.toggle('hidden', !on),
  // A drop adds to the session like any other source, so it needs no warning.
  drop: (pending) => addSource(pending),
});
backend.guardClose({
  dirty: () => editedPhotos().length > 0,
  confirm: () => confirmDiscard('Closing img-taggr'),
});
renderAll();

backend.envWarning().then((msg) => { if (msg) toast(msg, true); });
