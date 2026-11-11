// Inch lengths with fractions: parsing, formatting and on-screen keypad editing.
// Values are stored as decimal inches (number) or null when not filled in.

const NUM = String.raw`(\d+(?:\.\d*)?|\.\d+)`;
const FRAC = String.raw`(\d+)\s*\/\s*(\d+)`;
// [feet '] [inches [fraction] | fraction] ["]
const RE = new RegExp(
  String.raw`^(?:${NUM}\s*')?\s*(?:${NUM}(?:\s+${FRAC})?|${FRAC})?\s*"?$`
);

/**
 * Parse user input into decimal inches.
 * @returns {{value: number|null, error: boolean}}
 */
export function parseLength(input) {
  const s = String(input ?? '').trim();
  if (s === '') return { value: null, error: false };
  const m = RE.exec(s);
  if (!m) return { value: null, error: true };
  const [, feet, inches, num1, den1, num2, den2] = m;
  if (feet === undefined && inches === undefined && num2 === undefined) {
    return { value: null, error: true };
  }
  let total = 0;
  if (feet !== undefined) total += parseFloat(feet) * 12;
  if (inches !== undefined) total += parseFloat(inches);
  const num = num1 ?? num2;
  const den = den1 ?? den2;
  if (num !== undefined) {
    const d = parseInt(den, 10);
    if (d === 0) return { value: null, error: true };
    total += parseInt(num, 10) / d;
  }
  if (!Number.isFinite(total)) return { value: null, error: true };
  return { value: total, error: false };
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Split inches into whole + reduced fraction at the given precision (16 or 8). */
export function toFraction(value, precision = 16) {
  const neg = value < 0;
  const n = Math.round(Math.abs(value) * precision);
  const whole = Math.floor(n / precision);
  let num = n % precision;
  let den = precision;
  if (num) {
    const g = gcd(num, den);
    num /= g;
    den /= g;
  }
  return { neg: neg && n !== 0, whole, num, den };
}

/** Text without the inch mark, e.g. "48 3/8", "1/4", "96". */
export function formatPlain(value, precision = 16) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  const { neg, whole, num, den } = toFraction(value, precision);
  let out;
  if (num === 0) out = String(whole);
  else if (whole === 0) out = `${num}/${den}`;
  else out = `${whole} ${num}/${den}`;
  return (neg ? '-' : '') + out;
}

/** Display text with the inch mark, e.g. 48.375 -> `48 3/8"`. */
export function formatLength(value, precision = 16) {
  const p = formatPlain(value, precision);
  return p === '' ? '' : p + '"';
}

export const EIGHTHS = ['1/8', '1/4', '3/8', '1/2', '5/8', '3/4', '7/8'];
export const SIXTEENTHS = ['1/16', '3/16', '5/16', '7/16', '9/16', '11/16', '13/16', '15/16'];

const TRAILING_FRAC = /\s*\d+\/\d+$/;

/**
 * Apply a keypad key to the typed text.
 * Keys: '0'..'9', "'", '.', 'back', 'clear', or a fraction like '3/8'.
 * A fraction replaces an already typed fraction instead of adding a second one.
 */
export function applyKey(text, key) {
  text = text ?? '';
  if (key === 'clear') return '';
  if (key === 'back') {
    if (TRAILING_FRAC.test(text)) return text.replace(TRAILING_FRAC, '');
    return text.slice(0, -1).replace(/\s+$/, '');
  }
  if (/^\d+\/\d+$/.test(key)) {
    const base = text.replace(TRAILING_FRAC, '').trimEnd();
    if (base.endsWith('.')) return text; // "48." + fraction makes no sense
    return base === '' ? key : `${base} ${key}`;
  }
  if (TRAILING_FRAC.test(text)) return text; // nothing may follow a fraction
  if (/^\d$/.test(key)) {
    if (text.endsWith("'")) return `${text} ${key}`;
    return text + key;
  }
  if (key === '.') {
    const lastNum = /(\d*\.?\d*)$/.exec(text)[1];
    if (lastNum.includes('.')) return text;
    if (text.endsWith("'")) return `${text} 0.`;
    return text + (lastNum === '' ? '0.' : '.');
  }
  if (key === "'") {
    if (text.includes("'") || !/\d\.?$/.test(text)) return text;
    return text.replace(/\.$/, '') + "'";
  }
  return text;
}
