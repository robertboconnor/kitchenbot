// Runtime verification: a real browser, real CSS, real ES-module loading, real clicks.
// Mirrors the manual click-through checklist in docs/frontend-replumb-log.md so that pass
// becomes automatic.
import { expect, test } from '@playwright/test';
import { collectConsoleErrors, login, stubChatReply } from './helpers.mjs';

test('the app loads, styles apply, and the client module boots without console errors', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await login(page);

  // If the CSS lift or the module conversion had broken, one of these three fails immediately.
  await expect(page.locator('#app')).toBeVisible();
  const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(bodyFont.toLowerCase()).toContain('nunito');
  const accent = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--accent-strong').trim()
  );
  expect(accent).not.toBe('');

  expect(errors(), 'no console errors on load').toEqual([]);
});

test('the chat composer wires up: sending posts the typed prompt and renders the bubble', async ({ page }) => {
  // Deliberately does NOT assert on the assistant's reply text. Stubbing /chat means the server
  // never persists the exchange, so the client's follow-up history refresh legitimately clears
  // the transient bubbles — asserting on it would be testing the stub, not the app. What matters
  // here is the wiring: if app.js failed to load as a module, clicking send would do nothing.
  const errors = collectConsoleErrors(page);
  await login(page);
  await stubChatReply(page, 'Roast the squash at 425F.');

  const chatPost = page.waitForRequest(
    (req) => req.url().endsWith('/chat') && req.method() === 'POST'
  );
  await page.fill('#prompt', 'What temperature for the squash?');
  await page.click('#send');

  const request = await chatPost;
  expect(request.postDataJSON()?.prompt).toBe('What temperature for the squash?');
  // The composer clears on send, and the message renders optimistically.
  await expect(page.locator('#prompt')).toHaveValue('');
  await expect(page.locator('#chat')).toContainText('What temperature for the squash?');
  expect(errors()).toEqual([]);
});

test('the attach menu opens and offers Camera / Photos / File', async ({ page }) => {
  await login(page);
  await expect(page.locator('#attach-menu')).toBeHidden();

  await page.click('#attach-btn');
  await expect(page.locator('#attach-menu')).toBeVisible();
  for (const label of ['Camera', 'Photos', 'File']) {
    await expect(page.locator('#attach-menu')).toContainText(label);
  }
  // Each option must map to a real file input, since that is what fixes the Android picker.
  await expect(page.locator('#attach-input-photos')).toHaveAttribute('accept', 'image/*');
  await expect(page.locator('#attach-input-camera')).toHaveAttribute('capture', 'environment');

  // Clicking outside closes it.
  await page.click('#prompt');
  await expect(page.locator('#attach-menu')).toBeHidden();
});

test('switching palette in Settings repaints the app AND persists across a reload', async ({ page }) => {
  await login(page);
  const html = page.locator('html');
  const original = await html.getAttribute('data-palette');

  await page.click('#tab-settings');
  const target = original === 'cotton-candy' ? 'sweetwater' : 'cotton-candy';
  await page.selectOption('#my-palette-select', target);

  await expect(html).toHaveAttribute('data-palette', target, { timeout: 10000 });
  // Persistence covers both halves: the /me save AND the pre-paint localStorage cache.
  await page.reload();
  await expect(html).toHaveAttribute('data-palette', target);
});

test('the chosen palette also applies on the recipe importer page', async ({ page }) => {
  // REGRESSION GUARD. Rob spotted by eye on 2026-07-25 that /recipe-importer ignored his palette.
  // Root cause was self-inflicted earlier that night: the CSP pinned a hash of the inline
  // pre-paint script, and lifting the markup into views/ re-indented that script, so the browser
  // blocked it. The main app masked the bug (app.js re-applies the palette after /me loads); the
  // importer has no such fallback, so it stayed on the default. Fixed by deriving the CSP hash
  // from the template instead of hardcoding it — see app-shell.inlineScriptCspHashes().
  await login(page);
  await page.click('#tab-settings');
  await page.selectOption('#my-palette-select', 'cotton-candy');
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'cotton-candy');

  await page.goto('/recipe-importer');
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'cotton-candy');
});

test('the recipe importer page still renders (it is deliberately NOT an ES module)', async ({ page }) => {
  // Guards the opt-in decision in app-shell.renderClientBootTags: flipping this page to
  // type="module" would impose strict mode and remove its top-level names from global scope.
  const errors = collectConsoleErrors(page);
  await login(page);
  await page.goto('/recipe-importer');

  await expect(page.locator('body')).toContainText('Back to KitchenBot');
  const tag = await page.evaluate(() => {
    const el = [...document.querySelectorAll('script[src]')].find((s) => s.src.includes('recipe-importer.js'));
    return el ? el.getAttribute('type') : 'MISSING';
  });
  expect(tag, 'importer runtime must stay a classic script').toBeNull();
  expect(errors()).toEqual([]);
});
