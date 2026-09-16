import test from 'node:test';
import assert from 'node:assert/strict';

import { MULTI, common, mergeDateTime, parseShift, NOON } from '../app/edits.js';

const photo = (fields = {}) => ({
  id: 'p', name: 'p.jpg', datetime: null, offset: null, lat: null, lon: null,
  ...fields,
});

/* ── common ────────────────────────────────────────────────────── */

test('common: agreement, disagreement, emptiness', () => {
  const a = photo({ offset: '+02:00' });
  const b = photo({ offset: '+02:00' });
  const c = photo({ offset: '-05:00' });
  const off = (p) => p.offset;

  assert.equal(common([a, b], off), '+02:00');
  assert.equal(common([a, b, c], off), MULTI);
  assert.equal(common([a], off), '+02:00');
  // No selection has no value, which is not the same as a disagreement.
  assert.equal(common([], off), null);
});

test('common: photos agreeing on null agree', () => {
  assert.equal(common([photo(), photo()], (p) => p.offset), null);
  // ...but null against a value is still a disagreement.
  assert.equal(common([photo(), photo({ offset: '+01:00' })], (p) => p.offset), MULTI);
});

/* ── mergeDateTime ─────────────────────────────────────────────── */

test('mergeDateTime: each half falls back to the photo', () => {
  const p = photo({ datetime: '2021-06-01T08:30:00' });
  assert.equal(mergeDateTime(p, { date: '2022-01-15', time: null }), '2022-01-15T08:30:00');
  assert.equal(mergeDateTime(p, { date: null, time: '23:45:10' }), '2021-06-01T23:45:10');
  assert.equal(mergeDateTime(p, { date: '2022-01-15', time: '23:45:10' }), '2022-01-15T23:45:10');
  // Neither half given leaves the photo where it was.
  assert.equal(mergeDateTime(p, { date: null, time: null }), p.datetime);
});

test('mergeDateTime: an undated photo seeds from its file timestamp at noon', () => {
  const p = photo({ file_modified: '2019-03-04T17:02:11' });
  assert.equal(mergeDateTime(p, { date: null, time: null }), `2019-03-04T${NOON}`);
  assert.equal(mergeDateTime(p, { date: '2020-12-25', time: null }), `2020-12-25T${NOON}`);
  assert.equal(mergeDateTime(p, { date: null, time: '06:00:00' }), '2019-03-04T06:00:00');
});

test('mergeDateTime: an undated photo with no file timestamp seeds from today', () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(mergeDateTime(photo(), { date: null, time: null }), `${today}T${NOON}`);
});

test('mergeDateTime: years below 100 survive the round trip', () => {
  // Date.UTC folds years 0–99 into 1900–1999; a photo dated in year 12 must
  // come back as year 12, not 1912.
  const p = photo({ datetime: '0012-05-06T01:02:03' });
  assert.equal(mergeDateTime(p, { date: null, time: '04:05:06' }), '0012-05-06T04:05:06');
  assert.equal(mergeDateTime(photo(), { date: '0099-01-01', time: '00:00:00' }), '0099-01-01T00:00:00');
});

/* ── parseShift ────────────────────────────────────────────────── */

test('parseShift: the unit form', () => {
  assert.equal(parseShift('+3h47m'), 3 * 3600 + 47 * 60);
  assert.equal(parseShift('3h47m'), 3 * 3600 + 47 * 60);
  assert.equal(parseShift('-15s'), -15);
  assert.equal(parseShift('1d 2h'), 86400 + 7200);
  assert.equal(parseShift('1d2h3m4s'), 86400 + 7200 + 180 + 4);
  assert.equal(parseShift('2H'), 7200);
});

test('parseShift: the clock form', () => {
  assert.equal(parseShift('-0:15'), -15 * 60);
  assert.equal(parseShift('1:30'), 90 * 60);
  assert.equal(parseShift('0:01:30'), 90);
  assert.equal(parseShift('-2:00:30'), -(2 * 3600 + 30));
});

test('parseShift: the sign covers the whole amount', () => {
  assert.equal(parseShift('-1d2h'), -(86400 + 7200));
  assert.equal(parseShift('-1:30:30'), -(3600 + 30 * 60 + 30));
  // A minus typed as a unicode dash, which is what some keyboards produce.
  assert.equal(parseShift('−15s'), -15);
});

test('parseShift: whitespace anywhere is ignored', () => {
  assert.equal(parseShift('  + 3 h 47 m '), 3 * 3600 + 47 * 60);
});

test('parseShift: zero is a readable amount, not a failure', () => {
  assert.equal(parseShift('0s'), 0);
  assert.equal(parseShift('0:00'), 0);
});

test('parseShift: unreadable input is null', () => {
  for (const bad of ['', '   ', '+', '-', 'h', 'abc', '3x', '1:2:3:4', '3h47', '--5s', '1:70:00x']) {
    assert.equal(parseShift(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});
