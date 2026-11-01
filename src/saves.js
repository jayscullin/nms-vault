// Save discovery, editing sessions, and the verified write pipeline.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { decodeSave, encodeSave } from './codec.js';
import { parse, stringify, toDisplay } from './losslessJson.js';
import { deobfuscate, obfuscate, loadMapping } from './keys.js';
import { decryptMeta, encryptMeta, archiveNumberFor, META_MAGIC } from './manifest.js';
import { catalog, indexCatalog, view, applyOp, inventoryProblems, get, stackGroupOf, OpError } from './inventory.js';
import { diffTrees } from './validate.js';
import { describe, stackRule } from './gamedata/index.js';

const here = path.dirname(new URL(import.meta.url).pathname);
export const mapping = loadMapping(path.join(here, '..', 'data', 'mapping.json'));

const META_SIZE_WORD = 14; // decompressed size (text + NUL) in Frontiers-era and later manifests
const SAVE_FILE = /^save\d*\.hg$/;

export const vaultHome = process.env.NMS_VAULT_HOME ?? path.join(os.homedir(), '.nms-vault');
const backupRoot = path.join(vaultHome, 'backups');

export function saveRoots() {
  if (process.env.NMS_SAVE_ROOT) return [process.env.NMS_SAVE_ROOT];
  const home = os.homedir();
  if (process.platform === 'darwin') return [path.join(home, 'Library/Application Support/HelloGames/NMS')];
  if (process.platform === 'win32') return [path.join(process.env.APPDATA ?? path.join(home, 'AppData/Roaming'), 'HelloGames/NMS')];
  return [
    path.join(home, '.local/share/Steam/steamapps/compatdata/275850/pfx/drive_c/users/steamuser/AppData/Roaming/HelloGames/NMS'),
    path.join(home, '.steam/steam/steamapps/compatdata/275850/pfx/drive_c/users/steamuser/AppData/Roaming/HelloGames/NMS'),
  ];
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Saves pair up into slots: save.hg + save2.hg = slot 1, save3.hg + save4.hg = slot 2, ...
const slotOf = (file) => Math.ceil((archiveNumberFor(file) - 1) / 2);

// What the game's load screen shows for a save. Plain JSON.parse is fine here:
// this is read-only and never re-serialised.
function peekSummary(text) {
  const t = JSON.parse(deobfuscate(text, mapping));
  const ps = t.BaseContext?.PlayerStateData ?? {};
  const common = t.CommonStateData ?? {};
  const str = (v) => (typeof v === 'string' && v ? toDisplay(v) : null);
  return {
    name: str(common.SaveName),
    summary: str(ps.SaveSummary),
    playTime: common.TotalPlayTime ?? null,
    savedAt: ps.TimeStamp > 0 ? new Date(ps.TimeStamp * 1000).toISOString() : null,
    difficulty: ps.DifficultyState?.Preset?.DifficultyPresetType ?? null,
    season: common.SeasonData?.SeasonId > 0 ? common.SeasonData.SeasonId : null,
    platform: str(t.Platform),
  };
}

const summaryCache = new Map();

export function listAccounts() {
  const accounts = [];
  for (const root of saveRoots()) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !(entry.name.startsWith('st_') || entry.name === 'DefaultUser')) continue;
      const dir = path.join(root, entry.name);
      const slots = fs
        .readdirSync(dir)
        .filter((f) => SAVE_FILE.test(f))
        .map((file) => {
          const full = path.join(dir, file);
          const stat = fs.statSync(full);
          const cacheKey = `${full}:${stat.mtimeMs}:${stat.size}`;
          let info = summaryCache.get(cacheKey);
          if (!info) {
            try {
              info = peekSummary(decodeSave(fs.readFileSync(full)).text);
            } catch (e) {
              info = { error: e.message };
            }
            summaryCache.set(cacheKey, info);
          }
          return { file, slot: slotOf(file), size: stat.size, mtime: stat.mtime.toISOString(), hasManifest: fs.existsSync(path.join(dir, `mf_${file}`)), ...info };
        })
        .sort((a, b) => archiveNumberFor(a.file) - archiveNumberFor(b.file));
      accounts.push({
        id: entry.name,
        dir,
        kind: entry.name === 'DefaultUser' ? 'GOG' : 'Steam',
        slots,
      });
    }
  }
  return accounts;
}

