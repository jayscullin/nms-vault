// Inventory model: finds the player's inventories in a deobfuscated save tree,
// presents them as plain views, and applies edit operations to the tree.

import { num, setNum, toDisplay, fromDisplay, parse, stringify } from './losslessJson.js';

const PS = ['BaseContext', 'PlayerStateData'];

// Kinds decide which moves are allowed. Only "bulk" inventories exchange items.
// "legacy" marks the old *_Cargo inventories: current game versions keep cargo in
// the general inventory and these stay empty, so items moved there could vanish
// from view in-game. They are shown only if non-empty, and only to move items out.
const BULK = new Set(['general', 'storage']);

const SHIP_TYPES = [
  [/WRACER/, 'Starborn Runner'],
  [/BIOPARTS/, 'Living Ship'],
  [/SAILSHIP/, 'Solar'],
  [/SENTINELSHIP/, 'Interceptor'],
  [/DROPSHIPS/, 'Hauler'],
  [/FIGHTERS/, 'Fighter'],
  [/SHUTTLE/, 'Shuttle'],
  [/SCIENTIFIC/, 'Explorer'],
  [/ROYAL/, 'Exotic'],
  [/CORVETTE/, 'Corvette'],
];
const VEHICLES = ['Roamer', 'Nomad', 'Colossus', 'Pilgrim', 'Exocraft 5', 'Nautilon', 'Minotaur'];
const SPECIAL = [
  ['CookingIngredientsInventory', 'Ingredient Storage'],
  ['RocketLockerInventory', 'Rocket Locker'],
  ['ChestMagicInventory', 'Special Storage A'],
  ['ChestMagic2Inventory', 'Special Storage B'],
  ['FishPlatformInventory', 'Fishing Platform'],
  ['FishBaitBoxInventory', 'Bait Box'],
  ['FoodUnitInventory', 'Food Unit'],
];
export const CURRENCIES = { Units: 'Units', Nanites: 'Nanites', Specials: 'Quicksilver' };
export const NAME_MAX_BYTES = 32;
const INT32_MAX = 2147483647;

export class OpError extends Error {}

export const get = (tree, path) => path.reduce((v, k) => (v == null ? v : v[k]), tree);

function shipType(file) {
  for (const [re, label] of SHIP_TYPES) if (re.test(file)) return label;
  const folder = file.split('/').at(-2) ?? 'Ship';
  return folder.toLowerCase().replace(/(^|[-_ ])(\w)/g, (_m, sep, c) => `${sep}${c.toUpperCase()}`);
}

// Unnamed objects can hold a localisation key such as "BLD_STORAGE_NAME".
function displayName(raw) {
  const name = toDisplay(raw ?? '');
  return /^[A-Z0-9]+(_[A-Z0-9]+)+$/.test(name) ? '' : name;
}

