// The game's stack-limit rules, read from its data files:
//   limit = min(9999, base[difficulty][type][stackGroup] * itemMultiplier)
//   itemMultiplier 0 means the item does not stack (limit 1).
// The bases come from difficultyconfig.mbin; the multipliers from the item tables.
// Callers must check the rule against the limits the game already wrote into a
// save before trusting it (see saves.js).

export const STACK_CAP = 9999;

// cGcInventoryStackSizeGroup, in enum order (matches the 13-entry product arrays).
export const STACK_GROUPS = [
  'Default', 'Personal', 'PersonalCargo', 'Ship', 'ShipCargo', 'Freighter', 'FreighterCargo',
  'Vehicle', 'Chest', 'BaseCapsule', 'MaintenanceObject', 'UIPopup', 'SeasonTransfer',
];

// Stack-limit difficulty blocks appear in this order in difficultyconfig.mbin.
// "High" is confirmed by saves (all substances 9999); Normal/Low by their ordering.
const DIFFICULTIES = ['High', 'Normal', 'Low'];
const PRODUCT_LEN = 13;
const SUBSTANCE_LEN = 15;

// Multiplier columns (byte offset within a record) for each item table.
export const MULTIPLIER_OFFSETS = {
  'nms_reality_gcproducttable.mbin': 480,
  'nms_basepartproducts.mbin': 480,
  'nms_modularcustomisationproducts.mbin': 480,
  'nms_reality_gcsubstancetable.mbin': 300,
};

export function readStackBases(buf) {
  // The High substance array is the first run of 15 consecutive 9999s; the
  // product array sits just before it, and the other difficulties follow.
  let run = 0;
  let start = -1;
  for (let o = 0; o + 4 <= buf.length; o += 4) {
    run = buf.readInt32LE(o) === STACK_CAP ? run + 1 : 0;
    if (run === SUBSTANCE_LEN) {
      start = o - (SUBSTANCE_LEN - 1) * 4;
      break;
    }
  }
  if (start < 0) throw new Error('Stack limit table not found');
  const ints = (o, n) => Array.from({ length: n }, (_, i) => buf.readInt32LE(o + i * 4));
  const bases = {};
  DIFFICULTIES.forEach((d, i) => {
    const block = start - PRODUCT_LEN * 4 + i * (PRODUCT_LEN + SUBSTANCE_LEN) * 4;
    const Product = ints(block, PRODUCT_LEN);
    const Substance = ints(block + PRODUCT_LEN * 4, SUBSTANCE_LEN);
    if (![...Product, ...Substance].every((v) => v >= 1 && v <= STACK_CAP)) throw new Error(`Stack limits for ${d} look wrong`);
    bases[d] = { Product, Substance };
  });
  return bases;
}

// Multiplier column for a table, or null when it does not look like one.
export function readMultipliers(table, offset) {
  if (offset === undefined || offset + 4 > table.size) return null;
  const values = table.records.map((_, r) => table.buf.readInt32LE(table.start + r * table.size + offset));
  const plausible = values.filter((v) => v >= 0 && v <= 100000).length;
  return plausible / values.length > 0.99 ? values : null;
}

export function ruleLimit(bases, difficulty, type, group, multiplier) {
  const base = bases?.[difficulty]?.[type]?.[STACK_GROUPS.indexOf(group)];
  if (base === undefined || multiplier === undefined || multiplier === null) return null;
  if (multiplier === 0) return 1;
  return Math.min(STACK_CAP, base * multiplier);
}
