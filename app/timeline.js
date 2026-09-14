/* Timeline view — place photos through the day.
 *
 * One horizontal track per calendar day, midnight to midnight. Dragging a chip
 * sets its wall-clock time; dragging it onto another day's track moves it there.
 *
 * The important rule: when the dragged photo is part of a multi-photo selection,
 * the *whole selection shifts by the same delta*, preserving the intervals
 * between shots. That is the fix for the overwhelmingly common real problem —
 * a camera clock that was set wrong for an entire trip. Hold Alt to move a
 * single photo out of formation instead.
 */

import {
  state, selected, commit, emit, clickSelect, markClasses, photoCount,
  dtToMs, msToDt, secOfDay, dayOf, fmtDayLabel, fmtDur,
} from './state.js';

const DAY_SEC = 86400;
const MAX_LANES = 4;

/** Chip footprint and lane geometry, derived from the --chip CSS variable so
 *  size stays defined in exactly one place. */
function metrics() {
  const px = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--chip'));
  const w = Number.isFinite(px) && px > 0 ? px : 50;
  return { chipW: w + 4, laneH: w + 6 };
}
/** Track width multiplier. 1 = whole day across the pane. */
let zoom = 1;
let els = {};
/** photo id -> chip element, rebuilt on every render. */
const chips = new Map();
let drag = null;

export function setZoom(z) { zoom = z; render(); }

export function initTimeline(refs) {
  els = refs;
  els.days.addEventListener('pointerdown', onPointerDown);
  els.tray.addEventListener('pointerdown', onPointerDown);
}

const dayStartMs = (day) => dtToMs(`${day}T00:00:00`);

function chipEl(p) {
  const el = document.createElement('div');
  el.className = markClasses('chip', p);
  el.dataset.id = p.id;
  el.title = `${p.name}\n${p.datetime ? p.datetime.replace('T', ' ') : 'no date'}`;
  if (p.thumb) el.style.backgroundImage = `url('${p.thumb}')`;
  else el.dataset.ext = p.ext || '?';  // no decoder for this format in this browser
  return el;
}

/** Tick spacing that keeps labels readable at the current zoom. */
function tickStep(width) {
  const pxPerHour = width / 24;
  if (pxPerHour > 260) return 900;   // 15 min
  if (pxPerHour > 90) return 3600;   // 1 h
  if (pxPerHour > 34) return 10800;  // 3 h
  return 21600;                      // 6 h
}

const hhmm = (sec) =>
  `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`;

export function render() {
  if (!els.days) return;
  if (drag) return; // never rebuild mid-drag; the drag handler moves chips directly
  chips.clear();

  const baseW = els.days.clientWidth - 26;
  const width = Math.max(320, Math.round(baseW * zoom));

  // ── Undated tray ──────────────────────────────────────────────
  const undated = state.photos.filter((p) => !p.datetime);
  els.trayWrap.classList.toggle('hidden', undated.length === 0);
  els.tray.replaceChildren();
  els.trayCount.textContent = undated.length ? `· ${undated.length} · drag onto a day to date them` : '';
  for (const p of undated) {
    const el = chipEl(p);
    els.tray.appendChild(el);
    chips.set(p.id, el);
  }

  // ── Day tracks ────────────────────────────────────────────────
  const byDay = new Map();
  for (const p of state.photos) {
    if (!p.datetime) continue;
    const d = dayOf(p.datetime);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(p);
  }

  // A folder where nothing carries a capture date would render no tracks at
  // all, leaving the tray with nowhere to drop onto and the whole view inert.
  // Seed days from file modification times so there is always a landing zone.
  if (!byDay.size && state.photos.length) {
    const seeds = new Set();
    for (const p of state.photos) {
      if (p.file_modified) seeds.add(p.file_modified.slice(0, 10));
    }
    if (!seeds.size) seeds.add(new Date().toISOString().slice(0, 10));
    // Cap it: a folder spanning years must not become hundreds of empty tracks.
    for (const d of [...seeds].sort().slice(0, 8)) byDay.set(d, []);
  }

  const { chipW, laneH } = metrics();
  const frag = document.createDocumentFragment();
  for (const day of [...byDay.keys()].sort()) {
    const list = byDay.get(day);
    const dayEl = document.createElement('div');
    dayEl.className = 'day';
    dayEl.style.width = `${width}px`;

    const head = document.createElement('div');
    head.className = 'dayHead';
    head.innerHTML = `<b></b><span></span>`;
    head.querySelector('b').textContent = fmtDayLabel(day);
    head.querySelector('span').textContent = list.length
      ? photoCount(list.length)
      : 'drop photos here to date them';
    dayEl.appendChild(head);

    const track = document.createElement('div');
    track.className = 'track';
    track.dataset.day = day;
    track.style.width = `${width}px`;

    const step = tickStep(width);
    for (let s = 0; s <= DAY_SEC; s += step) {
      const x = (s / DAY_SEC) * width;
      const t = document.createElement('div');
      t.className = 'tick' + (s % 21600 === 0 ? ' major' : '');
      t.style.left = `${x}px`;
      track.appendChild(t);
      if (s % (step * (step < 3600 ? 4 : 1)) === 0 && s < DAY_SEC) {
        const lab = document.createElement('div');
        lab.className = 'tickLab';
        lab.style.left = `${x}px`;
        lab.textContent = hhmm(s);
        track.appendChild(lab);
      }
    }

    // Lane packing: photos taken seconds apart would otherwise stack into one
    // illegible blob, which is exactly what a burst of shots looks like.
    const placed = list
      .map((p) => ({ p, x: (secOfDay(p.datetime) / DAY_SEC) * width }))
      .sort((a, b) => a.x - b.x);
    const laneRight = [];
    for (const item of placed) {
      let lane = laneRight.findIndex((right) => item.x - right >= chipW);
      if (lane === -1) {
        if (laneRight.length < MAX_LANES) lane = laneRight.push(-Infinity) - 1;
        // Every lane is busy: fall back to the one that cleared earliest.
        else lane = laneRight.indexOf(Math.min(...laneRight));
      }
      laneRight[lane] = item.x;

      const el = chipEl(item.p);
      el.style.left = `${item.x}px`;
      el.style.top = `${9 + lane * laneH}px`;
      const t = document.createElement('div');
      t.className = 'chipTime';
      t.textContent = item.p.datetime.slice(11, 16);
      el.appendChild(t);
      track.appendChild(el);
      chips.set(item.p.id, el);
    }
    track.style.height = `${Math.max(74, 18 + Math.max(1, laneRight.length) * laneH)}px`;

    dayEl.appendChild(track);
    frag.appendChild(dayEl);
  }

  els.days.replaceChildren(frag);
  if (!byDay.size && !undated.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.padding = '24px 2px';
    empty.textContent = 'No photos loaded.';
    els.days.appendChild(empty);
  }
}

