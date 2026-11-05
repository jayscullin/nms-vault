#!/usr/bin/env node
// Builds the download for this computer's system into dist/: one executable holding
// Node, the app and its files, zipped with the licences and how to run it.
// Needs Node 25.5 or newer, because of `node --build-sea`.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const ROOT = path.join(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const WORK = path.join(DIST, 'work');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const { platform, arch } = process;
const NAME = `NMS-Vault-${version}-${{ darwin: 'macos', win32: 'windows' }[platform] ?? platform}-${arch}`;

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

// 1. One file of code.
const main = path.join(WORK, 'main.mjs');
await build({ entryPoints: [path.join(ROOT, 'server.js')], outfile: main, bundle: true, platform: 'node', format: 'esm', target: 'node25', logLevel: 'warning' });

// 2. The executable, with public/ and the key mapping inside it.
const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
const assets = Object.fromEntries([...walk('public'), 'data/mapping.json'].map((rel) => [rel, path.join(ROOT, rel)]));
const exe = path.join(WORK, platform === 'win32' ? 'NMS-Vault.exe' : 'nms-vault');
const config = path.join(WORK, 'sea-config.json');
fs.writeFileSync(config, JSON.stringify({ main, mainFormat: 'module', output: exe, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets }, null, 2));
run(process.execPath, ['--build-sea', config]);

// 3. Licences of everything inside it, and how to run it.
const stage = path.join(WORK, NAME);
const legal = path.join(stage, 'licences');
fs.mkdirSync(legal, { recursive: true });
const nodeDir = path.dirname(process.execPath);
const nodeLicence = [path.join(nodeDir, 'LICENSE'), path.join(nodeDir, '..', 'LICENSE')].find((f) => fs.existsSync(f));
if (!nodeLicence) throw new Error('Node’s LICENSE file is needed for the download, and it wasn’t found');
const copies = {
  'NMS-Vault-LICENSE.txt': 'LICENSE',
  'mapping-NOTICE.md': 'data/NOTICE.md',
  'LGPL-3.0.txt': 'data/LICENSE-LGPL-3.0.txt',
  'GPL-3.0.txt': 'data/LICENSE-GPL-3.0.txt',
  'Lucide-LICENSE.txt': 'public/vendor/LICENSE-lucide.txt',
};
for (const [to, from] of Object.entries(copies)) fs.copyFileSync(path.join(ROOT, from), path.join(legal, to));
fs.copyFileSync(nodeLicence, path.join(legal, 'Node.js-LICENSE.txt'));

const open = {
  darwin: 'Move NMS Vault to Applications and open it. The app isn’t notarized, so macOS blocks it the first time: open System Settings > Privacy & Security and choose Open Anyway. It has no Dock icon; it opens in your browser. If you close the tab while it’s running, go back to http://localhost:5280',
  win32: 'Run NMS-Vault.exe. The app isn’t signed, so Windows may say it protected your PC: choose More info, then Run anyway. It opens in your browser. Closing the black window stops it.',
  linux: 'Run ./nms-vault from this folder (on Steam Deck, in desktop mode). It opens in your browser.',
}[platform];
fs.writeFileSync(path.join(stage, 'READ ME FIRST.txt'), `NMS Vault ${version} (preview)

An unofficial, local inventory manager for No Man's Sky saves.
Not affiliated with or endorsed by Hello Games.

${open}

Close the game first. Every write is backed up in the .nms-vault folder in your home folder.
Use the power button in the top bar to stop NMS Vault.

This is a preview. Keep your own copy of any save you care about.
`);

if (platform === 'darwin') {
  // A bare program opens a Terminal window when double-clicked, so give it an app bundle.
  const app = path.join(stage, 'NMS Vault.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.copyFileSync(exe, path.join(app, 'Contents', 'MacOS', 'NMS Vault'));
  fs.chmodSync(path.join(app, 'Contents', 'MacOS', 'NMS Vault'), 0o755);
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>NMS Vault</string>
  <key>CFBundleDisplayName</key><string>NMS Vault</string>
  <key>CFBundleIdentifier</key><string>io.github.jayscullin.nms-vault</string>
  <key>CFBundleExecutable</key><string>NMS Vault</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>LSUIElement</key><true/>
</dict></plist>
`);
  run('codesign', ['--force', '--deep', '--sign', '-', app]);
} else {
  fs.copyFileSync(exe, path.join(stage, path.basename(exe)));
  if (platform === 'linux') fs.chmodSync(path.join(stage, path.basename(exe)), 0o755);
}

// 4. The download and its checksum.
const archive = path.join(DIST, `${NAME}.${platform === 'linux' ? 'tar.gz' : 'zip'}`);
if (platform === 'darwin') run('ditto', ['-c', '-k', '--norsrc', '--noextattr', '--keepParent', stage, archive]);
else if (platform === 'win32') run('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${stage}' -DestinationPath '${archive}'`]);
else run('tar', ['-czf', archive, '-C', WORK, NAME]);
const sum = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
fs.writeFileSync(`${archive}.sha256`, `${sum}  ${path.basename(archive)}\n`);

const program = platform === 'darwin' ? path.join(stage, 'NMS Vault.app', 'Contents', 'MacOS', 'NMS Vault') : path.join(stage, path.basename(exe));
fs.writeFileSync(path.join(DIST, 'program-path.txt'), program);
console.log(`Built ${path.relative(ROOT, archive)} (${(fs.statSync(archive).size / 1048576).toFixed(0)} MB)`);
