/* Seeing photos bigger.
 *
 *   hover a chip, pin or filmstrip thumbnail   a larger preview after a moment
 *   Space                                      full-size lightbox; ← → step
 *                                              through in time order, Esc closes
 *
 * Both are read-only.
 */

import { state } from './state.js';

const HOVER_DELAY_MS = 380;

const byId = (id) => state.photos.find((p) => p.id === id);

function caption(p) {
  const when = p.datetime ? `${p.datetime.replace('T', ' ')}${p.offset ? ` (${p.offset})` : ''}` : 'No date';
  const where = p.lat != null ? `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` : 'No location';
  return { name: p.name, detail: `${when} · ${where}` };
}

/* ── Hover preview ─────────────────────────────────────────────── */

let peek = null;
let timer = 0;
let hovered = null;

function peekEl() {
  if (peek) return peek;
  peek = document.createElement('div');
  peek.className = 'peek hidden';
  peek.setAttribute('aria-hidden', 'true');
  peek.innerHTML = '<div class="peekImg"></div><div class="peekCap"><b></b><span></span></div>';
  document.body.appendChild(peek);
  return peek;
}

function hidePeek() {
  clearTimeout(timer);
  hovered = null;
  peek?.classList.add('hidden');
}

function showPeek(el, id, x, y) {
  const p = byId(id);
  if (!p || document.body.classList.contains('dragging')) return;
  const box = peekEl();
  const img = box.querySelector('.peekImg');
  img.style.backgroundImage = p.thumb ? `url('${p.thumb}')` : '';
  img.dataset.ext = p.thumb ? '' : (p.ext || '?').toUpperCase();
  const c = caption(p);
  box.querySelector('b').textContent = c.name;
  box.querySelector('span').textContent = c.detail;
  box.classList.remove('hidden');

  // Beside the pointer, flipped to whichever side has room.
  const w = box.offsetWidth;
  const h = box.offsetHeight;
  const left = x + 18 + w < innerWidth - 8 ? x + 18 : x - 18 - w;
  const top = Math.max(8, Math.min(innerHeight - h - 8, y - h / 2));
  box.style.transform = `translate(${Math.max(8, left)}px, ${top}px)`;
}

/**
 * Preview whatever matches `selector` inside `root` when the pointer rests on
 * it. `idOf(el)` returns the photo id, or null to skip the element.
 */
export function hoverPreview(root, selector, idOf) {
  root.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse' || e.buttons) return;
    const el = e.target.closest(selector);
    if (!el || el === hovered) return;
    const id = idOf(el);
    if (!id) return;
    hidePeek();
    hovered = el;
    const { clientX, clientY } = e;
    timer = setTimeout(() => showPeek(el, id, clientX, clientY), HOVER_DELAY_MS);
  });
  root.addEventListener('pointerout', (e) => {
    if (!hovered) return;
    // Moving between an element's own children is not leaving it.
    if (e.relatedTarget && hovered.contains(e.relatedTarget)) return;
    hidePeek();
  });
}

// Anything that changes what is under the pointer ends the preview.
for (const type of ['pointerdown', 'wheel', 'keydown']) {
  window.addEventListener(type, hidePeek, { capture: true, passive: true });
}

/* ── Lightbox ──────────────────────────────────────────────────── */

let box = null;
let order = [];
let index = 0;
let loadPreview = async () => null;
let returnFocus = null;

export function initLightbox(opts) {
  loadPreview = opts.loadPreview;
}

export const lightboxOpen = () => !!box && !box.classList.contains('hidden');

function lightboxEl() {
  if (box) return box;
  box = document.createElement('div');
  box.className = 'lightbox hidden';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', 'Photo preview');
  box.tabIndex = -1;
  box.innerHTML =
    '<button type="button" class="lbClose" aria-label="Close preview">×</button>' +
    '<button type="button" class="lbNav prev" aria-label="Previous photo">‹</button>' +
    '<figure class="lbFig"><div class="lbStage"><img alt="" /><div class="lbMsg hidden"></div></div>' +
    '<figcaption><b></b><span></span><em></em></figcaption></figure>' +
    '<button type="button" class="lbNav next" aria-label="Next photo">›</button>';
  document.body.appendChild(box);

  box.querySelector('.lbClose').addEventListener('click', closeLightbox);
  box.querySelector('.prev').addEventListener('click', () => step(-1));
  box.querySelector('.next').addEventListener('click', () => step(1));
  // A click on the dark backdrop closes; a click on the photo does not.
  box.addEventListener('click', (e) => { if (e.target === box) closeLightbox(); });
  box.addEventListener('keydown', (e) => {
    // The app's shortcuts are disabled while the lightbox is open.
    e.stopPropagation();
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (e.key === 'Escape' || e.key === ' ') { e.preventDefault(); closeLightbox(); }
    else if (e.key === 'Tab') {
      // Keep focus inside the dialog.
      const stops = [...box.querySelectorAll('button')];
      const i = stops.indexOf(document.activeElement);
      e.preventDefault();
      stops[(i + (e.shiftKey ? -1 : 1) + stops.length) % stops.length].focus();
    }
  });
  return box;
}

/** Open on `startId`, stepping through `ids` (already in display order). */
export function openLightbox(ids, startId) {
  if (!ids.length) return;
  order = ids;
  index = Math.max(0, ids.indexOf(startId));
  returnFocus = document.activeElement;
  const el = lightboxEl();
  el.classList.remove('hidden');
  el.focus();
  show();
}

export function closeLightbox() {
  if (!lightboxOpen()) return;
  box.classList.add('hidden');
  box.querySelector('img').removeAttribute('src');
  if (returnFocus instanceof HTMLElement) returnFocus.focus();
}

function step(dir) {
  if (order.length < 2) return;
  index = (index + dir + order.length) % order.length;
  show();
}

let showing = 0;

async function show() {
  const p = byId(order[index]);
  if (!p) return;
  const ticket = ++showing;
  const img = box.querySelector('img');
  const msg = box.querySelector('.lbMsg');
  const c = caption(p);
  box.querySelector('figcaption b').textContent = c.name;
  box.querySelector('figcaption span').textContent = c.detail;
  box.querySelector('figcaption em').textContent = `${index + 1} / ${order.length}`;
  box.querySelector('.prev').disabled = order.length < 2;
  box.querySelector('.next').disabled = order.length < 2;

  // Show the thumbnail until the full image has loaded.
  msg.classList.add('hidden');
  if (p.thumb) img.src = p.thumb; else img.removeAttribute('src');
  img.classList.add('loading');

  let url = null;
  try { url = await loadPreview(p); } catch { /* fall through to the message */ }
  if (ticket !== showing) return;

  const fail = () => {
    img.classList.remove('loading');
    if (p.thumb) return; // the thumbnail is the best there is
    img.removeAttribute('src');
    msg.textContent = `This browser can't display ${(p.ext || 'this format').toUpperCase()} files.`;
    msg.classList.remove('hidden');
  };
  if (!url) { fail(); return; }
  const full = new Image();
  full.onload = () => {
    if (ticket !== showing) return;
    img.src = url;
    img.classList.remove('loading');
  };
  full.onerror = () => { if (ticket === showing) fail(); };
  full.src = url;
}
