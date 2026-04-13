import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decideKbActionIntegrityOverride,
  decideKbNextActionFollowUp,
  decideKbProtectedActionTurn,
  decideKbTurnFallback,
} from '../kb-turn-decider.mjs';

test('next-step choice follow-up executes the chosen action', () => {
  const turn = decideKbNextActionFollowUp('replace current list', {
    active: true,
    type: 'choice',
    action: { capability: 'grocery.write' },
    choices: [
      { id: 'append', label: 'add this to the Grocery List tab', actionInput: { mode: 'append' } },
      { id: 'replace', label: 'replace current list', actionInput: { mode: 'replace' } },
    ],
    question: 'Which do you want?',
  });

  assert.equal(turn.kind, 'execute_action');
  assert.deepEqual(turn.actions, [{ capability: 'grocery.write', input: { mode: 'replace' } }]);
});

test('bare yes executes the default next-step choice when one is provided', () => {
  const turn = decideKbNextActionFollowUp('yes', {
    active: true,
    type: 'choice',
    action: { capability: 'cookbook.save' },
    defaultChoiceId: 'search_now',
    choices: [
      {
        id: 'search_now',
        label: 'search for recipe details now',
        capability: 'web.search',
        actionInput: { query: 'https://www.seriouseats.com/all-american-beef-stew-recipe' },
      },
      {
        id: 'retry_fetch',
        label: 'retry the exact linked recipe fetch',
        capability: 'cookbook.save',
        actionInput: { request: 'save this linked recipe https://www.seriouseats.com/all-american-beef-stew-recipe' },
      },
    ],
    question: 'I can search now or retry the exact linked fetch.',
  });

  assert.equal(turn.kind, 'execute_action');
  assert.deepEqual(turn.actions, [
    {
      capability: 'web.search',
      input: { query: 'https://www.seriouseats.com/all-american-beef-stew-recipe' },
    },
  ]);
});

test('fallback decider only covers narrow durable-memory and defaults cases', () => {
  const defaultsTurn = decideKbTurnFallback({
    prompt: 'we cook 4 portions for dinner',
    memoriesByKey: new Map(),
    activeSpeakerName: 'Rob',
  });
  const memoryTurn = decideKbTurnFallback({
    prompt: "remember I don't like beets",
    memoriesByKey: new Map(),
    activeSpeakerName: 'Rob',
  });

  assert.equal(defaultsTurn.kind, 'execute_action');
  assert.equal(defaultsTurn.actions[0].capability, 'household.defaults.update');
  assert.equal(memoryTurn.kind, 'execute_action');
  assert.equal(memoryTurn.actions[0].capability, 'memory.save');
});

test('fallback decider does not invent pantry removal as a deterministic fallback skill', () => {
  const turn = decideKbTurnFallback({
    prompt: 'remove polenta',
    memoriesByKey: new Map(),
    activeSpeakerName: 'Rob',
  });
  assert.equal(turn.kind, 'reply_only');
});

test('fallback decider does not act as a second cookbook brain for ordinary cookbook listing', () => {
  const turn = decideKbTurnFallback({
    prompt: 'what do we have in our cookbook?',
    memoriesByKey: new Map(),
    activeSpeakerName: 'Rob',
  });
  assert.equal(turn.kind, 'reply_only');
});

test('fallback decider catches explicit cookbook saves with a linked recipe URL', () => {
  const turn = decideKbTurnFallback({
    prompt: 'save this recipe as our favorite beef stew: https://www.seriouseats.com/all-american-beef-stew-recipe',
    memoriesByKey: new Map(),
    activeSpeakerName: 'Rob',
  });
  assert.equal(turn.kind, 'execute_action');
  assert.equal(turn.actions[0].capability, 'cookbook.save');
  assert.match(turn.actions[0].input.request, /seriouseats\.com/);
});

test('integrity override forces explicit linked recipe saves out of reply_only', () => {
  const turn = decideKbActionIntegrityOverride(
    'save this recipe as our favorite beef stew: https://www.seriouseats.com/all-american-beef-stew-recipe',
    { kind: 'reply_only', replyText: 'I saved All-American Beef Stew to your cookbook.' }
  );
  assert.equal(turn.kind, 'execute_action');
  assert.equal(turn.actions[0].capability, 'cookbook.save');
});

test('integrity override does not replace an existing cookbook.save action', () => {
  const turn = decideKbActionIntegrityOverride(
    'save this recipe as our favorite beef stew: https://www.seriouseats.com/all-american-beef-stew-recipe',
    { kind: 'execute_action', actions: [{ capability: 'cookbook.save', input: { request: 'save this recipe' } }] }
  );
  assert.equal(turn, null);
});

test('protected action turn pre-routes explicit linked recipe saves', () => {
  const turn = decideKbProtectedActionTurn(
    'save this recipe as our favorite beef stew: https://www.seriouseats.com/all-american-beef-stew-recipe'
  );

  assert.equal(turn.kind, 'execute_action');
  assert.equal(turn.actions[0].capability, 'cookbook.save');
  assert.equal(turn.decisionSource, 'pre_router');
});
