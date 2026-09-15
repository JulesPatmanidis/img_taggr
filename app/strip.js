/* Filmstrip — the one place photos come from.
 *
 * Sorted by capture time with undated photos first, so the top of the list is
 * what still needs doing. Filters narrow it to what is missing a date or a
 * location. Cards drag straight onto the map or the timeline; the views are
 * only places to drop them.
 *
 * It is also the keyboard's way to photos: one card at a time takes Tab focus,
 * ↑ ↓ Home End move and select (Shift extends, Ctrl only moves), and Enter or
 * Ctrl+Space selects or toggles the focused card.
 */

import {
  state, emit, isEdited, clickSelect, commit, normDt, photoCount,
} from './state.js';
import { stored, store, dragHandle } from './dom.js';

const $ = (id) => document.getElementById(id);

const ICON_TIME =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6"/><path d="M6 3.4V6l1.8 1.1"/><path class="x" d="M1.2 10.8 10.8 1.2"/></svg>';
const ICON_PLACE =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 11s3.6-3.4 3.6-6.1a3.6 3.6 0 0 0-7.2 0C2.4 7.6 6 11 6 11z"/><circle cx="6" cy="4.9" r="1.1" fill="currentColor"/><path class="x" d="M1.2 10.8 10.8 1.2"/></svg>';

const FILTERS = {
  all: () => true,
  undated: (p) => !p.datetime,
  unplaced: (p) => p.lat == null,
};
let filter = 'all';
let lastClicked = null;
/** The card that takes Tab focus, so returning to the list lands where you were. */
let cursor = null;
let opts = {};

const visible = () => state.photos.filter(FILTERS[filter]);

export function initStrip(options) {
  opts = options;
  $('stripList').addEventListener('click', onClick);
  $('stripList').addEventListener('dblclick', (ev) => {
    const card = ev.target.closest('.card');
    if (card) opts.onReveal([card.dataset.id]);
  });
  $('stripList').addEventListener('pointerdown', onPointerDown);
  $('stripList').addEventListener('keydown', onKey);
  $('btnSelectAll').addEventListener('click', selectAll);
  $('stripFilters').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-filter]');
    if (b) setFilter(b.dataset.filter);
  });
  $('btnSeedDates').addEventListener('click', seedDates);
  initResize();
}

/** Build a card for every photo. Called once per folder; sync() does the rest. */
export function build() {
  const frag = document.createDocumentFragment();
  for (const p of state.photos) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = p.id;
    card.setAttribute('role', 'option');
    card.tabIndex = -1;
    card.innerHTML =
      '<div class="th"></div><div class="meta">' +
      '<div class="nm"></div><div class="sub"></div>' +
      `<div class="flags"><i class="flag">${ICON_TIME}</i><i class="flag">${ICON_PLACE}</i></div>` +
      '</div>';
    card.querySelector('.nm').textContent = p.name;
    card.querySelector('.th').dataset.ext = p.ext || '?';
    p._el = card;
    frag.appendChild(card);
  }
  $('stripList').replaceChildren(frag);
  lastClicked = null;
  cursor = null;
  if (!state.photos.some(FILTERS[filter])) setFilter('all');
}

export function sync() {
  const list = $('stripList');
  const show = FILTERS[filter];
  const shownIds = visible().map((p) => p.id);
  const tabStop = shownIds.includes(cursor) ? cursor
    : shownIds.find((id) => state.selection.has(id)) ?? shownIds[0];
  let i = 0;
  for (const p of state.photos) {
    const el = p._el;
    if (!el) continue;
    // Keep the DOM in capture order without rebuilding: move only what moved.
    if (list.children[i] !== el) list.insertBefore(el, list.children[i] ?? null);
    i++;
    el.classList.toggle('hidden', !show(p));
    el.classList.toggle('sel', state.selection.has(p.id));
    el.setAttribute('aria-selected', String(state.selection.has(p.id)));
    el.tabIndex = p.id === tabStop ? 0 : -1;
    el.classList.toggle('edited', isEdited(p));
    if (p.thumb && el._thumb !== p.thumb) {
      el.querySelector('.th').style.backgroundImage = `url('${p.thumb}')`;
      el._thumb = p.thumb;
    }
    el.querySelector('.sub').textContent = p.datetime
      ? p.datetime.slice(0, 16).replace('T', ' ')
      : 'No date';
    const [time, place] = el.querySelectorAll('.flag');
    time.classList.toggle('off', !p.datetime);
    time.title = p.datetime ? 'Has a date' : 'No date yet';
    place.classList.toggle('off', p.lat == null);
    place.title = p.lat != null ? 'Has a location' : 'No location yet';
  }

  const n = state.photos.length;
  const undated = state.photos.filter(FILTERS.undated).length;
  const counts = { all: n, undated, unplaced: state.photos.filter(FILTERS.unplaced).length };
  for (const b of $('stripFilters').querySelectorAll('[data-filter]')) {
    b.querySelector('b').textContent = counts[b.dataset.filter];
    b.disabled = !n;
  }
  const shown = shownIds.length;
  $('stripCount').textContent = !n ? 'No photos'
    : state.selection.size ? `${state.selection.size} selected`
      : filter === 'all' ? photoCount(n) : `${shown} of ${n}`;
  $('btnSelectAll').disabled = !shown;
  $('seedRow').classList.toggle('hidden',
    !state.photos.some((p) => !p.datetime && p.file_modified));
  $('stripEmpty').classList.toggle('hidden', !n || shown > 0);
}

