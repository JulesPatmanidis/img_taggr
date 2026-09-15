/* Shared state, wall-clock time helpers, and the undo journal.
 *
 * Time model: a photo's timestamp is *wall clock* — the numbers a camera wrote
 * on the file — held as "YYYY-MM-DDTHH:MM:SS" with no zone attached. The UTC
 * offset is a separate, independent field. That separation is deliberate: the
 * common repair is "the clock read 3h47m wrong", which must not be conflated
 * with "I was in a different timezone". All arithmetic runs through Date.UTC so
 * the machine's own timezone and its DST rules never leak into the result.
 */

export const state = {
  folder: null,
  photos: [],
  /** Photo ids, insertion-ordered. Opaque — the backend decides their shape. */
  selection: new Set(),
  undo: [],
  redo: [],
};

/* ── Change notification ───────────────────────────────────────── */
/** Every mutation funnels through one re-render; there has never been a second
 *  event or a second subscriber, so this is a callback rather than a bus. */
let onChange = () => {};
export const setOnChange = (fn) => { onChange = fn; };
export const emit = () => onChange();

/* ── Wall-clock helpers ────────────────────────────────────────── */
const pad = (n, w = 2) => String(n).padStart(w, '0');

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

/** `${n} photo` / `${n} photos` — spelled one way everywhere. */
export const photoCount = (n) => `${n} photo${n === 1 ? '' : 's'}`;

/** Seconds elapsed since midnight — the timeline's x coordinate. */
export function secOfDay(dt) {
  if (!dt) return null;
  return +dt.slice(11, 13) * 3600 + +dt.slice(14, 16) * 60 + +dt.slice(17, 19);
}

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
 * plain click replaces. `anchor` is the index a shift-click ranges from; pass
 * it only from views that have a stable order to range over.
 */
export function clickSelect(id, { toggle = false, extend = false, anchor = null } = {}) {
  if (toggle) {
    state.selection.has(id) ? state.selection.delete(id) : state.selection.add(id);
  } else if (extend && anchor !== null) {
    const to = state.photos.findIndex((p) => p.id === id);
    const [a, b] = [anchor, to].sort((x, y) => x - y);
    for (let i = a; i <= b; i++) state.selection.add(state.photos[i].id);
  } else {
    state.selection.clear();
    state.selection.add(id);
  }
  emit();
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

/** Treat the photo's current values as saved — its new baseline. */
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
}

/** Call immediately *before* mutating photo fields. */
export function commit() {
  state.undo.push(snapshot());
  // Snapshots cover every photo, so depth costs memory on large folders; 50
  // steps is far more than interactive editing ever walks back.
  if (state.undo.length > 50) state.undo.shift();
  state.redo.length = 0;
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
