// Browser tests for the core UI. Every write is validated on disk: the file must
// decode, round-trip byte-exact, have matching manifest sizes, and contain the change.

import { test, expect } from '@playwright/test';
import {
  resetFixtures, readSave, verifyFile, exosuitSlots, home, openSave, cell, reviewAndWrite,
  confirmDialog, writeFixtureSave, saveTree, fileExists,
} from './helpers.js';

test.beforeEach(() => resetFixtures());

test.describe('home screen', () => {
  test('shows the test banner, one save per slot, and the earlier save collapsed', async ({ page }) => {
    await home(page);
    await expect(page.locator('#test-banner')).toBeVisible();
    const groups = page.locator('.slot-group');
    await expect(groups).toHaveCount(2);
    await expect(groups.nth(0).locator(':scope > .slot-row')).toContainText('Aboard the Space Anomaly');
    const earlier = groups.nth(0).locator('details.earlier');
    await expect(earlier).toHaveCount(1);
    await expect(earlier).not.toHaveAttribute('open', '');
    await earlier.locator('summary').click();
    await expect(earlier.locator('.slot-row')).toContainText('On a planet');
  });

  test('Verify proves a save round-trips without writing', async ({ page }) => {
    await home(page);
    await page.locator('[data-action="verify"][data-file="save.hg"]').first().click();
    const result = page.locator('.verify-result').first();
    await expect(result).toContainText('Manifest decrypts and matches');
    await expect(result.locator('span[style*="--bad"]')).toHaveCount(0);
  });

  test('flags two slots that hold the same save', async ({ page }) => {
    writeFixtureSave('save4.hg', saveTree()); // same save id as slot 1, placed in slot 2
    await home(page);
    await expect(page.locator('.slot-warning')).toHaveCount(2);
    await expect(page.locator('.slot-warning').first()).toContainText('cross-save conflict');
  });
});

