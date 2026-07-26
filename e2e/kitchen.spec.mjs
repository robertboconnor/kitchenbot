// Kitchen-tab interactions: the parts of the UI that write to the database and the cookbook
// search whose ranking logic moved into public/modules/cookbook-display.js during the Phase 5
// extraction. These are exactly the flows the structural net cannot see.
import { expect, test } from '@playwright/test';
import { collectConsoleErrors, login } from './helpers.mjs';

test('adding a grocery item persists it across a reload', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await login(page);
  await page.click('#tab-groceries');
  // The add form lives inside the list sub-view; Kitchen may open on a different one.
  await page.click('#grocery-subtab-list');

  const item = `sumac ${Date.now()}`;
  await page.fill('#grocery-add-name', item);
  await page.click('#grocery-add-submit');

  const list = page.locator('#grocery-sections');
  await expect(list).toContainText(item, { timeout: 10000 });

  // A render-only bug would pass the assertion above; a reload proves it actually saved.
  await page.reload();
  await page.click('#tab-groceries');
  await page.click('#grocery-subtab-list');
  await expect(page.locator('#grocery-sections')).toContainText(item, { timeout: 10000 });

  expect(errors()).toEqual([]);
});

test('checking a grocery item survives a reload', async ({ page }) => {
  await login(page);
  await page.click('#tab-groceries');
  // The add form lives inside the list sub-view; Kitchen may open on a different one.
  await page.click('#grocery-subtab-list');

  const item = `aleppo ${Date.now()}`;
  await page.fill('#grocery-add-name', item);
  await page.click('#grocery-add-submit');

  const row = page.locator('#grocery-sections li', { hasText: item });
  await expect(row).toBeVisible({ timeout: 10000 });
  const box = row.locator('input[type="checkbox"]').first();
  await box.check();

  await page.reload();
  await page.click('#tab-groceries');
  await page.click('#grocery-subtab-list');
  const rowAfter = page.locator('#grocery-sections li', { hasText: item });
  await expect(rowAfter.locator('input[type="checkbox"]').first()).toBeChecked({ timeout: 10000 });
});

test('the Kitchen tab switches between its sub-views', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await login(page);
  await page.click('#tab-groceries');

  // Each sub-view must actually swap the visible panel, not just restyle the button.
  await page.click('#grocery-subtab-thisweek');
  await expect(page.locator('#grocery-subview-thisweek')).toBeVisible();

  await page.click('#grocery-subtab-cookbook');
  await expect(page.locator('#grocery-subview-cookbook')).toBeVisible();
  await expect(page.locator('#grocery-subview-thisweek')).toBeHidden();

  expect(errors()).toEqual([]);
});

test('cookbook search filters the list (the ranking logic extracted into a module)', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await login(page);
  await page.click('#tab-groceries');
  await page.click('#grocery-subtab-cookbook');

  const search = page.locator('#cookbook-search-filter');
  await expect(search).toBeVisible({ timeout: 10000 });

  // A nonsense query must reduce the list to nothing without throwing — this exercises
  // scoreCookbookSearchMatch()'s -1 exclude path through the real UI.
  await search.fill('zzzzz-not-a-real-recipe');
  await expect(page.locator('#cookbook-list .cookbook-card')).toHaveCount(0, { timeout: 10000 });

  await search.fill('');
  expect(errors(), 'search must not throw — its helpers now come from an ES module').toEqual([]);
});
