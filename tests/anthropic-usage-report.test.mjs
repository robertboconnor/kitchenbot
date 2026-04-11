import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnthropicUsageReport,
  classifyAnthropicUsageFunction,
} from '../anthropic-usage.mjs';

function makeRow(overrides = {}) {
  return {
    household_id: 1,
    call_purpose: 'chat_reply',
    model: 'claude-sonnet-4-5',
    input_tokens: 1000,
    output_tokens: 200,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    web_search_enabled_at_call: 0,
    used_web_search_tool: 0,
    ...overrides,
  };
}

test('classifyAnthropicUsageFunction groups raw purposes into human-readable functions', () => {
  assert.equal(classifyAnthropicUsageFunction('chat_reply'), 'Conversation replies');
  assert.equal(classifyAnthropicUsageFunction('kb_turn_interpretation_primary'), 'Turn interpretation');
  assert.equal(classifyAnthropicUsageFunction('kb_turn_interpretation_fallback'), 'Turn interpretation');
  assert.equal(classifyAnthropicUsageFunction('kb_working_context'), 'Context loading');
  assert.equal(classifyAnthropicUsageFunction('meal_refine'), 'Meal planning / refinement');
  assert.equal(classifyAnthropicUsageFunction('grocery_draft_generation_fallback'), 'Grocery drafting');
  assert.equal(classifyAnthropicUsageFunction('inventory_section_classification'), 'Inventory classification');
  assert.equal(classifyAnthropicUsageFunction('web_search'), 'Web search');
  assert.equal(classifyAnthropicUsageFunction('chat_title'), 'Chat titles');
  assert.equal(classifyAnthropicUsageFunction('something_new'), 'Other');
});

test('buildAnthropicUsageReport rolls visible chat work into meaningful function families', () => {
  const rows = [
    makeRow({ call_purpose: 'chat_reply', input_tokens: 1400, output_tokens: 250 }),
    makeRow({ call_purpose: 'kb_turn_interpretation_primary', input_tokens: 2200, output_tokens: 300 }),
    makeRow({ call_purpose: 'kb_turn_interpretation_fallback', input_tokens: 800, output_tokens: 90 }),
    makeRow({ call_purpose: 'kb_working_context', input_tokens: 1000, output_tokens: 160 }),
    makeRow({
      call_purpose: 'web_search',
      input_tokens: 75,
      output_tokens: 120,
      web_search_enabled_at_call: 1,
      used_web_search_tool: 1,
    }),
    makeRow({ call_purpose: 'chat_title', input_tokens: 180, output_tokens: 12 }),
    makeRow({ call_purpose: 'mystery_call', input_tokens: 50, output_tokens: 5 }),
  ];

  const report = buildAnthropicUsageReport(rows);
  const byFunction = Object.fromEntries(report.byFunction.map((entry) => [entry.key, entry]));
  const byPurpose = Object.fromEntries(report.byPurpose.map((entry) => [entry.key, entry]));
  const byWebSearchUsage = Object.fromEntries(
    report.byWebSearchUsage.map((entry) => [entry.key, entry])
  );

  assert.equal(report.totals.callCount, rows.length);
  assert.equal(byFunction['Conversation replies'].callCount, 1);
  assert.equal(byFunction['Turn interpretation'].callCount, 2);
  assert.equal(byFunction['Context loading'].callCount, 1);
  assert.equal(byFunction['Web search'].callCount, 1);
  assert.equal(byFunction['Chat titles'].callCount, 1);
  assert.equal(byFunction.Other.callCount, 1);

  assert.equal(byPurpose.chat_reply.callCount, 1);
  assert.equal(byPurpose.kb_turn_interpretation_primary.callCount, 1);
  assert.equal(byPurpose.kb_working_context.callCount, 1);

  assert.equal(byWebSearchUsage.used.callCount, 1);
  assert.equal(byWebSearchUsage.not_used.callCount, 6);

  const functionCallTotal = report.byFunction.reduce((sum, entry) => sum + entry.callCount, 0);
  const purposeCallTotal = report.byPurpose.reduce((sum, entry) => sum + entry.callCount, 0);
  assert.equal(functionCallTotal, report.totals.callCount);
  assert.equal(purposeCallTotal, report.totals.callCount);
});
