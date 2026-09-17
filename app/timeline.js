/* Timeline view — one continuous track across the whole set of photos.
 *
 * Wall-clock time runs left to right with day boundaries marked, so a trip is
 * one strip and moving a photo past midnight is an ordinary drag.
 *
 *   drag a chip          set its time
 *   drag empty space     draw a selection box
 *   wheel / Ctrl+wheel   pan / zoom around the pointer (a pinch zooms too)
 *   drag the axis        pan
 *
 * The important rule: when the dragged photo is part of a multi-photo selection,
 * the *whole selection shifts by the same delta*, preserving the intervals
 * between shots. That is the fix for the overwhelmingly common real problem —
 * a camera clock that was set wrong for an entire trip. Hold Alt to move a
 * single photo out of formation instead.
 */

import {
  state, selected, applyEdit, emit, clickSelect, markClasses, photoCount,
  dtToMs, msToDt, dayOf, fmtDayLabel, fmtDur, seedDay,
} from './state.js';
import { replay, keyedList } from './dom.js';

const DAY_MS = 86400000;
/** Zoom limits: about 1 min across 1000px, up to about 10 years. */
const MIN_MS_PER_PX = 60;
const MAX_MS_PER_PX = 10 * 365 * DAY_MS / 1000;
/** Tick spacings, smallest first; the first one at least MIN_TICK_PX apart wins. */
const TICKS = [60, 300, 900, 1800, 3600, 10800, 21600, 43200, 86400, 604800, 2592000]
  .map((s) => s * 1000);
const MIN_TICK_PX = 64;
/** Pointer distance from an edge that starts panning during a drag. */
const EDGE_PX = 36;

const HINT = 'Drag a photo to set its time · Ctrl+scroll to zoom · drag empty space to select';

let els = {};
/** Wall-clock ms at the left edge, and the zoom. */
const view = { start: 0, msPerPx: 60000 };
/** photo id -> chip element, kept across renders. */
let chips = null;
let drag = null;
/** A drag coming in from the filmstrip, previewed but not yet dropped. */
let incoming = null;

/** Chip footprint and row geometry, derived from the --chip CSS variable so
 *  size stays defined in exactly one place. */
function metrics() {
  const px = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--chip'));
  const chip = Number.isFinite(px) && px > 0 ? px : 50;
  // Rows leave room under each chip for the time label a selected chip shows.
  return { chip, gap: chip + 6, rowH: chip + 18 };
}

const trackBox = () => els.track.getBoundingClientRect();
const xOf = (ms) => (ms - view.start) / view.msPerPx;
const msAtClient = (clientX) => view.start + (clientX - trackBox().left) * view.msPerPx;
const snap = (ms) => Math.round(ms / 1000) * 1000;
const dayStartMs = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;

export function initTimeline(refs) {
  els = refs;
  // Chips are keyed by photo, so a render moves them instead of rebuilding
  // them; the grid, the empty message and the drop guide are not the list's.
  chips = keyedList(els.track, { key: (d) => d.p.id, create: chipEl, update: placeChip });
  els.track.addEventListener('pointerdown', onTrackDown);
  els.axis.addEventListener('pointerdown', onAxisDown);
  els.root.addEventListener('wheel', onWheel, { passive: false });
  els.hint(HINT);
}

/* ── Framing ───────────────────────────────────────────────────── */

function frame(lo, hi) {
  const W = els.track.clientWidth;
  if (!W) return false;
  const pad = Math.min(80, W * 0.12);
  // Never zoom in past a couple of hours just because the span is tiny.
  const span = Math.max(hi - lo, 2 * 3600000);
  view.msPerPx = clampScale(span / Math.max(40, W - 2 * pad));
  view.start = (lo + hi) / 2 - (W / 2) * view.msPerPx;
  return true;
}

const clampScale = (s) => Math.min(MAX_MS_PER_PX, Math.max(MIN_MS_PER_PX, s));

/** Fit every dated photo, or the undated photos' likely day if none has one. */
export function fit() {
  if (!els.track) return;
  const ms = state.photos.filter((p) => p.datetime).map((p) => dtToMs(p.datetime));
  if (ms.length) frame(Math.min(...ms), Math.max(...ms));
  else {
    const day = dtToMs(`${state.photos.length ? seedDay(state.photos[0]) : new Date().toISOString().slice(0, 10)}T00:00:00`);
    frame(day, day + DAY_MS);
  }
  render();
}

