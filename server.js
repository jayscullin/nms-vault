#!/usr/bin/env node
// Local-only server for NMS Vault. Binds to 127.0.0.1, rejects foreign Host
// headers (DNS rebinding), and requires a per-launch token on every API call.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import * as saves from './src/saves.js';
import { OpError } from './src/inventory.js';
import { ModelError } from './src/gamedata/model.js';
import * as gamedata from './src/gamedata/index.js';

const PORT = Number(process.env.PORT ?? 5280);
const HOST = '127.0.0.1';
const TOKEN = crypto.randomBytes(24).toString('hex');
const PUBLIC = path.join(import.meta.dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const routes = {
  'GET /api/accounts': () => saves.listAccounts().map(({ dir, ...a }) => a),
  'GET /api/gamedata': () => gamedata.status(),
  // Where saves are read from and written to; testMode means a folder other than the game's.
  'GET /api/where': () => ({ saveRoots: saves.saveRoots(), usual: saves.autoSaveRoots(), chosen: saves.chosenSaveFolder(), testMode: Boolean(process.env.NMS_SAVE_ROOT), vaultHome: saves.vaultHome }),
  'POST /api/folder-browse': (b) => saves.browseFolders(b.path),
  'POST /api/folder-use': (b) => saves.setSaveFolder(b.path ?? null) ?? { ok: true },
  'POST /api/verify': (b) => saves.verifyRoundTrip(b.account, b.file),
  'POST /api/open': (b) => saves.sessionView(saves.openSession(b.account, b.file)),
  'POST /api/op': (b) => {
    const s = saves.getSession(b.sessionId);
    saves.addOp(s, b.op);
    return saves.sessionView(s);
  },
  'POST /api/catalog': (b) => saves.addableItems(saves.getSession(b.sessionId), b.inv, b.q),
  'POST /api/browse': (b) => gamedata.browseItems(b.q, b.type),
  'POST /api/add-targets': (b) => saves.addTargets(saves.getSession(b.sessionId), b.id),
  'POST /api/export': (b) => saves.exportJson(b.account, b.file),
  'POST /api/slot': (b) => saves.slotOp(b.account, b.op, b.from, b.to),
  'GET /api/slots': () => saves.SLOT_FILES,
  'POST /api/undo': (b) => {
    const s = saves.getSession(b.sessionId);
    saves.undoOp(s);
    return saves.sessionView(s);
  },
  'POST /api/reset': (b) => {
    const s = saves.getSession(b.sessionId);
    saves.resetOps(s);
    return saves.sessionView(s);
  },
  'POST /api/review': (b) => {
    const s = saves.getSession(b.sessionId);
    const { ok, checks, notices } = saves.review(s);
    return { ok, checks, ops: s.ops.map((o) => o.op), warnings: [...notices, ...s.warnings] };
  },
  'POST /api/commit': (b) => saves.commit(saves.getSession(b.sessionId)),
  'POST /api/backups': (b) => saves.backupsView(b.account),
  'POST /api/backup-delete': (b) => saves.deleteBackup(b.account, b.backup),
  'POST /api/backup-trim': (b) => saves.deleteOlderBackups(b.account),
  'POST /api/restore': (b) => saves.restoreBackup(b.account, b.backup),
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
  });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

async function readBody(req) {
  let size = 0;
  const parts = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1e6) throw new OpError('Request too large');
    parts.push(chunk);
  }
  return parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {};
}

const server = http.createServer(async (req, res) => {
  if (!allowedHosts.has(req.headers.host)) return send(res, 421, { error: 'Bad host' });
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/')) {
    if (req.headers['x-vault-token'] !== TOKEN) return send(res, 403, { error: 'Bad token; reload the page' });
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return send(res, 404, { error: 'Not found' });
    try {
      send(res, 200, await route(req.method === 'POST' ? await readBody(req) : {}));
    } catch (e) {
      if (!(e instanceof OpError)) console.error(e);
      send(res, e instanceof OpError ? 400 : 500, { error: e.message });
    }
    return;
  }

  // Item icons, rendered from the game's own textures. Looked up by item key only.
  const icon = /^\/icons\/([A-Za-z0-9_]+)\.png$/.exec(url.pathname);
  if (icon) {
    try {
      const png = gamedata.iconPng(icon[1]);
      if (!png) return send(res, 404, 'No icon', 'text/plain');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
      return res.end(png);
    } catch (e) {
      console.error(e);
      return send(res, 500, 'Icon failed', 'text/plain');
    }
  }

  // 3D models and their textures, decoded from the game files (read-only, game data only).
  const model = /^\/models\/(.+)\.bin$/.exec(url.pathname);
  if (model) {
    try {
      const parts = (url.searchParams.get('parts') ?? '').split(',').filter(Boolean);
      const bin = gamedata.modelBinary(decodeURIComponent(model[1]), parts, { example: url.searchParams.get('example') === '1' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
      return res.end(bin);
    } catch (e) {
      if (!(e instanceof ModelError)) console.error(e);
      return send(res, e instanceof ModelError ? 422 : 500, e instanceof ModelError ? e.message : 'Model failed', 'text/plain');
    }
  }
  const texture = /^\/textures\/(.+\.dds)\.png$/.exec(url.pathname);
  if (texture) {
    try {
      const png = gamedata.texturePng(decodeURIComponent(texture[1]));
      if (!png) return send(res, 404, 'No texture', 'text/plain');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
      return res.end(png);
    } catch (e) {
      console.error(e);
      return send(res, 500, 'Texture failed', 'text/plain');
    }
  }

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain');
  let body = fs.readFileSync(file);
  if (rel === 'index.html') body = body.toString('utf8').replace('__VAULT_TOKEN__', TOKEN);
  send(res, 200, body, TYPES[path.extname(file)] ?? 'application/octet-stream');
});

const gd = gamedata.initGameData(saves.vaultHome);

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`NMS Vault running at ${url}`);
  console.log(`Saves: ${saves.saveRoots().join(', ')}${process.env.NMS_SAVE_ROOT ? '  (NMS_SAVE_ROOT override — not the game folder)' : ''}`);
  console.log(`Backups: ${saves.vaultHome}`);
  console.log(gd.available ? `Item data: ${gd.items} items from ${gd.dir}` : `Item data unavailable: ${gd.reason}`);
  if (!process.argv.includes('--no-open')) {
    // Opening a browser is a convenience; the address above still works if it fails.
    const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
});
