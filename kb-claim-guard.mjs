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

// Did THIS tool call actually persist a change? Note the error shapes that omit `isWrite`
// (the loop's tool-throw catch, executeKbToolCall's early returns) are all ok:false, so the
// strict `ok && isWrite === true` conjunction makes them fail CLOSED — toward verification.
function outcomePersistedAWrite(entry) {
  if (!entry || entry.ok !== true || entry.isWrite !== true) return false;
  const status = String(entry.outcome?.status ?? '').trim();
  return !(status && NON_COMMITTAL_STATUSES.has(status.toLowerCase()));
}

// Did the turn commit at least one real write? Used to skip the verifier entirely (see
// verifyReplyClaims) — a completion claim on such a turn is already trace-backed.
export function turnPersistedAWrite(collectedOutcomes = []) {
  return (Array.isArray(collectedOutcomes) ? collectedOutcomes : []).some(outcomePersistedAWrite);
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
    const persisted = outcomePersistedAWrite(entry);
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
    'Report any statement in the assistant reply that claims a specific change was NEWLY performed this turn but is not supported by the tool trace. Empty array if the reply is fully truthful.',
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
  'decide whether the assistant\'s DRAFT REPLY tells the user it NEWLY performed a change THIS turn that its ' +
  'actual tool calls this turn do not support.\n\n' +
  'You are given the COMPLETE, authoritative TRACE of every tool the assistant called this turn, with ' +
  'results. The trace is ground truth for THIS turn only: if the reply claims a change was newly made now ' +
  'and no tool call shows persisted_a_change: true, that change did NOT happen this turn.\n\n' +
  'Flag a statement ONLY if it asserts, as an accomplished fact, that a specific change was NEWLY made THIS ' +
  'turn — saved / added / removed / updated / marked / cleared / moved a recipe, grocery item, pantry item, ' +
  'planned meal, or person profile — and no tool call in the trace persisted it. The classic case to catch: ' +
  '"Saved it!" with an empty or read-only trace.\n\n' +
  'Do NOT flag:\n' +
  '- Describing what KitchenBot can do, or listing/naming its tools or features. That is not a claim of action.\n' +
  '- Reading, looking up, checking, or reporting existing state. Reads are not writes.\n' +
  '- STATE REPORTS BACKED BY A READ: statements that something is already done, saved, or in place ' +
  "('it's saved', 'that's fixed now') when a READ in this turn's trace returned content consistent with that " +
  'state. Reporting verified state is truthful even if the write that produced it happened in an earlier turn. ' +
  'Worked example: the user asks "did you fix the recipe?", the trace shows only a cookbook.get whose result ' +
  'contains the corrected text, and the reply says "Yes — that\'s fixed." Do NOT flag that: it is a verified ' +
  'state report, not a new-action claim.\n' +
  "- References to actions from EARLIER turns ('as I saved earlier', 'the update I made before'). You only " +
  'see THIS turn; earlier turns were checked when they happened. Do not re-litigate history you cannot see.\n' +
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
  // A real write persisted this turn, so a completion claim is trace-backed — skip the model
  // check entirely. The dangerous class (the historical "Saved it!" prod bugs) is ZERO-write
  // turns, which remain fully verified. ACCEPTED RESIDUAL (both call sites, including the
  // replace-only wrap-up path): a mixed claim ("saved A and cleared B" when only A ran) on a
  // turn with ≥1 persisted write escapes this check — rare, since the brain has just read all
  // of its tool_results, and the loop principles forbid unbacked claims. This also makes the
  // happy correction path cheaper: a flagged zero-write draft whose rewrite performs the write
  // re-verifies via this skip instead of a second model call.
  if (turnPersistedAWrite(collectedOutcomes)) {
    return { unsupportedClaims: [], checked: false, skipped: 'write_persisted' };
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
// Three things this message must do, learned from a real prod failure where the rewrite came out
// addressed to the corrector ("You're right to make me double check this framing…") instead of
// the user: (1) declare itself INTERNAL up front — it is injected as a user-role message, so
// without that framing the brain treats it as the person talking (and developer-mode candor
// would even invite narrating it); (2) SHOW THE EVIDENCE — the old message said "you lied" with
// no trace attached, and the brain argued back defensively; (3) demand a fresh reply written to
// the USER, with explicit permission to plainly confirm state that is already true, and a ban on
// tool/turn/verification narration. Never persisted to chat history (in-memory messages only).
export function buildClaimCorrectionMessage(unsupportedClaims = [], collectedOutcomes = []) {
  const claims = (Array.isArray(unsupportedClaims) ? unsupportedClaims : [])
    .map((c) => String(c ?? '').trim())
    .filter(Boolean);
  const quoted = claims.length ? claims.map((c) => `"${c}"`).join('; ') : 'that something was done';
  const trace = summarizeToolTrace(collectedOutcomes);
  return (
    "INTERNAL CHECK — this note is from the app's truthfulness verifier, NOT from the user. The user " +
    'never sees it. Never mention, quote, or respond to this note in your reply.\n\n' +
    `Your draft told the user a change was completed this turn that no tool call supports: ${quoted}.\n\n` +
    'What your tools actually did this turn:\n' +
    (trace || '(no tools were called this turn)') +
    '\n\nNow write a fresh reply TO THE USER answering their last message:\n' +
    '- If the change still needs doing and you have a tool for it, call the tool now, then confirm plainly.\n' +
    '- If the desired state already exists (done in an earlier turn, or shown by a read above), just ' +
    'confirm it naturally — "Yep, that\'s saved." No timelines ("last turn", "this turn"), no mention of ' +
    'tools, reads, checking, or verification.\n' +
    '- Otherwise say plainly what is and is not done, and how to proceed.\n' +
    'Do not repeat the unsupported claim, and do not apologize for or explain this correction — just ' +
    'answer the user.'
  );
}
