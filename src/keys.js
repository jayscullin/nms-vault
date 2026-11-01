// Reversible key (de)obfuscation, applied to the raw JSON text before parsing.
//
// Doing it at the text level keeps key order intact: JS objects hoist
// integer-like keys (e.g. "397") to the front, which would reorder the save.
// Encoded key forms:
//   Name        mapped key with a unique name
//   Name~obf    mapped key whose name is shared with other keys
//   ~obf        unmapped key that is integer-like, contains "~", or collides with a name
//   obf         any other unmapped key

import fs from 'node:fs';

export function loadMapping(path) {
  const { Mapping, libMBIN_version } = JSON.parse(fs.readFileSync(path, 'utf8'));
  const nameCount = new Map();
  const forward = new Map();
  for (const { Key, Value } of Mapping) {
    if (forward.has(Key)) continue;
    forward.set(Key, Value);
    nameCount.set(Value, (nameCount.get(Value) ?? 0) + 1);
  }
  const decodeMap = new Map();
  const encodeMap = new Map();
  for (const [obf, name] of forward) {
    const enc = nameCount.get(name) === 1 ? name : `${name}~${obf}`;
    decodeMap.set(obf, enc);
    encodeMap.set(enc, obf);
  }
  return { decodeMap, encodeMap, version: libMBIN_version };
}

const needsEscape = (raw, encodeMap) => /^\d+$/.test(raw) || raw.includes('~') || encodeMap.has(raw);

export function decodeKey(raw, { decodeMap, encodeMap }) {
  return decodeMap.get(raw) ?? (needsEscape(raw, encodeMap) ? `~${raw}` : raw);
}

export function encodeKey(enc, { encodeMap }) {
  const mapped = encodeMap.get(enc);
  if (mapped !== undefined) return mapped;
  const i = enc.indexOf('~');
  return i === -1 ? enc : enc.slice(i + 1);
}

// Rewrites every object key in compact or pretty JSON text. Values are copied verbatim.
export function transformKeys(text, fn) {
  const out = [];
  let last = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text.charCodeAt(i) !== 34 /* " */) { i++; continue; }
    const start = i++;
    let hasEscape = false;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 92 /* \ */) { hasEscape = true; i += 2; continue; }
      if (c === 34) break;
      i++;
    }
    const end = i++; // index of closing quote
    let j = i;
    while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 10 || text.charCodeAt(j) === 13 || text.charCodeAt(j) === 9)) j++;
    if (text.charCodeAt(j) !== 58 /* : */) continue;
    const raw = text.slice(start + 1, end);
    const key = hasEscape ? JSON.parse(`"${raw}"`) : raw;
    const next = fn(key);
    if (next !== key) {
      out.push(text.slice(last, start), JSON.stringify(next));
      last = end + 1;
    }
  }
  out.push(text.slice(last));
  return out.join('');
}

export const deobfuscate = (text, mapping) => transformKeys(text, (k) => decodeKey(k, mapping));
export const obfuscate = (text, mapping) => transformKeys(text, (k) => encodeKey(k, mapping));
