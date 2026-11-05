// Locating saves by hand. Runs without NMS_SAVE_ROOT, because that override wins
// over a chosen folder. NMS_VAULT_HOME keeps the choice out of the real settings.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFixtures, saveTree, writeSave, ACCOUNT } from './fixtures/build.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nms-vault-locate-'));
delete process.env.NMS_SAVE_ROOT;
process.env.NMS_VAULT_HOME = path.join(root, 'vault');
process.env.NMS_GAME_DIR = path.join(root, 'no-game');
const nms = path.join(root, 'with space', 'NMS');
buildFixtures(nms);
const S = await import('../src/saves.js');

test('the browser lists folders and counts saves without choosing anything', () => {
  const before = S.saveRoots();
  const f = S.browseFolders(path.dirname(nms));
  assert.deepEqual(f.dirs.map((d) => d.name), ['NMS']);
  assert.equal(f.found.saves, 0);
  const inside = S.browseFolders(f.dirs[0].path);
  assert.ok(inside.found.saves > 0);
  assert.equal(inside.found.accounts[0].id, ACCOUNT);
  assert.equal(inside.parent, path.dirname(nms));
  assert.deepEqual(S.saveRoots(), before);
  assert.ok(S.browseFolders(path.join(root, 'nope')).error);
});

test('a folder without saves is refused and changes nothing', () => {
  const before = S.saveRoots();
  assert.throws(() => S.setSaveFolder(root), /No saves/);
  assert.throws(() => S.setSaveFolder(path.join(root, 'nope')), /can’t be opened/);
  assert.deepEqual(S.saveRoots(), before);
  assert.equal(S.chosenSaveFolder(), null);
});

test('a chosen folder is used and remembered, until cleared', () => {
  S.setSaveFolder(nms);
  assert.deepEqual(S.saveRoots(), [nms]);
  assert.equal(S.listAccounts()[0].id, ACCOUNT);
  const settings = path.join(process.env.NMS_VAULT_HOME, 'settings.json');
  assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).saveFolder, nms);
  S.setSaveFolder(null);
  assert.equal(S.chosenSaveFolder(), null);
  assert.deepEqual(S.saveRoots(), S.autoSaveRoots());
});

test('an account’s own folder can be chosen, including one with another name', () => {
  S.setSaveFolder(path.join(nms, ACCOUNT));
  const [steam] = S.listAccounts();
  assert.equal(steam.id, ACCOUNT);
  assert.equal(steam.kind, 'Steam');
  const copy = path.join(root, 'PC copy');
  fs.mkdirSync(copy);
  writeSave(copy, 'save.hg', saveTree());
  S.setSaveFolder(copy);
  const [plain] = S.listAccounts();
  assert.equal(plain.id, 'PC copy');
  assert.equal(plain.kind, 'Folder');
  assert.equal(plain.slots.length, 1);
  S.setSaveFolder(null);
});

test('a backup never shows up for, or restores over, the same account in another folder', async () => {
  S.setSaveFolder(nms);
  const original = path.join(nms, ACCOUNT);
  const file = S.listAccounts()[0].slots[0].file;
  await S.backup({ account: S.listAccounts()[0], file }, 'test');
  assert.equal(S.listBackups(ACCOUNT).length, 1);

  const other = path.join(root, 'other pc', 'NMS');
  buildFixtures(other);
  S.setSaveFolder(other);
  assert.equal(S.listAccounts()[0].dir, path.join(other, ACCOUNT));
  assert.equal(S.listBackups(ACCOUNT).length, 0);
  assert.equal(S.backupsView(ACCOUNT).totalSize, 0);

  S.setSaveFolder(nms);
  assert.equal(S.listAccounts()[0].dir, original);
  assert.equal(S.listBackups(ACCOUNT).length, 1);
  S.setSaveFolder(null);
});

test('a chosen folder that goes missing lists nothing rather than failing', () => {
  const gone = path.join(root, 'unplugged');
  fs.mkdirSync(gone);
  writeSave(gone, 'save.hg', saveTree());
  S.setSaveFolder(gone);
  fs.rmSync(gone, { recursive: true });
  assert.deepEqual(S.listAccounts(), []);
  S.setSaveFolder(null);
});

test('a test run’s NMS_SAVE_ROOT beats a chosen folder and can’t be changed', () => {
  S.setSaveFolder(nms);
  process.env.NMS_SAVE_ROOT = path.join(root, 'test root');
  try {
    assert.deepEqual(S.saveRoots(), [path.join(root, 'test root')]);
    assert.equal(S.chosenSaveFolder(), null);
    assert.throws(() => S.setSaveFolder(nms), /NMS_SAVE_ROOT/);
  } finally {
    delete process.env.NMS_SAVE_ROOT;
  }
  S.setSaveFolder(null);
});

test('review warns that the game can only be seen on this computer', () => {
  S.setSaveFolder(nms);
  const s = S.openSession(ACCOUNT, S.listAccounts()[0].slots[0].file);
  assert.ok(S.review(s).notices.some((n) => n.includes('folder you chose')));
  S.setSaveFolder(null);
  assert.throws(() => S.getSession(s.id));
});
