// Asking Claude to find the edges to measure on a site photo, and cleaning up its answer.

export const EDGE_LABELS = ['ширина', 'высота', 'глубина', 'длина', 'толщина', 'другое'];

/** Prompt for one photo. `planeNames` are surfaces already named in this project. */
export function buildPrompt(planeNames = []) {
  const known = planeNames.length
    ? `Surfaces already named in this project (reuse a name exactly when this photo shows the same surface): ${planeNames.map((n) => JSON.stringify(n)).join(', ')}.`
    : 'No surfaces are named in this project yet.';
  return [
    'You help a facade installer take site measurements. The attached photo shows part of a building under construction:',
    'for example an entrance canopy, a column, a wall, a soffit, plywood sheathing or framing that will receive cladding.',
    '',
    'Find the flat surfaces (planes) that will be clad and mark the straight physical edges the installer must measure with a tape:',
    'for each surface its full width or length and its height or depth, plus edges of notable features on it',
    '(openings, light fixtures, returns, steps, sills, gaps to the slab).',
    '',
    'Rules:',
    '- Each edge runs exactly along a visible physical edge or corner line in the image, from one real corner to the other.',
    '- Coordinates use a 0-1000 grid over the whole image: x from the left edge, y from the top edge.',
    '- Mark 4 to 20 edges, the most useful first. Skip people, ladders, tools, hoses, siding ribs, trees and the background.',
    '- One edge per physical measurement: do not mark the same edge twice.',
    `- ${known}`,
    '',
    'Reply with only this JSON, no other text:',
    '{"planes":[{"name":"<short Russian name of the surface, e.g. Фасция козырька>","edges":[',
    `{"label":"<one of: ${EDGE_LABELS.join(', ')}>","note":"<optional short Russian hint, may be empty>","x1":0,"y1":0,"x2":0,"y2":0}]}]}`,
  ].join('\n');
}

const num = (v) => (typeof v === 'number' ? v : parseFloat(v));
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * Turn Claude's JSON into edges for a photo document.
 * Coordinates become 0..1; bad, tiny and duplicate edges are dropped.
 * @returns {Array<{id, plane, label, note, x1, y1, x2, y2, value: null, src: 'ai'}>}
 */
export function normalizeEdges(answer, makeId) {
  const out = [];
  const planes = Array.isArray(answer?.planes) ? answer.planes : [];
  for (const p of planes) {
    const plane = String(p?.name ?? '').trim().slice(0, 60) || 'Поверхность';
    for (const e of Array.isArray(p?.edges) ? p.edges : []) {
      const c = ['x1', 'y1', 'x2', 'y2'].map((k) => num(e?.[k]));
      if (c.some((v) => !Number.isFinite(v))) continue;
      // Accept 0..1 as well as the requested 0..1000 grid
      const scale = c.every((v) => v <= 1.5) ? 1 : 1000;
      const [x1, y1, x2, y2] = c.map((v) => clamp01(v / scale));
      if (Math.hypot(x2 - x1, y2 - y1) < 0.02) continue;
      const dup = out.some(
        (o) =>
          (Math.hypot(o.x1 - x1, o.y1 - y1) < 0.015 && Math.hypot(o.x2 - x2, o.y2 - y2) < 0.015) ||
          (Math.hypot(o.x1 - x2, o.y1 - y2) < 0.015 && Math.hypot(o.x2 - x1, o.y2 - y1) < 0.015)
      );
      if (dup) continue;
      const label = EDGE_LABELS.includes(e?.label) ? e.label : 'другое';
      out.push({ id: makeId(), plane, label, note: String(e?.note ?? '').trim().slice(0, 80), x1, y1, x2, y2, value: null, src: 'ai' });
      if (out.length >= 30) return out;
    }
  }
  return out;
}

/** Russian copy for a failed sample() call. */
export function aiErrorText(code) {
  switch (code) {
    case 'not_granted':
      return 'Нет разрешения на Claude. Разрешите его в меню страницы и нажмите «Разметить снова».';
    case 'rate_limited':
      return 'Слишком много запросов. Подождите минуту и нажмите «Разметить снова».';
    case 'session_expired':
      return 'Нужно заново войти в claude.ai.';
    case 'image_rejected':
      return 'Claude не принял это фото. Попробуйте другое.';
    case 'invalid_json':
    case 'empty_completion':
      return 'Claude ответил непонятно. Нажмите «Разметить снова».';
    case 'sampling_disabled':
    case 'images_unavailable':
    case 'capability_disabled':
      return 'Разметка через Claude здесь недоступна. Рёбра можно добавить вручную.';
    default:
      return 'Не удалось связаться с Claude. Нажмите «Разметить снова».';
  }
}
