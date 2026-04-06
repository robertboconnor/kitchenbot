import { sanitizePendingAction } from './pending-state.mjs';
import { createLoggedAnthropicMessage } from './anthropic-usage.mjs';
import { resolveAnthropicModelForCallPurpose } from './anthropic-model-policy.mjs';

function normalizeRememberKey(raw) {
  let s = String(raw ?? '').trim().toLowerCase();
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/ /g, '_');
  return s;
}

function stripOuterFormattingWrappers(text) {
  let s = String(text ?? '').trim();
  while (s.length >= 2 && s.startsWith('`') && s.endsWith('`')) {
    s = s.slice(1, -1).trim();
  }
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if ((a === '"' || a === "'") && a === b) {
      s = s.slice(1, -1).trim();
    }
  }
  return s;
}

export function normalizeRememberKeyForStorage(raw) {
  return normalizeRememberKey(stripOuterFormattingWrappers(String(raw ?? '')));
}

export function normalizeRememberValueForStorage(raw) {
  return stripOuterFormattingWrappers(String(raw ?? ''));
}

function mergeMemoryValuesForUpsert(existingRaw, incomingRaw) {
  const existing = String(existingRaw ?? '').trim();
  const incoming = String(incomingRaw ?? '').trim();
  if (!incoming) return existing;
  if (!existing) return incoming;
  if (existing.toLowerCase() === incoming.toLowerCase()) return existing;
  return `${existing}; ${incoming}`;
}

export function mergeMemoryProposalWithExisting(existingRaw, proposedRaw) {
  const existing = String(existingRaw ?? '').trim();
  const proposed = String(proposedRaw ?? '').trim();
  if (!proposed) return null;
  if (!existing) return proposed;
  if (proposed.toLowerCase() === existing.toLowerCase()) return null;
  if (proposed.toLowerCase().includes(existing.toLowerCase())) return proposed;
  if (existing.toLowerCase().includes(proposed.toLowerCase()) && proposed.length >= 4) return null;
  return mergeMemoryValuesForUpsert(existing, proposed);
}

