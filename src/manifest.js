// mf_*.hg manifest ("meta") files for Steam/GOG saves: XXTEA-encrypted with a
// key derived from the storage slot. They record the save's sizes, so they
// must be rewritten whenever the save data changes.

export const META_MAGIC = 0xeeeeeebe;
const DELTA = 0x9e3779b9;
const KEY_TEXT = 'NAESEVADNAYRTNRG';

const rotl = (v, s) => ((v << s) | (v >>> (32 - s))) >>> 0;

function keyFor(archiveNumber) {
  const text = Buffer.from(KEY_TEXT, 'latin1');
  const key = Uint32Array.from([0, 1, 2, 3], (i) => text.readUInt32LE(i * 4));
  key[0] = (Math.imul(rotl((archiveNumber ^ 0x1422cb8c) >>> 0, 13), 5) + 0xe6546b64) >>> 0;
  return key;
}

const rounds = (byteLength) => (byteLength === 0x68 ? 8 : 6);

const mx = (sum, y, z, p, e, key) =>
  ((((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4))) ^ ((sum ^ y) + (key[(p & 3) ^ e] ^ z))) >>> 0;

function toWords(buf) {
  const w = new Uint32Array(buf.length / 4);
  for (let i = 0; i < w.length; i++) w[i] = buf.readUInt32LE(i * 4);
  return w;
}
function fromWords(w) {
  const buf = Buffer.alloc(w.length * 4);
  for (let i = 0; i < w.length; i++) buf.writeUInt32LE(w[i], i * 4);
  return buf;
}

export function decryptMeta(buf, archiveNumber) {
  const v = toWords(buf);
  const key = keyFor(archiveNumber);
  const n = v.length;
  let sum = Math.imul(rounds(buf.length), DELTA) >>> 0;
  let y = v[0];
  for (let r = 0; r < rounds(buf.length); r++) {
    const e = (sum >>> 2) & 3;
    let z;
    for (let p = n - 1; p > 0; p--) {
      z = v[p - 1];
      y = v[p] = (v[p] - mx(sum, y, z, p, e, key)) >>> 0;
    }
    z = v[n - 1];
    y = v[0] = (v[0] - mx(sum, y, z, 0, e, key)) >>> 0;
    sum = (sum - DELTA) >>> 0;
  }
  return fromWords(v);
}

export function encryptMeta(buf, archiveNumber) {
  const v = toWords(buf);
  const key = keyFor(archiveNumber);
  const n = v.length;
  let sum = 0;
  let z = v[n - 1];
  for (let r = 0; r < rounds(buf.length); r++) {
    sum = (sum + DELTA) >>> 0;
    const e = (sum >>> 2) & 3;
    let y;
    for (let p = 0; p < n - 1; p++) {
      y = v[p + 1];
      z = v[p] = (v[p] + mx(sum, y, z, p, e, key)) >>> 0;
    }
    y = v[0];
    z = v[n - 1] = (v[n - 1] + mx(sum, y, z, n - 1, e, key)) >>> 0;
  }
  return fromWords(v);
}

// accountdata.hg -> 1, save.hg -> 2, save2.hg -> 3, save3.hg -> 4, ...
export function archiveNumberFor(saveFileName) {
  if (saveFileName === 'accountdata.hg') return 1;
  const m = /^save(\d*)\.hg$/.exec(saveFileName);
  if (!m) throw new Error(`Not a save file name: ${saveFileName}`);
  return (m[1] ? Number(m[1]) : 1) + 1;
}
