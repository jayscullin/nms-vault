// Shared test environment: where fixture saves live and whether game data is used.
// Game data (names, icons, adding items, knowledge, rewards) is only used when
// E2E_GAMEDATA=1 and the game is installed; otherwise those tests are skipped.

import path from 'node:path';

export const PORT = 5299;
export const TMP = path.join(import.meta.dirname, '.tmp');
export const SAVE_ROOT = path.join(TMP, 'saves');
export const VAULT_HOME = path.join(TMP, 'vault');
export const USE_GAMEDATA = process.env.E2E_GAMEDATA === '1';

export function applyEnv() {
  process.env.NMS_SAVE_ROOT = SAVE_ROOT;
  process.env.NMS_VAULT_HOME = VAULT_HOME;
  process.env.PORT = String(PORT);
  if (!USE_GAMEDATA) process.env.NMS_GAME_DIR = path.join(TMP, 'no-game');
}
