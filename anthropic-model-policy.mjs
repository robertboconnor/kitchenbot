export const ANTHROPIC_MAIN_REASONING_MODEL = 'claude-sonnet-4-5';
export const ANTHROPIC_LIGHTWEIGHT_BACKGROUND_MODEL = 'claude-haiku-4-5-20251001';

const LIGHTWEIGHT_CALL_PURPOSES = new Set([
  'kb_memory_shape',
  'memory_policy',
  'chat_title',
  'kb_working_context',
  'kb_turn_grounding_provisional',
  'kb_turn_grounding_final',
  'grocery_draft_generation_primary',
  'inventory_section_classification',
]);

export function resolveAnthropicModelForCallPurpose(callPurpose) {
  const purpose = String(callPurpose ?? '').trim();
  if (LIGHTWEIGHT_CALL_PURPOSES.has(purpose)) {
    return ANTHROPIC_LIGHTWEIGHT_BACKGROUND_MODEL;
  }
  return ANTHROPIC_MAIN_REASONING_MODEL;
}
