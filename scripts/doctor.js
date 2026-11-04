#!/usr/bin/env node
// Read-only check of how NMS Vault sees this machine: run `npm run doctor` and share the
// report. It never writes to saves or game files; its cache goes in a temporary folder.
// NMS_SAVE_ROOT and NMS_GAME_DIR point it at other folders, such as a mounted PC's.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nms-vault-doctor-'));
process.env.NMS_VAULT_HOME = temp;

const S = await import('../src/saves.js');
const G = await import('../src/gamedata/index.js');
const { gameDataDirs, findGameData, steamLibraries } = await import('../src/gamedata/itemdb.js');
const { HgPak } = await import('../src/gamedata/hgpak.js');
const { SHIP_KINDS, FREIGHTER_KINDS } = await import('../src/inventory.js');

let failed = 0;
const line = (status, name, detail = '') => {
  if (status === 'FAIL') failed++;
  console.log(`${status.padEnd(4)}  ${name}${detail ? `: ${detail}` : ''}`);
};
const attempt = (name, fn) => {
  try {
    const r = fn();
    line(r === false ? 'FAIL' : 'ok', name, typeof r === 'string' ? r : '');
  } catch (e) {
    line('FAIL', name, e.message);
  }
};

console.log(`NMS Vault doctor · ${process.platform} ${process.arch} · ${os.release()} · Node ${process.version}\n`);
line(zlib.zstdDecompressSync ? 'ok' : 'FAIL', 'Node can read zstd archives (Windows, Linux)', zlib.zstdDecompressSync ? '' : 'needs Node 22.15 or newer');

console.log('\nSaves');
if (!process.env.NMS_SAVE_ROOT && process.platform !== 'win32' && process.platform !== 'darwin') console.log(`      Steam libraries: ${steamLibraries().join(', ') || 'none'}`);
for (const root of S.saveRoots()) line(fs.existsSync(root) ? 'ok' : 'miss', 'Save folder', root);
const accounts = S.listAccounts();
line(accounts.length ? 'ok' : 'FAIL', 'Accounts found', accounts.map((a) => `${a.kind} (${a.slots.length} saves${a.accountFile ? ', rewards file' : ''})`).join(', ') || 'none');
for (const a of accounts) {
  for (const s of a.slots) {
    attempt(`Verify ${a.kind} ${s.file}`, () => {
      const r = S.verifyRoundTrip(a.id, s.file);
      if (!r.ok) throw new Error(r.checks.filter((c) => !c.ok).map((c) => c.name).join('; '));
      return `${s.summary ?? 'no summary'}, round trip exact`;
    });
  }
}

console.log('\nGame files');
const dir = findGameData();
line(dir ? 'ok' : 'FAIL', 'Game data folder', dir ?? `not found; set NMS_GAME_DIR. Looked in ${gameDataDirs().length} places`);
if (dir) {
  const kinds = {};
  for (const f of fs.readdirSync(dir).filter((x) => /\.pak$/i.test(x))) {
    try {
      const pak = new HgPak(path.join(dir, f));
      const fd = fs.openSync(pak.file, 'r');
      const chunk = pak.chunks.find((c) => c.size !== 0x20000);
      const head = Buffer.alloc(4);
      if (chunk) fs.readSync(fd, head, 0, 4, chunk.pos);
      fs.closeSync(fd);
      const kind = !pak.compressed ? 'uncompressed' : !chunk ? 'stored' : head.readUInt32LE(0) === 0xfd2fb528 ? 'zstd' : 'other (treated as lz4)';
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      pak.close();
    } catch (e) {
      line('FAIL', `Archive ${f}`, e.message);
    }
  }
  line('ok', 'Archive compression', JSON.stringify(kinds));

  const status = G.initGameData(temp);
  line(status.available ? 'ok' : 'FAIL', 'Item data', status.available ? `${status.items} items` : status.reason);
  if (status.available) {
    attempt('Item names', () => (G.itemInfo('^FUEL1') && G.describe('^FUEL1')?.name === 'Carbon' ? 'Carbon' : false));
    attempt('Technology facts', () => {
      const t = G.itemInfo('^LASER');
      return t?.core === true || t?.core === false ? (t.charge === 200 ? `core flag and charge read` : false) : false;
    });
    attempt('Fit lists', () => {
      const n = G.searchTechnology('', [1]).length;
      return n > 0 ? `${n} for a multi-tool` : false;
    });
    attempt('Icon', () => {
      const png = G.iconPng('FUEL1');
      return png?.length > 100 ? `${png.length} bytes` : false;
    });
    attempt('Fixed 3D model', () => `${(G.modelBinary('MODELS/COMMON/SPACECRAFT/FIGHTERS/WRACER.SCENE.MBIN').length / 1e6).toFixed(1)} MB`);
    for (const k of [...SHIP_KINDS, ...FREIGHTER_KINDS]) attempt(`Example model: ${k.label}`, () => `${(G.modelBinary(k.scene, [], { example: true }).length / 1e6).toFixed(1)} MB`);
  }
}

fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
console.log(failed ? `\n${failed} check(s) failed. Please share this report.` : '\nAll checks passed. Nothing was changed.');
process.exit(failed ? 1 : 0);
