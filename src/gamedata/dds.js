// DDS texture decoding (BC1, BC3, BC7, uncompressed RGBA) and a minimal PNG encoder,
// enough to turn the game's UI icons into images a browser can show.

import zlib from 'node:zlib';

// ---- BC7 tables (D3D11 spec) -------------------------------------------------

// Two-subset partitions: bit i set means pixel i belongs to subset 1.
const P2 = [
  0xcccc, 0x8888, 0xeeee, 0xecc8, 0xc880, 0xfeec, 0xfec8, 0xec80, 0xc800, 0xffec, 0xfe80, 0xe800, 0xffe8, 0xff00, 0xfff0, 0xf000,
  0xf710, 0x008e, 0x7100, 0x08ce, 0x008c, 0x7310, 0x3100, 0x8cce, 0x088c, 0x3110, 0x6666, 0x366c, 0x17e8, 0x0ff0, 0x718e, 0x399c,
  0xaaaa, 0xf0f0, 0x5a5a, 0x33cc, 0x3c3c, 0x55aa, 0x9696, 0xa55a, 0x73ce, 0x13c8, 0x324c, 0x3bdc, 0x6996, 0xc33c, 0x9966, 0x0660,
  0x0272, 0x04e4, 0x4e40, 0x2720, 0xc936, 0x936c, 0x39c6, 0x639c, 0x9336, 0x9cc6, 0x817e, 0xe718, 0xccf0, 0x0fcc, 0x7744, 0xee22,
];

const P3 = [
  '0011001102212222', '0001001122112221', '0000200122112211', '0222002200110111', '0000000011221122', '0011001100220022', '0022002211111111', '0011001122112211',
  '0000000011112222', '0000111111112222', '0000111122222222', '0012001200120012', '0112011201120112', '0122012201220122', '0011011211221222', '0011200122002220',
  '0001001101121122', '0111001120012200', '0000112211221122', '0022002200221111', '0111011102220222', '0001000122212221', '0000001101220122', '0000110022102210',
  '0122012200110000', '0012001211222222', '0110122112210110', '0000011012211221', '0022110211020022', '0110011020022222', '0011012201220011', '0000200022112221',
  '0000000211221222', '0222002200120011', '0011001200220222', '0120012001200120', '0000111122220000', '0120120120120120', '0120201212010120', '0011220011220011',
  '0011112222000011', '0101010122222222', '0000000021212121', '0022112200221122', '0022001100220011', '0220122102201221', '0101222222220101', '0000212121212121',
  '0101010101012222', '0222011102220111', '0002111200021112', '0000211221122112', '0222011101110222', '0002111211120002', '0110011001102222', '0000000021122112',
  '0110011022222222', '0022001100110022', '0022112211220022', '0000000000002112', '0002000100020001', '0222122202221222', '0101222222222222', '0111201122012220',
].map((row) => [...row].map(Number));

const ANCHOR2 = [
  15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2,
  15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6, 6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15,
];
const ANCHOR3A = [
  3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3, 3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5, 15, 15,
  8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15, 15, 15, 3, 15, 5, 5, 5, 8, 5, 10, 5, 10, 8, 13, 15, 12, 3, 3,
];
const ANCHOR3B = [
  15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8, 15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6, 10, 15, 15, 10, 8,
  15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8, 15, 3, 6, 6, 8, 15, 3, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 3, 15, 15, 8,
];

const WEIGHTS = {
  2: [0, 21, 43, 64],
  3: [0, 9, 18, 27, 37, 46, 55, 64],
  4: [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64],
};

// [subsets, partitionBits, rotationBits, indexSelBits, colorBits, alphaBits, endpointPBits, sharedPBits, indexBits, index2Bits]
const MODES = [
  [3, 4, 0, 0, 4, 0, 1, 0, 3, 0],
  [2, 6, 0, 0, 6, 0, 0, 1, 3, 0],
  [3, 6, 0, 0, 5, 0, 0, 0, 2, 0],
  [2, 6, 0, 0, 7, 0, 1, 0, 2, 0],
  [1, 0, 2, 1, 5, 6, 0, 0, 2, 3],
  [1, 0, 2, 0, 7, 8, 0, 0, 2, 2],
  [1, 0, 0, 0, 7, 7, 1, 0, 4, 0],
  [2, 6, 0, 0, 5, 5, 1, 0, 2, 0],
];

export function subsetOf(subsets, partition, pixel) {
  if (subsets === 1) return 0;
  if (subsets === 2) return (P2[partition] >> pixel) & 1;
  return P3[partition][pixel];
}

export function anchorsOf(subsets, partition) {
  if (subsets === 1) return [0];
  if (subsets === 2) return [0, ANCHOR2[partition]];
  return [0, ANCHOR3A[partition], ANCHOR3B[partition]];
}

