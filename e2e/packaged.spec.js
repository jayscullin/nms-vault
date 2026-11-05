// The Quit button, which only a packaged build shows. Needs a built executable:
// NMS_VAULT_EXE=<path> npx playwright test e2e/packaged.spec.js

import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFixtures } from '../test/fixtures/build.js';
import { cell, confirmDialog } from './helpers.js';

const EXE = process.env.NMS_VAULT_EXE;
const url = 'http://localhost:5296/';
test.skip(!EXE, 'Needs a built executable');

test('a packaged build can be quit from the page, warning about unsaved changes', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nms-vault-quit-'));
  buildFixtures(path.join(root, 'saves'));
  const server = spawn(EXE, ['--no-open'], { env: { ...process.env, PORT: '5296', NMS_SAVE_ROOT: path.join(root, 'saves'), NMS_VAULT_HOME: path.join(root, 'vault'), NMS_GAME_DIR: path.join(root, 'none') }, stdio: 'ignore' });
  const stopped = new Promise((resolve) => server.on('exit', resolve));
  try {
    await expect(async () => expect((await fetch(url)).ok).toBe(true)).toPass({ timeout: 15_000 });
    await page.goto(url);
    await page.locator('[data-action="open"][data-file="save.hg"]').first().click();
    await cell(page, 0, 0, 0).click();
    await page.keyboard.press('f');
    await expect(page.locator('.badge')).toHaveText('1');
    await page.locator('[data-action="quit"]').click();
    expect(await confirmDialog(page)).toContain('discard your unsaved changes');
    await expect(page.locator('h1')).toHaveText('NMS Vault has stopped');
    expect(await stopped).toBe(0);
  } finally {
    server.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
