import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

test('ONE BRAIN: grocery.write does NOT derive items from a recipe in the transcript (returns no_items)', async () => {
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

  // ONE BRAIN: even with recipes in the chat and a referential prompt, grocery.write must NOT
  // scan the transcript and derive the shopping list itself. It returns no_items so the brain
  // enumerates the ingredients and passes them explicitly. No side-model, no items written.
  assert.equal(parsed.outcome.status, 'no_items');
  assert.equal(parsed.anthropicCalls, 0);
  assert.equal(parsed.groceryItems.length, 0);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('ONE BRAIN: grocery.write commits explicit brain items with NO side-model call', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-grocery-explicit-'));
  const dbPath = path.join(tempDir, 'grocery-explicit.db');
  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const grocery = await import(new URL('./grocery-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const inventory = await import(new URL('./inventory-service.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({ householdName: 'Home', householdKey: 'home', ownerDisplayName: 'Rob', pin: '1234' });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Explicit');
    const anthropic = { messages: { create: async () => { anthropic.callCount = (anthropic.callCount||0)+1; return { content: [] }; } } };
    const outcome = await grocery.writeGroceryListFromConversation(
      { capability: 'grocery.write', input: { source: 'explicit_items', items: [ { name: 'flour', section: 'dry', amount: '1 bag' }, { name: 'eggs', section: 'dairy', amount: '12' } ] } },
      { req: { householdId: created.householdId }, name: 'Rob', chatId, prompt: 'add flour and eggs', anthropic,
        memoryContext: { pantryItems: [], pantryContextStatus: 'available', pantryContextAvailable: true, pantryItemCount: 0 },
        kbModeEnabled: true, runtimeManagedResponse: true, userMessageAlreadyPersisted: true,
        deps: {
          addMessage: db.addMessage, stripStoredMessageContentForDisplay: (t)=>t, incrementUserMessageCountForSender: async()=>{}, broadcastToChat: ()=>{},
          getGroceryItems: db.getGroceryItems, updateGroceryItemAmount: db.updateGroceryItemAmount, updateGroceryItemProbablyPantry: db.updateGroceryItemProbablyPantry,
          backfillGroceryItemSourceChatIfSafe: db.backfillGroceryItemSourceChatIfSafe, addGroceryItems: db.addGroceryItems, clearGroceryItems: db.clearGroceryItems,
          mergeGroceryItemsFromAi: (h,p,s)=>inventory.mergeGroceryItemsFromAi({ householdId:h, parsedItems:p, sourceChatId:s, getGroceryItems: db.getGroceryItems, updateGroceryItemAmount: db.updateGroceryItemAmount, updateGroceryItemProbablyPantry: db.updateGroceryItemProbablyPantry, backfillGroceryItemSourceChatIfSafe: db.backfillGroceryItemSourceChatIfSafe, addGroceryItems: db.addGroceryItems }),
          normalizeGroceryItemsForPost: (items, opts)=>inventory.normalizeGroceryItemsForPost(items, { ...opts, getAnthropicClient: async()=>({ client: anthropic }) }),
          normalizeInventoryNameKey: inventory.normalizeInventoryNameKey,
        } }
    );
    const groceryItems = await db.getGroceryItems(created.householdId);
    process.stdout.write(JSON.stringify({ outcome, names: groceryItems.map(i=>i.name).sort(), callCount: anthropic.callCount||0 }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());
  assert.deepEqual(parsed.names, ['eggs', 'flour']);
  assert.deepEqual(parsed.outcome.addedItems.map(s=>s.toLowerCase()).sort(), ['eggs', 'flour']);
  assert.equal(parsed.callCount, 0, 'no side-model may be called to commit explicit items');
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('ONE BRAIN: grocery.write with no items returns no_items and calls no model', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-grocery-noitems-'));
  const dbPath = path.join(tempDir, 'grocery-noitems.db');
  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const grocery = await import(new URL('./grocery-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const inventory = await import(new URL('./inventory-service.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({ householdName: 'Home', householdKey: 'home', ownerDisplayName: 'Rob', pin: '1234' });
    const chatId = await db.createChat(created.householdId, 'Rob', 'NoItems');
    await db.addMessage(created.householdId, chatId, 'user', 'Rob', 'make me a grocery list for the week');
    const anthropic = { messages: { create: async () => { anthropic.callCount = (anthropic.callCount||0)+1; return { content: [{ type:'text', text:'dry | flour | 1 bag' }] }; } } };
    const outcome = await grocery.writeGroceryListFromConversation(
      { capability: 'grocery.write', input: {} },
      { req: { householdId: created.householdId }, name: 'Rob', chatId, prompt: 'make me a grocery list', anthropic,
        memoryContext: { pantryItems: [], pantryContextStatus: 'available', pantryContextAvailable: true, pantryItemCount: 0 },
        kbModeEnabled: true, runtimeManagedResponse: true, userMessageAlreadyPersisted: true,
        deps: { addMessage: db.addMessage, stripStoredMessageContentForDisplay: (t)=>t, incrementUserMessageCountForSender: async()=>{}, broadcastToChat: ()=>{},
          getGroceryItems: db.getGroceryItems, addGroceryItems: db.addGroceryItems, clearGroceryItems: db.clearGroceryItems,
          normalizeInventoryNameKey: inventory.normalizeInventoryNameKey } }
    );
    const groceryItems = await db.getGroceryItems(created.householdId);
    process.stdout.write(JSON.stringify({ status: outcome.status, itemCount: groceryItems.length, callCount: anthropic.callCount||0 }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.status, 'no_items');
  assert.equal(parsed.itemCount, 0);
  assert.equal(parsed.callCount, 0, 'no side-model may be called when the brain provided no items');
  await fs.rm(tempDir, { recursive: true, force: true });
});
