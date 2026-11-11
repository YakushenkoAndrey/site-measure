import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLength, formatLength, formatPlain, applyKey } from '../units.js';

test('parser: examples from the spec table', () => {
  const ok = {
    '48': 48,
    '48 3/8': 48.375,
    '3/8': 0.375,
    "12'": 144,
    "12' 4 1/2": 148.5,
    "12'4": 148,
    '48.5': 48.5,
    '48 4/16': 48.25,
  };
  for (const [input, value] of Object.entries(ok)) {
    assert.deepEqual(parseLength(input), { value, error: false }, input);
  }
  assert.deepEqual(parseLength(''), { value: null, error: false });
  assert.deepEqual(parseLength('   '), { value: null, error: false });
  for (const bad of ['48 3/0', 'abc', '1/2/3', "'", '"', '48 3', "1' 2' 3"]) {
    assert.equal(parseLength(bad).error, true, bad);
    assert.equal(parseLength(bad).value, null, bad);
  }
});

test('parser: extra forms', () => {
  assert.equal(parseLength('48"').value, 48);
  assert.equal(parseLength("12' 1/2").value, 144.5);
  assert.equal(parseLength('.5').value, 0.5);
  assert.equal(parseLength('48.').value, 48);
  assert.equal(parseLength(' 30 1/2 ').value, 30.5);
});

test('format: spec examples', () => {
  assert.equal(formatLength(48.375), '48 3/8"');
  assert.equal(formatLength(0.0625), '1/16"');
  assert.equal(formatLength(47.999, 16), '48"');
  assert.equal(formatLength(96), '96"');
  assert.equal(formatLength(0.25), '1/4"');
  assert.equal(formatLength(48.25), '48 1/4"');
  assert.equal(formatLength(148.5), '148 1/2"');
  assert.equal(formatLength(0), '0"');
  assert.equal(formatLength(null), '');
});

test('format: precision 1/8 rounds and reduces', () => {
  assert.equal(formatLength(0.0625, 8), '1/8"'); // 0.5/8 rounds up
  assert.equal(formatLength(48.4375, 8), '48 1/2"'); // 7/16 -> 3.5/8 -> 4/8 = 1/2
  assert.equal(formatLength(48.375, 8), '48 3/8"');
  assert.equal(formatLength(47.95, 8), '48"');
  assert.equal(formatLength(10.75, 8), '10 3/4"');
  assert.equal(formatLength(10.5625, 16), '10 9/16"');
  assert.equal(formatLength(10.5625, 8), '10 5/8"');
});

test('format: plain text round-trips through the parser', () => {
  for (const v of [0.0625, 1, 48.375, 148.5, 239.9375]) {
    assert.equal(parseLength(formatPlain(v)).value, v);
  }
});

test('keypad: fraction replaces the typed fraction', () => {
  let t = '';
  for (const k of ['4', '8']) t = applyKey(t, k);
  assert.equal(t, '48');
  t = applyKey(t, '3/8');
  assert.equal(t, '48 3/8');
  t = applyKey(t, '1/2');
  assert.equal(t, '48 1/2');
  t = applyKey(t, '5'); // digits after a fraction are ignored
  assert.equal(t, '48 1/2');
  t = applyKey(t, 'back'); // removes the whole fraction
  assert.equal(t, '48');
  assert.equal(applyKey('', '3/8'), '3/8');
  assert.equal(applyKey('48', 'clear'), '');
});

test('keypad: feet, decimal point, backspace', () => {
  let t = '';
  for (const k of ['1', '2', "'", '4', '1/2']) t = applyKey(t, k);
  assert.equal(t, "12' 4 1/2");
  assert.equal(parseLength(t).value, 148.5);
  assert.equal(applyKey("12'", "'"), "12'");
  assert.equal(applyKey('', "'"), '');
  assert.equal(applyKey('48', '.'), '48.');
  assert.equal(applyKey('48.5', '.'), '48.5');
  assert.equal(applyKey('', '.'), '0.');
  assert.equal(applyKey('48', 'back'), '4');
  assert.equal(applyKey("12' 4", 'back'), "12'");
});
