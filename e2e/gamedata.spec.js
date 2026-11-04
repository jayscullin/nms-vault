// Browser tests that need the installed game's data (names, icons, adding items,
// knowledge, rewards). Run with E2E_GAMEDATA=1 on a machine with the game installed.

import { test, expect } from '@playwright/test';
import { USE_GAMEDATA } from './env.js';
import { resetFixtures, readSave, verifyFile, exosuitSlots, home, openSave, cell, reviewAndWrite, confirmDialog, writeFixtureSave, saveTree } from './helpers.js';

test.skip(!USE_GAMEDATA, 'needs the game installed (E2E_GAMEDATA=1)');
test.beforeEach(() => resetFixtures());

test('items show real names, and hovering shows the description', async ({ page }) => {
  await openSave(page, 'save.hg');
  const tile = cell(page, 0, 0, 0).locator('.tile');
  await expect(tile).toHaveAttribute('aria-label', /^Carbon /);
  await tile.hover();
  await expect(page.locator('#item-tip')).toContainText('Carbon');
  await expect(page.locator('#item-tip')).toHaveClass(/showing/);
  await page.locator('.content h2').first().hover();
  await expect(page.locator('#item-tip')).toBeHidden();
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
  await page.locator('[data-select="words"]').click();
  await expect(page.getByRole('heading', { name: 'Words' })).toBeVisible();
  await page.locator('[data-action="learn-words"][data-race="2"]').click();
  await expect(page.locator('.word-card').filter({ hasText: 'Korvax' })).toContainText('All known');
  await reviewAndWrite(page);
  expect(verifyFile('save.hg').ok).toBe(true);
  const groups = readSave('save.hg').BaseContext.PlayerStateData.KnownWordGroups;
  expect(groups.filter((g) => g.Group.startsWith('^EXP_') && g.Races[2]).length).toBeGreaterThan(100);
});

test('blueprints have their own page, and searching keeps focus in its search box', async ({ page }) => {
  await openSave(page, 'save.hg');
  await page.locator('[data-select="blueprints"]').click();
  await expect(page.getByRole('heading', { name: 'Blueprints' })).toBeVisible();
  await expect(page.locator('.word-card')).toHaveCount(0);
  const box = page.getByRole('searchbox', { name: 'Search blueprints' });
  await box.click();
  await page.keyboard.type('ab');
  await expect(box).toHaveValue('ab');
  await expect(box).toBeFocused();
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
  await expect(dialog.getByRole('heading', { name: 'All Items' })).toBeVisible();
  await page.locator('#cat-search').fill('pulse engine');
  await expect(dialog.locator('.cat-row').first()).toContainText('Pulse Engine');
  await expect(page.locator('#cat-search')).toBeFocused();
  await dialog.locator('[data-cat-type="Technology"]').click();
  await expect(dialog.locator('.cat-meta').first()).toContainText('Technology');
});

test('the catalogue shows what you own and adds what you don’t', async ({ page }) => {
  await openSave(page, 'save.hg');
  await page.locator('.topbar [data-action="catalogue"]').click();
  const dialog = page.locator('.modal.wide');
  // Owned: Ferrite Dust (^LAND1, 250 in the exosuit).
  await page.locator('#cat-search').fill('Ferrite Dust');
  const owned = dialog.locator('.cat-row').filter({ hasText: 'Ferrite Dust' }).first();
  await expect(owned.locator('.owned')).toHaveText('In 1 place · 250 total');
  // Not owned: Carbon Nanotubes gets a [+].
  await page.locator('#cat-search').fill('Carbon Nanotubes');
  const row = dialog.locator('.cat-row').filter({ hasText: 'Carbon Nanotubes' }).first();
  await expect(row).toContainText('Not in your inventories');
  await row.locator('[data-action="cat-add"]').click();
  await expect(dialog.getByRole('heading', { name: 'Add Carbon Nanotubes' })).toBeVisible();
  await expect(dialog.locator('.add-target input:checked')).toHaveCount(1);
  await page.locator('#cat-add-amount').fill('7');
  await dialog.locator('[data-action="cat-add-confirm"]').click();
  // Back in the catalogue, now owned.
  await page.locator('#cat-search').fill('Carbon Nanotubes');
  await expect(dialog.locator('.cat-row').filter({ hasText: 'Carbon Nanotubes' }).first().locator('.owned')).toContainText('7 total');
  await page.keyboard.press('Escape');
  await expect(page.locator('.badge')).toHaveText('1');
  await reviewAndWrite(page);
  expect(verifyFile('save.hg').ok).toBe(true);
  expect(exosuitSlots(readSave('save.hg')).find((s) => s.Id === '^NANOTUBES')).toMatchObject({ Amount: 7 });
  // "Show" jumps to the item and closes the catalogue.
  await page.locator('.topbar [data-action="catalogue"]').click();
  await page.locator('#cat-search').fill('Ferrite Dust');
  await dialog.locator('.cat-row').filter({ hasText: 'Ferrite Dust' }).first().locator('[data-jump]').click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(page.locator('.cell.selected .tile')).toHaveAttribute('aria-label', /Ferrite Dust/);
});

