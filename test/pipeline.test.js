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

test('account file round-trips; rewards need game data', () => {
  fresh();
  const s = S.openSession(ACCOUNT, 'accountdata.hg');
  assert.equal(S.sessionView(s).kind, 'account');
  assert.throws(() => S.addOp(s, { op: 'unlockRewards', list: 'titles', ids: ['T_TRA2'] }), /isn't one of/);
});
