import { createLoggedAnthropicMessage } from './anthropic-usage.mjs';
import { resolveAnthropicModelForCallPurpose } from './anthropic-model-policy.mjs';
import {
  getGroceryItems,
  getHouseholdDefaults,
  getPantryItems,
  listCookbookEntries,
  listHouseholdUsers,
  listKbMemories,
} from './db.mjs';
import {
  buildAppliedCookbookText,
  formatCookbookEntriesText,
  selectRelevantCookbookEntries,
} from './cookbook-store.mjs';
import { normalizePantrySection } from './inventory-classification.mjs';
import { normalizeMemoryKey, normalizeMemoryValue } from './kb-memory-policy.mjs';
import { getAssistantPersonaSettings } from './kb-persona.mjs';

const MEMORY_TYPES = new Set(['person', 'household_note']);

function titleCaseWords(raw) {
  return String(raw ?? '')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

export function normalizeMemoryType(raw) {
  const t = String(raw ?? '').trim().toLowerCase();
  return MEMORY_TYPES.has(t) ? t : 'household_note';
}

function normalizeLabel(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
}

function normalizeSummary(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 500);
}

function normalizeNoteText(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 180);
}

export function normalizePersonNotes(raw) {
  const values = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const notes = [];
  for (const entry of values) {
    const text = normalizeNoteText(
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

export function buildPersonSummary(notesRaw) {
  return normalizeSummary(normalizePersonNotes(notesRaw).map((note) => note.text).join('; '));
}

function normalizeAttributes(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value == null) continue;
    if (key === 'notes') {
      const notes = normalizePersonNotes(value);
      if (notes.length > 0) out.notes = notes;
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[String(key)] = String(value).trim().slice(0, 240);
    }
  }
  return out;
}

function normalizeLabelKey(raw) {
  return normalizeLabel(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

function normalizeEntityName(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeEntityNameKey(raw) {
  return normalizeEntityName(raw).replace(/\s+/g, '_');
}

function deriveHouseholdNoteLabel(summary) {
  const text = normalizeSummary(summary);
  if (!text) return 'Household note';
  const lower = text.toLowerCase();
  if (/\bportion|serving|servings\b/.test(lower)) return 'Dinner portions';
  if (/\balways have\b|\bstaples?\b|\bpantry\b/.test(lower)) return 'Kitchen staples';
  if (/\bcook\b/.test(lower)) return 'Cooking preference';
  const firstClause = text.split(/[.;!?]/)[0]?.trim() || text;
  const compact = firstClause
    .replace(/^(we|our household|our kitchen)\s+/i, '')
    .trim()
    .slice(0, 60);
  return normalizeLabel(compact || 'Household note');
}

function parseJsonObject(raw) {
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

function fallbackRecord({ key, value }) {
  const normKey = normalizeMemoryKey(key);
  const normValue = normalizeMemoryValue(value);
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

  const personFact = normValue.match(/^([A-Za-z][A-Za-z' -]{1,40})\s+(.+)$/);
  if (personFact && !/^we\b/i.test(normValue)) {
    const label = titleCaseWords(personFact[1]);
    const note = normalizeNoteText(personFact[2]);
    if (label && note) {
      return {
        memoryType: 'person',
        label,
        summary: note,
        attributes: { originalKey: normKey, notes: [{ text: note }] },
      };
    }
  }

  return {
    memoryType: 'household_note',
    label:
      normKey === 'household_note'
        ? deriveHouseholdNoteLabel(normValue)
        : normalizeLabel(humanKey || normValue.split(/[;,.]/)[0] || 'Household note'),
    summary: normValue,
    attributes: { originalKey: normKey },
  };
}

function coerceRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const memoryType = normalizeMemoryType(record.memoryType || record.type);
  const label = normalizeLabel(record.label);
  const attributes = normalizeAttributes(record.attributes);
  if (!label) return null;
  if (memoryType === 'person') {
    const notes = normalizePersonNotes(attributes.notes || (record.summary ? [{ text: record.summary }] : []));
    const summary = buildPersonSummary(notes);
    if (!summary) return null;
    return {
      memoryType,
      label,
      summary,
      attributes: { ...attributes, notes },
    };
  }
  const summary = normalizeSummary(record.summary);
  if (!summary) return null;
  return { memoryType, label, summary, attributes };
}

export async function inferMemoryRecord({ anthropic, householdId, chatId, key, value }) {
  const fallback = fallbackRecord({ key, value });
  const normKey = normalizeMemoryKey(key);
  if (/^[a-z0-9]+_preferences$/.test(normKey)) {
    return fallback;
  }
  if (!anthropic) return fallback;
  try {
    const callPurpose = 'kb_memory_shape';
    const response = await createLoggedAnthropicMessage(
      anthropic,
      {
        model: resolveAnthropicModelForCallPurpose(callPurpose),
        max_tokens: 220,
        system: `You convert a KitchenBot memory save into one compact structured record.

Output ONLY one JSON object:
{"memoryType":"person|household_note","label":"...","summary":"...","attributes":{"notes":[{"text":"..."}]}}

Rules:
- Keep label short and editable.
- Keep summary compact and durable.
- Use person for named household members and their stable preferences or constraints.
- Use household_note when the memory is household-wide rather than person-specific.
- Do not invent facts beyond the supplied key and value.`,
        messages: [{ role: 'user', content: JSON.stringify({ key, value }) }],
      },
      {
        householdId,
        chatId,
        runtimeEnabled: true,
        callSurface: 'background',
        callPurpose,
        webSearchEnabledAtCall: false,
        usedWebSearchTool: false,
      }
    );
    const raw = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const parsed = parseJsonObject(raw);
    return (
      coerceRecord({
        memoryType: parsed?.memoryType,
        label: parsed?.label,
        summary: parsed?.summary,
        attributes: {
          ...normalizeAttributes(fallback?.attributes),
          ...normalizeAttributes(parsed?.attributes),
        },
      }) || fallback
    );
  } catch (error) {
    console.error('KitchenBot memory shaping failed:', error?.message || error);
    return fallback;
  }
}

// ONE BRAIN (KITCHENBOT_BRAIN_CONTRACT.md): whether a memory is about a person or the whole
// household is the main brain's decision — it passes `scope` and `person` on the tool call.
// We honor those deterministically (no side-model), falling back to the key/value heuristic
// only when the brain gave no hint.
export function resolveMemoryRecordDeterministic({ scope, person, value, key }) {
  const summary = normalizeMemoryValue(value);
  if (!summary) return null;
  const scopeStr = String(scope ?? '').trim().toLowerCase();
  const personName = normalizeLabel(person);

  if (personName) {
    const note = normalizeNoteText(summary);
    return coerceRecord({
      memoryType: 'person',
      label: personName,
      summary: note || summary,
      attributes: { originalKey: normalizeMemoryKey(key), notes: [{ text: note || summary }] },
    });
  }
  if (scopeStr === 'person') {
    // Explicit person scope but no name given — the heuristic can still pull a name from the value.
    return fallbackRecord({ key, value });
  }
  if (scopeStr === 'household') {
    return coerceRecord({
      memoryType: 'household_note',
      label: deriveHouseholdNoteLabel(summary),
      summary,
      attributes: { originalKey: normalizeMemoryKey(key) },
    });
  }
  // No scope/person hint from the brain — deterministic key/value heuristic.
  return fallbackRecord({ key, value });
}

export function buildMemoryRecordForStorage(raw) {
  const record = coerceRecord(raw);
  if (!record) return null;
  return {
    ...record,
    normalizedLabel: normalizeLabelKey(record.label) || normalizeLabelKey(record.summary),
  };
}

export function mergeMemoryRecord(existingItem, incomingItem) {
  const existing = existingItem && typeof existingItem === 'object' ? existingItem : {};
  const incoming = incomingItem && typeof incomingItem === 'object' ? incomingItem : {};
  const memoryType = normalizeMemoryType(incoming.memoryType || existing.memoryType);
  if (memoryType === 'person') {
    const notes = normalizePersonNotes([
      ...(Array.isArray(existing?.attributes?.notes) ? existing.attributes.notes : []),
      ...(Array.isArray(incoming?.attributes?.notes) ? incoming.attributes.notes : []),
    ]);
    return {
      memoryType,
      label: normalizeLabel(incoming.label || existing.label),
      normalizedLabel: normalizeLabelKey(incoming.label || existing.label),
      summary: buildPersonSummary(notes),
      attributes: {
        ...normalizeAttributes(existing.attributes),
        ...normalizeAttributes(incoming.attributes),
        notes,
      },
    };
  }
  const incomingSummary = normalizeSummary(incoming.summary);
  const existingSummary = normalizeSummary(existing.summary);
  const summary =
    !incomingSummary
      ? existingSummary
      : !existingSummary
        ? incomingSummary
        : incomingSummary.toLowerCase().includes(existingSummary.toLowerCase())
          ? incomingSummary
          : existingSummary.toLowerCase().includes(incomingSummary.toLowerCase())
            ? existingSummary
            : `${existingSummary}; ${incomingSummary}`.slice(0, 500);
  return {
    memoryType,
    label: normalizeLabel(incoming.label || existing.label),
    normalizedLabel: normalizeLabelKey(incoming.label || existing.label),
    summary,
    attributes: {
      ...normalizeAttributes(existing.attributes),
      ...normalizeAttributes(incoming.attributes),
    },
  };
}

export async function reconcilePersonMemoryRecord({
  anthropic,
  householdId,
  chatId,
  existingItem,
  incomingItem,
}) {
  const existing = existingItem && typeof existingItem === 'object' ? existingItem : null;
  const incoming = incomingItem && typeof incomingItem === 'object' ? incomingItem : null;
  if (!existing || !incoming) return mergeMemoryRecord(existingItem, incomingItem);
  if (normalizeMemoryType(existing.memoryType || incoming.memoryType) !== 'person') {
    return mergeMemoryRecord(existingItem, incomingItem);
  }
  if (!anthropic) return mergeMemoryRecord(existingItem, incomingItem);

  try {
    const callPurpose = 'kb_memory_shape';
    const response = await createLoggedAnthropicMessage(
      anthropic,
      {
        model: resolveAnthropicModelForCallPurpose(callPurpose),
        max_tokens: 220,
        system: `You reconcile KitchenBot person memory updates into one coherent current record.

Output ONLY one JSON object:
{"label":"...","notes":[{"text":"..."}]}

Rules:
- Preserve independent still-true preferences from existing notes.
- If the incoming note refines, narrows, or replaces an older note on the same topic, keep only the refined current truth.
- Do not keep contradictory old and new notes together.
- Keep notes short, durable, and non-overlapping.
- Do not invent facts beyond the supplied notes.`,
        messages: [{
          role: 'user',
          content: JSON.stringify({
            label: normalizeLabel(incoming.label || existing.label),
            existingNotes: normalizePersonNotes(existing?.attributes?.notes || []),
            incomingNotes: normalizePersonNotes(incoming?.attributes?.notes || []),
          }),
        }],
      },
      {
        householdId,
        chatId,
        runtimeEnabled: true,
        callSurface: 'background',
        callPurpose,
        webSearchEnabledAtCall: false,
        usedWebSearchTool: false,
      }
    );
    const raw = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const parsed = parseJsonObject(raw);
    const merged = buildMemoryRecordForStorage({
      memoryType: 'person',
      label: parsed?.label || incoming.label || existing.label,
      attributes: { notes: parsed?.notes },
    });
    return merged || mergeMemoryRecord(existingItem, incomingItem);
  } catch (error) {
    console.error('KitchenBot person-memory reconciliation failed:', error?.message || error);
    return mergeMemoryRecord(existingItem, incomingItem);
  }
}

function buildSearchHaystack(item) {
  const attrs =
    item && item.attributes && typeof item.attributes === 'object' && !Array.isArray(item.attributes)
      ? Object.entries(item.attributes)
          .map(([key, value]) => {
            if (key === 'notes') return normalizePersonNotes(value).map((note) => note.text).join(' ');
            return typeof value === 'string' ? value : '';
          })
          .join(' ')
      : '';
  return `${item.memoryType || item.type || ''} ${item.label || ''} ${item.summary || ''} ${attrs}`.toLowerCase();
}

function tokenize(raw) {
  return [
    ...new Set(
      String(raw ?? '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .map((part) => part.trim())
        .filter((part) => part.length >= 3 && !['with', 'from', 'that', 'this', 'what', 'would', 'should', 'about'].includes(part))
    ),
  ];
}

function buildPromptTerms(prompt) {
  return tokenize(prompt);
}

function buildKnownPeople(items, householdUsers = []) {
  const people = new Map();
  for (const user of Array.isArray(householdUsers) ? householdUsers : []) {
    const label = normalizeLabel(user?.display_name);
    const key = normalizeEntityName(label);
    if (!label || !key || people.has(key)) continue;
    people.set(key, label);
  }
  for (const item of Array.isArray(items) ? items : []) {
    const type = normalizeMemoryType(item.memoryType || item.type);
    if (type !== 'person') continue;
    const label = normalizeLabel(item.label);
    const key = normalizeEntityName(label);
    if (!label || !key || people.has(key)) continue;
    people.set(key, label);
  }
  return [...people.values()];
}

function findActiveSpeakerLabel(items, activeSpeakerName, knownPeople = []) {
  const speakerKey = normalizeEntityName(activeSpeakerName);
  if (!speakerKey) return null;
  const match = (Array.isArray(items) ? items : []).find((item) => {
    const type = normalizeMemoryType(item.memoryType || item.type);
    if (type !== 'person') return false;
    return normalizeEntityName(item.label) === speakerKey;
  });
  if (match) return normalizeLabel(match.label);
  const knownMatch = (Array.isArray(knownPeople) ? knownPeople : []).find(
    (label) => normalizeEntityName(label) === speakerKey
  );
  return knownMatch ? normalizeLabel(knownMatch) : normalizeLabel(activeSpeakerName);
}

function findMentionedPersonLabels(items, prompt, activeSpeakerLabel = null, knownPeople = []) {
  const promptText = ` ${normalizeEntityName(prompt)} `;
  if (!promptText.trim()) return [];
  const labels = [];
  const seen = new Set();
  const candidates = [
    ...(Array.isArray(knownPeople) ? knownPeople : []),
    ...(Array.isArray(items) ? items : [])
      .filter((item) => normalizeMemoryType(item.memoryType || item.type) === 'person')
      .map((item) => item.label),
  ];
  for (const rawLabel of candidates) {
    const label = normalizeLabel(rawLabel);
    const labelKey = normalizeEntityName(label);
    if (!labelKey || seen.has(labelKey)) continue;
    if (activeSpeakerLabel && normalizeEntityName(activeSpeakerLabel) === labelKey) continue;
    if (promptText.includes(` ${labelKey} `)) {
      seen.add(labelKey);
      labels.push(label);
    }
  }
  return labels;
}

function resolveEntityContext(items, prompt, activeSpeakerName = '', householdUsers = []) {
  const knownPeople = buildKnownPeople(items, householdUsers);
  const activeSpeakerLabel = findActiveSpeakerLabel(items, activeSpeakerName, knownPeople);
  const mentionedPersonLabels = findMentionedPersonLabels(items, prompt, activeSpeakerLabel, knownPeople);
  const promptTerms = buildPromptTerms(prompt);
  const householdRelevant =
    promptTerms.length > 0 ||
    /\b(we|our|household|home|kitchen)\b/i.test(String(prompt ?? ''));
  return {
    activeSpeakerName: normalizeLabel(activeSpeakerName),
    activeSpeakerLabel,
    mentionedPersonLabels,
    knownPeople,
    householdRelevant,
  };
}

function formatCompatRows(items) {
  return (Array.isArray(items) ? items : []).map((item) => {
    const type = normalizeMemoryType(item.memoryType || item.type);
    const label = normalizeLabel(item.label || '');
    const summary = type === 'person' ? buildPersonSummary(item?.attributes?.notes || []) : normalizeSummary(item.summary || '');
    const keyBase = normalizeLabelKey(label || `${type}_${item.id ?? 'item'}`);
    const key = type === 'person' ? `${keyBase || `memory_${item.id ?? 'item'}`}_preferences` : keyBase || `memory_${item.id ?? 'item'}`;
    return { key, value: summary };
  });
}

function sortItemsForPrompt(items, entityContext = {}) {
  const activeSpeakerKey = normalizeEntityName(entityContext.activeSpeakerLabel || entityContext.activeSpeakerName);
  const mentionedKeys = new Set(
    (Array.isArray(entityContext.mentionedPersonLabels) ? entityContext.mentionedPersonLabels : []).map((label) =>
      normalizeEntityName(label)
    )
  );
  return [...(Array.isArray(items) ? items : [])].sort((a, b) => {
    const aType = normalizeMemoryType(a.memoryType || a.type);
    const bType = normalizeMemoryType(b.memoryType || b.type);
    const aKey = normalizeEntityName(a.label);
    const bKey = normalizeEntityName(b.label);
    const aRank =
      aType === 'person' && aKey === activeSpeakerKey ? 0 : aType === 'person' && mentionedKeys.has(aKey) ? 1 : aType === 'household_note' ? 2 : 3;
    const bRank =
      bType === 'person' && bKey === activeSpeakerKey ? 0 : bType === 'person' && mentionedKeys.has(bKey) ? 1 : bType === 'household_note' ? 2 : 3;
    return (
      aRank - bRank ||
      String(b.updatedAt || b.updated_at || '').localeCompare(String(a.updatedAt || a.updated_at || ''))
    );
  });
}

function formatPromptText(items, entityContext = {}) {
  const lines = sortItemsForPrompt(items, entityContext)
    .map((item) => {
      const type = normalizeMemoryType(item.memoryType || item.type);
      const label = normalizeLabel(item.label || '');
      const summary = type === 'person' ? buildPersonSummary(item?.attributes?.notes || []) : normalizeSummary(item.summary || '');
      if (!label || !summary) return null;
      return `${type} | ${label} | ${summary}`;
    })
    .filter(Boolean);
  return lines.length > 0 ? lines.join('\n') : '(none)';
}

function summarizeItemForApplication(item) {
  const type = normalizeMemoryType(item.memoryType || item.type);
  if (type === 'person') {
    return buildPersonSummary(item?.attributes?.notes || []);
  }
  return normalizeSummary(item.summary || '');
}

function uniqueTextList(values) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = normalizeSummary(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function formatHouseholdDefaultsText(defaults = {}) {
  const portions =
    defaults.defaultDinnerPortions == null || !Number.isFinite(Number(defaults.defaultDinnerPortions))
      ? null
      : Number(defaults.defaultDinnerPortions);
  const style = normalizeLabel(defaults.weeknightCookingStyle || '');
  const lines = [];
  if (portions) lines.push(`default dinner portions: ${portions}`);
  if (style) lines.push(`cooking style: ${style.toLowerCase()}`);
  return lines.length > 0 ? lines.join('\n') : '(none)';
}

function safePantryName(name) {
  return String(name ?? '').trim().replace(/\s+/g, ' ');
}

function safeGroceryName(name) {
  return String(name ?? '').trim().replace(/\s+/g, ' ');
}

function formatPantryItemsText(items = []) {
  const names = uniqueTextList((Array.isArray(items) ? items : []).map((item) => safePantryName(item?.name)));
  return names.length > 0 ? `pantry items: ${names.join(', ')}` : '(none)';
}

function grocerySectionLabel(section) {
  const key = String(section ?? '').trim().toLowerCase();
  if (key === 'dry') return 'dry goods';
  if (key) return key;
  return 'other';
}

function formatGroceryItemsText(items = [], maxItems = 18) {
  const activeItems = (Array.isArray(items) ? items : []).filter((item) => !item?.checked);
  if (activeItems.length === 0) return '(none)';
  const grouped = new Map();
  for (const item of activeItems.slice(0, maxItems)) {
    const section = grocerySectionLabel(item?.section);
    const name = safeGroceryName(item?.name);
    const amount = String(item?.amount ?? '').trim();
    if (!name) continue;
    const line = amount ? `${name} (${amount})` : name;
    if (!grouped.has(section)) grouped.set(section, []);
    grouped.get(section).push(line);
  }
  const lines = [];
  for (const [section, entries] of grouped.entries()) {
    lines.push(`${section}: ${entries.join(', ')}`);
  }
  if (activeItems.length > maxItems) {
    lines.push(`and ${activeItems.length - maxItems} more unchecked items`);
  }
  return lines.length > 0 ? `current grocery list: ${lines.join(' | ')}` : '(none)';
}

function buildAppliedGroceryText(items = []) {
  const activeItems = (Array.isArray(items) ? items : []).filter((item) => !item?.checked);
  if (activeItems.length === 0) return '(none)';
  const names = uniqueTextList(activeItems.map((item) => safeGroceryName(item?.name))).slice(0, 20);
  const lines = [
    'Treat these as the current live Grocery List tab items for this household:',
    `- ${names.join(', ')}`,
    'If the user asks what is on the grocery list or whether something is already there, answer from this state instead of saying you cannot see it.',
  ];
  if (activeItems.length > names.length) {
    lines[1] += `, and ${activeItems.length - names.length} more`;
  }
  return lines.join('\n');
}

function buildGroceryPantryOverlapText(groceryItems = [], pantryItems = []) {
  const pantryNames = new Set(uniqueTextList((Array.isArray(pantryItems) ? pantryItems : []).map((item) => safePantryName(item?.name).toLowerCase())));
  const overlap = [];
  const pantryLike = [];
  for (const item of Array.isArray(groceryItems) ? groceryItems : []) {
    if (item?.checked) continue;
    const name = safeGroceryName(item?.name);
    const key = name.toLowerCase();
    if (!name) continue;
    if (pantryNames.has(key)) overlap.push(name);
    const inferredPantrySection = normalizePantrySection('', name);
    if (inferredPantrySection !== 'other_pantry') pantryLike.push(name);
  }
  const uniqueOverlap = uniqueTextList(overlap);
  const uniquePantryLike = uniqueTextList(pantryLike);
  if (uniqueOverlap.length === 0 && uniquePantryLike.length === 0) return '(none)';
  const lines = [];
  if (uniqueOverlap.length > 0) {
    lines.push(`Items already in both Pantry and Grocery List: ${uniqueOverlap.join(', ')}`);
  }
  if (uniquePantryLike.length > 0) {
    lines.push(`Pantry-like items currently on the Grocery List: ${uniquePantryLike.join(', ')}`);
  }
  return lines.join('\n');
}

function buildAppliedMemoryText(items, entityContext = {}) {
  const activeSpeakerKey = normalizeEntityName(entityContext.activeSpeakerLabel || entityContext.activeSpeakerName);
  const mentionedKeys = new Set(
    (Array.isArray(entityContext.mentionedPersonLabels) ? entityContext.mentionedPersonLabels : []).map((label) =>
      normalizeEntityName(label)
    )
  );

  const activeSpeakerFacts = [];
  const mentionedFacts = [];
  const householdFacts = [];

  for (const item of Array.isArray(items) ? items : []) {
    const summary = summarizeItemForApplication(item);
    if (!summary) continue;
    const type = normalizeMemoryType(item.memoryType || item.type);
    const label = normalizeLabel(item.label);
    const labelKey = normalizeEntityName(label);
    if (type === 'person' && activeSpeakerKey && labelKey === activeSpeakerKey) {
      activeSpeakerFacts.push(`${label}: ${summary}`);
      continue;
    }
    if (type === 'person' && mentionedKeys.has(labelKey)) {
      mentionedFacts.push(`${label}: ${summary}`);
      continue;
    }
    if (type === 'household_note') {
      householdFacts.push(summary);
    }
  }

  const lines = ['Use these as live context for this turn:'];
  const uniqueActiveFacts = uniqueTextList(activeSpeakerFacts);
  const uniqueMentionedFacts = uniqueTextList(mentionedFacts);
  const uniqueHouseholdFacts = uniqueTextList(householdFacts);

  if (uniqueActiveFacts.length > 0) {
    lines.push(`- Active speaker: ${uniqueActiveFacts.join(' | ')}`);
  }
  if (uniqueMentionedFacts.length > 0) {
    lines.push(`- Other relevant people: ${uniqueMentionedFacts.join(' | ')}`);
  }
  if (uniqueHouseholdFacts.length > 0) {
    lines.push(`- Household context: ${uniqueHouseholdFacts.join(' | ')}`);
  }
  if (lines.length === 1) {
    return '(none)';
  }
  lines.push('If these constraints materially affect the answer, adapt naturally instead of ignoring them.');
  return lines.join('\n');
}

function buildAppliedDefaultsText(defaults = {}) {
  const portions =
    defaults.defaultDinnerPortions == null || !Number.isFinite(Number(defaults.defaultDinnerPortions))
      ? null
      : Number(defaults.defaultDinnerPortions);
  const style = normalizeLabel(defaults.weeknightCookingStyle || '');
  const lines = ['Use these household defaults as stronger operating assumptions when relevant:'];
  if (portions) {
    lines.push(`- Default dinner portions: ${portions}`);
  }
  if (style) {
    lines.push(`- Cooking style: ${style.toLowerCase()}`);
  }
  if (lines.length === 1) return '(none)';
  lines.push('If the current turn touches groceries, meal sizing, or weeknight cooking decisions, apply these defaults naturally.');
  return lines.join('\n');
}

function buildAppliedPantryText(items = []) {
  const names = uniqueTextList((Array.isArray(items) ? items : []).map((item) => safePantryName(item?.name)));
  if (names.length === 0) return '(none)';
  return [
    'Treat these pantry items as already on hand unless the conversation clearly says you need more of them:',
    `- ${names.join(', ')}`,
  ].join('\n');
}

function selectRelevantItems(items, prompt, entityContext = {}, limit = 6) {
  const terms = buildPromptTerms(prompt);
  const activeSpeakerKey = normalizeEntityName(entityContext.activeSpeakerLabel || entityContext.activeSpeakerName);
  const mentionedKeys = new Set(
    (Array.isArray(entityContext.mentionedPersonLabels) ? entityContext.mentionedPersonLabels : []).map((label) =>
      normalizeEntityName(label)
    )
  );
  const scored = (Array.isArray(items) ? items : [])
    .map((item) => {
      const haystack = buildSearchHaystack(item);
      const type = normalizeMemoryType(item.memoryType || item.type);
      const labelKey = normalizeEntityName(item.label);
      let score = 0;
      if (type === 'person' && activeSpeakerKey && labelKey === activeSpeakerKey) {
        score += 16;
      }
      if (type === 'person' && mentionedKeys.has(labelKey)) {
        score += 20;
      }
      for (const term of terms) {
        if (haystack.includes(term)) score += 3;
        if (String(item.label || '').toLowerCase().includes(term)) score += 2;
      }
      if (type === 'household_note' && entityContext.householdRelevant && score > 0) {
        score += 4;
      }
      if (type === 'person' && score === 0 && activeSpeakerKey && labelKey === activeSpeakerKey) {
        score = 6;
      }
      if (type === 'person' && mentionedKeys.has(labelKey) && score < 10) {
        score += 8;
      }
      return { item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        String(b.item.updatedAt || b.item.updated_at || '').localeCompare(String(a.item.updatedAt || a.item.updated_at || ''))
    )
    .slice(0, limit)
    .map((entry) => entry.item);

  return scored;
}

export async function buildKbContextPacket(householdId, prompt = '', opts = {}) {
  const allItems = await listKbMemories(householdId);
  const householdUsers = await listHouseholdUsers(householdId).catch(() => []);
  const includeDefaults = opts.includeDefaults !== false;
  const includePantry = opts.includePantry !== false;
  const includeGrocery = opts.includeGrocery !== false;
  const includeCookbook = opts.includeCookbook === true;
  const capabilities =
    opts.capabilities && typeof opts.capabilities === 'object' && !Array.isArray(opts.capabilities)
      ? {
          webSearchEnabled: !!opts.capabilities.webSearchEnabled,
        }
      : {
          webSearchEnabled: false,
        };
  let pantryItems = [];
  let pantryContextStatus = includePantry ? 'unavailable' : 'not_requested';
  if (includePantry) {
    try {
      pantryItems = await getPantryItems(householdId);
      pantryContextStatus = pantryItems.length > 0 ? 'available' : 'empty';
    } catch {
      pantryItems = [];
      pantryContextStatus = 'unavailable';
    }
  }
  const groceryItems = includeGrocery ? await getGroceryItems(householdId).catch(() => []) : [];
  const cookbookEntries = includeCookbook ? await listCookbookEntries(householdId).catch(() => []) : [];
  const fullHouseholdDefaults = await getHouseholdDefaults(householdId).catch(() => ({
    defaultDinnerPortions: null,
    weeknightCookingStyle: null,
    assistantName: 'KitchenBot',
    assistantTone: 'concise',
  }));
  const assistantPersona = getAssistantPersonaSettings(fullHouseholdDefaults);
  const householdDefaults = includeDefaults
    ? {
        defaultDinnerPortions: fullHouseholdDefaults.defaultDinnerPortions,
        weeknightCookingStyle: fullHouseholdDefaults.weeknightCookingStyle,
      }
    : {
        defaultDinnerPortions: null,
        weeknightCookingStyle: null,
      };
  const entityContext = resolveEntityContext(allItems, prompt, opts.activeSpeakerName, householdUsers);
  const selectedItems = selectRelevantItems(
    allItems,
    prompt,
    entityContext,
    Number.isFinite(opts.limit) ? Number(opts.limit) : 6
  );
  const selectedCookbookEntries = includeCookbook
    ? selectRelevantCookbookEntries(cookbookEntries, prompt, Number.isFinite(opts.cookbookLimit) ? Number(opts.cookbookLimit) : 8)
    : [];
  return {
    allItems,
    householdUsers,
    pantryItems,
    pantryContextStatus,
    pantryContextAvailable: pantryContextStatus === 'available' || pantryContextStatus === 'empty',
    pantryItemCount: pantryItems.length,
    groceryItems,
    cookbookEntries,
    selectedCookbookEntries,
    capabilities,
    householdDefaults,
    assistantPersona,
    selectedItems,
    rows: formatCompatRows(selectedItems),
    promptText: formatPromptText(selectedItems, entityContext),
    applicationText: buildAppliedMemoryText(selectedItems, entityContext),
    defaultsText: formatHouseholdDefaultsText(householdDefaults),
    appliedDefaultsText: buildAppliedDefaultsText(householdDefaults),
    pantryText: formatPantryItemsText(pantryItems),
    appliedPantryText: buildAppliedPantryText(pantryItems),
    groceryText: formatGroceryItemsText(groceryItems),
    appliedGroceryText: buildAppliedGroceryText(groceryItems),
    cookbookText: formatCookbookEntriesText(selectedCookbookEntries),
    appliedCookbookText: buildAppliedCookbookText(selectedCookbookEntries),
    groceryPantryOverlapText:
      includeGrocery && includePantry ? buildGroceryPantryOverlapText(groceryItems, pantryItems) : '(none)',
    entityContext,
  };
}