export function resolveSave(accountId, file) {
  const account = listAccounts().find((a) => a.id === accountId);
  if (!account) throw new OpError('Unknown account');
  if (!SAVE_FILE.test(file) || !account.slots.some((s) => s.file === file)) throw new OpError('Unknown save file');
  return { account, savePath: path.join(account.dir, file), metaPath: path.join(account.dir, `mf_${file}`) };
}

// Newer manifests repeat the decompressed size (e.g. word 21) and add the
// compressed file size (word 15); older ones leave those zero. Every copy is
// located by value so all of them get updated together.
const META_SIZE_RANGE = [META_SIZE_WORD, 24];
const META_COMPRESSED_WORD = 15;

function readMeta(metaPath, file, textLength, fileSize) {
  if (!fs.existsSync(metaPath)) return null;
  const enc = fs.readFileSync(metaPath);
  const dec = decryptMeta(enc, archiveNumberFor(file));
  const magic = dec.readUInt32LE(0) === META_MAGIC;
  const decWords = [];
  const compWords = [];
  if (magic) {
    for (let w = META_SIZE_RANGE[0]; w <= META_SIZE_RANGE[1]; w++) {
      const v = dec.readUInt32LE(w * 4);
      if (v === textLength + 1) decWords.push(w);
      else if (v === fileSize) compWords.push(w);
    }
  }
  const comp = magic ? dec.readUInt32LE(META_COMPRESSED_WORD * 4) : 0;
  const sizeOk = decWords.includes(META_SIZE_WORD) && (comp === 0 || comp === fileSize);
  return { enc, dec, magic, sizeOk, decWords, compWords, format: magic ? dec.readUInt32LE(4) : null };
}

// Read-only proof that this tool can rewrite the save without changing a byte.
export function verifyRoundTrip(accountId, file) {
  const { savePath, metaPath } = resolveSave(accountId, file);
  const checks = [];
  const check = (name, fn) => {
    try {
      const r = fn();
      checks.push({ name, ok: r !== false, detail: typeof r === 'string' ? r : undefined });
    } catch (e) {
      checks.push({ name, ok: false, detail: e.message });
    }
  };
  const buf = fs.readFileSync(savePath);
  let d, readable, text2;
  check('Decompress save', () => { d = decodeSave(buf); return `${d.chunks} chunks, ${(d.text.length / 1e6).toFixed(1)} MB JSON`; });
  check('Translate keys', () => { readable = deobfuscate(d.text, mapping); return `mapping ${mapping.version}`; });
  check('Parse and re-serialise exactly', () => { text2 = obfuscate(stringify(parse(readable)), mapping); return text2 === d.text; });
  check('Recompress and decode exactly', () => decodeSave(encodeSave(text2, { compressed: d.compressed })).text === d.text);
  check('Manifest decrypts and matches', () => {
    const meta = readMeta(metaPath, file, d.text.length, buf.length);
    if (!meta) return 'no manifest file';
    if (!meta.magic) throw new Error('manifest did not decrypt');
    if (!meta.sizeOk) throw new Error('manifest size fields do not match this save');
    return `format ${meta.format}, ${meta.decWords.length + meta.compWords.length} size field(s)`;
  });
  return { file, ok: checks.every((c) => c.ok), checks };
}

// ---- Stack limits -----------------------------------------------------------

// Decides an item's stack limit in a given inventory, trusting the game first:
// 1. a limit the game already wrote for the same item in the same stack group;
// 2. otherwise the game's rule (base x multiplier), but only for stack groups
//    where the rule reproduces every limit the game wrote in this save.
// Anything else is unknown (null), and moves that would need it are refused.
function stackPolicy(tree, containers) {
  const ps = get(tree, ['BaseContext', 'PlayerStateData']);
  const difficulty = ps.DifficultyState?.Settings?.InventoryStackLimits?.InventoryStackLimitsDifficulty ?? 'Normal';
  const written = new Map();
  const groups = new Map();
  for (const c of containers) {
    for (const info of c.inventories) {
      const inv = get(tree, info.path);
      const group = stackGroupOf(inv);
      for (const slot of inv.Slots) {
        const type = slot.Type?.InventoryType;
        if (type !== 'Product' && type !== 'Substance') continue;
        const max = num0(slot.MaxAmount);
        const key = `${group}|${slot.Id}`;
        if (!written.has(key)) written.set(key, new Set());
        written.get(key).add(max);
        const rule = stackRule(slot.Id, type, group, difficulty);
        if (rule === null) continue;
        const g = groups.get(`${group}|${type}`) ?? { agree: 0, disagree: 0, examples: [] };
        if (rule === max) g.agree++;
        else {
          g.disagree++;
          if (g.examples.length < 3) g.examples.push(`${toDisplay(slot.Id)}: game ${max}, rule ${rule}`);
        }
        groups.set(`${group}|${type}`, g);
      }
    }
  }
  const trusted = (group, type) => {
    const g = groups.get(`${group}|${type}`);
    return Boolean(g && g.agree > 0 && g.disagree === 0);
  };
  return {
    difficulty,
    groups,
    limitFor(slot, inv) {
      const group = stackGroupOf(inv);
      const type = slot.Type?.InventoryType;
      const seen = written.get(`${group}|${slot.Id}`);
      const known = seen?.size === 1 ? [...seen][0] : null;
      if (seen && seen.size > 1) return null;
      const rule = trusted(group, type) ? stackRule(slot.Id, type, group, difficulty) : null;
      if (known !== null && rule !== null && known !== rule) return null;
      return known ?? rule;
    },
  };
}

