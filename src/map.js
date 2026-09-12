/* Map view — place and move photos geographically.
 *
 * Interactions:
 *   click empty map      place every selected photo at that point
 *   drag a marker        move it; if it belongs to a multi-photo selection the
 *                        whole selection moves rigidly, preserving its shape
 *   Interpolate route    fill in un-placed photos along the line between placed
 *                        ones, positioned by their timestamp
 */

import { state, selected, isEdited, commit, emit, dtToMs, roundCoord } from './state.js';

let map = null;
/** photo id -> L.Marker */
const markers = new Map();
let route = null;
let showRoute = true;

export function initMap(el) {
  map = L.map(el, { zoomControl: false, attributionControl: true, worldCopyJump: true })
    .setView([30, 10], 2);
  L.control.zoom({ position: 'topright' }).addTo(map);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);

  map.on('click', (e) => {
    const sel = selected();
    if (!sel.length) return;
    commit();
    for (const p of sel) {
      p.lat = roundCoord(e.latlng.lat);
      p.lon = roundCoord(((e.latlng.lng + 180) % 360 + 360) % 360 - 180);
    }
    emit('change');
  });

  return map;
}

export function setShowRoute(v) { showRoute = v; render(); }
export function invalidate() { if (map) map.invalidateSize(); }

function icon(p) {
  const cls = ['pin', state.selection.has(p.id) ? 'sel' : '', isEdited(p) ? 'edited' : '']
    .filter(Boolean).join(' ');
  const img = p.thumb ? `background-image:url('${p.thumb}')` : '';
  return L.divIcon({
    className: '',
    html: `<div class="${cls}" style="${img}"></div>`,
    iconSize: [38, 47],
    iconAnchor: [19, 47],
  });
}

/** Rigid-body drag state, captured on dragstart. */
let drag = null;
/** Id of the marker being dragged. Set before any render can run, so render()
 *  knows to leave that marker's icon and position alone — swapping the icon of
 *  a marker mid-drag detaches the very element Leaflet is dragging. */
let dragId = null;

function makeMarker(p) {
  const m = L.marker([p.lat, p.lon], { icon: icon(p), draggable: true, riseOnHover: true });

  m.on('dragstart', () => {
    dragId = p.id;
    // Dragging a marker outside the current selection re-selects just that photo,
    // matching how every file manager behaves.
    if (!state.selection.has(p.id)) {
      state.selection.clear();
      state.selection.add(p.id);
      emit('change');
    }
    commit();
    const group = selected().filter((q) => q.lat != null && q.id !== p.id);
    drag = { origin: { lat: p.lat, lon: p.lon }, group: group.map((q) => ({ q, lat: q.lat, lon: q.lon })) };
  });

  m.on('drag', (e) => {
    if (!drag) return;
    const dLat = e.latlng.lat - drag.origin.lat;
    const dLon = e.latlng.lng - drag.origin.lon;
    for (const g of drag.group) {
      const mk = markers.get(g.q.id);
      if (mk) mk.setLatLng([g.lat + dLat, g.lon + dLon]);
    }
    if (showRoute) drawRoute(true);
  });

  m.on('dragend', (e) => {
    if (!drag) return;
    const dLat = e.target.getLatLng().lat - drag.origin.lat;
    const dLon = e.target.getLatLng().lng - drag.origin.lon;
    p.lat = roundCoord(drag.origin.lat + dLat);
    p.lon = roundCoord(drag.origin.lon + dLon);
    for (const g of drag.group) {
      g.q.lat = roundCoord(g.lat + dLat);
      g.q.lon = roundCoord(g.lon + dLon);
    }
    drag = null;
    dragId = null;
    emit('change');
  });

  m.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    const mod = e.originalEvent.ctrlKey || e.originalEvent.metaKey;
    if (mod) {
      state.selection.has(p.id) ? state.selection.delete(p.id) : state.selection.add(p.id);
    } else {
      state.selection.clear();
      state.selection.add(p.id);
    }
    emit('change');
  });

  return m;
}

