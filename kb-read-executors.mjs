// kb-read-executors.mjs
// Pass 2 "context as cognition": read-only tools the brain calls ON DEMAND to
// see live household state, instead of us pre-injecting pantry/grocery/defaults
// into every prompt. Each returns a compact { ok, ... } outcome that
// summarizeOutcomeForModel (kb-tools.mjs) hands back as the tool_result.
import { getGroceryItems, getPantryItems, getHouseholdDefaults } from './db.mjs';
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
