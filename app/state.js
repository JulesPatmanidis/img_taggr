/* Shared state, wall-clock time helpers, and the undo journal.
 *
 * Time model: a photo's timestamp is *wall clock*, the numbers a camera wrote
 * on the file, held as "YYYY-MM-DDTHH:MM:SS" with no zone attached. The UTC
 * offset is a separate, independent field. That separation is deliberate: the
 * common repair is "the clock read 3h47m wrong", which must not be conflated
 * with "I was in a different timezone". All arithmetic runs through Date.UTC so
 * the machine's own timezone and its DST rules never leak into the result.
 */

export const state = {
  /** Where the photos came from, in the order they were added. Labels, not
   *  photo counts: a source can be a folder or a single file, and photos leave
   *  the list one at a time, so any tally kept here would go stale. */
  sources: [],
  photos: [],
  /** Photo ids, insertion-ordered. Opaque, since the backend picks their shape. */
  selection: new Set(),
  undo: [],
  redo: [],
  /** Bumped every time the list is emptied. Work started for an older list
   *  checks it and stops, which the folder label cannot do: two loose drops
   *  carry the same label. */
  session: 0,
};

/* ── Change notification ───────────────────────────────────────── */
/** Every mutation funnels through one re-render; there has never been a second
 *  event or a second subscriber, so this is a callback rather than a bus.
 *
 *  What the callback gets is the *reason*, which is what lets a view do less
 *  than a full rebuild:
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

/** Natural filename order: the tie-break for capture order and the order the
 *  shot numbers are handed out in, so both agree on what "first" means. */
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });

/** Shot numbers handed out so far. Never reused inside a session, so a photo's
 *  badge is fixed from the moment it arrives. */
let lastSeq = 0;

/**
 * Add photos to the session, skipping ids that are already loaded, and record
 * where they came from. Returns the photos actually added, so the caller can
 * report the duplicates and start thumbnails for only the new ones.
 *
 * Adding disturbs nothing that is already here. Existing shot numbers, the
 * selection and the undo journal all survive, because a second source is not a
 * fresh start, and a badge that renumbered under the user's hands would undo
 * the point of having one.
 */
export function addPhotos(photos, label) {
  const have = new Set(state.photos.map((p) => p.id));
  const fresh = photos.filter((p) => !have.has(p.id));
  if (!fresh.length) return fresh;

  // Scanned film keeps its shot order in the filename, and the list re-sorts as
  // dates are set, so the badge comes from name order within the batch.
  [...fresh].sort(byName).forEach((p) => { p.seq = ++lastSeq; });
  for (const p of fresh) state.photos.push(p);
  if (label && !state.sources.includes(label)) state.sources.push(label);
  sortPhotos();
  return fresh;
}

/**
 * Drop photos from the session. The journal is left alone on purpose: it
 * restores values onto photos it still finds by id, so a step taken before a
 * removal replays correctly and cannot resurrect what was removed.
 *
 * Returns how many left, which is what the caller reports.
 */
export function removePhotos(ids) {
  const gone = new Set(ids);
  const before = state.photos.length;
  state.photos = state.photos.filter((p) => !gone.has(p.id));
  for (const id of gone) state.selection.delete(id);
  return before - state.photos.length;
}

/**
 * Empty the session and open a new one, returning its token. Bundled because
 * the selection, the journal, the sources and the shot numbers all belong to
 * the list that is going away, and a caller that forgot one of them left the
 * app in a state the views cannot describe.
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

/** The day an undated photo should be filed under: its file timestamp if it has
 *  one, otherwise today. Both the inspector and the timeline need this answer
 *  and must agree on it. */
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
 * The selection gesture, shared by the filmstrip, map and timeline so all three
 * behave identically: ctrl/cmd toggles, shift extends from the last click, a
 * plain click replaces. Extending needs `anchor` (the id last clicked) and
 * `order` (the ids in the order the view shows them), so only views with a stable,
 * visible order offer it.
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

/** Capture order: undated first, as the to-do list, then by time, then name.
 *  Filename order is the other one worth having, because a scanned roll was
 *  shot in that order. The backends hand photos over unsorted, so this runs on
 *  load, whenever a datetime moves, and when the order itself is changed. */
let sortMode = 'time';
export const sortModeName = () => sortMode;

/** The one call that changes the order, so the mode has a single owner. */
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

/** What a photo is still missing. Every view asks these questions, so they are
 *  answered once here rather than re-spelled as inline tests in each caller. */
export const isUndated = (p) => !p.datetime;
export const isUnplaced = (p) => p.lat == null;
export const isTagged = (p) => !isUndated(p) && !isUnplaced(p);

/** How much of the folder is finished. The top bar and the inspector both
 *  report this and must not disagree. */
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

/** The fields a user can edit. Everything that compares, snapshots, reverts or
 *  saves a photo derives from this list, so adding a field is a one-line change
 *  and the copies cannot drift apart. */
export const EDITABLE = ['datetime', 'offset', 'lat', 'lon'];

const pick = (p) => Object.fromEntries(EDITABLE.map((k) => [k, p[k]]));

export const isEdited = (p) => EDITABLE.some((k) => p[k] !== p.orig[k]);
export const editedPhotos = () => state.photos.filter(isEdited);

/** The `sel` / `edited` marker classes both views paint onto a photo. */
export const markClasses = (base, p) =>
  [base, state.selection.has(p.id) ? 'sel' : '', isEdited(p) ? 'edited' : '']
    .filter(Boolean).join(' ');

/** The same two markers, onto a node that already exists. Toggling rather than
 *  reassigning leaves whatever class a gesture put there (`drag`, `pulse`)
 *  alone, which is what makes a repaint safe mid-gesture. */
export const mark = (el, p) => {
  el.classList.toggle('sel', state.selection.has(p.id));
  el.classList.toggle('edited', isEdited(p));
};

/** Treat the photo's current values as saved, its new baseline. */
export const rebase = (p) => { p.orig = pick(p); };

/** Throw away the pending edits and return to the last baseline. */
export const revertToBaseline = (p) => { Object.assign(p, p.orig); };

export const resetHistory = () => { state.undo.length = 0; state.redo.length = 0; };

/** Coordinates round-tripped through EXIF land near 1e-7 degrees anyway; keep
 *  values comparable so a no-op drag does not mark a photo as edited. */
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
  // Snapshots cover every photo, so depth costs memory on large folders; 50
  // steps is far more than interactive editing ever walks back.
  if (state.undo.length > 50) state.undo.shift();
  state.redo.length = 0;
}

/**
 * The only way photo fields change. `mutate` receives `photos`, anything
 * iterable, and edits them in place. everything around it (the undo snapshot,
 * the re-render) happens here, so no caller can get the order wrong or forget
 * a step.
 *
 * The journal keeps the snapshot only if a field moved, so a drag that ends
 * where it began costs no undo step. Returns how many photos changed, which is
 * what callers report in a toast.
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