/** Bring these photos into view and pulse their chips so the eye finds them. */
export function reveal(ids) {
  const ms = state.photos.filter((p) => ids.includes(p.id) && p.datetime).map((p) => dtToMs(p.datetime));
  if (!ms.length || !els.track) return;
  const lo = Math.min(...ms);
  const hi = Math.max(...ms);
  const W = els.track.clientWidth;
  if (hi - lo > W * 0.8 * view.msPerPx) frame(lo, hi);
  else view.start = (lo + hi) / 2 - (W / 2) * view.msPerPx;
  render();
  for (const id of ids) {
    const el = chips.get(id);
    if (!el) continue;
    replay(el, 'pulse');
  }
}

/* ── Rendering ─────────────────────────────────────────────────── */

let queued = false;
/** Re-render at most once a frame, for wheel and pan streams. */
function renderSoon() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; if (drag) layoutDuringDrag(); else render(); });
}

export function render() {
  if (!els.track || drag) return;
  const W = els.track.clientWidth;
  if (!W) return;
  if (!view.start) fit();

  els.track.querySelector('.tlBox')?.remove();
  const grid = gridEl(W);
  const old = els.track.querySelector('.tlGrid');
  if (old) old.replaceWith(grid); else els.track.prepend(grid);

  const { gap, rowH } = metrics();
  const rows = Math.max(1, Math.floor((els.track.clientHeight - 10) / rowH));
  const dated = state.photos
    .filter((p) => p.datetime)
    .map((p) => ({ p, ms: dtToMs(p.datetime) }))
    .sort((a, b) => a.ms - b.ms || a.p.name.localeCompare(b.p.name, undefined, { numeric: true }));

  // Rows: a photo that would overlap the one before it steps one row down, and
  // a clear gap starts again at the top. Earliest is always on top, so a
  // burst reads as a staircase and nothing jumps rows for no visible reason.
  // A burst deeper than the track piles up on the bottom row rather than
  // wrapping back over the photos at the top.
  let prevX = -Infinity;
  let step = 0;
  for (const d of dated) {
    const x = xOf(d.ms);
    step = x - prevX >= gap ? 0 : step + 1;
    prevX = x;
    d.x = x;
    d.top = 6 + Math.min(step, rows - 1) * rowH;
  }
  chips.sync(dated);

  showEmpty(dated.length ? null : state.photos.length);
  drawAxis(W);
}

/** The stand-in shown when nothing on the timeline has a date yet. */
function showEmpty(n) {
  const msg = els.track.querySelector('.tlEmpty');
  if (n === null) { msg?.remove(); return; }
  const el = msg ?? Object.assign(document.createElement('div'), { className: 'tlEmpty' });
  el.textContent = n
    ? `None of these ${photoCount(n)} has a date yet. Drag them here from the list to date them.`
    : 'Open a folder to see its photos along a timeline.';
  if (!msg) els.track.appendChild(el);
}

function chipEl() {
  const el = document.createElement('div');
  el.appendChild(Object.assign(document.createElement('div'), { className: 'chipTime' }));
  return el;
}

function placeChip(el, { p, x, top }) {
  // Assigning the class wholesale also clears the transient `drag` and `pulse`
  // markers a previous gesture left behind.
  el.className = markClasses('chip', p);
  el.dataset.id = p.id;
  el.title = `${p.name}\n${p.datetime.replace('T', ' ')}`;
  if (p.thumb) el.style.backgroundImage = `url('${p.thumb}')`;
  else el.dataset.ext = p.ext || '?';  // no decoder for this format in this browser
  el.style.left = `${x}px`;
  el.style.top = `${top}px`;
  el.firstChild.textContent = p.datetime.slice(11, 16);
}

function tickStep() {
  return TICKS.find((s) => s / view.msPerPx >= MIN_TICK_PX) ?? TICKS[TICKS.length - 1];
}

/** Day bands and tick lines behind the chips. */
function gridEl(W) {
  const grid = document.createElement('div');
  grid.className = 'tlGrid';
  const end = view.start + W * view.msPerPx;
  for (let d = dayStartMs(view.start); d < end; d += DAY_MS) {
    const band = document.createElement('div');
    band.className = `tlBand${Math.floor(d / DAY_MS) % 2 ? ' odd' : ''}`;
    band.style.left = `${xOf(d)}px`;
    band.style.width = `${DAY_MS / view.msPerPx}px`;
    grid.appendChild(band);
  }
  const step = tickStep();
  for (let t = Math.ceil(view.start / step) * step; t < end; t += step) {
    const line = document.createElement('div');
    line.className = `tlTick${t % DAY_MS === 0 ? ' day' : ''}`;
    line.style.left = `${xOf(t)}px`;
    grid.appendChild(line);
  }
  return grid;
}

