import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('meal.refine returns the model-provided revised meal set when a real meal-plan revision is requested', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-meal-refine-model-'));
  const dbPath = path.join(tempDir, 'meal-refine-model.db');

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
    const chatId = await db.createChat(created.householdId, 'Rob', 'Meal refine model');
    await db.addMessage(created.householdId, chatId, 'assistant', 'KitchenBot', 'Current lineup: crispy tofu bowls, lemon cod, and baked ziti.');

    const anthropic = {
      messages: {
        create: async () => ({
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 10, output_tokens: 40 },
          content: [{ type: 'text', text: JSON.stringify({
            status: 'refined',
            topicSummary: 'Weeknight dinner plan after swapping the fish dish.',
            mealIdeas: ['crispy tofu bowls', 'miso-glazed salmon', 'baked ziti'],
            subjectItems: ['miso-glazed salmon'],
            activeConstraints: ['keep the rest of the meals'],
            groceryFocus: ['miso-glazed salmon ingredients'],
            replySummary: 'I swapped the fish dish to miso-glazed salmon.'
          }) }],
        }),
      },
    };

    const outcome = await executeMealRefine(
      { capability: 'meal.refine', input: { request: 'swap the fish one to miso-glazed salmon' } },
      {
        req: { householdId: created.householdId },
        chatId,
        prompt: 'swap the fish one to miso-glazed salmon',
        anthropic,
        memoryContext: null,
        workingContext: {
          topicSummary: 'Weeknight dinner plan',
          mealIdeas: ['crispy tofu bowls', 'lemon cod', 'baked ziti'],
          subjectItems: ['crispy tofu bowls', 'lemon cod', 'baked ziti'],
          groceryFocus: ['crispy tofu bowls', 'lemon cod', 'baked ziti'],
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
  assert.match(outcome.replySummary, /miso-glazed salmon/i);
  assert.deepEqual(outcome.workingContext.mealIdeas, ['crispy tofu bowls', 'miso-glazed salmon', 'baked ziti']);
  assert.deepEqual(outcome.workingContext.subjectItems, ['miso-glazed salmon']);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('meal.refine asks for context instead of pretending to revise when no active meal plan exists', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-meal-refine-needs-context-'));
  const dbPath = path.join(tempDir, 'meal-refine-needs-context.db');

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
    const chatId = await db.createChat(created.householdId, 'Rob', 'Meal refine no context');

    const outcome = await executeMealRefine(
      { capability: 'meal.refine', input: { request: 'swap the fish one to miso-glazed salmon' } },
      {
        req: { householdId: created.householdId },
        chatId,
        prompt: 'swap the fish one to miso-glazed salmon',
        anthropic: null,
        memoryContext: null,
        workingContext: null,
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
  assert.equal(outcome.status, 'needs_context');
  assert.match(outcome.question, /what meals or dinner ideas/i);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('meal.refine can revise a grounded targetMealSet without relying on persisted working context', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-meal-refine-grounded-object-'));
  const dbPath = path.join(tempDir, 'meal-refine-grounded-object.db');

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
    const chatId = await db.createChat(created.householdId, 'Rob', 'Meal refine grounded object');

    const anthropic = {
      messages: {
        create: async () => ({
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 10, output_tokens: 40 },
          content: [{ type: 'text', text: JSON.stringify({
            status: 'refined',
            topicSummary: 'Weeknight dinner plan after the fish swap.',
            mealIdeas: ['lemon pasta', 'cod bowls', 'chicken tortilla soup'],
            subjectItems: ['cod bowls'],
            activeConstraints: ['salmon swapped to cod'],
            groceryFocus: ['lemon pasta', 'cod bowls', 'chicken tortilla soup'],
            replySummary: 'I swapped the salmon dinner to cod bowls.'
          }) }],
        }),
      },
    };

    const outcome = await executeMealRefine(
      {
        capability: 'meal.refine',
        input: {
          request: 'swap the salmon for cod',
          targetMealSet: {
            objectType: 'meal_set',
            versionSummary: 'Weeknight dinner plan',
            mealIdeas: ['lemon pasta', 'salmon bowls', 'chicken tortilla soup'],
            subjectItems: ['lemon pasta', 'salmon bowls', 'chicken tortilla soup'],
            groceryFocus: ['lemon pasta', 'salmon bowls', 'chicken tortilla soup'],
          },
        },
      },
      {
        req: { householdId: created.householdId },
        chatId,
        prompt: 'swap the salmon for cod',
        anthropic,
        memoryContext: null,
        workingContext: null,
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
  assert.deepEqual(outcome.workingContext.mealIdeas, ['lemon pasta', 'cod bowls', 'chicken tortilla soup']);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('meal.refine can decline a fresh cooking-help turn instead of forcing a plan revision', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-meal-refine-fresh-turn-'));
  const dbPath = path.join(tempDir, 'meal-refine-fresh-turn.db');

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
    const chatId = await db.createChat(created.householdId, 'Rob', 'Meal refine fresh turn');
    await db.addMessage(created.householdId, chatId, 'assistant', 'KitchenBot', 'Current lineup: smoky bean soup, grilled fish tacos, and roast chicken.');

    const anthropic = {
      messages: {
        create: async () => ({
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 10, output_tokens: 30 },
          content: [{ type: 'text', text: JSON.stringify({
            status: 'needs_context',
            question: 'That sounds like cooking help for tonight, not a meal-plan revision. What part of the current meal ideas do you want me to change?'
          }) }],
        }),
      },
    };

    const outcome = await executeMealRefine(
      { capability: 'meal.refine', input: { request: 'we are making the tacos tonight. what do i do first?' } },
      {
        req: { householdId: created.householdId },
        chatId,
        prompt: 'we are making the tacos tonight. what do i do first?',
        anthropic,
        memoryContext: null,
        workingContext: {
          topicSummary: 'Weeknight dinner plan',
          mealIdeas: ['smoky bean soup', 'grilled fish tacos', 'roast chicken'],
          subjectItems: ['smoky bean soup', 'grilled fish tacos', 'roast chicken'],
          groceryFocus: ['smoky bean soup', 'grilled fish tacos', 'roast chicken'],
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
  assert.equal(outcome.status, 'needs_context');
  assert.match(outcome.question, /not a meal-plan revision/i);

  await fs.rm(tempDir, { recursive: true, force: true });
});
