import test from 'node:test';
import assert from 'node:assert/strict';

import { buildClarifyActionState } from '../kb-next-action.mjs';
import { resolveClarifyProposedNextAction } from '../kb-runtime.mjs';

test('clarify turn keeps existing pending clarify action when the model does not replace it', () => {
  const existing = buildClarifyActionState({
    capability: 'pantry.move_to_grocery',
    input: { name: 'olive oil' },
    question: 'Which pantry item did you mean?',
    contextSummary: 'Continue the pending pantry move action.',
    unresolvedFields: ['name'],
    candidateOptions: [{ id: '1', label: 'olive oil - 1 bottle' }],
    visibleReplySummary: 'Which pantry item did you mean?',
  });

  const resolved = resolveClarifyProposedNextAction({ kind: 'clarify', question: 'Can you be more specific?' }, existing);
  assert.deepEqual(resolved, existing);
});

test('clarify turn prefers a newly returned clarify action when present', () => {
  const existing = buildClarifyActionState({
    capability: 'pantry.move_to_grocery',
    input: { name: 'olive oil' },
    question: 'Which pantry item did you mean?',
    contextSummary: 'Continue the pending pantry move action.',
    unresolvedFields: ['name'],
    candidateOptions: [{ id: '1', label: 'olive oil - 1 bottle' }],
    visibleReplySummary: 'Which pantry item did you mean?',
  });
  const replacement = buildClarifyActionState({
    capability: 'grocery.remove',
    input: { name: 'apples' },
    question: 'Which apples entry did you mean?',
    contextSummary: 'Continue the pending grocery remove action.',
    unresolvedFields: ['name'],
    candidateOptions: [{ id: '2', label: 'apples - 3' }],
    visibleReplySummary: 'Which apples entry did you mean?',
  });

  const resolved = resolveClarifyProposedNextAction(
    { kind: 'clarify', question: 'Which apples entry?', proposedNextAction: replacement },
    existing
  );
  assert.deepEqual(resolved, replacement);
});
