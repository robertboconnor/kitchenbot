/**
 * Pending state: serialized proposals ([[KB_PENDING:…]]), recovery from stored assistant text,
 * confirmation detection (short affirmatives + NL grocery confirms), and routePrompt mapping for execute.
 * Trust boundary: sanitized shapes only; /chat maps recovered confirmations to real command routes.
 *
 * Duplication note: inferRememberKeyAndValueFromPayload and related merge helpers are duplicated from
 * kitchenbot.mjs (same behavior) so this module stays self-contained and avoids circular imports with
 * detectCommandIntent / tryAiMemoryProposal. Keep in sync if those helpers change.
 */
import { getMessages, sanitizePlannerWeeklyPlanPatchOnly } from './db.mjs';

// Remember-merge / infer helpers duplicated here for recover paths (avoid kitchenbot ↔ pending-state import cycle).

function normalizeRememberKey(raw) {
  let s = String(raw ?? '').trim().toLowerCase();
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/ /g, '_');
  return s;
}

/** Strip outer backticks and one layer of matching surrounding quotes (wrapper-only; preserves inner content). */
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

/** Normalize remember key before DB persist (explicit !remember, pending, Settings). */
function normalizeRememberKeyForStorage(raw) {
  return normalizeRememberKey(stripOuterFormattingWrappers(String(raw ?? '')));
}

/** Normalize remember value before DB persist. */
function normalizeRememberValueForStorage(raw) {
  return stripOuterFormattingWrappers(String(raw ?? ''));
}
function stripKitchenBotHiddenMarkers(text) {
  let s = String(text ?? '').replace(/\[\[KB_[A-Z0-9_]+\]\]/g, '');
  const pendingPrefix = '[[KB_PENDING:';
  let p = 0;
  while (true) {
    const start = s.indexOf(pendingPrefix, p);
    if (start === -1) break;
    const from = start + pendingPrefix.length;
    const close = s.indexOf(']]', from);
    if (close === -1) break;
    s = s.slice(0, start) + s.slice(close + 2);
    p = start;
  }
  s = s.replace(/\[\[KB_[A-Z0-9_]*$/g, '');
  return s;
}
function mergeMemoryValuesForUpsert(existingRaw, incomingRaw) {
  const existing = String(existingRaw ?? '').trim();
  const incoming = String(incomingRaw ?? '').trim();
  if (!incoming) return existing;
  if (!existing) return incoming;
  if (existing.toLowerCase() === incoming.toLowerCase()) return existing;
  return `${existing}; ${incoming}`;
}

/**
 * When AI or NL proposes a value for a key that already exists, merge or reject duplicates.
 * @returns {string | null} null = skip offer / no change
 */
function mergeMemoryProposalWithExisting(existingRaw, proposedRaw) {
  const existing = String(existingRaw ?? '').trim();
  const proposed = String(proposedRaw ?? '').trim();
  if (!proposed) return null;
  if (!existing) return proposed;
  if (proposed.toLowerCase() === existing.toLowerCase()) return null;
  if (proposed.toLowerCase().includes(existing.toLowerCase())) return proposed;
  if (existing.toLowerCase().includes(proposed.toLowerCase()) && proposed.length >= 4) return null;
  return mergeMemoryValuesForUpsert(existing, proposed);
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
    if (v) {
      const k = normalizeRememberKey('child_name');
      return { key: k, value: v };
    }
  }

  m = p.match(
    /^that\s+our\s+household\s+always\s+has\s+(?:these\s+)?(?:items?|ingredients?)\s*:?\s*(.+)$/i
  );
  if (!m) m = p.match(/^our\s+household\s+always\s+has\s+(?:these\s+)?(?:items?|ingredients?)\s*:?\s*(.+)$/i);
  if (!m) {
    m = p.match(
      /^that\s+our\s+kitchen\s+always\s+has\s+(?:these\s+)?(?:items?|ingredients?)\s*:?\s*(.+)$/i
    );
  }
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
/** Comma- or "and"-separated pantry-style list without a stronger pattern match. */
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

// --- Proposal serialization (sanitize + marker) ---

function sanitizePendingAction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const cmd = String(raw.command ?? '');
  if (cmd === 'weekly_plan_draft_patch') {
    const patch = sanitizePlannerWeeklyPlanPatchOnly(raw.patch);
    if (!patch) return null;
    return { command: 'weekly_plan_draft_patch', patch };
  }
  if (cmd === '!grocerylist') {
    const mode = raw.mode == null ? null : String(raw.mode);
    let out;
    if (mode == null || mode === '') {
      out = { command: '!grocerylist' };
    } else if (mode === 'append' || mode === 'replace' || mode === 'prune') {
      out = { command: '!grocerylist', mode };
    } else {
      return null;
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'source')) {
      if (raw.source !== 'draft_chat_offer') return null;
      out.source = 'draft_chat_offer';
    }
    return out;
  }
  if (cmd === '!help') return { command: cmd };
  if (cmd === '!remember') {
    const key = normalizeRememberKeyForStorage(raw.args?.key);
    const value = normalizeRememberValueForStorage(raw.args?.value);
    if (!key || !value) return null;
    return { command: '!remember', args: { key, value } };
  }
  if (cmd === '!rename') {
    const mode = raw.mode === 'manual' ? 'manual' : 'auto';
    if (mode === 'manual') {
      const title = String(raw.args?.title ?? '').trim().slice(0, 200);
      if (!title) return null;
      return { command: '!rename', mode, args: { title } };
    }
    return { command: '!rename', mode: 'auto' };
  }
  return null;
}

