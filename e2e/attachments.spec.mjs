// Photos attached to a chat message must survive the history redraw.
//
// Rob's report: the photo appears for a moment, inline in the message he sent, then disappears.
// That is the optimistic bubble (which passes its attachments) being replaced by loadHistory()
// (which did not) — so this asserts on the PERSISTED path, which is where the bug lives.
import { expect, test } from '@playwright/test';
import { collectConsoleErrors, login } from './helpers.mjs';
import { E2E_PHOTO_CHAT } from '../playwright.config.mjs';

async function openPhotoThread(page) {
  await page.click('#menu-button');
  await page.click(`#chat-list .chat-list-item:has-text("${E2E_PHOTO_CHAT.title}")`);
}

test('a photo in a saved message renders when the chat is opened', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await login(page);
  await openPhotoThread(page);

  const bubble = page.locator('.message.user', { hasText: E2E_PHOTO_CHAT.caption });
  await expect(bubble).toBeVisible({ timeout: 10000 });
  // Inline in the message it was sent with — not a separate card elsewhere in the thread.
  const photo = bubble.locator('img');
  await expect(photo).toBeVisible({ timeout: 10000 });
  await expect(photo).toHaveAttribute('src', /\/attachment\/\d+/);
  expect(errors()).toEqual([]);
});

test('the photo is still there after a reload', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await login(page);
  await openPhotoThread(page);
  await expect(page.locator('.message.user img')).toBeVisible({ timeout: 10000 });

  await page.reload();
  await openPhotoThread(page);
  await expect(page.locator('.message.user img')).toBeVisible({ timeout: 10000 });
  expect(errors()).toEqual([]);
});

test('the attachment bytes actually serve (the image is not a broken icon)', async ({ page }) => {
  // toBeVisible() passes for a broken <img>, so check the image really decoded.
  await login(page);
  await openPhotoThread(page);
  const photo = page.locator('.message.user img').first();
  await expect(photo).toBeVisible({ timeout: 10000 });
  const decoded = await photo.evaluate((img) => img.complete && img.naturalWidth > 0);
  expect(decoded).toBe(true);
});
