import { expect } from '@playwright/test';
import { E2E } from '../playwright.config.mjs';

/**
 * Log into the disposable E2E household. The key/PIN are fixtures created by playwright.config.mjs
 * for a throwaway database — never a real credential.
 *
 * The form is a 4-step flow: type the household key, resolve it, pick the user, enter the PIN.
 */
export async function login(page) {
  await page.goto('/');
  await page.fill('#login-household-key', E2E.householdKey);
  await page.click('#login-find-household');

  // Resolving the household enables the user picker.
  const namePicker = page.locator('#login-name');
  await expect(namePicker).toBeEnabled({ timeout: 10000 });
  await namePicker.selectOption({ label: E2E.displayName });

  await page.fill('#login-password', E2E.pin);
  await page.click('#login-button');

  // The app shell replaces the login pane once authenticated.
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
}

/**
 * Collect console errors for the life of a page. The single most valuable browser-only signal:
 * a module that fails to load, or a handler that throws on click, shows up here and nowhere else.
 *
 * Returns a getter so tests can assert at the end rather than racing the page.
 */
export function collectConsoleErrors(page) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`uncaught: ${err.message}`));
  return () =>
    errors.filter(
      (text) =>
        // Ignore network noise unrelated to app correctness (e.g. an absent favicon variant)
        // and the expected pre-login /me probe: the shell always asks who you are, and a 401
        // before you have signed in is the app working correctly, not an error.
        !/favicon/i.test(text) &&
        !/net::ERR_/.test(text) &&
        !/401/.test(text)
    );
}

/**
 * Stub the brain so chat tests exercise the UI without spending Anthropic tokens.
 *
 * On a 2xx the client reads the raw response body as a text stream and treats it as the reply
 * verbatim, UNLESS the NDJSON stream header is set — so a plain-text body is the correct stub.
 */
export async function stubChatReply(page, replyText = 'Stubbed reply from the test harness.') {
  await page.route('**/chat', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: replyText });
  });
}
