import test from 'node:test';
import assert from 'node:assert/strict';

import { buildClarifyActionState, normalizeProposedNextAction } from '../kb-next-action.mjs';

test('clarify_action next state normalizes as structured pending action', () => {
  const state = buildClarifyActionState({
    capability: 'pantry.move_to_grocery',
    input: { name: 'evoo' },
    question: 'Which pantry item did you mean?',
    contextSummary: 'Continue the pending pantry move once the user identifies the right item.',
    unresolvedFields: ['name'],
    candidateOptions: [{ id: '1', label: 'evoo - 1 bottle' }],
    visibleReplySummary: 'Which pantry item did you mean?',
  });

  assert.deepEqual(state, {
    active: true,
    type: 'clarify_action',
    action: { capability: 'pantry.move_to_grocery', input: { name: 'evoo' } },
    question: 'Which pantry item did you mean?',
    visibleReplySummary: 'Which pantry item did you mean?',
    contextSummary: 'Continue the pending pantry move once the user identifies the right item.',
    unresolvedFields: ['name'],
    candidateOptions: [{ id: '1', label: 'evoo - 1 bottle' }],
  });
});

test('normalizeProposedNextAction rejects incomplete clarify_action state', () => {
  assert.equal(
    normalizeProposedNextAction({
      active: true,
      type: 'clarify_action',
      action: { capability: '', input: {} },
      unresolvedFields: ['name'],
    }),
    null
  );
});
