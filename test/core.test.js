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
import { applyOp, catalog, indexCatalog, shipLock, freighterLock, SHIP_KINDS, FREIGHTER_KINDS, OpError } from '../src/inventory.js';
import { samplerTexture, packModel, loadModel, readCustomisationGroups, readDescriptor } from '../src/gamedata/model.js';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import { HgPak, CHUNK } from '../src/gamedata/hgpak.js';
import { parseLibraryFolders } from '../src/gamedata/itemdb.js';

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

test('customisation groups map a group id to the descriptor ids it switches on', () => {
  const b = Buffer.alloc(0x100);
  const str = (at, v) => b.write(v, at, 'latin1');
  // record at 0x20: list header -> 2 ids at 0x80, then the group id
  b.writeBigUInt64LE(0x60n, 0x20);
  b.writeUInt32LE(2, 0x28);
  b.writeUInt32LE(0xaaaaaa01, 0x2c);
  str(0x30, 'FIGHT_WINGBA');
  str(0x80, '_SUBWINGS_A');
  str(0xa0, '_Wings_B');
  const groups = readCustomisationGroups(b);
  assert.deepEqual(groups.get('FIGHT_WINGBA'), ['_SUBWINGS_A', '_WINGS_B']);
  assert.equal(groups.size, 1);
});

const FIGHTER = 'MODELS/COMMON/SPACECRAFT/FIGHTERS/FIGHTER_PROC.SCENE.MBIN';
const inv = () => ({ Slots: [], ValidSlotIndices: [], Width: 1, Height: 1 });
const ship = (Filename, seed, Name = '') => ({ Name, Resource: { Filename, Seed: [Boolean(Filename), seed] }, Inventory: inv(), Inventory_Cargo: inv(), Inventory_TechOnly: inv() });
const custom = (groups) => ({ SelectedPreset: '^', CustomData: { DescriptorGroups: groups, Colours: [], TextureOptions: [] } });
const fleet = () => ({
  BaseContext: {
    PlayerStateData: {
      PrimaryShip: 0,
      ShipOwnership: [ship(FIGHTER, '0xAAAAAAAAAAAA'), ship(FIGHTER, '0xBBBBBBBBBBBB', 'Keep'), ship(FIGHTER, '0x6'), ship('MODELS/COMMON/SPACECRAFT/FIGHTERS/WRACER.SCENE.MBIN', '0xCCCCCCCCCCCC'), ship('', '0x0')],
      ShipUsesLegacyColours: [false, true, false, false, false],
      CharacterCustomisationData: Array.from({ length: 26 }, (_, i) => custom(i === 4 ? ['^FIGHT_COCKD'] : [])),
      CurrentFreighter: { Filename: FREIGHTER_KINDS[1].scene, Seed: [true, '0x1234'] },
    },
  },
});
const shipPolicy = { sceneExists: () => true, rewardSeed: (s) => s === '0xDDDDDDDDDDDD' };
const shipOp = (tree, op) => applyOp(tree, indexCatalog(catalog(tree)), shipPolicy, op);
const PS_OF = (t) => t.BaseContext.PlayerStateData;

test('reward, fixed and empty ships are locked; standard ones are not', () => {
  const t = fleet();
  assert.equal(shipLock(t, 0, shipPolicy), null);
  assert.match(shipLock(t, 2, shipPolicy), /Reward/);
  assert.match(shipLock(t, 3, shipPolicy), /fixed parts/);
  assert.match(shipLock(t, 4, shipPolicy), /empty/);
  PS_OF(t).ShipOwnership[0].Resource.Seed[1] = '0xDDDDDDDDDDDD';
  assert.match(shipLock(t, 0, shipPolicy), /Reward/);
  assert.match(shipLock(t, 1, { ...shipPolicy, sceneExists: () => false }), /game’s data/);
});

