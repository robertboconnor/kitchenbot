import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  buildPromptContextProfile,
  profileNeedsRefresh,
} from '../kb-context-policy.mjs';
import { isMealGroceryRelevantTurn } from '../kb-working-context.mjs';

const execFileAsync = promisify(execFile);

test('light cooking advice stays on minimal context', () => {
  const profile = buildPromptContextProfile({
    provisionalGrounding: {
      surface: 'conversation',
      intent: 'answer_question',
      candidateObjectTypes: [],
    },
    runtimeProposedNextAction: null,
    workingContext: null,
  });
  assert.deepEqual(profile, {
    includeDefaults: false,
    includePantry: false,
    includeGrocery: false,
    includeCookbook: false,
    includeWorkingContext: false,
  });
});

test('grocery generation pulls richer context families', () => {
  const profile = buildPromptContextProfile({
    provisionalGrounding: {
      surface: 'grocery',
      intent: 'add_grocery_items',
      candidateObjectTypes: ['meal_plan_or_meal_set', 'offered_ingredients'],
    },
    runtimeProposedNextAction: null,
    workingContext: { topicSummary: 'Dinner plan', mealIdeas: ['meatloaf'] },
  });
  assert.equal(profile.includeDefaults, true);
  assert.equal(profile.includePantry, true);
  assert.equal(profile.includeGrocery, true);
  assert.equal(profile.includeCookbook, false);
  assert.equal(profile.includeWorkingContext, true);
});

test('meal planning pulls household defaults even without grocery wording', () => {
  const profile = buildPromptContextProfile({
    provisionalGrounding: {
      surface: 'meal_plan',
      intent: 'revise_meal_plan',
      candidateObjectTypes: ['meal_plan_or_meal_set'],
    },
    runtimeProposedNextAction: null,
    workingContext: null,
  });
  assert.equal(profile.includeDefaults, true);
  assert.equal(profile.includeCookbook, false);
});

test('explicit saved-recipe meal planning still pulls cookbook context', () => {
  const profile = buildPromptContextProfile({
    provisionalGrounding: {
      surface: 'meal_plan',
      intent: 'create_meal_plan_from_saved_recipes',
      candidateObjectTypes: ['meal_plan_or_meal_set'],
    },
    runtimeProposedNextAction: null,
    workingContext: null,
  });
  assert.equal(profile.includeDefaults, true);
  assert.equal(profile.includeCookbook, true);
});

test('asking about cooking style pulls household defaults', () => {
  const profile = buildPromptContextProfile({
    groundedTurn: {
      turnMode: 'reply_only',
      surface: 'conversation',
      intent: 'answer_question',
      rationale: 'defaults_question',
    },
    runtimeProposedNextAction: null,
    workingContext: null,
  });
  assert.equal(profile.includeDefaults, true);
  assert.equal(profile.includeCookbook, false);
});

test('profileNeedsRefresh only escalates when new families are required', () => {
  assert.equal(
    profileNeedsRefresh(
      { includeDefaults: false, includePantry: false, includeGrocery: false, includeCookbook: false, includeWorkingContext: false },
      { includeDefaults: true, includePantry: false, includeGrocery: false, includeCookbook: false, includeWorkingContext: false }
    ),
    true
  );
  assert.equal(
    profileNeedsRefresh(
      { includeDefaults: true, includePantry: true, includeGrocery: false, includeCookbook: true, includeWorkingContext: true },
      { includeDefaults: true, includePantry: true, includeGrocery: false, includeCookbook: true, includeWorkingContext: true }
    ),
    false
  );
});

test('direct cookbook prompts pull cookbook context without unrelated inventory', () => {
  const profile = buildPromptContextProfile({
    provisionalGrounding: {
      surface: 'cookbook',
      intent: 'list_saved_recipes',
      candidateObjectTypes: ['cookbook_entry'],
    },
    runtimeProposedNextAction: null,
    workingContext: null,
  });
  assert.equal(profile.includeCookbook, true);
  assert.equal(profile.includePantry, false);
  assert.equal(profile.includeGrocery, false);
});

