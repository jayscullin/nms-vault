import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { decodeSave, encodeSave, lz4CompressBlock, lz4DecompressBlock } from '../src/codec.js';
import { parse, stringify } from '../src/losslessJson.js';
import { loadMapping, deobfuscate, obfuscate } from '../src/keys.js';
import { encryptMeta, decryptMeta, archiveNumberFor } from '../src/manifest.js';
import { diffTrees } from '../src/validate.js';
import { subsetOf, anchorsOf, encodePng, decodeDds } from '../src/gamedata/dds.js';
import { resolveItem } from '../src/gamedata/itemdb.js';
import { readStackBases, ruleLimit } from '../src/gamedata/stacks.js';
import { applyRewardOp } from '../src/rewards.js';
import { samplerTexture, packModel, loadModel } from '../src/gamedata/model.js';
import zlib from 'node:zlib';

const mapping = loadMapping(path.join(import.meta.dirname, '..', 'data', 'mapping.json'));

test('LZ4 block round-trips random, repetitive and tiny inputs', () => {
  const inputs = [
    crypto.randomBytes(70000),
    Buffer.from('abcabcabc'.repeat(20000)),
    Buffer.from('x'),
    Buffer.alloc(0x80000, 7),
    Buffer.from(JSON.stringify({ a: Array.from({ length: 5000 }, (_, i) => ({ i, s: `item${i % 13}` })) })),
  ];
  for (const input of inputs) {
    const out = lz4DecompressBlock(lz4CompressBlock(input), input.length);
    assert.ok(out.equals(input));
  }
});

test('chunked save encoding round-trips text larger than one chunk', () => {
  const text = JSON.stringify({ big: 'y'.repeat(1_300_000), n: 1 });
  const bytes = encodeSave(text);
  const d = decodeSave(bytes);
  assert.equal(d.text, text);
  assert.equal(d.chunks, 3);
});

test('lossless JSON keeps float formatting, escapes and raw bytes', () => {
  const samples = [
    '{"a":1.0,"b":[0.0,75.0,-2.50],"c":4.4703490686970329e-8,"d":12}',
    '{"s":"\\u001BT\\u0005R","t":"quote \\" back \\\\u0041"}',
    Buffer.from([0x7b, 0x22, 0x62, 0x22, 0x3a, 0x22, 0x5e, 0xff, 0xfe, 0x22, 0x7d]).toString('latin1'),
  ];
  for (const s of samples) assert.equal(stringify(parse(s)), s);
});

test('key translation is reversible and preserves key order', () => {
  const [obf, name] = [...mapping.decodeMap][0];
  const text = `{"397":1,"${obf}":{"zz~":2,"${name}":3},"12":[{"${obf}":4}]}`;
  const readable = deobfuscate(text, mapping);
  assert.ok(readable.includes(`"${name}"`));
  assert.equal(obfuscate(readable, mapping), text);
  assert.equal(obfuscate(stringify(parse(readable)), mapping), text);
});

test('manifest cipher round-trips for each slot', () => {
  const plain = crypto.randomBytes(432);
  for (const file of ['save.hg', 'save2.hg', 'save9.hg']) {
    const n = archiveNumberFor(file);
    assert.ok(decryptMeta(encryptMeta(plain, n), n).equals(plain));
  }
});

test('BC7 partition tables are consistent with their anchors', () => {
  for (const ns of [2, 3]) {
    for (let p = 0; p < 64; p++) {
      anchorsOf(ns, p).forEach((pixel, subset) => assert.equal(subsetOf(ns, p, pixel), subset, `${ns}-subset partition ${p}`));
      assert.equal(new Set(Array.from({ length: 16 }, (_, i) => subsetOf(ns, p, i))).size, ns);
    }
  }
});

