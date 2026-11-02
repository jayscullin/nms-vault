// Helpers for the browser tests: reset fixtures, read written saves from disk,
// and drive common UI steps.

import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { applyEnv, SAVE_ROOT } from './env.js';
import { buildFixtures, ACCOUNT, writeSave, saveTree } from '../test/fixtures/build.js';

applyEnv();
const S = await import('../src/saves.js');
const { decodeSave } = await import('../src/codec.js');
const { deobfuscate } = await import('../src/keys.js');

export { ACCOUNT, saveTree };
export const accountDir = path.join(SAVE_ROOT, ACCOUNT);

export const resetFixtures = () => buildFixtures(SAVE_ROOT);
export const writeFixtureSave = (file, tree) => writeSave(accountDir, file, tree);
export const fileExists = (file) => fs.existsSync(path.join(accountDir, file));

// The save as the game would read it, with readable keys.
export const readSave = (file) => JSON.parse(deobfuscate(decodeSave(fs.readFileSync(path.join(accountDir, file))).text, S.mapping));
// Byte-exact rewrite check plus manifest sizes, the same check as the Verify button.
export const verifyFile = (file) => S.verifyRoundTrip(ACCOUNT, file);
export const exosuitSlots = (tree) => tree.BaseContext.PlayerStateData.Inventory.Slots;

export async function home(page) {
  await page.goto('/');
  await expect(page.locator('.slot-group').first()).toBeVisible();
}

export async function openSave(page, file) {
  await home(page);
  await page.locator(`[data-action="open"][data-file="${file}"]`).first().click();
  await expect(page.locator('.content h2')).toBeVisible();
}

// A grid cell by inventory section index (0 = first inventory shown) and coordinates.
export const cell = (page, section, x, y) => page.locator('.inv').nth(section).locator(`.cell[data-x="${x}"][data-y="${y}"]`);

export async function reviewAndWrite(page) {
  await page.locator('[data-action="review"]').click();
  const dialog = page.locator('.modal');
  await expect(dialog.getByRole('heading', { name: 'Review changes' })).toBeVisible();
  await expect(dialog.locator('.checks .bad')).toHaveCount(0);
  await dialog.locator('[data-action="commit"]').click();
  await expect(page.locator('.modal').getByRole('heading', { name: 'Saved' })).toBeVisible();
  await page.locator('.modal [data-action="close-modal"]').click();
}

// Accept every confirm() and remember the messages.
export function acceptDialogs(page) {
  const messages = [];
  page.on('dialog', (d) => {
    messages.push(d.message());
    d.accept();
  });
  return messages;
}
