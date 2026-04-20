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

test('grocery.write can build groceries directly from a grounded revised meal_set', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-grocery-from-meal-set-'));
  const dbPath = path.join(tempDir, 'grocery-from-meal-set.db');

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
    const chatId = await db.createChat(created.householdId, 'Rob', 'Grocery from meal set');

    const anthropic = {
      messages: {
        create: async () => ({
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 12, output_tokens: 36 },
          content: [{ type: 'text', text: 'dry | orzo | 1 box\\nmeat | cod fillets | 1 lb\\nproduce | cabbage | 1 head\\ndry | tortilla soup base | 1 jar' }],
        }),
      },
    };

    const outcome = await grocery.writeGroceryListFromConversation(
      {
        capability: 'grocery.write',
        input: {
          source: 'meal_set',
          sourceMealSet: {
            objectType: 'meal_set',
            versionSummary: 'Weeknight dinner plan',
            mealIdeas: ['lemon orzo skillet', 'cod bowls', 'chicken tortilla soup'],
            subjectItems: ['lemon orzo skillet', 'cod bowls', 'chicken tortilla soup'],
            activeConstraints: ['salmon swapped to cod'],
            groceryFocus: ['lemon orzo skillet', 'cod bowls', 'chicken tortilla soup'],
          },
        },
      },
      {
        req: { householdId: created.householdId },
        name: 'Rob',
        chatId,
        prompt: 'add all of that to the grocery list',
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
    process.stdout.write(JSON.stringify({ outcome, groceryItems }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });

  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.outcome.status, 'committed');
  assert.deepEqual(
    parsed.groceryItems.map((item) => item.name).sort(),
    ['orzo', 'cod fillets', 'cabbage', 'tortilla soup base'].sort()
  );
  assert.equal(parsed.groceryItems.some((item) => /salmon/i.test(item.name)), false);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('grocery.write can build groceries directly from a grounded meal_set_selection', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-grocery-from-meal-set-selection-'));
  const dbPath = path.join(tempDir, 'grocery-from-meal-set-selection.db');

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
    const chatId = await db.createChat(created.householdId, 'Rob', 'Grocery from meal set selection');

    const anthropic = {
      messages: {
        create: async () => ({
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 12, output_tokens: 36 },
          content: [{ type: 'text', text: 'dry | spaghetti | 1 box\\nproduce | lemons | 2\\ndry | white beans | 2 cans\\ndairy | parmesan | 1 wedge' }],
        }),
      },
    };

    const outcome = await grocery.writeGroceryListFromConversation(
      {
        capability: 'grocery.write',
        input: {
          source: 'meal_set_selection',
          sourceMealSetSelection: {
            objectType: 'meal_set_selection',
            versionSummary: 'Selected meals from the current meal set',
            mealIdeas: ['lemon pasta', 'white bean soup'],
            subjectItems: ['lemon pasta', 'white bean soup'],
            selectionScope: 'Selected meals from the current meal set',
          },
        },
      },
      {
        req: { householdId: created.householdId },
        name: 'Rob',
        chatId,
        prompt: 'just add the pasta and soup to the grocery list',
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
          emitKbProgress: async () => {},
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
  assert.deepEqual(parsed.groceryItems.map((item) => item.name).sort(), ['lemons', 'parmesan', 'spaghetti', 'white beans']);

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

test('grocery.write prefers the freshest explicit recipe in recent conversation over inferred soup vibes', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-grocery-recent-recipe-'));
  const dbPath = path.join(tempDir, 'grocery-recent-recipe.db');

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
    const chatId = await db.createChat(created.householdId, 'Rob', 'Recent explicit recipe grocery');
    await db.addMessage(created.householdId, chatId, 'assistant', 'KitchenBot', \`Cheat Wonton Soup with Frozen Pot Stickers & Bok Choy

Ingredients
6 cups chicken broth
2 cloves garlic
1-inch ginger
12 frozen pot stickers
2 heads baby bok choy

Instructions
1. Simmer the broth.
2. Add the pot stickers.
3. Add the bok choy and serve.\`);
    await db.addMessage(created.householdId, chatId, 'user', 'Elle', \`Lemony Artichoke Soup

Ingredients
1/4 cup butter
1 small white onion, diced
1 celery stalk, diced
3 garlic cloves, minced
6 cups chicken or vegetable stock
3 (14-ounce) jars artichoke hearts, drained
1/4 cup freshly-squeezed lemon juice

Instructions
1. Melt the butter and sauté the onion and celery.
2. Add the garlic and cook until fragrant.
3. Add the stock and artichokes and simmer.
4. Blend until smooth.
5. Stir in the lemon juice and serve.\`);
    await db.addMessage(created.householdId, chatId, 'assistant', 'KitchenBot', 'Want me to add those ingredients to the grocery list too?');

    const anthropic = {
      calls: 0,
      messages: {
        create: async () => {
          anthropic.calls += 1;
          throw new Error('anthropic should not be called for explicit recent recipe grocery adds');
        },
      },
    };

    const outcome = await grocery.writeGroceryListFromConversation(
      { capability: 'grocery.write', input: {} },
      {
        req: { householdId: created.householdId },
        name: 'Rob',
        chatId,
        prompt: 'Add the lemony artichoke soup ingredients to our grocery list.',
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
    process.stdout.write(JSON.stringify({ outcome, groceryItems, anthropicCalls: anthropic.calls }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.outcome.status, 'committed');
  assert.equal(parsed.anthropicCalls, 0);
  assert.equal(parsed.groceryItems.some((item) => /artichoke/i.test(item.name)), true);
  assert.equal(parsed.groceryItems.some((item) => /butter/i.test(item.name)), true);
  assert.equal(parsed.groceryItems.some((item) => /lemon/i.test(item.name)), true);
  assert.equal(parsed.groceryItems.some((item) => /pot stickers|bok choy/i.test(item.name)), false);
  assert.equal(parsed.groceryItems.some((item) => /diced|minced|drained|juice/i.test(item.name)), false);
  assert.equal(parsed.groceryItems.some((item) => item.name === 'white onion' && item.section === 'produce'), true);
  assert.equal(parsed.groceryItems.some((item) => item.name === 'celery' && item.section === 'produce'), true);
  assert.equal(parsed.groceryItems.some((item) => item.name === 'garlic' && item.section === 'produce'), true);
  assert.equal(parsed.groceryItems.some((item) => item.name === 'lemons' && item.section === 'produce'), true);
  assert.equal(parsed.groceryItems.some((item) => item.name === 'chicken or vegetable stock' && item.section === 'dry'), true);
  assert.equal(parsed.groceryItems.some((item) => item.name === 'artichoke hearts' && item.section === 'dry'), true);

  await fs.rm(tempDir, { recursive: true, force: true });
});
