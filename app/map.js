/* Map view — place and move photos geographically.
 *
 * Interactions:
 *   click empty map      place every selected photo at that point
 *   drag a marker        move it; if it belongs to a multi-photo selection the
 *                        whole selection moves rigidly, preserving its shape
 *   Interpolate route    fill in un-placed photos along the line between placed
 *                        ones, positioned by their timestamp
 *
 * Nearby pins merge into a cluster showing a count; clicking one zooms in, and
 * photos at the very same spot fan out so each can be picked or dragged.
 */

import {
  state, selected, commit, emit, dtToMs, roundCoord, clickSelect, markClasses, isEdited,
} from './state.js';

let map = null;
/** photo id -> L.Marker */
const markers = new Map();
let cluster = null;
/** Refreshing cluster icons folds a fanned-out cluster back up, which would
 *  snatch a pin away mid-click, so hold refreshes while one is open. */
let fannedOut = false;
let route = null;
let showRoute = true;
/** Called with a photo id when its pin is double-clicked. */
let onReveal = () => {};

export function initMap(el, opts = {}) {
  onReveal = opts.onReveal ?? onReveal;
  // Leaflet reads a 3px wobble between press and release as a pan and drops
  // the click, so a slightly shaky click on the map placed nothing.
  L.Draggable.prototype.options.clickTolerance = 10;
  map = L.map(el, { zoomControl: false, attributionControl: true, worldCopyJump: true, maxZoom: 20 })
    .setView([30, 10], 2);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  setBasemap(opts.basemap === 'satellite' ? 'satellite' : 'map');

  cluster = L.markerClusterGroup({
    maxClusterRadius: 36,
    showCoverageOnHover: false,
    spiderfyDistanceMultiplier: 1.7,
    spiderLegPolylineOptions: { weight: 1.5, color: '#3d64c4', opacity: 0.7 },
    iconCreateFunction: clusterIcon,
  }).addTo(map);
  cluster.on('spiderfied', () => { fannedOut = true; });
  cluster.on('unspiderfied', () => { fannedOut = false; cluster.refreshClusters(); });

  map.on('click', (e) => {
    const sel = selected();
    if (!sel.length) return;
    commit();
    for (const p of sel) {
      p.lat = roundCoord(e.latlng.lat);
      p.lon = roundCoord(((e.latlng.lng + 180) % 360 + 360) % 360 - 180);
    }
    emit();
  });

  return map;
}

/* Neither needs a key or an account, so the page works for anyone who opens
   it. (CARTO's styles were nicer but now demand a key.) */
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

export function setBasemap(name) {
  for (const layer of basemap) layer.remove();
  basemap = BASEMAPS[name]();
  for (const layer of basemap) layer.addTo(map).bringToBack();
  map.getContainer().dataset.basemap = name;
}

export function setShowRoute(v) { showRoute = v; render(); }
export function invalidate() { if (map) map.invalidateSize(); }

function icon(p) {
  const cls = markClasses('pin', p);
  const img = p.thumb ? `background-image:url('${p.thumb}')` : '';
  return L.divIcon({
    className: '',
    html: `<div class="${cls}" style="${img}"></div>`,
    iconSize: [38, 47],
    iconAnchor: [19, 47],
  });
}

/** A cluster looks like a pin with a count, and carries the same selected and
 *  edited colours as any photo inside it, so nothing hides behind a merge. */
function clusterIcon(c) {
  const ids = new Set(c.getAllChildMarkers().map((m) => m.photoId));
  const photos = state.photos.filter((p) => ids.has(p.id));
  const cls = ['pin', 'cluster',
    photos.some((p) => state.selection.has(p.id)) ? 'sel' : '',
    photos.some(isEdited) ? 'edited' : ''].filter(Boolean).join(' ');
  const face = photos.find((p) => p.thumb);
  const img = face ? `background-image:url('${face.thumb}')` : '';
  return L.divIcon({
    className: '',
    html: `<div class="${cls}" style="${img}"><b>${ids.size}</b></div>`,
    iconSize: [38, 47],
    iconAnchor: [19, 47],
  });
}

/** Refresh a pin's look in place. Swapping the whole icon would replace the
 *  element between the two clicks of a double-click, so it would never fire. */
function paint(m, p) {
  const el = m.getElement()?.firstElementChild;
  if (!el) { m.setIcon(icon(p)); return; }
  const cls = markClasses('pin', p);
  if (el.className.replace(/ ?pulse/, '') !== cls) {
    el.className = cls + (el.classList.contains('pulse') ? ' pulse' : '');
  }
  const bg = p.thumb ? `url("${p.thumb}")` : '';
  if (el.style.backgroundImage !== bg) el.style.backgroundImage = bg;
}

