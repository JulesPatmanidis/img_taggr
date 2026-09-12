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
  /** Photo ids (== absolute paths), insertion-ordered. */
  selection: new Set(),
  view: 'map',
  undo: [],
  redo: [],
};

/* ── Event bus ─────────────────────────────────────────────────── */
const handlers = {};
export function on(evt, fn) { (handlers[evt] ||= []).push(fn); }
export function emit(evt, arg) { (handlers[evt] || []).forEach((fn) => fn(arg)); }

/* ── Wall-clock helpers ────────────────────────────────────────── */
const pad = (n, w = 2) => String(n).padStart(w, '0');

/** "YYYY-MM-DDTHH:MM:SS" -> ms in a fictional UTC frame. */
export function dtToMs(dt) {
  if (!dt) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(dt);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/** Inverse of dtToMs. */
export function msToDt(ms) {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

export const dayOf = (dt) => (dt ? dt.slice(0, 10) : null);
export const timeOf = (dt) => (dt ? dt.slice(11, 19) : null);

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

/** Round-trip through the parser so malformed input never reaches exiftool. */
export const normDt = (dt) => { const ms = dtToMs(dt); return ms === null ? null : msToDt(ms); };

/* ── Photo helpers ─────────────────────────────────────────────── */
export function selected() {
  return state.photos.filter((p) => state.selection.has(p.id));
}

export function isEdited(p) {
  return (
    p.datetime !== p.orig.datetime ||
    p.offset !== p.orig.offset ||
    p.lat !== p.orig.lat ||
    p.lon !== p.orig.lon
  );
}

export const editedPhotos = () => state.photos.filter(isEdited);
export const byId = (id) => state.photos.find((p) => p.id === id);

/** Coordinates round-tripped through EXIF land near 1e-7 degrees anyway; keep
 *  values comparable so a no-op drag does not mark a photo as edited. */
export const roundCoord = (v) => (v == null ? null : Math.round(v * 1e7) / 1e7);

/* ── Undo ──────────────────────────────────────────────────────── */
function snapshot() {
  return state.photos.map((p) => ({
    id: p.id, datetime: p.datetime, offset: p.offset, lat: p.lat, lon: p.lon,
  }));
}

function restore(snap) {
  const m = new Map(snap.map((s) => [s.id, s]));
  for (const p of state.photos) {
    const s = m.get(p.id);
    if (s) Object.assign(p, { datetime: s.datetime, offset: s.offset, lat: s.lat, lon: s.lon });
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
