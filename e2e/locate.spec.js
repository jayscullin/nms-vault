// The Locate saves dialog, on its own server: the shared test server sets
// NMS_SAVE_ROOT, which deliberately turns the option off.

import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFixtures, ACCOUNT } from '../test/fixtures/build.js';

const PORT = 5298;
const url = `http://localhost:${PORT}/`;
let root;
let nms;
let server;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nms-vault-locate-e2e-'));
  nms = path.join(root, 'PC share', 'NMS');
  buildFixtures(nms);
  // A home folder of its own, so the usual save folder is empty on any machine.
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const env = { ...process.env, PORT: String(PORT), HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData'), NMS_VAULT_HOME: path.join(root, 'vault'), NMS_GAME_DIR: path.join(root, 'no-game') };
  delete env.NMS_SAVE_ROOT;
  server = spawn(process.execPath, ['server.js', '--no-open'], { env, stdio: 'ignore' });
  await expect(async () => {
    expect((await fetch(url)).ok).toBe(true);
  }).toPass({ timeout: 15_000 });
});

test.afterAll(() => {
  server?.kill();
  fs.rmSync(root, { recursive: true, force: true });
});

test('browse to a folder, use it, remember it, and go back', async ({ page }) => {
  await page.goto(url);
  // With no saves, the page asks for them; the top bar offers the same thing.
  await expect(page.locator('.no-saves')).toContainText('No saves found');
  await expect(page.locator('#save-info [data-action="locate"]')).toHaveText(/Locate saves/i);
  await expect(page.locator('#save-info')).not.toContainText('No save open');
  await page.locator('.no-saves [data-action="locate"]').click();
  const use = page.locator('[data-action="locate-use"]');

  // Type the parent, then click through to the folder with saves in it.
  await page.locator('.locate-form input').fill(path.dirname(nms));
  await page.locator('.locate-form input').press('Enter');
  await expect(page.locator('.locate-status')).toContainText('No saves in this folder');
  await expect(use).toBeDisabled();
  await page.locator('.locate-dir', { hasText: 'NMS' }).click();
  await expect(page.locator('.locate-status')).toContainText(`in ${ACCOUNT}`);

  // A mistyped path says so and can't be used.
  await page.locator('.locate-form input').fill(path.join(root, 'nope'));
  await page.locator('.locate-form input').press('Enter');
  await expect(page.locator('.locate-status')).toContainText('can’t be opened');
  await expect(use).toBeDisabled();
  await page.locator('.locate-form input').fill(nms);
  await page.locator('.locate-form input').press('Enter');
  await expect(use).toBeEnabled();
  await use.click();

  await expect(page.locator('.save-folder')).toContainText('chosen by you');
  await expect(page.locator('.save-folder')).toContainText(nms);
  await expect(page.locator('.account').first()).toContainText(ACCOUNT);
  await expect(page.locator('.slot-group').first()).toBeVisible();
  await expect(page.locator('.no-saves')).toHaveCount(0);

  await page.reload();
  await expect(page.locator('.save-folder')).toContainText('chosen by you');

  await page.locator('[data-action="locate-auto"]').click();
  await expect(page.locator('.save-folder')).not.toContainText('chosen by you');
  await expect(page.locator('.save-folder')).not.toContainText(nms);
  await expect(page.locator('.no-saves')).toBeVisible();
});

test('a chosen folder that goes away asks again', async ({ page }) => {
  const share = path.join(root, 'unplugged');
  buildFixtures(share);
  await page.goto(url);
  await page.locator('#save-info [data-action="locate"]').click();
  await page.locator('.locate-form input').fill(share);
  await page.locator('.locate-form input').press('Enter');
  await page.locator('[data-action="locate-use"]').click();
  await expect(page.locator('.slot-group').first()).toBeVisible();

  fs.rmSync(share, { recursive: true });
  await page.reload();
  await expect(page.locator('.no-saves')).toContainText('check that it’s connected');
  await page.locator('[data-action="locate-auto"]').click();
  await expect(page.locator('.save-folder')).not.toContainText('chosen by you');
});
