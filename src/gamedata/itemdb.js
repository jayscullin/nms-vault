// Builds an item database (names, descriptions, icons) from the installed game's
// archives, and caches it per game build.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HgPak } from './hgpak.js';
import { readTable } from './mbin.js';
import { readStackBases, readMultipliers, MULTIPLIER_OFFSETS } from './stacks.js';

const TABLES = 'metadata/reality/tables/';
const DB_VERSION = 2;
const SOURCES = [
  { file: 'nms_reality_gcsubstancetable.mbin', type: 'Substance' },
  { file: 'nms_reality_gcproducttable.mbin', type: 'Product' },
  { file: 'nms_basepartproducts.mbin', type: 'Product' },
  { file: 'nms_modularcustomisationproducts.mbin', type: 'Product' },
  { file: 'nms_reality_gctechnologytable.mbin', type: 'Technology' },
  { file: 'nms_reality_gcproceduraltechnologytable.mbin', type: 'Technology', procedural: true },
];
// Loaded in order; later files override earlier ones.
const LANGUAGES = [/nms_(loc\d+|update\d+)_english\.mbin$/, /nms_(loc\d+|update\d+)_usenglish\.mbin$/];

export function gameDataDirs() {
  if (process.env.NMS_GAME_DIR) return [process.env.NMS_GAME_DIR];
  const home = os.homedir();
  const steamLibs = {
    darwin: [path.join(home, 'Library/Application Support/Steam')],
    win32: ['C:/Program Files (x86)/Steam', 'C:/Program Files/Steam'],
    linux: [path.join(home, '.local/share/Steam'), path.join(home, '.steam/steam')],
  }[process.platform] ?? [];
  const libs = new Set(steamLibs);
  for (const lib of steamLibs) {
    try {
      const vdf = fs.readFileSync(path.join(lib, 'steamapps/libraryfolders.vdf'), 'utf8');
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, '/'));
    } catch {}
  }
  const dirs = [];
  for (const lib of libs) {
    const game = path.join(lib, "steamapps/common/No Man's Sky");
    dirs.push(path.join(game, "No Man's Sky.app/Contents/Resources/GAMEDATA/MACOSBANKS"), path.join(game, 'GAMEDATA/PCBANKS'));
  }
  if (process.platform === 'darwin') dirs.push(path.join(home, "Applications/No Man's Sky.app/Contents/Resources/GAMEDATA/MACOSBANKS"), "/Applications/No Man's Sky.app/Contents/Resources/GAMEDATA/MACOSBANKS");
  return dirs;
}

export function findGameData() {
  return gameDataDirs().find((d) => fs.existsSync(path.join(d, 'NMSARC.Precache.pak'))) ?? null;
}

// Opens every archive and indexes which one holds each file.
export class GameArchives {
  constructor(dir) {
    this.dir = dir;
    this.paks = fs
      .readdirSync(dir)
      .filter((f) => /\.pak$/i.test(f))
      .map((f) => new HgPak(path.join(dir, f)));
  }

  find(name) {
    return this.paks.find((p) => p.has(name)) ?? null;
  }

  read(name) {
    const pak = this.find(name);
    if (!pak) throw new Error(`${name} not found in game data`);
    return pak.read(name);
  }

  signature() {
    return this.paks.map((p) => {
      const st = fs.statSync(p.file);
      return `${path.basename(p.file)}:${st.size}:${Math.floor(st.mtimeMs)}`;
    });
  }

  close() {
    for (const p of this.paks) p.close();
  }
}

const stripMarkup = (s) =>
  s.replace(/<IMG>[^<]*<>/g, '').replace(/<\/?[A-Z_]*>/g, '').replace(/%[A-Z_]+%\s*/g, '').replace(/\s+/g, ' ').trim();

function loadLanguage(archives) {
  const loc = new Map();
  for (const pattern of LANGUAGES) {
    for (const pak of archives.paks) {
      for (const name of pak.files.keys()) {
        if (!pattern.test(name)) continue;
        for (const rec of readTable(pak.read(name)).records) {
          const key = rec.find((x) => !x.line)?.s;
          const value = rec.find((x) => x.line)?.s;
          if (key && value) loc.set(key, value);
        }
      }
    }
  }
  return loc;
}

// Chooses each column by the shape of its values rather than a fixed offset.
function columns(table) {
  const byOff = new Map();
  for (const rec of table.records) {
    for (const x of rec) {
      if (!byOff.has(x.off)) byOff.set(x.off, { off: x.off, line: x.line, values: [] });
      byOff.get(x.off).values.push(x.s);
    }
  }
  const cols = [...byOff.values()];
  const share = (c, re) => c.values.filter((v) => re.test(v)).length / table.count;
  const best = (re, filter = () => true) =>
    cols.filter(filter).map((c) => ({ c, score: share(c, re) })).filter((x) => x.score > 0.5).sort((a, b) => b.score - a.score)[0]?.c.off;

  const id = cols
    .filter((c) => !c.line && c.values.length === table.count && new Set(c.values).size === table.count)
    .filter((c) => share(c, /^(UI_|WIKI_)|_(NAME|NAME_L|DESC|SUB|SYM)$/) < 0.5)
    .sort((a, b) => a.off - b.off)[0]?.off;
  return {
    id,
    name: best(/_NAME_L$/) ?? best(/_NAME$/),
    desc: best(/_DESC(RIPTION)?$/),
    subtitle: best(/_SUB(TITLE)?(_\d+)?$/),
    icon: best(/^TEXTURES\/UI\/.*\.DDS$/i, (c) => c.line),
  };
}

