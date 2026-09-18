/* Map view: place and move photos geographically.
 *
 * Interactions:
 *   click empty map      place every selected photo at that point
 *   drag a marker        move it; if it belongs to a multi-photo selection the
 *                        whole selection moves rigidly, preserving its shape
 *   Interpolate route    fill in un-placed photos along the line between placed
 *                        ones, positioned by their timestamp
 *
 * Nearby pins merge into a cluster showing a count; clicking one zooms in, and
 * photos at identical coordinates are spiderfied so each can be picked or dragged.
 */

import {
  state, selected, applyEdit, dtToMs, roundCoord, clickSelect, markClasses, mark,
  isEdited, isRepaint, photoCount, isUnplaced,
} from './state.js';
import { replay, keyedList } from './dom.js';

let map = null;
/** photo id -> L.Marker. Clusters have no order of their own, so this list
 *  only ever adds, updates and removes. */
let markers = null;
let cluster = null;
/** Whether a cluster is spiderfied. Refreshing cluster icons collapses it and
 *  removes the pin under the pointer, so refreshes wait until this is false. */
let fannedOut = false;
let route = null;
let showRoute = true;
/** Called with a photo id when its pin is double-clicked. */
let onReveal = () => {};

export function initMap(el, opts = {}) {
  onReveal = opts.onReveal ?? onReveal;
  map = L.map(el, { zoomControl: false, attributionControl: true, worldCopyJump: true, maxZoom: 20 })
    .setView([30, 10], 2);
  // Leaflet treats more than 3px of movement between press and release as a
  // pan and drops the click. Only the map's own drag gets the wider tolerance; `_draggable`
  // is private, but has its own options object in Leaflet 1.9.
  map.dragging._draggable.options.clickTolerance = 10;
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  setBasemap(opts.basemap);

  cluster = L.markerClusterGroup({
    maxClusterRadius: 36,
    showCoverageOnHover: false,
    spiderfyDistanceMultiplier: 1.7,
    // Colours come from the theme in styles.css, through the class.
    spiderLegPolylineOptions: { weight: 1.5, opacity: 0.7, className: 'spiderLeg' },
    iconCreateFunction: clusterIcon,
  }).addTo(map);
  markers = keyedList(
    { insert: (m) => cluster.addLayer(m), remove: (m) => cluster.removeLayer(m) },
    { create: makeMarker, update: paintPin },
  );
  cluster.on('spiderfied', () => { fannedOut = true; });
  cluster.on('unspiderfied', () => { fannedOut = false; cluster.refreshClusters(); });

  map.on('click', (e) => {
    const sel = selected();
    if (!sel.length) { opts.onClickEmpty?.(); return; }
    placeAt(sel, e.latlng);
  });

  return map;
}

/** Move `photos` to `latlng` as one undo step. Leaflet's longitude runs past
 *  ±180 once the world has been panned round, so wrap it back. */
function placeAt(photos, latlng) {
  applyEdit(photos, (ps) => {
    for (const p of ps) {
      p.lat = roundCoord(latlng.lat);
      p.lon = roundCoord(((latlng.lng + 180) % 360 + 360) % 360 - 180);
    }
  });
}

/* Basemaps that need no key or account. */
const OSM = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const BASEMAPS = {
  map: () => [
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxNativeZoom: 19, maxZoom: 20, attribution: OSM,
    }),
  ],
  // Imagery has no names on it, so lay place labels on top to stay oriented.
  satellite: () => [
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 19, maxZoom: 20,
      attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
    }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 19, maxZoom: 20,
    }),
  ],
};
let basemap = [];
let basemapKey = 'map';

/** Switch basemaps; anything unknown, such as a stale saved choice, falls back
 *  to the plain map. Returns the basemap now shown. */
export function setBasemap(name) {
  basemapKey = name in BASEMAPS ? name : 'map';
  for (const layer of basemap) layer.remove();
  basemap = BASEMAPS[basemapKey]();
  for (const layer of basemap) layer.addTo(map).bringToBack();
  map.getContainer().dataset.basemap = basemapKey;
  return basemapKey;
}
export const basemapName = () => basemapKey;

