// Game data service: item database plus icon rendering with a disk cache.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadItemDb, resolveItem } from './itemdb.js';
import { decodeDds, encodePng } from './dds.js';
import { ruleLimit } from './stacks.js';
import { loadModel, packModel, readCustomisationGroups, ModelError } from './model.js';
import { SHIP_KINDS, FREIGHTER_KINDS } from '../inventory.js';

let db = null;
let iconDir = null;

export function initGameData(vaultHome) {
  try {
    db = loadItemDb();
  } catch (e) {
    db = { available: false, reason: `Could not read game data: ${e.message}` };
  }
  if (db.available) {
    const sig = crypto.createHash('sha1').update(db.signature).digest('hex').slice(0, 12);
    iconDir = path.join(vaultHome, 'cache', `icons-${sig}`);
    fs.mkdirSync(iconDir, { recursive: true });
  }
  return status();
}

export function status() {
  if (!db?.available) return { available: false, reason: db?.reason ?? 'Not loaded' };
  return { available: true, items: Object.keys(db.items).length, dir: db.dir, built: db.built };
}

// Display info for a save item id, or null when the game data has no entry.
export function describe(saveId) {
  if (!db?.available) return null;
  const r = resolveItem(db.items, saveId);
  if (!r) return null;
  return { key: r.key, name: r.name, subtitle: r.subtitle, desc: r.desc, icon: Boolean(r.icon), generic: r.generic, core: r.core, chargeable: r.chargeable };
}

// Facts the edit rules need about an item, or null when the game data has no entry.
export function itemInfo(saveId) {
  if (!db?.available) return null;
  const r = resolveItem(db.items, saveId);
  return r && { key: r.key, type: r.type, stack: r.stack, core: r.core, chargeable: r.chargeable, procedural: Boolean(r.procedural), alias: r.alias ?? null };
}

// Unlockable account rewards with display info, or null without game data.
export function rewardCatalog() {
  if (!db?.available || !db.rewards) return null;
  const withInfo = (list) =>
    (list ?? []).map(({ id, item, name }) => {
      const r = resolveItem(db.items, item);
      return { id, item, key: r?.key ?? null, name: name ?? r?.name ?? null, subtitle: r?.subtitle ?? (name ? 'Player title' : null), icon: Boolean(r?.icon) };
    });
  return Object.fromEntries(['season', 'twitch', 'specials', 'titles'].map((k) => [k, withInfo(db.rewards[k])]));
}

// Per-save knowledge catalogue: word groups by race, and learnable blueprints with display info.
export function knowledgeCatalog() {
  if (!db?.available || !db.knowledge) return null;
  return {
    wordGroups: db.knowledge.wordGroups,
    blueprints: db.knowledge.blueprints.map((id) => {
      const r = resolveItem(db.items, id);
      return { id, type: r?.type, name: r?.name ?? null, subtitle: r?.subtitle ?? null, icon: Boolean(r?.icon) };
    }),
  };
}

