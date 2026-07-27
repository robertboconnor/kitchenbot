// Leaving the app for the standalone Recipe Importer and coming back is a FULL page navigation, and
// the importer's "Back to KitchenBot" link points at /#cookbook. That hash used to stick around
// forever, and reapplyVisibleAppTab() reads it as "you are on the cookbook" on every pageshow —
// which Android fires each time you return to the app. So chat would work, and then minutes later
// silently flip to the Kitchen and take the composer with it.
import { expect, test } from '@playwright/test';
import { collectConsoleErrors, login } from './helpers.mjs';

/** Android fires a pageshow whenever you come back to the app; this is that, without a device. */
async function reshowPage(page) {
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await page.waitForTimeout(200);
}

test('the composer survives coming back from the importer and the page being re-shown', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await login(page);
  await page.goto('/recipe-importer');
  await page.click('text=Back to KitchenBot');
  await page.waitForTimeout(1000);

  await page.click('#tab-chat');
  await expect(page.locator('#input-area')).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe('');

  await reshowPage(page);
  await expect(page.locator('#input-area')).toBeVisible();
  await expect(page.locator('#chat')).toBeVisible();
  expect(errors()).toEqual([]);
});

test('browser Back from the importer, then Chat, still leaves the composer alone', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await login(page);
  await page.click('#tab-groceries');
  await page.click('#grocery-subtab-cookbook');
  await page.click('a.cookbook-hero-link');
  await expect(page.locator('#importer-status')).toBeVisible();

  await page.goBack();
  await page.waitForTimeout(1000);
  await page.click('#tab-chat');
  await reshowPage(page);
  await expect(page.locator('#input-area')).toBeVisible();
  expect(errors()).toEqual([]);
});

test('a #cookbook deep link still opens the cookbook (the hash is cleared only on leaving)', async ({ page }) => {
  // The fix must not break the reason the hash exists: arriving at /#cookbook still lands there.
  const errors = collectConsoleErrors(page);
  await login(page);
  await page.goto('/#cookbook');
  await expect(page.locator('#grocery-subview-cookbook')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#cookbook-list .cookbook-card').first()).toBeVisible({ timeout: 10000 });

  // And it survives a re-show while you are still on it.
  await reshowPage(page);
  await expect(page.locator('#grocery-subview-cookbook')).toBeVisible();
  expect(errors()).toEqual([]);
});

test('a #cookbook/<id> recipe deep link still opens that recipe', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await login(page);
  await page.click('#tab-groceries');
  await page.click('#grocery-subtab-cookbook');
  await page.locator('.cookbook-card', { hasText: 'Garlic Toum' })
    .getByRole('button', { name: 'Open' })
    .click();
  await expect(page.locator('#cookbook-detail-title')).toHaveValue('Garlic Toum', { timeout: 10000 });
  expect(await page.evaluate(() => location.hash)).toMatch(/^#cookbook\/\d+$/);

  // The deep link must survive a re-show while you are still looking at the recipe...
  await reshowPage(page);
  await expect(page.locator('#cookbook-detail-title')).toHaveValue('Garlic Toum');

  // ...and a full reload.
  await page.reload();
  await expect(page.locator('#cookbook-detail-title')).toHaveValue('Garlic Toum', { timeout: 15000 });

  // But leaving for chat clears it, so a later re-show cannot drag you back.
  await page.click('#tab-chat');
  expect(await page.evaluate(() => location.hash)).toBe('');
  await reshowPage(page);
  await expect(page.locator('#input-area')).toBeVisible();
  expect(errors()).toEqual([]);
});
