// Game data service: item database plus icon rendering with a disk cache.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadItemDb, resolveItem } from './itemdb.js';
import { decodeDds, encodePng } from './dds.js';
import { ruleLimit } from './stacks.js';

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
  return { key: r.key, name: r.name, subtitle: r.subtitle, desc: r.desc, icon: Boolean(r.icon), generic: r.generic };
}

// The game's rule-based stack limit for an item in a stack group, or null if unknown.
export function stackRule(saveId, type, group, difficulty) {
  if (!db?.available || !db.stackBases) return null;
  const r = resolveItem(db.items, saveId);
  if (!r || r.type !== type || r.stack === undefined) return null;
  return ruleLimit(db.stackBases, difficulty, type, group, r.stack);
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
