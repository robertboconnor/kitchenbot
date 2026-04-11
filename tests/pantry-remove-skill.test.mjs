import test from 'node:test';
import assert from 'node:assert/strict';

import { getKbSkill, normalizeKbSkillAction } from '../kb-skills.mjs';

test('pantry.remove is registered as a first-class KB skill', () => {
  const skill = getKbSkill('pantry.remove');
  assert.ok(skill);
  assert.equal(skill.id, 'pantry.remove');
  assert.equal(skill.contextProfile.includePantry, true);
});

test('pantry.remove normalizes a simple item-name input', () => {
  const action = normalizeKbSkillAction(
    { capability: 'pantry.remove', input: { name: 'polenta' } },
    { originalPrompt: 'remove polenta' }
  );

  assert.deepEqual(action, {
    capability: 'pantry.remove',
    input: { name: 'polenta' },
  });
});
