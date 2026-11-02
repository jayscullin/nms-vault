// Builds a synthetic NMS save folder for tests: real compression, key
// obfuscation and encrypted manifests, but invented (small) game state, so no
// personal save data is needed and the tests can run anywhere.

import fs from 'node:fs';
import path from 'node:path';
import { encodeSave } from '../../src/codec.js';
import { stringify } from '../../src/losslessJson.js';
import { obfuscate, loadMapping } from '../../src/keys.js';
import { encryptMeta, archiveNumberFor, META_MAGIC } from '../../src/manifest.js';

const mapping = loadMapping(path.join(import.meta.dirname, '..', '..', 'data', 'mapping.json'));
const f = (n) => JSON.rawJSON(Number.isInteger(n) ? `${n}.0` : String(n)); // float literal, as NMS writes them

export const ACCOUNT = 'st_76561190000000001';
export const SAVE_ID = '0x1111222233334444';
export const OTHER_ID = '0x5555666677778888';

const slot = (type, id, amount, max, x, y, extra = {}) => ({
  Type: { InventoryType: type },
  Id: id,
  Amount: amount,
  MaxAmount: max,
  DamageFactor: f(extra.damage ?? 0),
  FullyInstalled: extra.installed ?? true,
  AddedAutomatically: false,
  Index: { X: x, Y: y },
});

const inventory = (group, width, height, slots, name = '') => ({
  Slots: slots,
  ValidSlotIndices: Array.from({ length: width * height }, (_, i) => ({ X: i % width, Y: Math.floor(i / width) })),
  Class: { InventoryClass: 'C' },
  StackSizeGroup: { InventoryStackSizeGroup: group },
  BaseStatValues: [],
  SpecialSlots: [],
  Width: width,
  Height: height,
  IsCool: false,
  Name: name,
  Version: 1,
});

export function saveTree({ id = SAVE_ID, summary = 'Aboard the Space Anomaly', playTime = 3600, timestamp = 1790000000, units = 1000 } = {}) {
  const chest = (n) => inventory('Chest', 5, 2, n === 1 ? [slot('Product', '^HYPERFUEL2', 30, 40, 0, 0), slot('Substance', '^FUEL1', 500, 9999, 1, 0)] : [], n === 1 ? 'Supplies' : 'BLD_STORAGE_NAME');
  return {
    Version: 4743,
    Platform: 'Mac|Final',
    ActiveContext: 'Main',
    CommonStateData: { SaveName: '', TotalPlayTime: playTime, SaveUniversalId: id, SeasonData: { SeasonId: 0 } },
    BaseContext: {
      PlayerStateData: {
        SaveSummary: summary,
        TimeStamp: timestamp,
        Units: units,
        Nanites: 200,
        Specials: 30,
        DifficultyState: { Preset: { DifficultyPresetType: 'Relaxed' }, Settings: { InventoryStackLimits: { InventoryStackLimitsDifficulty: 'High' } } },
        Inventory: inventory('Personal', 6, 4, [
          slot('Substance', '^FUEL1', 100, 9999, 0, 0),
          slot('Substance', '^LAND1', 250, 9999, 1, 0),
          slot('Product', '^HYPERFUEL2', 5, 20, 2, 0),
          slot('Product', '^ANTIMATTER', 3, 20, 3, 0),
        ]),
        Inventory_Cargo: inventory('PersonalCargo', 4, 2, []),
        Inventory_TechOnly: inventory('Personal', 6, 3, [
          slot('Technology', '^ENERGY', 50, 100, 0, 0),
          slot('Technology', '^UP_HOT3#12345', -1, 100, 1, 0),
          slot('Technology', '^SUMMON_SUIT', -1, 100, 2, 0, { damage: 1, installed: false }),
        ]),
        ShipOwnership: [
          {
            Name: 'Test Ship',
            Resource: { Filename: 'MODELS/COMMON/SPACECRAFT/FIGHTERS/FIGHTER_PROC.SCENE.MBIN' },
            Inventory: inventory('Ship', 5, 3, [slot('Substance', '^FUEL1', 50, 9999, 0, 0)]),
            Inventory_Cargo: inventory('ShipCargo', 4, 2, []),
            Inventory_TechOnly: inventory('Ship', 5, 2, [slot('Technology', '^SHIPJUMP1', 100, 200, 0, 0)]),
          },
        ],
        PrimaryShip: 0,
        Multitools: [],
        ActiveMultioolIndex: 0,
        FreighterInventory: inventory('Freighter', 5, 2, []),
        FreighterInventory_Cargo: inventory('FreighterCargo', 4, 2, []),
        FreighterInventory_TechOnly: inventory('Freighter', 5, 2, []),
        Chest1Inventory: chest(1),
        Chest2Inventory: chest(2),
        VehicleOwnership: [],
        KnownWordGroups: [{ Group: '^TRA_A', Races: [true, false, false, false, false, false, false, false, false] }],
        KnownTech: ['^ENERGY'],
        KnownProducts: ['^HYPERFUEL2'],
      },
    },
  };
}

export function accountTree() {
  return {
    Version: 4098,
    UserSettingsData: {
      UnlockedTitles: ['^T_TRA1'],
      UnlockedSpecials: [],
      UnlockedSeasonRewards: [],
      UnlockedTwitchRewards: [],
      UnlockedPlatformRewards: [],
    },
  };
}

// Manifest with the fields NMS Vault reads/writes: magic, format, the size
// words (14, 15, 21), play time (19), save id (0x15C) and save time (0x164).
function manifest(file, text, bytes, { format, playTime = 0, id = null, timestamp = 0 }) {
  const m = Buffer.alloc(0x1b0);
  m.writeUInt32LE(META_MAGIC, 0);
  m.writeUInt32LE(format, 4);
  m.writeUInt32LE(text.length + 1, 14 * 4);
  m.writeUInt32LE(bytes.length, 15 * 4);
  m.writeUInt32LE(playTime, 19 * 4);
  m.writeUInt32LE(text.length + 1, 21 * 4);
  if (id) m.writeBigUInt64LE(BigInt(id), 0x15c);
  m.writeUInt32LE(timestamp, 0x164);
  return encryptMeta(m, archiveNumberFor(file));
}

export function writeSave(dir, file, tree, { compressed = true, format = 2004 } = {}) {
  const text = obfuscate(stringify(tree), mapping);
  const bytes = encodeSave(text, { compressed });
  const ps = tree.BaseContext?.PlayerStateData;
  fs.writeFileSync(path.join(dir, file), bytes);
  fs.writeFileSync(
    path.join(dir, `mf_${file}`),
    manifest(file, text, bytes, { format, playTime: tree.CommonStateData?.TotalPlayTime ?? 0, id: tree.CommonStateData?.SaveUniversalId, timestamp: ps?.TimeStamp ?? 0 }),
  );
}

// A fresh account folder: slot 1 with a latest and an earlier save, slot 2, and account data.
export function buildFixtures(root) {
  fs.rmSync(root, { recursive: true, force: true });
  const dir = path.join(root, ACCOUNT);
  fs.mkdirSync(dir, { recursive: true });
  writeSave(dir, 'save.hg', saveTree({ playTime: 3600, timestamp: 1790000000 }));
  writeSave(dir, 'save2.hg', saveTree({ summary: 'On a planet', playTime: 3500, timestamp: 1789990000 }));
  writeSave(dir, 'save3.hg', saveTree({ id: OTHER_ID, summary: 'In a far system', playTime: 600, timestamp: 1780000000, units: 5 }));
  writeSave(dir, 'accountdata.hg', accountTree(), { compressed: false, format: 2003 });
  return dir;
}