class Bits {
  constructor(buf, pos) {
    this.w = [buf.readUInt32LE(pos), buf.readUInt32LE(pos + 4), buf.readUInt32LE(pos + 8), buf.readUInt32LE(pos + 12)];
    this.at = 0;
  }
  read(n) {
    if (n === 0) return 0;
    const word = this.at >>> 5;
    const shift = this.at & 31;
    let v = this.w[word] >>> shift;
    if (shift + n > 32 && word < 3) v |= this.w[word + 1] << (32 - shift);
    this.at += n;
    return (v & ((1 << n) - 1)) >>> 0;
  }
}

const expand = (v, bits) => {
  v <<= 8 - bits;
  return v | (v >> bits);
};
const lerp = (a, b, w) => ((64 - w) * a + w * b + 32) >> 6;

function decodeBc7Block(buf, pos, out, stride, ox, oy) {
  const mode = buf[pos] === 0 ? -1 : Math.clz32(0) - 1 - Math.clz32(buf[pos] & -buf[pos]);
  const put = (i, r, g, b, a) => {
    const o = ((oy + (i >> 2)) * stride + ox + (i & 3)) * 4;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = a;
  };
  if (mode < 0 || mode > 7) {
    for (let i = 0; i < 16; i++) put(i, 0, 0, 0, 0); // reserved mode: transparent black
    return;
  }
  const [ns, pb, rb, isb, cb, ab, epb, spb, ib, ib2] = MODES[mode];
  const bits = new Bits(buf, pos);
  bits.read(mode + 1);
  const partition = bits.read(pb);
  const rotation = bits.read(rb);
  const indexSel = bits.read(isb);

  const n = ns * 2;
  const ep = Array.from({ length: n }, () => [0, 0, 0, 255]);
  for (let c = 0; c < 3; c++) for (let e = 0; e < n; e++) ep[e][c] = bits.read(cb);
  if (ab) for (let e = 0; e < n; e++) ep[e][3] = bits.read(ab);

  let cbits = cb;
  let abits = ab;
  if (epb) {
    for (let e = 0; e < n; e++) {
      const p = bits.read(1);
      for (let c = 0; c < 4; c++) ep[e][c] = (ep[e][c] << 1) | p;
    }
    cbits++;
    if (ab) abits++;
  } else if (spb) {
    for (let s = 0; s < ns; s++) {
      const p = bits.read(1);
      for (const e of [s * 2, s * 2 + 1]) for (let c = 0; c < 3; c++) ep[e][c] = (ep[e][c] << 1) | p;
    }
    cbits++;
  }
  for (const e of ep) {
    for (let c = 0; c < 3; c++) e[c] = expand(e[c], cbits);
    e[3] = ab ? expand(e[3], abits) : 255;
  }

  const anchors = anchorsOf(ns, partition);
  const idx = new Array(16);
  for (let i = 0; i < 16; i++) idx[i] = bits.read(anchors.includes(i) ? ib - 1 : ib);
  let idx2 = null;
  if (ib2) {
    idx2 = new Array(16);
    for (let i = 0; i < 16; i++) idx2[i] = bits.read(i === 0 ? ib2 - 1 : ib2);
  }

  for (let i = 0; i < 16; i++) {
    const s = subsetOf(ns, partition, i);
    const e0 = ep[s * 2];
    const e1 = ep[s * 2 + 1];
    let cw, aw;
    if (!idx2) cw = aw = WEIGHTS[ib][idx[i]];
    else if (indexSel) { cw = WEIGHTS[ib2][idx2[i]]; aw = WEIGHTS[ib][idx[i]]; }
    else { cw = WEIGHTS[ib][idx[i]]; aw = WEIGHTS[ib2][idx2[i]]; }
    const px = [lerp(e0[0], e1[0], cw), lerp(e0[1], e1[1], cw), lerp(e0[2], e1[2], cw), lerp(e0[3], e1[3], aw)];
    if (rotation) [px[3], px[rotation - 1]] = [px[rotation - 1], px[3]];
    put(i, px[0], px[1], px[2], px[3]);
  }
}

// ---- BC1 / BC3 ---------------------------------------------------------------

function rgb565(v) {
  return [expand((v >> 11) & 31, 5), expand((v >> 5) & 63, 6), expand(v & 31, 5)];
}

