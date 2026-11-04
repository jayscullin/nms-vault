// Reader for HGPAK game archives (NMS 5.x+). Layout:
//   header: "HGPAK\0\0\0", version, fileCount, chunkCount, compressed, dataOffset (u64 each)
//   fileCount entries: 16-byte hash, offset, size (offsets are in the decompressed stream)
//   chunkCount u64 compressed chunk sizes, then 16-byte-aligned chunks from dataOffset,
//   each decompressing to 128 KiB (a chunk of exactly 128 KiB is stored raw).
// The first file is the newline-separated list of names for the remaining entries.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { lz4DecompressBlock } from '../codec.js';

export const CHUNK = 0x20000;
const ZSTD_MAGIC = 0xfd2fb528;

export class HgPak {
  constructor(file) {
    this.file = file;
    this.fd = fs.openSync(file, 'r');
    const h = this.#read(0, 48);
    if (h.toString('latin1', 0, 5) !== 'HGPAK') throw new Error(`${file} is not an HGPAK archive`);
    const u64 = (b, o) => Number(b.readBigUInt64LE(o));
    const count = u64(h, 16);
    const chunkCount = u64(h, 24);
    this.compressed = u64(h, 32) === 1;
    this.dataOffset = u64(h, 40);

    const entries = this.#read(48, count * 32);
    this.entries = Array.from({ length: count }, (_, i) => ({ offset: u64(entries, i * 32 + 16), size: u64(entries, i * 32 + 24) }));
    const sizes = this.#read(48 + count * 32, chunkCount * 8);
    this.chunks = [];
    let pos = this.dataOffset;
    for (let i = 0; i < chunkCount; i++) {
      const size = u64(sizes, i * 8);
      this.chunks.push({ pos, size });
      pos = Math.ceil((pos + size) / 16) * 16; // chunks are 16-byte aligned
    }
    this.cache = new Map();

    const names = this.readEntry(this.entries[0]).toString('utf8').split(/\r?\n/).filter(Boolean);
    this.files = new Map(names.map((n, i) => [n.toLowerCase(), this.entries[i + 1]]));
  }

  #read(pos, len) {
    const buf = Buffer.alloc(len);
    fs.readSync(this.fd, buf, 0, len, pos);
    return buf;
  }

  #chunk(i) {
    let out = this.cache.get(i);
    if (out) return out;
    const { pos, size } = this.chunks[i];
    const raw = this.#read(pos, size);
    if (!this.compressed || size === CHUNK) out = raw;
    else if (raw.readUInt32LE(0) === ZSTD_MAGIC) {
      // Windows and Linux archives use zstd; only newer Node versions can read it.
      if (!zlib.zstdDecompressSync) throw new Error(`Reading these game files needs Node 22.15 or newer (this is ${process.version})`);
      out = zlib.zstdDecompressSync(raw);
    }
    else out = lz4DecompressBlock(raw, CHUNK);
    if (this.cache.size > 64) this.cache.clear();
    this.cache.set(i, out);
    return out;
  }

  readEntry({ offset, size }) {
    if (!this.compressed) return this.#read(offset, size);
    const out = Buffer.alloc(size);
    let rel = offset - this.dataOffset;
    let written = 0;
    while (written < size) {
      const ci = Math.floor(rel / CHUNK);
      const within = rel % CHUNK;
      const data = this.#chunk(ci);
      const n = Math.min(size - written, data.length - within);
      if (n <= 0) throw new Error(`Chunk ${ci} of ${this.file} is short`);
      data.copy(out, written, within, within + n);
      written += n;
      rel += n;
    }
    return out;
  }

  has(name) {
    return this.files.has(name.toLowerCase());
  }

  read(name) {
    const e = this.files.get(name.toLowerCase());
    if (!e) throw new Error(`${name} not found in ${this.file}`);
    return this.readEntry(e);
  }

  close() {
    fs.closeSync(this.fd);
  }
}
