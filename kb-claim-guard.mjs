// kb-claim-guard.mjs
// Truthfulness safety net for the agent loop — STRUCTURAL, not text-pattern.
//
// The brain must never tell the user it completed an action it didn't actually perform via a
// tool ("Saved it!" with no cookbook.save). The FIRST version of this guard regex-scanned the
// reply for "lie-shaped" words and mapped them to capability families. That was a dumb executor
// pretending to be smart: it couldn't tell "describing a tool" from "claiming a write" and shipped
// a real prod bug (asking KB to list its tools got the honest answer wiped). Per the brain
// contract, heuristics that infer meaning from prose are forbidden.
//
// This version is structural: we build the turn's ACTUAL tool trace (ground truth of what ran and
// what changed) and hand it, with the draft reply, to a verifier model that judges whether the
// reply asserts any change the trace doesn't support. Intelligence over facts, not pattern-matching
// over prose. It is a post-hoc integrity CHECK on the brain's own output — it selects no action and
// infers no USER intent (both remain the brain's job), so it does not violate the executor contract.

import { createLoggedAnthropicMessage } from './anthropic-usage.mjs';
import { resolveAnthropicModelForCallPurpose } from './anthropic-model-policy.mjs';

// A write "counts as done" if the tool ran ok with a status that persisted something. These
// statuses mean nothing was written — a reply must not claim completion off the back of them.
const NON_COMMITTAL_STATUSES = new Set([
  'invalid',
  'no_items',
  'error',
  'skipped',
  'ambiguous',
  'missing',
  'empty_plan',
  'invalid_section',
  'unavailable',
  'needs_clarification',
]);

function compactOutcomeDetail(outcome) {
  if (!outcome || typeof outcome !== 'object') return '';
  try {
    // The full outcome object IS the ground truth; give the verifier the raw fields (capped).
    const json = JSON.stringify(outcome);
    return json.length > 600 ? `${json.slice(0, 600)}…` : json;
  } catch {
    return '';
  }
}

// Deterministic, factual summary of everything the turn actually did — reads and writes, with
// status and result fields. This is structuring FACTS (not inferring meaning), so it stays in code.
export function summarizeToolTrace(collectedOutcomes = []) {
  const lines = [];
  for (const entry of Array.isArray(collectedOutcomes) ? collectedOutcomes : []) {
    if (!entry) continue;
    const cap = String(entry.capability ?? entry.outcome?.capability ?? 'unknown');
    const kind = entry.isWrite === true ? 'write' : 'read';
    const ok = entry.ok === true;
    const status = String(entry.outcome?.status ?? '').trim();
    const persisted =
      ok && entry.isWrite === true && !(status && NON_COMMITTAL_STATUSES.has(status.toLowerCase()));
    const detail = compactOutcomeDetail(entry.outcome);
    lines.push(
      `- tool: ${cap} | kind: ${kind} | ok: ${ok}` +
        (status ? ` | status: ${status}` : '') +
        (entry.isWrite === true ? ` | persisted_a_change: ${persisted}` : '') +
        (detail ? ` | result: ${detail}` : '')
    );
  }
  return lines.join('\n');
}

const VERIFIER_TOOL = {
  name: 'report_unsupported_claims',
  description:
    'Report any statement in the assistant reply that claims a specific change was completed this turn but is not supported by the tool trace. Empty array if the reply is fully truthful.',
  input_schema: {
    type: 'object',
    properties: {
      unsupportedClaims: {
        type: 'array',
        items: { type: 'string' },
        description: 'Each unsupported completed-change claim, quoted or briefly paraphrased.',
      },
    },
    required: ['unsupportedClaims'],
  },
};