/* ── Dragging ──────────────────────────────────────────────────── */

function trackUnder(x, y) {
  for (const t of els.days.querySelectorAll('.track')) {
    const r = t.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top - 14 && y <= r.bottom + 14) return { el: t, rect: r };
  }
  return null;
}

function onPointerDown(ev) {
  const hit = ev.target.closest('.chip');
  if (!hit || ev.button !== 0) return;
  const id = hit.dataset.id;
  const p = state.photos.find((q) => q.id === id);
  if (!p) return;

  if (ev.ctrlKey || ev.metaKey) {
    clickSelect(id, { toggle: true });
    return;
  }
  if (!state.selection.has(id)) clickSelect(id);

  // Selecting re-rendered the track, so `hit` may now be detached. Re-acquire
  // the live element before starting the drag, or the gesture moves a ghost.
  const el = chips.get(id);
  if (!el) return;

  // Alt breaks the photo out of the group so it can be moved on its own.
  const solo = ev.altKey || state.selection.size <= 1;
  const group = solo ? [p] : selected().filter((q) => q.datetime || q.id === id);

  drag = {
    p, el, group,
    startX: ev.clientX, startY: ev.clientY,
    fromTray: !p.datetime,
    moved: false,
    origin: new Map(group.map((q) => [q.id, q.datetime])),
  };

  // Window-level listeners rather than pointer capture: capture is bound to an
  // element identity that a re-render can invalidate.
  el.classList.add('drag');
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp, { once: true });
  ev.preventDefault();
}

/** Where the pointer currently resolves to, or null if it is off any track. */
function pointerTarget(ev) {
  const hit = trackUnder(ev.clientX, ev.clientY);
  if (!hit) return null;
  const frac = Math.min(1, Math.max(0, (ev.clientX - hit.rect.left) / hit.rect.width));
  // Snap to whole seconds; sub-second precision is not meaningful here and the
  // inspector is the right place for exact values anyway.
  const sec = Math.min(Math.round(frac * DAY_SEC), DAY_SEC - 1);
  return {
    track: hit.el,
    day: hit.el.dataset.day,
    ms: dayStartMs(hit.el.dataset.day) + sec * 1000,
    // Taken from the snapped second, not the raw pointer, so the marker shows
    // the value that will actually be written rather than where the mouse is.
    x: (sec / DAY_SEC) * hit.rect.width,
  };
}

/* ── Drop indicator ────────────────────────────────────────────── */

let dropline = null;

/** Vertical guide at the exact landing point, labelled with the resulting
 *  time. Reading the target off the cursor beats hunting for it in a corner. */