export function setShowRoute(v) { showRoute = v; render(); }

/** Crosshair cursor while a click would place photos. */
export function setPlacing(on) {
  map?.getContainer().classList.toggle('placing', on);
}

export function center() {
  const c = map.getCenter();
  return { lat: c.lat, lon: c.lng, zoom: map.getZoom() };
}

/** The photo a pin element belongs to, or null for clusters and search marks. */
export function photoIdOf(el) {
  for (const [id, m] of markers) if (m.getElement() === el) return id;
  return null;
}

/* ── Search results ────────────────────────────────────────────── */
let place = null;

/** Fly to a searched place and mark it. The mark ignores the pointer, so
 *  clicking on it places photos exactly there like anywhere else. */
export function showPlace({ lat, lon, extent, label }) {
  clearPlace();
  if (extent) {
    const [w, n, e, s] = extent;
    map.flyToBounds([[s, w], [n, e]], { maxZoom: 17, duration: 0.8 });
  } else {
    map.flyTo([lat, lon], 17, { duration: 0.8 });
  }
  place = L.marker([lat, lon], {
    interactive: false, keyboard: false,
    icon: L.divIcon({ className: '', html: '<div class="placeMark"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
  }).bindTooltip(label, { permanent: true, direction: 'top', offset: [0, -10], className: 'placeLabel' })
    .addTo(map);
}

export function clearPlace() {
  place?.remove();
  place = null;
}
export function invalidate() { if (map) map.invalidateSize(); }

/** A pin: a thumbnail in a teardrop, anchored at its tip. */
function pinIcon(cls, thumb, label = '') {
  const img = thumb ? `background-image:url('${thumb}')` : '';
  const lab = label ? ` data-label="${label}"` : '';
  return L.divIcon({
    className: '',
    html: `<div class="${cls}" style="${img}"${lab}></div>`,
    iconSize: [38, 47],
    iconAnchor: [19, 47],
  });
}

const icon = (p) => pinIcon(markClasses('pin', p), p.thumb);

/** A cluster looks like a pin with a count, and carries the selected and
 *  edited colours of any photo inside it. */
function clusterIcon(c) {
  const ids = new Set(c.getAllChildMarkers().map((m) => m.photoId));
  const photos = state.photos.filter((p) => ids.has(p.id));
  const picked = photos.filter((p) => state.selection.has(p.id)).length;
  const cls = ['pin', 'cluster',
    picked ? 'sel' : '',
    photos.some(isEdited) ? 'edited' : ''].filter(Boolean).join(' ');
  // The label gives the cluster's photo count and how many of them are selected.
  const label = picked && picked < ids.size ? `${ids.size} photos · ${picked} selected`
    : picked ? `${photoCount(ids.size)} selected`
      : photoCount(ids.size);
  return pinIcon(cls, photos.find((p) => p.thumb)?.thumb, label);
}

/** Refresh a pin's look in place. Swapping the whole icon would replace the
 *  element between the two clicks of a double-click, so it would never fire. */
function paint(m, p) {
  const el = m.getElement()?.firstElementChild;
  if (!el) { m.setIcon(icon(p)); return; }
  mark(el, p);
  const bg = p.thumb ? `url("${p.thumb}")` : '';
  if (el.style.backgroundImage !== bg) el.style.backgroundImage = bg;
}

/** Rigid-body drag state, captured on dragstart. */
let drag = null;
/** Id of the marker being dragged, set before any render can run. render()
 *  leaves its icon and position alone, since swapping a marker's icon mid-drag
 *  detaches the element Leaflet is dragging. */
let dragId = null;

function makeMarker(p) {
  const m = L.marker([p.lat, p.lon], { icon: icon(p), draggable: true, riseOnHover: true });
  m.photoId = p.id;

  m.on('dragstart', () => {
    dragId = p.id;
    // Dragging a marker outside the selection re-selects just that photo.
    if (!state.selection.has(p.id)) clickSelect(p.id);
    const group = selected().filter((q) => q.lat != null && q.id !== p.id);
    for (const q of group) {
      // Mark these as dragged for the cluster plugin, or it re-clusters them on
      // every frame and collapses the spiderfied group.
      const mk = markers.get(q.id);
      if (mk) mk.__dragStart = mk.getLatLng();
    }
    drag = {
      // The drawn position, which for a spiderfied pin differs from its coordinates.
      from: m.getLatLng(),
      origin: { lat: p.lat, lon: p.lon },
      group: group.map((q) => ({ q, lat: q.lat, lon: q.lon })),
    };
  });

  m.on('drag', (e) => {
    if (!drag) return;
    const dLat = e.latlng.lat - drag.from.lat;
    const dLon = e.latlng.lng - drag.from.lng;
    for (const g of drag.group) {
      const mk = markers.get(g.q.id);
      if (mk) mk.setLatLng([g.lat + dLat, g.lon + dLon]);
    }
    if (showRoute) drawRoute(true);
  });

  m.on('dragend', (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    dragId = null;
    const dLat = e.target.getLatLng().lat - d.from.lat;
    const dLon = e.target.getLatLng().lng - d.from.lng;
    for (const g of d.group) {
      // The plugin ignored their moves, so let render add them afresh.
      const mk = markers.get(g.q.id);
      if (mk) { delete mk.__dragStart; markers.drop(g.q.id); }
    }
    applyEdit([p, ...d.group.map((g) => g.q)], () => {
      p.lat = roundCoord(d.origin.lat + dLat);
      p.lon = roundCoord(d.origin.lon + dLon);
      for (const g of d.group) {
        g.q.lat = roundCoord(g.lat + dLat);
        g.q.lon = roundCoord(g.lon + dLon);
      }
    });
  });

  m.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    const ev = e.originalEvent;
    clickSelect(p.id, { toggle: ev.ctrlKey || ev.metaKey });
  });

  m.on('dblclick', (e) => {
    // Double-click reveals the photo in the timeline instead of zooming the map.
    L.DomEvent.stopPropagation(e);
    onReveal(p.id);
  });

  return m;
}

