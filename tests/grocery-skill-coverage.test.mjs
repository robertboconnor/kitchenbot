import test from 'node:test';
import assert from 'node:assert/strict';

import { getKbSkill, listKbSkills, normalizeKbSkillAction } from '../kb-skills.mjs';
import { buildKbToolDefinitions, isWriteCapability } from '../kb-tools.mjs';

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

test('grocery.update_item is a first-class KB skill exposed as a write tool', () => {
  assert.equal(getKbSkill('grocery.update_item')?.id, 'grocery.update_item');

  const tool = buildKbToolDefinitions({ webSearchEnabled: false }).find(
    (t) => t.name === 'grocery__update_item'
  );
  assert.ok(tool, 'grocery__update_item is built as an Anthropic tool');
  assert.deepEqual(tool.input_schema.required, ['name']);
  assert.equal(tool.input_schema.properties.amount.type, 'string');
  assert.equal(tool.input_schema.properties.checked.type, 'boolean');

  // It mutates the list, so it must be classified as a write (not a read tool).
  assert.equal(isWriteCapability('grocery.update_item'), true);
});

test('grocery.update_item normalizes name + amount + checked (and aliases)', () => {
  const explicit = normalizeKbSkillAction(
    { capability: 'grocery.update_item', input: { name: 'eggs', quantity: '12', checked: false } },
    {}
  );
  assert.deepEqual(explicit.input, { name: 'eggs', amount: '12', checked: false });

  // "item" aliases name; "bought" aliases checked.
  const aliased = normalizeKbSkillAction(
    { capability: 'grocery.update_item', input: { item: 'milk', amount: '3 cartons', bought: true } },
    {}
  );
  assert.deepEqual(aliased.input, { name: 'milk', amount: '3 cartons', checked: true });

  // Amount-only is valid (change quantity, leave checked state alone).
  const amountOnly = normalizeKbSkillAction(
    { capability: 'grocery.update_item', input: { name: 'flour', amount: '2 bags' } },
    {}
  );
  assert.deepEqual(amountOnly.input, { name: 'flour', amount: '2 bags' });

  // No name → not actionable.
  const noName = normalizeKbSkillAction(
    { capability: 'grocery.update_item', input: { amount: '5' } },
    {}
  );
  assert.equal(noName, null);
});
