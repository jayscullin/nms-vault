// End-to-end tests of the save pipeline (open, edit, review, write, verify)
// against generated fixture saves. No game data is needed.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFixtures, ACCOUNT, SAVE_ID } from './fixtures/build.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nms-vault-test-'));
process.env.NMS_SAVE_ROOT = path.join(root, 'saves');
process.env.NMS_VAULT_HOME = path.join(root, 'vault');
process.env.NMS_GAME_DIR = path.join(root, 'no-game');
const S = await import('../src/saves.js');
const { decodeSave } = await import('../src/codec.js');
const { deobfuscate } = await import('../src/keys.js');

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

test('account file round-trips; rewards need game data', () => {
  fresh();
  const s = S.openSession(ACCOUNT, 'accountdata.hg');
  assert.equal(S.sessionView(s).kind, 'account');
  assert.throws(() => S.addOp(s, { op: 'unlockRewards', list: 'titles', ids: ['T_TRA2'] }), /isn't one of/);
});