function setFilter(f) {
  filter = f;
  for (const b of $('stripFilters').querySelectorAll('[data-filter]')) {
    const on = b.dataset.filter === f;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
  lastClicked = null;
  sync();
}

/* ── Selection ─────────────────────────────────────────────────── */

/** Set right after a drag so the click that ends it does not reselect. */
let swallowClick = false;

function select(id, { toggle = false, extend = false } = {}) {
  cursor = id;
  clickSelect(id, { toggle, extend, anchor: lastClicked, order: visible().map((p) => p.id) });
  if (!extend) lastClicked = id;
}

function onClick(ev) {
  if (swallowClick) { swallowClick = false; return; }
  const card = ev.target.closest('.card');
  if (card) select(card.dataset.id, { toggle: ev.ctrlKey || ev.metaKey, extend: ev.shiftKey });
}

function onKey(ev) {
  const card = ev.target.closest('.card');
  if (!card) return;
  const mod = ev.ctrlKey || ev.metaKey;
  const order = visible().map((p) => p.id);
  const at = order.indexOf(card.dataset.id);
  const to = { ArrowUp: at - 1, ArrowDown: at + 1, PageUp: at - 10, PageDown: at + 10,
    Home: 0, End: order.length - 1 }[ev.key];
  if (to !== undefined) {
    ev.preventDefault();
    const id = order[Math.max(0, Math.min(order.length - 1, to))];
    if (mod) cursor = id; else select(id, { extend: ev.shiftKey });
    sync();
    state.photos.find((p) => p.id === id)?._el?.focus();
  } else if (ev.key === 'Enter' || (ev.key === ' ' && mod)) {
    // Plain Space stays the preview shortcut, as everywhere else.
    ev.preventDefault();
    select(card.dataset.id, { toggle: mod, extend: ev.shiftKey });
  }
}

/** Select everything the current filter shows, or clear if that is already it. */
export function selectAll() {
  const ids = visible().map((p) => p.id);
  const all = ids.length && ids.every((id) => state.selection.has(id))
    && state.selection.size === ids.length;
  state.selection.clear();
  if (!all) for (const id of ids) state.selection.add(id);
  emit();
}

function seedDates() {
  // Dragging dozens of undated photos one by one is not a workflow. File mtime
  // is a rough but honest starting point that can then be shifted as a group;
  // it is offered explicitly rather than applied behind the user's back.
  const undated = state.photos.filter((p) => !p.datetime && p.file_modified);
  if (!undated.length) return;
  commit();
  for (const p of undated) p.datetime = normDt(p.file_modified);
  emit();
  opts.toast(`Dated ${photoCount(undated.length)} from file timestamps — now drag to correct them`);
}

/* ── Dragging cards out ────────────────────────────────────────── */

let press = null;
let drag = null;

function onPointerDown(ev) {
  const card = ev.target.closest('.card');
  if (!card || ev.button !== 0 || ev.shiftKey || ev.ctrlKey || ev.metaKey) return;
  press = { id: card.dataset.id, x: ev.clientX, y: ev.clientY };
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp, { once: true });
}

function onPointerMove(ev) {
  if (!press) return;
  if (!drag) {
    if (Math.hypot(ev.clientX - press.x, ev.clientY - press.y) < 6) return;
    // Dragging a card outside the selection takes just that card, as in any
    // file manager.
    if (!state.selection.has(press.id)) {
      clickSelect(press.id);
      lastClicked = press.id;
    }
    const ids = state.photos.filter((p) => state.selection.has(p.id)).map((p) => p.id);
    drag = { ids, grabbed: press.id, ghost: ghostFor(ids, press.id), target: null };
    document.body.classList.add('dragging');
  }
  drag.ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`;
  drag.target = opts.dropTargets.find((t) => t.hover(ev.clientX, ev.clientY, drag.ids, drag.grabbed)) ?? null;
  for (const t of opts.dropTargets) if (t !== drag.target) t.leave();
  drag.ghost.classList.toggle('ok', !!drag.target);
}

function onPointerUp(ev) {
  window.removeEventListener('pointermove', onPointerMove);
  press = null;
  if (!drag) return;
  const d = drag;
  drag = null;
  d.ghost.remove();
  document.body.classList.remove('dragging');
  for (const t of opts.dropTargets) if (t !== d.target) t.leave();
  if (d.target) d.target.drop(ev.clientX, ev.clientY, d.ids, d.grabbed);
  // The pointerup may complete a click on the card we started from.
  swallowClick = true;
  setTimeout(() => { swallowClick = false; }, 0);
}

function ghostFor(ids, grabbed) {
  const p = state.photos.find((q) => q.id === grabbed);
  const el = document.createElement('div');
  el.className = 'dragGhost';
  if (p?.thumb) el.style.backgroundImage = `url('${p.thumb}')`;
  if (ids.length > 1) el.dataset.count = ids.length;
  document.body.appendChild(el);
  return el;
}

/* ── Sizing ────────────────────────────────────────────────────── */
/* One drag handle instead of a size menu: "too small" depends on the screen,
   and the thumbnails scale with the panel so widening it actually shows more. */
const MIN_STRIP = 180;
const MAX_STRIP = 460;

function setStripWidth(px) {
  const w = Math.round(Math.max(MIN_STRIP, Math.min(MAX_STRIP, px)));
  const root = document.documentElement;
  root.style.setProperty('--strip', `${w}px`);
  root.style.setProperty('--thumb', `${Math.round(Math.max(56, Math.min(132, w * 0.31)))}px`);
  return w;
}

function initResize() {
  const saved = Number(stored('stripWidth'));
  if (Number.isFinite(saved) && saved > 0) setStripWidth(saved);

  let width = 0;
  dragHandle($('stripResize'), {
    move: (e) => { width = setStripWidth(e.clientX); },
    // Both views size themselves from the pane, so keep them in step.
    frame: () => opts.onResize(),
    end: () => { if (width) store('stripWidth', width); },
  });
}