test('changing a ship type keeps its seed and clears customisation from the old type', () => {
  const t = fleet();
  const { touched } = shipOp(t, { op: 'setShipType', ship: 1, scene: SHIP_KINDS[1].scene });
  const s = PS_OF(t).ShipOwnership[1];
  assert.equal(s.Resource.Filename, SHIP_KINDS[1].scene);
  assert.equal(s.Resource.Seed[1], '0xBBBBBBBBBBBB');
  assert.deepEqual(PS_OF(t).CharacterCustomisationData[4].CustomData.DescriptorGroups, []);
  assert.ok(touched.some((p) => p.includes('CharacterCustomisationData')));
  assert.throws(() => shipOp(t, { op: 'setShipType', ship: 1, scene: SHIP_KINDS[1].scene }), /already/);
  assert.throws(() => shipOp(t, { op: 'setShipType', ship: 1, scene: 'MODELS/EVIL.SCENE.MBIN' }), OpError);
  assert.throws(() => shipOp(t, { op: 'setShipType', ship: 3, scene: FIGHTER }), /fixed parts/);
});

test('deleting a ship copies the save’s own empty record and refuses the ship in use', () => {
  const t = fleet();
  assert.throws(() => shipOp(t, { op: 'deleteShip', ship: 0 }), /Switch to another ship/);
  assert.throws(() => shipOp(t, { op: 'deleteShip', ship: 2 }), /Reward/);
  shipOp(t, { op: 'deleteShip', ship: 1 });
  const ps = PS_OF(t);
  assert.equal(ps.ShipOwnership[1].Resource.Filename, '');
  assert.equal(ps.ShipOwnership[1].Name, '');
  assert.equal(ps.ShipUsesLegacyColours[1], false);
  assert.deepEqual(ps.CharacterCustomisationData[4].CustomData.DescriptorGroups, []);
  assert.equal(catalog(t).filter((c) => c.group === 'Starships').length, 3);
  const none = fleet();
  PS_OF(none).ShipOwnership[4] = ship(FIGHTER, '0xEEEEEEEEEEEE');
  assert.throws(() => shipOp(none, { op: 'deleteShip', ship: 1 }), /no empty ship record/);
});

test('the freighter type only swaps between the two standard freighters', () => {
  const t = fleet();
  shipOp(t, { op: 'setFreighterType', scene: FREIGHTER_KINDS[0].scene });
  assert.equal(PS_OF(t).CurrentFreighter.Filename, FREIGHTER_KINDS[0].scene);
  assert.equal(PS_OF(t).CurrentFreighter.Seed[1], '0x1234');
  assert.throws(() => shipOp(t, { op: 'setFreighterType', scene: FIGHTER }), /Unknown freighter/);
  PS_OF(t).CurrentFreighter.Filename = 'MODELS/COMMON/SPACECRAFT/INDUSTRIAL/PIRATEFREIGHTER.SCENE.MBIN';
  assert.match(freighterLock(t, shipPolicy), /fixed parts/);
});

test('descriptor options match scenes by name, even when the id is shorter', () => {
  const buf = Buffer.from(['', '_SHIP_', '_SHIP_ROY', '_Ship_Royal', '_SHIP_SQU', '_Ship_Squid', '_WINGS_', '_WINGS_A', '_Wings_A', ''].join('\0'), 'latin1');
  const d = readDescriptor(buf);
  assert.deepEqual([...d.types], ['_SHIP_', '_WINGS_']);
  assert.deepEqual([...d.ids], ['_SHIP_ROY', '_SHIP_SQU', '_WINGS_A']);
  assert.equal(d.names.get('_SHIP_ROYAL'), '_SHIP_ROY');
  assert.equal(d.names.get('_SHIP_SQUID'), '_SHIP_SQU');
  assert.equal(d.names.get('_WINGS_A'), '_WINGS_A');
});

