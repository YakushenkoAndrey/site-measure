import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWall, wallHasErrors, overlapArea } from '../validate.js';

const op = (x, y, w, h) => ({ id: 'o', type: 'window', x, y, w, h });
const wall = (openings, width = 240, height = 120) => ({ width, height, openings });
const codes = (errs) => errs.map((e) => e.code);

test('valid opening inside the wall', () => {
  const r = validateWall(wall([op(36, 30.5, 48, 60)]));
  assert.deepEqual(r, [[]]);
  assert.equal(wallHasErrors(wall([op(36, 30.5, 48, 60)])), false);
});

test('opening touching the wall edges is valid', () => {
  assert.deepEqual(validateWall(wall([op(0, 0, 240, 120)])), [[]]);
});

test('outside the wall on every side', () => {
  for (const o of [op(-1, 0, 10, 10), op(0, -1, 10, 10), op(235, 0, 10, 10), op(0, 115, 10, 10)]) {
    const r = validateWall(wall([o]));
    assert.deepEqual(codes(r[0]), ['outside']);
    assert.equal(r[0][0].text, 'Выходит за стену');
  }
});

test('overlap is reported on both openings with numbers', () => {
  const r = validateWall(wall([op(10, 10, 40, 40), op(30, 30, 40, 40)]));
  assert.equal(r[0][0].text, 'Перекрывается с проёмом 2');
  assert.equal(r[1][0].text, 'Перекрывается с проёмом 1');
});

test('touching edges and corners is not an overlap', () => {
  assert.deepEqual(validateWall(wall([op(10, 10, 40, 40), op(50, 10, 40, 40)])), [[], []]);
  assert.deepEqual(validateWall(wall([op(10, 10, 40, 40), op(50, 50, 40, 40)])), [[], []]);
  assert.deepEqual(validateWall(wall([op(10, 10, 40, 40), op(10, 50, 40, 40)])), [[], []]);
  assert.equal(overlapArea(op(0, 0, 10, 10), op(10, 0, 10, 10)), 0);
});

test('zero size', () => {
  assert.deepEqual(codes(validateWall(wall([op(10, 10, 0, 40)]))[0]), ['zero']);
  assert.deepEqual(codes(validateWall(wall([op(10, 10, 40, -2)]))[0]), ['zero']);
});

test('empty fields are not errors', () => {
  const r = validateWall(wall([op(null, null, null, null), op(10, null, 40, null)]));
  assert.deepEqual(r, [[], []]);
  // incomplete openings never overlap
  assert.deepEqual(validateWall(wall([op(10, 10, 40, 40), op(10, null, 40, 40)])), [[], []]);
  // wall size unknown: only the checks that have their data
  assert.deepEqual(validateWall({ width: null, height: null, openings: [op(500, 500, 40, 40)] }), [[]]);
  assert.deepEqual(codes(validateWall({ width: null, height: null, openings: [op(-5, 0, 4, 4)] })[0]), ['outside']);
});

test('no openings', () => {
  assert.deepEqual(validateWall({ width: 100, height: 100, openings: [] }), []);
});
