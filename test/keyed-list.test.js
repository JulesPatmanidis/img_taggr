import test from 'node:test';
import assert from 'node:assert/strict';
import { keyedList } from '../app/dom.js';

/** A container standing in for a DOM parent: an array of nodes, plus the same
 *  three operations an element offers. Lets the reconciler be tested without a
 *  browser, which is the reason ops are injectable at all. */
function fakeHost() {
  const kids = [];
  return {
    kids,
    insert(node, before) {
      const at = kids.indexOf(node);
      if (at !== -1) kids.splice(at, 1);
      const to = before == null ? kids.length : kids.indexOf(before);
      kids.splice(to === -1 ? kids.length : to, 0, node);
    },
    remove(node) {
      const at = kids.indexOf(node);
      if (at !== -1) kids.splice(at, 1);
    },
    after(node) {
      const at = kids.indexOf(node);
      return at === -1 ? undefined : kids[at + 1] ?? null;
    },
  };
}

const ids = (host) => host.kids.map((n) => n.id);

/** Records every create and update so the tests can count the work done. */
function listOn(host, log = []) {
  const list = keyedList(host, {
    create: (it) => { log.push(`create ${it.id}`); return { id: it.id, v: it.v }; },
    update: (node, it) => { log.push(`update ${it.id}`); node.v = it.v; },
  });
  return { list, log };
}

test('keyedList: creates a node per item, in item order', () => {
  const host = fakeHost();
  const { list } = listOn(host);
  list.sync([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  assert.deepEqual(ids(host), ['a', 'b', 'c']);
});

test('keyedList: a surviving item keeps its node', () => {
  const host = fakeHost();
  const { list, log } = listOn(host);
  list.sync([{ id: 'a', v: 1 }]);
  const node = list.get('a');
  log.length = 0;
  list.sync([{ id: 'a', v: 2 }]);
  assert.equal(list.get('a'), node, 'same node object');
  assert.equal(node.v, 2, 'updated in place');
  assert.deepEqual(log, ['update a'], 'no second create');
});

test('keyedList: items that leave take their nodes with them', () => {
  const host = fakeHost();
  const { list } = listOn(host);
  list.sync([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  list.sync([{ id: 'b' }]);
  assert.deepEqual(ids(host), ['b']);
  assert.equal(list.has('a'), false);
  assert.equal(list.has('c'), false);
});

test('keyedList: reordering moves nodes without rebuilding them', () => {
  const host = fakeHost();
  const { list, log } = listOn(host);
  list.sync([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  const b = list.get('b');
  log.length = 0;
  list.sync([{ id: 'c' }, { id: 'b' }, { id: 'a' }]);
  assert.deepEqual(ids(host), ['c', 'b', 'a']);
  assert.equal(list.get('b'), b);
  assert.equal(log.filter((l) => l.startsWith('create')).length, 0);
});

test('keyedList: a list already in order is not touched', () => {
  const host = fakeHost();
  const { list } = listOn(host);
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  list.sync(items);
  let moves = 0;
  const insert = host.insert.bind(host);
  host.insert = (...args) => { moves++; insert(...args); };
  list.sync(items);
  assert.equal(moves, 0);
});

test('keyedList: a new item lands in the middle, not at the end', () => {
  const host = fakeHost();
  const { list } = listOn(host);
  list.sync([{ id: 'a' }, { id: 'c' }]);
  list.sync([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  assert.deepEqual(ids(host), ['a', 'b', 'c']);
});

test('keyedList: foreign children keep their place', () => {
  const host = fakeHost();
  const grid = { id: 'grid' };
  host.kids.push(grid);
  const { list } = listOn(host);
  list.sync([{ id: 'a' }, { id: 'b' }]);
  list.sync([{ id: 'b' }, { id: 'a' }]);
  assert.equal(host.kids[0], grid, 'the grid is never owned by the list');
  assert.deepEqual(ids(host), ['grid', 'b', 'a']);
});

test('keyedList: drop forgets a node so the next sync rebuilds it', () => {
  const host = fakeHost();
  const { list, log } = listOn(host);
  const items = [{ id: 'a' }, { id: 'b' }];
  list.sync(items);
  const a = list.get('a');
  log.length = 0;
  list.drop('a');
  assert.deepEqual(ids(host), ['b']);
  list.sync(items);
  assert.notEqual(list.get('a'), a, 'a fresh node');
  assert.deepEqual(ids(host), ['a', 'b']);
  assert.deepEqual(log, ['create a', 'update a', 'update b']);
});

test('keyedList: an unordered host is never reordered', () => {
  const host = fakeHost();
  delete host.after;
  const { list } = listOn(host);
  list.sync([{ id: 'a' }, { id: 'b' }]);
  list.sync([{ id: 'b' }, { id: 'a' }]);
  assert.deepEqual(ids(host), ['a', 'b'], 'insertion order, untouched');
});

test('keyedList: the key can be something other than item.id', () => {
  const host = fakeHost();
  const list = keyedList(host, {
    key: (it) => it.p.id,
    create: (it) => ({ id: it.p.id }),
  });
  list.sync([{ p: { id: 'x' } }, { p: { id: 'y' } }]);
  assert.deepEqual(ids(host), ['x', 'y']);
});

test('keyedList: clear empties the host', () => {
  const host = fakeHost();
  const { list } = listOn(host);
  list.sync([{ id: 'a' }, { id: 'b' }]);
  list.clear();
  assert.deepEqual(ids(host), []);
  assert.equal(list.has('a'), false);
});
