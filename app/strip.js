/* Filmstrip: the one place photos come from.
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
  state, emit, isEdited, clickSelect, photoCount,
  isUndated, isUnplaced, isTagged, setSortMode, sortModeName,
} from './state.js';
import { stored, store, dragHandle, keyedList } from './dom.js';

const $ = (id) => document.getElementById(id);

const ICON_CHECK =
  '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="m3 7.2 2.8 2.8L11 4.5"/></svg>';

const FILTERS = {
  all: () => true,
  ready: isTagged,
  undated: isUndated,
  unplaced: isUnplaced,
};
let filter = 'all';
/** Typed into the filename box; narrows the list on top of the filter. */
let query = '';
let lastClicked = null;
/** The card that takes Tab focus, so returning to the list lands where you were. */
let cursor = null;
let opts = {};
/** photo id -> card element. The cards live here, not on the photo records. */
let cards = null;

/** What the filter and the search box agree to show, in list order. */
const matches = (p) =>
  FILTERS[filter](p) && (!query || p.name.toLowerCase().includes(query));
const visible = () => state.photos.filter(matches);

/** The one line under a filename: what this photo is still missing. */
function statusOf(p) {
  if (isTagged(p)) return { word: 'Ready', ok: true };
  if (isUndated(p) && isUnplaced(p)) return { word: 'No date · no location', ok: false };
  return { word: isUnplaced(p) ? 'Needs location' : 'No date', ok: false };
}

export function initStrip(options) {
  opts = options;
  cards = keyedList($('stripList'), { create: cardEl, update: paintCard });
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
  initSearch();
  initSort();
  initResize();
}

/**
 * Settle the list after photos arrive or the session is emptied. The cards
 * themselves are built by sync(); `reset` throws the existing ones away, which
 * only an emptied session needs, since adding photos leaves the cards that are
 * already up exactly as they are.
 */
export function build({ reset = false } = {}) {
  if (reset) cards.clear();
  lastClicked = null;
  cursor = null;
  if (!state.photos.some(FILTERS[filter])) setFilter('all');
}

function cardEl(p) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = p.id;
  card.setAttribute('role', 'option');
  card.tabIndex = -1;
  card.innerHTML =
    `<span class="check">${ICON_CHECK}</span>` +
    '<div class="th"><span class="idx"></span></div>' +
    '<div class="meta"><div class="nm"></div>' +
    '<div class="status"><i class="dot"></i><span class="word"></span></div></div>';
  card.querySelector('.nm').textContent = p.name;
  card.querySelector('.idx').textContent = `#${String(p.seq ?? 0).padStart(3, '0')}`;
  card.querySelector('.th').dataset.ext = p.ext || '?';
  return card;
}

function paintCard(el, p, { show, tabStop }) {
  el.classList.toggle('hidden', !show(p));
  el.classList.toggle('sel', state.selection.has(p.id));
  el.setAttribute('aria-selected', String(state.selection.has(p.id)));
  el.tabIndex = p.id === tabStop ? 0 : -1;
  el.classList.toggle('edited', isEdited(p));
  if (p.thumb && el._thumb !== p.thumb) {
    el.querySelector('.th').style.backgroundImage = `url('${p.thumb}')`;
    el._thumb = p.thumb;
  }
  const st = statusOf(p);
  el.querySelector('.word').textContent = st.word;
  el.querySelector('.dot').classList.toggle('ok', st.ok);
  el.title = p.datetime ? `${p.name} · ${p.datetime.slice(0, 16).replace('T', ' ')}` : p.name;
}