test.describe('editing', () => {
  test('set an amount, review, write; the file holds exactly that change', async ({ page }) => {
    const before = readSave('save.hg');
    await openSave(page, 'save.hg');
    await cell(page, 0, 0, 0).locator('.tile').click();
    await page.locator('.amount-form input[name="amount"]').fill('42');
    await page.locator('.amount-form button[type="submit"]').click();
    await expect(page.locator('.badge')).toHaveText('1');
    await reviewAndWrite(page);

    expect(verifyFile('save.hg').ok).toBe(true);
    const after = readSave('save.hg');
    expect(exosuitSlots(after)[0].Amount).toBe(42);
    exosuitSlots(after)[0].Amount = exosuitSlots(before)[0].Amount;
    expect(after).toEqual(before);
  });

  test('an amount over the stack limit is refused', async ({ page }) => {
    await openSave(page, 'save.hg');
    await cell(page, 0, 2, 0).locator('.tile').click(); // Warp Hypercore, limit 20
    await page.locator('.amount-form input[name="amount"]').evaluate((el) => {
      el.removeAttribute('max');
      el.value = '25';
    });
    await page.locator('.amount-form button[type="submit"]').click();
    await expect(page.locator('.toast.error')).toContainText('1 to 20');
    await expect(page.locator('.badge')).toHaveCount(0);
  });

  test('drag an item to another cell and write it', async ({ page }) => {
    await openSave(page, 'save.hg');
    await cell(page, 0, 1, 0).locator('.tile').dragTo(cell(page, 0, 5, 3));
    await expect(cell(page, 0, 5, 3).locator('.tile')).toBeVisible();
    await expect(cell(page, 0, 1, 0).locator('.tile')).toHaveCount(0);
    await reviewAndWrite(page);
    expect(verifyFile('save.hg').ok).toBe(true);
    const land = exosuitSlots(readSave('save.hg')).find((s) => s.Id === '^LAND1');
    expect(land.Index).toEqual({ X: 5, Y: 3 });
  });

  test('technology cannot be dropped into a general inventory', async ({ page }) => {
    await openSave(page, 'save.hg');
    await cell(page, 1, 0, 0).locator('.tile').dragTo(cell(page, 0, 5, 3)); // Life Support -> exosuit General
    await expect(cell(page, 0, 5, 3).locator('.tile')).toHaveCount(0);
    await expect(cell(page, 1, 0, 0).locator('.tile')).toBeVisible();
    await expect(page.locator('.badge')).toHaveCount(0);
  });

  test('sort an inventory by name and write it', async ({ page }) => {
    await openSave(page, 'save.hg');
    const tools = page.locator('.inv').nth(0).locator('.inv-tools');
    await tools.locator('[data-sort-by]').selectOption('name');
    await tools.locator('[data-action="sort"]').click();
    await expect(page.locator('.badge')).toHaveText('1');
    // Grid cells are in row order, so the shown names must now be alphabetical.
    const names = (await page.locator('.inv').nth(0).locator('.tile').evaluateAll((tiles) => tiles.map((t) => t.getAttribute('aria-label'))))
      .map((l) => l.replace(/ \(\^.*\)$/, '').toLowerCase());
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    await reviewAndWrite(page);
    expect(verifyFile('save.hg').ok).toBe(true);
    // Written layout: one item per cell, filling the first row from the left.
    const cells = exosuitSlots(readSave('save.hg')).map((s) => `${s.Index.X},${s.Index.Y}`).sort();
    expect(cells).toEqual(['0,0', '1,0', '2,0', '3,0']);
    // Technology grids have no sort control.
    await expect(page.locator('.inv').nth(1).locator('.inv-tools')).toHaveCount(0);
  });

  test('unlock the locked slots of a ship and write it', async ({ page }) => {
    await openSave(page, 'save.hg');
    await page.locator('.nav-item', { hasText: 'Test Ship' }).click();
    const button = page.locator('.inv').nth(0).locator('[data-action="unlock-slots"]');
    await expect(button).toHaveText('Unlock 5 slots');
    await button.click();
    await expect(page.locator('.inv').nth(0).locator('.cell.locked')).toHaveCount(0);
    await expect(button).toHaveCount(0);
    await reviewAndWrite(page);
    expect(verifyFile('save.hg').ok).toBe(true);
    expect(readSave('save.hg').BaseContext.PlayerStateData.ShipOwnership[0].Inventory.ValidSlotIndices).toHaveLength(15);
    // Storage containers keep their game cap: no unlock button.
    await page.locator('.nav-item', { hasText: 'Supplies' }).click();
    await expect(page.locator('[data-action="unlock-slots"]')).toHaveCount(0);
  });

  test('clicking a locked cell unlocks just that slot', async ({ page }) => {
    await openSave(page, 'save.hg');
    await page.locator('.nav-item', { hasText: 'Test Ship' }).click();
    const grid = page.locator('.inv').nth(0);
    await expect(grid.locator('.cell.locked')).toHaveCount(5);
    await grid.locator('.cell[data-x="2"][data-y="2"]').click();
    await expect(grid.locator('.cell.locked')).toHaveCount(4);
    await expect(grid.locator('.cell[data-x="2"][data-y="2"]')).not.toHaveClass(/locked/);
    await expect(grid.locator('[data-action="unlock-slots"]')).toHaveText('Unlock 4 slots');
    await reviewAndWrite(page);
    expect(verifyFile('save.hg').ok).toBe(true);
    const valid = readSave('save.hg').BaseContext.PlayerStateData.ShipOwnership[0].Inventory.ValidSlotIndices;
    expect(valid).toHaveLength(11);
    expect(valid).toContainEqual({ X: 2, Y: 2 });
  });

  test('a group page shows every member and items drag between them', async ({ page }) => {
    await openSave(page, 'save.hg');
    await page.locator('.group-title', { hasText: 'Storage' }).click();
    await expect(page.locator('.content > h2')).toHaveText('Storage');
    await expect(page.locator('.group-member')).toHaveCount(2);
    const supplies = page.locator('.group-member').nth(0);
    const other = page.locator('.group-member').nth(1);
    await supplies.locator('.cell[data-x="0"][data-y="0"] .tile').dragTo(other.locator('.cell[data-x="0"][data-y="0"]'));
    await expect(other.locator('.cell[data-x="0"][data-y="0"] .tile')).toBeVisible();
    await reviewAndWrite(page);
    expect(verifyFile('save.hg').ok).toBe(true);
    const ps = readSave('save.hg').BaseContext.PlayerStateData;
    expect(ps.Chest1Inventory.Slots.find((s) => s.Id === '^HYPERFUEL2')).toBeUndefined();
    expect(ps.Chest2Inventory.Slots[0]).toMatchObject({ Id: '^HYPERFUEL2', Amount: 30, MaxAmount: 40 });
  });

  test('keyboard shortcuts: arrows, F, Delete, S, U, ⌘Z, ? and ⌘S to save', async ({ page }) => {
    await openSave(page, 'save.hg');
    const kb = page.keyboard;
    await kb.press('ArrowRight'); // nothing selected yet: starts at the first cell
    await expect(cell(page, 0, 0, 0)).toHaveClass(/selected/);
    await kb.press('ArrowRight');
    await kb.press('ArrowRight'); // Warp Hypercore, 5/20
    await expect(cell(page, 0, 2, 0)).toHaveClass(/selected/);
    await kb.press('f');
    await expect(cell(page, 0, 2, 0).locator('.amt')).toHaveText('20/20');
    await kb.press('ArrowLeft'); // Ferrite (LAND1)
    await kb.press('Delete');
    await expect(cell(page, 0, 1, 0).locator('.tile')).toHaveCount(0);
    await kb.press('Meta+z');
    await expect(cell(page, 0, 1, 0).locator('.tile')).toBeVisible();
    await kb.press('s');
    await expect(page.locator('.badge')).toHaveText('2');
    await kb.press('?');
    await expect(page.locator('.modal').getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
    await kb.press('Escape');
    await page.locator('.nav-item', { hasText: 'Test Ship' }).click();
    await kb.press('u');
    await expect(page.locator('.badge')).toHaveText('3');
    // ⌘S opens the review, ⌘S again writes.
    await kb.press('Meta+s');
    await expect(page.locator('.modal').getByRole('heading', { name: 'Review changes' })).toBeVisible();
    await kb.press('Meta+s');
    await expect(page.locator('.modal').getByRole('heading', { name: 'Saved' })).toBeVisible();
    expect(verifyFile('save.hg').ok).toBe(true);
    const ps = readSave('save.hg').BaseContext.PlayerStateData;
    expect(ps.Inventory.Slots.find((x) => x.Id === '^HYPERFUEL2').Amount).toBe(20);
    expect(ps.ShipOwnership[0].Inventory.ValidSlotIndices).toHaveLength(15);
  });

  test('undo and discard drop staged changes', async ({ page }) => {
    await openSave(page, 'save.hg');
    await cell(page, 0, 0, 0).locator('.tile').click();
    await page.locator('[data-action="fill"]').click();
    await expect(page.locator('.badge')).toHaveText('1');
    await page.locator('[data-action="undo"]').click();
    await expect(page.locator('.badge')).toHaveCount(0);
    await page.locator('[data-action="fill"]').click();
    await page.locator('[data-action="reset"]').click();
    await confirmDialog(page);
    await expect(page.locator('.badge')).toHaveCount(0);
  });

  test('edit Units in the top bar and write it', async ({ page }) => {
    await openSave(page, 'save.hg');
    const units = page.locator('input[data-currency="Units"]');
    await units.click();
    await units.fill('987654');
    await units.press('Enter');
    await expect(page.locator('.badge')).toHaveText('1');
    await reviewAndWrite(page);
    expect(verifyFile('save.hg').ok).toBe(true);
    expect(readSave('save.hg').BaseContext.PlayerStateData.Units).toBe(987654);
  });
});

test.describe('save slots', () => {
  test('copy to an empty slot creates a separate save with a new id', async ({ page }) => {
    await home(page);
    await page.locator('[data-action="slot-menu"][data-file="save.hg"]').first().click();
    await page.locator('#slot-target').selectOption('save5.hg');
    await page.locator('[data-action="slot-op"][data-op="copy"]').click();
    expect(await confirmDialog(page)).toContain('new save ID');
    await expect(page.locator('.toast').last()).toContainText('verified');
    await expect(page.locator('.slot-group')).toHaveCount(3);
    expect(verifyFile('save5.hg').ok).toBe(true);
    expect(readSave('save5.hg').CommonStateData.SaveUniversalId).not.toBe(readSave('save.hg').CommonStateData.SaveUniversalId);
    await expect(page.locator('.slot-warning')).toHaveCount(0);
  });

  test('delete warns about Steam Cloud and removes the files', async ({ page }) => {
    await home(page);
    await page.locator('[data-action="slot-menu"][data-file="save3.hg"]').first().click();
    await page.locator('[data-action="slot-op"][data-op="delete"]').click();
    expect(await confirmDialog(page)).toContain('Steam Cloud');
    await expect(page.locator('.slot-group')).toHaveCount(1);
    expect(fileExists('save3.hg')).toBe(false);
    expect(fileExists('mf_save3.hg')).toBe(false);
  });

  test('export downloads the save as readable JSON', async ({ page }) => {
    await home(page);
    await page.locator('[data-action="slot-menu"][data-file="save.hg"]').first().click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-action="export-json"]').click()]);
    const json = JSON.parse(await (await import('node:fs')).promises.readFile(await download.path(), 'utf8'));
    expect(json.CommonStateData.SaveUniversalId).toBe(readSave('save.hg').CommonStateData.SaveUniversalId);
    expect(json.BaseContext.PlayerStateData.Inventory.Slots[0].Id).toBe('^FUEL1');
  });

  test('backups list every write and restore puts a save back', async ({ page }) => {
    await home(page);
    await page.locator('[data-action="slot-menu"][data-file="save3.hg"]').first().click();
    await page.locator('[data-action="slot-op"][data-op="delete"]').click();
    await confirmDialog(page);
    await expect(page.locator('.slot-group')).toHaveCount(1);
    await page.locator('[data-action="backups"]').click();
    await page.locator('.modal [data-action="restore"]').first().click();
    await confirmDialog(page);
    await expect(page.locator('.toast').last()).toContainText('Restored');
    await expect(page.locator('.slot-group')).toHaveCount(2);
    expect(verifyFile('save3.hg').ok).toBe(true);
  });
});

test.describe('account rewards', () => {
  test('opens the account file and explains when game data is missing', async ({ page }) => {
    await home(page);
    await page.locator('[data-file="accountdata.hg"]').click();
    await expect(page.getByRole('heading', { name: 'Account rewards' })).toBeVisible();
    await expect(page.locator('[data-reward-tab]')).toHaveCount(4);
  });
});
