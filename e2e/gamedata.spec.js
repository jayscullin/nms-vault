// Browser tests that need the installed game's data (names, icons, adding items,
// knowledge, rewards). Run with E2E_GAMEDATA=1 on a machine with the game installed.

import { test, expect } from '@playwright/test';
import { USE_GAMEDATA } from './env.js';
import { resetFixtures, readSave, verifyFile, exosuitSlots, home, openSave, cell, reviewAndWrite, confirmDialog } from './helpers.js';

test.skip(!USE_GAMEDATA, 'needs the game installed (E2E_GAMEDATA=1)');
test.beforeEach(() => resetFixtures());

test('items show real names, and hovering shows the description', async ({ page }) => {
  await openSave(page, 'save.hg');
  const tile = cell(page, 0, 0, 0).locator('.tile');
  await expect(tile).toHaveAttribute('aria-label', /^Carbon /);
  await tile.hover();
  await expect(page.locator('#item-tip')).toContainText('Carbon');
});

test('add an item from the catalogue to an empty cell', async ({ page }) => {
  await openSave(page, 'save.hg');
  await cell(page, 0, 5, 3).click();
  await page.locator('[data-action="add-item"]').click();
  await page.locator('#add-search').fill('Ferrite Dust');
  const row = page.locator('.add-row').filter({ hasText: 'Ferrite Dust' }).first();
  await row.locator('input[type="number"]').fill('123');
  await row.locator('[data-action="add-confirm"]').click();
  await expect(cell(page, 0, 5, 3).locator('.tile')).toBeVisible();
  await reviewAndWrite(page);
  expect(verifyFile('save.hg').ok).toBe(true);
  const added = exosuitSlots(readSave('save.hg')).find((s) => s.Index.X === 5 && s.Index.Y === 3);
  expect([added.Id, added.Amount, added.MaxAmount]).toEqual(['^LAND1', 123, 9999]);
});

test('remove, recharge and repair technology, then write', async ({ page }) => {
  await openSave(page, 'save.hg');
  const tech = (x) => cell(page, 1, x, 0).locator('.tile');
  // Upgrade module (not core): can be removed.
  await tech(1).click();
  await page.locator('[data-action="remove"]').click();
  expect(await confirmDialog(page)).toContain('Remove');
  await expect(tech(1)).toHaveCount(0);
  // Life Support at 50/100: core, chargeable.
  await tech(0).click();
  await expect(page.locator('[data-action="remove"]')).toHaveCount(0);
  await page.locator('[data-action="recharge"]').click();
  // Damaged Exocraft Summoning Unit: repair.
  await tech(2).click();
  await page.locator('[data-action="repair"]').click();
  await expect(page.locator('.badge')).toHaveText('3');
  await reviewAndWrite(page);

  expect(verifyFile('save.hg').ok).toBe(true);
  const slots = readSave('save.hg').BaseContext.PlayerStateData.Inventory_TechOnly.Slots;
  expect(slots.find((s) => s.Id.startsWith('^UP_HOT3'))).toBeUndefined();
  expect(slots.find((s) => s.Id === '^ENERGY').Amount).toBe(100);
  const summon = slots.find((s) => s.Id === '^SUMMON_SUIT');
  expect([summon.DamageFactor, summon.FullyInstalled]).toEqual([0, true]);
});

test('learn all Korvax words', async ({ page }) => {
  await openSave(page, 'save.hg');
  await page.locator('[data-select="knowledge"]').click();
  await page.locator('[data-action="learn-words"][data-race="2"]').click();
  await expect(page.locator('.word-card').filter({ hasText: 'Korvax' })).toContainText('All known');
  await reviewAndWrite(page);
  expect(verifyFile('save.hg').ok).toBe(true);
  const groups = readSave('save.hg').BaseContext.PlayerStateData.KnownWordGroups;
  expect(groups.filter((g) => g.Group.startsWith('^EXP_') && g.Races[2]).length).toBeGreaterThan(100);
});

test('unlock a title in the account file', async ({ page }) => {
  await home(page);
  await page.locator('[data-file="accountdata.hg"]').click();
  await page.locator('[data-reward-tab="titles"]').click();
  await page.locator('.reward:not(:disabled)').first().click();
  await page.locator('[data-action="unlock-selected"]').click();
  await expect(page.locator('.badge')).toHaveText('1');
  await reviewAndWrite(page);
  expect(verifyFile('accountdata.hg').ok).toBe(true);
});

test('the item catalogue opens in a modal without a save, from the top bar', async ({ page }) => {
  await home(page);
  await page.locator('.topbar [data-action="catalogue"]').click();
  const dialog = page.locator('.modal.wide');
  await expect(dialog.getByRole('heading', { name: 'Item catalogue' })).toBeVisible();
  await page.locator('#cat-search').fill('pulse engine');
  await expect(dialog.locator('.cat-row').first()).toContainText('Pulse Engine');
  await expect(page.locator('#cat-search')).toBeFocused();
  await dialog.locator('[data-cat-type="Technology"]').click();
  await expect(dialog.locator('.cat-meta').first()).toContainText('Technology');
});

test('the catalogue modal opens over an open save and closing it keeps staged changes', async ({ page }) => {
  await openSave(page, 'save.hg');
  await cell(page, 0, 0, 0).locator('.tile').click();
  await page.keyboard.press('f');
  await expect(page.locator('.badge')).toHaveText('1');
  await page.locator('.topbar [data-action="catalogue"]').click();
  await expect(page.locator('.modal.wide').getByRole('heading', { name: 'Item catalogue' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(page.locator('.content h2')).toContainText('Exosuit');
  await expect(page.locator('.badge')).toHaveText('1');
});
