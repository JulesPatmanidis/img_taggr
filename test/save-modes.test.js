import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SAVE_MODES, saveMode, modesFor } from '../app/backend.js';

test('every mode is fully declared', () => {
  for (const m of SAVE_MODES) {
    assert.equal(typeof m.id, 'string');
    assert.ok(m.label && m.hint, `${m.id} needs a label and a hint`);
    for (const flag of ['needsOutDir', 'writesOriginals', 'destructive']) {
      assert.equal(typeof m[flag], 'boolean', `${m.id}.${flag} must be declared`);
    }
  }
  assert.equal(new Set(SAVE_MODES.map((m) => m.id)).size, SAVE_MODES.length, 'ids are unique');
});

test('a mode writing somewhere else never also writes the originals', () => {
  for (const m of SAVE_MODES) {
    assert.ok(!(m.needsOutDir && m.writesOriginals), `${m.id} cannot do both`);
    // Nothing is destructive without opening the originals for writing.
    assert.ok(!m.destructive || m.writesOriginals, `${m.id} is destructive but writes elsewhere`);
  }
});

test('the safe mode is offered first', () => {
  const [first] = SAVE_MODES;
  assert.equal(first.writesOriginals, false);
  assert.equal(first.destructive, false);
});

test('saveMode refuses an id it does not know', () => {
  assert.equal(saveMode('copy').id, 'copy');
  // A typo must not quietly resolve to anything, least of all the destructive one.
  for (const bad of ['Copy', 'in-place', 'overwrite', '', undefined]) {
    assert.throws(() => saveMode(bad), /unknown save mode/);
  }
});

test('modesFor keeps the declared order, not the backend order', () => {
  const ids = (caps) => modesFor(caps).map((m) => m.id);
  assert.deepEqual(ids({ saveModes: ['inplace', 'copy'] }), ['copy', 'inplace']);
  assert.deepEqual(ids({ saveModes: ['copy'] }), ['copy']);
  assert.deepEqual(ids({ saveModes: [] }), []);
});

test('the ids match the Rust enum they are matched against', () => {
  const src = readFileSync(new URL('../desktop/src/lib.rs', import.meta.url), 'utf8');
  const body = /enum SaveMode \{([^}]*)\}/.exec(src);
  assert.ok(body, 'SaveMode enum not found in desktop/src/lib.rs');

  // serde renames the variants to lowercase; those are the ids on the wire.
  const variants = [...body[1].matchAll(/^\s{4}([A-Z]\w*),/gm)].map((m) => m[1].toLowerCase());
  assert.deepEqual(variants.sort(), SAVE_MODES.map((m) => m.id).sort());
});
