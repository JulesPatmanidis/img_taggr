/* Small DOM helpers shared by the views. */

/** A remembered setting, or `fallback` when storage is empty or blocked
 *  (private mode, disabled site data). */
export function stored(key, fallback = null) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

/** Remember a setting; losing it is never worth an error. */
export function store(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* ignore */ }
}

/**
 * A drag handle for resizing panes. `move(e)` runs on every pointermove;
 * `frame()` runs at most once per animation frame while dragging, and once at
 * the end, since re-laying out the views per pointermove is too much work.
 */
export function dragHandle(handle, { move, frame, end = () => {} }) {
  handle.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    handle.classList.add('on');
    let queued = false;
    const onMove = (e) => {
      move(e);
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; frame(); });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', () => {
      window.removeEventListener('pointermove', onMove);
      handle.classList.remove('on');
      end();
      frame();
    }, { once: true });
  });
}

/* ── Keyed lists ───────────────────────────────────────────────── */

/** How a keyed list adds, removes and locates its nodes inside a container
 *  element. Anything that is not an element supplies its own version of this,
 *  which is how the Leaflet layer group and the tests plug in. */
const childOps = (el) => ({
  insert: (node, before) => el.insertBefore(node, before),
  remove: (node) => node.remove(),
  after: (node) => (node.parentNode === el ? node.nextSibling : undefined),
});

/**
 * Keeps a container in step with a keyed sequence: creates what is new,
 * updates what stayed, removes what left, and puts the nodes in item order.
 * The nodes live in here, so the data never has to carry its own view.
 *
 * `host` is a container element, or an ops object for a collection that is not
 * a DOM parent. Ordering happens only when ops can report a node's position,
 * so a host without `after` (the map's clusters) is left unordered.
 *
 * `update` is called for new and surviving nodes alike, so it is the only
 * place that has to know how an item is painted.
 */
export function keyedList(host, { key = (it) => it.id, create, update = () => {} }) {
  const ops = typeof host.insert === 'function' ? host : childOps(host);
  const nodes = new Map();

  const forget = (k) => {
    const node = nodes.get(k);
    if (node === undefined) return;
    nodes.delete(k);
    ops.remove(node);
  };

  return {
    get: (k) => nodes.get(k),
    has: (k) => nodes.has(k),
    entries: () => nodes.entries(),
    /** Forget one node, so the next sync builds it again from scratch. */
    drop: forget,
    clear() { for (const k of [...nodes.keys()]) forget(k); },

    sync(items, ctx) {
      const order = [];
      const seen = new Set();
      for (const it of items) {
        const k = key(it);
        seen.add(k);
        let node = nodes.get(k);
        if (node === undefined) {
          node = create(it, ctx);
          nodes.set(k, node);
          ops.insert(node, null);
        }
        update(node, it, ctx);
        order.push(node);
      }
      for (const k of [...nodes.keys()]) if (!seen.has(k)) forget(k);
      if (!ops.after) return order.length;
      // Walk backwards so each node only has to know the one that follows it;
      // a list that is already in order moves nothing.
      let anchor = null;
      for (let i = order.length - 1; i >= 0; i--) {
        if (ops.after(order[i]) !== anchor) ops.insert(order[i], anchor);
        anchor = order[i];
      }
      return order.length;
    },
  };
}

/** Play a one-shot CSS animation again, even if it is already running. */
export function replay(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth; // force a style flush so the animation restarts
  el.classList.add(cls);
}

/** Text with `code spans` in it, as DOM nodes. Built rather than assigned as HTML,
 *  so a label can carry a filename without the string ever being parsed. */
export function withCode(text) {
  const frag = document.createDocumentFragment();
  text.split(/`([^`]+)`/).forEach((part, i) => {
    if (i % 2 === 0) frag.append(part);
    else frag.append(Object.assign(document.createElement('code'), { textContent: part }));
  });
  return frag;
}