// --- Proposal → command routing ---

/**
 * Map a sanitized pending action to the route prompt used by /chat (must match client executePendingAction routing).
 */
function routePromptFromSanitizedPendingAction(action, fallbackPrompt) {
  if (!action || typeof action !== 'object') return fallbackPrompt;
  const cmd = String(action.command ?? '');
  if (cmd === 'weekly_plan_draft_patch') return fallbackPrompt;
  if (cmd === '!grocerylist') return '!grocerylist';
  if (cmd === '!help') return '!help';
  if (cmd === '!rename') {
    return action.mode === 'manual' && action.args?.title
      ? `!rename ${String(action.args.title).trim()}`
      : '!rename';
  }
  if (cmd === '!remember' && action.args?.key != null && action.args?.value != null) {
    return `!remember ${action.args.key} = ${action.args.value}`;
  }
  return fallbackPrompt;
}

/**
 * Append a machine-readable pending payload to persisted assistant content (stripped for display).
 * @param {string} content
 * @param {object} pendingAction raw or sanitized pending object
 */
function appendPendingMarkerToAssistantContent(content, pendingAction) {
  const sanitized = sanitizePendingAction(pendingAction);
  if (!sanitized) return String(content ?? '');
  const encoded = encodeURIComponent(JSON.stringify(sanitized));
  return String(content ?? '').trimEnd() + '\n[[KB_PENDING:' + encoded + ']]';
}

/**
 * Recover pending from hidden marker in stored assistant text (before regex fallbacks).
 * @returns {ReturnType<typeof sanitizePendingAction> | null}
 */
function parsePendingMarkerFromAssistantContent(rawContent) {
  const t = String(rawContent ?? '');
  const pendingPrefix = '[[KB_PENDING:';
  const start = t.indexOf(pendingPrefix);
  if (start === -1) return null;
  const from = start + pendingPrefix.length;
  const close = t.indexOf(']]', from);
  if (close === -1) return null;
  const encoded = t.slice(from, close);
  try {
    const json = decodeURIComponent(encoded);
    const obj = JSON.parse(json);
    return sanitizePendingAction(obj);
  } catch (e) {
    return null;
  }
}

function escapeInlineCodeSegment(s) {
  return String(s ?? '').replace(/`/g, "'");
}

/**
 * @param {Map<string, string> | null} memoriesByKey When set, remember offers can acknowledge an existing key and show merged value.
 */
function buildPendingActionReply(action, memoriesByKey = null) {
  if (!action) return '';
  if (action.command === '!grocerylist') {
    return "If you want, I can add this to the Grocery List tab. Want me to do that?";
  }
  if (action.command === '!help') {
    return 'I can show the help menu for you. Want me to do that?';
  }
  if (action.command === '!remember' && action.args?.key && action.args?.value) {
    const k = String(action.args.key);
    const v = String(action.args.value);
    const mergedCode = escapeInlineCodeSegment(`${k} = ${v}`);
    const memMap = memoriesByKey instanceof Map ? memoriesByKey : null;
    if (memMap && memMap.has(k)) {
      const existingRaw = String(memMap.get(k) ?? '').trim();
      if (existingRaw && existingRaw !== v.trim()) {
        const existingEsc = escapeInlineCodeSegment(existingRaw);
        const keyEsc = escapeInlineCodeSegment(k);
        return (
          `There is already a memory called \`${keyEsc}\` that says \`${existingEsc}\`. ` +
          `I can add this to it as \`${mergedCode}\`. Want me to do that?`
        );
      }
    }
    return `I can save that to memory as \`${mergedCode}\`. Want me to do that?`;
  }
  if (action.command === '!remember') {
    return 'I can save that to memory. Want me to do that?';
  }
  if (action.command === '!rename' && action.mode === 'manual') {
    return `I can rename this chat to "${action.args.title}". Want me to do that?`;
  }
  if (action.command === '!rename') {
    return 'I can rename this chat for you based on the thread context. Want me to do that?';
  }
  return '';
}