export function sync() {
  const shownIds = visible().map((p) => p.id);
  const tabStop = shownIds.includes(cursor) ? cursor
    : shownIds.find((id) => state.selection.has(id)) ?? shownIds[0];
  // Every photo keeps a card; the filter only hides them, so the list stays in
  // capture order and a filter change costs no DOM.
  cards.sync(state.photos, { show: matches, tabStop });

  const n = state.photos.length;
  const undated = state.photos.filter(FILTERS.undated).length;
  // Chip counts ignore the search box: they describe the folder, not the query.
  const counts = Object.fromEntries(
    Object.entries(FILTERS).map(([k, f]) => [k, state.photos.filter(f).length]));
  for (const b of $('stripFilters').querySelectorAll('[data-filter]')) {
    b.querySelector('b').textContent = counts[b.dataset.filter];
    b.disabled = !n;
  }
  const shown = shownIds.length;
  $('stripCount').textContent = !n ? 'No photos'
    : state.selection.size ? `${state.selection.size} selected`
      : filter === 'all' && !query ? photoCount(n) : `${shown} of ${n}`;
  $('btnSelectAll').disabled = !shown;
  $('stripSearch').disabled = !n;
  $('stripEmpty').classList.toggle('hidden', !n || shown > 0);
  $('stripEmpty').textContent = query
    ? `No filename matches “${query}”.` : 'Nothing left here.';
}

/* ── Narrowing the list ────────────────────────────────────────── */

function initSearch() {
  $('stripSearch').addEventListener('input', (ev) => {
    query = ev.target.value.trim().toLowerCase();
    lastClicked = null;
    sync();
  });
  // Escape clears the box rather than leaving a filter nobody can see.
  $('stripSearch').addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key !== 'Escape' || !ev.target.value) return;
    ev.target.value = '';
    query = '';
    sync();
  });
}

/* Two orders are worth having: the capture order the app works in, and the
   filename order a scanned roll was shot in. */
function initSort() {
  const menu = $('sortMenu');
  const items = () => [...menu.querySelectorAll('[data-sort]')];
  const open = (on, { focus = true } = {}) => {
    menu.classList.toggle('hidden', !on);
    $('btnSort').setAttribute('aria-expanded', String(on));
    if (!focus) return;
    if (on) items()[0].focus(); else $('btnSort').focus();
  };
  $('btnSort').addEventListener('click', () => open(menu.classList.contains('hidden')));
  $('btnSort').addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    ev.preventDefault();
    open(true);
  });
  menu.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-sort]');
    if (!b) return;
    setSort(b.dataset.sort);
    open(false);
  });
  // A menu you can open with the keyboard has to be navigable and escapable
  // with it too, or the focus lands somewhere it cannot leave.
  menu.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    const list = items();
    const at = list.indexOf(document.activeElement);
    if (ev.key === 'Escape') { ev.preventDefault(); open(false); return; }
    if (ev.key === 'Tab') { open(false, { focus: false }); return; }
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: list.length - 1 }[ev.key];
    if (to === undefined) return;
    ev.preventDefault();
    list[(to + list.length) % list.length].focus();
  });
  document.addEventListener('pointerdown', (ev) => {
    if (!ev.target.closest('.menuWrap')) open(false, { focus: false });
  });
  // Boot: the other views are not up yet, so restore the order without a render.
  setSort(stored('sort'), { quiet: true });
}

function setSort(mode, { quiet = false } = {}) {
  setSortMode(mode);
  store('sort', sortModeName());
  for (const b of $('sortMenu').querySelectorAll('[data-sort]')) {
    b.setAttribute('aria-checked', String(b.dataset.sort === sortModeName()));
  }
  lastClicked = null;
  if (!quiet) emit('photos');
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
    cards.get(id)?.focus();
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
  emit('selection');
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
   and the thumbnails scale with the panel, so widening it shows more. */
const MIN_STRIP = 180;
const MAX_STRIP = 460;

function setStripWidth(px) {
  const w = Math.round(Math.max(MIN_STRIP, Math.min(MAX_STRIP, px)));
  const root = document.documentElement;
  root.style.setProperty('--strip', `${w}px`);
  root.style.setProperty('--thumb', `${Math.round(Math.max(36, Math.min(76, w * 0.147)))}px`);
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
