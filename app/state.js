/* Shared state, wall-clock time helpers, and the undo journal.
 *
 * Time model: a photo's timestamp is *wall clock*, the numbers a camera wrote
 * on the file, held as "YYYY-MM-DDTHH:MM:SS" with no zone attached. The UTC
 * offset is a separate, independent field, so "the clock read 3h47m wrong" and
 * "I was in a different timezone" are different repairs. All arithmetic runs
 * through Date.UTC, so the machine's own timezone and its DST rules never reach
 * the result.
 */

export const state = {
  /** Source labels, in the order they were added. A label names a folder or a
   *  loose batch, never a count. */
  sources: [],
  photos: [],
  /** Photo ids, insertion-ordered. Opaque, since the backend picks their shape. */
  selection: new Set(),
  undo: [],
  redo: [],
  /** Bumped every time the list is emptied. Work started for an older list
   *  checks it and stops. */
  session: 0,
};

/* ── Change notification ───────────────────────────────────────── */
/** The single subscriber, called after every mutation with the *reason*, which
 *  lets a view do less than a full rebuild:
 *    'photos'     a new list arrived
 *    'edits'      field values moved
 *    'thumbs'     images arrived
 *    'selection'  only the selection changed
 */
let onChange = () => {};
export const setOnChange = (fn) => { onChange = fn; };
export const emit = (reason) => onChange(reason);

/** The reasons that change nothing but how a photo looks, so a view can patch
 *  its nodes instead of laying them out again. */
export const isRepaint = (reason) => reason === 'selection' || reason === 'thumbs';

/** Natural filename order: the tie-break for capture order, and the order shot
 *  numbers are handed out in. */
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });

/** Shot numbers handed out so far. Never reused inside a session, so a badge is
 *  fixed from the moment its photo arrives. */
let lastSeq = 0;

/**
 * Add photos to the session, skipping ids that are already loaded, and record
 * where they came from. Returns the photos actually added, so the caller can
 * report the duplicates and start thumbnails for only the new ones.
 *
 * Adding disturbs nothing already here: existing shot numbers, the selection
 * and the undo journal all survive.
 */
export function addPhotos(photos, label) {
  const have = new Set(state.photos.map((p) => p.id));
  const fresh = photos.filter((p) => !have.has(p.id));
  if (!fresh.length) return fresh;

  // Badges follow name order within the batch, since the list itself re-sorts
  // as dates are set.
  [...fresh].sort(byName).forEach((p) => { p.seq = ++lastSeq; });
  for (const p of fresh) state.photos.push(p);
  if (label && !state.sources.includes(label)) state.sources.push(label);
  sortPhotos();
  return fresh;
}

/**
 * Drop photos from the session, and return how many left. The journal is left
 * alone: it restores values onto photos it still finds by id, so an older step
 * still replays and cannot resurrect what was removed.
 */
export function removePhotos(ids) {
  const gone = new Set(ids);
  const before = state.photos.length;
  state.photos = state.photos.filter((p) => !gone.has(p.id));
  for (const id of gone) state.selection.delete(id);
  return before - state.photos.length;
}

/**
 * Empty the session and open a new one, returning its token. The selection, the
 * journal, the sources and the shot numbers all go with the list.
 */
export function clearPhotos() {
  state.photos = [];
  state.sources = [];
  state.selection.clear();
  resetHistory();
  lastSeq = 0;
  return ++state.session;
}

/* ── Wall-clock helpers ────────────────────────────────────────── */
export const pad = (n, w = 2) => String(n).padStart(w, '0');

