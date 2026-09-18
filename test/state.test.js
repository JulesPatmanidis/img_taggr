import test from 'node:test';
import assert from 'node:assert/strict';

import {
  state, applyEdit, setOnChange, undo, redo, isEdited, rebase, resetHistory,
  sortPhotos, dtToMs, msToDt, normDt,
  emit, isRepaint, clickSelect, addPhotos, removePhotos, clearPhotos,
} from '../app/state.js';

/** A folder of photos, plus a count of the re-renders they trigger. */
function folder(...photos) {
  state.photos = photos.map((p, i) => {
    const photo = {
      id: `p${i}`, name: `p${i}.jpg`,
      datetime: null, offset: null, lat: null, lon: null, ...p,
    };
    rebase(photo);
    return photo;
  });
  state.selection.clear();
  resetHistory();
  const renders = { n: 0 };
  setOnChange(() => { renders.n++; });
  return renders;
}

/* ── applyEdit ─────────────────────────────────────────────────── */

test('applyEdit: mutates, counts, snapshots and re-renders', () => {
  const renders = folder({ lat: 1 }, { lat: 2 });
  const [a] = state.photos;

  const n = applyEdit([a], (ps) => { ps[0].lat = 9; });

  assert.equal(n, 1);
  assert.equal(a.lat, 9);
  assert.equal(state.undo.length, 1);
  assert.equal(renders.n, 1);
  assert.equal(isEdited(a), true);
});

test('applyEdit: an edit that changes nothing costs no undo step', () => {
  const renders = folder({ lat: 1 });
  const [a] = state.photos;

  const n = applyEdit([a], (ps) => { ps[0].lat = 1; });

  assert.equal(n, 0);
  assert.equal(state.undo.length, 0);
  // It still re-renders: a drag back to where it started must be redrawn.
  assert.equal(renders.n, 1);
});

test('applyEdit: an empty selection does nothing at all', () => {
  const renders = folder({ lat: 1 });
  const n = applyEdit([], () => { assert.fail('mutate must not run'); });
  assert.equal(n, 0);
  assert.equal(state.undo.length, 0);
  assert.equal(renders.n, 0);
});

test('applyEdit: the count is of photos changed, not photos passed', () => {
  folder({ lat: 1 }, { lat: 2 }, { lat: 3 });
  const [, b] = state.photos;

  // The whole folder goes in; one photo comes out changed.
  const n = applyEdit(state.photos, () => { b.lat = 99; });

  assert.equal(n, 1);
  assert.equal(state.undo.length, 1);
});

test('applyEdit: takes any iterable', () => {
  folder({ lat: 1 }, { lat: 2 });
  const n = applyEdit(new Set(state.photos), (ps) => { for (const p of ps) p.lat = 0; });
  assert.equal(n, 2);
});

test('applyEdit: one call is one undo step, however many photos it touched', () => {
  folder({ lat: 1 }, { lat: 2 }, { lat: 3 });
  applyEdit(state.photos, (ps) => { for (const p of ps) p.lat = 0; });

  assert.equal(state.undo.length, 1);
  assert.equal(undo(), true);
  assert.deepEqual(state.photos.map((p) => p.lat), [1, 2, 3]);
});

/* ── Undo journal ──────────────────────────────────────────────── */

test('undo and redo walk the same edits both ways', () => {
  folder({ lat: 1 });
  const [a] = state.photos;

  applyEdit([a], () => { a.lat = 2; });
  applyEdit([a], () => { a.lat = 3; });

  assert.equal(undo(), true);
  assert.equal(a.lat, 2);
  assert.equal(undo(), true);
  assert.equal(a.lat, 1);
  assert.equal(undo(), false, 'nothing left to undo');

  assert.equal(redo(), true);
  assert.equal(a.lat, 2);
  assert.equal(redo(), true);
  assert.equal(a.lat, 3);
  assert.equal(redo(), false, 'nothing left to redo');
});

test('an undo restores only the fields that photo owns', () => {
  folder({ lat: 1, datetime: '2020-01-01T00:00:00' }, { lat: 2 });
  const [a, b] = state.photos;

  applyEdit([b], () => { b.lat = 20; });
  undo();

  assert.equal(b.lat, 2);
  assert.equal(a.lat, 1, 'the untouched photo is left alone');
  assert.equal(a.datetime, '2020-01-01T00:00:00');
});

