// Cookbook behaviour, written BEFORE the feature is extracted from app.js so the extraction has
// something to be verified against. Runs on the three recipes seeded in playwright.config.mjs.
import { expect, test } from '@playwright/test';
import { collectConsoleErrors, login } from './helpers.mjs';

async function openCookbook(page) {
  await login(page);
  await page.click('#tab-groceries');
  await page.click('#grocery-subtab-cookbook');
  await expect(page.locator('#cookbook-list .cookbook-card').first()).toBeVisible({ timeout: 10000 });
}

test('the cookbook lists saved recipes with their titles, categories and tags', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openCookbook(page);

  const list = page.locator('#cookbook-list');
  await expect(list.locator('.cookbook-card')).toHaveCount(3);
  await expect(list).toContainText('Garlic Toum');
  await expect(list).toContainText('Seared Cod with Corn Succotash');
  await expect(list).toContainText('Weeknight Tomato Pasta');
  // Category label and tag chips are rendered by the display helpers.
  await expect(list).toContainText('Pasta');
  await expect(list.locator('.cookbook-tag-chip').first()).toBeVisible();

  expect(errors()).toEqual([]);
});

test('opening a recipe shows its full ingredients and steps', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openCookbook(page);

  await page.locator('.cookbook-card', { hasText: 'Garlic Toum' })
    .getByRole('button', { name: 'Open' })
    .click();

  // The detail view is an editable form: title is an <input>, the bodies are <textarea>s, so
  // their content lives in .value rather than in a text node.
  await expect(page.locator('#cookbook-detail-view')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#cookbook-detail-title')).toHaveValue('Garlic Toum', { timeout: 10000 });
  await expect(page.locator('#cookbook-detail-ingredients')).toHaveValue(/neutral oil/);
  await expect(page.locator('#cookbook-detail-instructions')).toHaveValue(/emulsifies/);

  expect(errors()).toEqual([]);
});

test('the detail view deep-links via #cookbook and survives a reload', async ({ page }) => {
  // Guards navigation.isCookbookHash() + the boot path that restores the cookbook from the URL.
  await openCookbook(page);
  await page.locator('.cookbook-card', { hasText: 'Weeknight Tomato Pasta' })
    .getByRole('button', { name: 'Open' })
    .click();
  await expect(page.locator('#cookbook-detail-title')).toHaveValue('Weeknight Tomato Pasta', {
    timeout: 10000,
  });

  expect(page.url()).toMatch(/#cookbook\/\d+/);
  await page.reload();
  await expect(page.locator('#cookbook-detail-title')).toHaveValue('Weeknight Tomato Pasta', {
    timeout: 15000,
  });
});

test('going back from a recipe returns to the list', async ({ page }) => {
  await openCookbook(page);
  await page.locator('.cookbook-card', { hasText: 'Garlic Toum' })
    .getByRole('button', { name: 'Open' })
    .click();
  await expect(page.locator('#cookbook-detail-view')).toBeVisible();

  await page.click('#cookbook-detail-back');
  await expect(page.locator('#cookbook-list .cookbook-card')).toHaveCount(3);
});

test('the category filter narrows the list, and clearing it restores every recipe', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openCookbook(page);

  await page.selectOption('#cookbook-category-filter', 'fish');
  await expect(page.locator('#cookbook-list .cookbook-card')).toHaveCount(1);
  await expect(page.locator('#cookbook-list')).toContainText('Seared Cod');

  await page.selectOption('#cookbook-category-filter', '');
  await expect(page.locator('#cookbook-list .cookbook-card')).toHaveCount(3);
  expect(errors()).toEqual([]);
});

test('search matches on title and on ingredients, and ranks the title hit first', async ({ page }) => {
  // Exercises scoreCookbookSearchMatch() through the real UI: "garlic" is in the Toum's TITLE and
  // in the pasta's INGREDIENTS, so both match — but the title hit must sort first.
  const errors = collectConsoleErrors(page);
  await openCookbook(page);

  const search = page.locator('#cookbook-search-filter');
  await search.fill('garlic');
  const cards = page.locator('#cookbook-list .cookbook-card');
  await expect(cards).toHaveCount(2, { timeout: 10000 });
  await expect(cards.first()).toContainText('Garlic Toum');

  // A term that appears in no recipe empties the list (the -1 exclude path).
  await search.fill('zzzzz-not-a-real-recipe');
  await expect(cards).toHaveCount(0);

  await search.fill('');
  await expect(cards).toHaveCount(3);
  expect(errors()).toEqual([]);
});