// --- Confirmation detection ---

function isShortAffirmativeConfirm(text) {
  const t = String(text ?? '').trim();
  if (t.length > 120) return false;
  const lower = t.toLowerCase();
  const s = lower.replace(/[!?.]/g, '').replace(/\s+/g, ' ').trim();
  if (
    [
      'yes',
      'yep',
      'yeah',
      'sure',
      'do it',
      'run it',
      'go ahead',
      'sure go ahead',
      'sure, go ahead',
      'yes please',
      'okay',
      'ok',
      'okay do it',
      'ok do it',
      'please do',
      'yeah save it',
      'yes save it',
      'sure save it',
      'yep save it',
      'ok save it',
      'okay save it',
      'yes save the preference please',
      'yeah save the preference please',
      'sure save the preference please',
      'yep save the preference please',
      'ok save the preference please',
      'okay save the preference please',
    ].includes(s)
  ) {
    return true;
  }
  if (/^(yes|yeah|yep|sure|ok|okay)\s+save\s+it$/.test(s)) {
    return true;
  }
  if (/^(yes|yeah|yep|sure|ok|okay)\s+save(\s+the)?\s+preference(\s+please)?$/.test(s)) {
    return true;
  }
  if (
    /^(yes|yeah|yep|sure|ok|okay)\s+update(\s+the)?\s+preferences(\s+please)?$/.test(s) ||
    /^(yes|yeah|yep|sure|ok|okay)\s+update\s+it(\s+please)?$/.test(s) ||
    /^(yes|yeah|yep|sure|ok|okay)\s+save(\s+the)?\s+preferences(\s+please)?$/.test(s)
  ) {
    return true;
  }
  if (['add it', 'add them', 'update it', 'push it', 'push it over'].includes(s)) {
    return true;
  }
  return /^(sure|yes|okay|ok)(?:,\s*|\s+)?(?:go ahead|do it|please)?$/.test(s);
}

/**
 * Natural-language confirmations for a recovered !grocerylist offer (not used without a matching last assistant offer).
 */
