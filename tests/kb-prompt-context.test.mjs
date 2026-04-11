import test from 'node:test';
import assert from 'node:assert/strict';

import { buildKbContextSystemText } from '../kb-prompt-context.mjs';

test('shared prompt context text includes the major context sections once', () => {
  const text = buildKbContextSystemText({
    promptText: 'memory rows',
    applicationText: 'applied memory',
    defaultsText: 'defaults',
    appliedDefaultsText: 'applied defaults',
    pantryText: 'pantry',
    appliedPantryText: 'applied pantry',
    groceryText: 'grocery',
    appliedGroceryText: 'applied grocery',
    groceryPantryOverlapText: 'overlap',
    appMapText: 'app map',
    timeContextText: 'time',
    pendingActionText: 'pending clarify action',
    workingContextText: 'working context',
    appliedWorkingContextText: 'applied working context',
    entityContext: { activeSpeakerLabel: 'Rob' },
  });

  assert.match(text, /Relevant saved memory for this turn:/);
  assert.match(text, /Pantry items currently on hand:/);
  assert.match(text, /Current Grocery List tab:/);
  assert.match(text, /Pending action context for this turn:/);
  assert.match(text, /pending clarify action/);
  assert.match(text, /Resolved entities for this turn:/);
  assert.match(text, /active speaker: Rob/);
});
