// Schema-free reader for MBIN table files. It finds the root record list,
// infers the record size, and returns each record's strings: fixed-size inline
// strings (IDs, localisation keys) and out-of-line strings (paths, text) with
// their offset within the record. Callers pick fields by offset or by shape,
// which keeps this working across game updates that reshuffle unrelated fields.

const MARKER = 0xaaaaaa01;
const HEADER_SIZE = 0x20;

const isText = (c) => c >= 0x20 && c < 0x7f;

function header(buf, pos) {
  if (pos + 16 > buf.length || buf.readUInt32LE(pos + 12) !== MARKER) return null;
  const rel = Number(buf.readBigUInt64LE(pos));
  const count = buf.readUInt32LE(pos + 8);
  return { target: pos + rel, count, rel };
}

// An out-of-line string: header points at `count` bytes of text ending in NUL.
function lineString(buf, h) {
  if (!h || h.rel === 0 || h.count < 2 || h.target + h.count > buf.length) return null;
  if (buf[h.target + h.count - 1] !== 0) return null;
  // Allow UTF-8 (bytes >= 0x80) and whitespace in localised text.
  for (let i = h.target; i < h.target + h.count - 1; i++) {
    const c = buf[i];
    if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) return null;
  }
  return buf.toString('utf8', h.target, h.target + h.count - 1);
}

// An inline fixed string starting at a 4-byte boundary, preceded by padding or a header.
function inlineString(buf, pos, end) {
  if (!isText(buf[pos])) return null;
  let i = pos;
  while (i < end && isText(buf[i])) i++;
  if (i === end || buf[i] !== 0 || i - pos < 2) return null;
  return buf.toString('latin1', pos, i);
}

export function readTable(buf) {
  if (buf.readUInt32LE(0) !== 0xcccccccc) throw new Error('Not an MBIN file');
  // Root struct: pick its largest list as the record array.
  let list = null;
  for (let pos = HEADER_SIZE; pos < HEADER_SIZE + 0x200 && pos + 16 <= buf.length; pos += 8) {
    const h = header(buf, pos);
    if (h && h.count > (list?.count ?? 0) && h.target > pos && h.target < buf.length) list = { ...h, at: pos };
  }
  if (!list) throw new Error('No record list found');

  // Out-of-line data is written after the whole array, so the earliest target
  // referenced from inside the array marks its end.
  let end = buf.length;
  for (let pos = list.target; pos < end; pos += 8) {
    const h = header(buf, pos);
    if (h && h.rel > 0 && h.target > pos && h.target < end) end = h.target;
  }
  const span = end - list.target;
  const size = span / list.count;
  if (!Number.isInteger(size) || size % 8 !== 0) throw new Error(`Could not infer record size (${span}/${list.count})`);

  const records = [];
  for (let r = 0; r < list.count; r++) {
    const base = list.target + r * size;
    const strings = [];
    let afterHeader = false;
    for (let off = 0; off < size; off += 4) {
      const pos = base + off;
      const h = off % 8 === 0 ? header(buf, pos) : null;
      if (h) {
        const s = lineString(buf, h);
        if (s !== null) strings.push({ off, s, line: true });
        off += 12;
        afterHeader = true;
        continue;
      }
      if (off > 0 && !afterHeader && buf[pos - 1] !== 0) continue;
      afterHeader = false;
      const s = inlineString(buf, pos, base + size);
      if (s !== null) {
        strings.push({ off, s, line: false });
        off = Math.ceil((off + s.length + 1) / 4) * 4 - 4;
      }
    }
    records.push(strings);
  }
  // buf + start let callers read numeric fields: record r starts at start + r * size.
  return { count: list.count, size, records, buf, start: list.target };
}
