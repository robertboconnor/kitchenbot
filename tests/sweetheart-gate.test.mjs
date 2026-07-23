import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLoopSystemPrompt } from '../kb-agent-loop.mjs';

const memoryContext = { assistantPersona: { assistantName: 'KitchenBot', assistantTone: 'warm' } };
// A marker phrase unique to the sweetheart principle.
const MARKER = 'Elle is your favorite';

test('the sweetheart principle is included when Elle is talking', () => {
  const system = buildLoopSystemPrompt({ memoryContext, name: 'Elle' });
  assert.ok(system.includes(MARKER), 'Elle should get the sweetheart principle');
});

test('the gate is case-insensitive', () => {
  const system = buildLoopSystemPrompt({ memoryContext, name: 'elle' });
  assert.ok(system.includes(MARKER), 'lowercase "elle" should also trigger it');
});

test('the sweetheart principle does NOT leak to other household members', () => {
  for (const name of ['Rob', 'Bizzy', 'Grandma', '', 'Ellery', 'Michelle']) {
    const system = buildLoopSystemPrompt({ memoryContext, name });
    assert.ok(!system.includes(MARKER), `"${name}" must not receive the sweetheart principle`);
  }
});
