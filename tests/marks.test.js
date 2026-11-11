import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newMark, markLabel, distToSegment, hitMark, hitHandle, isTiny, clampPoint, drawMarks, markSegments } from '../marks.js';

const mk = (type, x1, y1, x2, y2, extra = {}) => ({ ...newMark(type, x1, y1, '#f00', type + x1), x2, y2, ...extra });

test('new marks', () => {
  const d = newMark('dim', 0.2, 0.3);
  assert.equal(d.type, 'dim');
  assert.equal(d.value, null);
  assert.deepEqual([d.x1, d.y1, d.x2, d.y2], [0.2, 0.3, 0.2, 0.3]);
  assert.equal('value' in newMark('rect', 0, 0), false);
});

test('dimension label', () => {
  assert.equal(markLabel(mk('dim', 0, 0, 1, 1, { value: 48.375 })), '48 3/8"');
  assert.equal(markLabel(mk('dim', 0, 0, 1, 1, { value: 48.4375 }), 8), '48 1/2"');
  assert.equal(markLabel(mk('dim', 0, 0, 1, 1)), '?');
  assert.equal(markLabel(mk('line', 0, 0, 1, 1)), '');
});

test('distance to segment', () => {
  const a = { x: 0, y: 0 }, b = { x: 10, y: 0 };
  assert.equal(distToSegment({ x: 5, y: 3 }, a, b), 3);
  assert.equal(distToSegment({ x: -4, y: 3 }, a, b), 5); // beyond the end
  assert.equal(distToSegment({ x: 1, y: 1 }, a, a), Math.SQRT2); // degenerate
});

test('rect has four sides', () => {
  const segs = markSegments(mk('rect', 0.1, 0.1, 0.5, 0.5), 100, 200);
  assert.equal(segs.length, 4);
  assert.deepEqual(segs[0], [{ x: 10, y: 20 }, { x: 50, y: 20 }]);
});

test('hit testing picks the nearest, topmost mark', () => {
  const line = mk('line', 0, 0.5, 1, 0.5);
  const rect = mk('rect', 0.2, 0.2, 0.8, 0.8);
  const marks = [line, rect];
  assert.equal(hitMark(marks, { x: 50, y: 52 }, 5, 100, 100), line);
  assert.equal(hitMark(marks, { x: 20, y: 40 }, 5, 100, 100), rect); // left side of rect
  assert.equal(hitMark(marks, { x: 50, y: 30 }, 5, 100, 100), null); // inside rect, far from edges
  // same distance: later (top) mark wins
  const l2 = mk('line', 0, 0.5, 1, 0.5);
  assert.equal(hitMark([line, l2], { x: 50, y: 50 }, 5, 100, 100), l2);
});

test('handles and tiny marks', () => {
  const m = mk('dim', 0.1, 0.1, 0.9, 0.1);
  assert.equal(hitHandle(m, { x: 12, y: 11 }, 5, 100, 100), '1');
  assert.equal(hitHandle(m, { x: 88, y: 10 }, 5, 100, 100), '2');
  assert.equal(hitHandle(m, { x: 50, y: 10 }, 5, 100, 100), null);
  assert.equal(isTiny(mk('line', 0.5, 0.5, 0.51, 0.5), 100, 100, 3), true);
  assert.equal(isTiny(mk('line', 0.5, 0.5, 0.6, 0.5), 100, 100, 3), false);
  assert.deepEqual(clampPoint(-0.2, 1.4), { x: 0, y: 1 });
});

test('drawMarks issues strokes and the dimension label', () => {
  const calls = [];
  const ctx = new Proxy(
    { measureText: (t) => ({ width: t.length * 10 }) },
    {
      get(target, k) {
        if (k in target) return target[k];
        return (...args) => calls.push([k, ...args]);
      },
      set(target, k, v) {
        target[k] = v;
        return true;
      },
    }
  );
  drawMarks(ctx, [mk('dim', 0, 0.5, 1, 0.5, { value: 96 }), mk('rect', 0.1, 0.1, 0.2, 0.2)], { iw: 200, ih: 100, lineW: 4, fontPx: 20 });
  assert.equal(calls.filter((c) => c[0] === 'stroke').length, 4); // shadow + main for each mark
  assert.deepEqual(calls.find((c) => c[0] === 'fillText'), ['fillText', '96"', 100, 28]);
  assert.deepEqual(calls.find((c) => c[0] === 'rect'), ['rect', 20, 10, 20, 10]);
});
