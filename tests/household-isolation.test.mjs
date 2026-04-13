import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { withTempDb } from '../test-support/db-helpers.mjs';

const execFileAsync = promisify(execFile);

function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
}

async function runMiddleware(fn, req, res) {
  return await new Promise((resolve, reject) => {
    fn(req, res, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

test('authenticated household-scoped routes stay pinned to the signed cookie household when multiple households exist', async () => {
  await withTempDb('household-isolation-routes', async ({ importFresh }) => {
    const db = await importFresh('../db.mjs', 'household-isolation-db');
    const cookbook = await importFresh('../cookbook-store.mjs', 'household-isolation-cookbook');
    const kitchenbot = await importFresh('../kitchenbot.mjs', 'household-isolation-kitchenbot');
    await db.runMigrations();

    const householdOne = await db.createHouseholdWithInitialOwner({
      householdName: 'Rob and Elle',
      householdKey: 'oconnor-home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const householdTwo = await db.createHouseholdWithInitialOwner({
      householdName: 'Codex Debug',
      householdKey: 'codex-debug',
      ownerDisplayName: 'Pat',
      pin: '5678',
    });

    await db.createChat(householdOne.householdId, 'Rob', 'Real household chat');
    await db.createChat(householdTwo.householdId, 'Pat', 'Debug household chat');

    await db.saveCookbookEntry(
      householdOne.householdId,
      cookbook.buildCookbookRecordForStorage({
        title: 'Serious Eats beef stew',
        summary: 'A rich beef stew for cold nights.',
        ingredients: ['beef chuck', 'stock'],
        instructions: ['Brown the beef.', 'Simmer until tender.'],
        sourceTitle: 'All-American Beef Stew',
        sourceUrl: 'https://www.seriouseats.com/all-american-beef-stew-recipe',
        sourceKind: 'manual',
      })
    );
    await db.saveCookbookEntry(
      householdTwo.householdId,
      cookbook.buildCookbookRecordForStorage({
        title: 'Debug pasta',
        summary: 'A throwaway debug recipe.',
        ingredients: ['pasta'],
        instructions: ['Boil the pasta.'],
        sourceKind: 'manual',
      })
    );

    const token = kitchenbot.signToken({
      householdId: householdOne.householdId,
      userId: householdOne.userId,
      displayName: 'Rob',
      sessionVersion: 0,
    });
    const req = {
      headers: {
        cookie: `kitchenbot_auth=${token}`,
      },
    };

    await runMiddleware(kitchenbot.requireHousehold, req, createMockRes());
    assert.equal(req.householdId, householdOne.householdId);
    await runMiddleware(kitchenbot.requireAuth, req, createMockRes());
    assert.equal(req.householdId, householdOne.householdId);
    assert.equal(req.user, 'Rob');

    const meRes = createMockRes();
    await kitchenbot.handleGetMe(req, meRes);
    assert.equal(meRes.statusCode, 200);
    assert.equal(meRes.body.householdId, householdOne.householdId);
    assert.equal(meRes.body.householdName, 'Rob and Elle');
    assert.equal(meRes.body.householdKey, 'oconnor-home');

    const cookbookRes = createMockRes();
    await kitchenbot.handleGetCookbook(req, cookbookRes);
    assert.equal(cookbookRes.statusCode, 200);
    assert.deepEqual(
      cookbookRes.body.items.map((entry) => entry.title),
      ['Serious Eats beef stew']
    );

    const chatsRes = createMockRes();
    await kitchenbot.handleGetChats(req, chatsRes);
    assert.equal(chatsRes.statusCode, 200);
    assert.deepEqual(
      chatsRes.body.chats.map((chat) => chat.title),
      ['Real household chat']
    );
  });
});

test('household sanity script reports multiple households and their chat/cookbook counts without mutating anything', async () => {
  await withTempDb('household-sanity-script', async ({ dbPath, importFresh }) => {
    const db = await importFresh('../db.mjs', 'household-sanity-db');
    const cookbook = await importFresh('../cookbook-store.mjs', 'household-sanity-cookbook');
    await db.runMigrations();

    const householdOne = await db.createHouseholdWithInitialOwner({
      householdName: 'Rob and Elle',
      householdKey: 'oconnor-home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const householdTwo = await db.createHouseholdWithInitialOwner({
      householdName: 'Codex Debug',
      householdKey: 'codex-debug',
      ownerDisplayName: 'Pat',
      pin: '5678',
    });

    await db.createChat(householdOne.householdId, 'Rob', 'Dinner');
    await db.createChat(householdOne.householdId, 'Rob', 'Groceries');
    await db.createChat(householdTwo.householdId, 'Pat', 'Debug');

    await db.saveCookbookEntry(
      householdOne.householdId,
      cookbook.buildCookbookRecordForStorage({
        title: 'White Chicken Chili',
        summary: 'A cozy chili for weeknights.',
        ingredients: ['chicken', 'beans'],
        instructions: ['Simmer everything together.'],
        sourceKind: 'manual',
      })
    );

    const { stdout } = await execFileAsync(process.execPath, ['scripts/household-sanity.mjs'], {
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
      env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
    });

    assert.match(stdout, /KitchenBot DB:/);
    assert.match(stdout, /#1 \| Rob and Elle \| key=oconnor-home \| chats=2 \| cookbook=1/);
    assert.match(stdout, /#2 \| Codex Debug \| key=codex-debug \| chats=1 \| cookbook=0/);
  });
});