/** "YYYY-MM-DDTHH:MM:SS" -> ms in a fictional UTC frame. */
export function dtToMs(dt) {
  if (!dt) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(dt);
  if (!m) return null;
  // Date.UTC maps years 0–99 onto 1900–1999, so set the year separately.
  const d = new Date(Date.UTC(2000, +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  d.setUTCFullYear(+m[1]);
  return d.getTime();
}

/** Inverse of dtToMs. */
export function msToDt(ms) {
  const d = new Date(ms);
  return (
    `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

export const dayOf = (dt) => (dt ? dt.slice(0, 10) : null);
export const timeOf = (dt) => (dt ? dt.slice(11, 19) : null);

/** The day an undated photo is filed under: its file timestamp if it has one,
 *  otherwise today. */
export const seedDay = (p) =>
  (p.file_modified ? dayOf(p.file_modified) : new Date().toISOString().slice(0, 10));

/** `${n} photo` / `${n} photos`, spelled one way everywhere. */
export const photoCount = (n) => `${n} photo${n === 1 ? '' : 's'}`;

export function fmtDayLabel(day) {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString(undefined, {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

export function fmtDur(sec) {
  const s = Math.abs(Math.round(sec));
  const parts = [];
  if (s >= 3600) parts.push(`${Math.floor(s / 3600)}h`);
  if (s % 3600 >= 60) parts.push(`${Math.floor((s % 3600) / 60)}m`);
  if (s % 60 || !parts.length) parts.push(`${s % 60}s`);
  return (sec < 0 ? '−' : '+') + parts.join(' ');
}

/** Round-trip through the parser so malformed input never reaches a backend. */
export const normDt = (dt) => { const ms = dtToMs(dt); return ms === null ? null : msToDt(ms); };

/* ── Photo helpers ─────────────────────────────────────────────── */
export function selected() {
  return state.photos.filter((p) => state.selection.has(p.id));
}

/**
 * The selection gesture, shared by the filmstrip, map and timeline: ctrl/cmd
 * toggles, shift extends from the last click, a plain click replaces. Extending
 * needs `anchor` (the id last clicked) and `order` (the ids in the order the
 * view shows them), so only views with a stable visible order offer it.
 */
export function clickSelect(id, { toggle = false, extend = false, anchor = null, order = null } = {}) {
  const from = extend && order ? order.indexOf(anchor) : -1;
  const to = from === -1 ? -1 : order.indexOf(id);
  if (toggle) {
    state.selection.has(id) ? state.selection.delete(id) : state.selection.add(id);
  } else if (to !== -1) {
    for (let i = Math.min(from, to); i <= Math.max(from, to); i++) state.selection.add(order[i]);
  } else {
    state.selection.clear();
    state.selection.add(id);
  }
  emit('selection');
}

/** The order the list is held in. 'time' puts undated photos first, as the
 *  to-do list, then sorts by time and by name; 'name' sorts by filename alone.
 *  Re-applied on load, whenever a datetime moves, and when the mode changes. */
let sortMode = 'time';
export const sortModeName = () => sortMode;

/** The one call that changes the order. */
export function setSortMode(mode) {
  sortMode = mode === 'name' ? 'name' : 'time';
  sortPhotos();
}

export function sortPhotos() {
  if (sortMode === 'name') { state.photos.sort(byName); return; }
  state.photos.sort((a, b) =>
    (!!a.datetime - !!b.datetime)
    || (a.datetime && b.datetime ? dtToMs(a.datetime) - dtToMs(b.datetime) : 0)
    || byName(a, b));
}

/** What a photo is still missing. */
export const isUndated = (p) => !p.datetime;
export const isUnplaced = (p) => p.lat == null;
export const isTagged = (p) => !isUndated(p) && !isUnplaced(p);

/** How much of the session is finished. */
export function folderStats() {
  const total = state.photos.length;
  const done = state.photos.filter(isTagged).length;
  return {
    total,
    done,
    undated: state.photos.filter(isUndated).length,
    unplaced: state.photos.filter(isUnplaced).length,
    percent: total ? (done / total) * 100 : 0,
  };
}

/** The fields a user can edit. Comparing, snapshotting, reverting and saving a
 *  photo all derive from this list. */
export const EDITABLE = ['datetime', 'offset', 'lat', 'lon'];

const pick = (p) => Object.fromEntries(EDITABLE.map((k) => [k, p[k]]));

export const isEdited = (p) => EDITABLE.some((k) => p[k] !== p.orig[k]);
export const editedPhotos = () => state.photos.filter(isEdited);

/** The `sel` / `edited` marker classes both views paint onto a photo. */
export const markClasses = (base, p) =>
  [base, state.selection.has(p.id) ? 'sel' : '', isEdited(p) ? 'edited' : '']
    .filter(Boolean).join(' ');

/** The same two markers, onto a node that already exists. Toggling leaves
 *  classes a gesture put there (`drag`, `pulse`) alone, so a repaint is safe
 *  in the middle of one. */
export const mark = (el, p) => {
  el.classList.toggle('sel', state.selection.has(p.id));
  el.classList.toggle('edited', isEdited(p));
};

/** Treat the photo's current values as saved, its new baseline. */
export const rebase = (p) => { p.orig = pick(p); };

/** Discard the pending edits and restore the last baseline. */
export const revertToBaseline = (p) => { Object.assign(p, p.orig); };

export const resetHistory = () => { state.undo.length = 0; state.redo.length = 0; };

/** Coordinates at 1e-7 degrees, the precision an EXIF round-trip survives, so a
 *  no-op drag does not read as an edit. */
export const roundCoord = (v) => (v == null ? null : Math.round(v * 1e7) / 1e7);

/* ── Undo ──────────────────────────────────────────────────────── */
function snapshot() {
  return state.photos.map((p) => ({ id: p.id, ...pick(p) }));
}

function restore(snap) {
  const m = new Map(snap.map((s) => [s.id, s]));
  for (const p of state.photos) {
    const s = m.get(p.id);
    if (s) Object.assign(p, pick(s));
  }
  sortPhotos();
}

function pushUndo(snap) {
  state.undo.push(snap);
  // Snapshots cover every photo, so depth costs memory on a large folder.
  if (state.undo.length > 50) state.undo.shift();
  state.redo.length = 0;
}

/**
 * The only way photo fields change. `mutate` receives `photos`, anything
 * iterable, and edits them in place; the undo snapshot, the re-sort and the
 * re-render all happen here.
 *
 * The journal keeps the snapshot only if a field moved, so a drag that ends
 * where it began costs no undo step. Returns how many photos changed.
 */
export function applyEdit(photos, mutate) {
  const list = [...photos];
  if (!list.length) return 0;
  const before = list.map(pick);
  const snap = snapshot();
  mutate(list);
  const changed = list.filter(
    (p, i) => EDITABLE.some((k) => p[k] !== before[i][k])).length;
  if (changed) pushUndo(snap);
  // Ordering follows datetime, so re-sort here rather than inside the render.
  if (list.some((p, i) => p.datetime !== before[i].datetime)) sortPhotos();
  emit('edits');
  return changed;
}

export function undo() {
  if (!state.undo.length) return false;
  state.redo.push(snapshot());
  restore(state.undo.pop());
  return true;
}

export function redo() {
  if (!state.redo.length) return false;
  state.undo.push(snapshot());
  restore(state.redo.pop());
  return true;
}
