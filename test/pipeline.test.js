// End-to-end tests of the save pipeline (open, edit, review, write, verify)
// against generated fixture saves. No game data is needed.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFixtures, writeSave, saveTree, ACCOUNT, SAVE_ID } from './fixtures/build.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nms-vault-test-'));
process.env.NMS_SAVE_ROOT = path.join(root, 'saves');
process.env.NMS_VAULT_HOME = path.join(root, 'vault');
process.env.NMS_GAME_DIR = path.join(root, 'no-game');
const S = await import('../src/saves.js');
const { decodeSave } = await import('../src/codec.js');
const { deobfuscate } = await import('../src/keys.js');
const { parse, stringify } = await import('../src/losslessJson.js');

let dir;
before(() => {
  dir = buildFixtures(process.env.NMS_SAVE_ROOT);
});

const fresh = () => {
  dir = buildFixtures(process.env.NMS_SAVE_ROOT);
};
const readTree = (file) => JSON.parse(deobfuscate(decodeSave(fs.readFileSync(path.join(dir, file))).text, S.mapping));
const exosuit = (s) => S.sessionView(s).containers[0].inventories[0];

test('fixture saves list like the game and verify byte-exact', () => {
  fresh();
  const [account] = S.listAccounts();
  assert.equal(account.id, ACCOUNT);
  assert.deepEqual(account.slots.map((s) => s.file), ['save.hg', 'save2.hg', 'save3.hg']);
  for (const f of ['save.hg', 'save2.hg', 'save3.hg', 'accountdata.hg']) assert.ok(S.verifyRoundTrip(ACCOUNT, f).ok, f);
});

