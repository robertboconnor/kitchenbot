import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('meal.refine treats a concrete dish selection as refined even if the model asks optional follow-up questions', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-meal-refine-selection-'));
  const dbPath = path.join(tempDir, 'meal-refine-selection.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { executeMealRefine } = await import(new URL('./meal-refine-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Meal refine selection');
    await db.addMessage(created.householdId, chatId, 'assistant', 'KitchenBot', 'Let me know what makes the absurd sandwich absurd.');

    const anthropic = {
      messages: {
        create: async () => ({
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 10, output_tokens: 40 },
          content: [{ type: 'text', text: JSON.stringify({
            status: 'needs_context',
            question: 'What meats, cheeses, condiments, and bread do you want in the loaded Italian sub?'
          }) }],
        }),
      },
    };

    const outcome = await executeMealRefine(
      { capability: 'meal.refine', input: { request: 'make the absurd sandwich the loaded Italian sub' } },
      {
        req: { householdId: created.householdId },
        chatId,
        prompt: 'make the absurd sandwich the loaded Italian sub',
        anthropic,
        memoryContext: null,
        workingContext: {
          topicSummary: 'Planning 3 meals for the week',
          mealIdeas: ['lemony fish', 'absurd sandwich', 'mushroom pasta'],
          subjectItems: ['lemony fish', 'absurd sandwich', 'mushroom pasta'],
          groceryFocus: ['lemony fish', 'absurd sandwich', 'mushroom pasta'],
        },
        deps: { stripStoredMessageContentForDisplay: (text) => text },
      }
    );

    process.stdout.write(JSON.stringify(outcome));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });

  const outcome = JSON.parse(stdout.trim());
  assert.equal(outcome.status, 'refined');
  assert.match(outcome.replySummary, /loaded italian sub/i);
  assert.equal(outcome.workingContext.subjectItems[0], 'loaded Italian sub');
  assert.equal(outcome.workingContext.mealIdeas[0], 'loaded Italian sub');

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('meal.refine still honors the raw user prompt when the interpreter paraphrases the refine request', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-meal-refine-prompt-'));
  const dbPath = path.join(tempDir, 'meal-refine-prompt.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { executeMealRefine } = await import(new URL('./meal-refine-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Meal refine prompt');
    await db.addMessage(created.householdId, chatId, 'assistant', 'KitchenBot', 'Tell me how you want to change the absurd sandwich.');

    const anthropic = {
      messages: {
        create: async () => ({
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 10, output_tokens: 40 },
          content: [{ type: 'text', text: JSON.stringify({
            status: 'needs_context',
            question: 'Do you want me to turn the absurd sandwich into a loaded Italian sub, or did you mean something else?'
          }) }],
        }),
      },
    };

    const outcome = await executeMealRefine(
      { capability: 'meal.refine', input: { request: 'revise the current meal plan based on the user\\'s latest sandwich change' } },
      {
        req: { householdId: created.householdId },
        chatId,
        prompt: 'make the absurd sandwich the loaded Italian sub',
        anthropic,
        memoryContext: null,
        workingContext: {
          topicSummary: 'Planning 3 meals for the week',
          mealIdeas: ['lemony fish', 'absurd sandwich', 'mushroom pasta'],
          subjectItems: ['lemony fish', 'absurd sandwich', 'mushroom pasta'],
          groceryFocus: ['lemony fish', 'absurd sandwich', 'mushroom pasta'],
        },
        deps: { stripStoredMessageContentForDisplay: (text) => text },
      }
    );

    process.stdout.write(JSON.stringify(outcome));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });

  const outcome = JSON.parse(stdout.trim());
  assert.equal(outcome.status, 'refined');
  assert.match(outcome.replySummary, /loaded italian sub/i);
  assert.equal(outcome.workingContext.subjectItems[0], 'loaded Italian sub');

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('meal.refine resolves slot-alias selections from the recent meal-planning conversation', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-meal-refine-slot-alias-'));
  const dbPath = path.join(tempDir, 'meal-refine-slot-alias.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { executeMealRefine } = await import(new URL('./meal-refine-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Meal refine slot alias');
    await db.addMessage(
      created.householdId,
      chatId,
      'assistant',
      'KitchenBot',
      '**Smoky:** Charred pork chops with blistered scallions\\n**Crispy in bread:** Crispy chicken sandwich with dill mayo\\n**Cozy with noodles:** Baked ziti with mozzarella'
    );

    const anthropic = {
      messages: {
        create: async () => ({
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 10, output_tokens: 40 },
          content: [{ type: 'text', text: JSON.stringify({
            status: 'needs_context',
            question: 'Do you want me to change only the middle one, or rethink all three meals?'
          }) }],
        }),
      },
    };

    const outcome = await executeMealRefine(
      { capability: 'meal.refine', input: { request: 'make the bread one a schnitzel sandwich' } },
      {
        req: { householdId: created.householdId },
        chatId,
        prompt: 'make the bread one a schnitzel sandwich',
        anthropic,
        memoryContext: null,
        workingContext: {
          topicSummary: 'Planning 3 dinners for the week',
          mealIdeas: ['Charred pork chops', 'Crispy chicken sandwich', 'Baked ziti'],
          subjectItems: ['Charred pork chops', 'Crispy chicken sandwich', 'Baked ziti'],
          groceryFocus: ['Charred pork chops', 'Crispy chicken sandwich', 'Baked ziti'],
        },
        deps: { stripStoredMessageContentForDisplay: (text) => text },
      }
    );

    process.stdout.write(JSON.stringify(outcome));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });

  const outcome = JSON.parse(stdout.trim());
  assert.equal(outcome.status, 'refined');
  assert.match(outcome.replySummary, /schnitzel sandwich/i);
  assert.equal(outcome.workingContext.subjectItems[0], 'schnitzel sandwich');
  assert.equal(outcome.workingContext.mealIdeas[0], 'schnitzel sandwich');
  assert.ok(outcome.workingContext.mealIdeas.includes('Charred pork chops'));
  assert.ok(outcome.workingContext.mealIdeas.includes('Baked ziti'));

  await fs.rm(tempDir, { recursive: true, force: true });
});