/** Day names on top, tick times underneath. Day names stick to the left edge
 *  while their day is on screen, so you always know which day you are in. */
function drawAxis(W) {
  const frag = document.createDocumentFragment();
  const end = view.start + W * view.msPerPx;
  const dayW = DAY_MS / view.msPerPx;
  for (let d = dayStartMs(view.start); d < end; d += DAY_MS) {
    if (dayW < 44) break;
    const lab = document.createElement('div');
    lab.className = 'tlDay';
    lab.textContent = fmtDayLabel(msToDt(d).slice(0, 10));
    const x = xOf(d);
    lab.style.left = `${Math.max(x, Math.min(0, x + dayW - 140)) + 6}px`;
    lab.style.maxWidth = `${dayW - 12}px`;
    frag.appendChild(lab);
  }
  const step = tickStep();
  for (let t = Math.ceil(view.start / step) * step; t < end; t += step) {
    const lab = document.createElement('div');
    lab.className = 'tlTime';
    lab.style.left = `${xOf(t)}px`;
    const stamp = msToDt(t);
    lab.textContent = step >= DAY_MS
      ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
      : stamp.slice(11, 16);
    frag.appendChild(lab);
  }
  els.axis.replaceChildren(frag);
}

/* ── Wheel and axis panning ────────────────────────────────────── */

function onWheel(ev) {
  ev.preventDefault();
  const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? els.track.clientWidth : 1;
  if (ev.ctrlKey || ev.metaKey) {
    const at = msAtClient(ev.clientX);
    view.msPerPx = clampScale(view.msPerPx * Math.exp(ev.deltaY * unit * 0.0022));
    view.start = at - (ev.clientX - trackBox().left) * view.msPerPx;
  } else {
    // Vertical wheels pan too: a timeline has only one direction to go.
    const d = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
    view.start += d * unit * view.msPerPx;
  }
  renderSoon();
}

function onAxisDown(ev) {
  if (ev.button !== 0) return;
  ev.preventDefault();
  const x0 = ev.clientX;
  const start0 = view.start;
  els.axis.classList.add('panning');
  const move = (e) => { view.start = start0 - (e.clientX - x0) * view.msPerPx; renderSoon(); };
  const up = () => {
    window.removeEventListener('pointermove', move);
    els.axis.classList.remove('panning');
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up, { once: true });
}

/* ── Chip drags and selection boxes ────────────────────────────── */

const lastPress = { id: null, at: 0 };

function onTrackDown(ev) {
  if (ev.button !== 0) return;
  const hit = ev.target.closest('.chip');
  if (hit) chipDown(ev, hit.dataset.id);
  else boxDown(ev);
}

function chipDown(ev, id) {
  const p = state.photos.find((q) => q.id === id);
  if (!p) return;

  // Chips are rebuilt on every selection change, so the browser never sees a
  // click on one element, let alone a dblclick. Count presses ourselves.
  const now = performance.now();
  if (lastPress.id === id && now - lastPress.at < 400) {
    lastPress.id = null;
    els.onReveal?.(id);
    return;
  }
  lastPress.id = id;
  lastPress.at = now;

  if (ev.ctrlKey || ev.metaKey) {
    clickSelect(id, { toggle: true });
    return;
  }
  if (!state.selection.has(id)) clickSelect(id);

  // Alt breaks the photo out of the group so it can be moved on its own.
  const solo = ev.altKey || state.selection.size <= 1;
  const group = solo ? [p] : selected().filter((q) => q.datetime);
  const origin = new Map(group.map((q) => [q.id, dtToMs(q.datetime)]));
  drag = {
    kind: 'chips', p, group, origin,
    // Where in the photo's own time the pointer grabbed it, so the chip stays
    // under the pointer even while the view pans.
    offset: origin.get(p.id) - msAtClient(ev.clientX),
    startX: ev.clientX, clientX: ev.clientX,
    moved: false, delta: 0,
  };
  chips.get(id)?.classList.add('drag');
  startPointerDrag(ev);
}

