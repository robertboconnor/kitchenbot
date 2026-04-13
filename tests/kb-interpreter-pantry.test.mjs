import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('interpreter fallback rejects pantry-confirmation clarify when pantry context is already available for a grocery write', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-interpreter-pantry-'));
  const dbPath = path.join(tempDir, 'kb-interpreter-pantry.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const memory = await import(new URL('./kb-memory-store.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { interpretKbTurn } = await import(new URL('./kb-interpreter.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    await db.addPantryItems(created.householdId, [{ name: 'olive oil', section: 'oils_vinegars', amount: '1 bottle' }]);
    const chatId = await db.createChat(created.householdId, 'Rob', 'Pantry interpreter');
    await db.addMessage(created.householdId, chatId, 'assistant', 'KitchenBot', 'I can cross-reference what you already have in your Pantry so we only add what is missing.');

    const memoryContext = await memory.buildKbContextPacket(created.householdId, 'Yes, add the necessary items to our grocery list', {
      includeDefaults: true,
      includePantry: true,
      includeGrocery: true,
      includeCookbook: false,
      activeSpeakerName: 'Rob',
      capabilities: { webSearchEnabled: false },
    });

    const anthropic = {
      callCount: 0,
      messages: {
        create: async () => {
          anthropic.callCount += 1;
          if (anthropic.callCount === 1) {
            return {
              model: 'claude-haiku-4-5',
              usage: { input_tokens: 10, output_tokens: 20 },
              content: [{ type: 'text', text: JSON.stringify({ kind: 'clarify', question: 'Do you already have olive oil and flour on hand in your pantry?' }) }],
            };
          }
          return {
            model: 'claude-haiku-4-5',
            usage: { input_tokens: 10, output_tokens: 20 },
            content: [{ type: 'text', text: JSON.stringify({ kind: 'execute_action', actions: [{ capability: 'grocery.write', input: {} }] }) }],
          };
        },
      },
    };

    const turn = await interpretKbTurn({
      anthropic,
      req: { householdId: created.householdId },
      chatId,
      prompt: 'Yes, add the necessary items to our grocery list',
      turnId: 'turn-1',
      activeSpeakerName: 'Rob',
      memoryContext,
      runtimeProposedNextAction: null,
      memoriesByKey: new Map(),
      deps: { stripStoredMessageContentForDisplay: (text) => text },
    });
    process.stdout.write(JSON.stringify({
      pantryContextStatus: memoryContext.pantryContextStatus,
      callCount: anthropic.callCount,
      turn,
    }));

  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.pantryContextStatus, 'available');
  assert.equal(parsed.callCount, 2);
  assert.equal(parsed.turn.kind, 'execute_action');
  assert.equal(parsed.turn.actions[0].capability, 'grocery.write');

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('interpreter fallback rejects component-vs-full clarify when one dish is already dominant', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-interpreter-recipe-dominant-'));
  const dbPath = path.join(tempDir, 'kb-interpreter-recipe-dominant.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const memory = await import(new URL('./kb-memory-store.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { interpretKbTurn } = await import(new URL('./kb-interpreter.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Recipe interpreter');
    await db.addMessage(created.householdId, chatId, 'user', 'Rob', 'help me plan 3 meals for this week. one should be a nuts sandwich idea.');
    await db.addMessage(
      created.householdId,
      chatId,
      'assistant',
      'KitchenBot',
      '1. Bacon pork\\n2. Waffle Iron Grilled Cheese "Burger"\\n3. Chicken liver pate'
    );

    const memoryContext = await memory.buildKbContextPacket(created.householdId, 'give me the waffle iron recipe', {
      includeDefaults: true,
      includePantry: false,
      includeGrocery: false,
      includeCookbook: false,
      activeSpeakerName: 'Rob',
      capabilities: { webSearchEnabled: false },
    });
    memoryContext.workingContext = {
      topicSummary: 'Three dinner ideas for the week',
      mealIdeas: ['Bacon-Wrapped Pork Tenderloin', 'Waffle Iron Grilled Cheese Burger', 'Chicken Liver Pate'],
      subjectItems: ['Waffle Iron Grilled Cheese Burger', 'waffle iron recipe'],
    };

    const anthropic = {
      callCount: 0,
      messages: {
        create: async () => {
          anthropic.callCount += 1;
          if (anthropic.callCount === 1) {
            return {
              model: 'claude-haiku-4-5',
              usage: { input_tokens: 10, output_tokens: 20 },
              content: [{ type: 'text', text: JSON.stringify({
                kind: 'clarify',
                question: 'Do you mean the savory waffle recipe itself, or the full assembly and cooking instructions for the whole grilled cheese burger creation?'
              }) }],
            };
          }
          return {
            model: 'claude-haiku-4-5',
            usage: { input_tokens: 10, output_tokens: 20 },
            content: [{ type: 'text', text: JSON.stringify({ kind: 'reply_only' }) }],
          };
        },
      },
    };

    const turn = await interpretKbTurn({
      anthropic,
      req: { householdId: created.householdId },
      chatId,
      prompt: 'give me the waffle iron recipe',
      turnId: 'turn-2',
      activeSpeakerName: 'Rob',
      memoryContext,
      runtimeProposedNextAction: null,
      memoriesByKey: new Map(),
      deps: { stripStoredMessageContentForDisplay: (text) => text },
    });
    process.stdout.write(JSON.stringify({ callCount: anthropic.callCount, turn }));

  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.callCount, 1);
  assert.equal(parsed.turn.kind, 'reply_only');
  assert.deepEqual(parsed.turn.replyPlan, { kind: 'generate_reply' });

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('interpreter rejects dominant-dish-vs-all-three clarify when one dish is already selected', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-interpreter-dominant-vs-all-'));
  const dbPath = path.join(tempDir, 'kb-interpreter-dominant-vs-all.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const memory = await import(new URL('./kb-memory-store.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { interpretKbTurn } = await import(new URL('./kb-interpreter.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Recipe interpreter');
    await db.addMessage(created.householdId, chatId, 'user', 'Rob', 'help me map out three dinners this week: something brothy, something messy in bread, and something roasted');
    await db.addMessage(
      created.householdId,
      chatId,
      'assistant',
      'KitchenBot',
      'Brothy: Tuscan White Bean & Kale Soup\\nMessy in Bread: Meatball Subs\\nRoasted: Lemon Thyme Chicken'
    );
    await db.setChatRuntimeState(chatId, created.householdId, {
      workingContext: {
        topicSummary: 'Three dinners locked in',
        mealIdeas: ['Meatball Subs', 'Tuscan White Bean & Kale Soup', 'Lemon Thyme Chicken'],
        subjectItems: ['Meatball Subs', 'Tuscan White Bean & Kale Soup', 'Lemon Thyme Chicken'],
      },
    });

    const memoryContext = await memory.buildKbContextPacket(created.householdId, 'show me the recipe', {
      includeDefaults: true,
      includePantry: false,
      includeGrocery: false,
      includeCookbook: false,
      activeSpeakerName: 'Rob',
      capabilities: { webSearchEnabled: false },
    });
    memoryContext.workingContext = {
      topicSummary: 'Three dinners locked in',
      mealIdeas: ['Meatball Subs', 'Tuscan White Bean & Kale Soup', 'Lemon Thyme Chicken'],
      subjectItems: ['Meatball Subs', 'Tuscan White Bean & Kale Soup', 'Lemon Thyme Chicken'],
    };

    const anthropic = {
      messages: {
        create: async () => ({
          model: 'claude-haiku-4-5',
          usage: { input_tokens: 10, output_tokens: 20 },
          content: [{ type: 'text', text: JSON.stringify({
            kind: 'clarify',
            question: 'Would you like the Meatball Subs recipe, or would you prefer all three recipes together?',
            proposedNextAction: {
              active: true,
              type: 'clarify_action',
              action: { capability: 'reply_only', input: {} },
              unresolvedFields: ['which_recipe'],
              candidateOptions: [
                { id: 'meatball_subs', label: 'Just the Meatball Subs recipe' },
                { id: 'all_three', label: 'All three recipes' }
              ]
            }
          }) }],
        }),
      },
    };

    const turn = await interpretKbTurn({
      anthropic,
      req: { householdId: created.householdId },
      chatId,
      prompt: 'show me the recipe',
      turnId: 'turn-2',
      activeSpeakerName: 'Rob',
      memoryContext,
      runtimeProposedNextAction: null,
      memoriesByKey: new Map(),
      deps: {
        buildKbContextPacket: async () => memoryContext,
        stripStoredMessageContentForDisplay: (text) => text,
      },
    });
    process.stdout.write(JSON.stringify(turn));

  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });

  const turn = JSON.parse(stdout.trim());
  assert.equal(turn.kind, 'reply_only');
  assert.equal(turn.replyPlan?.kind, 'generate_reply');

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('interpreter rejects which-dish clarify when one dominant selected dish is already locked', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-interpreter-dominant-selected-options-'));
  const dbPath = path.join(tempDir, 'kb-interpreter-dominant-selected-options.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const memory = await import(new URL('./kb-memory-store.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { interpretKbTurn } = await import(new URL('./kb-interpreter.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Dominant selected recipe');
    const memoryContext = await memory.buildKbContextPacket(created.householdId, 'show me the recipe', {
      includeDefaults: true,
      includePantry: false,
      includeGrocery: false,
      includeCookbook: false,
      activeSpeakerName: 'Rob',
      capabilities: { webSearchEnabled: false },
    });
    memoryContext.workingContext = {
      topicSummary: 'Three dinners locked in after switching the sloppy slot to meatball subs.',
      mealIdeas: ['Italian meatball subs with marinara and melted provolone', 'Creamy tomato and white bean soup', 'Whole roasted chicken with root vegetables'],
      subjectItems: ['Italian meatball subs with marinara and melted provolone'],
    };

    const anthropic = {
      callCount: 0,
      messages: {
        create: async () => {
          anthropic.callCount += 1;
          return {
            model: 'claude-haiku-4-5',
            usage: { input_tokens: 10, output_tokens: 20 },
            content: [{ type: 'text', text: JSON.stringify({
              kind: 'clarify',
              question: 'Which recipe would you like to see—meatball subs, the soup, or the roasted chicken?',
              proposedNextAction: {
                active: true,
                type: 'clarify_action',
                action: { capability: 'reply_only', input: {} },
                unresolvedFields: ['dish'],
                candidateOptions: [
                  { id: '1', label: 'Italian meatball subs' },
                  { id: '2', label: 'Creamy tomato and white bean soup' },
                  { id: '3', label: 'Whole roasted chicken with root vegetables' }
                ]
              }
            }) }],
          };
        },
      },
    };

    const turn = await interpretKbTurn({
      anthropic,
      req: { householdId: created.householdId },
      chatId,
      prompt: 'show me the recipe',
      turnId: 'turn-dominant-selected-options',
      activeSpeakerName: 'Rob',
      memoryContext,
      runtimeProposedNextAction: null,
      memoriesByKey: new Map(),
      deps: { stripStoredMessageContentForDisplay: (text) => text },
    });
    process.stdout.write(JSON.stringify({ callCount: anthropic.callCount, turn }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.callCount, 1);
  assert.equal(parsed.turn.kind, 'reply_only');
  assert.deepEqual(parsed.turn.replyPlan, { kind: 'generate_reply' });

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('interpreter keeps dish-level clarify when multiple targets are still genuinely active', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-interpreter-recipe-ambiguous-'));
  const dbPath = path.join(tempDir, 'kb-interpreter-recipe-ambiguous.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const memory = await import(new URL('./kb-memory-store.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { interpretKbTurn } = await import(new URL('./kb-interpreter.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Recipe ambiguity');
    const memoryContext = await memory.buildKbContextPacket(created.householdId, 'give me the recipe', {
      includeDefaults: true,
      includePantry: false,
      includeGrocery: false,
      includeCookbook: false,
      activeSpeakerName: 'Rob',
      capabilities: { webSearchEnabled: false },
    });
    memoryContext.workingContext = {
      topicSummary: 'Dinner ideas',
      mealIdeas: ['White Chicken Chili', 'Mexican Street Corn Pasta'],
      subjectItems: [],
    };

    const anthropic = {
      callCount: 0,
      messages: {
        create: async () => {
          anthropic.callCount += 1;
          return {
            model: 'claude-haiku-4-5',
            usage: { input_tokens: 10, output_tokens: 20 },
            content: [{ type: 'text', text: JSON.stringify({
              kind: 'clarify',
              question: 'Do you mean the White Chicken Chili or the Mexican Street Corn Pasta?'
            }) }],
          };
        },
      },
    };

    const turn = await interpretKbTurn({
      anthropic,
      req: { householdId: created.householdId },
      chatId,
      prompt: 'give me the recipe',
      turnId: 'turn-3',
      activeSpeakerName: 'Rob',
      memoryContext,
      runtimeProposedNextAction: null,
      memoriesByKey: new Map(),
      deps: { stripStoredMessageContentForDisplay: (text) => text },
    });
    process.stdout.write(JSON.stringify({ callCount: anthropic.callCount, turn }));

  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.callCount, 1);
  assert.equal(parsed.turn.kind, 'clarify');
  assert.match(parsed.turn.question, /white chicken chili/i);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('interpreter prompt tells the model not to widen back out when one dish is already dominant', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-interpreter-selected-dish-'));
  const dbPath = path.join(tempDir, 'kb-interpreter-selected-dish.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const memory = await import(new URL('./kb-memory-store.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { interpretKbTurn } = await import(new URL('./kb-interpreter.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Selected dish follow-up');
    await db.addMessage(created.householdId, chatId, 'user', 'Rob', 'help me plan 3 meals for this week. one lemony fish, one absurd sandwich, and one mushroom pasta');
    await db.addMessage(created.householdId, chatId, 'assistant', 'KitchenBot', 'Here are three ideas: lemony fish, absurd sandwich, and mushroom pasta.');
    await db.addMessage(created.householdId, chatId, 'user', 'Rob', 'make the absurd sandwich the loaded Italian sub');
    await db.addMessage(created.householdId, chatId, 'assistant', 'KitchenBot', 'Perfect—now we\\'ve got Loaded Italian Sub locked in for that absurd sandwich slot.');

    const memoryContext = await memory.buildKbContextPacket(created.householdId, 'show me the recipe', {
      includeDefaults: true,
      includePantry: false,
      includeGrocery: false,
      includeCookbook: false,
      activeSpeakerName: 'Rob',
      capabilities: { webSearchEnabled: false },
    });
    memoryContext.workingContext = {
      topicSummary: 'Planning 3 meals for the week: lemony fish, loaded Italian sub, mushroom pasta.',
      mealIdeas: ['Loaded Italian Sub', 'Lemony Fish', 'Mushroom Pasta'],
      subjectItems: ['Loaded Italian Sub', 'Lemony Fish', 'Mushroom Pasta'],
    };

    let capturedSystem = '';
    const anthropic = {
      callCount: 0,
      messages: {
        create: async (payload) => {
          anthropic.callCount += 1;
          capturedSystem = String(payload.system || '');
          return {
            model: 'claude-haiku-4-5',
            usage: { input_tokens: 10, output_tokens: 20 },
            content: [{ type: 'text', text: JSON.stringify({ kind: 'reply_only' }) }],
          };
        },
      },
    };

    const turn = await interpretKbTurn({
      anthropic,
      req: { householdId: created.householdId },
      chatId,
      prompt: 'show me the recipe',
      turnId: 'turn-selected',
      activeSpeakerName: 'Rob',
      memoryContext,
      runtimeProposedNextAction: null,
      memoriesByKey: new Map(),
      deps: { stripStoredMessageContentForDisplay: (text) => text },
    });
    process.stdout.write(JSON.stringify({ callCount: anthropic.callCount, capturedSystem, turn }));

  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.callCount, 1);
  assert.match(parsed.capturedSystem, /If one dish is already dominant in the recent conversation or working context, do not widen back out/i);
  assert.match(parsed.capturedSystem, /default to the full actionable dish/i);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('interpreter prompt tells the model to use meal.refine for slot selections inside an active meal thread', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-interpreter-meal-selection-'));
  const dbPath = path.join(tempDir, 'kb-interpreter-meal-selection.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const memory = await import(new URL('./kb-memory-store.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { interpretKbTurn } = await import(new URL('./kb-interpreter.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Meal selection follow-up');
    await db.addMessage(created.householdId, chatId, 'user', 'Rob', 'help me plan 3 meals for this week. one lemony fish, one absurd sandwich, and one mushroom pasta');
    await db.addMessage(created.householdId, chatId, 'assistant', 'KitchenBot', 'Here are three ideas: lemony fish, absurd sandwich, and mushroom pasta.');

    const memoryContext = await memory.buildKbContextPacket(created.householdId, 'make the absurd sandwich the loaded Italian sub', {
      includeDefaults: true,
      includePantry: false,
      includeGrocery: false,
      includeCookbook: false,
      activeSpeakerName: 'Rob',
      capabilities: { webSearchEnabled: false },
    });
    memoryContext.workingContext = {
      topicSummary: 'Planning 3 meals for the week.',
      mealIdeas: ['Lemony Fish', 'Absurd Sandwich', 'Mushroom Pasta'],
      subjectItems: ['Lemony Fish', 'Absurd Sandwich', 'Mushroom Pasta'],
    };

    let capturedSystem = '';
    const anthropic = {
      callCount: 0,
      messages: {
        create: async (payload) => {
          anthropic.callCount += 1;
          capturedSystem = String(payload.system || '');
          return {
            model: 'claude-haiku-4-5',
            usage: { input_tokens: 10, output_tokens: 20 },
            content: [{ type: 'text', text: JSON.stringify({ kind: 'reply_only' }) }],
          };
        },
      },
    };

    const turn = await interpretKbTurn({
      anthropic,
      req: { householdId: created.householdId },
      chatId,
      prompt: 'make the absurd sandwich the loaded Italian sub',
      turnId: 'turn-selection',
      activeSpeakerName: 'Rob',
      memoryContext,
      runtimeProposedNextAction: null,
      memoriesByKey: new Map(),
      deps: { stripStoredMessageContentForDisplay: (text) => text },
    });
    process.stdout.write(JSON.stringify({ callCount: anthropic.callCount, capturedSystem, turn }));

  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.callCount, 2);
  assert.match(parsed.capturedSystem, /Decide whether the latest user prompt is a concrete request to revise the currently active meal thread/i);
  assert.match(parsed.capturedSystem, /If the user is clearly choosing or swapping one dish within that active meal thread/i);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('interpreter rescues concrete meal-slot narrowing into meal.refine after stray clarifies', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-interpreter-meal-refine-rescue-'));
  const dbPath = path.join(tempDir, 'kb-interpreter-meal-refine-rescue.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const memory = await import(new URL('./kb-memory-store.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { interpretKbTurn } = await import(new URL('./kb-interpreter.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Meal refine rescue');
    await db.addMessage(created.householdId, chatId, 'user', 'Rob', 'help me map out three dinners this week: something brothy, something messy in bread, and something roasted');
    await db.addMessage(
      created.householdId,
      chatId,
      'assistant',
      'KitchenBot',
      '**Brothy:** Tuscan White Bean Soup\\n\\n**Messy in bread:** Sloppy Joes or shredded chicken sandwiches\\n\\n**Roasted:** Lemon thyme chicken'
    );

    const memoryContext = await memory.buildKbContextPacket(created.householdId, 'make the messy in bread one meatball subs', {
      includeDefaults: true,
      includePantry: false,
      includeGrocery: false,
      includeCookbook: false,
      activeSpeakerName: 'Rob',
      capabilities: { webSearchEnabled: false },
    });
    memoryContext.workingContext = {
      topicSummary: 'Three dinner ideas for the week',
      mealIdeas: ['Tuscan White Bean Soup', 'Sloppy Joes', 'Lemon thyme chicken'],
      subjectItems: ['Tuscan White Bean Soup', 'Sloppy Joes', 'Lemon thyme chicken'],
    };

    const anthropic = {
      callCount: 0,
      messages: {
        create: async () => {
          anthropic.callCount += 1;
          if (anthropic.callCount === 1) {
            return {
              model: 'claude-haiku-4-5-20251001',
              usage: { input_tokens: 10, output_tokens: 20 },
              content: [{ type: 'text', text: JSON.stringify({
                kind: 'clarify',
                question: 'Are you looking for a meatball sub recipe, or do you want to refine the current sandwich idea?'
              }) }],
            };
          }
          return {
            model: 'claude-sonnet-4-5-20250929',
            usage: { input_tokens: 10, output_tokens: 20 },
            content: [{ type: 'text', text: JSON.stringify({
              kind: 'execute_action',
              actions: [{ capability: 'meal.refine', input: { request: 'make the messy in bread one meatball subs' } }]
            }) }],
          };
        },
      },
    };

    const turn = await interpretKbTurn({
      anthropic,
      req: { householdId: created.householdId },
      chatId,
      prompt: 'make the messy in bread one meatball subs',
      turnId: 'turn-rescue',
      activeSpeakerName: 'Rob',
      memoryContext,
      runtimeProposedNextAction: null,
      memoriesByKey: new Map(),
      deps: { stripStoredMessageContentForDisplay: (text) => text },
    });

    process.stdout.write(JSON.stringify({ turn, callCount: anthropic.callCount }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.callCount, 2);
  assert.equal(parsed.turn.kind, 'execute_action');
  assert.equal(parsed.turn.actions[0].capability, 'meal.refine');
  assert.equal(parsed.turn.actions[0].input.request, 'make the messy in bread one meatball subs');

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('interpreter prompt keeps natural slot references inside the active meal thread', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-interpreter-slot-alias-selection-'));
  const dbPath = path.join(tempDir, 'kb-interpreter-slot-alias-selection.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const memory = await import(new URL('./kb-memory-store.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { interpretKbTurn } = await import(new URL('./kb-interpreter.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Slot alias follow-up');
    await db.addMessage(created.householdId, chatId, 'user', 'Rob', 'help me figure out three dinners this week: something brothy, something crunchy and handheld, and something cozy with beans');
    await db.addMessage(created.householdId, chatId, 'assistant', 'KitchenBot', 'Here are three ideas: brothy noodles, crispy chicken sandwich, and braised beans.');

    const memoryContext = await memory.buildKbContextPacket(created.householdId, 'make the handheld one fish tacos', {
      includeDefaults: true,
      includePantry: false,
      includeGrocery: false,
      includeCookbook: false,
      activeSpeakerName: 'Rob',
      capabilities: { webSearchEnabled: false },
    });
    memoryContext.workingContext = {
      topicSummary: 'Planning 3 dinners for the week.',
      mealIdeas: ['Brothy noodles', 'Crispy chicken sandwich', 'Braised beans'],
      subjectItems: ['Brothy noodles', 'Crispy chicken sandwich', 'Braised beans'],
    };

    let capturedSystem = '';
    const anthropic = {
      callCount: 0,
      messages: {
        create: async (payload) => {
          anthropic.callCount += 1;
          capturedSystem = String(payload.system || '');
          return {
            model: 'claude-haiku-4-5',
            usage: { input_tokens: 10, output_tokens: 20 },
            content: [{ type: 'text', text: JSON.stringify({ kind: 'reply_only' }) }],
          };
        },
      },
    };

    const turn = await interpretKbTurn({
      anthropic,
      req: { householdId: created.householdId },
      chatId,
      prompt: 'make the handheld one fish tacos',
      turnId: 'turn-slot-selection',
      activeSpeakerName: 'Rob',
      memoryContext,
      runtimeProposedNextAction: null,
      memoriesByKey: new Map(),
      deps: { stripStoredMessageContentForDisplay: (text) => text },
    });
    process.stdout.write(JSON.stringify({ callCount: anthropic.callCount, capturedSystem, turn }));

  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.callCount, 2);
  assert.match(parsed.capturedSystem, /Decide whether the latest user prompt is a concrete request to revise the currently active meal thread/i);
  assert.match(parsed.capturedSystem, /If the user is clearly choosing or swapping one dish within that active meal thread/i);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('interpreter does not allow advisory memory questions to mutate state', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-interpreter-memory-advisory-'));
  const dbPath = path.join(tempDir, 'kb-interpreter-memory-advisory.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const memory = await import(new URL('./kb-memory-store.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { interpretKbTurn } = await import(new URL('./kb-interpreter.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Memory advisory');
    const memoryContext = await memory.buildKbContextPacket(created.householdId, "what is the cleanest way to remember that Elle is okay with olives in sandwiches but not as the main ingredient?", {
      includeDefaults: true,
      includePantry: false,
      includeGrocery: false,
      includeCookbook: false,
      activeSpeakerName: 'Rob',
      capabilities: { webSearchEnabled: false },
    });

    const anthropic = {
      callCount: 0,
      messages: {
        create: async () => {
          anthropic.callCount += 1;
          return {
            model: 'claude-haiku-4-5',
            usage: { input_tokens: 10, output_tokens: 20 },
            content: [{ type: 'text', text: JSON.stringify({
              kind: 'execute_action',
              actions: [{ capability: 'memory.save', input: { key: 'elle_preferences', value: "okay with olives in sandwiches but not as the main ingredient" } }]
            }) }],
          };
        },
      },
    };

    const turn = await interpretKbTurn({
      anthropic,
      req: { householdId: created.householdId },
      chatId,
      prompt: "what is the cleanest way to remember that Elle is okay with olives in sandwiches but not as the main ingredient?",
      turnId: 'turn-memory-advisory',
      activeSpeakerName: 'Rob',
      memoryContext,
      runtimeProposedNextAction: null,
      memoriesByKey: new Map(),
      deps: {
        buildKbContextPacket: async () => memoryContext,
        stripStoredMessageContentForDisplay: (text) => text,
      },
    });
    process.stdout.write(JSON.stringify({ callCount: anthropic.callCount, turn }));

  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });

  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.callCount, 1);
  assert.equal(parsed.turn.kind, 'reply_only');
  assert.deepEqual(parsed.turn.replyPlan, { kind: 'generate_reply' });

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('interpreter fallback also rejects component-vs-full clarify when the prompt already asked for only the component', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-interpreter-recipe-component-'));
  const dbPath = path.join(tempDir, 'kb-interpreter-recipe-component.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const memory = await import(new URL('./kb-memory-store.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { interpretKbTurn } = await import(new URL('./kb-interpreter.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Recipe component');
    const memoryContext = await memory.buildKbContextPacket(created.householdId, 'just give me the waffle batter recipe', {
      includeDefaults: true,
      includePantry: false,
      includeGrocery: false,
      includeCookbook: false,
      activeSpeakerName: 'Rob',
      capabilities: { webSearchEnabled: false },
    });
    memoryContext.workingContext = {
      topicSummary: 'Three dinner ideas for the week',
      mealIdeas: ['Bacon-Wrapped Pork Tenderloin', 'Waffle Iron Grilled Cheese Burger', 'Chicken Liver Pate'],
      subjectItems: ['Waffle Iron Grilled Cheese Burger', 'waffle batter recipe'],
    };

    const anthropic = {
      callCount: 0,
      messages: {
        create: async () => {
          anthropic.callCount += 1;
          if (anthropic.callCount === 1) {
            return {
              model: 'claude-haiku-4-5',
              usage: { input_tokens: 10, output_tokens: 20 },
              content: [{ type: 'text', text: JSON.stringify({
                kind: 'clarify',
                question: 'Do you mean the savory waffle recipe itself, or the full assembly and cooking instructions for the whole grilled cheese burger creation?'
              }) }],
            };
          }
          return {
            model: 'claude-haiku-4-5',
            usage: { input_tokens: 10, output_tokens: 20 },
            content: [{ type: 'text', text: JSON.stringify({ kind: 'reply_only' }) }],
          };
        },
      },
    };

    const turn = await interpretKbTurn({
      anthropic,
      req: { householdId: created.householdId },
      chatId,
      prompt: 'just give me the waffle batter recipe',
      turnId: 'turn-4',
      activeSpeakerName: 'Rob',
      memoryContext,
      runtimeProposedNextAction: null,
      memoriesByKey: new Map(),
      deps: { stripStoredMessageContentForDisplay: (text) => text },
    });
    process.stdout.write(JSON.stringify({ callCount: anthropic.callCount, turn }));

  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.callCount, 1);
  assert.equal(parsed.turn.kind, 'reply_only');
  assert.deepEqual(parsed.turn.replyPlan, { kind: 'generate_reply' });

  await fs.rm(tempDir, { recursive: true, force: true });
});