function showDrop(target, timeLabel, note) {
  if (!dropline) {
    dropline = document.createElement('div');
    dropline.className = 'dropline';
    dropline.innerHTML = '<div class="lab"></div><div class="note"></div>';
  }
  if (dropline.parentElement !== target.track) target.track.appendChild(dropline);
  dropline.style.left = `${target.x}px`;
  dropline.querySelector('.lab').textContent = timeLabel;
  const n = dropline.querySelector('.note');
  n.textContent = note || '';
  n.classList.toggle('hidden', !note);
}

function hideDrop() {
  if (dropline && dropline.parentElement) dropline.remove();
}

function onPointerMove(ev) {
  if (!drag) return;
  if (!drag.moved && Math.abs(ev.clientX - drag.startX) < 3 && Math.abs(ev.clientY - drag.startY) < 3) return;
  drag.moved = true;

  const target = pointerTarget(ev);
  for (const t of els.days.querySelectorAll('.track')) t.classList.remove('drop');

  // Off every track: nothing would be written, so show nothing rather than a
  // stale marker suggesting otherwise.
  if (!target) {
    hideDrop();
    if (drag.ghost) drag.ghost.remove();
    drag.pending = null;
    els.hint('Drop on a day to set the time');
    return;
  }
  target.track.classList.add('drop');

  const targetMs = target.ms;
  const stamp = msToDt(targetMs);

  if (drag.fromTray) {
    drag.pending = targetMs;
    // The tray chip stays put, so carry a translucent copy to the drop point —
    // otherwise a tray drag gives no sign of what is being placed, or where.
    if (!drag.ghost) {
      drag.ghost = chipEl(drag.p);
      drag.ghost.classList.add('ghost');
    }
    if (drag.ghost.parentElement !== target.track) target.track.appendChild(drag.ghost);
    drag.ghost.style.left = `${target.x}px`;
    drag.ghost.style.top = '9px';
    showDrop(target, stamp.slice(11, 19), fmtDayLabel(target.day));
    els.hint(`Set to ${stamp.replace('T', ' ')}`);
    return;
  }

  const deltaMs = targetMs - dtToMs(drag.origin.get(drag.p.id));
  drag.pending = deltaMs;
  showDrop(
    target,
    stamp.slice(11, 19),
    drag.group.length > 1
      ? `${fmtDur(deltaMs / 1000)} · ${drag.group.length} photos`
      : fmtDur(deltaMs / 1000)
  );

  // Live preview: move every chip in the group by the same delta.
  for (const q of drag.group) {
    const o = drag.origin.get(q.id);
    if (!o) continue;
    const stamp = msToDt(dtToMs(o) + deltaMs);
    const el = chips.get(q.id);
    const track = els.days.querySelector(`.track[data-day="${dayOf(stamp)}"]`);
    if (!el) continue;
    if (track) {
      if (el.parentElement !== track) track.appendChild(el);
      el.style.left =
        `${(secOfDay(stamp) / DAY_SEC) * track.getBoundingClientRect().width}px`;
      el.style.opacity = '';
      const t = el.querySelector('.chipTime');
      if (t) t.textContent = stamp.slice(11, 16);
    } else {
      // Lands on a day that has no track yet — it will appear after the drop.
      el.style.opacity = '.35';
    }
  }

  const n = drag.group.length;
  els.hint(
    n > 1
      ? `${fmtDur(deltaMs / 1000)} · shifting ${n} photos together (hold Alt to move one)`
      : `${fmtDur(deltaMs / 1000)} · ${msToDt(dtToMs(drag.origin.get(drag.p.id)) + deltaMs).replace('T', ' ')}`
  );
}

function onPointerUp() {
  window.removeEventListener('pointermove', onPointerMove);
  const d = drag;
  drag = null;
  if (!d) return;
  d.el.classList.remove('drag');
  for (const t of els.days.querySelectorAll('.track')) t.classList.remove('drop');
  hideDrop();
  if (d.ghost) d.ghost.remove();
  els.hint('');

  if (!d.moved || d.pending == null) { render(); return; }

  commit();
  if (d.fromTray) {
    d.p.datetime = msToDt(d.pending);
  } else {
    for (const q of d.group) {
      const o = d.origin.get(q.id);
      if (o) q.datetime = msToDt(dtToMs(o) + d.pending);
    }
  }
  emit();
}

/** Shift every selected photo that has a date by `sec` seconds. */
export function shiftSelection(sec) {
  const sel = selected().filter((p) => p.datetime);
  if (!sel.length) return 0;
  commit();
  for (const p of sel) p.datetime = msToDt(dtToMs(p.datetime) + sec * 1000);
  emit();
  return sel.length;
}