function looksLikePrimaryNonMemoryTaskClause(beforeText) {
  const t = String(beforeText ?? '').trim().toLowerCase();
  if (t.length < 10) return false;
  return (
    /\b(generate|create|make|build|draft|write|plan|help\s+me|suggest|give\s+me|what\s+should\s+i|can\s+you\s+|how\s+do\s+i|explain|compare)\b/.test(t) ||
    /\b(meal\s*plan|recipe|menu|grocery|shopping\s*list|week(?:'s)?\s+meals|dinners?|breakfast|lunch)\b/.test(t) ||
    /\b(planning|plan)\s+(?:meals?|for)\b/.test(t) ||
    /\bfor\s+this\s+week\b/.test(t)
  );
}

function mergeIntoExistingPreferenceKey(prefKey, fragment, memoriesByKey) {
  const k = normalizeRememberKey(prefKey);
  const frag = String(fragment ?? '').trim();
  if (!k || !frag) return null;
  if (memoriesByKey.has(k)) {
    const merged = mergeMemoryProposalWithExisting(String(memoriesByKey.get(k) ?? ''), frag);
    if (merged === null) return { key: k, value: String(memoriesByKey.get(k) ?? '') };
    return { key: k, value: merged };
  }
  return { key: k, value: frag };
}

function mergeIntoHouseholdStaples(listFragment, memoriesByKey) {
  const k = normalizeRememberKey('household_staples');
  const frag = String(listFragment ?? '').trim().replace(/^[:,]\s*/, '');
  if (!frag) return null;
  if (memoriesByKey.has(k)) {
    return { key: k, value: mergeMemoryValuesForUpsert(String(memoriesByKey.get(k) ?? ''), frag) };
  }
  return { key: k, value: frag };
}

function isSentenceLikeRememberKey(k) {
  const s = String(k ?? '').trim();
  if (!s) return true;
  if (s.length > 48) return true;
  const parts = s.split('_');
  if (parts.length > 5) return true;
  if (/^(that|our|my|the|remember|we|if|when|your)_/.test(s)) return true;
  return false;
}

function looksLikeStaplesListFragment(p) {
  const t = String(p ?? '').trim().toLowerCase();
  if (t.length < 8) return false;
  if (/\b(olive\s+oil|vegetable\s+oil|salt|pepper|vinegar|ketchup|flour|sugar|butter)\b/.test(t)) {
    return true;
  }
  return /,/.test(t) && t.split(',').length >= 2;
}

function looksLikeChildNameUpdatePayload(p) {
  return /\bchild(?:'s|\u2019s)?\s+name\s+is\b/i.test(p) || /\bkid(?:'s|\u2019s)?\s+name\s+is\b/i.test(p);
}

function extractChildNameFromPayload(p) {
  const m = String(p).match(/\b(?:child|kid)(?:'s|\u2019s)?\s+name\s+is\s+(.+)$/i);
  return m ? m[1].trim().replace(/[.!?]+$/, '') : null;
}

function inferRememberKeyAndValueFromPayload(payload, memoriesByKey = new Map()) {
  let p = String(payload ?? '').trim();
  if (!p) return null;
  p = p.slice(0, 500);

  let m = p.match(/\b(?:your\s+)?(?:writing\s+)?tone\s+should\s+be\s+(.+)$/i);
  if (m) return { key: normalizeRememberKey('tone'), value: m[1].trim() };
  m = p.match(/\b(?:your\s+)?(?:writing\s+)?tone\s+is\s+(.+)$/i);
  if (m) return { key: normalizeRememberKey('tone'), value: m[1].trim() };
  m = p.match(/\b(?:writing\s+)?style\s+should\s+be\s+(.+)$/i);
  if (m) return { key: normalizeRememberKey('tone'), value: m[1].trim() };

  m = p.match(/\bfavorite\s+(food|pasta|meal)\s+(?:is|should\s+be)\s+(.+)$/i);
  if (m) return { key: normalizeRememberKey(`favorite_${m[1]}`), value: m[2].trim() };
  m = p.match(/\bfavorite\s+(food|pasta|meal)\s+(.+)$/i);
  if (m) return { key: normalizeRememberKey(`favorite_${m[1]}`), value: m[2].trim() };

  m = p.match(/^([A-Za-z][a-z]{1,24})\s+does\s+not\s+like\s+(.+)$/i);
  if (!m) m = p.match(/^([A-Za-z][a-z]{1,24})\s+doesn't\s+like\s+(.+)$/i);
  if (m) {
    const name = m[1].toLowerCase();
    const thing = m[2].trim();
    if (name && thing) {
      return mergeIntoExistingPreferenceKey(`${name}_preferences`, `doesn't like ${thing}`, memoriesByKey);
    }
  }

  m = p.match(/^that\s+([a-z][a-z0-9]{1,23})\s+loves\s+(.+)$/i);
  if (!m) m = p.match(/^([a-z][a-z0-9]{1,23})\s+loves\s+(.+)$/i);
  if (m) {
    const name = m[1].toLowerCase();
    const thing = m[2].trim();
    if (name && thing) {
      return mergeIntoExistingPreferenceKey(`${name}_preferences`, `loves ${thing}`, memoriesByKey);
    }
  }

  m = p.match(/^that\s+([a-z][a-z0-9]{1,23})\s+hates\s+(.+)$/i);
  if (!m) m = p.match(/^([a-z][a-z0-9]{1,23})\s+hates\s+(.+)$/i);
  if (m) {
    const name = m[1].toLowerCase();
    const thing = m[2].trim();
    if (name && thing) {
      return mergeIntoExistingPreferenceKey(`${name}_preferences`, `hates ${thing}`, memoriesByKey);
    }
  }

  m = p.match(/^our\s+child(?:'s|\u2019s)?\s+name\s+is\s+(.+)$/i);
  if (!m) m = p.match(/^our\s+kid(?:'s|\u2019s)?\s+name\s+is\s+(.+)$/i);
  if (!m) m = p.match(/^that\s+our\s+child(?:'s|\u2019s)?\s+name\s+is\s+(.+)$/i);
  if (!m) m = p.match(/^that\s+our\s+kid(?:'s|\u2019s)?\s+name\s+is\s+(.+)$/i);
  if (m) {
    const v = m[1].trim();
    if (v) return { key: normalizeRememberKey('child_name'), value: v };
  }

  m = p.match(/^that\s+our\s+household\s+always\s+has\s+(?:these\s+)?(?:items?|ingredients?)\s*:?\s*(.+)$/i);
  if (!m) m = p.match(/^our\s+household\s+always\s+has\s+(?:these\s+)?(?:items?|ingredients?)\s*:?\s*(.+)$/i);
  if (!m) m = p.match(/^that\s+our\s+kitchen\s+always\s+has\s+(?:these\s+)?(?:items?|ingredients?)\s*:?\s*(.+)$/i);
  if (!m) m = p.match(/^our\s+kitchen\s+always\s+has\s+(?:these\s+)?(?:items?|ingredients?)\s*:?\s*(.+)$/i);
  if (!m) m = p.match(/^we\s+always\s+have\s+(.+)$/i);
  if (m) {
    const list = m[1].trim().replace(/^[:,]\s*/, '');
    if (list) return mergeIntoHouseholdStaples(list, memoriesByKey);
  }

  if (memoriesByKey.has('household_staples') && looksLikeStaplesListFragment(p)) {
    return mergeIntoHouseholdStaples(p, memoriesByKey);
  }
  if (memoriesByKey.has('child_name') && looksLikeChildNameUpdatePayload(p)) {
    const v = extractChildNameFromPayload(p);
    if (v) return { key: normalizeRememberKey('child_name'), value: v };
  }

  return { key: normalizeRememberKey('saved_note'), value: p };
}

function tryExtractNaturalLanguageRememberPayload(raw) {
  const s = String(raw ?? '').trim();
  const subordinate = s.match(/^(.{20,}?)\bremember(?:ing)?\s+that\s+(.+)$/is);
  if (subordinate) {
    const before = subordinate[1].trim();
    const payload = subordinate[2].trim();
    if (looksLikePrimaryNonMemoryTaskClause(before)) return { mixed: true };
    if (payload) return { payload };
  }
  const anchoredPatterns = [
    /^(?:please\s+)?remember\s+that\s+(.*)$/is,
    /^(?:please\s+)?save\s+(?:this|it|that)\s+to\s+(?:household\s+)?memory\b[.:\s]*(?:[-—]\s*)?(.*)$/is,
    /^(?:please\s+)?write\s+(?:this|it|that)\s+to\s+(?:household\s+)?memory\b[.:\s]*(?:[-—]\s*)?(.*)$/is,
    /^(?:please\s+)?don['']t\s+forget\s+that\s+(.*)$/is,
  ];
  for (const re of anchoredPatterns) {
    const m = s.match(re);
    if (!m) continue;
    let payload = (m[1] ?? '').trim();
    if (payload) return { payload };
    const stripped = s.replace(re, '').trim();
    if (stripped) return { payload: stripped };
  }
  return null;
}

export function buildMixedMemoryOfferLine(pendingRemember, userMessage) {
  const key = pendingRemember?.args?.key ?? '';
  const val = String(pendingRemember?.args?.value ?? '').trim();
  const raw = String(userMessage ?? '');

  function nameHintFromMessage() {
    const m1 = raw.match(/\b([A-Z][a-z]+)\s+does\s+not\s+like\b/);
    if (m1) return m1[1];
    const m2 = raw.match(/\b([a-z]+)\s+does\s+not\s+like\b/i);
    if (m2) return m2[1].charAt(0).toUpperCase() + m2[1].slice(1).toLowerCase();
    const m3 = raw.match(/\bremember(?:ing)?\s+that\s+([A-Z][a-z]+)\b/i);
    if (m3) return m3[1];
    const m4 = raw.match(/\bremember(?:ing)?\s+that\s+([a-z]{2,})\b/i);
    if (m4) {
      const w = m4[1].toLowerCase();
      if (['your', 'the', 'our', 'my', 'this', 'that', 'their', 'they', 'there', 'she', 'he'].includes(w)) {
        return null;
      }
      return m4[1].charAt(0).toUpperCase() + m4[1].slice(1).toLowerCase();
    }
    return null;
  }

  if (!key || !val) return 'Want me to save that as a household preference too?';

  const prefMatch = key.match(/^([a-z][a-z0-9]*)_preferences$/);
  if (prefMatch) {
    const fromKey = prefMatch[1].charAt(0).toUpperCase() + prefMatch[1].slice(1);
    const hint = nameHintFromMessage();
    const label = hint && hint.toLowerCase() === prefMatch[1].toLowerCase() ? hint : fromKey;
    if (val) return `If you want, I can save ${label}'s preference (${val}) so I remember it next time too.`;
    return `Want me to save that as a household preference for ${label} too?`;
  }
  if (key === 'tone') {
    const short = val.length > 70 ? val.slice(0, 67) + '…' : val;
    return `If you want, I can save your tone preference (${short}) so I remember it next time too.`;
  }
  const fav = key.match(/^favorite_(food|pasta|meal)$/);
  if (fav) {
    const short = val.length > 60 ? val.slice(0, 57) + '…' : val;
    return `Want me to save the favorite ${fav[1]} (${short}) as a household note too?`;
  }
  if (key === normalizeRememberKey('child_name')) {
    const short = val.length > 60 ? val.slice(0, 57) + '…' : val;
    return `If you want, I can save your child's name (${short}) for next time too.`;
  }
  if (key === normalizeRememberKey('household_staples')) {
    const short = val.length > 90 ? val.slice(0, 87) + '…' : val;
    return `If you want, I can save household staples (${short}) for next time too.`;
  }
  if (key === 'saved_note') {
    const short = val.length > 90 ? val.slice(0, 87) + '…' : val;
    return `If you want, I can save this (${short}) under household memory for next time too.`;
  }
  const short = val.length > 80 ? val.slice(0, 77) + '…' : val;
  return `If you want, I can save that (${short}) so I remember it next time too.`;
}

export function hasStrongMemoryIntentKeywords(text) {
  const lower = String(text ?? '').toLowerCase();
  if (/\bremember(?:ing)?\b/.test(lower)) return true;
  if (/\bmemory\b/.test(lower)) return true;
  if (/\bsave\s+this\b/.test(lower)) return true;
  if (/\bdon['']t\s+forget\b/.test(lower)) return true;
  if (/\bsave\s+(?:it|that)\s+(?:to|into)\s+(?:the\s+)?(?:household\s+)?memory\b/.test(lower)) return true;
  if (/\b(?:add|put|store)\s+(?:it|that|this)\s+(?:to|into)\s+(?:the\s+)?(?:household\s+)?memory\b/.test(lower)) {
    return true;
  }
  if (/\bhousehold\s+memory\b/.test(lower) && /\b(?:save|store|add|put)\b/.test(lower)) return true;
  return false;
}

function hasExplicitHouseholdMemorySaveIntent(text) {
  const lower = String(text ?? '').toLowerCase();
  return (
    /\bsave\s+(?:it|that|this)\s+(?:to|into)\s+(?:the\s+)?(?:household\s+)?memory\b/.test(lower) ||
    /\b(?:add|put|store)\s+(?:it|that|this)\s+(?:to|into)\s+(?:the\s+)?(?:household\s+)?memory\b/.test(lower) ||
    (/\bhousehold\s+memory\b/.test(lower) && /\b(?:save|store|add|put)\b/.test(lower))
  );
}

export function isMixedIntentMemoryMessage(raw) {
  const nl = tryExtractNaturalLanguageRememberPayload(raw);
  if (nl && 'mixed' in nl && nl.mixed) return true;
  if (looksLikePrimaryNonMemoryTaskClause(raw) && /\b(remember|memory|remembering|don['']t\s+forget)\b/i.test(raw)) {
    return true;
  }
  return false;
}

function normalizeForDurableMemoryScan(s) {
  return String(s ?? '').toLowerCase();
}

export function isDurableAutoMemoryCandidate({ key, value, routePrompt, threadCtx = null, userPrompt = null } = {}) {
  const k = normalizeForDurableMemoryScan(key);
  const v = normalizeForDurableMemoryScan(value);
  const rp = normalizeForDurableMemoryScan(routePrompt ?? userPrompt ?? '');
  const up = normalizeForDurableMemoryScan(userPrompt ?? '');
  const combined = `${k} ${v} ${rp} ${up}`;

  if (/\b(meal_plan|weekly_plan|meal_plan_week|dinner_plan|thread_mission|grocery_draft|current_plan|this_week_plan|plan_for_week|draft_grocery|thread_grocery|thread_plan|open_loop|openloop|mission_state)\b/.test(k)) {
    return false;
  }

  const ephemeralRes = [
    /\bthis week\b|\bweek's\b|\bfor the week\b|\bweekly dinner\b|\bweekly plan\b/,
    /\btonight\b|\bfor tonight\b/,
    /\bthis month\b/,
    /\bmeal plan\b|\bdinner plan\b|\bweekly menu\b/,
    /\b(?:the )?plan is\b|\bcurrent plan\b|\boptions we (?:picked|chose)\b|\bour plan\b/,
    /\bdraft(?:\s+grocery)?\b|\bgrocery list intent\b|\bthread intent\b/,
    /\bthread (?:mission|options)\b|\bopen loop\b|\b(?:current )?thread mission\b/,
  ];
  for (const re of ephemeralRes) {
    if (re.test(combined)) return false;
  }

  const mps = threadCtx?.mealPlanSummary ? normalizeForDurableMemoryScan(threadCtx.mealPlanSummary) : '';
  if (mps && v.length >= 12) {
    const slice = v.slice(0, 48);
    if (slice.length >= 12 && mps.includes(slice)) return false;
  }
  const tgs = threadCtx?.threadGrocerySummary ? normalizeForDurableMemoryScan(threadCtx.threadGrocerySummary) : '';
  if (tgs && v.length >= 12) {
    const slice = v.slice(0, 48);
    if (slice.length >= 12 && tgs.includes(slice)) return false;
  }
  const sceneStr =
    threadCtx?.threadScene && typeof threadCtx.threadScene === 'object'
      ? normalizeForDurableMemoryScan(JSON.stringify(threadCtx.threadScene))
      : '';
  if (sceneStr && v.length >= 12) {
    const slice = v.slice(0, 40);
    if (slice.length >= 12 && sceneStr.includes(slice)) return false;
  }

  const durablePositive =
    /\b(?:likes|love|loves|hate|hates|prefers|preference|preferences|allergic|allergy|avoid|avoidance|cannot eat|doesn't|does not|favorite|favourite|staples?|staple|household|recurring|dislikes?)\b/;
  if (durablePositive.test(combined)) return true;
  if (/_preferences$|_dietary$|_allergies$/.test(k)) return true;
  return false;
}

export function shouldApplyDurableAutoMemoryGuard({
  commandUserTextForPersistence,
  executePendingAction,
  bodyExecutePending,
  isPendingActionConfirmation,
}) {
  const userLine = String(commandUserTextForPersistence ?? '').trim();
  if (/^!remember(\s|$)/i.test(userLine)) return false;

  const bodyPending = sanitizePendingAction(bodyExecutePending);
  if (bodyPending?.command === '!remember') return false;

  if (
    executePendingAction?.command === '!remember' &&
    typeof isPendingActionConfirmation === 'function' &&
    isPendingActionConfirmation(commandUserTextForPersistence, executePendingAction)
  ) {
    return false;
  }
  return true;
}

function parseJsonObjectFromModelText(raw) {
  let s = String(raw ?? '').trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)```$/im);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

export async function tryAiMemoryProposal(anthropic, userMessage, memoriesList, threadCtx = null, opts = {}) {
  if (!hasStrongMemoryIntentKeywords(userMessage)) return null;
  const explicitSaveToMemory = hasExplicitHouseholdMemorySaveIntent(userMessage);
  const existing = (memoriesList || [])
    .filter((m) => m && m.key !== 'assistant_name')
    .map((m) => `${m.key}: ${m.value}`)
    .join('\n');
  try {
    const callPurpose = 'memory_policy';
    const res = await createLoggedAnthropicMessage(anthropic, {
      model: resolveAnthropicModelForCallPurpose(callPurpose),
      max_tokens: 400,
      system: `You help propose household memory key/value pairs. Output ONLY one JSON object (no markdown fences, no commentary) with this shape:
{"should_offer_memory":boolean,"key":string,"value":string,"confidence":number}

Rules:
- should_offer_memory: true only if the user clearly wants to save something for later recall (preferences, tone, dietary facts, names).
- Prefer reusing an EXISTING key from the list when the new fact belongs to the same topic.
- Use stable snake_case keys (lowercase, underscores).
- If the key already exists in the list, the value field must be the full merged text you want stored.
- confidence: 0.0–1.0.
- If there is nothing to save, set should_offer_memory to false, key and value to "", confidence to 0.`,
      messages: [
        {
          role: 'user',
          content: `Existing household memories (keys are unique; reuse when appropriate):\n${existing || '(none)'}\n\nUser message:\n${String(userMessage).slice(0, 4000)}`,
        },
      ],
    }, {
      householdId: opts?.householdId,
      chatId: opts?.chatId,
      smartModeEnabled: true,
      callSurface: 'background',
      callPurpose,
      webSearchEnabledAtCall: false,
      usedWebSearchTool: false,
    });
    const blocks = res.content.filter((b) => b.type === 'text');
    const raw = blocks.map((b) => b.text).join('\n').trim();
    const parsed = parseJsonObjectFromModelText(raw);
    if (!parsed || typeof parsed.should_offer_memory !== 'boolean') return null;
    const conf = Number(parsed.confidence);
    const minConf = explicitSaveToMemory ? 0.48 : 0.55;
    if (!parsed.should_offer_memory || !Number.isFinite(conf) || conf < minConf) return null;

    let key = normalizeRememberKeyForStorage(parsed.key);
    let value = normalizeRememberValueForStorage(String(parsed.value ?? '').trim().slice(0, 2000));
    if (!key || !value) return null;

    const memMap = new Map((memoriesList || []).filter((m) => m && m.key).map((m) => [m.key, m.value]));
    if (isSentenceLikeRememberKey(key)) {
      const fromVal = inferRememberKeyAndValueFromPayload(value, memMap);
      const fromUser = inferRememberKeyAndValueFromPayload(String(userMessage ?? '').trim(), memMap);
      const picked =
        fromVal && fromVal.key !== normalizeRememberKey('saved_note')
          ? fromVal
          : fromUser && fromUser.key !== normalizeRememberKey('saved_note')
            ? fromUser
            : null;
      if (picked) {
        key = picked.key;
        value = picked.value;
      } else {
        key = normalizeRememberKey('saved_note');
      }
    }

    const prior = (memoriesList || []).find((m) => m && m.key === key);
    if (prior) {
      const merged = mergeMemoryProposalWithExisting(String(prior.value ?? ''), value);
      if (merged === null) return null;
      if (merged.trim() === String(prior.value ?? '').trim()) return null;
      value = merged;
    }

    const proposal = sanitizePendingAction({ command: '!remember', args: { key, value } });
    if (!proposal) return null;
    if (!isDurableAutoMemoryCandidate({
      key: proposal.args.key,
      value: proposal.args.value,
      routePrompt: userMessage,
      threadCtx,
      userPrompt: userMessage,
    })) {
      return null;
    }
    return proposal;
  } catch (e) {
    if (typeof opts.isAnthropicSdkAuthOrKeyError === 'function' && opts.isAnthropicSdkAuthOrKeyError(e)) {
      throw e;
    }
    console.error('Memory proposal AI failed:', e?.message || e);
    return null;
  }
}