export function buildItemDb(archives) {
  const loc = loadLanguage(archives);
  const text = (key) => (key && loc.has(key) ? stripMarkup(loc.get(key)) : null);
  const items = {};
  const report = [];
  for (const src of SOURCES) {
    const pak = archives.find(TABLES + src.file);
    if (!pak) {
      report.push({ table: src.file, error: 'missing' });
      continue;
    }
    let table;
    try {
      table = readTable(pak.read(TABLES + src.file));
    } catch (e) {
      report.push({ table: src.file, error: e.message });
      continue;
    }
    const col = columns(table);
    if (col.id === undefined) {
      report.push({ table: src.file, error: 'no id column' });
      continue;
    }
    const multipliers = readMultipliers(table, MULTIPLIER_OFFSETS[src.file]);
    let named = 0;
    table.records.forEach((rec, r) => {
      const at = (off) => (off === undefined ? null : rec.find((x) => x.off === off)?.s ?? null);
      const id = at(col.id);
      if (!id || items[id]) return;
      const name = text(at(col.name));
      if (name) named++;
      items[id] = {
        type: src.type,
        name,
        subtitle: text(at(col.subtitle)),
        desc: text(at(col.desc)),
        icon: at(col.icon),
        ...(multipliers ? { stack: multipliers[r] } : {}),
        ...(src.procedural ? { procedural: true } : {}),
      };
    });
    report.push({ table: src.file, records: table.count, named, columns: col, multipliers: Boolean(multipliers) });
    if (src.procedural) borrowIcons(table, col, items);
  }
  report.push(addProceduralProducts(archives, items));

  let stackBases = null;
  try {
    stackBases = readStackBases(archives.read('metadata/gamestate/difficultyconfig.mbin'));
  } catch (e) {
    report.push({ table: 'difficultyconfig.mbin', error: e.message });
  }
  return { items, stackBases, report, languageKeys: loc.size };
}

// Procedural products (PROC_BIO, PROC_SALV, ...) get seed-generated names in game,
// so only their category is known. The category comes from the name-format key.
const PROC_CATEGORIES = {
  LOOT: 'Treasure', DOC: 'Document', BIO: 'Biological sample', FOSSIL: 'Fossil', PLANT: 'Plant',
  TOOL: 'Tool', WATER: 'Aquatic find', WATERWEIRD: 'Strange aquatic find', SALVAGE: 'Salvage',
};

function addProceduralProducts(archives, items) {
  const file = TABLES + 'proceduralproducttable.mbin';
  const pak = archives.find(file);
  if (!pak) return { table: 'proceduralproducttable.mbin', error: 'missing' };
  const text = pak.read(file).toString('latin1');
  let added = 0;
  for (const m of text.matchAll(/(PROC_[A-Z0-9_]+)\0[\s\S]{0,256}?ITEMGEN_FORMAT_([A-Z0-9_]+)/g)) {
    const [, id, format] = m;
    if (items[id]) continue;
    const category = PROC_CATEGORIES[format] ?? format.charAt(0) + format.slice(1).toLowerCase();
    // Procedural products never stack (the game writes MaxAmount 1).
    items[id] = { type: 'Product', name: category, subtitle: 'Procedurally named in game', desc: null, icon: null, stack: 0, procedural: true, generic: true };
    added++;
  }
  return { table: 'proceduralproducttable.mbin', added };
}

// Resolves a save item id ("^UP_HOT3#17498", "^FUEL1") to its database entry.
// Uninstalled upgrade modules ("UP_STEALTH") fall back to their technology ("STEALTH").
export function resolveItem(items, saveId) {
  const id = baseId(saveId);
  if (items[id]) return { key: id, ...items[id] };
  const tech = id.startsWith('UP_') && items[id.slice(3)];
  if (tech) return { key: id.slice(3), ...tech, name: tech.name && `${tech.name} Upgrade`, subtitle: 'Upgrade module' };
  return null;
}

// Procedural records carry no icon of their own; they reference a template
// item (e.g. UP_LASER1 -> UP_LASER) whose icon the game shows.
function borrowIcons(table, col, items) {
  for (const rec of table.records) {
    const item = items[rec.find((x) => x.off === col.id)?.s];
    if (!item || item.icon) continue;
    for (const x of rec) {
      if (x.off === col.id) continue;
      const ref = items[x.s];
      if (ref?.icon && !ref.procedural) {
        item.icon = ref.icon;
        break;
      }
    }
  }
}

const cacheDir = () => path.join(process.env.NMS_VAULT_HOME ?? path.join(os.homedir(), '.nms-vault'), 'cache');

// Loads the cached database for this game build, building it if needed.
export function loadItemDb({ rebuild = false } = {}) {
  const dir = findGameData();
  if (!dir) return { available: false, reason: 'No Man’s Sky game files were not found. Set NMS_GAME_DIR to the GAMEDATA/PCBANKS (or MACOSBANKS) folder.' };
  const archives = new GameArchives(dir);
  // Bump DB_VERSION whenever the database's contents change shape.
  const signature = [`db${DB_VERSION}`, ...archives.signature()].join('|');
  const cacheFile = path.join(cacheDir(), 'itemdb.json');
  if (!rebuild && fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cached.signature === signature) return { available: true, dir, archives, ...cached };
  }
  const started = Date.now();
  const db = { signature, built: new Date().toISOString(), ...buildItemDb(archives) };
  fs.mkdirSync(cacheDir(), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(db));
  return { available: true, dir, archives, buildMs: Date.now() - started, ...db };
}

// "^UP_LASER4#12345" -> "UP_LASER4"
export const baseId = (saveId) => String(saveId).replace(/^\^/, '').split('#')[0];