// Containers group inventories by what owns them (a ship, a chest, the exosuit).
export function catalog(tree) {
  const ps = get(tree, PS);
  const containers = [];
  const container = (group, title, { namePath, current = false } = {}) => {
    const c = { id: `${group}:${containers.length}`, group, title, namePath, current, inventories: [] };
    containers.push(c);
    return c;
  };
  const inv = (c, label, path, kind) => {
    const v = get(tree, path);
    if (!v?.Slots || num(v.Width) * num(v.Height) === 0) return;
    if (kind === 'legacy' && v.Slots.length === 0) return;
    c.inventories.push({ id: path.join('/'), label: kind === 'legacy' ? `${label} (legacy)` : label, path, kind, where: `${c.title} · ${label}` });
  };

  const exo = container('Exosuit', 'Exosuit');
  inv(exo, 'General', [...PS, 'Inventory'], 'general');
  inv(exo, 'Cargo', [...PS, 'Inventory_Cargo'], 'legacy');
  inv(exo, 'Technology', [...PS, 'Inventory_TechOnly'], 'tech');

  (ps.ShipOwnership ?? []).forEach((s, i) => {
    const file = s.Resource?.Filename;
    if (!file) return;
    const base = [...PS, 'ShipOwnership', i];
    const c = container('Starships', displayName(s.Name) || `${shipType(file)} ${i + 1}`, {
      namePath: [...base, 'Name'],
      current: num(ps.PrimaryShip) === i,
    });
    c.subtitle = shipType(file);
    inv(c, 'General', [...base, 'Inventory'], 'general');
    inv(c, 'Cargo', [...base, 'Inventory_Cargo'], 'legacy');
    inv(c, 'Technology', [...base, 'Inventory_TechOnly'], 'tech');
  });

  (ps.Multitools ?? []).forEach((m, i) => {
    if (!m.Resource?.Filename || !m.Store?.Slots?.length) return;
    const c = container('Multi-Tools', displayName(m.Name) || `Multi-Tool ${i + 1}`, {
      namePath: [...PS, 'Multitools', i, 'Name'],
      current: num(ps.ActiveMultioolIndex) === i,
    });
    inv(c, 'Technology', [...PS, 'Multitools', i, 'Store'], 'tech');
  });

  const fr = container('Freighter', 'Freighter');
  inv(fr, 'General', [...PS, 'FreighterInventory'], 'general');
  inv(fr, 'Cargo', [...PS, 'FreighterInventory_Cargo'], 'legacy');
  inv(fr, 'Technology', [...PS, 'FreighterInventory_TechOnly'], 'tech');

  for (let n = 1; n <= 10; n++) {
    const key = `Chest${n}Inventory`;
    if (!ps[key]) continue;
    const c = container('Storage', displayName(ps[key].Name) || `Storage Container ${n - 1}`, {
      namePath: [...PS, key, 'Name'],
    });
    if (displayName(ps[key].Name)) c.subtitle = `Container ${n - 1}`;
    inv(c, 'Contents', [...PS, key], 'storage');
  }

  (ps.VehicleOwnership ?? []).forEach((v, i) => {
    const c = container('Exocraft', displayName(v.Name) || VEHICLES[i] || `Exocraft ${i + 1}`);
    inv(c, 'General', [...PS, 'VehicleOwnership', i, 'Inventory'], 'general');
    inv(c, 'Technology', [...PS, 'VehicleOwnership', i, 'Inventory_TechOnly'], 'tech');
  });

  for (const [key, label] of SPECIAL) {
    if (!ps[key]) continue;
    inv(container('Base & Utility', label), 'Contents', [...PS, key], 'special');
  }

  return containers.filter((c) => c.inventories.length);
}

export function indexCatalog(containers) {
  const inventories = new Map();
  const names = new Map();
  for (const c of containers) {
    for (const i of c.inventories) inventories.set(i.id, i);
    if (c.namePath) names.set(c.namePath.join('/'), c.namePath);
  }
  return { inventories, names };
}

const cellKey = (x, y) => `${x},${y}`;

export function inventoryView(tree, info) {
  const v = get(tree, info.path);
  return {
    id: info.id,
    label: info.label,
    kind: info.kind,
    width: num(v.Width),
    height: num(v.Height),
    stackGroup: v.StackSizeGroup?.InventoryStackSizeGroup ?? null,
    valid: v.ValidSlotIndices.map((i) => cellKey(num(i.X), num(i.Y))),
    slots: v.Slots.map((s) => ({
      x: num(s.Index.X),
      y: num(s.Index.Y),
      type: s.Type?.InventoryType,
      id: typeof s.Id === 'string' ? toDisplay(s.Id) : String(s.Id),
      amount: num(s.Amount),
      max: num(s.MaxAmount),
      damage: num(s.DamageFactor),
      installed: s.FullyInstalled !== false,
    })),
  };
}

export function view(tree, containers) {
  const ps = get(tree, PS);
  return {
    currencies: Object.fromEntries(Object.keys(CURRENCIES).map((k) => [k, num(ps[k])])),
    containers: containers.map((c) => ({
      id: c.id,
      group: c.group,
      title: c.title,
      subtitle: c.subtitle,
      current: c.current,
      nameKey: c.namePath?.join('/'),
      name: c.namePath ? displayName(get(tree, c.namePath)) : undefined,
      inventories: c.inventories.map((i) => inventoryView(tree, i)),
    })),
  };
}

export const stackGroupOf = (inv) => inv.StackSizeGroup?.InventoryStackSizeGroup ?? 'Default';

