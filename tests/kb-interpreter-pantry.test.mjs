import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('interpreter executes a grounded grocery write without a second interpretation pass', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-interpreter-grounded-grocery-'));
  const dbPath = path.join(tempDir, 'kb-interpreter-grounded-grocery.db');

  const script = `
    const { interpretKbTurn } = await import(new URL('./kb-interpreter.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const turn = await interpretKbTurn({
      prompt: 'Yes, add the necessary items to our grocery list',
      memoryContext: { capabilities: { webSearchEnabled: false } },
      groundedTurn: {
        turnMode: 'execute_action',
        surface: 'grocery',
        intent: 'add_grocery_items',
        activeObjects: [{ type: 'grocery_list', label: 'Household grocery list' }],
      },
      runtimeProposedNextAction: null,
    });
    process.stdout.write(JSON.stringify(turn));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.kind, 'execute_action');
  assert.equal(parsed.actions[0].capability, 'grocery.write');

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('interpreter promotes clear current-object grocery commits into execute_action', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-interpreter-current-object-grocery-'));
  const dbPath = path.join(tempDir, 'kb-interpreter-current-object-grocery.db');

  const script = `
    const { interpretKbTurn } = await import(new URL('./kb-interpreter.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const turn = await interpretKbTurn({
      prompt: 'Okay now add all of that to the grocery list.',
      memoryContext: { capabilities: { webSearchEnabled: false } },
      groundedTurn: {
        turnMode: 'reply_only',
        surface: 'conversation',
        intent: 'answer_question',
        currentObject: {
          objectType: 'meal_set',
          versionSummary: 'Three weeknight dinners',
          mealIdeas: ['cacio e pepe', 'miso-glazed cod bowl', 'white bean soup'],
        },
        activeObjects: [{ type: 'grocery_list', label: 'Household grocery list' }],
      },
      runtimeProposedNextAction: null,
    });
    process.stdout.write(JSON.stringify(turn));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.kind, 'execute_action');
  assert.equal(parsed.actions[0].capability, 'grocery.write');
  assert.equal(parsed.actions[0].input.source, 'meal_set');

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('interpreter promotes clear current-object grocery commits even when grounding initially asks to clarify', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-interpreter-current-object-grocery-clarify-'));
  const dbPath = path.join(tempDir, 'kb-interpreter-current-object-grocery-clarify.db');

  const script = `
    const { interpretKbTurn } = await import(new URL('./kb-interpreter.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const turn = await interpretKbTurn({
      prompt: 'Cool, put all that on the grocery list.',
      memoryContext: { capabilities: { webSearchEnabled: false } },
      groundedTurn: {
        turnMode: 'clarify',
        surface: 'conversation',
        intent: 'answer_question',
        currentObject: {
          objectType: 'meal_set',
          versionSummary: 'Three weeknight dinners',
          mealIdeas: ['cacio e pepe', 'miso-glazed cod bowl', 'white bean soup'],
        },
        activeObjects: [{ type: 'grocery_list', label: 'Household grocery list' }],
      },
      runtimeProposedNextAction: null,
    });
    process.stdout.write(JSON.stringify(turn));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.kind, 'execute_action');
  assert.equal(parsed.actions[0].capability, 'grocery.write');
  assert.equal(parsed.actions[0].input.source, 'meal_set');

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('interpreter promotes clear current-object cookbook saves into execute_action', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-interpreter-current-object-cookbook-'));
  const dbPath = path.join(tempDir, 'kb-interpreter-current-object-cookbook.db');

  const script = `
    const { interpretKbTurn } = await import(new URL('./kb-interpreter.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const turn = await interpretKbTurn({
      prompt: 'Okay this looks really good. Add it to our cookbook.',
      memoryContext: { capabilities: { webSearchEnabled: false } },
      groundedTurn: {
        turnMode: 'reply_only',
        surface: 'conversation',
        intent: 'answer_question',
        currentObject: {
          objectType: 'chat_recipe',
          title: 'Wonton Soup Stock',
          versionSummary: 'Wonton Soup Stock',
          recipeText: 'Wonton Soup Stock\\n\\nIngredients\\n- broth\\n\\nInstructions\\n1. Simmer.',
          recipeRecord: {
            title: 'Wonton Soup Stock',
            ingredients: ['broth'],
            instructions: ['Simmer.'],
            sourceKind: 'kb_generated',
          },
        },
      },
      runtimeProposedNextAction: null,
    });
    process.stdout.write(JSON.stringify(turn));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.kind, 'execute_action');
  assert.equal(parsed.actions[0].capability, 'cookbook.save');
  assert.equal(parsed.actions[0].input.targetRecipe.title, 'Wonton Soup Stock');

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('interpreter executes grocery intent aliases through the grocery.write skill', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-interpreter-grocery-alias-'));
  const dbPath = path.join(tempDir, 'kb-interpreter-grocery-alias.db');

  const script = `
    const { interpretKbTurn } = await import(new URL('./kb-interpreter.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const turn = await interpretKbTurn({
      prompt: 'Put all that on the grocery list.',
      memoryContext: { capabilities: { webSearchEnabled: false } },
      groundedTurn: {
        turnMode: 'execute_action',
        surface: 'grocery',
        intent: 'add_recipe_ingredients_to_grocery_list',
        currentObject: {
          objectType: 'meal_set',
          versionSummary: 'Three weeknight dinners',
          mealIdeas: ['cacio e pepe', 'cod bowl', 'white bean soup'],
        },
      },
      runtimeProposedNextAction: null,
    });
    process.stdout.write(JSON.stringify(turn));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.kind, 'execute_action');
  assert.equal(parsed.actions[0].capability, 'grocery.write');

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('interpreter source no longer contains interpreter fallback logic or a second model pass', async () => {
  const source = await fs.readFile(
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'kb-interpreter.mjs'),
    'utf8'
  );
  assert.doesNotMatch(source, /needsInterpreterFallback/);
  assert.doesNotMatch(source, /createLoggedAnthropicMessage/);
});

test('grounding keeps a fresh cooking turn in conversation even with stale meal continuity present', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-interpreter-fresh-turn-'));
  const dbPath = path.join(tempDir, 'kb-interpreter-fresh-turn.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const memory = await import(new URL('./kb-memory-store.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { groundTurnFinal } = await import(new URL('./kb-grounding.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const memoryContext = await memory.buildKbContextPacket(created.householdId, 'We are making the bean soup tonight. Remind me the recipe.', {
      includeDefaults: true,
      includePantry: false,
      includeGrocery: false,
      includeCookbook: false,
      activeSpeakerName: 'Rob',
      capabilities: { webSearchEnabled: false },
    });
    const recentMessages = [
      { role: 'user', name: 'Rob', content: 'help me plan three dinners this week: one brothy, one cheesy pasta, one fish' },
      { role: 'assistant', name: 'KitchenBot', content: 'Brothy: smoky bean soup\\nCheesy pasta: baked ziti\\nFish: roast salmon' },
    ];
    const anthropic = {
      messages: {
        create: async () => ({
          model: 'claude-haiku-4-5',
          usage: { input_tokens: 10, output_tokens: 20 },
          content: [{ type: 'text', text: JSON.stringify({ turnMode: 'reply_only', surface: 'conversation', intent: 'answer_question', confidence: 'high' }) }],
        }),
      },
    };
    const grounded = await groundTurnFinal({
      anthropic,
      req: { householdId: created.householdId },
      prompt: 'We are making the bean soup tonight. Remind me the recipe.',
      activeSpeakerName: 'Rob',
      memoryContext,
      recentMessages,
      workingContext: {
        topicSummary: 'Old dinner plan',
        mealIdeas: ['Roast salmon', 'Baked ziti', 'Smoky bean soup'],
        subjectItems: ['Roast salmon', 'Baked ziti', 'Smoky bean soup'],
      },
      runtimeProposedNextAction: null,
      deps: { stripStoredMessageContentForDisplay: (text) => text },
    });
    process.stdout.write(JSON.stringify(grounded));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.turnMode, 'reply_only');
  assert.equal(parsed.surface, 'conversation');

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('grounding keeps dish-level clarify when multiple saved cookbook targets remain genuinely ambiguous', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-interpreter-recipe-ambiguous-'));
  const dbPath = path.join(tempDir, 'kb-interpreter-recipe-ambiguous.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const memory = await import(new URL('./kb-memory-store.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { groundTurnFinal } = await import(new URL('./kb-grounding.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const memoryContext = await memory.buildKbContextPacket(created.householdId, 'update the chili recipe in our cookbook', {
      includeDefaults: false,
      includePantry: false,
      includeGrocery: false,
      includeCookbook: true,
      activeSpeakerName: 'Rob',
      capabilities: { webSearchEnabled: false },
    });
    memoryContext.cookbookEntries = [
      { id: 1, title: 'Weeknight White Chicken Chili' },
      { id: 2, title: 'Poblano White Chicken Chili' },
    ];
    const anthropic = {
      messages: {
        create: async () => ({
          model: 'claude-haiku-4-5',
          usage: { input_tokens: 10, output_tokens: 20 },
          content: [{ type: 'text', text: JSON.stringify({ turnMode: 'execute_action', surface: 'cookbook', intent: 'update_saved_recipe', confidence: 'high' }) }],
        }),
      },
    };
    const grounded = await groundTurnFinal({
      anthropic,
      req: { householdId: created.householdId },
      prompt: 'update the chili recipe in our cookbook',
      activeSpeakerName: 'Rob',
      memoryContext,
      runtimeProposedNextAction: null,
      deps: { stripStoredMessageContentForDisplay: (text) => text },
    });
    process.stdout.write(JSON.stringify(grounded));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.turnMode, 'clarify');
  assert.match(parsed.clarifyQuestion, /which saved cookbook recipe/i);
  assert.equal(parsed.clarifyChoices.length, 2);

  await fs.rm(tempDir, { recursive: true, force: true });
});
