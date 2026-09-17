/* Date-time field: one "YYYY-MM-DD HH:MM:SS" input, edited segment by segment.
 *
 * Replaces the native date and time inputs, which commit on every keystroke,
 * render differently in every browser, and whose calendar popups ignore the
 * keyboard and outside clicks.
 *
 *   click            select the segment under the pointer
 *   ← → / - : space  move between segments
 *   ↑ ↓              step the segment, carrying into its neighbours
 *   digits           type the segment; it advances once it is unambiguous
 *   Enter / leave    commit       Esc   discard
 *
 * Nothing reaches the photos until a commit, and a commit reports only the
 * halves that changed, so editing the date of a mixed selection keeps each
 * photo's own time and vice versa.
 */

import { dtToMs, msToDt, dayOf, timeOf, pad } from './state.js';

/** [start, end] of each segment in "YYYY-MM-DD HH:MM:SS". */
const SEGS = [[0, 4], [5, 7], [8, 10], [11, 13], [14, 16], [17, 19]];
const MIN = [1, 1, 1, 0, 0, 0];
const MAX = [9999, 12, 31, 23, 59, 59];
/** Seconds per unit; years and months have no fixed length and step apart. */
const UNIT = [null, null, 86400, 3600, 60, 1];

/** Days in month `m` (1–12) of year `y`: day 0 of the next month. */
function daysIn(y, m) {
  const d = new Date(0);
  d.setUTCFullYear(y, m, 0);
  return d.getUTCDate();
}

/** [year, month] `n` months on from month `m` (1–12) of year `y`. */
function addMonths(y, m, n) {
  const i = y * 12 + m - 1 + n;
  return [Math.floor(i / 12), ((i % 12) + 12) % 12 + 1];
}

const parts = (text) => SEGS.map(([a, b]) => +text.slice(a, b));
function format(p) {
  const d = Math.min(p[2], daysIn(p[0], p[1]));
  return `${pad(p[0], 4)}-${pad(p[1], 2)}-${pad(d, 2)} ${pad(p[3], 2)}:${pad(p[4], 2)}:${pad(p[5], 2)}`;
}
const toText = (dt) => dt.replace('T', ' ');
const toDt = (text) => text.replace(' ', 'T');

/**
 * @param input    a text <input>
 * @param opts.onCommit({date, time}) gets "YYYY-MM-DD" / "HH:MM:SS", or null
 *                 when that half was left alone
 * @returns {set(value, {mixed, fallback})}
 */
