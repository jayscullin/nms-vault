// Starts NMS Vault for the browser tests against freshly generated fixture saves.
import fs from 'node:fs';
import { applyEnv, SAVE_ROOT, VAULT_HOME } from './env.js';
import { buildFixtures } from '../test/fixtures/build.js';

applyEnv();
fs.rmSync(VAULT_HOME, { recursive: true, force: true });
buildFixtures(SAVE_ROOT);
process.argv.push('--no-open');
await import('../server.js');
