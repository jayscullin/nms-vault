// Browser tests for the core UI. Every write is validated on disk: the file must
// decode, round-trip byte-exact, have matching manifest sizes, and contain the change.

import { test, expect } from '@playwright/test';
import {
  resetFixtures, readSave, verifyFile, exosuitSlots, home, openSave, cell, reviewAndWrite,
  confirmDialog, writeFixtureSave, saveTree, fileExists, accountDir,
} from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';

test.beforeEach(() => resetFixtures());

const openMenu = (page, file) => page.locator(`[data-action="save-menu"][data-file="${file}"]`).first().click();

test.describe('home screen', () => {
  test('shows the test banner and one save per slot, like the game', async ({ page }) => {
    await home(page);
    await expect(page.locator('#test-banner')).toBeVisible();
    const groups = page.locator('.slot-group');
    await expect(groups).toHaveCount(2);
    // Slot 1 holds two saves; only the newer one is listed.
    await expect(groups.nth(0).locator('.slot-row')).toHaveCount(1);
    await expect(groups.nth(0).locator('.slot-row')).toContainText('Aboard the Space Anomaly');
    await expect(page.getByText('On a planet')).toHaveCount(0);
  });

  test('Verify proves a save round-trips without writing', async ({ page }) => {
    await home(page);
    await openMenu(page, 'save.hg');
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
    await page.locator('.group-title', { hasText: 'Storage' }).locator('.pill').click();
    await expect(page.locator('.content h2').first()).toHaveText('Storage');
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
    await openMenu(page, 'save.hg');
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
    await openMenu(page, 'save3.hg');
    await page.locator('[data-action="slot-op"][data-op="delete"]').click();
    expect(await confirmDialog(page)).toContain('Steam Cloud');
    await expect(page.locator('.slot-group')).toHaveCount(1);
    expect(fileExists('save3.hg')).toBe(false);
    expect(fileExists('mf_save3.hg')).toBe(false);
  });

  test('export downloads the save as readable JSON', async ({ page }) => {
    await home(page);
    await openMenu(page, 'save.hg');
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-action="export-json"]').click()]);
    const json = JSON.parse(await (await import('node:fs')).promises.readFile(await download.path(), 'utf8'));
    expect(json.CommonStateData.SaveUniversalId).toBe(readSave('save.hg').CommonStateData.SaveUniversalId);
    expect(json.BaseContext.PlayerStateData.Inventory.Slots[0].Id).toBe('^FUEL1');
  });

  test('backups list every write and restore puts a save back', async ({ page }) => {
    await home(page);
    await openMenu(page, 'save3.hg');
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

test.describe('backups page', () => {
  test('shows where backups live and deletes them', async ({ page }) => {
    for (const n of [1, 2]) {
      await openSave(page, 'save.hg');
      await cell(page, 0, 0, 0).click();
      await page.locator('.amount-form input').fill(String(n + 1));
      await page.locator('.amount-form button').click();
      await reviewAndWrite(page);
      await page.locator('[data-action="home"]').click();
    }
    await page.locator('[data-action="backups"]').first().click();
    await expect(page.locator('.backup-where')).toContainText('backups');
    const rows = page.locator('.backup-list li');
    await expect(rows.nth(1)).toBeVisible(); // earlier tests may have left more
    const before = await rows.count();
    await rows.first().locator('[data-action="backup-delete"]').click();
    expect(await confirmDialog(page)).toContain('can’t be restored');
    await expect(rows).toHaveCount(before - 1);
    const trim = page.locator('[data-action="backup-trim"]');
    if (await trim.isEnabled()) {
      await trim.click();
      expect(await confirmDialog(page)).toContain('newest backup of each save will be kept');
      await expect(trim).toBeDisabled();
    }
    const names = await rows.locator('b').allTextContents();
    expect(new Set(names).size).toBe(names.length); // at most one left per save
    expect(verifyFile('save.hg').ok).toBe(true);
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

test.describe('rewards button', () => {
  const OTHER = 'st_76561190000000002';
  const addPlatform = () => fs.cpSync(accountDir, path.join(accountDir, '..', OTHER), { recursive: true });
  const rewards = (page) => page.locator('#global-tools');

  test('one platform opens directly, and a save with changes asks first', async ({ page }) => {
    await openSave(page, 'save.hg');
    await cell(page, 0, 0, 0).click();
    await page.locator('[data-action="remove"]').click();
    await rewards(page).getByRole('button', { name: /^Rewards for / }).click();
    await page.locator('#confirm-root [data-confirm="cancel"]').click();
    await expect(page.locator('.inv').first()).toBeVisible(); // still in the save
    await rewards(page).getByRole('button', { name: /^Rewards for / }).click();
    await confirmDialog(page);
    await expect(page.getByRole('heading', { name: 'Account rewards' })).toBeVisible();
  });

  test('several platforms: the save page offers a choice, an open save uses its own', async ({ page }) => {
    addPlatform();
    await home(page);
    await rewards(page).locator('[data-action="rewards-menu"]').click();
    await expect(rewards(page).locator('.menu-item')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(rewards(page).locator('.menu-item')).toHaveCount(0);

    await page.locator(`[data-action="open"][data-account="${OTHER}"][data-file="save.hg"]`).click();
    const button = rewards(page).getByRole('button', { name: new RegExp(`^Rewards for .*${OTHER}`) });
    await expect(button).toBeVisible();
    await button.click();
    await expect(page.locator('#save-info')).toContainText(OTHER);
    await expect(page.getByRole('heading', { name: 'Account rewards' })).toBeVisible();
  });
});

test.describe('save menu', () => {
  test('Open has a menu that closes on Escape or an outside click', async ({ page }) => {
    await home(page);
    await expect(page.locator('.save-menu')).toHaveCount(0);
    await openMenu(page, 'save.hg');
    await expect(page.locator('.save-menu .menu-item')).toHaveText(['Export as JSON', 'Copy…', 'Verify', 'Delete']);
    await page.keyboard.press('Escape');
    await expect(page.locator('.save-menu')).toHaveCount(0);
    await openMenu(page, 'save.hg');
    await page.locator('.home h1').click();
    await expect(page.locator('.save-menu')).toHaveCount(0);
  });
});

test.describe('animation', () => {
  test('page, details and edit animations run once, only for their own change', async ({ page }) => {
    await openSave(page, 'save.hg');
    await expect(page.locator('.page-in')).toHaveCount(1);
    await cell(page, 0, 0, 0).click();
    await expect(page.locator('.page-in')).toHaveCount(0); // selecting isn't navigating
    await expect(page.locator('.details-body.swapped')).toHaveCount(1);
    await page.locator('.amount-form input').fill('5');
    await page.locator('.amount-form button').click();
    await expect(cell(page, 0, 0, 0)).toHaveClass(/landed/);
    await expect(page.locator('.badge.pop')).toHaveCount(1);
    await expect(page.locator('.btn.primary.arrive')).toHaveCount(1);
    await expect(page.locator('.details-body.swapped')).toHaveCount(0);
    await cell(page, 1, 0, 0).click();
    await expect(page.locator('.cell.landed')).toHaveCount(0); // not replayed by a redraw
    await expect(page.locator('.badge.pop')).toHaveCount(0);
  });

  test('the info pane slides both ways at its full width', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openSave(page, 'save.hg');
    const sample = (name) => page.evaluate(async (label) => {
      document.querySelector(`[aria-label="${label}"]`).click();
      await new Promise((r) => setTimeout(r, 40));
      const pane = document.querySelector('#details');
      return { anims: pane.getAnimations().map((a) => a.animationName), width: pane.getBoundingClientRect().width };
    }, name);
    expect(await sample('Collapse details')).toEqual({ anims: ['pane-out'], width: 300 });
    await expect(page.locator('#details')).toHaveClass(/collapsed/);
    expect(await sample('Show details')).toEqual({ anims: ['pane-in'], width: 300 });
    await page.locator('#details').evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    await page.setViewportSize({ width: 900, height: 800 });
    await expect(page.locator('#details')).toHaveClass(/collapsed/);
    expect((await sample('Show details')).anims).toEqual(['drawer-in']);
    await page.locator('#details').evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    expect((await sample('Collapse details')).anims).toEqual(['drawer-out']);
    await expect(page.locator('#details')).toHaveClass(/collapsed/);
  });

  test('reduced motion is honoured', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openSave(page, 'save.hg');
    const seconds = await page.locator('.page-in').evaluate((el) => parseFloat(getComputedStyle(el).animationDuration));
    expect(seconds).toBeLessThan(0.01);
  });
});

test.describe('clicking an item', () => {
  const amount = (page) => page.locator('.amount-form input');

  test('opens a collapsed pane with the amount focused and selected, and typing replaces it', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openSave(page, 'save.hg');
    await page.getByRole('button', { name: 'Collapse details' }).click();
    await expect(page.locator('#details')).toHaveClass(/collapsed/);
    await cell(page, 0, 0, 0).click();
    await expect(page.locator('#details')).toHaveClass(/open/);
    await expect(amount(page)).toBeFocused();
    await page.keyboard.type('7');
    await page.keyboard.press('Enter');
    await expect(page.locator('.badge')).toHaveText('1');
    expect(await page.evaluate(() => document.querySelector('.cell[data-x="0"][data-y="0"] .amt').textContent)).toMatch(/^7\//);
  });

  test('opens the drawer over the content at small widths', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await openSave(page, 'save.hg');
    await expect(page.locator('#details')).toHaveClass(/collapsed/);
    await cell(page, 0, 0, 0).click();
    await expect(page.locator('#details.overlay.open')).toBeVisible();
    await expect(amount(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#details')).toHaveClass(/collapsed/);
  });

  test('keeps a clicked slot on screen when the grid has scrolled', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 420 });
    await openSave(page, 'save.hg');
    await page.locator('.content').evaluate((el) => { el.scrollTop = 120; });
    const before = await page.locator('.content').evaluate((el) => el.scrollTop);
    await cell(page, 0, 1, 0).click({ force: true });
    await expect(amount(page)).toBeFocused();
    expect(await page.locator('.content').evaluate((el) => el.scrollTop)).toBe(before);
    // Moving to another page starts at its top.
    await page.locator('[data-select="items"]').click();
    expect(await page.locator('.content').evaluate((el) => el.scrollTop)).toBe(0);
  });

  test('shortcuts still work until you start editing, and then keys edit the number', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openSave(page, 'save.hg');
    await cell(page, 0, 0, 0).click();
    await page.keyboard.press('f'); // fill
    await expect(page.locator('.badge')).toHaveText('1');
    await cell(page, 0, 0, 0).click();
    await amount(page).click(); // into the number: now it's plain editing
    await page.keyboard.press('Backspace');
    await expect(cell(page, 0, 0, 0).locator('.tile')).toBeVisible();
    await expect(page.locator('.badge')).toHaveText('1');
  });

  test('an empty cell and technology have no amount to focus', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openSave(page, 'save.hg');
    await cell(page, 0, 5, 3).click();
    await expect(page.locator('[data-action="add-item"]')).toBeVisible();
    await cell(page, 1, 0, 0).click();
    await expect(amount(page)).toHaveCount(0);
  });
});

test.describe('inventory toolbar', () => {
  // One atomic read of the live page: a resize can redraw it at any moment.
  const measure = (page) => page.evaluate(() => {
    const sec = document.querySelector('.inv');
    const h3 = sec.querySelector('h3').getBoundingClientRect();
    const tools = sec.querySelector('.inv-tools').getBoundingClientRect();
    const first = sec.querySelector('.inv-tools > *').getBoundingClientRect();
    return { h3Left: h3.left, toolsRight: tools.right, h3Right: h3.right, firstLeft: first.left, toolsTop: tools.top, labelTop: sec.querySelector('h3').firstChild.parentElement.getBoundingClientRect().top, sortText: getComputedStyle(sec.querySelector('[data-action="sort"] .tool-text')).display };
  });

  test('condenses to glyphs, then moves under the heading, as room runs out', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await openSave(page, 'save.hg');
    expect((await measure(page)).sortText).not.toBe('none');

    // Resizing can redraw the page, so wait for the new layout before measuring.
    await page.setViewportSize({ width: 1350, height: 900 });
    await expect.poll(async () => (await measure(page)).sortText).toBe('none');
    let m = await measure(page);
    expect(m.firstLeft).toBeGreaterThan(m.h3Left + 100); // still beside the heading

    await page.setViewportSize({ width: 600, height: 900 });
    await expect.poll(async () => { const now = await measure(page); return Math.abs(now.firstLeft - now.h3Left) < 1; }).toBe(true); // lined up with the heading
    m = await measure(page);
    expect(m.sortText).toBe('none');
    await expect(page.getByRole('button', { name: /^Sort / }).first()).toBeVisible(); // still named
  });
});

test.describe('glow', () => {
  test('Save only glows once there is something to save', async ({ page }) => {
    await openSave(page, 'save.hg');
    const save = page.locator('.topbar [data-action="review"]');
    await expect(save).toHaveCSS('box-shadow', 'none');
    await cell(page, 0, 0, 0).click();
    await page.locator('[data-action="remove"]').click();
    await expect(save).not.toHaveCSS('box-shadow', 'none');
  });
});

test.describe('details pane', () => {
  test('collapses to a tab on wide screens and stays collapsed after reload', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openSave(page, 'save.hg');
    const pane = page.locator('#details');
    await expect(pane).toHaveClass(/open/);
    await page.getByRole('button', { name: 'Collapse details' }).click();
    await expect(pane).toHaveClass(/collapsed/);
    await page.reload();
    await openSave(page, 'save.hg');
    await expect(page.locator('#details')).toHaveClass(/collapsed/);
    await page.getByRole('button', { name: 'Show details' }).click();
    await expect(page.locator('#details')).toHaveClass(/open/);
  });

  test('starts collapsed at small widths and opens over the content', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await openSave(page, 'save.hg');
    const pane = page.locator('#details');
    await expect(pane).toHaveClass(/collapsed/);
    await page.getByRole('button', { name: 'Show details' }).click();
    await expect(pane).toHaveClass(/open/);
    await expect(pane).toHaveCSS('position', 'absolute');
    await expect(pane).toHaveCSS('bottom', '0px');
    await page.keyboard.press('Escape');
    await expect(pane).toHaveClass(/collapsed/);
    await page.getByRole('button', { name: 'Show details' }).click();
    await page.locator('.details-backdrop').click({ position: { x: 20, y: 300 } });
    await expect(pane).toHaveClass(/collapsed/);
  });
});