export function dateTimeField(input, { onCommit }) {
  input.spellcheck = false;
  input.autocomplete = 'off';

  let value = null;      // committed value shown when idle, or null
  let mixed = false;     // selection disagrees, so nothing single to show
  let fallback = null;   // where editing starts from when there is no value
  let start = null;      // text at the start of this edit
  let draft = null;      // text while editing
  let seg = 0;
  let typed = '';

  const editing = () => draft !== null;

  function showIdle() {
    input.value = mixed || value == null ? '' : toText(value);
    input.placeholder = mixed ? 'multiple' : 'YYYY-MM-DD HH:MM:SS';
    input.classList.toggle('multi', mixed);
  }

  function select() {
    input.value = draft;
    input.setSelectionRange(SEGS[seg][0], SEGS[seg][1]);
  }

  function begin() {
    if (editing()) return;
    const from = value ?? fallback;
    if (!from) return;
    start = draft = toText(from);
    typed = '';
  }

  /** Close a half-typed segment, clamping it into range. */
  function settle() {
    if (!typed) return;
    const p = parts(draft);
    p[seg] = Math.min(MAX[seg], Math.max(MIN[seg], +typed));
    draft = format(p);
    typed = '';
  }

  function moveTo(i) {
    settle();
    seg = Math.max(0, Math.min(SEGS.length - 1, i));
    select();
  }

  function step(dir) {
    settle();
    const p = parts(draft);
    if (seg === 0) p[0] = Math.min(MAX[0], Math.max(MIN[0], p[0] + dir));
    else if (seg === 1) [p[0], p[1]] = addMonths(p[0], p[1], dir);
    else {
      draft = toText(msToDt(dtToMs(toDt(draft)) + dir * UNIT[seg] * 1000));
      select();
      return;
    }
    draft = format(p);
    select();
  }

  function typeDigit(d) {
    const [a, b] = SEGS[seg];
    const width = b - a;
    typed += d;
    // A first digit that no two-digit value in range could start with is
    // already the whole answer: "4" in the month can only mean April.
    const done = typed.length === width
      || (width === 2 && +typed * 10 > MAX[seg]);
    draft = draft.slice(0, a) + pad(typed, width) + draft.slice(b);
    if (done) {
      settle();
      if (seg < SEGS.length - 1) seg++;
    }
    select();
  }

  function commit() {
    settle();
    if (!editing()) return;
    const date = dayOf(draft) !== dayOf(start) ? dayOf(draft) : null;
    const time = timeOf(draft) !== timeOf(start) ? timeOf(draft) : null;
    start = draft;
    if (date || time) onCommit({ date, time });
  }

  function end({ keep }) {
    if (keep) commit();
    draft = start = null;
    typed = '';
    showIdle();
  }

  input.addEventListener('mousedown', () => {
    // Let the browser place the caret first, then widen it to the segment.
    requestAnimationFrame(() => {
      if (!editing()) begin();
      if (!editing()) return;
      const at = input.selectionStart ?? 0;
      const i = SEGS.findIndex(([, b]) => at <= b);
      moveTo(i === -1 ? SEGS.length - 1 : i);
    });
  });

  input.addEventListener('focus', () => {
    begin();
    if (editing()) { seg = 0; select(); }
  });

  input.addEventListener('blur', () => end({ keep: true }));

  input.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Tab') return;
    if (!editing()) begin();
    if (!editing()) return;
    e.preventDefault();

    if (e.key === 'ArrowLeft') moveTo(seg - 1);
    else if (e.key === 'ArrowRight') moveTo(seg + 1);
    else if (e.key === 'ArrowUp') step(1);
    else if (e.key === 'ArrowDown') step(-1);
    else if (/^\d$/.test(e.key)) typeDigit(e.key);
    else if (e.key === '-' || e.key === ':' || e.key === ' ') moveTo(seg + 1);
    else if (e.key === 'Home') moveTo(0);
    else if (e.key === 'End') moveTo(SEGS.length - 1);
    else if (e.key === 'Backspace' || e.key === 'Delete') {
      // Put the segment back as it was at the start of the edit.
      typed = '';
      const [a, b] = SEGS[seg];
      draft = draft.slice(0, a) + start.slice(a, b) + draft.slice(b);
      select();
    } else if (e.key === 'Enter') {
      commit();
      select();
    } else if (e.key === 'Escape') {
      // Esc here means "undo my typing", not "clear the selection".
      // Drop the edit before blurring, or the blur would commit what was typed.
      e.stopPropagation();
      end({ keep: false });
      input.blur();
    }
  });

  input.addEventListener('paste', (e) => {
    e.preventDefault();
    const m = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/
      .exec(e.clipboardData.getData('text'));
    if (!m) return;
    begin();
    if (!editing()) start = draft = '0001-01-01 00:00:00';
    draft = format([+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0)]);
    typed = '';
    select();
  });

  // Anything that bypasses keydown (autofill, IME, drag-and-drop text) is
  // reverted rather than half-parsed.
  input.addEventListener('input', () => {
    if (editing()) select(); else showIdle();
  });

  return {
    set(v, opts = {}) {
      value = v;
      mixed = !!opts.mixed;
      fallback = opts.fallback ?? null;
      // Never overwrite what the user is in the middle of typing.
      if (!editing()) showIdle();
    },
  };
}

/* ── Calendar popover ──────────────────────────────────────────── */

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const dayAt = (ms) => dayOf(msToDt(ms));
const DAY_MS = 86400000;

/**
 * A month grid anchored to `button`. Arrow keys move by day and week, PageUp
 * and PageDown by month; Enter picks; Esc or a click outside closes.
 *
 * @param opts.current() "YYYY-MM-DD" to open on, or null for today
 * @param opts.onPick(day)
 * @param opts.absorbIn  elements where a bare click edits photos, so the click
 *                 that closes the calendar must not also land there
 */
