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
import { describe, stackRule, stackBaseUniform, itemInfo, isAddable, searchItems, rewardCatalog, knowledgeCatalog } from './gamedata/index.js';
import { knowledgeState, applyKnowledgeOp } from './knowledge.js';
import { REWARD_LISTS, unlockedIds, applyRewardOp } from './rewards.js';

const here = path.dirname(new URL(import.meta.url).pathname);
export const mapping = loadMapping(path.join(here, '..', 'data', 'mapping.json'));

const META_SIZE_WORD = 14; // decompressed size (text + NUL) in Frontiers-era and later manifests
const SAVE_FILE = /^save\d*\.hg$/;
// Account-wide settings and unlocks, shared by every save slot.
export const ACCOUNT_FILE = 'accountdata.hg';

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
    universalId: typeof common.SaveUniversalId === 'string' ? common.SaveUniversalId : null,
    platform: str(t.Platform),
  };
}

const summaryCache = new Map();

// Save time recorded in a Frontiers-era (format 2002+) manifest, as the game shows it.
const META_SAVED_AT = 0x164;
function manifestSavedAt(metaPath, file) {
  try {
    const plain = decryptMeta(fs.readFileSync(metaPath), archiveNumberFor(file));
    if (plain.readUInt32LE(0) !== META_MAGIC || plain.readUInt32LE(4) < 2002 || plain.length < META_SAVED_AT + 4) return null;
    const seconds = plain.readUInt32LE(META_SAVED_AT);
    return seconds > 1e9 && seconds < 4e9 ? new Date(seconds * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

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
          const listed = { file, slot: slotOf(file), size: stat.size, mtime: stat.mtime.toISOString(), hasManifest: fs.existsSync(path.join(dir, `mf_${file}`)), ...info };
          // The game shows (and loads) whichever of a slot's two saves has the newer
          // manifest time, which can differ from the time inside the save.
          const shown = manifestSavedAt(path.join(dir, `mf_${file}`), file);
          if (shown) listed.savedAt = shown;
          return listed;
        })
        .sort((a, b) => archiveNumberFor(a.file) - archiveNumberFor(b.file));
      accounts.push({
        id: entry.name,
        dir,
        kind: entry.name === 'DefaultUser' ? 'GOG' : 'Steam',
        slots,
        accountFile: fs.existsSync(path.join(dir, ACCOUNT_FILE)),
      });
    }
  }
  return accounts;
}

