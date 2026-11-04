// Runs the browser tests with the installed game's data, on any system.
import { spawnSync } from 'node:child_process';

const { status } = spawnSync('npx', ['playwright', 'test', ...process.argv.slice(2)], { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, E2E_GAMEDATA: '1' } });
process.exit(status ?? 1);