const VERIFIER_SYSTEM =
  'You are the truthfulness checker for KitchenBot, a shared household kitchen assistant. Your ONLY job: ' +
  'decide whether the assistant\'s DRAFT REPLY tells the user it COMPLETED or CHANGED something that its ' +
  'actual tool calls this turn do not support.\n\n' +
  'You are given the COMPLETE, authoritative TRACE of every tool the assistant called this turn, with ' +
  'results. The trace is ground truth: if a change is not in the trace (persisted_a_change: true), it did ' +
  'NOT happen.\n\n' +
  'Flag a statement ONLY if it asserts, as an accomplished fact, that a specific change was made THIS turn ' +
  '— saved / added / removed / updated / marked / cleared / moved a recipe, grocery item, pantry item, ' +
  'planned meal, memory, or person profile — and no tool call in the trace persisted it.\n\n' +
  'Do NOT flag:\n' +
  '- Describing what KitchenBot can do, or listing/naming its tools or features. That is not a claim of action.\n' +
  '- Reading, looking up, checking, or reporting existing state. Reads are not writes.\n' +
  "- Offers, suggestions, or questions ('I can add that', 'want me to save it?', 'should I…').\n" +
  "- Recommendations or conditional/future statements ('this pairs well', 'you could add', 'next time').\n" +
  '- A change the trace shows as done even if its status was duplicate / already-present / unchanged — the ' +
  "item IS on the list, so 'it's saved' is truthful.\n\n" +
  'Call report_unsupported_claims with each unsupported claim (short quote or paraphrase), or an empty array ' +
  'if the reply is fully truthful. When in doubt that a claim is truly unsupported, do NOT flag it.';

function buildVerifierUserMessage(reply, trace) {
  return (
    'TOOL TRACE (everything the assistant actually did this turn):\n' +
    (trace && trace.trim() ? trace : '(no tools were called this turn)') +
    '\n\nDRAFT REPLY:\n' +
    String(reply ?? '')
  );
}

// Parses the verifier's forced tool call into a clean string[]. Exported for unit tests.
export function parseVerifierResponse(response) {
  const content = Array.isArray(response?.content) ? response.content : [];
  const block = content.find(
    (b) => b?.type === 'tool_use' && b?.name === 'report_unsupported_claims'
  );
  const raw = block?.input?.unsupportedClaims;
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => String(s ?? '').trim()).filter(Boolean);
}

// Verifies the draft reply against the real tool trace using a verifier model. Returns
// { unsupportedClaims: string[], checked: boolean }. FAILS OPEN — if the check can't run or
// errors, it returns no claims, because wrongly blocking a truthful reply (the exact prod bug we
// are fixing) is worse than missing a rare genuine over-claim, which the system prompt discourages.
export async function verifyReplyClaims({
  anthropic,
  replyText,
  collectedOutcomes = [],
  ids = {},
  prompt = '',
} = {}) {
  const reply = String(replyText ?? '').trim();
  if (!reply) return { unsupportedClaims: [], checked: false };
  if (typeof anthropic?.messages?.create !== 'function') {
    return { unsupportedClaims: [], checked: false };
  }
  const trace = summarizeToolTrace(collectedOutcomes);
  try {
    const response = await createLoggedAnthropicMessage(
      anthropic,
      {
        model: resolveAnthropicModelForCallPurpose('kb_truthfulness_check'),
        max_tokens: 400,
        system: VERIFIER_SYSTEM,
        messages: [{ role: 'user', content: buildVerifierUserMessage(reply, trace) }],
        tools: [VERIFIER_TOOL],
        tool_choice: { type: 'tool', name: 'report_unsupported_claims' },
      },
      {
        householdId: ids.householdId,
        chatId: ids.chatId,
        turnId: ids.turnId,
        callPurpose: 'kb_truthfulness_check',
        callSurface: 'chat',
        prompt,
      }
    );
    return { unsupportedClaims: parseVerifierResponse(response), checked: true };
  } catch (error) {
    console.warn(`[kb-truthfulness] verifier error (failing open): ${error?.message || error}`);
    return { unsupportedClaims: [], checked: false, error: true };
  }
}

// The corrective message fed back to the model when the verifier found unsupported claims.
export function buildClaimCorrectionMessage(unsupportedClaims = []) {
  const claims = (Array.isArray(unsupportedClaims) ? unsupportedClaims : [])
    .map((c) => String(c ?? '').trim())
    .filter(Boolean);
  const quoted = claims.length ? claims.map((c) => `"${c}"`).join('; ') : 'that something was done';
  return (
    `STOP — your draft reply told the user you completed a change you did NOT actually make via a tool this ` +
    `turn: ${quoted}. Your rules forbid claiming you changed something unless a tool actually did it and ` +
    `reported success. Do ONE of these now: (1) call the right tool to actually do it, then confirm ` +
    `truthfully; or (2) rewrite your reply to say plainly what is and is not done, and how to proceed. Do ` +
    `not repeat the false claim.`
  );
}
