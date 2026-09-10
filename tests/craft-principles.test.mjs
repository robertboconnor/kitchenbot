// The cooking-craft block in the system prompt.
//
// These are free structural guards — whether the guidance actually WORKS is measured by
// `npm run eval:craft`, which costs money and lives outside the test suite. What is pinned here is
// the stuff that would silently rot: the block existing at all, sitting before the tool mechanics,
// not being duplicated, and not quietly tripling in size (every token here is in the cached system
// block, on every request, for every household).
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLoopSystemPrompt } from '../kb-agent-loop.mjs';

const memoryContext = { assistantPersona: { assistantName: 'KitchenBot', assistantTone: 'helpful' } };
const build = (over = {}) => buildLoopSystemPrompt({ memoryContext, name: 'Rob', ...over });

test('the craft block is present and teaches the four things it is for', () => {
  const system = build();
  // 1. cook, not recipe printer
  assert.match(system, /cook, not a recipe printer/i);
  // 2. constraints change the METHOD
  assert.match(system, /changes the METHOD, not just the schedule/i);
  // 3. doneness by sensory state
  assert.match(system, /doneness as a state they can see, hear, smell or feel/i);
  // 4. the brake
  assert.match(system, /Explain WHY only where the why changes what they DO/i);
  assert.match(system, /do not append general advice detached from the steps/i);
  // 5. do not re-pitch their dish
  assert.match(system, /they have already decided what they are cooking/i);
});

test('the craft block names the acid case specifically', () => {
  // The succotash failure was not "did not know chemistry", it was "did not apply it". The worked
  // example is what makes the abstract rule land, so it must survive edits to this block.
  const system = build();
  assert.match(system, /acid dulling and greying vegetables and beans/i);
  assert.match(system, /hold the vinegar until you are back/i);
});

test('the craft block says when waiting HELPS, not only when it hurts', () => {
  // Without this, "reason like a cook" over-corrects into refusing make-ahead dishes that are
  // better for the rest. evals/scenarios.mjs has three scenarios guarding the same thing.
  const system = build();
  assert.match(system, /when the gap HELPS/i);
  assert.match(system, /a braise, a stew, a brine, a cure, a quick pickle, a marinade/i);
});

test('the craft block sits before the tool mechanics', () => {
  // Order is meaning: the craft block is the JOB, everything after it is the machinery.
  const system = build();
  const craftAt = system.indexOf('cook, not a recipe printer');
  const toolsAt = system.indexOf('Your TOOLS are how you DO things');
  assert.ok(craftAt > 0 && toolsAt > 0, 'both blocks should be present');
  assert.ok(craftAt < toolsAt, 'craft guidance must come before tool mechanics');
});

test('the craft block appears exactly once', () => {
  const system = build();
  const hits = system.match(/cook, not a recipe printer/gi) || [];
  assert.equal(hits.length, 1);
});

test('the craft block stays within its token budget', () => {
  // Every character here is in the cached system block on every request. The block is ~2,600 chars
  // (~600 tokens); this ceiling catches it quietly tripling, not ordinary editing.
  const system = build();
  const start = system.indexOf('You are a cook, not a recipe printer');
  const end = system.indexOf('When they have already decided what they are cooking');
  assert.ok(start > 0 && end > start, 'craft block boundaries should be findable');
  const block = system.slice(start, end);
  assert.ok(block.length < 4000, `craft block is ${block.length} chars — over budget, trim it`);
});

test('the prompt is byte-identical for identical inputs (the cache key depends on it)', () => {
  // The whole system text is ONE cache_control block. Any per-turn variation in it would fork the
  // cache on every request and quietly multiply the token bill.
  assert.equal(build(), build());
  assert.notEqual(build(), build({ name: 'Elle' }), 'speaker is a known, intentional cache fork');
});
