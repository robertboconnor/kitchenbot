import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { decideKbNextActionFollowUp } from '../kb-turn-decider.mjs';

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

test('turn decider stays a bounded follow-up helper instead of a second turn-understanding brain', async () => {
  const source = await fs.readFile(
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '../kb-turn-decider.mjs'),
    'utf8'
  );

  assert.doesNotMatch(source, /decideKbTurnFallback/);
  assert.doesNotMatch(source, /decideKbProtectedActionTurn/);
  assert.doesNotMatch(source, /decideKbActionIntegrityOverride/);
});