function drawRoute(live) {
  if (!showRoute || state.photos.length === 0) {
    if (route) { route.remove(); route = null; }
    return;
  }
  const pts = state.photos
    .filter((p) => p.lat != null && p.datetime)
    .sort((a, b) => dtToMs(a.datetime) - dtToMs(b.datetime))
    .map((p) => (live && markers.get(p.id) ? markers.get(p.id).getLatLng() : L.latLng(p.lat, p.lon)));

  if (pts.length < 2) {
    if (route) { route.remove(); route = null; }
    return;
  }
  // One polyline, reused across drag frames.
  if (route) {
    route.setLatLngs(pts);
  } else {
    route = L.polyline(pts, { weight: 1.5, opacity: 0.5, dashArray: '4 4', className: 'route' })
      .addTo(map);
    route.bringToBack();
  }
}

/** Move a pin to its photo's coordinates, unless a drag is moving it. */
function paintPin(m, p) {
  if (p.id === dragId) return;
  if (!drag) {
    // A spiderfied pin is drawn at its fan position; the plugin keeps its real
    // coordinates in `_preSpiderfyLatlng`.
    const cur = m._preSpiderfyLatlng ?? m.getLatLng();
    if (cur.lat !== p.lat || cur.lng !== p.lon) m.setLatLng([p.lat, p.lon]);
  }
  paint(m, p);
}

export function render(reason) {
  if (!map) return;
  markers.sync(state.photos.filter((p) => p.lat != null && p.lon != null));
  // Selection and edits change what a cluster should look like.
  if (!drag && !fannedOut) cluster.refreshClusters();
  // The route follows positions and times, so a selection never moves it.
  if (!isRepaint(reason)) drawRoute(false);
}

