// Account reward unlocking (accountdata.hg). Unlocked rewards are lists of ids
// in UserSettingsData; the game offers unlocked rewards to claim in-game.

import { OpError } from './inventory.js';

export const REWARD_LISTS = {
  season: { field: 'UnlockedSeasonRewards', label: 'Expedition rewards' },
  twitch: { field: 'UnlockedTwitchRewards', label: 'Twitch rewards' },
};

const listPath = (key) => ['UserSettingsData', REWARD_LISTS[key].field];
const isSorted = (list) => list.every((v, i) => i === 0 || list[i - 1] <= v);

export function unlockedIds(tree, key) {
  const list = tree.UserSettingsData?.[REWARD_LISTS[key]?.field];
  return Array.isArray(list) ? list.map((v) => String(v).replace(/^\^/, '')) : [];
}

// Applies one reward op in place. `catalog` is the game's reward lists (rewardCatalog()).
export function applyRewardOp(tree, catalog, op) {
  if (op?.op !== 'unlockRewards') throw new OpError(`Unknown operation ${op?.op}`);
  const meta = REWARD_LISTS[op.list];
  if (!meta) throw new OpError('Unknown reward list');
  const list = tree.UserSettingsData?.[meta.field];
  if (!Array.isArray(list)) throw new OpError(`This account file has no ${meta.label.toLowerCase()} list`);
  const known = new Set((catalog?.[op.list] ?? []).map((r) => r.id));
  const ids = [...new Set(Array.isArray(op.ids) ? op.ids.map(String) : [])];
  if (!ids.length) throw new OpError('Nothing to unlock');
  const unknown = ids.find((id) => !known.has(id));
  if (unknown) throw new OpError(`${unknown} isn't one of the game's ${meta.label.toLowerCase()}`);
  const have = new Set(unlockedIds(tree, op.list));
  const add = ids.filter((id) => !have.has(id)).map((id) => `^${id}`);
  if (!add.length) throw new OpError('Those rewards are already unlocked');
  // The game keeps these lists sorted; keep that order (or append if it never was).
  const sorted = isSorted(list);
  list.push(...add);
  if (sorted) list.sort();
  return { touched: [listPath(op.list)], warnings: [] };
}
