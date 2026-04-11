import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPromptContextProfile,
  profileNeedsRefresh,
} from '../kb-context-policy.mjs';

test('light cooking advice stays on minimal context', () => {
  const profile = buildPromptContextProfile({
    prompt: 'what is the best oven setting for crispy chicken thighs?',
    runtimeProposedNextAction: null,
    workingContext: null,
  });
  assert.deepEqual(profile, {
    includeDefaults: false,
    includePantry: false,
    includeGrocery: false,
    includeWorkingContext: false,
  });
});

test('grocery generation pulls richer context families', () => {
  const profile = buildPromptContextProfile({
    prompt: 'give me a grocery list for this meal plan',
    runtimeProposedNextAction: null,
    workingContext: { topicSummary: 'Dinner plan', mealIdeas: ['meatloaf'] },
  });
  assert.equal(profile.includeDefaults, true);
  assert.equal(profile.includePantry, true);
  assert.equal(profile.includeGrocery, true);
  assert.equal(profile.includeWorkingContext, true);
});

test('meal planning pulls household defaults even without grocery wording', () => {
  const profile = buildPromptContextProfile({
    prompt: 'help me plan 3 dinners for this week',
    runtimeProposedNextAction: null,
    workingContext: null,
  });
  assert.equal(profile.includeDefaults, true);
});

test('asking about cooking style pulls household defaults', () => {
  const profile = buildPromptContextProfile({
    prompt: 'what do you know about my cooking style?',
    runtimeProposedNextAction: null,
    workingContext: null,
  });
  assert.equal(profile.includeDefaults, true);
});

test('profileNeedsRefresh only escalates when new families are required', () => {
  assert.equal(
    profileNeedsRefresh(
      { includeDefaults: false, includePantry: false, includeGrocery: false, includeWorkingContext: false },
      { includeDefaults: true, includePantry: false, includeGrocery: false, includeWorkingContext: false }
    ),
    true
  );
  assert.equal(
    profileNeedsRefresh(
      { includeDefaults: true, includePantry: true, includeGrocery: false, includeWorkingContext: true },
      { includeDefaults: true, includePantry: true, includeGrocery: false, includeWorkingContext: true }
    ),
    false
  );
});