/** Places photos dragged in from the filmstrip at the drop coordinates. */
export const dropTarget = {
  hover(x, y) {
    const over = !!map && inside(x, y);
    map?.getContainer().classList.toggle('dropping', over);
    return over;
  },
  leave() { map?.getContainer().classList.remove('dropping'); },
  drop(x, y, ids) {
    this.leave();
    const r = map.getContainer().getBoundingClientRect();
    placeAt(state.photos.filter((p) => ids.includes(p.id)),
      map.containerPointToLatLng([x - r.left, y - r.top]));
  },
};

function inside(x, y) {
  const r = map.getContainer().getBoundingClientRect();
  return r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** Pan to these photos and play the pulse animation on their pins. */
export function reveal(ids) {
  if (!map) return;
  const pts = state.photos.filter((p) => ids.includes(p.id) && p.lat != null);
  if (!pts.length) return;
  const pulse = () => {
    for (const p of pts) {
      const el = markers.get(p.id)?.getElement()?.firstElementChild;
      if (el) replay(el, 'pulse');
    }
  };
  if (pts.length === 1) {
    map.setView([pts[0].lat, pts[0].lon], Math.max(map.getZoom(), 15), { animate: false });
    // Zooms further or fans out a cluster if the pin is still hidden inside one.
    cluster.zoomToShowLayer(markers.get(pts[0].id), pulse);
  } else {
    map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lon])).pad(0.3), { maxZoom: 17, animate: false });
    pulse();
  }
}

/** Zoom to fit every placed photo. */
export function fit() {
  if (!map) return;
  const pts = state.photos.filter((p) => p.lat != null).map((p) => [p.lat, p.lon]);
  if (!pts.length) return;
  if (pts.length === 1) map.setView(pts[0], Math.max(map.getZoom(), 14));
  else map.fitBounds(L.latLngBounds(pts).pad(0.18));
}

/**
 * Fill in positions for photos whose timestamps fall between two placed photos.
 * Returns a short report for the toast.
 */
export function interpolate() {
  const scope = state.selection.size >= 2 ? selected() : state.photos;
  const timed = scope
    .filter((p) => p.datetime)
    .sort((a, b) => dtToMs(a.datetime) - dtToMs(b.datetime));

  const anchorIdx = timed.map((p, i) => (p.lat != null ? i : -1)).filter((i) => i >= 0);
  if (anchorIdx.length < 2) {
    // Name the set without enough placed photos: the selection, or all photos.
    return { ok: false, msg: state.selection.size >= 2
      ? 'Fewer than two of the selected photos have a location. Clear the selection to interpolate across the whole folder.'
      : 'Place at least two photos on the map first. Interpolation needs a route to follow.' };
  }

  const filled = applyEdit(timed, () => {
    for (let k = 0; k < anchorIdx.length - 1; k++) {
      const a = timed[anchorIdx[k]];
      const b = timed[anchorIdx[k + 1]];
      const ta = dtToMs(a.datetime);
      const tb = dtToMs(b.datetime);
      for (let i = anchorIdx[k] + 1; i < anchorIdx[k + 1]; i++) {
        const p = timed[i];
        if (p.lat != null) continue;
        // Equal timestamps would divide by zero; fall back to the first anchor.
        const f = tb === ta ? 0 : (dtToMs(p.datetime) - ta) / (tb - ta);
        p.lat = roundCoord(a.lat + (b.lat - a.lat) * f);
        p.lon = roundCoord(a.lon + (b.lon - a.lon) * f);
      }
    }
  });

  const outside = timed.filter(isUnplaced).length;
  if (!filled) {
    return { ok: false, msg: outside
      ? `Nothing to fill. The ${outside} un-placed photo${outside > 1 ? 's fall' : ' falls'} outside the placed range.`
      : 'Every photo in range already has a location.' };
  }
  return {
    ok: true,
    msg: `Placed ${filled} photo${filled > 1 ? 's' : ''} along the route` +
         (outside ? ` · ${outside} left un-placed (outside the range)` : ''),
  };
}
