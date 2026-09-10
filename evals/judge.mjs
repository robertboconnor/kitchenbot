// The judge: an LLM grading a reply against the hand-written criteria in scenarios.mjs.
//
// Shape is copied deliberately from kb-claim-guard.mjs:178-197 — a forced tool call plus a small
// exported parser — because that pattern is already proven in this codebase and already tested.
//
// The judge is the weakest link in the whole eval, so two things are structural rather than
// optional:
//   1. It never sees which variant produced the reply, nor any "ideal answer". It grades the reply
//      against the criteria and nothing else, so it cannot infer the expected verdict.
//   2. Every verdict must carry a VERBATIM quote from the reply. A judge that cannot point at the
//      deciding text is guessing, and a missing quote is visible in the report.
//
// Run `node evals/run.mjs --calibrate` before trusting any green result: it grades hand-written
// known-bad replies and fails the run if the judge lets them through.
import { ANTHROPIC_MAIN_REASONING_MODEL } from '../anthropic-model-policy.mjs';
import { estimateAnthropicLedgerCostUsd, extractAnthropicUsageFields } from '../anthropic-usage.mjs';

const JUDGE_TOOL = {
  name: 'report_criteria_verdicts',
  description: 'Report a pass/fail verdict for every criterion you were given, in the same order.',
  input_schema: {
    type: 'object',
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The criterion id exactly as given.' },
            pass: { type: 'boolean' },
            evidence: {
              type: 'string',
              description:
                'A short VERBATIM quote from the reply that decides this criterion. Empty string only if the reply contains nothing bearing on it.',
            },
            rationale: { type: 'string', description: 'One sentence.' },
          },
          required: ['id', 'pass', 'evidence', 'rationale'],
        },
      },
    },
    required: ['verdicts'],
  },
};

const JUDGE_SYSTEM = [
  'You grade a home-cooking assistant\'s reply against criteria written by an experienced cook.',
  '',
  'Grade ONLY the criteria you are given, one at a time, on what the reply actually says.',
  '- A MUST criterion passes only if the reply plainly does the thing. Implied, hinted, or "could be read as" is a FAIL.',
  '- A MUST-NOT criterion passes only if the reply plainly avoids the thing. If the reply does it even once, that is a FAIL.',
  '',
  'Quote the exact text that decides each verdict. If nothing in the reply bears on a criterion, the',
  'evidence is an empty string — and a MUST with no supporting text is a FAIL.',
  '',
  'Do not reward or penalise anything the criteria do not name. Do not add your own opinion about',
  'the cooking, the tone, or the formatting. Do not be generous: you are the only thing standing',
  'between a plausible-sounding answer and a wrong one going unnoticed.',
  '',
  'If the reply is empty, truncated, or an error message, fail every criterion.',
].join('\n');

function buildJudgeUserMessage({ prompt, reply, criteria, priorTurns = [] }) {
  const lines = [];
  if (priorTurns.length) {
    lines.push('Earlier in the conversation:');
    for (const turn of priorTurns) lines.push(`  ${turn.role}: ${turn.content}`);
    lines.push('');
  }
  lines.push('The user asked:');
  lines.push(prompt);
  lines.push('');
  lines.push('The assistant replied:');
  lines.push('"""');
  lines.push(reply || '(empty reply)');
  lines.push('"""');
  lines.push('');
  lines.push('Grade this reply against each criterion:');
  for (const c of criteria) {
    lines.push(`- id: ${c.id}`);
    lines.push(`  ${c.kind === 'must' ? 'MUST' : 'MUST NOT'}: ${c.text}`);
  }
  return lines.join('\n');
}

/**
 * Pull the verdict list out of a forced-tool response. Mirrors parseVerifierResponse in
 * kb-claim-guard.mjs — tolerant of shape, strict about content.
 */
export function parseJudgeResponse(response) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  const toolUse = blocks.find((b) => b?.type === 'tool_use' && b?.name === 'report_criteria_verdicts');
  const raw = Array.isArray(toolUse?.input?.verdicts) ? toolUse.input.verdicts : [];
  const out = [];
  for (const v of raw) {
    const id = typeof v?.id === 'string' ? v.id.trim() : '';
    if (!id) continue;
    out.push({
      id,
      pass: v?.pass === true,
      evidence: typeof v?.evidence === 'string' ? v.evidence.trim() : '',
      rationale: typeof v?.rationale === 'string' ? v.rationale.trim() : '',
    });
  }
  return out;
}

/**
 * Grade one reply. Returns { verdicts, missing, costUsd, error }.
 * `missing` names criteria the judge failed to return a verdict for — treated as failures by the
 * caller, never silently dropped.
 */
export async function judgeReply(anthropic, { prompt, reply, criteria, priorTurns }) {
  let response;
  try {
    response = await anthropic.messages.create({
      model: ANTHROPIC_MAIN_REASONING_MODEL,
      max_tokens: 1500,
      system: JUDGE_SYSTEM,
      messages: [{ role: 'user', content: buildJudgeUserMessage({ prompt, reply, criteria, priorTurns }) }],
      tools: [JUDGE_TOOL],
      tool_choice: { type: 'tool', name: 'report_criteria_verdicts' },
    });
  } catch (error) {
    return { verdicts: [], missing: criteria.map((c) => c.id), costUsd: 0, error: String(error?.message || error) };
  }

  const verdicts = parseJudgeResponse(response);
  const seen = new Set(verdicts.map((v) => v.id));
  const missing = criteria.map((c) => c.id).filter((id) => !seen.has(id));

  const usage = extractAnthropicUsageFields(response) || {};
  const costUsd = estimateAnthropicLedgerCostUsd({ model: response?.model || ANTHROPIC_MAIN_REASONING_MODEL, ...usage }) || 0;

  return { verdicts, missing, costUsd, error: null };
}

export const __testables = { JUDGE_TOOL, JUDGE_SYSTEM, buildJudgeUserMessage };