function isNaturalLanguageGroceryPendingConfirmation(text) {
  const t = String(text ?? '').trim();
  if (t.length > 200) return false;
  const lower = t.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/^\s*(why|what|when|where|who|how)\b/i.test(lower)) return false;
  if (/\b(don'?t|do not|never mind|nevermind|cancel|no thanks|no thank you)\b/i.test(lower)) return false;
  if (
    /^(okay|ok|yes|sure|yeah|yep)\s*,?\s*(let'?s|let us)\s+update\s+(the\s+)?grocery\s+list\b/i.test(lower) ||
    /^(let'?s|let us)\s+update\s+(the\s+)?grocery\s+list\b/i.test(lower)
  ) {
    return true;
  }
  if (
    /^(okay|ok|yes|sure|yeah|yep)\s*,?\s*(please\s+)?(go ahead\s+(and\s+)?)?update\s+(the\s+)?grocery\s+list\b/i.test(lower)
  ) {
    return true;
  }
  if (
    /^\s*(please\s+)?(go ahead\s+(and\s+)?)?update\s+(the\s+)?grocery\s+list\s*[!?.]*\s*$/i.test(lower)
  ) {
    return true;
  }
  if (
    /\b(go ahead|please)\s*,?\s*(and\s+)?(update\s+(the\s+)?grocery\s+list|add\s+(this|that|it|these|those)\s+to\s+(the\s+)?grocery\s+list)\b/i.test(lower)
  ) {
    return true;
  }
  if (
    /^(okay|ok|yes|sure|yeah|yep)\b/i.test(lower) &&
    /\b(add|put)\s+(this|that|it|these|those)\s+to\s+(the\s+)?(grocery|shopping)\s+list\b/i.test(lower)
  ) {
    return true;
  }
  // Same phrases as tryGroceryTabDeicticFollowUpPending: explicit follow-up after an in-chat draft + recoverable tab offer—confirm !grocerylist instead of re-offering / streaming another draft.
  if (
    /\bmake\s+a\s+grocery\s+list\s+from\s+this\b/.test(lower) ||
    /\bturn\s+this\s+into\s+(?:a\s+)?grocery\s+list\b/.test(lower)
  ) {
    return true;
  }
  return false;
}

function inferGroceryModeChoiceFromText(text, { allowPrune = true } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw || raw.length > 240) return null;
  const t = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (/^\s*(why|what|when|where|who|how)\b/i.test(t)) return null;
  if (/\b(don'?t|do not|never mind|nevermind|cancel|no thanks|no thank you)\b/i.test(t)) return null;

  const replacePhrases = [
    'replace',
    'replace it',
    'replace the list',
    'overwrite',
    'overwrite it',
    'overwrite the list',
    'start new',
    'start a new',
    'start a new one',
    'start a new list',
    'start fresh',
    'start over',
    'new list',
    'new one',
    'create a new one',
    'create a new list',
    'make a new one',
    'make a new list',
    'fresh list',
    'just this list',
    'only this list',
  ];
  for (const phrase of replacePhrases) {
    if (t === phrase || t.includes(phrase)) return 'replace';
  }

  const appendPatterns = [
    /\bappend\b/i,
    /\badd\s+(?:them|these|those|it)\s+(?:on\s+top|to\s+it|to\s+the\s+list)\b/i,
    /\badd\s+these\s+on\s+top\b/i,
    /\bkeep\s+what(?:'|’|)s\s+there\s+and\s+add\b/i,
    /\bkeep\s+what\s+is\s+there\s+and\s+add\b/i,
    /\bkeep\s+(?:the\s+)?existing\s+list\b/i,
    /\bkeep\s+(?:everything|what(?:'|’|)s\s+there|what\s+is\s+there)\b/i,
    /\bon\s+top\b/i,
  ];
  for (const pattern of appendPatterns) {
    if (pattern.test(t)) return 'append';
  }
  if (t === 'append' || t === 'add' || t === 'keep') return 'append';

  if (allowPrune) {
    const prunePatterns = [
      /\bprune\b/i,
      /\bremove\s+old\b/i,
      /\bremove\s+(?:the\s+)?ones\s+that\s+no\s+longer\s+fit\b/i,
      /\bremove\s+(?:the\s+)?items\s+we\s+swapped\s+out\b/i,
      /\bremove\s+swapped[- ]?out\b/i,
      /\bclean\s+up\s+old\s+items\b/i,
      /\bdrop\s+old\b/i,
    ];
    for (const pattern of prunePatterns) {
      if (pattern.test(t)) return 'prune';
    }
  }

  return null;
}

/**
 * True if the user is confirming a recovered sanitized pending action (extends short phrases with NL grocery confirms).
 * @param {string} text
 * @param {ReturnType<typeof sanitizePendingAction>} pending
 */
function isPendingActionConfirmation(text, pending) {
  if (!pending || !text) return false;
  if (isShortAffirmativeConfirm(text)) return true;
  const cmd = String(pending.command ?? '');
  if (cmd === '!grocerylist') {
    return isNaturalLanguageGroceryPendingConfirmation(text);
  }
  return false;
}

// --- Proposal recovery (marker → remember → grocery → rename → help; see recoverPendingActionFromLastAssistantMessage) ---

/**
 * Parse mixed-intent memory offer closing lines (same templates as buildMixedMemoryOfferLine).
 * @returns {ReturnType<typeof sanitizePendingAction> | null}
 */
function recoverRememberFromMixedOfferAssistantContent(content) {
  const t = stripKitchenBotHiddenMarkers(String(content ?? ''));
  let m = t.match(
    /If you want, I can save (.+?)['\u2019]s preference \(([^)]+)\) so I remember it next time too\.?/
  );
  if (m) {
    const name = m[1].trim();
    const detail = m[2].trim();
    const key = normalizeRememberKey(`${name}_preferences`);
    const value = detail;
    return sanitizePendingAction({ command: '!remember', args: { key, value } });
  }
  m = t.match(
    /If you want, I can save your tone preference \(([^)]+)\) so I remember it next time too\.?/
  );
  if (m) {
    return sanitizePendingAction({ command: '!remember', args: { key: 'tone', value: m[1].trim() } });
  }
  m = t.match(/Want me to save the favorite (food|pasta|meal) \(([^)]+)\) as a household note too\?/);
  if (m) {
    return sanitizePendingAction({
      command: '!remember',
      args: { key: normalizeRememberKey(`favorite_${m[1]}`), value: m[2].trim() },
    });
  }
  m = t.match(
    /If you want, I can save this \(([^)]+)\) under household memory for next time too\.?/
  );
  if (m) {
    const inferred = inferRememberKeyAndValueFromPayload(m[1].trim(), new Map());
    if (inferred?.key && inferred?.value) {
      return sanitizePendingAction({ command: '!remember', args: { key: inferred.key, value: inferred.value } });
    }
    return sanitizePendingAction({
      command: '!remember',
      args: { key: 'saved_note', value: m[1].trim() },
    });
  }
  m = t.match(/If you want, I can save that \(([^)]+)\) so I remember it next time too\.?/);
  if (m) {
    const inferred = inferRememberKeyAndValueFromPayload(m[1].trim(), new Map());
    if (inferred?.key && inferred?.value) {
      return sanitizePendingAction({ command: '!remember', args: { key: inferred.key, value: inferred.value } });
    }
    return sanitizePendingAction({
      command: '!remember',
      args: { key: 'saved_note', value: m[1].trim() },
    });
  }
  return null;
}

/**
 * Recover !remember from merge-aware offer (see buildPendingActionReply with existing key).
 */
function parseRememberMergeOfferFromAssistantContent(content) {
  const t = String(content ?? '');
  const re =
    /There is already a memory called `([^`]+)` that says `([^`]*)`\.\s*I can add this to it as `([^`]+)`\.\s*Want me to do that\?/is;
  const m = t.match(re);
  if (!m) return null;
  const combined = String(m[3] ?? '').trim();
  const eq = combined.indexOf(' = ');
  if (eq === -1) return null;
  const keyRaw = combined.slice(0, eq).trim();
  const valueRaw = combined.slice(eq + 3).trim();
  const key = normalizeRememberKey(keyRaw);
  const value = String(valueRaw).trim();
  if (!key || !value) return null;
  return sanitizePendingAction({ command: '!remember', args: { key, value } });
}

/**
 * Recover a !remember pending action from assistant message text (same chat).
 * Matches standard offer lines with plain and/or backticked key/value (case-insensitive anchor).
 * @returns {ReturnType<typeof sanitizePendingAction> | null}
 */
function parseRememberPendingFromAssistantContent(rawContent) {
  const content = stripKitchenBotHiddenMarkers(String(rawContent ?? ''));
  const mergePending = parseRememberMergeOfferFromAssistantContent(content);
  if (mergePending) return mergePending;
  const anchorRe = /I can save that to memory as /i;
  const am = anchorRe.exec(content);
  if (!am) return recoverRememberFromMixedOfferAssistantContent(content);
  const suffix = '. Want me to do that?';
  const afterAnchor = am.index + am[0].length;
  const end = content.indexOf(suffix, afterAnchor);
  if (end === -1) return recoverRememberFromMixedOfferAssistantContent(content);
  let mid = content.slice(afterAnchor, end).trim();
  function stripOuterBackticks(seg) {
    const t = String(seg).trim();
    if (t.length >= 2 && t.startsWith('`') && t.endsWith('`')) return t.slice(1, -1);
    return t;
  }
  const inner = stripOuterBackticks(mid);
  const eq = inner.indexOf(' = ');
  if (eq === -1) return recoverRememberFromMixedOfferAssistantContent(content);
  const keyRaw = inner.slice(0, eq).trim();
  const valueRaw = inner.slice(eq + 3).trim();
  const key = normalizeRememberKey(keyRaw);
  const value = String(valueRaw).trim();
  if (!key || !value) return recoverRememberFromMixedOfferAssistantContent(content);
  return sanitizePendingAction({ command: '!remember', args: { key, value } });
}

/**
 * True when stripped assistant text offers a direct yes/no update/add to the Grocery List tab (narrow).
 * Caller should pass content with hidden markers already removed.
 */
export function groceryTabOfferTextMatchesForPending(strippedText) {
  const t = String(strippedText ?? '');
  if (
    /If you want, I can add (?:this|these|those|it|them)\s+to\s+(?:the\s+)?Grocery\s+List\s+tab(?:\s+for you)?(?:\.|,)?/i.test(
      t
    ) ||
    /If you want, I can update\s+(?:the\s+)?Grocery\s+List\s+tab(?:\s+for you)?(?:\.|,)?/i.test(t)
  ) {
    return true;
  }
  if (
    /(?:^|[\n\r])\s*Want me to\s+(?:update\s+(?:the\s+)?Grocery\s+List\s+tab|add (?:this|these|those)\s+to\s+(?:the\s+)?Grocery\s+List\s+tab)\s*\.?\s*\??/im.test(
      t
    ) ||
    /(?:^|[\n\r])\s*Do you want me to\s+(?:update\s+(?:the\s+)?Grocery\s+List\s+tab|add (?:this|these|those)\s+to\s+(?:the\s+)?Grocery\s+List\s+tab)\s*\.?\s*\??/im.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Recover !grocerylist from assistant text (marker is stripped before persist; match visible offer lines).
 * @returns {ReturnType<typeof sanitizePendingAction> | null}
 */
function recoverGroceryPendingFromAssistantContent(rawContent) {
  const t = stripKitchenBotHiddenMarkers(String(rawContent ?? ''));
  if (groceryTabOfferTextMatchesForPending(t)) {
    return sanitizePendingAction({ command: '!grocerylist', source: 'draft_chat_offer' });
  }
  if (
    /That's a command-backed action\.\s*I can run !grocerylist for you\.\s*Want me to do that\?/i.test(t) ||
    /\bI can run !grocerylist for you\b/i.test(t)
  ) {
    return sanitizePendingAction({ command: '!grocerylist' });
  }
  return null;
}

/**
 * Recover !help / !rename offers from buildPendingActionReply text.
 * @returns {ReturnType<typeof sanitizePendingAction> | null}
 */
function recoverHelpPendingFromAssistantContent(rawContent) {
  const t = stripKitchenBotHiddenMarkers(String(rawContent ?? ''));
  if (/I can show the help menu for you\.\s*Want me to do that\?/i.test(t)) {
    return sanitizePendingAction({ command: '!help' });
  }
  return null;
}

/**
 * @returns {ReturnType<typeof sanitizePendingAction> | null}
 */
function recoverRenamePendingFromAssistantContent(rawContent) {
  const t = stripKitchenBotHiddenMarkers(String(rawContent ?? ''));
  const manual = t.match(
    /I can rename this chat to ["\u201c](.+?)["\u201d]\.\s*Want me to do that\?/i
  );
  if (manual) {
    const title = String(manual[1] ?? '')
      .trim()
      .slice(0, 200);
    if (title) return sanitizePendingAction({ command: '!rename', mode: 'manual', args: { title } });
  }
  if (
    /I can rename this chat for you based on the thread context\.\s*Want me to do that\?/i.test(t)
  ) {
    return sanitizePendingAction({ command: '!rename', mode: 'auto' });
  }
  return null;
}

/**
 * If the client lost X-KitchenBot-Pending-Action, recover a pending action from the latest assistant message in this chat.
 * Replaces the old memory-only recoverRememberPendingFromLastAssistantMessage.
 * Parsers are ordered: [[KB_PENDING:…]] marker → remember → grocery → rename → help (memory before grocery when both appear, e.g. mixed intent + marker).
 * Add new command recoverers here; map them in routePromptFromSanitizedPendingAction.
 */
async function recoverPendingActionFromLastAssistantMessage(chatId, householdId) {
  const conv = await getMessages(chatId, householdId);
  const lastAssistant = [...conv].reverse().find((m) => m.role === 'assistant');
  if (!lastAssistant) return null;
  const raw = lastAssistant.content;
  const markerParsed = parsePendingMarkerFromAssistantContent(raw);
  const rememberParsed = parseRememberPendingFromAssistantContent(raw);
  const recovered =
    markerParsed ||
    rememberParsed ||
    recoverGroceryPendingFromAssistantContent(raw) ||
    recoverRenamePendingFromAssistantContent(raw) ||
    recoverHelpPendingFromAssistantContent(raw);
  return recovered;
}


export {
  sanitizePendingAction,
  routePromptFromSanitizedPendingAction,
  appendPendingMarkerToAssistantContent,
  parsePendingMarkerFromAssistantContent,
  stripKitchenBotHiddenMarkers,
  buildPendingActionReply,
  isShortAffirmativeConfirm,
  isNaturalLanguageGroceryPendingConfirmation,
  inferGroceryModeChoiceFromText,
  isPendingActionConfirmation,
  recoverGroceryPendingFromAssistantContent,
  recoverPendingActionFromLastAssistantMessage,
};
