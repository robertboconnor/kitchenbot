import { createLoggedAnthropicMessage } from './anthropic-usage.mjs';
import { resolveAnthropicModelForCallPurpose } from './anthropic-model-policy.mjs';
import { normalizeRememberKeyForStorage, normalizeRememberValueForStorage } from './smart-memory-policy.mjs';
import { listSmartDurableMemories } from './db.mjs';

export const SMART_DURABLE_MEMORY_TYPES = new Set(['person', 'household_note']);

const SMART_DURABLE_LABEL_MAX = 120;
const SMART_DURABLE_SUMMARY_MAX = 500;

function titleCaseWords(raw) {
  return String(raw ?? '')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

export function normalizeSmartDurableMemoryType(raw) {
  const t = String(raw ?? '').trim().toLowerCase();
  return SMART_DURABLE_MEMORY_TYPES.has(t) ? t : 'household_note';
}

export function normalizeSmartDurableMemoryLabel(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, SMART_DURABLE_LABEL_MAX);
}

export function normalizeSmartDurableMemorySummary(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, SMART_DURABLE_SUMMARY_MAX);
}

function normalizeSmartDurableNoteText(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 180);
}

export function normalizeSmartDurablePersonNotes(raw) {
  const values = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const notes = [];
  for (const entry of values) {
    const text = normalizeSmartDurableNoteText(
      typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? entry.text : ''
    );
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    notes.push({ text });
  }
  return notes.slice(0, 12);
}

export function buildPersonSummaryFromNotes(raw) {
  return normalizeSmartDurableMemorySummary(normalizeSmartDurablePersonNotes(raw).map((note) => note.text).join('; '));
}

export function normalizeSmartDurableMemoryAttributes(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value == null) continue;
    if (key === 'notes') {
      const notes = normalizeSmartDurablePersonNotes(value);
      if (notes.length > 0) out.notes = notes;
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[String(key)] = String(value).trim().slice(0, 240);
    }
  }
  return out;
}

