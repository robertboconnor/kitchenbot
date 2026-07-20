import {
  getMealPlanItems,
  addMealPlanItems,
  updateMealPlanItem,
  deleteMealPlanItem,
} from './db.mjs';
import { resolveInventoryItemMatch } from './inventory-item-resolver.mjs';

// ── This Week's Plan executors ──────────────────────────────────────────────────
// ONE BRAIN (KITCHENBOT_BRAIN_CONTRACT.md — "Smart Brain, Dumb Executors"): the brain
// decides what the week's meals are and passes them explicitly; these executors just
// record/read/edit the plan. No side-model, no transcript scan. The plan is a visible,
// user-editable object (a "This Week" panel), so it is never a silent side-channel.

function safeTrim(text) {
  return String(text ?? '').trim();
}

function planInput(runtimeAction) {
  const input = runtimeAction?.input;
  return input && typeof input === 'object' && !Array.isArray(input) ? input : {};
}

function normalizeMealList(raw) {
  const source = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const seen = new Set();
  const meals = [];
  for (const entry of source) {
    const obj = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : { name: entry };
    const name = safeTrim(obj.name);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    meals.push({
      name,
      note: safeTrim(obj.note),
      status: safeTrim(obj.status).toLowerCase() === 'cooked' ? 'cooked' : 'planned',
      ...(Number.isFinite(Number(obj.cookbookEntryId)) && Number(obj.cookbookEntryId) > 0
        ? { cookbookEntryId: Number(obj.cookbookEntryId) }
        : {}),
    });
  }
  return meals;
}

// Resolve which planned meal the brain means (fuzzy: exact → token-containment),
// mirroring how pantry/grocery resolve an item. Returns a pass-through outcome on
// ambiguous/missing so the brain can ask or re-state.
async function resolveMeal(capability, runtimeAction, context) {
  const householdId = context?.req?.householdId;
  const chatId = context?.chatId;
  const input = planInput(runtimeAction);
  const name = safeTrim(input.meal || input.name || input.title);
  if (!name) {
    return { outcome: { capability, status: 'invalid', error: 'Tell me which meal on the plan you mean.' } };
  }
  const meals = await getMealPlanItems(householdId, chatId);
  if (meals.length === 0) {
    return { outcome: { capability, status: 'empty_plan', error: "This week's plan is empty — nothing to change yet." } };
  }
  const resolution = resolveInventoryItemMatch(meals, name);
  if (resolution.status === 'found') return { item: resolution.item, meals };
  if (resolution.status === 'ambiguous') {
    return {
      outcome: {
        capability,
        status: 'ambiguous',
        requestedName: name,
        matches: resolution.matches.map((m) => m.name),
        question: `Which one do you mean: ${resolution.matches.map((m) => m.name).join(', ')}?`,
      },
    };
  }
  return {
    outcome: {
      capability,
      status: 'missing',
      requestedName: name,
      meals: meals.map((m) => m.name),
      error: `"${name}" is not on this week's plan.`,
    },
  };
}

export async function executePlanAdd(runtimeAction, context) {
  const householdId = context?.req?.householdId;
  const chatId = context?.chatId;
  const input = planInput(runtimeAction);
  const meals = normalizeMealList(input.meals || input.items || input.meal || input.name);
  if (meals.length === 0) {
    return {
      capability: 'plan.add',
      status: 'invalid',
      error: 'No meals were provided.',
      note: "Pass the meals for this week's plan as meals: [{ name }] — you decide them.",
    };
  }
  const before = await getMealPlanItems(householdId, chatId);
  const beforeKeys = new Set(before.map((m) => m.normalizedName));
  const addedCount = await addMealPlanItems(householdId, chatId, meals);
  const after = await getMealPlanItems(householdId, chatId);
  const afterByKey = new Map(after.map((m) => [m.normalizedName, m]));

  const addedMeals = [];
  const alreadyOnPlan = [];
  for (const meal of meals) {
    const resolved = resolveInventoryItemMatch(after, meal.name);
    const match = resolved.status === 'found' ? resolved.item : afterByKey.get(meal.name.toLowerCase());
    const key = match?.normalizedName;
    if (key && beforeKeys.has(key)) alreadyOnPlan.push(match.name);
    else addedMeals.push(match?.name || meal.name);
  }

  return {
    capability: 'plan.add',
    status: addedCount > 0 ? 'added' : 'unchanged',
    changed: addedCount > 0,
    addedCount,
    addedMeals,
    alreadyOnPlan,
    meals: after.map((m) => m.name),
    plannedCount: after.filter((m) => m.status !== 'cooked').length,
    cookedCount: after.filter((m) => m.status === 'cooked').length,
  };
}

export async function executePlanUpdate(runtimeAction, context) {
  const resolved = await resolveMeal('plan.update', runtimeAction, context);
  if (!resolved.item) return resolved.outcome;
  const householdId = context?.req?.householdId;
  const chatId = context?.chatId;
  const input = planInput(runtimeAction);

  const fields = {};
  const requestedStatus = safeTrim(input.status).toLowerCase();
  if (requestedStatus === 'cooked' || requestedStatus === 'done' || input.cooked === true) fields.status = 'cooked';
  else if (requestedStatus === 'planned' || input.cooked === false) fields.status = 'planned';
  const newName = safeTrim(input.newName || input.rename);
  if (newName) fields.name = newName;
  if (input.note != null) fields.note = safeTrim(input.note);
  if (Number.isFinite(Number(input.cookbookEntryId)) && Number(input.cookbookEntryId) > 0) {
    fields.cookbookEntryId = Number(input.cookbookEntryId);
  }

  if (Object.keys(fields).length === 0) {
    return { capability: 'plan.update', status: 'invalid', mealName: resolved.item.name, error: 'Nothing to change was specified (status, name, or note).' };
  }
  const changed = await updateMealPlanItem(householdId, chatId, resolved.item.id, fields);
  const after = await getMealPlanItems(householdId, chatId);
  const nowName = fields.name || resolved.item.name;
  const nowRow = after.find((m) => m.id === resolved.item.id) || null;
  return {
    capability: 'plan.update',
    status: changed > 0 ? 'updated' : 'unchanged',
    changed: changed > 0,
    mealName: nowRow?.name || nowName,
    previousName: resolved.item.name,
    newStatus: nowRow?.status || fields.status || resolved.item.status,
    meals: after.map((m) => `${m.name}${m.status === 'cooked' ? ' (cooked)' : ''}`),
  };
}

export async function executePlanRemove(runtimeAction, context) {
  const resolved = await resolveMeal('plan.remove', runtimeAction, context);
  if (!resolved.item) return resolved.outcome;
  const householdId = context?.req?.householdId;
  const chatId = context?.chatId;
  await deleteMealPlanItem(householdId, chatId, resolved.item.id);
  const after = await getMealPlanItems(householdId, chatId);
  return {
    capability: 'plan.remove',
    status: 'removed',
    changed: true,
    mealName: resolved.item.name,
    meals: after.map((m) => m.name),
  };
}