test('linked recipe provenance follow-ups pull cookbook context', () => {
  const profile = buildPromptContextProfile({
    provisionalGrounding: {
      surface: 'conversation',
      intent: 'answer_question',
      candidateObjectTypes: ['linked_recipe'],
    },
    runtimeProposedNextAction: null,
    workingContext: null,
  });
  assert.equal(profile.includeCookbook, true);
  assert.equal(profile.includePantry, false);
  assert.equal(profile.includeGrocery, false);
});

test('chat-only recipe revision does not pull cookbook context', () => {
  const profile = buildPromptContextProfile({
    provisionalGrounding: {
      surface: 'conversation',
      intent: 'revise_recipe',
      candidateObjectTypes: ['chat_recipe'],
    },
    runtimeProposedNextAction: null,
    workingContext: null,
  });
  assert.equal(profile.includeCookbook, false);
});

test('grocery turns do not inherit cookbook context just because a chat recipe is visible', () => {
  const profile = buildPromptContextProfile({
    groundedTurn: {
      turnMode: 'execute_action',
      surface: 'grocery',
      intent: 'add_grocery_items',
      activeObjects: [{ type: 'chat_recipe', label: 'Quick Cucumber Yogurt Salad' }],
    },
    runtimeProposedNextAction: null,
    workingContext: null,
  });
  assert.equal(profile.includeCookbook, false);
  assert.equal(profile.includeGrocery, true);
});

test('recipe follow-ups pull working context when a meal thread is already active', () => {
  const profile = buildPromptContextProfile({
    provisionalGrounding: {
      surface: 'conversation',
      intent: 'answer_question',
      candidateObjectTypes: ['meal_plan_or_meal_set'],
    },
    runtimeProposedNextAction: null,
    workingContext: {
      topicSummary: 'Three dinner ideas for the week',
      mealIdeas: ['Bacon-Wrapped Pork Tenderloin', 'Waffle Iron Grilled Cheese Burger', 'Chicken Liver Pate'],
      subjectItems: ['Waffle Iron Grilled Cheese Burger', 'waffle iron recipe'],
    },
  });
  assert.equal(profile.includeWorkingContext, true);
});

test('meal/grocery relevance stays generic and uses existing thread continuity', () => {
  const relevant = isMealGroceryRelevantTurn({
    prompt: 'show me how to make the one we just picked',
    workingContext: {
      topicSummary: 'Planning dinner',
      mealIdeas: ['Crispy tofu rice bowl', 'Braised short ribs'],
      subjectItems: ['Crispy tofu rice bowl'],
    },
  });
  assert.equal(relevant, true);
});

test('working context clears instead of reconstructing stale meal threads when the background model drops continuity', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-working-context-clear-'));
  const dbPath = path.join(tempDir, 'kb-working-context-clear.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { refreshKbWorkingContext } = await import(new URL('./kb-working-context.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Working context clear');
    await db.addMessage(created.householdId, chatId, 'user', 'Rob', 'help me figure out three dinners this week: something smoky, something crispy in bread, and something cozy with noodles');
    await db.addMessage(
      created.householdId,
      chatId,
      'assistant',
      'KitchenBot',
      '**Smoky:** Smoked brisket burnt ends with charred corn and brioche rolls\\n**Crispy in bread:** Crispy chicken sandwich with hot honey\\n**Cozy with noodles:** Cheesy baked ziti with basil'
    );

    const anthropic = {
      messages: {
        create: async () => ({
          model: 'claude-haiku-4-5',
          usage: { input_tokens: 10, output_tokens: 10 },
          content: [{ type: 'text', text: JSON.stringify({ keep: false }) }],
        }),
      },
    };

    const workingContext = await refreshKbWorkingContext({
      anthropic,
      req: { householdId: created.householdId, kbTurnId: 'turn-fallback' },
      chatId,
      routePrompt: 'help me figure out three dinners this week: something smoky, something crispy in bread, and something cozy with noodles',
      currentWorkingContext: null,
      memoryContext: null,
      outcomes: [],
      deps: { stripStoredMessageContentForDisplay: (text) => text },
    });

    process.stdout.write(JSON.stringify(workingContext));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });

  const workingContext = JSON.parse(stdout.trim());
  assert.equal(workingContext, null);

  await fs.rm(tempDir, { recursive: true, force: true });
});
