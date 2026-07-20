export const ANTHROPIC_MAIN_REASONING_MODEL = 'claude-sonnet-5';
export const ANTHROPIC_LIGHTWEIGHT_BACKGROUND_MODEL = 'claude-haiku-4-5-20251001';

// ONE BRAIN (KITCHENBOT_BRAIN_CONTRACT.md — "Smart Brain, Dumb Executors"): the only
// permitted side-model calls are mechanical parse/shape helpers that never decide an
// action, derive intent, or classify on the brain's behalf. Chat-title naming and recipe
// import structuring (OCR / URL → structured recipe) are the whole allowed set.
const LIGHTWEIGHT_CALL_PURPOSES = new Set([
  'chat_title',
  'recipe_import_image_structure',
  'recipe_import_url_structure',
]);

export function resolveAnthropicModelForCallPurpose(callPurpose) {
  const purpose = String(callPurpose ?? '').trim();
  if (LIGHTWEIGHT_CALL_PURPOSES.has(purpose)) {
    return ANTHROPIC_LIGHTWEIGHT_BACKGROUND_MODEL;
  }
  return ANTHROPIC_MAIN_REASONING_MODEL;
}
