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

/** Play a one-shot CSS animation again, even if it is already running. */
export function replay(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth; // force a style flush so the animation restarts
  el.classList.add(cls);
}
