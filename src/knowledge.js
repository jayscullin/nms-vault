// Per-save knowledge: alien words (KnownWordGroups) and learned blueprints
// (KnownTech / KnownProducts). Only entries from the game's own tables are added.

import { OpError } from './inventory.js';
import { parse, stringify } from './losslessJson.js';

const PS = ['BaseContext', 'PlayerStateData'];
export const RACE_NAMES = { 0: 'Gek', 1: 'Vy’keen', 2: 'Korvax', 4: 'Atlas', 8: 'Autophage' };

const strip = (v) => String(v).replace(/^\^/, '');
const ps = (tree) => tree.BaseContext?.PlayerStateData ?? {};

export function knowledgeState(tree, catalog) {
  const groups = new Map((ps(tree).KnownWordGroups ?? []).map((g) => [strip(g.Group), g.Races]));
  const words = Object.entries(RACE_NAMES).map(([race, name]) => {
    const all = (catalog?.wordGroups ?? []).filter((g) => g.race === Number(race));
    return { race: Number(race), name, total: all.length, known: all.filter((g) => groups.get(g.group)?.[race] === true).length };
  });
  const known = new Set([...(ps(tree).KnownTech ?? []), ...(ps(tree).KnownProducts ?? [])].map(strip));
  const blueprints = (catalog?.blueprints ?? []).map((b) => ({ ...b, known: known.has(b.id) }));
  return { words, blueprints };
}

// Applies one knowledge op in place; returns { touched, warnings }.
export function applyKnowledgeOp(tree, catalog, op) {
  const state = ps(tree);
  switch (op?.op) {
    case 'learnWords': {
      const list = state.KnownWordGroups;
      if (!Array.isArray(list)) throw new OpError('This save has no known-words list');
      const races = (Array.isArray(op.races) ? op.races : []).map(Number).filter((r) => r in RACE_NAMES);
      if (!races.length) throw new OpError('Choose a race');
      // New entries copy an existing entry's shape (field order, race count).
      const template = list[0];
      if (!template) throw new OpError('There is no known word in this save to copy the format from');
      const byGroup = new Map(list.map((g) => [strip(g.Group), g]));
      let learned = 0;
      for (const { group, race } of catalog?.wordGroups ?? []) {
        if (!races.includes(race)) continue;
        let entry = byGroup.get(group);
        if (!entry) {
          entry = parse(stringify(template));
          entry.Group = `^${group}`;
          entry.Races = entry.Races.map(() => false);
          list.push(entry);
          byGroup.set(group, entry);
        }
        if (race >= entry.Races.length) continue;
        if (entry.Races[race] !== true) {
          entry.Races[race] = true;
          learned++;
        }
      }
      if (!learned) throw new OpError('Those words are already known');
      return { touched: [[...PS, 'KnownWordGroups']], warnings: [] };
    }
    case 'learnBlueprints': {
      const byId = new Map((catalog?.blueprints ?? []).map((b) => [b.id, b]));
      const ids = [...new Set(Array.isArray(op.ids) ? op.ids.map(String) : [])];
      if (!ids.length) throw new OpError('Nothing to learn');
      const unknown = ids.find((id) => !byId.has(id));
      if (unknown) throw new OpError(`${unknown} isn't one of the game's learnable blueprints`);
      const touched = new Set();
      for (const id of ids) {
        const field = byId.get(id).type === 'Technology' ? 'KnownTech' : 'KnownProducts';
        const list = state[field];
        if (!Array.isArray(list)) throw new OpError(`This save has no ${field} list`);
        if (list.some((v) => strip(v) === id)) continue;
        list.push(`^${id}`);
        touched.add(field);
      }
      if (!touched.size) throw new OpError('Those blueprints are already known');
      return { touched: [...touched].map((f) => [...PS, f]), warnings: [] };
    }
    default:
      throw new OpError(`Unknown operation ${op?.op}`);
  }
}
