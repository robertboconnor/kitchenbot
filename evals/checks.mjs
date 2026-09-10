// Deterministic checks — everything a machine can decide, decided by a machine.
//
// Anything that lands here is free, instant, and cannot be talked out of its verdict. The judge is
// for cooking judgment; it should never be asked "was grocery.write called", because it would
// sometimes be wrong about that and cost money to be wrong.

function words(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function toolNames(toolTrace) {
  return (toolTrace || []).map((t) => String(t?.name || ''));
}

/** Normalize a tool name so 'grocery.write' and 'grocery_write' compare equal. */
function normalizeToolName(name) {
  return String(name || '').replace(/[._-]/g, '').toLowerCase();
}

/**
 * Run a scenario's deterministic checks against one child result.
 * Returns [{ id, pass, detail }].
 */
export function runChecks(scenario, result) {
  const out = [];
  for (const check of scenario.checks || []) {
    switch (check.kind) {
      case 'tool_called': {
        const want = normalizeToolName(check.name);
        const got = toolNames(result.toolTrace).map(normalizeToolName);
        out.push({
          id: `tool_called:${check.name}`,
          pass: got.includes(want),
          detail: got.length ? `called: ${toolNames(result.toolTrace).join(', ')}` : 'no tools called',
        });
        break;
      }
      case 'tool_not_called': {
        const want = normalizeToolName(check.name);
        const got = toolNames(result.toolTrace).map(normalizeToolName);
        out.push({
          id: `tool_not_called:${check.name}`,
          pass: !got.includes(want),
          detail: `called: ${toolNames(result.toolTrace).join(', ') || 'none'}`,
        });
        break;
      }
      case 'no_tool_calls': {
        const got = toolNames(result.toolTrace);
        out.push({ id: 'no_tool_calls', pass: got.length === 0, detail: `called: ${got.join(', ') || 'none'}` });
        break;
      }
      case 'max_words': {
        const n = words(result.reply);
        out.push({ id: `max_words:${check.n}`, pass: n <= check.n, detail: `${n} words` });
        break;
      }
      case 'grocery_contains': {
        const have = (result.finalState?.grocery || []).map((i) => String(i.name || '').toLowerCase());
        const missing = check.items.filter((want) => !have.some((h) => h.includes(String(want).toLowerCase())));
        out.push({
          id: `grocery_contains:${check.items.join('+')}`,
          pass: missing.length === 0,
          detail: missing.length ? `missing: ${missing.join(', ')} (have: ${have.join(', ') || 'nothing'})` : `have: ${have.join(', ')}`,
        });
        break;
      }
      case 'plan_contains': {
        const have = (result.finalState?.plan || []).map((i) => String(i.name || '').toLowerCase());
        const missing = check.items.filter((want) => !have.some((h) => h.includes(String(want).toLowerCase())));
        out.push({
          id: `plan_contains:${check.items.join('+')}`,
          pass: missing.length === 0,
          detail: missing.length ? `missing: ${missing.join(', ')}` : `have: ${have.join(', ')}`,
        });
        break;
      }
      case 'claim_requires_tool': {
        // The truthfulness contract, re-pinned: if the reply SAYS it wrote something, a write must
        // actually have happened. Passing vacuously (no claim made) is correct here.
        const claimed = check.phrase.test(String(result.reply || ''));
        const want = normalizeToolName(check.name);
        const called = toolNames(result.toolTrace).map(normalizeToolName).includes(want);
        out.push({
          id: `claim_requires_tool:${check.name}`,
          pass: !claimed || called,
          detail: claimed ? (called ? 'claimed and called' : 'CLAIMED BUT NEVER CALLED') : 'no claim made',
        });
        break;
      }
      default:
        out.push({ id: `unknown_check:${check.kind}`, pass: false, detail: 'unrecognized check kind' });
    }
  }
  return out;
}

/**
 * Invariants asserted on EVERY scenario regardless of what it is testing. The cache-shape one
 * exists so that a future change which shoves per-turn text into the system prompt — quietly
 * multiplying the app's token bill — fails loudly here instead of showing up on a bill weeks later.
 */
export function runGlobalInvariants(result) {
  const out = [];
  const counts = result.systemBlockCounts || [];
  out.push({
    id: 'system_is_one_cached_block',
    pass: counts.length > 0 && counts.every((c) => c === 1),
    detail: counts.length ? `system block counts per request: ${counts.join(', ')}` : 'no requests recorded',
  });
  out.push({
    id: 'reply_not_empty',
    pass: words(result.reply) > 0,
    detail: `${words(result.reply)} words`,
  });
  return out;
}

export const __testables = { words, normalizeToolName };
