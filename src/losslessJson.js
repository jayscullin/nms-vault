// Byte-exact JSON round-tripping for NMS saves.
//
// - Text is handled as latin1 (one char per byte) because some string values
//   contain raw bytes that are not valid UTF-8; decoding as UTF-8 would corrupt them.
// - Numbers whose source text differs from JS's formatting (e.g. "1.0", "4.47e-8")
//   are kept as JSON.rawJSON so they serialize exactly as read.
// - NMS writes \u escapes with uppercase hex; JSON.stringify uses lowercase.

const reviver = (_key, value, ctx) =>
  typeof value === 'number' && ctx?.source !== String(value) ? JSON.rawJSON(ctx.source) : value;

export function parse(text) {
  return JSON.parse(text, reviver);
}

// Matches \uXXXX escapes that are real escapes (preceded by an even number of backslashes).
const LOWER_ESCAPE = /(?<!\\)((?:\\\\)*)\\u([0-9a-f]{4})/g;

export function stringify(value) {
  return JSON.stringify(value).replace(LOWER_ESCAPE, (_m, bs, hex) => `${bs}\\u${hex.toUpperCase()}`);
}

// Read a number regardless of whether it is a plain number or a rawJSON wrapper.
export function num(v) {
  return JSON.isRawJSON?.(v) ? Number(v.rawJSON) : v;
}

// Write a number, preserving NMS's float formatting when the original was a float literal.
export function setNum(original, n) {
  if (JSON.isRawJSON?.(original) && /^-?\d+\.\d+$/.test(original.rawJSON) && Number.isInteger(n)) {
    return JSON.rawJSON(`${n}.0`);
  }
  return n;
}

// Latin1 holds UTF-8 bytes; convert for display and back for writing.
export const toDisplay = (s) => Buffer.from(s, 'latin1').toString('utf8');
export const fromDisplay = (s) => Buffer.from(s, 'utf8').toString('latin1');
