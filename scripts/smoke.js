#!/usr/bin/env node
// Runs the built executable against generated saves and goes through the things a
// packaged build could get wrong: built-in files, a full edit and write, a second launch, Quit.
// Never touches real saves: NMS_SAVE_ROOT points at a temporary folder.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFixtures, ACCOUNT } from '../test/fixtures/build.js';

const ROOT = path.join(import.meta.dirname, '..');
const program = process.argv[2] ?? fs.readFileSync(path.join(ROOT, 'dist', 'program-path.txt'), 'utf8');
const PORT = '5297';
const base = `http://localhost:${PORT}`;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nms-vault-smoke-'));
const saves = path.join(temp, 'saves');
buildFixtures(saves);
const env = { ...process.env, PORT, NMS_SAVE_ROOT: saves, NMS_VAULT_HOME: path.join(temp, 'vault'), NMS_GAME_DIR: path.join(temp, 'no-game') };
const start = () => spawn(program, ['--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const exited = (p) => new Promise((resolve) => p.on('exit', (code) => resolve(code)));
const step = (text) => console.log(`ok    ${text}`);

const server = start();
let output = '';
server.stdout.on('data', (d) => { output += d; });
server.stderr.on('data', (d) => { output += d; });
try {
  let html;
  for (let i = 0; i < 100 && !html; i++) {
    try {
      html = await (await fetch(`${base}/`)).text();
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(html, `The app didn't start:\n${output}`);
  assert.ok(!output.includes('ExperimentalWarning'), 'A warning is shown to the user');
  const token = /name="vault-token" content="([0-9a-f]+)"/.exec(html)?.[1];
  assert.ok(token, 'The page has no API token');
  step('starts and serves the page');

  for (const f of ['app.js', 'styles.css', 'icons.js', 'viewer.js', 'icon.svg']) assert.equal((await fetch(`${base}/${f}`)).status, 200, f);
  assert.equal((await fetch(`${base}/nope.js`)).status, 404);
  assert.equal((await fetch(`${base}/..%2fdata%2fmapping.json`)).status, 404);
  step('serves its built-in files, and nothing else');

  const api = async (route, body) => {
    const res = await fetch(`${base}/api/${route}`, { method: body ? 'POST' : 'GET', headers: { 'x-vault-token': token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    const json = await res.json();
    assert.equal(res.status, 200, `${route}: ${JSON.stringify(json)}`);
    return json;
  };
  const where = await api('where');
  assert.equal(where.packaged, true);
  const accounts = await api('accounts');
  assert.equal(accounts[0].id, ACCOUNT);
  assert.ok(!accounts[0].slots[0].error, 'The save list couldn’t read a save, so the built-in key mapping may be missing');
  step('reads saves with the built-in key mapping');

  const file = accounts[0].slots[0].file;
  assert.equal((await api('verify', { account: ACCOUNT, file })).ok, true);
  const view = await api('open', { account: ACCOUNT, file });
  const general = view.containers[0].inventories[0];
  const slot = general.slots[0];
  await api('op', { sessionId: view.sessionId, op: { op: 'setAmount', inv: general.id, x: slot.x, y: slot.y, amount: slot.amount + 1 } });
  const done = await api('commit', { sessionId: view.sessionId });
  assert.equal(done.ok, true, JSON.stringify(done.checks));
  assert.equal((await api('verify', { account: ACCOUNT, file })).ok, true);
  assert.equal((await api('backups', { account: ACCOUNT })).list.length, 1);
  step('edits, writes, backs up and verifies a save');

  const second = start();
  assert.equal(await exited(second), 0, 'A second launch should hand over to the running copy');
  await api('where');
  step('a second launch leaves the running copy alone');

  await api('quit', {});
  assert.equal(await exited(server), 0);
  step('stops when asked');
  console.log(`\nPassed: ${path.basename(program)}`);
} finally {
  server.kill();
  fs.rmSync(temp, { recursive: true, force: true });
}
