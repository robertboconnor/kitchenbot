import test from 'node:test';
import assert from 'node:assert/strict';

import { applyPromptCaching, withConversationCacheBreakpoint } from '../kb-agent-loop.mjs';

// The brain loop re-sends the same system rulebook + tool schema on every iteration and every
// message. applyPromptCaching marks that fixed block ephemeral-cached so reuse bills at ~10%.
// These tests pin the API-ready shape so the cache markers can't silently regress away.

test('applyPromptCaching wraps the system prompt in one cached text block (content unchanged)', () => {
  const { system } = applyPromptCaching('THE RULEBOOK', []);
  assert.equal(system.length, 1);
  assert.equal(system[0].type, 'text');
  assert.equal(system[0].text, 'THE RULEBOOK'); // exact same content the model saw before
  assert.deepEqual(system[0].cache_control, { type: 'ephemeral' });
});

test('applyPromptCaching puts the cache breakpoint on the LAST tool only', () => {
  const input = [
    { name: 'grocery_write', description: 'a', input_schema: { type: 'object' } },
    { name: 'pantry_add', description: 'b', input_schema: { type: 'object' } },
    { name: 'cookbook_save', description: 'c', input_schema: { type: 'object' } },
  ];
  const { tools } = applyPromptCaching('sys', input);

  // Only the final tool carries the marker — caching a prefix caches every tool before it too.
  assert.equal(tools[0].cache_control, undefined);
  assert.equal(tools[1].cache_control, undefined);
  assert.deepEqual(tools[2].cache_control, { type: 'ephemeral' });

  // Original tool fields are preserved untouched.
  assert.equal(tools[2].name, 'cookbook_save');
  assert.equal(tools[2].description, 'c');
  assert.deepEqual(tools[2].input_schema, { type: 'object' });

  // At most two markers total (system + last tool) — well under the API's limit of four.
  const markerCount =
    1 + tools.filter((t) => t.cache_control).length;
  assert.equal(markerCount, 2);
});

test('applyPromptCaching does not mutate the caller’s tool array', () => {
  const input = [{ name: 't', description: 'd', input_schema: {} }];
  applyPromptCaching('sys', input);
  assert.equal(input[0].cache_control, undefined); // caller’s objects left alone
});

test('applyPromptCaching is safe when there are no tools', () => {
  const { system, tools } = applyPromptCaching('sys', []);
  assert.deepEqual(tools, []);
  assert.deepEqual(system[0].cache_control, { type: 'ephemeral' });
});

// --- withConversationCacheBreakpoint: the rotating breakpoint on the growing transcript ---

test('withConversationCacheBreakpoint marks only the last message; earlier turns stay clean', () => {
  const messages = [
    { role: 'user', content: 'plan the week' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 't1', name: 'grocery_list', input: {} },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '[]' }] },
  ];
  const out = withConversationCacheBreakpoint(messages);

  // earlier messages carry no markers
  assert.equal(out[0].content, 'plan the week');
  assert.equal(out[1].content[0].cache_control, undefined);
  assert.equal(out[1].content[1].cache_control, undefined);

  // the last message's final block carries the single breakpoint
  assert.deepEqual(out[2].content[0].cache_control, { type: 'ephemeral' });

  // exactly ONE conversation marker across the request (so total with system+tool stays <= 4)
  const markers = out
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b.cache_control).length;
  assert.equal(markers, 1);
});

test('withConversationCacheBreakpoint converts a string last message into a cached text block', () => {
  const out = withConversationCacheBreakpoint([{ role: 'user', content: 'just chatting' }]);
  assert.deepEqual(out[0].content, [
    { type: 'text', text: 'just chatting', cache_control: { type: 'ephemeral' } },
  ]);
});

test('withConversationCacheBreakpoint marks only the FINAL block (e.g. an attached photo)', () => {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
    },
  ];
  const out = withConversationCacheBreakpoint(messages);
  assert.equal(out[0].content[0].cache_control, undefined); // text block untouched
  assert.deepEqual(out[0].content[1].cache_control, { type: 'ephemeral' }); // image (last) marked
});

test('withConversationCacheBreakpoint does not mutate the caller’s messages', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
  ];
  withConversationCacheBreakpoint(messages);
  assert.equal(messages[1].content[0].cache_control, undefined); // original left clean
  assert.equal(typeof messages[0].content, 'string'); // untouched shape
});

test('withConversationCacheBreakpoint is safe on empty / unmarkable input', () => {
  assert.deepEqual(withConversationCacheBreakpoint([]), []);
  const odd = [{ role: 'user', content: [] }];
  assert.equal(withConversationCacheBreakpoint(odd), odd); // nothing to mark → returned as-is
});