test('technology installs only where it fits, once, with the game’s charge', () => {
  const tech = (Id, Amount, MaxAmount, X) => ({ Type: { InventoryType: 'Technology' }, Id, Amount, MaxAmount, DamageFactor: 0, FullyInstalled: true, AddedAutomatically: true, Index: { X, Y: 0 } });
  const t = fleet();
  const grid = PS_OF(t).ShipOwnership[0].Inventory_TechOnly;
  Object.assign(grid, { Width: 3, Height: 1, ValidSlotIndices: [0, 1, 2].map((X) => ({ X, Y: 0 })), Slots: [tech('^SHIPJUMP1', 50, 200, 0)] });
  const facts = { '^SHIPSHIELD': { chargeable: true, charge: 200 }, '^SHIP_TELEPORT': { chargeable: false, charge: 100 } };
  const stacks = { ...shipPolicy, item: (id) => facts[id] ?? null, installable: (id, fits) => id in facts && fits.includes(0), template: () => tech('^X', 1, 1, 0) };
  const inv = 'BaseContext/PlayerStateData/ShipOwnership/0/Inventory_TechOnly';
  const cat = indexCatalog(catalog(t));
  applyOp(t, cat, stacks, { op: 'add', inv, x: 1, y: 0, id: 'SHIPSHIELD' });
  applyOp(t, cat, stacks, { op: 'add', inv, x: 2, y: 0, id: '^SHIP_TELEPORT' });
  const [, charged, plain] = grid.Slots;
  assert.deepEqual([charged.Id, charged.Amount, charged.MaxAmount, charged.AddedAutomatically], ['^SHIPSHIELD', 200, 200, false]);
  assert.deepEqual([plain.Id, plain.Amount, plain.MaxAmount, plain.Index.X], ['^SHIP_TELEPORT', -1, 100, 2]);
  grid.ValidSlotIndices.push({ X: 3, Y: 0 });
  grid.Width = 4;
  assert.throws(() => applyOp(t, cat, stacks, { op: 'add', inv, x: 3, y: 0, id: 'SHIPSHIELD' }), /already installed/);
  assert.throws(() => applyOp(t, cat, stacks, { op: 'add', inv, x: 3, y: 0, id: 'LASER' }), /can't be installed/);
  assert.throws(() => applyOp(t, cat, stacks, { op: 'add', inv, x: 1, y: 0, id: 'SHIP_TELEPORT' }), /occupied/);
});

test('archives read with zstd chunks (Windows, Linux), lz4 chunks (macOS) and stored chunks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nms-vault-pak-'));
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const write = (encode) => {
    const names = Buffer.from('a.mbin\nb.mbin\n');
    const a = crypto.randomBytes(CHUNK + 5000); // incompressible: its first chunk is stored as is
    const b = Buffer.from('hello world '.repeat(50));
    const stream = Buffer.concat([names, a, b]);
    const pieces = [];
    for (let i = 0; i < stream.length; i += CHUNK) pieces.push(encode(stream.subarray(i, i + CHUNK)));
    const headerSize = 48 + 3 * 32 + pieces.length * 8;
    const dataOffset = Math.ceil(headerSize / 16) * 16;
    // Entry offsets count from the start of the file, as if the data were uncompressed.
    const entry = (offset, size) => Buffer.concat([Buffer.alloc(16), u64(dataOffset + offset), u64(size)]);
    const entries = [entry(0, names.length), entry(names.length, a.length), entry(names.length + a.length, b.length)];
    const header = Buffer.concat([Buffer.from('HGPAK\0\0\0'), u64(2), u64(entries.length), u64(pieces.length), u64(1), u64(dataOffset), ...entries, ...pieces.map((p) => u64(p.length))]);
    const body = [Buffer.alloc(dataOffset - header.length)];
    for (const p of pieces) body.push(p, Buffer.alloc((16 - (p.length % 16)) % 16));
    const file = path.join(dir, 'test.pak');
    fs.writeFileSync(file, Buffer.concat([header, ...body]));
    const pak = new HgPak(file);
    assert.ok(pak.read('a.mbin').equals(a));
    assert.ok(pak.read('B.MBIN').equals(b));
    pak.close();
  };
  write((c) => (c.length === CHUNK ? c : zlib.zstdCompressSync(c)));
  write((c) => (c.length === CHUNK ? c : lz4CompressBlock(c)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Steam library lists read Windows and Linux paths', () => {
  const vdf = '"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"/run/media/deck/card"\n\t}\n}';
  assert.deepEqual(parseLibraryFolders(vdf), ['C:/Program Files (x86)/Steam', '/run/media/deck/card']);
});
