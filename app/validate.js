// Opening checks. Errors are only highlighted; they never block saving or export.

const EPS = 1e-6;
const has = (v) => typeof v === 'number' && Number.isFinite(v);

/** True when the opening has all four values. */
export function isComplete(o) {
  return has(o.x) && has(o.y) && has(o.w) && has(o.h);
}

/**
 * Validate all openings of a wall.
 * @returns {Array<Array<{code: string, text: string, other?: number}>>}
 *   errors per opening, same order as wall.openings. `other` is the 1-based number
 *   of the overlapping opening.
 */
export function validateWall(wall) {
  const W = wall.width;
  const H = wall.height;
  const list = wall.openings || [];
  const result = list.map(() => []);

  list.forEach((o, i) => {
    const errs = result[i];
    let outside = false;
    if (has(o.x) && o.x < -EPS) outside = true;
    if (has(o.y) && o.y < -EPS) outside = true;
    if (has(o.x) && has(o.w) && has(W) && o.x + o.w > W + EPS) outside = true;
    if (has(o.y) && has(o.h) && has(H) && o.y + o.h > H + EPS) outside = true;
    if (outside) errs.push({ code: 'outside', text: 'Выходит за стену' });
    if ((has(o.w) && o.w <= EPS) || (has(o.h) && o.h <= EPS)) {
      errs.push({ code: 'zero', text: 'Нулевой размер' });
    }
  });

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (overlapArea(list[i], list[j]) > EPS) {
        result[i].push({ code: 'overlap', other: j + 1, text: `Перекрывается с проёмом ${j + 1}` });
        result[j].push({ code: 'overlap', other: i + 1, text: `Перекрывается с проёмом ${i + 1}` });
      }
    }
  }
  return result;
}

/** Intersection area of two complete openings; 0 if incomplete or only touching. */
export function overlapArea(a, b) {
  if (!isComplete(a) || !isComplete(b)) return 0;
  const dx = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const dy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return dx > 0 && dy > 0 ? dx * dy : 0;
}

export function wallHasErrors(wall) {
  return validateWall(wall).some((e) => e.length > 0);
}
