import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('grocery.write re-reasons over current pantry state before commit', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-grocery-pantry-rereason-'));
  const dbPath = path.join(tempDir, 'grocery-pantry-rereason.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const grocery = await import(new URL('./grocery-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const memory = await import(new URL('./kb-memory-store.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const inventory = await import(new URL('./inventory-service.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Grocery pantry rerun');
    await db.addMessage(created.householdId, chatId, 'user', 'Rob', 'Plan dinners for this week.');
    await db.addMessage(created.householdId, chatId, 'assistant', 'KitchenBot', 'Let\\'s do lemon pasta and roast chicken tacos.');
    await db.addMessage(created.householdId, chatId, 'user', 'Rob', 'Make me a grocery list for those.');
    await db.addMessage(created.householdId, chatId, 'assistant', 'KitchenBot', 'If you want, I can add these items to your Grocery List tab.');

    const anthropic = {
      messages: {
        create: async () => {
          anthropic.callCount = (anthropic.callCount || 0) + 1;
          if (anthropic.callCount === 1) {
            return {
              model: 'claude-sonnet-4-5',
              usage: { input_tokens: 20, output_tokens: 40 },
              content: [{ type: 'text', text: 'dry | pasta | 1 box\\ndry | olive oil | 1 bottle\\nproduce | lemons | 2' }],
            };
          }
          return {
            model: 'claude-sonnet-4-5',
            usage: { input_tokens: 15, output_tokens: 30 },
            content: [{ type: 'text', text: 'dry | pasta | 1 box\\nproduce | lemons | 2' }],
          };
        },
      },
    };

    await db.addPantryItems(created.householdId, [{ name: 'olive oil', section: 'oils_vinegars', amount: '1 bottle' }]);

    const memoryContext = await memory.buildKbContextPacket(created.householdId, 'yes', {
      includeDefaults: true,
      includeCookbook: true,
      includePantry: true,
      includeGrocery: true,
      activeSpeakerName: 'Rob',
      capabilities: { webSearchEnabled: false },
    });

    const outcome = await grocery.writeGroceryListFromConversation(
      { capability: 'grocery.write', input: { source: 'draft_chat_offer', mode: 'append' } },
      {
        req: { householdId: created.householdId },
        name: 'Rob',
        chatId,
        prompt: 'yes',
        anthropic,
        memoryContext,
        kbModeEnabled: true,
        runtimeManagedResponse: true,
        userMessageAlreadyPersisted: true,
        deps: {
          addMessage: db.addMessage,
          stripStoredMessageContentForDisplay: (text) => text,
          incrementUserMessageCountForSender: async () => {},
          broadcastToChat: () => {},
          getGroceryItems: db.getGroceryItems,
          updateGroceryItemAmount: db.updateGroceryItemAmount,
          backfillGroceryItemSourceChatIfSafe: db.backfillGroceryItemSourceChatIfSafe,
          addGroceryItems: db.addGroceryItems,
          clearGroceryItems: db.clearGroceryItems,
          mergeGroceryItemsFromAi: (householdId, parsedItems, sourceChatId) =>
            inventory.mergeGroceryItemsFromAi({
              householdId,
              parsedItems,
              sourceChatId,
              getGroceryItems: db.getGroceryItems,
              updateGroceryItemAmount: db.updateGroceryItemAmount,
              backfillGroceryItemSourceChatIfSafe: db.backfillGroceryItemSourceChatIfSafe,
              addGroceryItems: db.addGroceryItems,
            }),
          normalizeGroceryItemsForPost: (items, opts) =>
            inventory.normalizeGroceryItemsForPost(items, {
              ...opts,
              getAnthropicClient: async () => {
                throw new Error('no anthropic');
              },
            }),
          normalizeInventoryNameKey: inventory.normalizeInventoryNameKey,
        },
      }
    );

    const groceryItems = await db.getGroceryItems(created.householdId);
    process.stdout.write(JSON.stringify({
      outcome,
      groceryItems,
      anthropicCallCount: anthropic.callCount,
    }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.outcome.status, 'committed');
  assert.equal(parsed.outcome.usedPantryContext, true);
  assert.equal(parsed.outcome.pantryClarificationNeeded, false);
  assert.equal(parsed.outcome.pantryContextStatus, 'available');
  assert.equal(parsed.outcome.pantryItemCount, 1);
  assert.equal(parsed.outcome.reconciledWithPantry, true);
  assert.equal(parsed.outcome.initialParsedItemCount, 3);
  assert.equal(parsed.outcome.finalParsedItemCount, 2);
  assert.equal(parsed.outcome.pantryAdjustedItemCount, 1);
  assert.deepEqual(parsed.outcome.missingFromPantry, ['pasta', 'lemons']);
  assert.equal(parsed.anthropicCallCount, 2);
  assert.deepEqual(parsed.groceryItems.map((item) => item.name), ['pasta', 'lemons']);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('grocery.write marks pantry as unavailable when that context was not loaded', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-grocery-pantry-unavailable-'));
  const dbPath = path.join(tempDir, 'grocery-pantry-unavailable.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const grocery = await import(new URL('./grocery-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const inventory = await import(new URL('./inventory-service.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Grocery pantry unavailable');
    await db.addMessage(created.householdId, chatId, 'user', 'Rob', 'Add the cake ingredients to our grocery list.');

    const anthropic = {
      messages: {
        create: async () => ({
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 12, output_tokens: 24 },
          content: [{ type: 'text', text: 'dry | flour | 1 bag\\ndairy | eggs | 12' }],
        }),
      },
    };

    const outcome = await grocery.writeGroceryListFromConversation(
      { capability: 'grocery.write', input: { mode: 'append' } },
      {
        req: { householdId: created.householdId },
        name: 'Rob',
        chatId,
        prompt: 'Add the cake ingredients to our grocery list.',
        anthropic,
        memoryContext: {
          pantryItems: [],
          pantryContextStatus: 'unavailable',
          pantryContextAvailable: false,
          pantryItemCount: 0,
        },
        kbModeEnabled: true,
        runtimeManagedResponse: true,
        userMessageAlreadyPersisted: true,
        deps: {
          addMessage: db.addMessage,
          stripStoredMessageContentForDisplay: (text) => text,
          incrementUserMessageCountForSender: async () => {},
          broadcastToChat: () => {},
          getGroceryItems: db.getGroceryItems,
          updateGroceryItemAmount: db.updateGroceryItemAmount,
          backfillGroceryItemSourceChatIfSafe: db.backfillGroceryItemSourceChatIfSafe,
          addGroceryItems: db.addGroceryItems,
          clearGroceryItems: db.clearGroceryItems,
          mergeGroceryItemsFromAi: (householdId, parsedItems, sourceChatId) =>
            inventory.mergeGroceryItemsFromAi({
              householdId,
              parsedItems,
              sourceChatId,
              getGroceryItems: db.getGroceryItems,
              updateGroceryItemAmount: db.updateGroceryItemAmount,
              backfillGroceryItemSourceChatIfSafe: db.backfillGroceryItemSourceChatIfSafe,
              addGroceryItems: db.addGroceryItems,
            }),
          normalizeGroceryItemsForPost: (items, opts) =>
            inventory.normalizeGroceryItemsForPost(items, {
              ...opts,
              getAnthropicClient: async () => {
                throw new Error('no anthropic');
              },
            }),
          normalizeInventoryNameKey: inventory.normalizeInventoryNameKey,
        },
      }
    );

    process.stdout.write(JSON.stringify({ outcome }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.outcome.status, 'committed');
  assert.equal(parsed.outcome.usedPantryContext, false);
  assert.equal(parsed.outcome.pantryClarificationNeeded, true);
  assert.equal(parsed.outcome.pantryContextStatus, 'unavailable');
  assert.equal(parsed.outcome.pantryItemCount, 0);
  assert.deepEqual(parsed.outcome.missingFromPantry, ['flour', 'eggs']);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('grocery.write checks the live grocery list before claiming an explicit item is already there', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-grocery-direct-add-present-'));
  const dbPath = path.join(tempDir, 'grocery-direct-add-present.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const grocery = await import(new URL('./grocery-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const inventory = await import(new URL('./inventory-service.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Grocery direct add present');
    await db.addGroceryItems(created.householdId, [{ name: 'powdered sugar', section: 'dry', amount: '' }]);

    const outcome = await grocery.writeGroceryListFromConversation(
      { capability: 'grocery.write', input: { source: 'explicit_items', items: [{ name: 'powdered sugar', amount: '', section: '' }] } },
      {
        req: { householdId: created.householdId },
        name: 'Rob',
        chatId,
        prompt: 'add powdered sugar to the grocery list',
        anthropic: null,
        memoryContext: {
          pantryItems: [],
          pantryContextStatus: 'available',
          pantryContextAvailable: true,
          pantryItemCount: 0,
        },
        kbModeEnabled: true,
        runtimeManagedResponse: true,
        userMessageAlreadyPersisted: true,
        deps: {
          addMessage: db.addMessage,
          stripStoredMessageContentForDisplay: (text) => text,
          incrementUserMessageCountForSender: async () => {},
          broadcastToChat: () => {},
          getGroceryItems: db.getGroceryItems,
          updateGroceryItemAmount: db.updateGroceryItemAmount,
          updateGroceryItemProbablyPantry: db.updateGroceryItemProbablyPantry,
          backfillGroceryItemSourceChatIfSafe: db.backfillGroceryItemSourceChatIfSafe,
          addGroceryItems: db.addGroceryItems,
          clearGroceryItems: db.clearGroceryItems,
          mergeGroceryItemsFromAi: (householdId, parsedItems, sourceChatId) =>
            inventory.mergeGroceryItemsFromAi({
              householdId,
              parsedItems,
              sourceChatId,
              getGroceryItems: db.getGroceryItems,
              updateGroceryItemAmount: db.updateGroceryItemAmount,
              updateGroceryItemProbablyPantry: db.updateGroceryItemProbablyPantry,
              backfillGroceryItemSourceChatIfSafe: db.backfillGroceryItemSourceChatIfSafe,
              addGroceryItems: db.addGroceryItems,
            }),
          normalizeInventoryNameKey: inventory.normalizeInventoryNameKey,
        },
      }
    );

    const groceryItems = await db.getGroceryItems(created.householdId);
    process.stdout.write(JSON.stringify({ outcome, groceryItems }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.outcome.status, 'already_present');
  assert.equal(parsed.outcome.checkedLiveGroceryList, true);
  assert.equal(parsed.groceryItems.length, 1);
  assert.equal(parsed.groceryItems[0].name, 'powdered sugar');

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('grocery.write appends a direct explicit item when it is missing', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-grocery-direct-add-missing-'));
  const dbPath = path.join(tempDir, 'grocery-direct-add-missing.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const grocery = await import(new URL('./grocery-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const inventory = await import(new URL('./inventory-service.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Grocery direct add missing');

    const outcome = await grocery.writeGroceryListFromConversation(
      { capability: 'grocery.write', input: { source: 'explicit_items', items: [{ name: 'powdered sugar', amount: '', section: '' }] } },
      {
        req: { householdId: created.householdId },
        name: 'Rob',
        chatId,
        prompt: 'add powdered sugar to the grocery list',
        anthropic: null,
        memoryContext: {
          pantryItems: [],
          pantryContextStatus: 'available',
          pantryContextAvailable: true,
          pantryItemCount: 0,
        },
        kbModeEnabled: true,
        runtimeManagedResponse: true,
        userMessageAlreadyPersisted: true,
        deps: {
          addMessage: db.addMessage,
          stripStoredMessageContentForDisplay: (text) => text,
          incrementUserMessageCountForSender: async () => {},
          broadcastToChat: () => {},
          getGroceryItems: db.getGroceryItems,
          updateGroceryItemAmount: db.updateGroceryItemAmount,
          updateGroceryItemProbablyPantry: db.updateGroceryItemProbablyPantry,
          backfillGroceryItemSourceChatIfSafe: db.backfillGroceryItemSourceChatIfSafe,
          addGroceryItems: db.addGroceryItems,
          clearGroceryItems: db.clearGroceryItems,
          mergeGroceryItemsFromAi: (householdId, parsedItems, sourceChatId) =>
            inventory.mergeGroceryItemsFromAi({
              householdId,
              parsedItems,
              sourceChatId,
              getGroceryItems: db.getGroceryItems,
              updateGroceryItemAmount: db.updateGroceryItemAmount,
              updateGroceryItemProbablyPantry: db.updateGroceryItemProbablyPantry,
              backfillGroceryItemSourceChatIfSafe: db.backfillGroceryItemSourceChatIfSafe,
              addGroceryItems: db.addGroceryItems,
            }),
          normalizeInventoryNameKey: inventory.normalizeInventoryNameKey,
        },
      }
    );

    const groceryItems = await db.getGroceryItems(created.householdId);
    process.stdout.write(JSON.stringify({ outcome, groceryItems }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.outcome.status, 'committed');
  assert.equal(parsed.outcome.checkedLiveGroceryList, true);
  assert.equal(parsed.outcome.mode, 'append');
  assert.equal(parsed.groceryItems.length, 1);
  assert.equal(parsed.groceryItems[0].name, 'powdered sugar');
  assert.equal(parsed.groceryItems[0].probably_pantry_item, 1);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('grocery.write defaults to append when the list already exists', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-grocery-default-append-'));
  const dbPath = path.join(tempDir, 'grocery-default-append.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const grocery = await import(new URL('./grocery-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const inventory = await import(new URL('./inventory-service.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Grocery default append');
    await db.addGroceryItems(created.householdId, [{ name: 'olive oil', section: 'dry', amount: '1 bottle' }]);
    await db.addMessage(created.householdId, chatId, 'user', 'Rob', 'Add the cake ingredients to our grocery list.');

    const anthropic = {
      messages: {
        create: async () => ({
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 12, output_tokens: 24 },
          content: [{ type: 'text', text: 'dry | flour | 1 bag\\ndairy | eggs | 12' }],
        }),
      },
    };

    const outcome = await grocery.writeGroceryListFromConversation(
      { capability: 'grocery.write', input: {} },
      {
        req: { householdId: created.householdId },
        name: 'Rob',
        chatId,
        prompt: 'Add the cake ingredients to our grocery list.',
        anthropic,
        memoryContext: {
          pantryItems: [],
          pantryContextStatus: 'available',
          pantryContextAvailable: true,
          pantryItemCount: 0,
        },
        kbModeEnabled: true,
        runtimeManagedResponse: true,
        userMessageAlreadyPersisted: true,
        deps: {
          addMessage: db.addMessage,
          stripStoredMessageContentForDisplay: (text) => text,
          incrementUserMessageCountForSender: async () => {},
          broadcastToChat: () => {},
          getGroceryItems: db.getGroceryItems,
          updateGroceryItemAmount: db.updateGroceryItemAmount,
          updateGroceryItemProbablyPantry: db.updateGroceryItemProbablyPantry,
          backfillGroceryItemSourceChatIfSafe: db.backfillGroceryItemSourceChatIfSafe,
          addGroceryItems: db.addGroceryItems,
          clearGroceryItems: db.clearGroceryItems,
          mergeGroceryItemsFromAi: (householdId, parsedItems, sourceChatId) =>
            inventory.mergeGroceryItemsFromAi({
              householdId,
              parsedItems,
              sourceChatId,
              getGroceryItems: db.getGroceryItems,
              updateGroceryItemAmount: db.updateGroceryItemAmount,
              updateGroceryItemProbablyPantry: db.updateGroceryItemProbablyPantry,
              backfillGroceryItemSourceChatIfSafe: db.backfillGroceryItemSourceChatIfSafe,
              addGroceryItems: db.addGroceryItems,
            }),
          normalizeInventoryNameKey: inventory.normalizeInventoryNameKey,
        },
      }
    );

    const groceryItems = await db.getGroceryItems(created.householdId);
    process.stdout.write(JSON.stringify({ outcome, groceryItems }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.outcome.status, 'committed');
  assert.equal(parsed.outcome.mode, 'append');
  assert.equal(parsed.groceryItems.length, 3);
  assert.deepEqual(parsed.groceryItems.map((item) => item.name), ['eggs', 'flour', 'olive oil']);

  await fs.rm(tempDir, { recursive: true, force: true });
});