const isBulkItem = (slot) => slot.Type?.InventoryType === 'Product' || slot.Type?.InventoryType === 'Substance';

function locate(tree, cat, ref) {
  const info = cat.inventories.get(ref?.inv);
  if (!info) throw new OpError(`Unknown inventory ${ref?.inv}`);
  const inv = get(tree, info.path);
  const x = Number(ref.x);
  const y = Number(ref.y);
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new OpError('Slot coordinates must be integers');
  const index = inv.Slots.findIndex((s) => num(s.Index.X) === x && num(s.Index.Y) === y);
  return { info, inv, x, y, index, slot: index === -1 ? null : inv.Slots[index] };
}

function assertCellUsable(loc) {
  const { inv, x, y } = loc;
  if (x < 0 || y < 0 || x >= num(inv.Width) || y >= num(inv.Height)) throw new OpError(`Cell ${x},${y} is outside the inventory`);
  if (!inv.ValidSlotIndices.some((i) => num(i.X) === x && num(i.Y) === y)) throw new OpError(`Cell ${x},${y} is not unlocked`);
}

function assertCanHold(loc, slot) {
  if (!isBulkItem(slot)) throw new OpError('Technology can only be rearranged within its own inventory');
  if (!BULK.has(loc.info.kind)) throw new OpError(`${loc.info.where} can't receive items from elsewhere`);
}

function amountInt(value, min, max, what) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new OpError(`${what} must be a whole number from ${min} to ${max}`);
  return n;
}

