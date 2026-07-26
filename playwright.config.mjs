// Playwright drives a REAL browser against a REAL server, which is the one thing the node:test
// suite cannot do: it verifies that clicking things actually works. That gap is why the Phase 5
// app.js feature-split was deferred — structure was verifiable, runtime interaction was not.
//
// The database and login here are entirely disposable: a temp DB seeded with a throwaway
// household and a test PIN. No real credential is ever involved.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = 3317;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Seeded at config-load time, which happens before both globalSetup and the webServer — so there
// is no race over whether the database exists when the server boots.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-'));
const DB_PATH = path.join(TMP_DIR, 'e2e.db');

export const E2E = {
  baseURL: BASE_URL,
  householdKey: 'e2e-kitchen',
  displayName: 'Tester',
  pin: '4321',
};

process.env.DB_PATH = DB_PATH;
process.env.KB_TEST_GUARD = '1';
const db = await import('./db.mjs');
await db.runMigrations();
const seeded = await db.createHouseholdWithInitialOwner({
  householdName: 'E2E Kitchen',
  householdKey: E2E.householdKey,
  ownerDisplayName: E2E.displayName,
  pin: E2E.pin,
});

// Seed cookbook entries so cookbook tests assert on real rendering, filtering and ranking rather
// than on an empty list (which passes trivially and proves nothing).
const { buildCookbookRecordForStorage } = await import('./cookbook-store.mjs');
export const E2E_RECIPES = [
  {
    title: 'Garlic Toum',
    summary: 'A fluffy Lebanese garlic sauce.',
    category: 'sauces',
    tags: ['quick', 'vegetarian'],
    ingredients: ['4 cloves garlic', '1 cup neutral oil', '1 tbsp lemon juice'],
    instructions: ['Blitz the garlic with salt.', 'Stream in the oil until it emulsifies.'],
  },
  {
    title: 'Seared Cod with Corn Succotash',
    summary: 'A late-summer one-pan seafood supper.',
    category: 'fish',
    tags: ['weeknight'],
    ingredients: ['1.5 lb cod', '2 ears corn', '4 oz bacon'],
    instructions: ['Render the bacon until crisp.', 'Sear the cod skin-side down and plate.'],
  },
  {
    title: 'Weeknight Tomato Pasta',
    summary: 'A quick pantry pasta.',
    category: 'pasta',
    tags: ['weeknight', 'kid-approved'],
    ingredients: ['1 lb pasta', '1 can crushed tomatoes', '3 cloves garlic'],
    instructions: ['Boil the pasta.', 'Simmer the tomatoes with garlic and toss.'],
  },
];
for (const recipe of E2E_RECIPES) {
  await db.saveCookbookEntry(seeded.householdId, buildCookbookRecordForStorage(recipe), {
    sourceKind: 'manual',
  });
}

export default defineConfig({
  testDir: './e2e',
  // Serial: every test shares one server and one database, so parallel writes would make
  // grocery/plan assertions flaky for reasons that have nothing to do with the app.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    // Artifacts only for failures — this is how a headless run explains itself.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node kitchenbot.mjs',
    url: BASE_URL,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30000,
    env: {
      PORT: String(PORT),
      DB_PATH,
      KITCHENBOT_SECRET: 'e2e-secret-not-a-real-key',
      // Hermetic: no redis, no env-seeded household, no live Anthropic calls. Tests that need a
      // chat reply stub the /chat response in the browser instead of spending money.
      REDIS_URL: '',
      INITIAL_HOUSEHOLD_KEY: '',
      INITIAL_OWNER_PIN: '',
      ANTHROPIC_API_KEY: '',
    },
  },
});