function drawRoute(live) {
  if (route) { route.remove(); route = null; }
  if (!showRoute) return;
  const pts = state.photos
    .filter((p) => p.lat != null && p.datetime)
    .sort((a, b) => dtToMs(a.datetime) - dtToMs(b.datetime))
    .map((p) => (live && markers.get(p.id) ? markers.get(p.id).getLatLng() : L.latLng(p.lat, p.lon)));
  if (pts.length < 2) return;
  route = L.polyline(pts, { color: '#7aa2f7', weight: 1.5, opacity: 0.5, dashArray: '4 4' }).addTo(map);
  route.bringToBack();
}

export function render() {
  if (!map) return;
  const live = new Set();

  for (const p of state.photos) {
    if (p.lat == null || p.lon == null) continue;
    live.add(p.id);
    let m = markers.get(p.id);
    if (!m) {
      m = makeMarker(p);
      m.addTo(map);
      markers.set(p.id, m);
    } else if (!drag) {
      const cur = m.getLatLng();
      if (cur.lat !== p.lat || cur.lng !== p.lon) m.setLatLng([p.lat, p.lon]);
    }
    if (p.id !== dragId) m.setIcon(icon(p));
  }

  for (const [id, m] of markers) {
    if (!live.has(id)) { m.remove(); markers.delete(id); }
  }
  drawRoute(false);
}

/** Zoom to everything placed, or to the selection if it has coordinates. */
export function fit(onlySelection = false) {
  if (!map) return;
  const src = onlySelection ? selected() : state.photos;
  const pts = src.filter((p) => p.lat != null).map((p) => [p.lat, p.lon]);
  if (!pts.length) return;
  if (pts.length === 1) map.setView(pts[0], Math.max(map.getZoom(), 14));
  else map.fitBounds(L.latLngBounds(pts).pad(0.18));
}

/**
 * Fill in positions for photos that sit, in time, between two placed photos.
 * Returns a short report for the toast.
 */
export function interpolate() {
  const scope = state.selection.size >= 2 ? selected() : state.photos;
  const timed = scope
    .filter((p) => p.datetime)
    .sort((a, b) => dtToMs(a.datetime) - dtToMs(b.datetime));

  const anchorIdx = timed.map((p, i) => (p.lat != null ? i : -1)).filter((i) => i >= 0);
  if (anchorIdx.length < 2) {
    // Say *which* set came up short, or the message is baffling when the folder
    // is well placed but the selection happens not to be.
    return { ok: false, msg: state.selection.size >= 2
      ? 'Fewer than two of the selected photos have a location. Clear the selection to interpolate across the whole folder.'
      : 'Place at least two photos on the map first — interpolation needs a route to follow.' };
  }

  let filled = 0;
  let committed = false;
  for (let k = 0; k < anchorIdx.length - 1; k++) {
    const a = timed[anchorIdx[k]];
    const b = timed[anchorIdx[k + 1]];
    const ta = dtToMs(a.datetime);
    const tb = dtToMs(b.datetime);
    for (let i = anchorIdx[k] + 1; i < anchorIdx[k + 1]; i++) {
      const p = timed[i];
      if (p.lat != null) continue;
      if (!committed) { commit(); committed = true; }
      // Equal timestamps would divide by zero; fall back to the first anchor.
      const f = tb === ta ? 0 : (dtToMs(p.datetime) - ta) / (tb - ta);
      p.lat = roundCoord(a.lat + (b.lat - a.lat) * f);
      p.lon = roundCoord(a.lon + (b.lon - a.lon) * f);
      filled++;
    }
  }

  const outside = timed.filter((p) => p.lat == null).length;
  if (!filled) {
    return { ok: false, msg: outside
      ? `Nothing to fill — the ${outside} un-placed photo${outside > 1 ? 's fall' : ' falls'} outside the placed range.`
      : 'Every photo in range already has a location.' };
  }
  if (filled) emit('change');
  return {
    ok: true,
    msg: `Placed ${filled} photo${filled > 1 ? 's' : ''} along the route` +
         (outside ? ` · ${outside} left un-placed (outside the range)` : ''),
  };
}