// Applies one op to the tree in place. Returns { touched: [path...], warnings: [] }.
// Callers apply ops to a scratch tree; on OpError the tree may be partially modified.
// `stacks` supplies the game's rules:
//   limitFor(slot, inv)  the game's stack limit for a slot in an inventory, or null
//                        when it cannot be confirmed. Stack limits are never edited;
//                        they only change when an item moves to another inventory.
//   item(id)             game-data facts about an item ({ type, core, ... }) or null
//   template(type)       a slot of that type from this save, used as the shape of new slots
export function applyOp(tree, cat, stacks, op) {
  const warnings = [];
  switch (op?.op) {
    case 'add': {
      const loc = locate(tree, cat, op);
      if (loc.slot) throw new OpError('That cell is already occupied');
      assertCellUsable(loc);
      if (!BULK.has(loc.info.kind)) throw new OpError(`${loc.info.where} can't receive items`);
      const id = String(op.id ?? '').replace(/^\^/, '');
      if (!/^[A-Z0-9_]+$/.test(id)) throw new OpError('Unknown item');
      const info = stacks.item(`^${id}`);
      if (!info || !stacks.addable(`^${id}`)) throw new OpError(`^${id} can't be added: only named products and substances from the game data can be`);
      // Copy a real slot from this save so new slots have exactly the fields this game version writes.
      const template = stacks.template(info.type);
      if (!template) throw new OpError(`There is no ${info.type.toLowerCase()} anywhere in this save to copy the slot format from`);
      const slot = parse(stringify(template));
      slot.Id = `^${id}`;
      const limit = stacks.limitFor(slot, loc.inv);
      if (limit === null) throw new OpError(`Can't confirm the game's stack limit for ^${id} in ${loc.info.where}`);
      const n = amountInt(op.amount, 1, limit, 'Amount');
      slot.Amount = setNum(slot.Amount, n);
      slot.MaxAmount = setNum(slot.MaxAmount, limit);
      slot.DamageFactor = setNum(slot.DamageFactor, 0);
      slot.FullyInstalled = true;
      if ('AddedAutomatically' in slot) slot.AddedAutomatically = false;
      setIndex(slot, loc.x, loc.y);
      loc.inv.Slots.push(slot);
      return { touched: [[...loc.info.path, 'Slots']], warnings };
    }
    case 'recharge': {
      const loc = locate(tree, cat, op);
      if (!loc.slot || isBulkItem(loc.slot)) throw new OpError('Only technology can be recharged');
      const max = num(loc.slot.MaxAmount);
      // Only tech the game data marks as chargeable; a charge of -1 also means "no charge".
      const chargeable = stacks.item(loc.slot.Id)?.chargeable;
      if (chargeable === undefined) throw new OpError(`Can't confirm whether ${toDisplay(loc.slot.Id)} uses charge`);
      if (!chargeable || num(loc.slot.Amount) < 0 || max <= 0) throw new OpError('This technology doesn’t use charge');
      if (num(loc.slot.DamageFactor) > 0) throw new OpError('Repair it before recharging');
      if (num(loc.slot.Amount) >= max) throw new OpError('Already fully charged');
      loc.slot.Amount = setNum(loc.slot.Amount, max);
      return { touched: [[...loc.info.path, 'Slots']], warnings };
    }
    case 'repair': {
      const loc = locate(tree, cat, op);
      if (!loc.slot || isBulkItem(loc.slot)) throw new OpError('Only technology can be repaired');
      if (num(loc.slot.DamageFactor) <= 0) throw new OpError('This technology isn’t damaged');
      // Damaged tech is marked not fully installed; installed items at full damage are
      // salvage placeholders for broken slots, which the game removes on repair instead.
      if (loc.slot.FullyInstalled !== false) throw new OpError('This is a damaged-slot placeholder; remove it instead of repairing');
      loc.slot.DamageFactor = setNum(loc.slot.DamageFactor, 0);
      loc.slot.FullyInstalled = true;
      return { touched: [[...loc.info.path, 'Slots']], warnings };
    }
    case 'setAmount': {
      const loc = locate(tree, cat, op);
      if (!loc.slot) throw new OpError('That cell is empty');
      if (!isBulkItem(loc.slot)) throw new OpError('Only products and substances have editable amounts');
      const n = amountInt(op.amount, 1, num(loc.slot.MaxAmount), 'Amount');
      loc.slot.Amount = setNum(loc.slot.Amount, n);
      return { touched: [[...loc.info.path, 'Slots']], warnings };
    }
    case 'remove': {
      const loc = locate(tree, cat, op);
      if (!loc.slot) throw new OpError('That cell is empty');
      if (!isBulkItem(loc.slot)) {
        const core = stacks.item(loc.slot.Id)?.core;
        if (core === true) throw new OpError('Core technology can’t be removed; the game doesn’t allow dismantling it');
        if (core !== false) throw new OpError(`Can't confirm whether ${toDisplay(loc.slot.Id)} is core technology, so it stays installed`);
      }
      loc.inv.Slots.splice(loc.index, 1);
      return { touched: [[...loc.info.path, 'Slots']], warnings };
    }
    case 'move': {
      const from = locate(tree, cat, op.from);
      const to = locate(tree, cat, op.to);
      if (!from.slot) throw new OpError('Nothing to move there');
      if (from.info.id === to.info.id && from.x === to.x && from.y === to.y) throw new OpError('Item is already there');
      assertCellUsable(to);
      const touched = [[...from.info.path, 'Slots'], [...to.info.path, 'Slots']];
      const same = from.info.id === to.info.id;

      if (to.slot && to.slot.Id === from.slot.Id && isBulkItem(from.slot)) {
        // Merge into an existing stack of the same item.
        const room = num(to.slot.MaxAmount) - num(to.slot.Amount);
        if (room <= 0) throw new OpError('Target stack is full');
        const moved = Math.min(room, num(from.slot.Amount));
        to.slot.Amount = setNum(to.slot.Amount, num(to.slot.Amount) + moved);
        const left = num(from.slot.Amount) - moved;
        if (left > 0) from.slot.Amount = setNum(from.slot.Amount, left);
        else from.inv.Slots.splice(from.index, 1);
        return { touched, warnings };
      }

      if (same) {
        // Same inventory: only coordinates change, so technology may be rearranged too.
        setIndex(from.slot, to.x, to.y);
        if (to.slot) setIndex(to.slot, from.x, from.y);
        return { touched, warnings };
      }

      assertCanHold(to, from.slot);
      if (to.slot) assertCanHold(from, to.slot);

      if (!to.slot) {
        // Into an empty cell: move as much as fits one stack there, leave the rest.
        const limit = stacks.limitFor(from.slot, to.inv);
        if (limit === null) throw new OpError(`Can't confirm the game's stack limit for ${toDisplay(from.slot.Id)} in ${to.info.where}, so it stays where it is`);
        if (num(from.slot.Amount) > limit) {
          const part = parse(stringify(from.slot));
          part.Amount = setNum(part.Amount, limit);
          part.MaxAmount = setNum(part.MaxAmount, limit);
          setIndex(part, to.x, to.y);
          to.inv.Slots.push(part);
          from.slot.Amount = setNum(from.slot.Amount, num(from.slot.Amount) - limit);
          warnings.push(`Moved ${limit} ${toDisplay(from.slot.Id)} (one full stack in ${to.info.where}); the rest stayed behind`);
          return { touched, warnings };
        }
      }
      fitStack(from.slot, to, stacks);
      if (to.slot) fitStack(to.slot, from, stacks);

      const moving = from.slot;
      const swapping = to.slot;
      // Remove both first (higher index first if they share an array — they don't here).
      from.inv.Slots.splice(from.index, 1);
      if (swapping) to.inv.Slots.splice(to.inv.Slots.indexOf(swapping), 1);
      setIndex(moving, to.x, to.y);
      to.inv.Slots.push(moving);
      if (swapping) {
        setIndex(swapping, from.x, from.y);
        from.inv.Slots.push(swapping);
      }
      return { touched, warnings };
    }
    case 'setCurrency': {
      if (!(op.field in CURRENCIES)) throw new OpError(`Unknown currency ${op.field}`);
      const ps = get(tree, PS);
      ps[op.field] = setNum(ps[op.field], amountInt(op.value, 0, INT32_MAX, CURRENCIES[op.field]));
      return { touched: [[...PS, op.field]], warnings };
    }
    case 'rename': {
      const path = cat.names.get(op.target);
      if (!path) throw new OpError('That cannot be renamed');
      const name = String(op.name ?? '');
      if (/[\u0000-\u001f]/.test(name)) throw new OpError('Names cannot contain control characters');
      if (Buffer.byteLength(name, 'utf8') > NAME_MAX_BYTES) throw new OpError(`Names are limited to ${NAME_MAX_BYTES} bytes`);
      const owner = get(tree, path.slice(0, -1));
      owner[path.at(-1)] = fromDisplay(name);
      return { touched: [path], warnings };
    }
    default:
      throw new OpError(`Unknown operation ${op?.op}`);
  }
}

