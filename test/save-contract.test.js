/* The save path has one shape: tagged copies into a new folder, sources never
 * opened for writing. These tests guard that, because losing it would mean
 * overwriting someone's originals. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { IMAGE_EXTS, freeName, freeNameIn } from '../app/backend.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const rust = (name) => read(`desktop/src/${name}`);

/** The string literals in a Rust `&[&str]` slice named `name`. */
function extList(src, name) {
  const body = new RegExp(`(?:const )?${name}: &\\[&str\\] = &\\[([^\\]]*)\\]`).exec(src);
  assert.ok(body, `${name} not found`);
  return [...body[1].matchAll(/"([a-z0-9]+)"/g)].map((m) => m[1]).sort();
}

test('the picker, the scanner and the engine agree on which formats exist', () => {
  const scanner = extList(rust('lib.rs'), 'SUPPORTED');
  const engine = extList(read('engine/src/lib.rs'), 'WRITABLE');
  // Offering a format the engine cannot write hands the user a file that is
  // accepted, edited, and then fails at save. Hiding one it can write is
  // invisible: the file simply cannot be chosen, with nothing to say why.
  assert.deepEqual(scanner, [...IMAGE_EXTS].sort());
  assert.deepEqual(scanner, engine);
});

test('saving always needs an output folder', () => {
  const src = rust('lib.rs');
  const sig = /async fn apply_edits\(([^)]*)\)/.exec(src);
  assert.ok(sig, 'apply_edits not found in desktop/src/lib.rs');
  // Not Option<String>: there is no path through the save that writes without
  // one, so the type is what stops a missing folder becoming "edit in place".
  assert.match(sig[1], /out_dir:\s*String/);
  assert.doesNotMatch(sig[1], /Option/);
});

test('nothing in the desktop save path opens a source for writing', () => {
  const lib = rust('lib.rs');
  assert.doesNotMatch(lib, /enum SaveMode/, 'save modes are gone; do not bring them back');
  // Every write goes to a copy made inside the output folder first.
  assert.match(lib, /paths::create_dest\(&out_dir, &src\)/);
  // The scanner still skips `name.ext_original` backups older versions left
  // behind, but nothing writes one any more.
  assert.doesNotMatch(rust('exif.rs'), /_original/);
});

/* ── Output names ──────────────────────────────────────────────── */
/* The web build picks its own output names, so the rule that stops one file
 * landing on another lives in JS and is tested here. The desktop build asks
 * the filesystem instead; `create_dest` in desktop/src/paths.rs is tested by
 * `npm run test:rust`. */

test('freeName steps aside for names already taken', () => {
  const taken = new Set();
  assert.equal(freeName('IMG_1.jpg', taken), 'IMG_1.jpg');
  // A second source holding the same filename must not become the same file.
  assert.equal(freeName('IMG_1.jpg', taken), 'IMG_1 (1).jpg');
  assert.equal(freeName('IMG_1.jpg', taken), 'IMG_1 (2).jpg');
  // Only the final extension is an extension, and a name without one survives.
  assert.equal(freeName('a.b.c.jpg', taken), 'a.b.c.jpg');
  assert.equal(freeName('photo', taken), 'photo');
  assert.equal(freeName('photo', taken), 'photo (1)');
});

/** A directory handle standing in for one the browser hands over. */
const dirWith = (...names) => ({
  async getFileHandle(name) {
    if (names.includes(name)) return { name };
    throw Object.assign(new Error('nope'), { name: 'NotFoundError' });
  },
});

test('freeNameIn never picks a name the folder already holds', async () => {
  // The output folder can be any folder the user typed a name for, including
  // one holding their originals. Overwriting what is in it is the one failure
  // this whole save path exists to prevent.
  const dir = dirWith('IMG_1.jpg', 'IMG_1 (1).jpg');
  assert.equal(await freeNameIn(dir, 'IMG_1.jpg', new Set()), 'IMG_1 (2).jpg');
  assert.equal(await freeNameIn(dir, 'IMG_9.jpg', new Set()), 'IMG_9.jpg');
});

test('freeNameIn also avoids names claimed earlier in the same save', async () => {
  const dir = dirWith();
  const taken = new Set();
  assert.equal(await freeNameIn(dir, 'IMG_1.jpg', taken), 'IMG_1.jpg');
  assert.equal(await freeNameIn(dir, 'IMG_1.jpg', taken), 'IMG_1 (1).jpg');
});

test('freeNameIn treats a refusal it does not understand as "taken"', async () => {
  // A directory of that name, or permission withdrawn: either way, writing
  // there is not something to attempt just because the check was inconclusive.
  const dir = {
    async getFileHandle(name) {
      if (name === 'IMG_1.jpg') throw Object.assign(new Error('is a dir'), { name: 'TypeMismatchError' });
      throw Object.assign(new Error('nope'), { name: 'NotFoundError' });
    },
  };
  assert.equal(await freeNameIn(dir, 'IMG_1.jpg', new Set()), 'IMG_1 (1).jpg');
});
