import test from 'node:test';
import assert from 'node:assert/strict';

import { buildClarifyActionState } from '../kb-next-action.mjs';
import { interpretKbSkillFollowUp, normalizeKbSkillAction } from '../kb-skills.mjs';
import { rewriteUngroundedActionOfferReply, shouldForceDeterministicOutcomeReply } from '../kb-reply.mjs';

test('web.search action normalization reuses offered search topic for referential search acceptance', () => {
  const action = normalizeKbSkillAction(
    { capability: 'web.search', input: {} },
    {
      webSearchEnabled: true,
      originalPrompt: 'sure search the web',
      workingContext: {
        offeredSearchTopic: 'classic Transfusion cocktail recipe with grape juice and ginger ale',
      },
      memoryContext: {
        workingContext: {
          offeredSearchTopic: 'classic Transfusion cocktail recipe with grape juice and ginger ale',
        },
      },
    }
  );

  assert.deepEqual(action, {
    capability: 'web.search',
    input: { query: 'classic Transfusion cocktail recipe with grape juice and ginger ale' },
  });
});

test('web.search skill follow-up executes stored search query on just-that confirmation', () => {
  const nextAction = buildClarifyActionState({
    capability: 'web.search',
    input: { query: 'classic Transfusion cocktail recipe with grape juice and ginger ale' },
    question: 'If you want, I can search for the classic version.',
    contextSummary: 'Continue the pending web search.',
  });

  const turn = interpretKbSkillFollowUp('just that', nextAction, {
    memoryContext: { capabilities: { webSearchEnabled: true } },
  });

  assert.deepEqual(turn, {
    kind: 'execute_action',
    actions: [{ capability: 'web.search', input: { query: 'classic Transfusion cocktail recipe with grape juice and ginger ale' } }],
    routePrompt: 'just that',
  });
});

test('grocery.write skill follow-up carries offered ingredients through all', () => {
  const nextAction = buildClarifyActionState({
    capability: 'grocery.write',
    input: {
      source: 'offered_items',
      items: [
        { name: 'vodka', amount: '', section: '' },
        { name: 'Concord grape juice', amount: '', section: '' },
        { name: 'fresh limes', amount: '', section: '' },
        { name: 'ginger ale', amount: '', section: '' },
      ],
    },
    question: 'If you want, I can add those ingredients to the Grocery List tab.',
    contextSummary: 'Continue the pending grocery add for the offered ingredients.',
  });

  const turn = interpretKbSkillFollowUp('all', nextAction, {});

  assert.deepEqual(turn, {
    kind: 'execute_action',
    actions: [{
      capability: 'grocery.write',
      input: {
        source: 'offered_items',
        items: [
          { name: 'vodka', amount: '', section: '' },
          { name: 'Concord grape juice', amount: '', section: '' },
          { name: 'fresh limes', amount: '', section: '' },
          { name: 'ginger ale', amount: '', section: '' },
        ],
      },
    }],
    routePrompt: 'all',
  });
});

test('fragile outcomes force deterministic fallback narration', () => {
  assert.equal(
    shouldForceDeterministicOutcomeReply([{ capability: 'web.search', status: 'unavailable' }]),
    true
  );
  assert.equal(
    shouldForceDeterministicOutcomeReply([{ capability: 'grocery.write', status: 'already_present' }]),
    true
  );
  assert.equal(
    shouldForceDeterministicOutcomeReply([{ capability: 'grocery.write', status: 'committed' }]),
    false
  );
});

test('reply guard rewrites bare yes invitations when no next action exists', () => {
  const rewritten = rewriteUngroundedActionOfferReply(
    "Say yes and I'll search for the classic Transfusion cocktail recipe with grape juice and ginger ale."
  );

  assert.doesNotMatch(rewritten, /\bsay yes\b/i);
  assert.match(rewritten, /if you want that, ask me to/i);
});
