export const ANTHROPIC_MAIN_REASONING_MODEL = 'claude-sonnet-5';
export const ANTHROPIC_LIGHTWEIGHT_BACKGROUND_MODEL = 'claude-haiku-4-5-20251001';

// ONE BRAIN (KITCHENBOT_BRAIN_CONTRACT.md — "Smart Brain, Dumb Executors"): the only
// permitted side-model calls are (a) mechanical parse/shape helpers that never decide an
// action, derive intent, or classify on the brain's behalf, and (b) post-hoc integrity CHECKS
// on the brain's own output that select no action and infer no user intent. Chat-title naming
// and recipe import structuring (OCR / URL → structured recipe) are the parse/shape set;
// the truthfulness verifier (`kb_truthfulness_check`) is the integrity-check set — it reads
// the reply + the real tool trace and flags unsupported completion claims. It uses the MAIN
// model on purpose: it runs AFTER the reply has streamed (so its latency is a background commit,
// not a wait), and mis-judging truthfulness in either direction is high-cost, so it gets the
// strongest judgment rather than the cheap tier. (Switch it to lightweight below if that ever
// becomes a latency problem.)
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