// Every product/substance in the given inventories must carry the stack limit
// the game would give it there. Returns problems not already present before.
function stackProblems(s, invPath, tree = s.work) {
  const check = (tree) => {
    const inv = get(tree, invPath);
    const out = [];
    for (const slot of inv.Slots) {
      const type = slot.Type?.InventoryType;
      if (type !== 'Product' && type !== 'Substance') continue;
      const expected = s.stacks.limitFor(slot, inv);
      const max = num0(slot.MaxAmount);
      if (expected === null) out.push(`${toDisplay(slot.Id)} has an unconfirmed stack limit (${max})`);
      else if (max !== expected) out.push(`${toDisplay(slot.Id)} has stack limit ${max}; the game uses ${expected}`);
    }
    return out;
  };
  const before = check(s.origTree);
  return check(tree).filter((p) => !before.includes(p));
}

// ---- Sessions ---------------------------------------------------------------

const sessions = new Map();

export function openSession(accountId, file) {
  const { account, savePath, metaPath } = resolveSave(accountId, file);
  const original = fs.readFileSync(savePath);
  const decoded = decodeSave(original);
  const readable = deobfuscate(decoded.text, mapping);
  const tree = parse(readable);
  const containers = catalog(tree);
  const s = {
    id: crypto.randomUUID(),
    account,
    file,
    savePath,
    metaPath,
    originalHash: sha(original),
    originalSize: original.length,
    metaHash: fs.existsSync(metaPath) ? sha(fs.readFileSync(metaPath)) : null,
    compressed: decoded.compressed,
    text: decoded.text,
    readable,
    origTree: tree,
    containers,
    cat: indexCatalog(containers),
    stacks: stackPolicy(tree, containers),
    ops: [],
    warnings: [],
    work: null,
  };
  s.work = parse(readable);
  sessions.set(s.id, s);
  return s;
}

export function getSession(id) {
  const s = sessions.get(id);
  if (!s) throw new OpError('Session expired; reopen the save');
  return s;
}

export function sessionView(s) {
  const v = view(s.work, s.containers);
  // Item info is sent once per distinct id rather than per slot.
  const items = {};
  for (const c of v.containers) for (const inv of c.inventories) for (const slot of inv.slots) if (!(slot.id in items)) items[slot.id] = describe(slot.id);
  return {
    sessionId: s.id,
    account: s.account.id,
    file: s.file,
    ops: s.ops.length,
    warnings: s.warnings,
    version: num0(s.origTree.Version),
    summary: toDisplay(get(s.origTree, ['BaseContext', 'PlayerStateData', 'SaveSummary']) ?? ''),
    items,
    ...v,
  };
}

const num0 = (v) => (JSON.isRawJSON(v) ? Number(v.rawJSON) : v);

