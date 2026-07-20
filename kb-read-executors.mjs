// kb-read-executors.mjs
// Pass 2 "context as cognition": read-only tools the brain calls ON DEMAND to
// see live household state, instead of us pre-injecting pantry/grocery/defaults
// into every prompt. Each returns a compact { ok, ... } outcome that
// summarizeOutcomeForModel (kb-tools.mjs) hands back as the tool_result.
import { getGroceryItems, getPantryItems, getHouseholdDefaults } from './db.mjs';

function s(v) {
  return String(v ?? '').trim();
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