function decodeBc1Colors(buf, pos, out, stride, ox, oy, alphaFromBlock) {
  const c0 = buf.readUInt16LE(pos);
  const c1 = buf.readUInt16LE(pos + 2);
  const a = rgb565(c0);
  const b = rgb565(c1);
  const palette = [a, b];
  if (c0 > c1 || alphaFromBlock) {
    palette.push(a.map((v, i) => Math.round((2 * v + b[i]) / 3)), a.map((v, i) => Math.round((v + 2 * b[i]) / 3)));
  } else {
    palette.push(a.map((v, i) => (v + b[i]) >> 1), [0, 0, 0]);
  }
  const bitsVal = buf.readUInt32LE(pos + 4);
  for (let i = 0; i < 16; i++) {
    const k = (bitsVal >> (i * 2)) & 3;
    const o = ((oy + (i >> 2)) * stride + ox + (i & 3)) * 4;
    out[o] = palette[k][0];
    out[o + 1] = palette[k][1];
    out[o + 2] = palette[k][2];
    out[o + 3] = !alphaFromBlock && c0 <= c1 && k === 3 ? 0 : 255;
  }
}

function decodeBc3Alpha(buf, pos, out, stride, ox, oy) {
  const a0 = buf[pos];
  const a1 = buf[pos + 1];
  const pal = [a0, a1];
  if (a0 > a1) for (let i = 1; i < 7; i++) pal.push(Math.round(((7 - i) * a0 + i * a1) / 7));
  else {
    for (let i = 1; i < 5; i++) pal.push(Math.round(((5 - i) * a0 + i * a1) / 5));
    pal.push(0, 255);
  }
  let bitsVal = 0n;
  for (let i = 0; i < 6; i++) bitsVal |= BigInt(buf[pos + 2 + i]) << BigInt(i * 8);
  for (let i = 0; i < 16; i++) {
    const k = Number((bitsVal >> BigInt(i * 3)) & 7n);
    out[((oy + (i >> 2)) * stride + ox + (i & 3)) * 4 + 3] = pal[k];
  }
}

// ---- DDS ---------------------------------------------------------------------

const DXGI = { 28: 'rgba8', 29: 'rgba8', 71: 'bc1', 72: 'bc1', 77: 'bc3', 78: 'bc3', 98: 'bc7', 99: 'bc7' };

export function parseDds(buf) {
  if (buf.toString('latin1', 0, 4) !== 'DDS ') throw new Error('Not a DDS file');
  const height = buf.readUInt32LE(12);
  const width = buf.readUInt32LE(16);
  const mips = Math.max(1, buf.readUInt32LE(28));
  const fourCC = buf.toString('latin1', 84, 88);
  let format;
  let data = 128;
  if (fourCC === 'DX10') {
    format = DXGI[buf.readUInt32LE(128)];
    data = 148;
  } else if (fourCC === 'DXT1') format = 'bc1';
  else if (fourCC === 'DXT5') format = 'bc3';
  else if (buf.readUInt32LE(88) === 32) format = 'rgba8';
  if (!format) throw new Error(`Unsupported DDS format ${fourCC}`);
  return { width, height, mips, format, data };
}

const blockBytes = { bc1: 8, bc3: 16, bc7: 16 };

export function mipOffset(info, level) {
  let pos = info.data;
  let w = info.width;
  let h = info.height;
  for (let l = 0; l < level; l++) {
    pos += info.format === 'rgba8' ? w * h * 4 : Math.ceil(w / 4) * Math.ceil(h / 4) * blockBytes[info.format];
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
  return { pos, w, h };
}

// Decodes one mip level to RGBA8.
export function decodeDds(buf, level = 0) {
  const info = parseDds(buf);
  const { pos, w, h } = mipOffset(info, level);
  const out = Buffer.alloc(w * h * 4);
  if (info.format === 'rgba8') {
    buf.copy(out, 0, pos, pos + out.length);
    return { width: w, height: h, rgba: out };
  }
  const bw = Math.ceil(w / 4);
  const bh = Math.ceil(h / 4);
  const pw = bw * 4;
  const tmp = Buffer.alloc(pw * bh * 4 * 4);
  const size = blockBytes[info.format];
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const p = pos + (by * bw + bx) * size;
      if (info.format === 'bc7') decodeBc7Block(buf, p, tmp, pw, bx * 4, by * 4);
      else if (info.format === 'bc1') decodeBc1Colors(buf, p, tmp, pw, bx * 4, by * 4, false);
      else {
        decodeBc1Colors(buf, p + 8, tmp, pw, bx * 4, by * 4, true);
        decodeBc3Alpha(buf, p, tmp, pw, bx * 4, by * 4);
      }
    }
  }
  for (let y = 0; y < h; y++) tmp.copy(out, y * w * 4, y * pw * 4, y * pw * 4 + w * 4);
  return { width: w, height: h, rgba: out, mips: info.mips };
}

// ---- PNG ---------------------------------------------------------------------

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePng({ width, height, rgba }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