export function calendar(button, { current, onPick, absorbIn = [] }) {
  const pop = document.createElement('div');
  pop.className = 'cal hidden';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Choose a date');
  pop.innerHTML =
    '<div class="calHead">' +
    '<button type="button" class="calNav" data-dir="-1" aria-label="Previous month">‹</button>' +
    '<b class="calTitle" aria-live="polite"></b>' +
    '<button type="button" class="calNav" data-dir="1" aria-label="Next month">›</button>' +
    '</div>' +
    `<div class="calWeek">${WEEKDAYS.map((d) => `<span>${d}</span>`).join('')}</div>` +
    '<div class="calGrid" role="grid" tabindex="0"></div>';
  document.body.appendChild(pop);
  const grid = pop.querySelector('.calGrid');

  let focusMs = 0;
  let chosen = null;

  function draw() {
    const focus = dayAt(focusMs);
    const [y, m] = [+focus.slice(0, 4), +focus.slice(5, 7)];
    const first = dtToMs(`${pad(y, 4)}-${pad(m, 2)}-01T00:00:00`);
    const lead = (new Date(first).getUTCDay() + 6) % 7; // Monday first
    pop.querySelector('.calTitle').textContent = new Date(first)
      .toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });

    const frag = document.createDocumentFragment();
    for (let i = 0; i < 42; i++) {
      const ms = first + (i - lead) * DAY_MS;
      const d = dayAt(ms);
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.tabIndex = -1;
      cell.dataset.day = d;
      cell.textContent = +d.slice(8);
      cell.className = 'calDay'
        + (+d.slice(5, 7) !== m ? ' out' : '')
        + (d === focus ? ' focus' : '')
        + (d === chosen ? ' on' : '');
      cell.setAttribute('aria-label', d);
      frag.appendChild(cell);
    }
    grid.replaceChildren(frag);
  }

  function place() {
    const r = button.getBoundingClientRect();
    const h = pop.offsetHeight;
    const w = pop.offsetWidth;
    const top = r.top - h - 6 >= 8 ? r.top - h - 6 : r.bottom + 6;
    pop.style.top = `${top}px`;
    pop.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left))}px`;
  }

  function open() {
    chosen = current();
    focusMs = dtToMs(`${chosen ?? new Date().toISOString().slice(0, 10)}T00:00:00`);
    draw();
    pop.classList.remove('hidden');
    place();
    grid.focus();
    button.setAttribute('aria-expanded', 'true');
    window.addEventListener('pointerdown', onPointerOutside, true);
  }

  function close({ refocus = true } = {}) {
    if (pop.classList.contains('hidden')) return;
    pop.classList.add('hidden');
    button.setAttribute('aria-expanded', 'false');
    window.removeEventListener('pointerdown', onPointerOutside, true);
    if (refocus) button.focus();
  }

  function onPointerOutside(e) {
    if (pop.contains(e.target) || button.contains(e.target)) return;
    close({ refocus: false });
    // Anywhere else the click goes through, so a card or Save still works.
    if (!absorbIn.some((el) => el.contains(e.target))) return;
    const swallow = (c) => { c.stopPropagation(); c.preventDefault(); };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, true), 500);
  }

  function shiftMonth(dir) {
    const d = dayAt(focusMs);
    const [y, m] = addMonths(+d.slice(0, 4), +d.slice(5, 7), dir);
    const day = Math.min(+d.slice(8), daysIn(y, m));
    focusMs = dtToMs(`${pad(y, 4)}-${pad(m, 2)}-${pad(day, 2)}T00:00:00`);
    draw();
  }

  function pick(day) {
    close();
    onPick(day);
  }

  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () => {
    if (pop.classList.contains('hidden')) open(); else close();
  });

  pop.addEventListener('click', (e) => {
    const nav = e.target.closest('.calNav');
    if (nav) { shiftMonth(+nav.dataset.dir); grid.focus(); return; }
    const cell = e.target.closest('.calDay');
    if (cell) pick(cell.dataset.day);
  });

  pop.addEventListener('keydown', (e) => {
    // The window-level shortcuts (arrows nudge time, Esc clears the selection)
    // must not see keys meant for the calendar.
    e.stopPropagation();
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in moves) {
      e.preventDefault();
      focusMs += moves[e.key] * DAY_MS;
      draw();
    } else if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      shiftMonth(e.key === 'PageUp' ? -1 : 1);
    } else if ((e.key === 'Enter' || e.key === ' ') && e.target === grid) {
      e.preventDefault();
      pick(dayAt(focusMs));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      close({ refocus: false });
    }
  });

  window.addEventListener('resize', () => close({ refocus: false }));
  return { close };
}