export function resolveSave(accountId, file) {
  const account = listAccounts().find((a) => a.id === accountId);
  if (!account) throw new OpError('Unknown account');
  const known = file === ACCOUNT_FILE ? account.accountFile : SAVE_FILE.test(file) && account.slots.some((s) => s.file === file);
  if (!known) throw new OpError('Unknown save file');
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
//    where the rule reproduces every limit the game wrote in this save, or where
//    every stack group has the same base so the group cannot matter.
// Anything else is unknown (null), and moves that would need it are refused.
function stackPolicy(tree, containers) {
  const ps = get(tree, ['BaseContext', 'PlayerStateData']);
  const difficulty = ps.DifficultyState?.Settings?.InventoryStackLimits?.InventoryStackLimitsDifficulty ?? 'Normal';
  const written = new Map();
  const groups = new Map();
  const templates = new Map(); // first slot of each type, the shape for new slots
  for (const c of containers) {
    for (const info of c.inventories) {
      const inv = get(tree, info.path);
      const group = stackGroupOf(inv);
      for (const slot of inv.Slots) {
        const type = slot.Type?.InventoryType;
        if (!templates.has(type)) templates.set(type, slot);
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
  const verified = (group, type) => {
    const g = groups.get(`${group}|${type}`);
    return Boolean(g && g.agree > 0 && g.disagree === 0);
  };
  const contradicted = (type) => [...groups].some(([k, g]) => k.endsWith(`|${type}`) && g.disagree > 0);
  const trusted = (group, type) => verified(group, type) || (stackBaseUniform(type, difficulty) && !contradicted(type));
  return {
    difficulty,
    groups,
    // Whether any item of this type has a confirmed limit in this group. Items the
    // game already stores in the group are also allowed (see limitFor).
    trusted,
    item: itemInfo,
    name: (id) => describe(id)?.name ?? null,
    addable: isAddable,
    template: (type) => templates.get(type) ?? null,
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
  // The account file holds settings and unlocks, not inventories.
  const kind = file === ACCOUNT_FILE ? 'account' : 'save';
  const containers = kind === 'save' ? catalog(tree) : [];
  const s = {
    id: crypto.randomUUID(),
    kind,
    rewards: kind === 'account' ? rewardCatalog() : null,
    knowledge: kind === 'save' ? knowledgeCatalog() : null,
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
    stacks: kind === 'save' ? stackPolicy(tree, containers) : null,
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

function accountView(s) {
  const lists = {};
  for (const key of Object.keys(REWARD_LISTS)) {
    const unlocked = new Set(unlockedIds(s.work, key));
    const before = new Set(unlockedIds(s.origTree, key));
    lists[key] = {
      label: REWARD_LISTS[key].label,
      rewards: (s.rewards?.[key] ?? []).map((r) => ({ ...r, unlocked: unlocked.has(r.id), pending: unlocked.has(r.id) && !before.has(r.id) })),
    };
  }
  return { kind: 'account', sessionId: s.id, account: s.account.id, file: s.file, ops: s.ops.length, warnings: s.warnings, gamedata: Boolean(s.rewards), lists };
}

export function sessionView(s) {
  if (s.kind === 'account') return accountView(s);
  const v = view(s.work, s.containers);
  // Item info is sent once per distinct id rather than per slot.
  const items = {};
  for (const c of v.containers) for (const inv of c.inventories) for (const slot of inv.slots) if (!(slot.id in items)) items[slot.id] = describe(slot.id);
  // Which item types have a confirmed stack limit in each stack group, so the
  // page can refuse drop targets before the server has to.
  const stackTrust = {};
  for (const c of v.containers) {
    for (const inv of c.inventories) {
      if (inv.stackGroup && !(inv.stackGroup in stackTrust)) {
        stackTrust[inv.stackGroup] = { Product: s.stacks.trusted(inv.stackGroup, 'Product'), Substance: s.stacks.trusted(inv.stackGroup, 'Substance') };
      }
    }
  }
  return {
    stackTrust,
    stackDifficulty: s.stacks.difficulty,
    knowledge: knowledgeState(s.work, s.knowledge),
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

// Items that can be added to an inventory, with the stack limit each would get there.
export function addableItems(s, invId, query) {
  const info = s.cat.inventories.get(invId);
  if (!info) throw new OpError('Unknown inventory');
  const inv = get(s.work, info.path);
  return searchItems(query).map((item) => {
    const limit = s.stacks.limitFor({ Id: `^${item.id}`, Type: { InventoryType: item.type } }, inv);
    return { ...item, limit, reason: limit === null ? `The game’s stack limit for this item in ${info.where} can’t be confirmed` : undefined };
  });
}

// Where an item could be added: every inventory that takes new items, with its free
// unlocked cells and the game's stack limit for the item there (or why not).
export function addTargets(s, id) {
  const saveId = `^${String(id).replace(/^\^/, '')}`;
  const info = itemInfo(saveId);
  if (!info || !isAddable(saveId)) throw new OpError('Only named products and substances from the game data can be added');
  const out = [];
  for (const c of s.containers) {
    for (const inv of c.inventories) {
      if (inv.kind !== 'general' && inv.kind !== 'storage') continue;
      const v = get(s.work, inv.path);
      const used = new Set(v.Slots.map((x) => `${num0(x.Index.X)},${num0(x.Index.Y)}`));
      const free = v.ValidSlotIndices.map((i) => [num0(i.X), num0(i.Y)]).filter(([x, y]) => !used.has(`${x},${y}`));
      const limit = s.stacks.limitFor({ Id: saveId, Type: { InventoryType: info.type } }, v);
      out.push({
        inv: inv.id,
        where: inv.where,
        group: c.group,
        free: free.length,
        cell: free[0] ?? null,
        limit,
        reason: limit === null ? 'The game’s stack limit for this item here can’t be confirmed' : free.length === 0 ? 'No free unlocked cell' : undefined,
      });
    }
  }
  return out;
}

// Item ids in messages ("^GEODE_LAND") become their in-game names where known.
const nameIds = (text) => text.replace(/\^[A-Z0-9_]+(?:#\d+)?/g, (id) => describe(id)?.name ?? id);

// The tree locations an op may modify. Ops never change anything else (review's
// structural diff enforces that), so snapshotting these is enough to undo a
// rejected op without copying the whole multi-megabyte save.
function opScope(s, op) {
  const inv = (id) => s.cat.inventories.get(id)?.path;
  switch (op?.op) {
    case 'setAmount':
    case 'remove':
    case 'add':
    case 'sortInventory':
    case 'unlockSlots':
    case 'recharge':
    case 'repair': return [inv(op.inv)];
    case 'move': return [inv(op.from?.inv), inv(op.to?.inv)];
    case 'setCurrency': return [['BaseContext', 'PlayerStateData', op.field]];
    case 'rename': return [s.cat.names.get(op.target)];
    case 'unlockRewards': return [REWARD_LISTS[op.list] ? ['UserSettingsData', REWARD_LISTS[op.list].field] : undefined];
    case 'learnWords': return [['BaseContext', 'PlayerStateData', 'KnownWordGroups']];
    case 'learnBlueprints': return [['BaseContext', 'PlayerStateData', 'KnownTech'], ['BaseContext', 'PlayerStateData', 'KnownProducts']];
    default: return [undefined];
  }
}

function snapshot(tree, paths) {
  return paths.map((path) => {
    const parent = get(tree, path.slice(0, -1));
    const key = path.at(-1);
    const value = parent[key];
    return { parent, key, value: value !== null && typeof value === 'object' && !JSON.isRawJSON(value) ? parse(stringify(value)) : value };
  });
}

// Routes an op to the module that owns it.
function applyAny(s, tree, op) {
  if (s.kind === 'account') return applyRewardOp(tree, s.rewards, op);
  if (op?.op === 'learnWords' || op?.op === 'learnBlueprints') return applyKnowledgeOp(tree, s.knowledge, op);
  return applyOp(tree, s.cat, s.stacks, op);
}

// Applies an op to the working tree, rolling back its scope if it is rejected.
export function addOp(s, op) {
  try {
    applyToSession(s, op);
  } catch (e) {
    if (e instanceof OpError) throw new OpError(nameIds(e.message));
    throw e;
  }
}

function applyToSession(s, op) {
  const scope = opScope(s, op);
  // Unknown scope (bad op): work on a full copy instead, which is slow but safe.
  const scoped = scope.every((p) => p && get(s.work, p.slice(0, -1)));
  const tree = scoped ? s.work : parse(stringify(s.work));
  const saved = scoped ? snapshot(s.work, scope) : [];
  const rollback = () => {
    for (const { parent, key, value } of saved.reverse()) parent[key] = value;
  };
  try {
    const { touched, warnings } = applyAny(s, tree, op);
    for (const p of touched) {
      if (p.at(-1) !== 'Slots') continue;
      const before = inventoryProblems(get(s.origTree, p.slice(0, -1)));
      const fresh = inventoryProblems(get(tree, p.slice(0, -1))).filter((x) => !before.includes(x));
      fresh.push(...stackProblems(s, p.slice(0, -1), tree));
      if (fresh.length) throw new OpError(fresh[0]);
    }
    s.work = tree;
    s.ops.push({ op, touched });
    s.warnings.push(...warnings.map(nameIds));
  } catch (e) {
    rollback();
    throw e;
  }
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
  for (const { op } of s.ops) {
    const r = applyAny(s, tree, op);
    s.warnings.push(...r.warnings.map(nameIds));
  }
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

  if (s.kind === 'save') {
    const problems = allowed
      .filter((p) => p.at(-1) === 'Slots')
      .flatMap((p) => {
        const before = inventoryProblems(get(s.origTree, p.slice(0, -1)));
        return inventoryProblems(get(s.work, p.slice(0, -1))).filter((x) => !before.includes(x));
      });
    add('Inventory rules hold', problems.length === 0, problems.slice(0, 3).join('; ') || undefined);

    const stackIssues = allowed.filter((p) => p.at(-1) === 'Slots').flatMap((p) => stackProblems(s, p.slice(0, -1)));
    add('Stack limits match the game', stackIssues.length === 0, stackIssues.slice(0, 3).join('; ') || `${s.stacks.difficulty} stack limits`);
  } else {
    const known = new Set(Object.keys(REWARD_LISTS).flatMap((k) => (s.rewards?.[k] ?? []).map((r) => `${k}|${r.id}`)));
    const strays = Object.keys(REWARD_LISTS).flatMap((k) => unlockedIds(s.work, k).filter((id) => !unlockedIds(s.origTree, k).includes(id) && !known.has(`${k}|${id}`)));
    add('Only the game’s own rewards added', strays.length === 0, strays.slice(0, 3).join(', ') || undefined);
  }

  const readable = stringify(s.work);
  const text = obfuscate(readable, mapping);
  add('Keys translate back exactly', deobfuscate(text, mapping) === readable);
  add('Re-parse matches edits', !fail() && diffTrees(s.work, parse(readable), []).unexpected.length === 0);

  const bytes = encodeSave(text, { compressed: s.compressed });
  add('Compressed data decodes exactly', decodeSave(bytes).text === text, `${(bytes.length / 1024).toFixed(0)} KiB`);

  // The save must grow or shrink by exactly what the edited regions did: compact JSON
  // is compositional, so any other difference means something else changed.
  const regions = [...new Map(allowed.map((p) => [p.join('\u0000'), p])).values()].filter(
    (p, _, all) => !all.some((q) => q !== p && q.length < p.length && q.every((k, i) => String(k) === String(p[i]))),
  );
  const sized = (tree, p) => {
    const v = get(tree, p);
    return v === undefined ? 0 : stringify(v).length;
  };
  const expected = regions.reduce((n, p) => n + sized(s.work, p) - sized(s.origTree, p), 0);
  const actual = readable.length - s.readable.length;
  add('Size change matches the edits', actual === expected, `${actual >= 0 ? '+' : ''}${actual.toLocaleString()} bytes${actual === expected ? '' : `, expected ${expected.toLocaleString()}`}`);

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

export const backup = (s, reason) => backupFiles(s.account, [s.file], reason);

// Copies each save file (and its manifest) that exists into one verified backup.
async function backupFiles(account, saveFiles, reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(backupRoot, account.id, `${stamp}_${saveFiles.map((f) => f.replace('.hg', '')).join('+')}`);
  await fsp.mkdir(dir, { recursive: true });
  const files = saveFiles.flatMap((f) => [f, `mf_${f}`]).filter((f) => fs.existsSync(path.join(account.dir, f)));
  for (const f of files) {
    const src = path.join(account.dir, f);
    await fsp.copyFile(src, path.join(dir, f));
    if (sha(await fsp.readFile(src)) !== sha(await fsp.readFile(path.join(dir, f)))) throw new Error(`Backup of ${f} did not verify`);
  }
  await fsp.writeFile(path.join(dir, 'backup.json'), JSON.stringify({ account: account.id, sourceDir: account.dir, file: saveFiles.join(' + '), files, reason, created: new Date().toISOString() }, null, 2));
  return dir;
}

// ---- Save slot management ---------------------------------------------------

// The game uses save.hg … save30.hg (15 slots × 2).
export const SLOT_FILES = Array.from({ length: 30 }, (_, i) => (i === 0 ? 'save.hg' : `save${i + 1}.hg`));

// A save file's bytes plus its manifest re-keyed for another file name: the
// manifest's encryption key depends on the file name, the save data doesn't.
function rekeyed(account, from, to) {
  const data = fs.readFileSync(path.join(account.dir, from));
  const metaPath = path.join(account.dir, `mf_${from}`);
  if (!fs.existsSync(metaPath)) return { data, meta: null };
  const plain = decryptMeta(fs.readFileSync(metaPath), archiveNumberFor(from));
  if (plain.readUInt32LE(0) !== META_MAGIC) throw new OpError(`The manifest for ${from} isn't recognised`);
  const meta = encryptMeta(plain, archiveNumberFor(to));
  if (!decryptMeta(meta, archiveNumberFor(to)).equals(plain)) throw new Error('Re-keyed manifest did not verify');
  return { data, meta };
}

// The game identifies a save by CommonStateData.SaveUniversalId (newer saves only).
// Two slots with the same id are "multiple versions of this save" to the game, so a
// copy placed in another slot gets a fresh id. Newer manifests repeat the id at a
// fixed spot (little-endian u64), so it is replaced there too.
const UNIVERSAL_ID = /^0x[0-9A-F]{16}$/i;
const idBytes = (hex) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(hex));
  return b;
};

function withNewIdentity(account, from, to) {
  const savePath = path.join(account.dir, from);
  const buf = fs.readFileSync(savePath);
  const d = decodeSave(buf);
  const readable = deobfuscate(d.text, mapping);
  const tree = parse(readable);
  const oldId = tree.CommonStateData?.SaveUniversalId;
  if (typeof oldId !== 'string' || !UNIVERSAL_ID.test(oldId)) return { ...rekeyed(account, from, to), newId: null };
  const newId = `0x${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  tree.CommonStateData.SaveUniversalId = newId;

  const newReadable = stringify(tree);
  const { unexpected } = diffTrees(parse(readable), parse(newReadable), [['CommonStateData', 'SaveUniversalId']]);
  if (unexpected.length) throw new Error('Changing the save id altered other data');
  const text = obfuscate(newReadable, mapping);
  if (deobfuscate(text, mapping) !== newReadable) throw new Error('Keys did not translate back exactly');
  const data = encodeSave(text, { compressed: d.compressed });
  if (decodeSave(data).text !== text) throw new Error('Re-encoded save did not decode exactly');

  const meta = readMeta(path.join(account.dir, `mf_${from}`), from, d.text.length, buf.length);
  if (!meta) return { data, meta: null, newId };
  if (!meta.magic || !meta.sizeOk) throw new OpError(`The manifest for ${from} isn't recognised`);
  const plain = Buffer.from(meta.dec);
  for (const w of meta.decWords) plain.writeUInt32LE(text.length + 1, w * 4);
  for (const w of meta.compWords) plain.writeUInt32LE(data.length, w * 4);
  const oldBytes = idBytes(oldId);
  const at = plain.indexOf(oldBytes);
  if (at !== -1) {
    if (plain.indexOf(oldBytes, at + 1) !== -1) throw new OpError(`The manifest for ${from} holds its save id more than once; not changing it`);
    idBytes(newId).copy(plain, at);
  }
  const enc = encryptMeta(plain, archiveNumberFor(to));
  if (!decryptMeta(enc, archiveNumberFor(to)).equals(plain)) throw new Error('Re-keyed manifest did not verify');
  return { data, meta: enc, newId };
}

const partnerOf = (file) => SLOT_FILES[SLOT_FILES.indexOf(file) ^ 1];
const slotNumber = (file) => Math.floor(SLOT_FILES.indexOf(file) / 2) + 1;

async function writePair(account, file, { data, meta }) {
  await writeAtomic(path.join(account.dir, file), data);
  if (meta) await writeAtomic(path.join(account.dir, `mf_${file}`), meta);
  if (!fs.readFileSync(path.join(account.dir, file)).equals(data)) throw new Error(`Read-back of ${file} did not match`);
  if (meta && !fs.readFileSync(path.join(account.dir, `mf_${file}`)).equals(meta)) throw new Error(`Read-back of mf_${file} did not match`);
}

async function removePair(account, file) {
  for (const f of [file, `mf_${file}`]) await fsp.rm(path.join(account.dir, f), { force: true });
}

// op: copy (from -> to, overwriting), move (copy then delete from), swap, delete (from).
export async function slotOp(accountId, op, from, to) {
  const account = listAccounts().find((a) => a.id === accountId);
  if (!account) throw new OpError('Unknown account');
  const exists = (f) => fs.existsSync(path.join(account.dir, f));
  if (!SLOT_FILES.includes(from) || !exists(from)) throw new OpError('Choose an existing save');
  if (op !== 'delete' && (!SLOT_FILES.includes(to) || to === from)) throw new OpError('Choose a different target slot');
  if (op === 'swap' && !exists(to)) throw new OpError('Swap needs a save in both places; use Move instead');
  if (!['copy', 'move', 'swap', 'delete'].includes(op)) throw new OpError(`Unknown slot operation ${op}`);
  // A slot's two files are the same game (its latest and earlier saves). Copying or
  // moving into a slot whose other file holds a different save would mix two games.
  const otherSlot = op !== 'delete' && slotNumber(to) !== slotNumber(from);
  if ((op === 'copy' || op === 'move') && otherSlot && exists(partnerOf(to)) && partnerOf(to) !== from) {
    throw new OpError(`Slot ${slotNumber(to)} already holds another save in ${partnerOf(to)}; choose an empty slot`);
  }
  if (isGameRunning()) throw new OpError('Close No Man’s Sky first');

  const involved = op === 'delete' ? [from] : [from, to];
  const backupDir = await backupFiles(account, involved, `Before ${op} ${involved.join(' → ')}`);
  // Read everything before writing anything. A copy or move into another slot becomes a
  // separate save with its own id, so the game never sees two slots as one save.
  const fromPair = op === 'delete' ? null : (op === 'copy' || op === 'move') && otherSlot ? withNewIdentity(account, from, to) : rekeyed(account, from, to);
  const toPair = op === 'swap' ? rekeyed(account, to, from) : null;
  try {
    if (op === 'delete') await removePair(account, from);
    else {
      await writePair(account, to, fromPair);
      if (op === 'swap') await writePair(account, from, toPair);
      if (op === 'move') await removePair(account, from);
    }
  } catch (e) {
    // Put back what was there; a newly created target from a failed copy is removed.
    await restoreFiles(backupDir, account.dir);
    if (!JSON.parse(fs.readFileSync(path.join(backupDir, 'backup.json'), 'utf8')).files.includes(to)) await removePair(account, to);
    throw new Error(`${e.message}; original files restored`);
  }
  const verified = involved.filter(exists).map((f) => verifyRoundTrip(accountId, f));
  return {
    backupDir,
    newId: fromPair?.newId ?? null,
    verified: verified.every((v) => v.ok),
    checks: verified.flatMap((v) => v.checks.map((c) => ({ ...c, name: `${v.file}: ${c.name}` }))),
  };
}

// ---- Export -----------------------------------------------------------------

// The save as indented JSON with readable keys, for reading — not for re-import.
export function exportJson(accountId, file) {
  const { savePath } = resolveSave(accountId, file);
  const readable = deobfuscate(decodeSave(fs.readFileSync(savePath)).text, mapping);
  return { name: `${accountId}-${file.replace('.hg', '')}.json`, json: toDisplay(JSON.stringify(parse(readable), null, 2)) };
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
