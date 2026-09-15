/* Place search on the map, backed by Photon (komoot's OpenStreetMap geocoder).
 *
 * Search only moves the map. It never writes coordinates: placing photos stays
 * a deliberate click or drag. Queries leave the machine; photos never do.
 */

const ENDPOINT = 'https://photon.komoot.io/api/';
const DEBOUNCE_MS = 280;
/** Photon names places in these languages; anything else gets local names. */
const LANGS = ['en', 'de', 'fr'];

/**
 * @param opts.input, opts.list   the text field and the results list
 * @param opts.center()           {lat, lon, zoom} to bias results toward
 * @param opts.onPick(place)      {lat, lon, extent, label}
 * @param opts.onClear()
 */
export function initSearch({ input, list, center, onPick, onClear }) {
  let results = [];
  let active = -1;
  let timer = 0;
  let pending = null;

  const lang = LANGS.find((l) => navigator.language?.startsWith(l));

  function open(on) {
    list.classList.toggle('hidden', !on);
    input.setAttribute('aria-expanded', String(on));
    if (!on) setActive(-1);
  }

  function setActive(i) {
    active = i;
    const items = list.querySelectorAll('[role="option"]');
    items.forEach((el, k) => el.setAttribute('aria-selected', String(k === i)));
    if (i >= 0 && items[i]) {
      input.setAttribute('aria-activedescendant', items[i].id);
      items[i].scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function message(text) {
    results = [];
    const li = document.createElement('li');
    li.className = 'searchMsg';
    li.textContent = text;
    list.replaceChildren(li);
    open(true);
  }

  function show(features) {
    results = features.map((f) => {
      const p = f.properties;
      const detail = [p.street && p.housenumber ? `${p.street} ${p.housenumber}` : p.street,
        p.city !== p.name ? p.city : null, p.state, p.country]
        .filter((v, i, all) => v && v !== p.name && all.indexOf(v) === i);
      return {
        name: p.name || detail.shift() || 'Unnamed place',
        detail: detail.join(', '),
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0],
        // [minLon, maxLat, maxLon, minLat] for areas such as cities and parks.
        extent: p.extent ?? null,
      };
    });
    if (!results.length) { message('No places found'); return; }

    const frag = document.createDocumentFragment();
    results.forEach((r, i) => {
      const li = document.createElement('li');
      li.id = `searchOpt${i}`;
      li.setAttribute('role', 'option');
      li.innerHTML = '<b></b><span></span>';
      li.querySelector('b').textContent = r.name;
      li.querySelector('span').textContent = r.detail;
      frag.appendChild(li);
    });
    const credit = document.createElement('li');
    credit.className = 'searchCredit';
    credit.textContent = 'Search by Photon · © OpenStreetMap contributors';
    frag.appendChild(credit);
    list.replaceChildren(frag);
    open(true);
    setActive(0);
  }

  async function run(q) {
    pending?.abort();
    pending = new AbortController();
    const c = center();
    const url = new URL(ENDPOINT);
    url.search = new URLSearchParams({
      q, limit: '6', lat: c.lat.toFixed(4), lon: c.lon.toFixed(4), zoom: String(Math.round(c.zoom)),
      ...(lang ? { lang } : {}),
    });
    try {
      const res = await fetch(url, { signal: pending.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      show((await res.json()).features ?? []);
    } catch (e) {
      if (e.name === 'AbortError') return;
      message(navigator.onLine ? 'Search is unavailable right now' : 'Search needs an internet connection');
    }
  }

  function pick(i) {
    const r = results[i];
    if (!r) return;
    input.value = r.name;
    open(false);
    onPick({ lat: r.lat, lon: r.lon, extent: r.extent, label: r.name });
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) {
      pending?.abort();
      open(false);
      if (!q) onClear();
      return;
    }
    timer = setTimeout(() => run(q), DEBOUNCE_MS);
  });

  input.addEventListener('keydown', (e) => {
    const n = results.length;
    const shown = !list.classList.contains('hidden');
    if (e.key === 'ArrowDown' && n) {
      e.preventDefault();
      if (!shown) open(true);
      setActive((active + 1) % n);
    } else if (e.key === 'ArrowUp' && n) {
      e.preventDefault();
      setActive((active - 1 + n) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown) pick(Math.max(0, active));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (shown) { open(false); return; }
      input.value = '';
      onClear();
      input.blur();
    }
  });

  // pointerdown rather than click, so the pick lands before the field blurs.
  list.addEventListener('pointerdown', (e) => {
    const li = e.target.closest('[role="option"]');
    if (!li) return;
    e.preventDefault();
    pick([...list.querySelectorAll('[role="option"]')].indexOf(li));
  });
  list.addEventListener('pointermove', (e) => {
    const li = e.target.closest('[role="option"]');
    if (li) setActive([...list.querySelectorAll('[role="option"]')].indexOf(li));
  });

  input.addEventListener('blur', () => open(false));
  input.addEventListener('focus', () => { if (results.length) open(true); });
  // The browser's own clear button on a search field.
  input.addEventListener('search', () => { if (!input.value) onClear(); });
}
