import test from 'node:test';
import assert from 'node:assert/strict';

import { getKbSkill, listKbSkills } from '../kb-skills.mjs';

test('inventory app capabilities have matching KB skill coverage', () => {
  const skillIds = new Set(listKbSkills().map((skill) => skill.id));
  const expectedInventorySkills = [
    'grocery.write',
    'grocery.preview',
    'grocery.remove',
    'grocery.check',
    'grocery.uncheck',
    'grocery.clear',
    'pantry.add',
    'pantry.remove',
    'pantry.move_to_grocery',
    'grocery.move_to_pantry',
  ];

  for (const id of expectedInventorySkills) {
    assert.equal(skillIds.has(id), true, `Expected KB skill coverage for ${id}`);
  }
});

test('new grocery inventory skills are first-class KB skills', () => {
  assert.equal(getKbSkill('grocery.remove')?.id, 'grocery.remove');
  assert.equal(getKbSkill('grocery.check')?.id, 'grocery.check');
  assert.equal(getKbSkill('grocery.uncheck')?.id, 'grocery.uncheck');
  assert.equal(getKbSkill('grocery.clear')?.id, 'grocery.clear');
});
