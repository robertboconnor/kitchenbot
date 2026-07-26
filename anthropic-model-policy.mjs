export const ANTHROPIC_MAIN_REASONING_MODEL = 'claude-sonnet-5';
export const ANTHROPIC_LIGHTWEIGHT_BACKGROUND_MODEL = 'claude-haiku-4-5-20251001';

// ONE BRAIN (KITCHENBOT_BRAIN_CONTRACT.md — "Smart Brain, Dumb Executors"): the only
// permitted side-model calls are (a) mechanical parse/shape helpers that never decide an
// action, derive intent, or classify on the brain's behalf, and (b) post-hoc integrity CHECKS
// on the brain's own output that select no action and infer no user intent. Chat-title naming,
// recipe import structuring (OCR / URL → structured recipe), and cookbook shaping (`cookbook_shape`
// — cleaning a saved recipe into structured JSON, and isolating/extracting a recipe from fetched
// page text) are the parse/shape set; the truthfulness verifier (`kb_truthfulness_check`) is the
// integrity-check set — it reads the reply + the real tool trace and flags unsupported
// completion claims.
const LIGHTWEIGHT_CALL_PURPOSES = new Set([
  'chat_title',
  'recipe_import_image_structure',
  'recipe_import_url_structure',
  // Strict-JSON recipe shaping/extraction on save/import. Off the reply hot path and the same class
  // of task as the recipe-import structuring above, which already runs on the lightweight tier.
  'cookbook_shape',
  // The truthfulness verifier originally ran on the MAIN model, justified by "it runs AFTER the
  // reply has streamed, so its latency is free" — that premise went stale when the loop buffered
  // (2026-07-24): the verifier now sits on the critical path of EVERY reply's time-to-first-byte.
  // It moved to the lightweight tier in the 2026-07-25 guard redesign, which also made the cheap
  // tier adequate: the rubric is turn-scoped and binary (flag only new-action claims with no
  // persisted write in the trace), write-backed turns skip verification entirely, a false flag
  // now costs one invisible grounded regeneration (not a user-visible meta-reply), and an honest
  // canned fallback still floors the worst case. Remove it from this set to restore the main
  // model. Do NOT bother adding cache_control to the verifier call: its ~600-token stable prefix
  // is far below Haiku's 4096-token cache minimum and would silently never cache.
  'kb_truthfulness_check',
]);

export function resolveAnthropicModelForCallPurpose(callPurpose) {
  const purpose = String(callPurpose ?? '').trim();
  if (LIGHTWEIGHT_CALL_PURPOSES.has(purpose)) {
    return ANTHROPIC_LIGHTWEIGHT_BACKGROUND_MODEL;
  }
  return ANTHROPIC_MAIN_REASONING_MODEL;
}