// Item catalogue for browsing without a save: every named item, any type.
export function browseItems(query, type, limit = 200) {
  if (!db?.available) return [];
  const q = String(query ?? '').trim().toLowerCase();
  const out = [];
  for (const [id, item] of Object.entries(db.items)) {
    if (!item.name || (type && item.type !== type)) continue;
    if (q && !item.name.toLowerCase().includes(q) && !id.toLowerCase().includes(q)) continue;
    out.push({ id, type: item.type, name: item.name, subtitle: item.subtitle, desc: item.desc, icon: Boolean(item.icon), stack: item.stack, core: item.core, chargeable: item.chargeable, procedural: Boolean(item.procedural), addable: Boolean(addable(item)) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { total: out.length, items: out.slice(0, limit) };
}

// Items that can be added as new stacks: named, non-procedural products and
// substances with a known stack multiplier.
const addable = (item) =>
  (item.type === 'Product' || item.type === 'Substance') && item.name && !item.procedural && !item.alias && item.stack !== undefined;

export function searchItems(query, limit = 40) {
  if (!db?.available) return [];
  const q = String(query ?? '').trim().toLowerCase();
  const hits = [];
  for (const [id, item] of Object.entries(db.items)) {
    if (!addable(item)) continue;
    const name = item.name.toLowerCase();
    const rank = !q ? 2 : name.startsWith(q) ? 0 : name.includes(q) ? 1 : id.toLowerCase().includes(q) ? 2 : -1;
    if (rank >= 0) hits.push({ rank, id, name: item.name, subtitle: item.subtitle, type: item.type, icon: Boolean(item.icon) });
  }
  hits.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return hits.slice(0, limit);
}

export const isAddable = (saveId) => {
  const r = db?.available && resolveItem(db.items, saveId);
  return Boolean(r && addable(r));
};

// The game's rule-based stack limit for an item in a stack group, or null if unknown.
export function stackRule(saveId, type, group, difficulty) {
  if (!db?.available || !db.stackBases) return null;
  const r = resolveItem(db.items, saveId);
  if (!r || r.type !== type || r.stack === undefined) return null;
  return ruleLimit(db.stackBases, difficulty, type, group, r.stack);
}

// True when every inventory type shares one base limit for this item type and
// difficulty (e.g. substances on High are 9999 everywhere), so the rule cannot
// depend on which inventory type is which.
export function stackBaseUniform(type, difficulty) {
  const bases = db?.stackBases?.[difficulty]?.[type];
  return Boolean(bases?.length) && bases.every((b) => b === bases[0]);
}

const memory = new Map();

// PNG bytes for an item key's icon, or null.
export function iconPng(key) {
  if (!db?.available || !/^[A-Z0-9_]+$/i.test(key)) return null;
  const item = db.items[key];
  if (!item?.icon) return null;
  if (memory.has(key)) return memory.get(key);
  const file = path.join(iconDir, `${key}.png`);
  let png;
  if (fs.existsSync(file)) png = fs.readFileSync(file);
  else {
    const name = item.icon.toLowerCase();
    if (!db.archives.find(name)) return null;
    png = encodePng(decodeDds(db.archives.read(name)));
    fs.writeFileSync(file, png);
  }
  if (memory.size > 500) memory.clear();
  memory.set(key, png);
  return png;
}

let groups = null;
const GROUPS_FILE = 'metadata/gamestate/playerdata/charactercustomisationdescriptorgroupsdata.mbin';

// Descriptor ids for recorded customisation groups, or null if any group is unknown.
function partsFor(groupIds) {
  if (!groups) groups = db.archives.find(GROUPS_FILE) ? readCustomisationGroups(db.archives.read(GROUPS_FILE)) : new Map();
  const parts = [];
  for (const g of groupIds) {
    if (!groups.has(g)) return null;
    parts.push(...groups.get(g));
  }
  return parts;
}

export const sceneExists = (scene) => Boolean(db?.available && db.archives.find(sceneName(scene)));

// Whether a ship seed is one the game's reward table hands out.
let rewardTable = null;
export function isRewardSeed(hex) {
  if (!db?.available) return false;
  rewardTable ??= db.archives.read('metadata/reality/tables/rewardtable.mbin');
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(hex));
  return rewardTable.includes(bytes);
}

const sceneName = (scene) => String(scene ?? '').replaceAll('\\', '/').toLowerCase();

// Whether a model can be shown in 3D, without decoding it. Procedural models
// (ones with a descriptor) need their parts recorded in the save; the game
// otherwise picks them from a seed, which can't be reproduced here.
export function modelStatus(scene, groupIds = []) {
  if (!db?.available) return { available: false, reason: 'Game data unavailable' };
  const name = sceneName(scene);
  if (!name || !db.archives.find(name)) return { available: false, reason: 'Model not found in game data' };
  if (db.archives.find(name.replace(/\.scene\.mbin$/, '.descriptor.mbin'))) {
    if (!groupIds.length) return { available: false, reason: 'Procedurally generated: its parts come from a seed the game doesn’t write to the save. Customised ships can be shown.' };
    if (!partsFor(groupIds)) return { available: false, reason: 'Its recorded parts aren’t in this game version’s data' };
    // Recorded parts may still leave a choice open; decode now (cached) so the button tells the truth.
    try {
      modelBinary(scene, groupIds);
    } catch (e) {
      if (!(e instanceof ModelError)) throw e;
      return { available: false, reason: e.message };
    }
  }
  return { available: true };
}

const models = new Map();
// Textures referenced by a model served so far; only these can be fetched.
const modelTextures = new Set();

// Packed model bytes for a scene path and its recorded customisation groups, or throws
// ModelError. `example` builds a representative of a swappable ship or freighter type.
export function modelBinary(scene, groupIds = [], { example = false } = {}) {
  if (!db?.available) throw new ModelError('Game data unavailable');
  if (example && ![...SHIP_KINDS, ...FREIGHTER_KINDS].some((k) => sceneName(k.scene) === sceneName(scene))) throw new ModelError('No example for this model');
  const key = `${sceneName(scene)}|${example ? 'example' : groupIds.join(',')}`;
  if (models.has(key)) return models.get(key);
  const parts = !example && groupIds.length ? partsFor(groupIds) : undefined;
  if (!example && groupIds.length && !parts) throw new ModelError('Unknown customisation part');
  const model = loadModel(db.archives, sceneName(scene), { parts, example });
  for (const t of Object.values(model.textures)) if (t) modelTextures.add(t);
  const bin = packModel(model);
  if (models.size > 12) models.delete(models.keys().next().value);
  models.set(key, bin);
  return bin;
}

const textures = new Map();

// PNG for a texture a served model uses, or null. Cached on disk like icons.
export function texturePng(name) {
  if (!db?.available || !modelTextures.has(name)) return null;
  if (textures.has(name)) return textures.get(name);
  const file = path.join(iconDir, `tex-${name.replace(/[^a-z0-9]+/g, '_')}.png`);
  let png;
  if (fs.existsSync(file)) png = fs.readFileSync(file);
  else {
    if (!db.archives.find(name)) return null;
    png = encodePng(decodeDds(db.archives.read(name)));
    fs.writeFileSync(file, png);
  }
  if (textures.size > 16) textures.clear();
  textures.set(name, png);
  return png;
}