// Item ids in messages ("^GEODE_LAND") become their in-game names where known.
const nameIds = (text) => text.replace(/\^[A-Z0-9_]+(?:#\d+)?/g, (id) => describe(id)?.name ?? id);

// Applies to a scratch copy first, so a rejected op never corrupts the working tree.
export function addOp(s, op) {
  try {
    applyToSession(s, op);
  } catch (e) {
    if (e instanceof OpError) throw new OpError(nameIds(e.message));
    throw e;
  }
}

function applyToSession(s, op) {
  const scratch = parse(stringify(s.work));
  const { touched, warnings } = applyOp(scratch, s.cat, s.stacks, op);
  for (const p of touched) {
    if (p.at(-1) !== 'Slots') continue;
    const before = inventoryProblems(get(s.origTree, p.slice(0, -1)));
    const fresh = inventoryProblems(get(scratch, p.slice(0, -1))).filter((x) => !before.includes(x));
    fresh.push(...stackProblems(s, p.slice(0, -1), scratch));
    if (fresh.length) throw new OpError(fresh[0]);
  }
  s.work = scratch;
  s.ops.push({ op, touched });
  s.warnings.push(...warnings.map(nameIds));
}

export function undoOp(s) {
  s.ops.pop();
  replay(s);
}

export function resetOps(s) {
  s.ops = [];
  replay(s);
}

function replay(s) {
  const tree = parse(s.readable);
  s.warnings = [];
  for (const { op } of s.ops) s.warnings.push(...applyOp(tree, s.cat, s.stacks, op).warnings.map(nameIds));
  s.work = tree;
}

// ---- Review & commit --------------------------------------------------------

function isSteamRunning() {
  try {
    if (process.platform === 'win32') return execFileSync('tasklist', ['/FI', 'IMAGENAME eq steam.exe'], { encoding: 'utf8' }).includes('steam.exe');
    execFileSync('pgrep', ['-i', 'steam_osx|^steam$'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isGameRunning() {
  try {
    if (process.platform === 'win32') return execFileSync('tasklist', ['/FI', 'IMAGENAME eq NMS.exe'], { encoding: 'utf8' }).includes('NMS.exe');
    execFileSync('pgrep', ['-if', "no man's sky|NMS.exe"], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Builds the bytes to write and runs every check. Nothing is written here.
export function review(s) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  const fail = () => checks.some((c) => !c.ok);

  const allowed = s.ops.flatMap((o) => o.touched);
  const { changed, unexpected } = diffTrees(s.origTree, s.work, allowed);
  add('Only intended values changed', unexpected.length === 0, unexpected.length ? `Unexpected: ${unexpected.join(', ')}` : `${changed.length} region(s) changed`);

  const problems = allowed
    .filter((p) => p.at(-1) === 'Slots')
    .flatMap((p) => {
      const before = inventoryProblems(get(s.origTree, p.slice(0, -1)));
      return inventoryProblems(get(s.work, p.slice(0, -1))).filter((x) => !before.includes(x));
    });
  add('Inventory rules hold', problems.length === 0, problems.slice(0, 3).join('; ') || undefined);

  const stackIssues = allowed.filter((p) => p.at(-1) === 'Slots').flatMap((p) => stackProblems(s, p.slice(0, -1)));
  add('Stack limits match the game', stackIssues.length === 0, stackIssues.slice(0, 3).join('; ') || `${s.stacks.difficulty} stack limits`);

  const readable = stringify(s.work);
  const text = obfuscate(readable, mapping);
  add('Keys translate back exactly', deobfuscate(text, mapping) === readable);
  add('Re-parse matches edits', !fail() && diffTrees(s.work, parse(readable), []).unexpected.length === 0);

  const bytes = encodeSave(text, { compressed: s.compressed });
  add('Compressed data decodes exactly', decodeSave(bytes).text === text, `${(bytes.length / 1024).toFixed(0)} KiB`);

  const ratio = text.length / s.text.length;
  add('Size is plausible', ratio > 0.95 && ratio < 1.05, `${((ratio - 1) * 100).toFixed(3)}% size change`);

  let metaBytes = null;
  const meta = readMeta(s.metaPath, s.file, s.text.length, s.originalSize);
  if (!meta) add('Manifest', true, 'none for this save');
  else if (!meta.magic || !meta.sizeOk) add('Manifest format recognised', false, 'Unrecognised manifest; refusing to write');
  else {
    const dec = Buffer.from(meta.dec);
    for (const w of meta.decWords) dec.writeUInt32LE(text.length + 1, w * 4);
    for (const w of meta.compWords) dec.writeUInt32LE(bytes.length, w * 4);
    metaBytes = encryptMeta(dec, archiveNumberFor(s.file));
    const back = decryptMeta(metaBytes, archiveNumberFor(s.file));
    const sizesOk = meta.decWords.every((w) => back.readUInt32LE(w * 4) === text.length + 1) && meta.compWords.every((w) => back.readUInt32LE(w * 4) === bytes.length);
    add('Manifest updated and verified', back.equals(dec) && sizesOk, `format ${meta.format}; updated size words ${[...meta.decWords, ...meta.compWords].sort((a, b) => a - b).join(', ')}`);
  }

  const onDisk = fs.readFileSync(s.savePath);
  add('Save unchanged on disk since opening', sha(onDisk) === s.originalHash, sha(onDisk) === s.originalHash ? undefined : 'The game or another tool wrote this save; reopen it');
  if (s.metaHash) add('Manifest unchanged on disk since opening', sha(fs.readFileSync(s.metaPath)) === s.metaHash);
  const running = isGameRunning();
  add('Game is not running', !running, running ? 'Close No Man’s Sky before writing' : undefined);
  add('There are changes to write', s.ops.length > 0);

  const notices = [];
  if (s.account.kind === 'Steam' && isSteamRunning()) {
    notices.push('Steam is running. Steam Cloud uploads this change on next sync, and can replace it if another device has a newer save.');
  }

  return { ok: !fail(), checks, notices, bytes: fail() ? null : bytes, metaBytes, text };
}

async function writeAtomic(target, bytes) {
  const tmp = `${target}.nmsvault-tmp`;
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, target);
}

export async function backup(s, reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(backupRoot, s.account.id, `${stamp}_${s.file.replace('.hg', '')}`);
  await fsp.mkdir(dir, { recursive: true });
  const files = [s.file, `mf_${s.file}`].filter((f) => fs.existsSync(path.join(s.account.dir, f)));
  for (const f of files) {
    const src = path.join(s.account.dir, f);
    await fsp.copyFile(src, path.join(dir, f));
    if (sha(await fsp.readFile(src)) !== sha(await fsp.readFile(path.join(dir, f)))) throw new Error(`Backup of ${f} did not verify`);
  }
  await fsp.writeFile(path.join(dir, 'backup.json'), JSON.stringify({ account: s.account.id, sourceDir: s.account.dir, file: s.file, files, reason, created: new Date().toISOString() }, null, 2));
  return dir;
}

export async function commit(s) {
  const r = review(s);
  if (!r.ok) return { ok: false, checks: r.checks };
  const backupDir = await backup(s, `Before writing ${s.ops.length} change(s)`);
  try {
    await writeAtomic(s.savePath, r.bytes);
    if (r.metaBytes) await writeAtomic(s.metaPath, r.metaBytes);
    const back = fs.readFileSync(s.savePath);
    if (!back.equals(r.bytes) || decodeSave(back).text !== r.text) throw new Error('Read-back did not match');
    if (r.metaBytes && !fs.readFileSync(s.metaPath).equals(r.metaBytes)) throw new Error('Manifest read-back did not match');
  } catch (e) {
    await restoreFiles(backupDir, s.account.dir);
    return { ok: false, checks: [...r.checks, { name: 'Write', ok: false, detail: `${e.message}; original restored from backup` }] };
  }
  sessions.delete(s.id);
  return { ok: true, checks: [...r.checks, { name: 'Written and read back', ok: true }], backupDir };
}

// ---- Backups ----------------------------------------------------------------

export function listBackups(accountId) {
  const dir = path.join(backupRoot, accountId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((d) => fs.existsSync(path.join(dir, d, 'backup.json')))
    .map((d) => ({ id: d, ...JSON.parse(fs.readFileSync(path.join(dir, d, 'backup.json'), 'utf8')) }))
    .sort((a, b) => b.created.localeCompare(a.created));
}

async function restoreFiles(backupDir, targetDir) {
  const { files } = JSON.parse(await fsp.readFile(path.join(backupDir, 'backup.json'), 'utf8'));
  for (const f of files) await writeAtomic(path.join(targetDir, f), await fsp.readFile(path.join(backupDir, f)));
}

export async function restoreBackup(accountId, backupId) {
  const account = listAccounts().find((a) => a.id === accountId);
  if (!account) throw new OpError('Unknown account');
  const b = listBackups(accountId).find((x) => x.id === backupId);
  if (!b) throw new OpError('Unknown backup');
  if (isGameRunning()) throw new OpError('Close No Man’s Sky before restoring');
  // Restoring is itself reversible: snapshot the current files first.
  const current = { account, file: b.file };
  const safety = await backup(current, `Before restoring ${backupId}`);
  await restoreFiles(path.join(backupRoot, accountId, backupId), account.dir);
  return { restored: b.file, safety };
}