test('the catalogue modal opens over an open save and closing it keeps staged changes', async ({ page }) => {
  await openSave(page, 'save.hg');
  await cell(page, 0, 0, 0).locator('.tile').click();
  await page.keyboard.press('f');
  await expect(page.locator('.badge')).toHaveText('1');
  await page.locator('.topbar [data-action="catalogue"]').click();
  await expect(page.locator('.modal.wide').getByRole('heading', { name: 'All Items' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(page.locator('.content h2')).toContainText('Exosuit');
  await expect(page.locator('.badge')).toHaveText('1');
});

test('3D view: procedural ships are refused with a reason, fixed models load', async ({ page }) => {
  await openSave(page, 'save.hg');
  await page.locator('[data-select*="Starships"]').first().click();
  const button = page.getByRole('button', { name: /3D view unavailable: Procedurally generated/ }).first();
  await expect(button).toBeDisabled();
  const fixed = await page.request.get('/models/' + encodeURIComponent('MODELS/COMMON/SPACECRAFT/FIGHTERS/WRACER.SCENE.MBIN') + '.bin');
  expect(fixed.status()).toBe(200);
  const body = await fixed.body();
  const header = JSON.parse(body.toString('utf8', 4, 4 + body.readUInt32LE(0)));
  expect(header.meshes.length).toBeGreaterThan(10);
  const procedural = await page.request.get('/models/' + encodeURIComponent('MODELS/COMMON/SPACECRAFT/FIGHTERS/FIGHTER_PROC.SCENE.MBIN') + '.bin');
  expect(procedural.status()).toBe(422);
});

test('3D view: recorded parts build a customised ship; unrecorded decals are left out, unrecorded parts refused', async ({ page }) => {
  await page.goto('/');
  const get = (scene, parts) => page.request.get('/models/' + encodeURIComponent(scene) + '.bin?parts=' + parts.join(','));
  const hauler = await get('MODELS/COMMON/SPACECRAFT/DROPSHIPS/DROPSHIP_PROC.SCENE.MBIN', ['DROPS_COCKS13', 'DROPS_ENGIS13', 'DROPS_WINGS13']);
  expect(hauler.status()).toBe(200);
  const body = await hauler.body();
  const header = JSON.parse(body.toString('utf8', 4, 4 + body.readUInt32LE(0)));
  expect(header.omitted).toEqual(['decals']);
  const noWings = await get('MODELS/COMMON/SPACECRAFT/FIGHTERS/FIGHTER_PROC.SCENE.MBIN', ['FIGHT_COCKD', 'FIGHT_ENGIC']);
  expect(noWings.status()).toBe(422);
  expect(await noWings.text()).toMatch(/wings/);
});

test('change a ship type and delete a spare ship, then write', async ({ page }) => {
  const tree = saveTree();
  const ps = tree.BaseContext.PlayerStateData;
  const copy = () => JSON.parse(JSON.stringify(ps.ShipOwnership[0]));
  ps.ShipOwnership[0].Resource.Seed = [true, '0xAAAAAAAAAAAA'];
  const spare = copy();
  spare.Name = 'Spare';
  spare.Resource.Seed = [true, '0xBBBBBBBBBBBB'];
  const empty = copy();
  empty.Name = '';
  empty.Resource = { Filename: '', Seed: [false, '0x0'] };
  ps.ShipOwnership.push(spare, empty);
  writeFixtureSave('save.hg', tree);

  await openSave(page, 'save.hg');
  await page.locator('.nav-item', { hasText: 'Test Ship' }).click();
  // The ship in use can't be deleted, but can change type.
  await expect(page.locator('[data-action="delete-ship"]')).toBeDisabled();
  await page.locator('[data-action="change-type"]').click();
  await expect(page.locator('.type-preview canvas.ready')).toBeVisible(); // the current type, as an example
  await expect(page.locator('#type-caption')).toContainText('An example Fighter, not this exact ship');
  await page.locator('.modal input[name="kind"][value*="SHUTTLE_PROC"]').check();
  await expect(page.locator('#type-caption')).toContainText('An example Shuttle');
  await expect(page.locator('.type-preview canvas.ready')).toBeVisible();
  await page.locator('[data-action="type-confirm"]').click();
  await expect(page.locator('.content .sub')).toContainText('Shuttle');

  await page.locator('.nav-item', { hasText: 'Spare' }).click();
  await page.locator('[data-action="delete-ship"]').click();
  await confirmDialog(page);
  await expect(page.locator('.nav-item', { hasText: 'Spare' })).toHaveCount(0);

  await reviewAndWrite(page);
  expect(verifyFile('save.hg').ok).toBe(true);
  const after = readSave('save.hg').BaseContext.PlayerStateData.ShipOwnership;
  expect(after[0].Resource.Filename).toContain('SHUTTLE_PROC');
  expect(after[0].Resource.Seed[1]).toBe('0xAAAAAAAAAAAA');
  expect(after[1].Resource.Filename).toBe('');
  expect(after[1].Name).toBe('');
});

test('example models exist only for swappable types', async ({ page }) => {
  await home(page);
  const get = (scene) => page.request.get(`/models/${encodeURIComponent(scene)}.bin?example=1`);
  for (const type of ['FIGHTERS/FIGHTER_PROC', 'SENTINELSHIP/SENTINELSHIP_PROC', 'INDUSTRIAL/CAPITALFREIGHTER_PROC']) {
    expect((await get(`MODELS/COMMON/SPACECRAFT/${type}.SCENE.MBIN`)).status()).toBe(200);
  }
  expect((await get('MODELS/COMMON/WEAPONS/MULTITOOL/MULTITOOL.SCENE.MBIN')).status()).toBe(422);
  // The ordinary request still refuses to guess a procedural model.
  expect((await page.request.get(`/models/${encodeURIComponent('MODELS/COMMON/SPACECRAFT/FIGHTERS/FIGHTER_PROC.SCENE.MBIN')}.bin`)).status()).toBe(422);
});