function boxDown(ev) {
  const r = trackBox();
  drag = {
    kind: 'box',
    x0: ev.clientX - r.left, y0: ev.clientY - r.top,
    additive: ev.ctrlKey || ev.metaKey || ev.shiftKey,
    base: new Set(state.selection),
    moved: false,
  };
  startPointerDrag(ev);
}

function startPointerDrag(ev) {
  // Window-level listeners rather than pointer capture: capture is bound to an
  // element identity that a re-render can invalidate.
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp, { once: true });
  ev.preventDefault();
}

function onPointerMove(ev) {
  if (!drag) return;
  if (drag.kind === 'box') { moveBox(ev); return; }
  if (!drag.moved && Math.abs(ev.clientX - drag.startX) < 3) return;
  drag.moved = true;
  drag.clientX = ev.clientX;
  autoPan(ev.clientX);
  layoutDuringDrag();
}

/** Keep panning while a dragged chip is held against either edge. */
function autoPan(clientX) {
  const r = trackBox();
  const push = clientX < r.left + EDGE_PX ? -1 : clientX > r.right - EDGE_PX ? 1 : 0;
  if (!push) { drag.panning = false; return; }
  if (drag.panning) return;
  drag.panning = true;
  const tick = () => {
    if (!drag || !drag.panning) return;
    const rr = trackBox();
    const depth = drag.clientX < rr.left + EDGE_PX
      ? rr.left + EDGE_PX - drag.clientX
      : drag.clientX - (rr.right - EDGE_PX);
    if (depth <= 0) { drag.panning = false; return; }
    view.start += Math.sign(drag.clientX - rr.left - rr.width / 2) * Math.min(24, depth / 2 + 4) * view.msPerPx;
    layoutDuringDrag();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Reposition everything for the current drag without rebuilding the chips. */
function layoutDuringDrag() {
  const W = els.track.clientWidth;
  const grid = els.track.querySelector('.tlGrid');
  if (grid) grid.replaceWith(gridEl(W));
  drawAxis(W);
  if (drag?.kind !== 'chips') return;

  const target = snap(msAtClient(drag.clientX) + drag.offset);
  drag.delta = target - drag.origin.get(drag.p.id);
  for (const p of state.photos) {
    const el = chips.get(p.id);
    if (!el) continue;
    const o = drag.origin.get(p.id);
    const ms = o != null ? o + drag.delta : dtToMs(p.datetime);
    el.style.left = `${xOf(ms)}px`;
    if (o != null) el.querySelector('.chipTime').textContent = msToDt(ms).slice(11, 16);
  }
  const stamp = msToDt(target);
  const n = drag.group.length;
  const moved = dayOf(stamp) !== dayOf(msToDt(drag.origin.get(drag.p.id)));
  showDrop(xOf(target), stamp.slice(11, 19),
    `${fmtDur(drag.delta / 1000)}${moved ? ` · ${fmtDayLabel(dayOf(stamp))}` : ''}${n > 1 ? ` · ${n} photos` : ''}`);
  els.hint(n > 1
    ? `${fmtDur(drag.delta / 1000)} · shifting ${n} photos together (hold Alt to move one)`
    : `${fmtDur(drag.delta / 1000)} · ${stamp.replace('T', ' ')}`);
}

function moveBox(ev) {
  const r = trackBox();
  const x = ev.clientX - r.left;
  const y = ev.clientY - r.top;
  if (!drag.moved && Math.hypot(x - drag.x0, y - drag.y0) < 4) return;
  drag.moved = true;
  const [left, right] = [Math.min(x, drag.x0), Math.max(x, drag.x0)];
  const [top, bottom] = [Math.min(y, drag.y0), Math.max(y, drag.y0)];
  let box = els.track.querySelector('.tlBox');
  if (!box) {
    box = document.createElement('div');
    box.className = 'tlBox';
    els.track.appendChild(box);
  }
  Object.assign(box.style, {
    left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px`,
  });
  // Highlight live, but only tell the rest of the app when the box is let go:
  // re-rendering the map on every pointer move is far too much work.
  drag.hits = new Set();
  for (const [id, el] of chips.entries()) {
    const c = el.getBoundingClientRect();
    const cx0 = c.left - r.left;
    const cy0 = c.top - r.top;
    const inBox = cx0 < right && cx0 + c.width > left && cy0 < bottom && cy0 + c.height > top;
    if (inBox) drag.hits.add(id);
    el.classList.toggle('sel', inBox || (drag.additive && drag.base.has(id)));
  }
}

function onPointerUp() {
  window.removeEventListener('pointermove', onPointerMove);
  const d = drag;
  drag = null;
  if (!d) return;
  hideDrop();
  els.hint(HINT);

  if (d.kind === 'box') {
    if (d.moved) {
      if (!d.additive) state.selection.clear();
      for (const id of d.hits ?? []) state.selection.add(id);
      emit();
    } else if (!d.additive && state.selection.size) {
      // A plain click on empty track clears the selection, as in any editor.
      state.selection.clear();
      emit();
    } else render();
    return;
  }

  if (!d.moved || !d.delta) { render(); return; }
  applyEdit(d.group, (ps) => {
    for (const q of ps) q.datetime = msToDt(d.origin.get(q.id) + d.delta);
  });
}

/** Shift every selected photo that has a date by `sec` seconds. */
export function shiftSelection(sec) {
  return applyEdit(selected().filter((p) => p.datetime), (ps) => {
    for (const p of ps) p.datetime = msToDt(dtToMs(p.datetime) + sec * 1000);
  });
}

/* ── Drops from the filmstrip ──────────────────────────────────── */

/**
 * Dated photos keep their spacing and move so the grabbed photo (or, if that
 * one has no date, the earliest dated one) lands on the pointer. Undated
 * photos land exactly at the pointer, ready to be spread out.
 */
function planDrop(x, ids, grabbed) {
  const target = snap(msAtClient(x));
  const photos = state.photos.filter((p) => ids.includes(p.id));
  const dated = photos.filter((p) => p.datetime);
  const g = dated.find((p) => p.id === grabbed);
  const anchor = g ? dtToMs(g.datetime) : dated.length ? Math.min(...dated.map((p) => dtToMs(p.datetime))) : null;
  return {
    target,
    delta: anchor == null ? 0 : target - anchor,
    dated,
    undated: photos.filter((p) => !p.datetime),
  };
}

export const dropTarget = {
  hover(x, y, ids, grabbed) {
    if (!els.track?.clientWidth) return false;
    const r = trackBox();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false;
    const plan = planDrop(x, ids, grabbed);
    incoming = plan;
    els.track.classList.add('dropping');
    for (const p of plan.dated) {
      const el = chips.get(p.id);
      if (el) el.style.left = `${xOf(dtToMs(p.datetime) + plan.delta)}px`;
    }
    const parts = [];
    if (plan.dated.length) parts.push(`${fmtDur(plan.delta / 1000)} · ${photoCount(plan.dated.length)}`);
    if (plan.undated.length) parts.push(`${photoCount(plan.undated.length)} dated here`);
    showDrop(xOf(plan.target), msToDt(plan.target).slice(11, 19), parts.join(' · '));
    return true;
  },
  leave() {
    if (!incoming) return;
    incoming = null;
    els.track.classList.remove('dropping');
    hideDrop();
    render();
  },
  drop(x, y, ids, grabbed) {
    const plan = planDrop(x, ids, grabbed);
    incoming = null;
    els.track.classList.remove('dropping');
    hideDrop();
    applyEdit([...plan.dated, ...plan.undated], () => {
      for (const p of plan.dated) p.datetime = msToDt(dtToMs(p.datetime) + plan.delta);
      for (const p of plan.undated) p.datetime = msToDt(plan.target);
    });
  },
};

/* ── Drop indicator ────────────────────────────────────────────── */

let dropline = null;

/** Vertical guide at the exact landing point, labelled with the resulting
 *  time. Reading the target off the cursor beats hunting for it in a corner. */
function showDrop(x, timeLabel, note) {
  if (!dropline) {
    dropline = document.createElement('div');
    dropline.className = 'dropline';
    dropline.innerHTML = '<div class="lab"></div><div class="note"></div>';
  }
  if (dropline.parentElement !== els.track) els.track.appendChild(dropline);
  dropline.style.left = `${x}px`;
  dropline.querySelector('.lab').textContent = timeLabel;
  const n = dropline.querySelector('.note');
  n.textContent = note || '';
  n.classList.toggle('hidden', !note);
}

function hideDrop() {
  if (dropline && dropline.parentElement) dropline.remove();
}