test('BC7 mode 6 block decodes to its solid endpoint colour', () => {
  // Mode 6 (bit 6 set), both endpoints RGBA = 0x7F,0x00,0x7F,0x7F with p-bits 1 -> 0xFF,0x01,0xFF,0xFF; all indices 0.
  const block = Buffer.alloc(16);
  let bit = 0;
  const put = (v, n) => { for (let i = 0; i < n; i++, bit++) if ((v >> i) & 1) block[bit >> 3] |= 1 << (bit & 7); };
  put(0b1000000, 7);
  for (const c of [0x7f, 0x00, 0x7f, 0x7f]) { put(c, 7); put(c, 7); }
  put(1, 1); put(1, 1);
  const header = Buffer.alloc(148);
  header.write('DDS ', 0, 'latin1');
  header.writeUInt32LE(4, 12); header.writeUInt32LE(4, 16); header.writeUInt32LE(1, 28);
  header.write('DX10', 84, 'latin1'); header.writeUInt32LE(98, 128);
  const { rgba } = decodeDds(Buffer.concat([header, block]));
  assert.deepEqual([...rgba.subarray(0, 4)], [0xff, 0x01, 0xff, 0xff]);
  assert.deepEqual([...rgba.subarray(60, 64)], [0xff, 0x01, 0xff, 0xff]);
});

test('PNG encoder writes a valid image', () => {
  const png = encodePng({ width: 2, height: 1, rgba: Buffer.from([255, 0, 0, 255, 0, 0, 255, 128]) });
  assert.equal(png.toString('latin1', 1, 4), 'PNG');
  const idatLen = png.readUInt32BE(33);
  const raw = zlib.inflateSync(png.subarray(41, 41 + idatLen));
  assert.deepEqual([...raw], [0, 255, 0, 0, 255, 0, 0, 255, 128]);
});

test('item resolution strips markers and falls back for upgrade modules', () => {
  const items = { FUEL1: { name: 'Carbon', icon: 'x' }, STEALTH: { name: 'Cloaking Device', icon: 'y' } };
  assert.equal(resolveItem(items, '^FUEL1').name, 'Carbon');
  assert.equal(resolveItem(items, '^FUEL1#123').key, 'FUEL1');
  assert.equal(resolveItem(items, '^UP_STEALTH#9').name, 'Cloaking Device Upgrade');
  assert.equal(resolveItem(items, '^NOPE'), null);
});

test('stack bases are found after the High substance run and rules apply cap and non-stacking', () => {
  const high = { Product: [5, 10, 10, 10, 10, 20, 20, 10, 20, 100, 10, 1, 20], Substance: Array(15).fill(9999) };
  const normal = { Product: [5, 10, 10, 10, 10, 10, 20, 10, 20, 100, 10, 1, 20], Substance: [500, 500, 500, 1000, 1000, 2000, 2000, 1000, 1000, 2000, 250, 250, 9999, 9999, 9999] };
  const low = { Product: [3, 3, 5, 3, 5, 5, 10, 3, 10, 50, 5, 1, 20], Substance: [150, 300, 300, 300, 750, 750, 750, 300, 1000, 1250, 150, 150, 9999, 9999, 9999] };
  const ints = [7, 7, ...[high, normal, low].flatMap((b) => [...b.Product, ...b.Substance]), 0];
  const buf = Buffer.alloc(ints.length * 4);
  ints.forEach((v, i) => buf.writeInt32LE(v, i * 4));
  const bases = readStackBases(buf);
  assert.deepEqual(bases.Normal, normal);
  assert.equal(ruleLimit(bases, 'High', 'Product', 'Chest', 10), 200);
  assert.equal(ruleLimit(bases, 'High', 'Product', 'Personal', 1000), 9999);
  assert.equal(ruleLimit(bases, 'High', 'Product', 'Personal', 0), 1);
  assert.equal(ruleLimit(bases, 'Low', 'Substance', 'Ship', 1), 300);
  assert.equal(ruleLimit(bases, 'High', 'Product', 'NoSuchGroup', 1), null);
});

