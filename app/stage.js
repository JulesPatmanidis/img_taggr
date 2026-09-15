/* Split stage — map above, timeline below, so a photo's place and time are on
 * screen together. Either pane can take the whole stage for a while, and the
 * divider between them drags.
 */

import * as MapView from './map.js';
import * as TL from './timeline.js';
import { stored, store, dragHandle } from './dom.js';

const $ = (id) => document.getElementById(id);

/** Every pane, with the name its buttons use and the key that enlarges it. */
const PANES = {
  map: { name: 'map', key: 'm' },
  time: { name: 'timeline', key: 't' },
};

let maxed = null; // null | a PANES key
export const mapShown = () => maxed !== 'time';
export const timeShown = () => maxed !== 'map';

/** The pane a shortcut key enlarges, if any. */
export const paneForKey = (key) => Object.keys(PANES).find((pane) => PANES[pane].key === key);

export function resizeViews() {
  if (mapShown()) MapView.invalidate();
  if (timeShown()) TL.render();
}

export function toggleMax(pane) {
  maxed = maxed === pane ? null : pane;
  $('stage').dataset.max = maxed ?? '';
  for (const b of document.querySelectorAll('.maxBtn')) {
    const on = b.dataset.pane === maxed;
    const { name, key } = PANES[b.dataset.pane];
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', `${on ? 'Restore' : 'Enlarge'} ${name}`);
    b.title = `${on ? 'Restore' : 'Enlarge'} ${name} — ${key.toUpperCase()}`;
  }
  // A hidden pane skips renders, so catch the one coming back up.
  if (mapShown()) MapView.render();
  resizeViews();
}

/** Bring back whichever pane is about to be used. A maximised pane hides the
 *  other one, which is exactly what was asked for. */
export function show({ map = false, time = false }) {
  if (map && maxed === 'time') toggleMax('time');
  if (time && maxed === 'map') toggleMax('map');
}

const MIN_SPLIT = 0.18;
function setSplit(frac) {
  const f = Math.max(MIN_SPLIT, Math.min(1 - MIN_SPLIT, frac));
  document.documentElement.style.setProperty('--split', `${(f * 100).toFixed(2)}%`);
  return f;
}

export function initStage() {
  for (const b of document.querySelectorAll('.maxBtn')) {
    b.addEventListener('click', () => toggleMax(b.dataset.pane));
  }

  const saved = Number(stored('split'));
  if (saved > 0 && saved < 1) setSplit(saved);

  let frac = 0;
  dragHandle($('splitResize'), {
    move: (e) => {
      const box = $('stage').getBoundingClientRect();
      frac = setSplit((e.clientY - box.top) / box.height);
    },
    frame: resizeViews,
    end: () => { if (frac) store('split', frac); },
  });
}
