/* Pure edit logic: parsing and merging for the inspector's fields.
 *
 * Nothing here touches the DOM or the backend, so Node can import and test it.
 * Code that computes new photo values from inspector input goes here; app.js
 * holds only the event wiring.
 */

import { dayOf, timeOf, normDt, seedDay } from './state.js';

/* ── Shared values across a selection ──────────────────────────── */

/** Returned by `common` when the selected photos hold different values. */
export const MULTI = Symbol('multiple');

/** The value `fn` gives for every photo in `sel`, or MULTI if they differ.
 *  Empty selections have no value at all, which is null rather than MULTI. */
export function common(sel, fn) {
  if (!sel.length) return null;
  const first = fn(sel[0]);
  return sel.every((p) => fn(p) === first) ? first : MULTI;
}

/* ── The date/time half merge ──────────────────────────────────── */

/** The time of day an undated photo is given. Noon leaves room to shift either
 *  way without crossing into another date. */
export const NOON = '12:00:00';

/** Where the date/time field starts for a photo that has no date at all. */
export const seedDateTime = (p) => `${seedDay(p)}T${NOON}`;

/**
 * What `p.datetime` becomes when a date and/or time is applied to it. A null
 * half is left as it is, so editing one field across a mixed selection keeps
 * each photo's own other half.
 *
 * A photo with no date at all has no halves to keep, so it starts from its
 * seed day at noon.
 */
export function mergeDateTime(p, { date, time }) {
  const d = date ?? dayOf(p.datetime) ?? seedDay(p);
  const t = time ?? timeOf(p.datetime) ?? NOON;
  return normDt(`${d}T${t}`);
}

/* ── Shift amounts ─────────────────────────────────────────────── */

/**
 * "+3h47m", "-15s", "1d 2h", "-0:15" → seconds, or null if unreadable.
 *
 * Accepts the colon form ("-0:15") and the unit form ("+3h47m"). A leading sign
 * applies to the whole amount.
 */
export function parseShift(text) {
  const t = text.replace(/−/g, '-').replace(/\s+/g, '');
  let m = /^([+-]?)(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(t);
  if (m) return (m[1] === '-' ? -1 : 1) * (+m[2] * 3600 + +m[3] * 60 + +(m[4] ?? 0));
  m = /^([+-]?)(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(t);
  if (!m || !(m[2] || m[3] || m[4] || m[5])) return null;
  return (m[1] === '-' ? -1 : 1)
    * ((+m[2] || 0) * 86400 + (+m[3] || 0) * 3600 + (+m[4] || 0) * 60 + (+m[5] || 0));
}