test('a fresh edit clears the redo branch', () => {
  folder({ lat: 1 });
  const [a] = state.photos;

  applyEdit([a], () => { a.lat = 2; });
  undo();
  assert.equal(state.redo.length, 1);

  applyEdit([a], () => { a.lat = 5; });
  assert.equal(state.redo.length, 0);
  assert.equal(redo(), false);
});

test('the journal stops at 50 steps, dropping the oldest', () => {
  folder({ lat: 0 });
  const [a] = state.photos;
  for (let i = 1; i <= 60; i++) applyEdit([a], () => { a.lat = i; });

  assert.equal(state.undo.length, 50);
  for (let i = 0; i < 50; i++) undo();
  // 60 edits, 50 remembered: the walk back stops at the 10th, not the start.
  assert.equal(a.lat, 10);
});

/* ── Ordering ──────────────────────────────────────────────────── */

test('sortPhotos: undated first, then by time, then by name', () => {
  folder(
    { name: 'c.jpg', datetime: '2021-01-01T10:00:00' },
    { name: 'a.jpg' },
    { name: 'b.jpg', datetime: '2020-01-01T10:00:00' },
  );
  sortPhotos();
  assert.deepEqual(state.photos.map((p) => p.name), ['a.jpg', 'b.jpg', 'c.jpg']);
});

test('sortPhotos: same timestamp falls back to a natural name order', () => {
  const dt = '2020-01-01T10:00:00';
  folder({ name: 'img10.jpg', datetime: dt }, { name: 'img2.jpg', datetime: dt });
  sortPhotos();
  assert.deepEqual(state.photos.map((p) => p.name), ['img2.jpg', 'img10.jpg']);
});

/* ── Wall-clock arithmetic ─────────────────────────────────────── */

test('the wall clock round-trips, including years below 100', () => {
  for (const dt of ['2020-02-29T23:59:59', '0012-05-06T01:02:03', '1999-12-31T00:00:00']) {
    assert.equal(msToDt(dtToMs(dt)), dt);
    assert.equal(normDt(dt), dt);
  }
});

test('dtToMs ignores the machine timezone', () => {
  // One hour apart in wall-clock terms, whatever TZ the test runs under.
  const a = dtToMs('2020-06-01T12:00:00');
  const b = dtToMs('2020-06-01T13:00:00');
  assert.equal(b - a, 3600 * 1000);
});

test('dtToMs rejects what it cannot read', () => {
  for (const bad of [null, '', 'yesterday', '2020-06-01']) assert.equal(dtToMs(bad), null);
});

/* ── Emit reasons ──────────────────────────────────────────────── */

/** Same folder, but recording *why* each re-render was asked for. */
function reasons(...photos) {
  const log = [];
  folder(...photos);
  setOnChange((reason) => log.push(reason));
  return log;
}

test('emit: an edit is one render, for the reason "edits"', () => {
  const log = reasons({ lat: 1 }, { lat: 2 });
  applyEdit(state.photos, (ps) => { for (const p of ps) p.lat = 5; });
  assert.deepEqual(log, ['edits']);
});

test('emit: a no-op edit still renders, and still says "edits"', () => {
  const log = reasons({ lat: 1 });
  applyEdit(state.photos, () => {});
  assert.deepEqual(log, ['edits']);
});

test('emit: selecting says "selection", so the views can skip a re-layout', () => {
  const log = reasons({}, {});
  clickSelect('p0');
  clickSelect('p1', { toggle: true });
  assert.deepEqual(log, ['selection', 'selection']);
});

test('emit: undo and redo are edits, not selections', () => {
  const log = reasons({ lat: 1 });
  applyEdit(state.photos, (ps) => { ps[0].lat = 2; });
  log.length = 0;
  undo(); emit('edits');
  redo(); emit('edits');
  assert.deepEqual(log, ['edits', 'edits']);
});

test('isRepaint: only selection and thumbs skip the layout', () => {
  assert.equal(isRepaint('selection'), true);
  assert.equal(isRepaint('thumbs'), true);
  assert.equal(isRepaint('edits'), false);
  assert.equal(isRepaint('photos'), false);
  assert.equal(isRepaint(undefined), false);
});

/* ── Sessions and sources ──────────────────────────────────────── */

/** A loose photo record, as a backend hands one over. */
const mk = (id, extra = {}) => {
  const p = { id, name: `${id}.jpg`, datetime: null, offset: null, lat: null, lon: null, ...extra };
  rebase(p);
  return p;
};

