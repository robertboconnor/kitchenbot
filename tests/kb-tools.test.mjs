import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildKbToolDefinitions,
  capabilityToToolName,
  toolNameToCapability,
  isWriteCapability,
  executeKbToolCall,
} from '../kb-tools.mjs';

test('capability <-> tool-name mapping round-trips and encodes dots as __', () => {
  assert.equal(capabilityToToolName('grocery.write'), 'grocery__write');
  assert.equal(toolNameToCapability('grocery__write'), 'grocery.write');
  // single underscores inside a capability must survive the round-trip
  assert.equal(capabilityToToolName('pantry.move_to_grocery'), 'pantry__move_to_grocery');
  assert.equal(toolNameToCapability('pantry__move_to_grocery'), 'pantry.move_to_grocery');
  assert.equal(toolNameToCapability('household__defaults__get'), 'household.defaults.get');
});

test('buildKbToolDefinitions exposes every skill as a valid Anthropic tool', () => {
  const tools = buildKbToolDefinitions({ webSearchEnabled: true });
  assert.ok(tools.length >= 20, 'expected the full skill set as tools');
  for (const t of tools) {
    assert.match(t.name, /^[a-zA-Z0-9_-]{1,64}$/, `tool name ${t.name} must satisfy Anthropic naming`);
    assert.equal(typeof t.description, 'string');
    assert.ok(t.description.length > 0, `tool ${t.name} needs a description`);
    assert.equal(t.input_schema?.type, 'object');
    assert.ok(toolNameToCapability(t.name), `every tool maps back to a capability: ${t.name}`);
  }
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('grocery__list'), 'read-tool grocery.list is exposed');
  assert.ok(names.includes('pantry__list'), 'read-tool pantry.list is exposed');
});

test('web.search is gated by webSearchEnabled', () => {
  const off = buildKbToolDefinitions({ webSearchEnabled: false }).map((t) => t.name);
  const on = buildKbToolDefinitions({ webSearchEnabled: true }).map((t) => t.name);
  assert.ok(!off.includes('web__search'), 'web.search hidden when disabled');
  assert.ok(on.includes('web__search'), 'web.search exposed when enabled');
});

test('isWriteCapability separates reads from writes', () => {
  assert.equal(isWriteCapability('grocery.write'), true);
  assert.equal(isWriteCapability('pantry.add'), true);
  assert.equal(isWriteCapability('memory.save'), true);
  assert.equal(isWriteCapability('grocery.list'), false);
  assert.equal(isWriteCapability('pantry.list'), false);
  assert.equal(isWriteCapability('cookbook.list'), false);
  assert.equal(isWriteCapability('web.search'), false);
});

test('executeKbToolCall returns a clean error result for an unknown tool', async () => {
  const result = await executeKbToolCall('not__a__tool', {}, {});
  assert.equal(result.ok, false);
  assert.match(result.resultText, /Unknown tool/i);
});
