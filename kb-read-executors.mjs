// kb-read-executors.mjs
// Pass 2 "context as cognition": read-only tools the brain calls ON DEMAND to
// see live household state, instead of us pre-injecting pantry/grocery/defaults
// into every prompt. Each returns a compact { ok, ... } outcome that
// summarizeOutcomeForModel (kb-tools.mjs) hands back as the tool_result.
import { getGroceryItems, getPantryItems, getHouseholdDefaults, getMealPlanItems, getMessages } from './db.mjs';
import { GROCERY_SECTION_KEYS, PANTRY_SECTION_KEYS } from './inventory-classification.mjs';
import { COOKBOOK_CATEGORY_OPTIONS } from './cookbook-store.mjs';

function s(v) {
  return String(v ?? '').trim();
}

// The canonical, fixed taxonomies — so the brain can answer "what categories exist?"
// and place/recategorize items into valid sections, instead of only inferring the
// ones currently in use from pantry.list / grocery.list.
export async function executeInventorySections(_action, _context = {}) {
  return {
    ok: true,
    grocerySections: [...GROCERY_SECTION_KEYS],
    pantrySections: [...PANTRY_SECTION_KEYS],
    cookbookCategories: COOKBOOK_CATEGORY_OPTIONS.map((o) => o.value),
  };
}

export async function executeGroceryList(_action, context = {}) {
  const householdId = context?.req?.householdId;
  const rows = await getGroceryItems(householdId);
  const items = (Array.isArray(rows) ? rows : []).map((r) => ({
    name: s(r.name),
    amount: s(r.amount),
    section: s(r.section),
    checked: !!r.checked,
  }));
  return {
    ok: true,
    count: items.length,
    checkedCount: items.filter((i) => i.checked).length,
    items,
  };
}

export async function executePantryList(_action, context = {}) {
  const householdId = context?.req?.householdId;
  const rows = await getPantryItems(householdId);
  const items = (Array.isArray(rows) ? rows : []).map((r) => ({
    name: s(r.name),
    amount: s(r.amount),
    section: s(r.section),
  }));
  return { ok: true, count: items.length, items };
}

export async function executeHouseholdDefaultsGet(_action, context = {}) {
  const householdId = context?.req?.householdId;
  const d = (await getHouseholdDefaults(householdId)) || {};
  return {
    ok: true,
    defaults: {
      defaultDinnerPortions: d.defaultDinnerPortions ?? d.default_dinner_portions ?? null,
      weeknightCookingStyle: d.weeknightCookingStyle ?? d.weeknight_cooking_style ?? null,
    },
  };
}

// This Week's Plan — the meals recorded for THIS chat (= this week's thread). Lets the
// brain recall the plan hundreds of messages later without re-reading the transcript.
export async function executePlanList(_action, context = {}) {
  const householdId = context?.req?.householdId;
  const chatId = context?.chatId;
  const rows = await getMealPlanItems(householdId, chatId);
  const meals = (Array.isArray(rows) ? rows : []).map((r) => ({
    name: s(r.name),
    status: r.status === 'cooked' ? 'cooked' : 'planned',
    note: s(r.note) || undefined,
    recipeTitle: s(r.cookbookTitle) || undefined,
    hasRecipe: !!r.cookbookEntryId,
  }));
  return {
    ok: true,
    count: meals.length,
    plannedCount: meals.filter((m) => m.status !== 'cooked').length,
    cookedCount: meals.filter((m) => m.status === 'cooked').length,
    meals,
  };
}

const THREAD_SEARCH_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'how', 'what', 'was', 'were',
  'is', 'it', 'my', 'our', 'me', 'you', 'do', 'did', 'can', 'we', 'that', 'this', 'i', 'again', 'about',
]);

function threadSearchTokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !THREAD_SEARCH_STOP_WORDS.has(t));
}

function buildThreadSnippet(content, qTokens, radius = 170) {
  const lc = content.toLowerCase();
  let pos = -1;
  for (const t of qTokens) {
    const i = lc.indexOf(t);
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
  }
  if (pos < 0) pos = 0;
  const start = Math.max(0, pos - 40);
  let snippet = content.slice(start, start + radius * 2).replace(/\s+/g, ' ').trim();
  if (start > 0) snippet = `…${snippet}`;
  if (start + radius * 2 < content.length) snippet = `${snippet}…`;
  return snippet;
}

// Deterministic retrieval over THIS chat's messages. ONE BRAIN: the brain decides to
// look back and provides the query; we mechanically rank + return snippets (no side-model).
// This is how the brain recalls arbitrary older detail (a fix, an amount) from a long thread
// without carrying all of it in context — and it narrates what it found, so it is not silent.
export async function executeThreadSearch(action, context = {}) {
  const householdId = context?.req?.householdId;
  const chatId = context?.chatId;
  const input = action?.input && typeof action.input === 'object' && !Array.isArray(action.input) ? action.input : {};
  const query = s(input.query || input.q || input.text);
  if (!query) {
    return { ok: false, status: 'invalid', error: 'Provide a search query for this chat.', results: [] };
  }
  const qTokens = [...new Set(threadSearchTokens(query))];
  if (qTokens.length === 0) {
    return { ok: true, query, count: 0, results: [] };
  }
  const messages = await getMessages(chatId, householdId);
  const total = Array.isArray(messages) ? messages.length : 0;
  const scored = [];
  (Array.isArray(messages) ? messages : []).forEach((m, idx) => {
    const content = String(m?.content ?? '');
    if (!content.trim() || content.trim().startsWith('!')) return;
    const lc = content.toLowerCase();
    let score = 0;
    for (const t of qTokens) if (lc.includes(t)) score += 1;
    if (score > 0) scored.push({ idx, score, m, content });
  });
  scored.sort((a, b) => b.score - a.score || b.idx - a.idx);
  const results = scored.slice(0, 5).map(({ idx, m, content }) => ({
    who: m.role === 'assistant' ? 'KitchenBot' : s(m.name) || s(m.role),
    position: `message ${idx + 1} of ${total}`,
    when: s(m.created_at),
    snippet: buildThreadSnippet(content, qTokens),
  }));
  return { ok: true, query, count: results.length, totalMessages: total, results };
}