test('clearPhotos: each session gets its own token', () => {
  folder({});
  const first = clearPhotos();
  const second = clearPhotos();
  assert.equal(second, first + 1);
  assert.equal(state.session, second);
});

test('clearPhotos: two loads of the same folder still differ', () => {
  // The bug this exists for: the old token was the folder label, and two loose
  // drops carry the same label, so the first load never learned it was stale.
  folder({});
  const a = clearPhotos();
  addPhotos([mk('x')], 'trip');
  const b = clearPhotos();
  assert.notEqual(a, b);
});

test('clearPhotos: the outgoing list takes its selection, journal and sources with it', () => {
  folder({ lat: 1 });
  applyEdit(state.photos, (ps) => { ps[0].lat = 2; });
  state.selection.add('p0');
  clearPhotos();
  assert.deepEqual(state.photos, []);
  assert.deepEqual(state.sources, []);
  assert.equal(state.selection.size, 0);
  assert.equal(state.undo.length, 0);
  assert.equal(state.redo.length, 0);
});

test('addPhotos: the new photos arrive sorted into the list', () => {
  folder();
  clearPhotos();
  addPhotos([mk('b', { datetime: '2023-01-02T00:00:00' }),
    mk('a', { datetime: '2023-01-01T00:00:00' }), mk('u')], 'trip');
  assert.deepEqual(state.photos.map((p) => p.id), ['u', 'a', 'b']);
});

test('addPhotos: a second source joins the first rather than replacing it', () => {
  folder();
  clearPhotos();
  addPhotos([mk('a')], '/trip');
  state.selection.add('a');
  const added = addPhotos([mk('b')], '/scans');
  assert.deepEqual(added.map((p) => p.id), ['b']);
  assert.deepEqual(state.photos.map((p) => p.id).sort(), ['a', 'b']);
  assert.deepEqual(state.sources, ['/trip', '/scans']);
  // Adding is not a fresh start, so nothing the user had set up is cleared.
  assert.deepEqual([...state.selection], ['a']);
});

test('addPhotos: a photo already loaded is not added twice', () => {
  folder();
  clearPhotos();
  addPhotos([mk('a'), mk('b')], '/trip');
  const added = addPhotos([mk('b'), mk('c')], '/trip');
  assert.deepEqual(added.map((p) => p.id), ['c']);
  assert.deepEqual(state.photos.map((p) => p.id).sort(), ['a', 'b', 'c']);
  // The same folder added twice is still one source.
  assert.deepEqual(state.sources, ['/trip']);
});

test('addPhotos: shot numbers are handed out once and never move', () => {
  folder();
  clearPhotos();
  addPhotos([mk('b'), mk('a')], '/trip');
  const seqOf = (id) => state.photos.find((p) => p.id === id).seq;
  // Within a batch the badge follows filename order, which is shot order.
  assert.equal(seqOf('a'), 1);
  assert.equal(seqOf('b'), 2);
  addPhotos([mk('c')], '/scans');
  assert.equal(seqOf('c'), 3);
  // The photos that were already here keep the numbers the user has been reading.
  assert.equal(seqOf('a'), 1);
  assert.equal(seqOf('b'), 2);
});

test('addPhotos: a batch of nothing new records no source', () => {
  folder();
  clearPhotos();
  addPhotos([mk('a')], '/trip');
  assert.deepEqual(addPhotos([mk('a')], '/scans'), []);
  assert.deepEqual(state.sources, ['/trip']);
});

test('removePhotos: the photos and their selection go, the rest stays', () => {
  folder();
  clearPhotos();
  addPhotos([mk('a'), mk('b'), mk('c')], '/trip');
  state.selection.add('a');
  state.selection.add('b');
  assert.equal(removePhotos(['a', 'missing']), 1);
  assert.deepEqual(state.photos.map((p) => p.id).sort(), ['b', 'c']);
  assert.deepEqual([...state.selection], ['b']);
});

test('removePhotos: undo still works on what is left, and brings nothing back', () => {
  folder();
  clearPhotos();
  addPhotos([mk('a', { lat: 1 }), mk('b', { lat: 1 })], '/trip');
  applyEdit(state.photos, (ps) => { for (const p of ps) p.lat = 2; });
  removePhotos(['a']);
  assert.equal(undo(), true);
  assert.deepEqual(state.photos.map((p) => p.id), ['b']);
  assert.equal(state.photos[0].lat, 1);
});