export function normalizeSmartDurableMemoryLabelKey(raw) {
  return normalizeSmartDurableMemoryLabel(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

/** Interpreter-driven scopes for the final Smart Mode reply memory injection (Design A). */
export const DURABLE_MEMORY_REPLY_SCOPE_MODES = new Set(['auto', 'none', 'all_people', 'all_household_notes', 'full', 'labels']);

/**
 * Normalize interpreter output field durable_memory_scope (string or { mode, labels? }).
 * Invalid or missing values → { mode: 'auto' }.
 */
export function normalizeDurableMemoryScopeFromInterpreter(raw) {
  if (raw == null || raw === '') return { mode: 'auto' };
  if (typeof raw === 'string') {
    const m = String(raw).trim().toLowerCase();
    if (DURABLE_MEMORY_REPLY_SCOPE_MODES.has(m) && m !== 'labels') return { mode: m };
    return { mode: 'auto' };
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const mode = String(raw.mode ?? '').trim().toLowerCase();
    if (mode === 'labels') {
      const labels = Array.isArray(raw.labels)
        ? raw.labels.map((l) => String(l ?? '').trim()).filter(Boolean).slice(0, 12)
        : [];
      return labels.length > 0 ? { mode: 'labels', labels } : { mode: 'auto' };
    }
    if (DURABLE_MEMORY_REPLY_SCOPE_MODES.has(mode) && mode !== 'labels') return { mode };
  }
  return { mode: 'auto' };
}

function sortSmartDurableItemsByUpdatedDesc(items) {
  return [...(Array.isArray(items) ? items : [])].sort(
    (a, b) =>
      String(b.updatedAt || b.updated_at || '').localeCompare(String(a.updatedAt || a.updated_at || '')) ||
      String(a.label || '').localeCompare(String(b.label || ''))
  );
}

function smartMemoryItemMatchesLabels(item, labels) {
  const display = String(item.label ?? '').trim().toLowerCase();
  const norm = String(item.normalizedLabel ?? '').trim().toLowerCase();
  for (const req of labels) {
    const r = String(req ?? '').trim().toLowerCase();
    if (!r) continue;
    if (display === r || norm === r) return true;
    const rk = normalizeSmartDurableMemoryLabelKey(req).toLowerCase();
    if (norm && (norm === rk || norm.includes(rk) || rk.includes(norm))) return true;
    if (display.includes(r) || r.includes(display)) return true;
  }
  return false;
}

/**
 * Select structured memories for chat_reply when the interpreter requests a non-auto scope.
 * Returns null when scope.mode is 'auto' (caller should use selectRelevantSmartDurableMemories).
 */
export function selectSmartDurableMemoriesForReplyScope(allItems, scope, caps = {}) {
  if (!scope || scope.mode === 'auto') return null;
  const maxPeople = Math.min(24, Math.max(1, Number(caps.maxPeople) || 16));
  const maxNotes = Math.min(24, Math.max(1, Number(caps.maxNotes) || 16));
  const maxTotal = Math.min(32, Math.max(1, Number(caps.maxTotal) || 24));
  const list = Array.isArray(allItems) ? allItems : [];

  const people = () =>
    sortSmartDurableItemsByUpdatedDesc(
      list.filter((item) => normalizeSmartDurableMemoryType(item.memoryType || item.type) === 'person')
    );
  const householdNotes = () =>
    sortSmartDurableItemsByUpdatedDesc(
      list.filter((item) => normalizeSmartDurableMemoryType(item.memoryType || item.type) === 'household_note')
    );

  if (scope.mode === 'none') return [];

  if (scope.mode === 'all_people') return people().slice(0, maxPeople);

  if (scope.mode === 'all_household_notes') return householdNotes().slice(0, maxNotes);

  if (scope.mode === 'full') {
    const p = people().slice(0, maxPeople);
    const n = householdNotes().slice(0, maxNotes);
    const merged = [];
    const seen = new Set();
    for (const item of [...p, ...n]) {
      const id = String(item.id ?? `${item.memoryType}:${item.label}`);
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(item);
    }
    return merged.slice(0, maxTotal);
  }

  if (scope.mode === 'labels' && Array.isArray(scope.labels) && scope.labels.length > 0) {
    const out = [];
    const seen = new Set();
    for (const item of list) {
      if (!smartMemoryItemMatchesLabels(item, scope.labels)) continue;
      const id = String(item.id ?? `${item.memoryType}:${item.label}`);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(item);
    }
    return sortSmartDurableItemsByUpdatedDesc(out).slice(0, maxTotal);
  }

  return null;
}

function mergeSummaries(existingRaw, incomingRaw) {
  const existing = normalizeSmartDurableMemorySummary(existingRaw);
  const incoming = normalizeSmartDurableMemorySummary(incomingRaw);
  if (!incoming) return existing;
  if (!existing) return incoming;
  if (existing.toLowerCase() === incoming.toLowerCase()) return existing;
  if (incoming.toLowerCase().includes(existing.toLowerCase())) return incoming;
  if (existing.toLowerCase().includes(incoming.toLowerCase())) return existing;
  return `${existing}; ${incoming}`.slice(0, SMART_DURABLE_SUMMARY_MAX);
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

function inferFallbackSmartDurableMemoryRecord({ key, value }) {
  const normKey = normalizeRememberKeyForStorage(key);
  const normValue = normalizeRememberValueForStorage(value);
  const humanKey = normKey.replace(/_/g, ' ').trim();

  if (/^([a-z0-9]+)_preferences$/.test(normKey)) {
    const [, rawName] = normKey.match(/^([a-z0-9]+)_preferences$/) || [];
    return {
      memoryType: 'person',
      label: titleCaseWords(rawName),
      summary: normValue,
      attributes: { originalKey: normKey, notes: [{ text: normValue }] },
    };
  }

  if (normKey === 'child_name' && normValue) {
    return {
      memoryType: 'person',
      label: titleCaseWords(normValue),
      summary: 'Household child',
      attributes: { originalKey: normKey, role: 'child', notes: [{ text: 'Household child' }] },
    };
  }

  const personFact = normValue.match(/^([A-Za-z][A-Za-z' -]{1,40})\s+(.+)$/);
  if (personFact && !/^we\b/i.test(normValue)) {
    const label = titleCaseWords(personFact[1]);
    const note = normalizeSmartDurableNoteText(personFact[2]);
    if (label && note) {
      return {
        memoryType: 'person',
        label,
        summary: note,
        attributes: { originalKey: normKey, notes: [{ text: note }] },
      };
    }
  }

  if (/^(likes?|loves?|hates?|dislikes?|prefers?)\b/i.test(normValue) && humanKey) {
    return {
      memoryType: 'person',
      label: titleCaseWords(humanKey),
      summary: normValue,
      attributes: { originalKey: normKey, notes: [{ text: normValue }] },
    };
  }

  return {
    memoryType: 'household_note',
    label: normalizeSmartDurableMemoryLabel(humanKey || normValue.split(/[;,.]/)[0] || 'Saved note'),
    summary: normValue,
    attributes: { originalKey: normKey },
  };
}

function coerceSmartMemoryRecordForType(record) {
  if (!record || typeof record !== 'object') return null;
  const memoryType = normalizeSmartDurableMemoryType(record.memoryType || record.type);
  const label = normalizeSmartDurableMemoryLabel(record.label);
  const attributes = normalizeSmartDurableMemoryAttributes(record.attributes);
  if (!label) return null;
  if (memoryType === 'person') {
    const notes = normalizeSmartDurablePersonNotes(attributes.notes || (record.summary ? [{ text: record.summary }] : []));
    const summary = buildPersonSummaryFromNotes(notes);
    if (!summary) return null;
    return {
      memoryType,
      label,
      summary,
      attributes: {
        ...attributes,
        notes,
      },
    };
  }
  const summary = normalizeSmartDurableMemorySummary(record.summary);
  if (!summary) return null;
  return {
    memoryType,
    label,
    summary,
    attributes,
  };
}

function validateModelShapedMemory(parsed, fallback) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
  return (
    coerceSmartMemoryRecordForType({
      memoryType: parsed.memoryType,
      label: parsed.label,
      summary: parsed.summary,
      attributes: {
        ...normalizeSmartDurableMemoryAttributes(fallback?.attributes),
        ...normalizeSmartDurableMemoryAttributes(parsed.attributes),
      },
    }) || fallback
  );
}

export async function inferSmartDurableMemoryRecord({ anthropic, householdId, chatId, key, value }) {
  const fallback = inferFallbackSmartDurableMemoryRecord({ key, value });
  if (!anthropic) return fallback;
  try {
    const callPurpose = 'smart_durable_memory_shape';
    const response = await createLoggedAnthropicMessage(
      anthropic,
      {
        model: resolveAnthropicModelForCallPurpose(callPurpose),
        max_tokens: 220,
        system: `You convert a Smart Mode durable memory save into one compact structured memory record.

Output ONLY one JSON object:
{"memoryType":"person|household_note","label":"...","summary":"...","attributes":{"notes":[{"text":"..."}]}}

Rules:
- Keep label short and human-editable.
- Keep summary compact and durable.
- Use person for named household members and their stable preferences, likes, dislikes, or food constraints.
- Use household_note when the memory is household-wide rather than person-specific.
- For person, include a compact attributes.notes array with one short note item when possible.
- Do not invent facts beyond the supplied key/value.`,
        messages: [
          {
            role: 'user',
            content: JSON.stringify({ key, value }),
          },
        ],
      },
      {
        householdId,
        chatId,
        smartModeEnabled: true,
        callSurface: 'background',
        callPurpose,
        webSearchEnabledAtCall: false,
        usedWebSearchTool: false,
      }
    );
    const raw = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const parsed = parseJsonObjectFromModelText(raw);
    return validateModelShapedMemory(parsed, fallback);
  } catch (e) {
    console.error('Smart durable memory shaping failed:', e?.message || e);
    return fallback;
  }
}

export function buildSmartDurableMemoryCompatRows(items) {
  return (Array.isArray(items) ? items : []).map((item) => {
    const type = normalizeSmartDurableMemoryType(item.memoryType || item.type);
    const label = normalizeSmartDurableMemoryLabel(item.label || '');
    const summary =
      type === 'person'
        ? buildPersonSummaryFromNotes(item?.attributes?.notes || [])
        : normalizeSmartDurableMemorySummary(item.summary || '');
    const keyBase = normalizeSmartDurableMemoryLabelKey(label || `${type}_${item.id ?? 'item'}`);
    const key = type === 'person' ? `${keyBase || `smart_memory_${item.id ?? 'item'}`}_preferences` : keyBase || `smart_memory_${item.id ?? 'item'}`;
    return { key, value: summary };
  });
}

function tokenize(raw) {
  return [
    ...new Set(
      String(raw ?? '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .map((part) => part.trim())
        .filter(
          (part) =>
            part.length >= 3 &&
            !['with', 'from', 'that', 'this', 'what', 'would', 'should', 'about', 'there'].includes(part)
        )
    ),
  ];
}

function buildSearchHaystack(item) {
  const attrs =
    item && item.attributes && typeof item.attributes === 'object' && !Array.isArray(item.attributes)
      ? Object.entries(item.attributes)
          .map(([key, value]) => {
            if (key === 'notes') return normalizeSmartDurablePersonNotes(value).map((note) => note.text).join(' ');
            return typeof value === 'string' ? value : '';
          })
          .join(' ')
      : '';
  return `${item.memoryType || item.type || ''} ${item.label || ''} ${item.summary || ''} ${attrs}`.toLowerCase();
}

function isPreferenceLikeTurn(text) {
  return /\b(like|likes|love|loves|hate|hates|dislike|dislikes|prefer|prefers|favorite|favourite|can eat|allergic|allergy)\b/i.test(
    String(text || '')
  );
}

function isFoodPlanningTurn(text) {
  return /\b(dinner|meal|meals|recipe|recipes|cook|cooking|grocery|groceries|ingredient|ingredients|shop|shopping|wine|pairing|menu|breakfast|lunch|snack|fridge|pantry)\b/i.test(
    String(text || '')
  );
}

export function isMealGroceryPersonalizationTurn(context = {}) {
  const joined = [
    context?.prompt,
    context?.routePrompt,
  ]
    .filter(Boolean)
    .join(' ');
  if (!joined) return false;
  if (
    /\b(substitute|swap|replace|instead of|what should we eat|what should i make|plan meals|meal plan|weekly plan|what do i buy|what should i buy)\b/i.test(
      joined
    )
  ) {
    return true;
  }
  return isFoodPlanningTurn(joined);
}

function isNonRetrievalTurn(text) {
  return /\b(rename|title this chat|what can you do|help\b|settings|admin|mode|smart mode|legacy mode)\b/i.test(
    String(text || '')
  );
}

export function selectRelevantSmartDurableMemories(items, context, opts = {}) {
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Number(opts.limit)) : 6;
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];

  const contextTextParts = [
    context?.prompt,
    context?.routePrompt,
  ];
  const fullContextText = contextTextParts.filter(Boolean).join(' ');
  if (isNonRetrievalTurn(fullContextText)) return [];
  const terms = tokenize(fullContextText);
  if (terms.length === 0) return [];

  const foodPlanningTurn = opts.mode === 'planning' || opts.mode === 'grocery' || isMealGroceryPersonalizationTurn(context);
  const preferenceLikeTurn = isPreferenceLikeTurn(fullContextText);

  if (foodPlanningTurn) {
    const people = list
      .filter((item) => normalizeSmartDurableMemoryType(item.memoryType || item.type) === 'person')
      .sort(
        (a, b) =>
          String(b.updatedAt || b.updated_at || '').localeCompare(String(a.updatedAt || a.updated_at || '')) ||
          String(a.label || '').localeCompare(String(b.label || ''))
      );
    const scoredNotes = list
      .filter((item) => normalizeSmartDurableMemoryType(item.memoryType || item.type) === 'household_note')
      .map((item) => {
        const haystack = buildSearchHaystack(item);
        let score = 0;
        for (const term of terms) {
          if (haystack.includes(term)) score += 3;
          if (String(item.label || '').toLowerCase().includes(term)) score += 2;
        }
        if (preferenceLikeTurn) score += 1;
        return { item, score };
      })
      .sort(
        (a, b) =>
          b.score - a.score ||
          String(b.item.updatedAt || b.item.updated_at || '').localeCompare(String(a.item.updatedAt || a.item.updated_at || ''))
      )
      .map((entry) => entry.item);
    const unique = new Map();
    for (const item of [...people, ...scoredNotes]) {
      unique.set(String(item.id ?? `${item.memoryType}:${item.label}`), item);
    }
    return [...unique.values()].slice(0, Math.max(limit, people.length + Math.min(4, scoredNotes.length)));
  }

  const scored = list
    .map((item) => {
      const type = normalizeSmartDurableMemoryType(item.memoryType || item.type);
      const haystack = buildSearchHaystack(item);
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) score += 3;
        if (String(item.label || '').toLowerCase().includes(term)) score += 2;
      }
      if (type === 'person' && terms.some((term) => String(item.label || '').toLowerCase() === term)) {
        score += 2;
      }
      if (type === 'person' && !(preferenceLikeTurn || foodPlanningTurn || score >= 5)) score = 0;
      if (type === 'household_note' && !(preferenceLikeTurn || foodPlanningTurn)) score = 0;
      return { item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        String(b.item.updatedAt || b.item.updated_at || '').localeCompare(String(a.item.updatedAt || a.item.updated_at || ''))
    );

  return scored.slice(0, limit).map((entry) => entry.item);
}

export function formatSmartDurableMemoriesForPrompt(items) {
  const lines = (Array.isArray(items) ? items : [])
    .map((item) => {
      const type = normalizeSmartDurableMemoryType(item.memoryType || item.type);
      const label = normalizeSmartDurableMemoryLabel(item.label || '');
      const summary =
        type === 'person'
          ? buildPersonSummaryFromNotes(item?.attributes?.notes || [])
          : normalizeSmartDurableMemorySummary(item.summary || '');
      if (!label || !summary) return null;
      return `${type} | ${label} | ${summary}`;
    })
    .filter(Boolean);
  return lines.length > 0 ? lines.join('\n') : '(none)';
}

export async function getSmartDurableMemoryPromptContext(householdId, context = {}, opts = {}) {
  const allItems = await listSmartDurableMemories(householdId);
  const scope = normalizeDurableMemoryScopeFromInterpreter(opts.durableMemoryScope);
  const capOpts = {
    maxPeople: opts.scopeMaxPeople,
    maxNotes: opts.scopeMaxNotes,
    maxTotal: opts.scopeMaxTotal,
  };
  const scoped = selectSmartDurableMemoriesForReplyScope(allItems, scope, capOpts);
  const selectedItems =
    scoped === null ? selectRelevantSmartDurableMemories(allItems, context, opts) : scoped;
  return {
    allItems,
    selectedItems,
    compatRows: buildSmartDurableMemoryCompatRows(allItems),
    selectedCompatRows: buildSmartDurableMemoryCompatRows(selectedItems),
    promptText: formatSmartDurableMemoriesForPrompt(selectedItems),
  };
}

export function buildSmartDurableMemoryRecordForStorage(raw) {
  const coerced = coerceSmartMemoryRecordForType(raw);
  if (!coerced) return null;
  return {
    ...coerced,
    normalizedLabel:
      normalizeSmartDurableMemoryLabelKey(coerced.label) || normalizeSmartDurableMemoryLabelKey(coerced.summary),
  };
}

export function mergeSmartDurableMemoryForUpsert(existingItem, incomingItem) {
  const existing = existingItem && typeof existingItem === 'object' ? existingItem : {};
  const incoming = incomingItem && typeof incomingItem === 'object' ? incomingItem : {};
  const memoryType = normalizeSmartDurableMemoryType(incoming.memoryType || existing.memoryType);
  if (memoryType === 'person') {
    const notes = normalizeSmartDurablePersonNotes([
      ...(Array.isArray(existing?.attributes?.notes) ? existing.attributes.notes : []),
      ...(Array.isArray(incoming?.attributes?.notes) ? incoming.attributes.notes : []),
      ...(incoming.summary ? [{ text: incoming.summary }] : []),
    ]);
    const summary = buildPersonSummaryFromNotes(notes);
    return {
      memoryType,
      label: normalizeSmartDurableMemoryLabel(incoming.label || existing.label),
      normalizedLabel: normalizeSmartDurableMemoryLabelKey(incoming.label || existing.label),
      summary,
      attributes: {
        ...normalizeSmartDurableMemoryAttributes(existing.attributes),
        ...normalizeSmartDurableMemoryAttributes(incoming.attributes),
        notes,
      },
    };
  }
  return {
    memoryType,
    label: normalizeSmartDurableMemoryLabel(incoming.label || existing.label),
    normalizedLabel: normalizeSmartDurableMemoryLabelKey(incoming.label || existing.label),
    summary: mergeSummaries(existing.summary, incoming.summary),
    attributes: {
      ...normalizeSmartDurableMemoryAttributes(existing.attributes),
      ...normalizeSmartDurableMemoryAttributes(incoming.attributes),
    },
  };
}
