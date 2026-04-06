export const ANTHROPIC_MAIN_REASONING_MODEL = 'claude-sonnet-4-5';
export const ANTHROPIC_LIGHTWEIGHT_BACKGROUND_MODEL = 'claude-haiku-4-5-20251001';

const LIGHTWEIGHT_CALL_PURPOSES = new Set([
  'thread_scene_auto_update',
  'chat_title_generation',
  'smart_durable_memory_shape',
  'memory_policy',
  'smart_artifact_phrase',
  'smart_initiative',
]);

export function resolveAnthropicModelForCallPurpose(callPurpose) {
  const purpose = String(callPurpose ?? '').trim();
  if (LIGHTWEIGHT_CALL_PURPOSES.has(purpose)) {
    return ANTHROPIC_LIGHTWEIGHT_BACKGROUND_MODEL;
  }
  return ANTHROPIC_MAIN_REASONING_MODEL;
}
