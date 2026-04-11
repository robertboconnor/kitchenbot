import test from 'node:test';
import assert from 'node:assert/strict';

import { decideKbNextActionFollowUp, decideKbTurnFallback } from '../kb-turn-decider.mjs';

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