test('an amount edit is written, verified, backed up and changes nothing else', async () => {
  fresh();
  const before = readTree('save.hg');
  const s = S.openSession(ACCOUNT, 'save.hg');
  S.addOp(s, { op: 'setAmount', inv: exosuit(s).id, x: 0, y: 0, amount: 42 });
  const r = await S.commit(s);
  assert.ok(r.ok, JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.ok(fs.existsSync(path.join(r.backupDir, 'save.hg')));
  assert.ok(S.verifyRoundTrip(ACCOUNT, 'save.hg').ok);
  const after = readTree('save.hg');
  const slotOf = (t) => t.BaseContext.PlayerStateData.Inventory.Slots[0];
  assert.equal(slotOf(after).Amount, 42);
  slotOf(after).Amount = slotOf(before).Amount;
  assert.deepEqual(after, before);
});

test('rejected edits leave the session unchanged', () => {
  fresh();
  const s = S.openSession(ACCOUNT, 'save.hg');
  const inv = exosuit(s);
  assert.throws(() => S.addOp(s, { op: 'setAmount', inv: inv.id, x: 2, y: 0, amount: 21 }), /1 to 20/);
  assert.throws(() => S.addOp(s, { op: 'remove', inv: S.sessionView(s).containers[0].inventories[1].id, x: 0, y: 0 }), /core/);
  assert.equal(s.ops.length, 0);
  assert.equal(S.review(s).checks.find((c) => c.name === 'There are changes to write').ok, false);
});

test('moving a stack uses the limit the game wrote for the target inventory', () => {
  fresh();
  const s = S.openSession(ACCOUNT, 'save.hg');
  const v = S.sessionView(s);
  const chest = v.containers.find((c) => c.title === 'Supplies').inventories[0];
  // 30 Warp Hypercore in a chest (limit 40) into the exosuit (limit 20): one full stack moves.
  S.addOp(s, { op: 'move', from: { inv: chest.id, x: 0, y: 0 }, to: { inv: exosuit(s).id, x: 5, y: 3 } });
  const moved = exosuit(s).slots.find((x) => x.x === 5 && x.y === 3);
  assert.deepEqual([moved.amount, moved.max], [20, 20]);
  assert.equal(S.sessionView(s).containers.find((c) => c.title === 'Supplies').inventories[0].slots[0].amount, 10);
  assert.ok(S.review(s).ok);
});

test('move to an inventory tops up its stack, then uses a free cell', () => {
  fresh();
  const s = S.openSession(ACCOUNT, 'save.hg');
  const chest = S.sessionView(s).containers.find((c) => c.title === 'Supplies').inventories[0];
  // 30 in a chest into the exosuit, which has 5 of a limit of 20: 15 top it up, 15 take a new cell.
  S.addOp(s, { op: 'moveTo', from: { inv: chest.id, x: 0, y: 0 }, inv: exosuit(s).id });
  const stacks = exosuit(s).slots.filter((x) => x.id === '^HYPERFUEL2');
  assert.deepEqual(stacks.map((x) => [x.amount, x.max]), [[20, 20], [15, 20]]);
  assert.equal(S.sessionView(s).containers.find((c) => c.title === 'Supplies').inventories[0].slots.some((x) => x.id === '^HYPERFUEL2'), false);
  assert.ok(S.review(s).ok);
  assert.throws(() => S.addOp(s, { op: 'moveTo', from: { inv: exosuit(s).id, x: 2, y: 0 }, inv: exosuit(s).id }), /already there/);
});

test('technology and other grids are refused as move targets', () => {
  fresh();
  const s = S.openSession(ACCOUNT, 'save.hg');
  const [general, tech] = S.sessionView(s).containers[0].inventories;
  const chest = S.sessionView(s).containers.find((c) => c.title === 'Supplies').inventories[0];
  assert.throws(() => S.addOp(s, { op: 'moveTo', from: { inv: general.id, x: 0, y: 0 }, inv: tech.id }), /can't receive/);
  assert.throws(() => S.addOp(s, { op: 'moveTo', from: { inv: tech.id, x: 0, y: 0 }, inv: chest.id }), /Technology/);
  assert.equal(s.ops.length, 0);
});

test('consolidate gathers every other stack and can be undone', () => {
  fresh();
  const s = S.openSession(ACCOUNT, 'save.hg');
  const chestOf = () => S.sessionView(s).containers.find((c) => c.title === 'Supplies').inventories[0];
  S.addOp(s, { op: 'consolidate', id: '^FUEL1', into: chestOf().id });
  assert.equal(chestOf().slots.find((x) => x.id === '^FUEL1').amount, 650); // 500 + 100 + a ship's 50
  assert.equal(exosuit(s).slots.some((x) => x.id === '^FUEL1'), false);
  const r = S.review(s);
  assert.ok(r.ok, JSON.stringify(r.checks.filter((c) => !c.ok)));
  S.undoOp(s);
  assert.equal(chestOf().slots.find((x) => x.id === '^FUEL1').amount, 500);
  assert.equal(exosuit(s).slots.find((x) => x.id === '^FUEL1').amount, 100);
});

test('consolidate only targets an inventory holding the item, and has to have something to do', () => {
  fresh();
  const s = S.openSession(ACCOUNT, 'save.hg');
  const empty = S.sessionView(s).containers.find((c) => c.group === 'Storage' && c.title !== 'Supplies' && c.inventories[0].slots.length === 0)?.inventories[0];
  if (empty) assert.throws(() => S.addOp(s, { op: 'consolidate', id: '^FUEL1', into: empty.id }), /doesn't hold/);
  assert.throws(() => S.addOp(s, { op: 'consolidate', id: '^ANTIMATTER', into: exosuit(s).id }), /already in/);
  assert.equal(s.ops.length, 0);
});

test('consolidating many items is one edit with one undo', () => {
  fresh();
  const s = S.openSession(ACCOUNT, 'save.hg');
  const chest = () => S.sessionView(s).containers.find((c) => c.title === 'Supplies').inventories[0];
  S.addOp(s, { op: 'consolidateMany', items: [{ id: '^FUEL1', into: chest().id }, { id: '^HYPERFUEL2', into: chest().id }] });
  assert.equal(s.ops.length, 1);
  assert.equal(chest().slots.find((x) => x.id === '^FUEL1').amount, 650);
  assert.equal(chest().slots.find((x) => x.id === '^HYPERFUEL2').amount, 35);
  assert.ok(S.review(s).ok);
  S.undoOp(s);
  assert.equal(s.ops.length, 0);
  assert.equal(chest().slots.find((x) => x.id === '^FUEL1').amount, 500);
  assert.equal(exosuit(s).slots.find((x) => x.id === '^HYPERFUEL2').amount, 5);
  // A wrong target refuses the whole edit and leaves nothing half done.
  assert.throws(() => S.addOp(s, { op: 'consolidateMany', items: [{ id: '^FUEL1', into: chest().id }, { id: '^ANTIMATTER', into: chest().id }] }), /doesn't hold/);
  assert.equal(exosuit(s).slots.find((x) => x.id === '^FUEL1').amount, 100);
  assert.throws(() => S.addOp(s, { op: 'consolidateMany', items: [] }), /Nothing/);
});

test('what doesn’t fit stays where it was', () => {
  const tree = saveTree();
  const chest = tree.BaseContext.PlayerStateData.Chest1Inventory;
  chest.ValidSlotIndices = chest.ValidSlotIndices.slice(0, 2); // only the two occupied cells
  chest.Slots[0].Amount = 39; // room for 1
  fresh();
  writeSave(dir, 'save.hg', tree);
  const s = S.openSession(ACCOUNT, 'save.hg');
  const chestInv = () => S.sessionView(s).containers.find((c) => c.title === 'Supplies').inventories[0];
  S.addOp(s, { op: 'consolidate', id: '^HYPERFUEL2', into: chestInv().id });
  assert.equal(chestInv().slots.find((x) => x.id === '^HYPERFUEL2').amount, 40);
  assert.equal(exosuit(s).slots.find((x) => x.id === '^HYPERFUEL2').amount, 4);
  assert.ok(s.warnings.some((w) => w.includes('4 stayed')));
  assert.ok(S.review(s).ok);
  assert.throws(() => S.addOp(s, { op: 'consolidate', id: '^HYPERFUEL2', into: chestInv().id }), /no room/);
});

test('currency and rename edits pass review', () => {
  fresh();
  const s = S.openSession(ACCOUNT, 'save.hg');
  S.addOp(s, { op: 'setCurrency', field: 'Units', value: 123456 });
  S.addOp(s, { op: 'rename', target: S.sessionView(s).containers.find((c) => c.group === 'Starships').nameKey, name: 'Renamed ✓' });
  assert.ok(S.review(s).ok);
});

test('copying a save to another slot gives it a new save id; duplicates are detectable', async () => {
  fresh();
  const r = await S.slotOp(ACCOUNT, 'copy', 'save.hg', 'save5.hg');
  assert.ok(r.verified);
  assert.notEqual(r.newId, SAVE_ID);
  assert.equal(readTree('save5.hg').CommonStateData.SaveUniversalId, r.newId);
  assert.equal(readTree('save.hg').CommonStateData.SaveUniversalId, SAVE_ID);
  await assert.rejects(S.slotOp(ACCOUNT, 'copy', 'save3.hg', 'save6.hg'), /already holds another save/);
  const swap = await S.slotOp(ACCOUNT, 'swap', 'save3.hg', 'save5.hg');
  assert.ok(swap.verified);
  assert.equal(readTree('save3.hg').CommonStateData.SaveUniversalId, r.newId);
});

test('sort lays items out row by row, combines stacks within limits, and leaves tech alone', async () => {
  fresh();
  // Messy exosuit: split stacks of Carbon and Warp Hypercore scattered around.
  const tree = saveTree();
  const slots = tree.BaseContext.PlayerStateData.Inventory.Slots;
  const extra = (id, type, amount, max, x, y) => ({ ...parse(stringify(slots[0])), Type: { InventoryType: type }, Id: id, Amount: amount, MaxAmount: max, Index: { X: x, Y: y } });
  slots.push(extra('^FUEL1', 'Substance', 50, 9999, 4, 2), extra('^HYPERFUEL2', 'Product', 18, 20, 5, 3));
  writeSave(dir, 'save.hg', tree);

  const s = S.openSession(ACCOUNT, 'save.hg');
  const inv = exosuit(s);
  S.addOp(s, { op: 'sortInventory', inv: inv.id, by: 'type', combine: true });
  const after = exosuit(s).slots.sort((a, b) => a.y - b.y || a.x - b.x).map((x) => `${x.x},${x.y} ${x.id} ${x.amount}/${x.max}`);
  assert.deepEqual(after, [
    '0,0 ^FUEL1 150/9999', // 100 + 50 combined
    '1,0 ^LAND1 250/9999',
    '2,0 ^ANTIMATTER 3/20',
    '3,0 ^HYPERFUEL2 20/20', // 5 + 18 = 23 -> a full stack and the rest
    '4,0 ^HYPERFUEL2 3/20',
  ]);
  const techInv = S.sessionView(s).containers[0].inventories[1];
  assert.throws(() => S.addOp(s, { op: 'sortInventory', inv: techInv.id, by: 'name' }), /adjacency/);
  const r = await S.commit(s);
  assert.ok(r.ok, JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.ok(S.verifyRoundTrip(ACCOUNT, 'save.hg').ok);
  const total = (t, id) => t.BaseContext.PlayerStateData.Inventory.Slots.filter((x) => x.Id === id).reduce((n, x) => n + x.Amount, 0);
  assert.equal(total(readTree('save.hg'), '^HYPERFUEL2'), 23);
  assert.deepEqual(readTree('save.hg').BaseContext.PlayerStateData.Inventory_TechOnly, JSON.parse(stringify(tree.BaseContext.PlayerStateData.Inventory_TechOnly)));
});

test('unlock slots fills the grid row by row, but not storage with a game cap', async () => {
  fresh();
  const s = S.openSession(ACCOUNT, 'save.hg');
  const ship = S.sessionView(s).containers.find((c) => c.group === 'Starships').inventories[0];
  assert.equal(ship.valid.length, 10);
  // One cell first (as when buying a slot), then the rest.
  S.addOp(s, { op: 'unlockSlots', inv: ship.id, x: 4, y: 2 });
  assert.ok(S.sessionView(s).containers.find((c) => c.group === 'Starships').inventories[0].valid.includes('4,2'));
  assert.throws(() => S.addOp(s, { op: 'unlockSlots', inv: ship.id, x: 4, y: 2 }), /already unlocked/);
  assert.throws(() => S.addOp(s, { op: 'unlockSlots', inv: ship.id, x: 9, y: 9 }), /outside/);
  S.addOp(s, { op: 'unlockSlots', inv: ship.id });
  assert.throws(() => S.addOp(s, { op: 'unlockSlots', inv: ship.id }), /already unlocked/);
  const chest = S.sessionView(s).containers.find((c) => c.title === 'Supplies').inventories[0];
  assert.throws(() => S.addOp(s, { op: 'unlockSlots', inv: chest.id }), /slot limit/);
  const r = await S.commit(s);
  assert.ok(r.ok, JSON.stringify(r.checks.filter((c) => !c.ok)));
  const valid = readTree('save.hg').BaseContext.PlayerStateData.ShipOwnership[0].Inventory.ValidSlotIndices;
  assert.deepEqual(valid, Array.from({ length: 15 }, (_, i) => ({ X: i % 5, Y: Math.floor(i / 5) })));
});

test('account file round-trips; rewards need game data', () => {
  fresh();
  const s = S.openSession(ACCOUNT, 'accountdata.hg');
  assert.equal(S.sessionView(s).kind, 'account');
  assert.throws(() => S.addOp(s, { op: 'unlockRewards', list: 'titles', ids: ['T_TRA2'] }), /isn't one of/);
});

test('backups can be listed with their size, deleted one at a time and trimmed', async () => {
  fresh();
  const stamp = (file, n) => {
    const s = S.openSession(ACCOUNT, file);
    S.addOp(s, { op: 'setCurrency', field: 'Units', value: 1000 + n });
    return S.commit(s);
  };
  const start = S.backupsView(ACCOUNT).list.length;
  await stamp('save.hg', 1);
  await new Promise((r) => setTimeout(r, 5));
  await stamp('save.hg', 2);
  await new Promise((r) => setTimeout(r, 5));
  await stamp('save3.hg', 3);

  let v = S.backupsView(ACCOUNT);
  assert.equal(v.list.length, start + 3);
  assert.ok(v.folder.includes(ACCOUNT));
  assert.ok(v.list.every((b) => b.size > 0));
  assert.equal(v.totalSize, v.list.reduce((n, b) => n + b.size, 0));

  // Only ids from the listing are accepted: nothing outside the backup folder can be reached.
  for (const bad of ['../..', '..', '', 'nope', `${v.list[0].id}/../..`]) assert.throws(() => S.deleteBackup(ACCOUNT, bad), /Unknown backup/);
  assert.throws(() => S.deleteBackup('../..', v.list[0].id), /Unknown account/);
  assert.ok(fs.existsSync(path.join(dir, 'save.hg')));

  const gone = v.list.find((b) => b.file === 'save.hg').id;
  v = S.deleteBackup(ACCOUNT, gone);
  assert.ok(!v.list.some((b) => b.id === gone));

  v = S.deleteOlderBackups(ACCOUNT);
  const files = v.list.map((b) => b.file);
  assert.equal(new Set(files).size, files.length); // one per save
  assert.ok(files.includes('save.hg') && files.includes('save3.hg'));
  assert.equal(v.older.count, 0);
  assert.ok(fs.existsSync(path.join(dir, 'save.hg')));
  assert.equal(readTree('save.hg').BaseContext.PlayerStateData.Units, 1002);
});