test('reward unlocking adds only known rewards and keeps the list sorted', () => {
  const tree = { UserSettingsData: { UnlockedSeasonRewards: ['^A_ONE', '^C_THREE'], UnlockedTwitchRewards: [] } };
  const catalog = { season: [{ id: 'A_ONE' }, { id: 'B_TWO' }, { id: 'D_FOUR' }], twitch: [{ id: 'TWITCH_001' }] };
  const r = applyRewardOp(tree, catalog, { op: 'unlockRewards', list: 'season', ids: ['D_FOUR', 'B_TWO', 'A_ONE'] });
  assert.deepEqual(tree.UserSettingsData.UnlockedSeasonRewards, ['^A_ONE', '^B_TWO', '^C_THREE', '^D_FOUR']);
  assert.deepEqual(r.touched, [['UserSettingsData', 'UnlockedSeasonRewards']]);
  assert.throws(() => applyRewardOp(tree, catalog, { op: 'unlockRewards', list: 'season', ids: ['NOPE'] }), /isn't one of/);
  assert.throws(() => applyRewardOp(tree, catalog, { op: 'unlockRewards', list: 'season', ids: ['A_ONE'] }), /already unlocked/);
  assert.throws(() => applyRewardOp(tree, catalog, { op: 'unlockRewards', list: 'other', ids: ['A_ONE'] }), /Unknown reward list/);
});

test('diff flags changes outside allowed paths', () => {
  const a = parse('{"x":{"Slots":[1,2]},"y":1.0,"z":"k"}');
  const b = parse('{"x":{"Slots":[2]},"y":1.0,"z":"k"}');
  assert.deepEqual(diffTrees(a, b, [['x', 'Slots']]).unexpected, []);
  const c = parse('{"x":{"Slots":[1,2]},"y":1,"z":"k"}');
  assert.deepEqual(diffTrees(a, c, []).unexpected, ['y']);
});

test('material sampler lookup takes the map path recorded before the sampler name', () => {
  const rec = (map, name) => `${map}\0\0\0${name}\0\0`;
  const mat = Buffer.from(rec('TEXTURES/A/TRIM.DDS', 'gDiffuseMap') + rec('TEXTURES/A/TRIM.MASKS.DDS', 'gMasksMap'), 'latin1');
  assert.equal(samplerTexture(mat), 'TEXTURES/A/TRIM.DDS');
  assert.equal(samplerTexture(mat, 'gMasksMap'), 'TEXTURES/A/TRIM.MASKS.DDS');
  assert.equal(samplerTexture(mat, 'gNormalMap'), null);
});

test('packed models carry an aligned JSON header followed by the mesh arrays', () => {
  const mesh = { name: 'M', material: 'm', positions: new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]), uvs: new Float32Array(6), indices: new Uint32Array([0, 1, 2]) };
  const bin = packModel({ name: 'X', meshes: [mesh], textures: { m: 'textures/t.dds' } });
  const len = bin.readUInt32LE(0);
  assert.equal(len % 4, 0);
  const header = JSON.parse(bin.toString('utf8', 4, 4 + len));
  const m = header.meshes[0];
  assert.equal(m.vertices, 3);
  assert.equal(m.count, 3);
  const base = 4 + len;
  assert.equal(bin.readFloatLE(base + m.positions + 8 * 4), 8);
  assert.equal(bin.readUInt32LE(base + m.indices + 8), 2);
  assert.equal(bin.length, base + 36 + 24 + 12);
});

test('model loading refuses odd paths and procedural models', () => {
  const files = new Set(['models/a/ship.scene.mbin', 'models/a/ship.descriptor.mbin']);
  const archives = { find: (n) => (files.has(n) ? {} : null), read: () => Buffer.alloc(0), paks: [] };
  assert.throws(() => loadModel(archives, '../etc/passwd'), /Not a model path/);
  assert.throws(() => loadModel(archives, 'MODELS/A/MISSING.SCENE.MBIN'), /not found/);
  assert.throws(() => loadModel(archives, 'MODELS\\A\\SHIP.SCENE.MBIN'), /Procedurally generated/);
});
