// NMS .hg save codec: a sequence of chunks, each a 16-byte header
// (magic, compressed size, decompressed size, padding) followed by an
// LZ4 block. Chunks decompress to at most 512 KiB of the JSON text.

export const MAGIC = 0xfeeda1e5;
export const CHUNK_SIZE = 0x80000;

export function isCompressed(buf) {
  return buf.length >= 16 && buf.readUInt32LE(0) === MAGIC;
}

export function decodeSave(buf) {
  if (!isCompressed(buf)) return { text: stripNull(buf.toString('latin1')), compressed: false, chunks: 0 };
  const parts = [];
  let off = 0;
  let chunks = 0;
  while (off < buf.length) {
    if (buf.readUInt32LE(off) !== MAGIC) throw new Error(`Bad chunk magic at offset ${off}`);
    const csize = buf.readUInt32LE(off + 4);
    const dsize = buf.readUInt32LE(off + 8);
    off += 16;
    const out = lz4DecompressBlock(buf.subarray(off, off + csize), dsize);
    if (out.length !== dsize) throw new Error(`Chunk ${chunks} decompressed to ${out.length}, expected ${dsize}`);
    parts.push(out);
    off += csize;
    chunks++;
  }
  return { text: stripNull(Buffer.concat(parts).toString('latin1')), compressed: true, chunks };
}

export function encodeSave(text, { compressed = true } = {}) {
  const raw = Buffer.concat([Buffer.from(text, 'latin1'), Buffer.from([0])]);
  if (!compressed) return raw;
  const out = [];
  for (let off = 0; off < raw.length; off += CHUNK_SIZE) {
    const src = raw.subarray(off, off + CHUNK_SIZE);
    const block = lz4CompressBlock(src);
    const header = Buffer.alloc(16);
    header.writeUInt32LE(MAGIC, 0);
    header.writeUInt32LE(block.length, 4);
    header.writeUInt32LE(src.length, 8);
    out.push(header, block);
  }
  return Buffer.concat(out);
}

function stripNull(s) {
  const i = s.indexOf('\0');
  return i === -1 ? s : s.slice(0, i);
}

export function lz4DecompressBlock(src, maxOut) {
  const dst = Buffer.alloc(maxOut);
  let s = 0;
  let d = 0;
  while (s < src.length) {
    const token = src[s++];
    let lit = token >> 4;
    if (lit === 15) {
      let b;
      do { b = src[s++]; lit += b; } while (b === 255);
    }
    src.copy(dst, d, s, s + lit);
    s += lit;
    d += lit;
    if (s >= src.length) break;
    const offset = src[s] | (src[s + 1] << 8);
    s += 2;
    if (offset === 0 || offset > d) throw new Error('Corrupt LZ4 block: bad match offset');
    let len = token & 15;
    if (len === 15) {
      let b;
      do { b = src[s++]; len += b; } while (b === 255);
    }
    len += 4;
    // Byte-wise copy: matches may overlap their own output.
    for (let i = 0; i < len; i++, d++) dst[d] = dst[d - offset];
  }
  return dst.subarray(0, d);
}

// Greedy hash-chain-free LZ4 block compressor. Follows the spec's end-of-block
// rules: the last 5 bytes are literals and no match starts within 12 bytes of the end.
export function lz4CompressBlock(src) {
  const n = src.length;
  const out = Buffer.alloc(n + Math.ceil(n / 255) + 16);
  const table = new Int32Array(1 << 16).fill(-1);
  const hash = (i) => (Math.imul(src.readUInt32LE(i), 2654435761) >>> 16);
  let o = 0;
  let anchor = 0;
  let i = 0;
  const matchLimit = n - 12;

  const writeLen = (len) => {
    while (len >= 255) { out[o++] = 255; len -= 255; }
    out[o++] = len;
  };
  const emit = (litEnd, matchLen, offset) => {
    const lit = litEnd - anchor;
    const tokenPos = o++;
    let token = (lit >= 15 ? 15 : lit) << 4;
    if (lit >= 15) writeLen(lit - 15);
    src.copy(out, o, anchor, litEnd);
    o += lit;
    if (matchLen > 0) {
      out[o++] = offset & 255;
      out[o++] = offset >> 8;
      const ml = matchLen - 4;
      token |= ml >= 15 ? 15 : ml;
      if (ml >= 15) writeLen(ml - 15);
    }
    out[tokenPos] = token;
  };

  while (i < matchLimit) {
    const h = hash(i);
    const ref = table[h];
    table[h] = i;
    if (ref >= 0 && i - ref <= 0xffff && src.readUInt32LE(ref) === src.readUInt32LE(i)) {
      let len = 4;
      const maxLen = n - 5 - i;
      while (len < maxLen && src[ref + len] === src[i + len]) len++;
      emit(i, len, i - ref);
      i += len;
      anchor = i;
    } else {
      i++;
    }
  }
  emit(n, 0, 0);
  return out.subarray(0, o);
}