function setIndex(slot, x, y) {
  slot.Index.X = setNum(slot.Index.X, x);
  slot.Index.Y = setNum(slot.Index.Y, y);
}

// Different inventories can have different stack limits for the same item.
function fitStack(slot, dest, stacks) {
  const limit = stacks.limitFor(slot, dest.inv);
  if (limit === null) {
    throw new OpError(`Can't confirm the game's stack limit for ${toDisplay(slot.Id)} in ${dest.info.where}, so it stays where it is`);
  }
  if (num(slot.Amount) > limit) throw new OpError(`Only ${limit} ${toDisplay(slot.Id)} fit in one stack there; reduce the amount first`);
  slot.MaxAmount = setNum(slot.MaxAmount, limit);
}

// Rule checks for one inventory; returns human-readable problems.
export function inventoryProblems(inv) {
  const problems = [];
  const w = num(inv.Width);
  const h = num(inv.Height);
  const valid = new Set(inv.ValidSlotIndices.map((i) => cellKey(num(i.X), num(i.Y))));
  const seen = new Set();
  for (const s of inv.Slots) {
    const x = num(s.Index.X);
    const y = num(s.Index.Y);
    const k = cellKey(x, y);
    if (x < 0 || y < 0 || x >= w || y >= h) problems.push(`${s.Id} at ${k} is outside the grid`);
    else if (!valid.has(k)) problems.push(`${s.Id} at ${k} is in a locked cell`);
    if (seen.has(k)) problems.push(`Two items share cell ${k}`);
    seen.add(k);
    if (isBulkItem(s)) {
      const a = num(s.Amount);
      if (!Number.isInteger(a) || a < 1) problems.push(`${s.Id} at ${k} has invalid amount ${a}`);
      if (a > num(s.MaxAmount)) problems.push(`${s.Id} at ${k} exceeds its stack limit`);
    }
  }
  return problems;
}
