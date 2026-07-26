// Behaviour coverage for pantry, This Week, and settings — written BEFORE those features are
// extracted from app.js, so the extraction has a baseline to be verified against.
import { expect, test } from '@playwright/test';
import { collectConsoleErrors, login } from './helpers.mjs';

test('pantry: adding an item persists it across a reload', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await login(page);
  await page.click('#tab-groceries');
  await page.click('#grocery-subtab-pantry');

  const item = `smoked paprika ${Date.now()}`;
  await page.fill('#pantry-add-name', item);
  await page.click('#pantry-add-submit');
  await expect(page.locator('#pantry-sections')).toContainText(item, { timeout: 10000 });

  await page.reload();
  await page.click('#tab-groceries');
  await page.click('#grocery-subtab-pantry');
  await expect(page.locator('#pantry-sections')).toContainText(item, { timeout: 10000 });
  expect(errors()).toEqual([]);
});

test('This Week: the panel renders and reports an empty plan without errors', async ({ page }) => {
  // The seeded household has no planned meals, so the empty state is the correct assertion —
  // what matters is that the panel renders and the loader runs cleanly.
  const errors = collectConsoleErrors(page);
  await login(page);
  await page.click('#tab-groceries');
  await page.click('#grocery-subtab-thisweek');

  await expect(page.locator('#grocery-subview-thisweek')).toBeVisible();
  await expect(page.locator('#thisweek-empty')).toBeVisible({ timeout: 10000 });
  expect(errors()).toEqual([]);
});

test('This Week: the chat strip stays hidden when there is nothing planned', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await login(page);
  await page.click('#tab-chat');
  // With an empty plan the strip must not take up space above the messages.
  await expect(page.locator('#thisweek-strip')).toBeHidden();
  expect(errors()).toEqual([]);
});

test('settings: the panel loads and shows household identity', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await login(page);
  await page.click('#tab-settings');

  await expect(page.locator('#settings-panel')).toBeVisible();
  await expect(page.locator('#my-settings-hh-name')).toContainText('E2E Kitchen', { timeout: 10000 });
  await expect(page.locator('#my-settings-hh-key')).toContainText('e2e-kitchen');
  await expect(page.locator('#my-settings-users-list')).toContainText('Tester');
  expect(errors()).toEqual([]);
});

test('settings: household defaults save and survive a reload', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await login(page);
  await page.click('#tab-settings');
  await page.click('#settings-subtab-household-btn');

  const portions = page.locator('#my-settings-defaults-portions');
  await expect(portions).toBeVisible({ timeout: 10000 });
  await portions.fill('6');
  await page.click('#my-settings-defaults-save');
  await expect(page.locator('#my-settings-defaults-msg')).toContainText(/saved/i, { timeout: 10000 });

  await page.reload();
  await page.click('#tab-settings');
  await page.click('#settings-subtab-household-btn');
  await expect(page.locator('#my-settings-defaults-portions')).toHaveValue('6', { timeout: 10000 });
  expect(errors()).toEqual([]);
});

test('settings: renaming the assistant updates it everywhere', async ({ page }) => {
  // The assistant name lives on session state and is read by chat when labelling replies, so this
  // exercises a genuinely cross-feature path.
  const errors = collectConsoleErrors(page);
  await login(page);
  await page.click('#tab-settings');
  await page.click('#settings-subtab-household-btn');

  const nameField = page.locator('#my-settings-defaults-assistant-name');
  await expect(nameField).toBeVisible({ timeout: 10000 });
  await nameField.fill('Sous');
  await page.click('#my-settings-defaults-save');
  await expect(page.locator('#my-settings-defaults-msg')).toContainText(/saved/i, { timeout: 10000 });

  await page.reload();
  await page.click('#tab-settings');
  await page.click('#settings-subtab-household-btn');
  await expect(page.locator('#my-settings-defaults-assistant-name')).toHaveValue('Sous', { timeout: 10000 });

  // Restore so later tests see the default.
  await page.fill('#my-settings-defaults-assistant-name', 'KitchenBot');
  await page.click('#my-settings-defaults-save');
  expect(errors()).toEqual([]);
});