/** Rigid-body drag state, captured on dragstart. */
let drag = null;
/** Id of the marker being dragged. Set before any render can run, so render()
 *  knows to leave that marker's icon and position alone — swapping the icon of
 *  a marker mid-drag detaches the very element Leaflet is dragging. */
let dragId = null;

function makeMarker(p) {
  const m = L.marker([p.lat, p.lon], { icon: icon(p), draggable: true, riseOnHover: true });
  m.photoId = p.id;

  m.on('dragstart', () => {
    dragId = p.id;
    // Dragging a marker outside the current selection re-selects just that photo,
    // matching how every file manager behaves.
    if (!state.selection.has(p.id)) clickSelect(p.id);
    commit();
    const group = selected().filter((q) => q.lat != null && q.id !== p.id);
    for (const q of group) {
      // Tell the cluster plugin these are being dragged too, or it regroups
      // them on every frame and folds up the fan under the pointer.
      const mk = markers.get(q.id);
      if (mk) mk.__dragStart = mk.getLatLng();
    }
    drag = {
      // Where the pin was drawn, which for a fanned-out pin is not its real spot.
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
    const dLat = e.target.getLatLng().lat - drag.from.lat;
    const dLon = e.target.getLatLng().lng - drag.from.lng;
    p.lat = roundCoord(drag.origin.lat + dLat);
    p.lon = roundCoord(drag.origin.lon + dLon);
    for (const g of drag.group) {
      g.q.lat = roundCoord(g.lat + dLat);
      g.q.lon = roundCoord(g.lon + dLon);
      // The plugin ignored their moves, so let render add them afresh.
      const mk = markers.get(g.q.id);
      if (mk) { delete mk.__dragStart; cluster.removeLayer(mk); markers.delete(g.q.id); }
    }
    drag = null;
    dragId = null;
    emit();
  });

  m.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    const ev = e.originalEvent;
    clickSelect(p.id, { toggle: ev.ctrlKey || ev.metaKey });
  });

  m.on('dblclick', (e) => {
    // Double-click means "find this in the timeline", not "zoom the map".
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
  // Reuse the polyline across drag frames rather than tearing down the SVG
  // path 60 times a second.
  if (route) {
    route.setLatLngs(pts);
  } else {
    route = L.polyline(pts, { color: '#7aa2f7', weight: 1.5, opacity: 0.5, dashArray: '4 4' })
      .addTo(map);
    route.bringToBack();
  }
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
      cluster.addLayer(m);
      markers.set(p.id, m);
    } else if (!drag) {
      // A fanned-out pin sits at its spot in the fan; its real place is kept
      // aside by the cluster plugin.
      const cur = m._preSpiderfyLatlng ?? m.getLatLng();
      if (cur.lat !== p.lat || cur.lng !== p.lon) m.setLatLng([p.lat, p.lon]);
    }
    if (p.id !== dragId) paint(m, p);
  }

  for (const [id, m] of markers) {
    if (!live.has(id)) { cluster.removeLayer(m); markers.delete(id); }
  }
  // Selection and edits change what a cluster should look like.
  if (!drag && !fannedOut) cluster.refreshClusters();
  drawRoute(false);
}

/** Photos dragged in from the filmstrip land where they are dropped. */
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
    const ll = map.containerPointToLatLng([x - r.left, y - r.top]);
    commit();
    for (const p of state.photos) {
      if (!ids.includes(p.id)) continue;
      p.lat = roundCoord(ll.lat);
      p.lon = roundCoord(((ll.lng + 180) % 360 + 360) % 360 - 180);
    }
    emit();
  },
};

function inside(x, y) {
  const r = map.getContainer().getBoundingClientRect();
  return r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** Bring these photos into view and pulse their pins so the eye finds them. */
export function reveal(ids) {
  if (!map) return;
  const pts = state.photos.filter((p) => ids.includes(p.id) && p.lat != null);
  if (!pts.length) return;
  const pulse = () => {
    for (const p of pts) {
      const el = markers.get(p.id)?.getElement()?.firstElementChild;
      if (!el) continue;
      el.classList.remove('pulse');
      void el.offsetWidth; // restart the animation
      el.classList.add('pulse');
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
  emit();
  return {
    ok: true,
    msg: `Placed ${filled} photo${filled > 1 ? 's' : ''} along the route` +
         (outside ? ` · ${outside} left un-placed (outside the range)` : ''),
  };
}
