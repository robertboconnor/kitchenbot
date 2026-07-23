import { executeMemorySave } from './memory-executor.mjs';
import {
  executeCookbookDelete,
  executeCookbookList,
  executeCookbookSave,
  executeCookbookUpdate,
  normalizeCookbookDeleteInput,
  normalizeCookbookSaveInput,
  normalizeCookbookUpdateInput,
} from './cookbook-executor.mjs';
import { previewGroceryListFromConversation, writeGroceryListFromConversation } from './grocery-executor.mjs';
import { executeGroceryCheck, executeGroceryClear, executeGroceryRemove, executeGroceryUncheck, executeGroceryUpdateItem } from './grocery-action-executor.mjs';
import { executeHouseholdDefaultsUpdate } from './household-defaults-executor.mjs';
import { executeGroceryMoveToPantry, executePantryAdd, executePantryMoveToGrocery, executePantryRecategorize, executePantryRemove } from './pantry-executor.mjs';
import { executePlanAdd, executePlanUpdate, executePlanRemove } from './mealplan-executor.mjs';
import { executePersonProfileUpdate } from './person-profile-executor.mjs';
import { executeWebSearch } from './web-search-executor.mjs';
import { executeChatRename, normalizeChatRenameActionInput } from './chat-executor.mjs';
import {
  normalizeMemoryKey,
  normalizeMemoryValue,
} from './kb-memory-policy.mjs';
import { normalizeWorkingContext } from './kb-working-context.mjs';
import { executeGroceryList, executePantryList, executeHouseholdDefaultsGet, executeInventorySections, executePlanList, executeThreadSearch, executePersonProfileGet } from './kb-read-executors.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

function normalizeMemorySaveActionInput(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  // ONE BRAIN: pass through whatever the brain provided; it owns the scope/person decision.
  // A value is required; scope/person/key are optional hints the executor resolves.
  const value = normalizeMemoryValue(
    raw.value || raw.note || raw.summary || raw.preference || raw.fact || raw.memory || raw.payload || raw.text
  );
  if (!value) return null;
  const out = { value };
  const scope = safeTrim(raw.scope).toLowerCase();
  if (scope === 'person' || scope === 'household') out.scope = scope;
  const person = safeTrim(raw.person || raw.label || raw.entity);
  if (person) out.person = person;
  const key = normalizeMemoryKey(raw.key);
  if (key) out.key = key;
  return out;
}

function promptClearlyRequestsDirectGroceryWrite(promptRaw) {
  const text = safeTrim(promptRaw).toLowerCase();
  if (!text) return false;
  const mentionsList = /\b(grocery list|groceries|shopping list|shopping)\b/.test(text);
  const wantsMutation = /\b(add|buy|get|put|write|update|build|make|create|append|replace|clear|remove|take off|need)\b/.test(text);
  return mentionsList && wantsMutation;
}

function normalizeGroceryWriteActionInput(input, context = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = {};
  const groundedCurrentObjectType = safeTrim(context.groundedTurn?.currentObject?.objectType);
  const mode = safeTrim(raw.mode).toLowerCase();
  if (mode && ['append', 'replace'].includes(mode)) out.mode = mode;
  const source = safeTrim(raw.source).toLowerCase();
  if (source) out.source = source;
  if (raw.sourceMealSet && typeof raw.sourceMealSet === 'object' && !Array.isArray(raw.sourceMealSet)) {
    out.sourceMealSet = raw.sourceMealSet;
    out.source = out.source || 'meal_set';
  }
  if (raw.sourceMealSetSelection && typeof raw.sourceMealSetSelection === 'object' && !Array.isArray(raw.sourceMealSetSelection)) {
    out.sourceMealSetSelection = raw.sourceMealSetSelection;
    out.source = out.source || 'meal_set_selection';
  }
  if (raw.sourceGroceryProposal && typeof raw.sourceGroceryProposal === 'object' && !Array.isArray(raw.sourceGroceryProposal)) {
    out.sourceGroceryProposal = raw.sourceGroceryProposal;
    out.source = out.source || 'grocery_proposal';
  }
  if (raw.sourceRecipe && typeof raw.sourceRecipe === 'object' && !Array.isArray(raw.sourceRecipe)) {
    out.sourceRecipe = raw.sourceRecipe;
    out.source = out.source || 'chat_recipe';
  }
  if (Array.isArray(raw.items)) {
    const items = raw.items
      .map((item) => ({
        name: safeTrim(typeof item === 'string' ? item : item?.name),
        amount: safeTrim(item?.amount),
        section: safeTrim(item?.section),
      }))
      .filter((item) => item.name);
    if (items.length > 0) {
      out.items = items;
      // Model-provided explicit items: tag as an explicit add so grocery.write does a
      // clean live-checked add (grocery-executor.mjs:514 short-circuit) instead of the
      // AI meal-planning draft, which re-derives items from the whole conversation and
      // sends the agent loop into a confused retry spiral.
      if (!safeTrim(out.source)) out.source = 'explicit_items';
    }
  }
  const hasStructuredSource =
    !!out.sourceMealSet ||
    !!out.sourceMealSetSelection ||
    !!out.sourceGroceryProposal ||
    !!out.sourceRecipe ||
    ['meal_set', 'meal_set_selection', 'grocery_proposal', 'chat_recipe'].includes(groundedCurrentObjectType);
  if ((!Array.isArray(out.items) || out.items.length === 0) && !hasStructuredSource) {
    const inferredItems = inferExplicitGroceryItemsFromPrompt(context.originalPrompt);
    if (inferredItems.length > 0) {
      out.items = inferredItems;
      out.source = out.source || 'explicit_items';
    }
  }
  const originalPrompt = safeTrim(context.originalPrompt);
  const followUpLooksReferential =
    /\b(all|them|those|these|ingredients?)\b/i.test(originalPrompt) ||
    promptClearlyRequestsDirectGroceryWrite(originalPrompt);
  if ((!Array.isArray(out.items) || out.items.length === 0) && !hasStructuredSource && followUpLooksReferential) {
    const inferredItems = buildIngredientItemsFromWorkingContext(context.workingContext || context.memoryContext?.workingContext);
    if (inferredItems.length > 0) {
      out.items = inferredItems;
      out.source = out.source || 'offered_items';
    }
  }
  if ((!Array.isArray(out.items) || out.items.length === 0) && !safeTrim(out.source) && !promptClearlyRequestsDirectGroceryWrite(originalPrompt)) {
    return null;
  }
  return out;
}

function normalizeGroceryPreviewActionInput() {
  return {};
}

function inferExplicitGroceryItemsFromPrompt(promptRaw) {
  const prompt = safeTrim(promptRaw)
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ');
  if (!prompt) return [];
  const lower = prompt.toLowerCase();
  if (!/\b(grocery list|groceries|shopping list)\b/.test(lower)) return [];
  const match =
    prompt.match(/\b(?:add|buy|get|put|grab|pick up)\s+(.+?)\s+(?:to|on|onto|in)\s+(?:our|my|the)\s+(?:grocery list|groceries|shopping list)\b/i) ||
    prompt.match(/\b(?:add|buy|get|put|grab|pick up)\s+(.+?)\s+(?:to|on|onto|in)\s+(?:the\s+)?list\b/i);
  if (!match) return [];
  const payload = safeTrim(match[1]);
  if (!payload) return [];
  if (/\b(this|that|those|these|it|them|ingredients?|recipe|meal|everything|all of it|all of them|necessary items|needed items)\b/i.test(payload)) {
    return [];
  }
  return payload
    .split(/\s*,\s*|\s+\band\b\s+/i)
    .map((item) => safeTrim(item))
    .filter(Boolean)
    .map((name) => ({ name, amount: '', section: '' }))
    .slice(0, 12);
}

function normalizeEmptyActionInput() {
  return {};
}

function normalizeCookbookListActionInput(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const tag = safeTrim(raw.tag || raw.label || raw.filter);
  return tag ? { tag } : {};
}

function normalizePantryItems(raw) {
  const source = Array.isArray(raw)
    ? raw
    : String(raw ?? '')
        .split(/,|\band\b/gi)
        .map((part) => part.trim());
  const seen = new Set();
  const items = [];
  for (const entry of source) {
    const text = safeTrim(entry).toLowerCase().replace(/\s+/g, ' ');
    if (!text || seen.has(text)) continue;
    seen.add(text);
    items.push(text);
  }
  return items.slice(0, 80);
}

function normalizeWeeknightStyle(raw) {
  const text = safeTrim(raw).toLowerCase();
  if (!text) return null;
  if (['easy', 'normal', 'ambitious'].includes(text)) return text;
  if (/(easy|simple|quick)/.test(text)) return 'easy';
  if (/(ambitious|elaborate|project)/.test(text)) return 'ambitious';
  if (/(normal|balanced|standard)/.test(text)) return 'normal';
  return null;
}

export function inferHouseholdDefaultsUpdateFromPrompt(payloadRaw) {
  const payload = safeTrim(payloadRaw)
    .replace(/^(?:please\s+)?remember\s+that\s+/i, '')
    .replace(/^(?:please\s+)?remember\s+/i, '')
    .replace(/^(?:please\s+)?save\s+(?:this|it|that)\s+to\s+memory\b[.:\s-]*/i, '')
    .replace(/[.!?]+$/, '');
  if (!payload) return null;
  const update = {};

  let match =
    payload.match(/^(?:that\s+)?(?:we|our household)\s+(?:usually\s+)?cook\s+(\d{1,2})\s+portions?(?:\s+for dinner)?$/i) ||
    payload.match(/^(?:that\s+)?(?:we|our household)\s+(?:usually\s+)?make\s+(\d{1,2})\s+portions?(?:\s+for dinner)?$/i);
  if (match) {
    update.defaultDinnerPortions = Math.max(1, Math.min(24, Number(match[1]) || 0)) || null;
  }

  match =
    payload.match(/^(?:on\s+weeknights?,?\s*)?(?:we|our household)\s+(?:prefer|like|want|do)\s+(.+)$/i) ||
    payload.match(/^weeknights?\s+(?:are|should be)\s+(.+)$/i);
  if (match) {
    const style = normalizeWeeknightStyle(match[1]);
    if (style) update.weeknightCookingStyle = style;
  }

  return Object.keys(update).length > 0 ? update : null;
}

function normalizeHouseholdDefaultsActionInput(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const defaults = raw.defaults && typeof raw.defaults === 'object' && !Array.isArray(raw.defaults) ? raw.defaults : raw;
  const update = {};

  const portionsRaw = defaults.defaultDinnerPortions ?? defaults.portions ?? defaults.dinnerPortions;
  if (portionsRaw != null && String(portionsRaw).trim() !== '') {
    const portions = Math.max(1, Math.min(24, Number(portionsRaw) || 0)) || null;
    if (portions) update.defaultDinnerPortions = portions;
  }

  const style = normalizeWeeknightStyle(
    defaults.weeknightCookingStyle ?? defaults.weeknightStyle ?? defaults.cookingStyle
  );
  if (style) update.weeknightCookingStyle = style;

  const payload = safeTrim(raw.payload || raw.text || raw.note || raw.summary || raw.fact || raw.memory);
  if (payload) {
    const inferred = inferHouseholdDefaultsUpdateFromPrompt(payload);
    if (inferred) {
      if (inferred.defaultDinnerPortions) update.defaultDinnerPortions = inferred.defaultDinnerPortions;
      if (inferred.weeknightCookingStyle) update.weeknightCookingStyle = inferred.weeknightCookingStyle;
    }
  }

  return Object.keys(update).length > 0 ? update : null;
}

export function inferPantryAddItemsFromPrompt(payloadRaw) {
  const payload = safeTrim(payloadRaw)
    .replace(/^(?:please\s+)?remember\s+that\s+/i, '')
    .replace(/^(?:please\s+)?remember\s+/i, '')
    .replace(/[.!?]+$/, '');
  if (!payload) return [];
  const match =
    payload.match(/^(?:that\s+)?(?:we|our household|our kitchen)\s+always\s+have\s+(.+)$/i) ||
    payload.match(/^(?:that\s+)?(?:we|our household|our kitchen)\s+always\s+keep\s+(.+)$/i) ||
    payload.match(/^(?:that\s+)?(?:we|our kitchen)\s+(?:usually\s+)?have\s+(.+)\s+on hand$/i);
  return match ? normalizePantryItems(match[1]).map((name) => ({ name, amount: '' })) : [];
}

function normalizePantryAddActionInput(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const directItems = Array.isArray(raw.items)
    ? raw.items
        .map((item) => ({
          name: safeTrim(typeof item === 'string' ? item : item?.name),
          section: safeTrim(item?.section),
          amount: safeTrim(item?.amount),
        }))
        .filter((item) => item.name)
    : [];
  if (directItems.length > 0) return { items: directItems };

  const payload = safeTrim(raw.payload || raw.text || raw.note || raw.summary || raw.fact || raw.memory);
  const inferredItems = inferPantryAddItemsFromPrompt(payload);
  return inferredItems.length > 0 ? { items: inferredItems } : null;
}

function normalizeNameOnlyActionInput(input, context = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const name = safeTrim(raw.name || raw.item || raw.product || raw.payload || raw.text || context.originalPrompt);
  return name ? { name } : null;
}

function normalizePlanAddActionInput(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const source = Array.isArray(raw.meals)
    ? raw.meals
    : Array.isArray(raw.items)
      ? raw.items
      : raw.meal || raw.name
        ? [raw.meal || raw.name]
        : [];
  const meals = [];
  for (const entry of source) {
    const obj = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : { name: entry };
    const name = safeTrim(obj.name || obj.meal || obj.title);
    if (!name) continue;
    meals.push({ name, ...(safeTrim(obj.note) ? { note: safeTrim(obj.note) } : {}) });
  }
  return meals.length > 0 ? { meals } : null;
}

function normalizePlanUpdateActionInput(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const meal = safeTrim(raw.meal || raw.name || raw.title);
  if (!meal) return null;
  const out = { meal };
  const status = safeTrim(raw.status).toLowerCase();
  if (status === 'cooked' || status === 'done' || raw.cooked === true) out.status = 'cooked';
  else if (status === 'planned' || raw.cooked === false) out.status = 'planned';
  const newName = safeTrim(raw.newName || raw.rename);
  if (newName) out.newName = newName;
  if (raw.note != null) out.note = safeTrim(raw.note);
  return out;
}

function normalizePlanRemoveActionInput(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const meal = safeTrim(raw.meal || raw.name || raw.title);
  return meal ? { meal } : null;
}

function normalizeThreadSearchActionInput(input, context = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const query = safeTrim(raw.query || raw.q || raw.text || context.originalPrompt);
  return query ? { query } : null;
}

function normalizePersonProfileUpdateActionInput(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const person = safeTrim(raw.person || raw.name || raw.who);
  if (!person) return null;
  const list = (v) => {
    const source = Array.isArray(v) ? v : v == null || v === '' ? [] : [v];
    return source.map((x) => safeTrim(x)).filter(Boolean);
  };
  const out = { person };
  const accepted = list(raw.acceptedFoods || raw.accepts || raw.likes);
  const rejected = list(raw.rejectedFoods || raw.rejects || raw.dislikes);
  const allergies = list(raw.allergies || raw.allergicTo);
  const notes = list(raw.notes ?? raw.note);
  if (accepted.length) out.acceptedFoods = accepted;
  if (rejected.length) out.rejectedFoods = rejected;
  if (allergies.length) out.allergies = allergies;
  if (notes.length) out.notes = notes;
  return out;
}

function normalizePersonProfileGetActionInput(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const person = safeTrim(raw.person || raw.name || raw.who);
  return person ? { person } : {};
}

function normalizeGroceryUpdateItemActionInput(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const name = safeTrim(raw.name || raw.item || raw.product);
  if (!name) return null;
  const out = { name };
  const amount = safeTrim(raw.amount ?? raw.quantity ?? raw.qty);
  if (amount) out.amount = amount;
  if (typeof raw.checked === 'boolean') out.checked = raw.checked;
  else if (typeof raw.bought === 'boolean') out.checked = raw.bought;
  const section = safeTrim(raw.section || raw.category);
  if (section) out.section = section;
  return out;
}

function normalizePantryRecategorizeActionInput(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const name = safeTrim(raw.name || raw.item || raw.product);
  const section = safeTrim(raw.section || raw.category);
  if (!name || !section) return null;
  return { name, section };
}

function normalizeWebSearchActionInput(input, context = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const workingContext = normalizeWorkingContext(context.workingContext || context.memoryContext?.workingContext);
  const originalPrompt = safeTrim(context.originalPrompt);
  const fallbackPrompt = /\b(search|look up|lookup|google|find)\b/i.test(originalPrompt) ? '' : originalPrompt;
  const query = safeTrim(
    raw.query ||
    raw.topic ||
    raw.search ||
    raw.payload ||
    raw.text ||
    (workingContext?.offeredSearchTopic && /\b(search|look up|lookup|google|find|that|it|just that|sure)\b/i.test(originalPrompt)
      ? workingContext.offeredSearchTopic
      : fallbackPrompt)
  );
  return query ? { query } : null;
}

function isAffirmativeFollowUp(prompt) {
  const text = safeTrim(prompt).toLowerCase();
  if (!text) return false;
  return /^(yes|yeah|yep|sure|ok|okay|do it|go ahead|all|that|just that|search it|search that|add them|add it|those)$/i.test(text) ||
    /\b(search the web|look it up|look that up|add them|add those|add all|all of them)\b/.test(text);
}

function buildIngredientItemsFromWorkingContext(workingContext) {
  const context = normalizeWorkingContext(workingContext);
  return (Array.isArray(context?.offeredIngredients) ? context.offeredIngredients : [])
    .map((name) => ({ name: safeTrim(name), amount: '', section: '' }))
    .filter((item) => item.name);
}

export const KB_SKILLS = {
  'memory.save': {
    id: 'memory.save',
    description: 'Save a memory to the right household or person record.',
    narrationType: 'memory.save',
    contextProfile: {},
    interpreterDescription:
      'Save durable household or person memory when the user clearly wants KitchenBot to remember something.',
    exampleAction: {
      capability: 'memory.save',
      input: { key: 'rob_preferences', value: "doesn't like beets" },
    },
    normalizeActionInput: normalizeMemorySaveActionInput,
    execute: executeMemorySave,
  },
  'cookbook.save': {
    id: 'cookbook.save',
    description:
      'Save a recipe to the household cookbook. Pass the recipe itself in `recipe` {title, ingredients[], instructions[]} — the one you just wrote or the user gave you. For a recipe URL or pasted recipe text, put that in `request` and I will fetch/parse it. Do not expect me to re-read the chat to reconstruct the recipe.',
    narrationType: 'cookbook.save',
    contextProfile: {
      includeDefaults: true,
      includeCookbook: true,
      includeWorkingContext: true,
    },
    interpreterDescription:
      'Save a recipe into the household cookbook when the user clearly asks to save it. Provide the recipe in `recipe`; use `request` for a URL or pasted text.',
    exampleAction: {
      capability: 'cookbook.save',
      input: {
        recipe: {
          title: 'Garlic Butter Shrimp Pasta',
          ingredients: ['12 oz linguine', '1 lb shrimp', '4 tbsp butter', '4 cloves garlic'],
          instructions: ['Boil the linguine.', 'Sauté garlic in butter, add shrimp.', 'Toss with pasta and serve.'],
        },
      },
    },
    normalizeActionInput: normalizeCookbookSaveInput,
    execute: executeCookbookSave,
  },
  'cookbook.update': {
    id: 'cookbook.update',
    description: 'Replace a saved cookbook recipe with an explicitly revised version.',
    narrationType: 'cookbook.update',
    contextProfile: {
      includeCookbook: true,
      includeWorkingContext: true,
    },
    interpreterDescription:
      'Update an existing saved cookbook recipe when the user explicitly asks to replace, update, or save a revised version of that saved entry.',
    exampleAction: {
      capability: 'cookbook.update',
      input: { request: 'replace that saved recipe with the revised version' },
    },
    normalizeActionInput: normalizeCookbookUpdateInput,
    execute: executeCookbookUpdate,
  },
  'cookbook.list': {
    id: 'cookbook.list',
    description: 'List the recipes and meal ideas saved in the household cookbook.',
    narrationType: 'cookbook.list',
    contextProfile: {
      includeCookbook: true,
    },
    interpreterDescription:
      'List saved cookbook entries (with their titles and tags) when the user asks what recipes or saved meals are in the cookbook. Pass a `tag` to filter to just those labeled recipes, e.g. tag "kid-approved".',
    exampleAction: {
      capability: 'cookbook.list',
      input: { tag: 'kid-approved' },
    },
    normalizeActionInput: normalizeCookbookListActionInput,
    execute: executeCookbookList,
  },
  'cookbook.delete': {
    id: 'cookbook.delete',
    description: 'Delete a saved recipe or meal idea from the household cookbook.',
    narrationType: 'cookbook.delete',
    contextProfile: {
      includeCookbook: true,
    },
    interpreterDescription:
      'Delete a saved cookbook entry when the user clearly says to remove or delete a recipe from the household cookbook.',
    exampleAction: {
      capability: 'cookbook.delete',
      input: { name: 'Lemony Orzo Chicken Skillet' },
    },
    normalizeActionInput: normalizeCookbookDeleteInput,
    execute: executeCookbookDelete,
  },
  'chat.rename': {
    id: 'chat.rename',
    description: 'Rename the current chat, either to an exact title or a fresh context-aware one.',
    narrationType: 'chat.rename',
    contextProfile: {},
    interpreterDescription:
      'Rename the current chat when the user explicitly asks to rename or retitle this chat. If they provide a title, use it exactly. If they just ask to rename the chat, generate a fresh short title from the current conversation context.',
    exampleAction: {
      capability: 'chat.rename',
      input: { request: 'rename this chat to Cod And Asparagus Plan' },
    },
    normalizeActionInput: normalizeChatRenameActionInput,
    execute: executeChatRename,
  },
  'grocery.write': {
    id: 'grocery.write',
    description: 'Write grocery items into the household grocery list based on the conversation.',
    narrationType: 'grocery.write',
    contextProfile: {
      includeDefaults: true,
      includeCookbook: true,
      includePantry: true,
      includeGrocery: true,
      includeWorkingContext: true,
    },
    interpreterDescription:
      'Add items to the household grocery list (or replace it) when the user clearly wants list changes. Adds NEW items and merges duplicates. To change the QUANTITY of an item already on the list, or to put a bought item back on the active list, use grocery.update_item instead — grocery.write will not change the amount of an item that is already marked bought.',
    exampleAction: {
      capability: 'grocery.write',
      input: {},
    },
    normalizeActionInput: normalizeGroceryWriteActionInput,
    execute: writeGroceryListFromConversation,
  },
  'grocery.preview': {
    id: 'grocery.preview',
    description: 'Show a grocery list draft for the current meals without changing the tab.',
    narrationType: 'grocery.preview',
    contextProfile: {
      includeDefaults: true,
      includeCookbook: true,
      includePantry: true,
      includeGrocery: true,
      includeWorkingContext: true,
    },
    interpreterDescription:
      'Show a grocery list draft for the current meals or plan without changing the grocery tab.',
    exampleAction: {
      capability: 'grocery.preview',
      input: {},
    },
    normalizeActionInput: normalizeGroceryPreviewActionInput,
    execute: previewGroceryListFromConversation,
  },
  'grocery.remove': {
    id: 'grocery.remove',
    description: 'Remove an item from the Grocery List tab.',
    narrationType: 'grocery.remove',
    contextProfile: {
      includeGrocery: true,
    },
    interpreterDescription:
      'Remove or delete an item from the Grocery List tab when the user clearly wants that item taken off the list.',
    exampleAction: {
      capability: 'grocery.remove',
      input: { name: 'apples' },
    },
    normalizeActionInput: normalizeNameOnlyActionInput,
    execute: executeGroceryRemove,
  },
  'grocery.check': {
    id: 'grocery.check',
    description: 'Mark a Grocery List tab item as bought or checked off.',
    narrationType: 'grocery.check',
    contextProfile: {
      includeGrocery: true,
    },
    interpreterDescription:
      'Check off or mark a Grocery List tab item as bought when the user clearly wants it marked done.',
    exampleAction: {
      capability: 'grocery.check',
      input: { name: 'eggs' },
    },
    normalizeActionInput: normalizeNameOnlyActionInput,
    execute: executeGroceryCheck,
  },
  'grocery.uncheck': {
    id: 'grocery.uncheck',
    description: 'Mark a Grocery List tab item as not yet bought.',
    narrationType: 'grocery.uncheck',
    contextProfile: {
      includeGrocery: true,
    },
    interpreterDescription:
      'Uncheck or mark a Grocery List tab item as not done when the user clearly wants it put back on the active list.',
    exampleAction: {
      capability: 'grocery.uncheck',
      input: { name: 'eggs' },
    },
    normalizeActionInput: normalizeNameOnlyActionInput,
    execute: executeGroceryUncheck,
  },
  'grocery.update_item': {
    id: 'grocery.update_item',
    description: 'Change the quantity of an item already on the Grocery List tab, or put a bought item back on the active list.',
    narrationType: 'grocery.update_item',
    contextProfile: {
      includeGrocery: true,
    },
    interpreterDescription:
      'Update an item ALREADY on the Grocery List tab: set a new amount and/or change whether it is checked off (bought). Use this to change a quantity ("make the eggs a dozen") or to un-check a bought item and put it back on the active list. This does NOT add new items — use grocery.write to add. Unlike grocery.write, it CAN change the amount of an item that is already marked as bought.',
    exampleAction: {
      capability: 'grocery.update_item',
      input: { name: 'eggs', amount: '12', checked: false },
    },
    normalizeActionInput: normalizeGroceryUpdateItemActionInput,
    execute: executeGroceryUpdateItem,
  },
  'grocery.clear': {
    id: 'grocery.clear',
    description: 'Clear the entire Grocery List tab.',
    narrationType: 'grocery.clear',
    contextProfile: {
      includeGrocery: true,
    },
    interpreterDescription:
      'Clear or wipe the entire Grocery List tab when the user clearly wants the full list emptied.',
    exampleAction: {
      capability: 'grocery.clear',
      input: {},
    },
    normalizeActionInput: normalizeEmptyActionInput,
    execute: executeGroceryClear,
  },
  'household.defaults.update': {
    id: 'household.defaults.update',
    description: 'Update structured household defaults like dinner portions and weeknight cooking style.',
    narrationType: 'household.defaults.update',
    contextProfile: {
      includeDefaults: true,
    },
    interpreterDescription:
      'Update structured household defaults when the user clearly sets default dinner portions or weeknight cooking style.',
    exampleAction: {
      capability: 'household.defaults.update',
      input: { defaultDinnerPortions: 4, weeknightCookingStyle: 'easy' },
    },
    normalizeActionInput: normalizeHouseholdDefaultsActionInput,
    execute: executeHouseholdDefaultsUpdate,
  },
  'pantry.add': {
    id: 'pantry.add',
    description: 'Add household items to the Pantry.',
    narrationType: 'pantry.add',
    contextProfile: {
      includePantry: true,
    },
    interpreterDescription:
      'Add on-hand household items to the Pantry when the user says they always have or keep certain staples around.',
    exampleAction: {
      capability: 'pantry.add',
      input: { items: [{ name: 'olive oil' }, { name: 'cumin' }] },
    },
    normalizeActionInput: normalizePantryAddActionInput,
    execute: executePantryAdd,
  },
  'pantry.remove': {
    id: 'pantry.remove',
    description: 'Remove an item from the Pantry.',
    narrationType: 'pantry.remove',
    contextProfile: {
      includePantry: true,
    },
    interpreterDescription:
      'Remove a Pantry item when the user clearly says to remove, delete, or take something out of the Pantry.',
    exampleAction: {
      capability: 'pantry.remove',
      input: { name: 'polenta' },
    },
    normalizeActionInput: normalizeNameOnlyActionInput,
    execute: executePantryRemove,
  },
  'pantry.recategorize': {
    id: 'pantry.recategorize',
    description: 'Re-file a Pantry item into a different section/category.',
    narrationType: 'pantry.recategorize',
    contextProfile: {
      includePantry: true,
    },
    interpreterDescription:
      'Move a Pantry item into a different section (recategorize it) — e.g. file "flour tortillas" under pasta_grains_dry_goods instead of baking. Use this to reorganize or clean up how pantry items are sorted; it changes an existing item\'s section directly (no need to remove and re-add). Valid pantry sections: spices_herbs, oils_vinegars, baking, sweeteners, condiments_sauces, pasta_grains_dry_goods, other_pantry.',
    exampleAction: {
      capability: 'pantry.recategorize',
      input: { name: 'flour tortillas', section: 'pasta_grains_dry_goods' },
    },
    normalizeActionInput: normalizePantryRecategorizeActionInput,
    execute: executePantryRecategorize,
  },
  'pantry.move_to_grocery': {
    id: 'pantry.move_to_grocery',
    description: 'Move an item from the Pantry to the Grocery List tab.',
    narrationType: 'pantry.move_to_grocery',
    contextProfile: {
      includePantry: true,
      includeGrocery: true,
    },
    interpreterDescription:
      'Move a pantry item to the Grocery List tab when the user says they ran out of it or wants to buy it.',
    exampleAction: {
      capability: 'pantry.move_to_grocery',
      input: { name: 'olive oil' },
    },
    normalizeActionInput: normalizeNameOnlyActionInput,
    execute: executePantryMoveToGrocery,
  },
  'grocery.move_to_pantry': {
    id: 'grocery.move_to_pantry',
    description: 'Move a Grocery List tab item into the Pantry after it has been bought.',
    narrationType: 'grocery.move_to_pantry',
    contextProfile: {
      includePantry: true,
      includeGrocery: true,
    },
    interpreterDescription:
      'Move a Grocery List tab item into the Pantry when the user says they bought it or wants to treat it as on hand.',
    exampleAction: {
      capability: 'grocery.move_to_pantry',
      input: { name: 'olive oil' },
    },
    normalizeActionInput: normalizeNameOnlyActionInput,
    execute: executeGroceryMoveToPantry,
  },
  'web.search': {
    id: 'web.search',
    description: 'Search the live web for outside or current information when household web search is enabled.',
    narrationType: 'web.search',
    contextProfile: {
      includeDefaults: true,
      includeCookbook: true,
      includeWorkingContext: true,
    },
    interpreterDescription:
      'Search the live web for current or outside information when the household has web search enabled and the request clearly needs it.',
    exampleAction: {
      capability: 'web.search',
      input: { query: 'Masters Champions Dinner menu traditions' },
    },
    normalizeActionInput: normalizeWebSearchActionInput,
    execute: executeWebSearch,
  },
  'grocery.list': {
    id: 'grocery.list',
    description: 'Read the current household grocery list.',
    narrationType: 'grocery.list',
    contextProfile: { includeGrocery: true },
    interpreterDescription:
      'Read the current grocery list to see what is already on it — check this before answering questions about the list or before adding an item that might already be there.',
    exampleAction: { capability: 'grocery.list', input: {} },
    normalizeActionInput: normalizeEmptyActionInput,
    execute: executeGroceryList,
  },
  'pantry.list': {
    id: 'pantry.list',
    description: 'Read the current household pantry (tracked staples on hand).',
    narrationType: 'pantry.list',
    contextProfile: { includePantry: true },
    interpreterDescription:
      'Read the current pantry to see which staples the household already keeps on hand.',
    exampleAction: { capability: 'pantry.list', input: {} },
    normalizeActionInput: normalizeEmptyActionInput,
    execute: executePantryList,
  },
  'household.defaults.get': {
    id: 'household.defaults.get',
    description: 'Read structured household defaults (dinner portions, weeknight cooking style).',
    narrationType: 'household.defaults.get',
    contextProfile: { includeDefaults: true },
    interpreterDescription:
      'Read the household defaults (default dinner portions, weeknight cooking style) when they matter for planning.',
    exampleAction: { capability: 'household.defaults.get', input: {} },
    normalizeActionInput: normalizeEmptyActionInput,
    execute: executeHouseholdDefaultsGet,
  },
  'inventory.sections': {
    id: 'inventory.sections',
    description: 'Read the canonical list of valid grocery sections, pantry sections, and cookbook categories.',
    narrationType: 'inventory.sections',
    contextProfile: {},
    interpreterDescription:
      'Read the fixed master list of valid grocery sections, pantry sections, and cookbook categories. Use this when asked what categories exist, or before recategorizing/placing an item, so you use a real valid section — not just the ones currently in use.',
    exampleAction: { capability: 'inventory.sections', input: {} },
    normalizeActionInput: normalizeEmptyActionInput,
    execute: executeInventorySections,
  },
  'plan.list': {
    id: 'plan.list',
    description: "Read this week's meal plan (the meals recorded for this chat).",
    narrationType: 'plan.list',
    contextProfile: {},
    interpreterDescription:
      "Read THIS week's meal plan — the meals recorded for this chat and each one's status (planned/cooked). Use this to recall what the household is cooking this week or which meal the user means, especially deep in a long thread where the plan was set much earlier.",
    exampleAction: { capability: 'plan.list', input: {} },
    normalizeActionInput: normalizeEmptyActionInput,
    execute: executePlanList,
  },
  'plan.add': {
    id: 'plan.add',
    description: "Record meals into this week's plan (shown in the This Week panel).",
    narrationType: 'plan.add',
    contextProfile: {},
    interpreterDescription:
      "Record the meals you and the user settled on into THIS week's plan so the household sees them in the This Week panel and you can recall them later in a long thread. YOU decide the meals and pass them.",
    exampleAction: {
      capability: 'plan.add',
      input: { meals: [{ name: 'Cod with corn & lima bean succotash' }, { name: 'Chicken piccata' }] },
    },
    normalizeActionInput: normalizePlanAddActionInput,
    execute: executePlanAdd,
  },
  'plan.update': {
    id: 'plan.update',
    description: "Update a meal on this week's plan — mark it cooked, rename it, or note it.",
    narrationType: 'plan.update',
    contextProfile: {},
    interpreterDescription:
      "Update a meal already on this week's plan: mark it cooked once the household makes it, rename it, or add a short note. Identify the meal by name.",
    exampleAction: { capability: 'plan.update', input: { meal: 'cod succotash', status: 'cooked' } },
    normalizeActionInput: normalizePlanUpdateActionInput,
    execute: executePlanUpdate,
  },
  'plan.remove': {
    id: 'plan.remove',
    description: "Remove a meal from this week's plan.",
    narrationType: 'plan.remove',
    contextProfile: {},
    interpreterDescription: "Remove a meal from this week's plan when the household drops it.",
    exampleAction: { capability: 'plan.remove', input: { meal: 'chicken piccata' } },
    normalizeActionInput: normalizePlanRemoveActionInput,
    execute: executePlanRemove,
  },
  'thread.search': {
    id: 'thread.search',
    description: 'Search earlier messages in THIS chat for something no longer in your recent context.',
    narrationType: 'thread.search',
    contextProfile: {},
    interpreterDescription:
      'Search earlier messages in THIS chat when the user refers to something from much earlier in a long thread that is no longer in your recent context — an amount, a fix, a decision made many messages ago. Give a focused query; you get the most relevant snippets back. Tell the user what you found.',
    exampleAction: { capability: 'thread.search', input: { query: 'lemon juice amount' } },
    normalizeActionInput: normalizeThreadSearchActionInput,
    execute: executeThreadSearch,
  },
  'person.profile.update': {
    id: 'person.profile.update',
    description: "Record structured food facts about a household member (accepted/rejected foods, allergies, notes).",
    narrationType: 'person.profile.update',
    contextProfile: {},
    interpreterDescription:
      "Record structured facts about a specific person's eating: foods they accept or reject, allergies, or a short note. Use THIS (not memory.save) for a household member's food preferences and allergies so it stays queryable. Foods accumulate; marking a food accepted removes it from rejected and vice versa.",
    exampleAction: {
      capability: 'person.profile.update',
      input: { person: 'Bizzy', acceptedFoods: ['creamy lemon rice with hot dog'], allergies: ['peanuts'] },
    },
    normalizeActionInput: normalizePersonProfileUpdateActionInput,
    execute: executePersonProfileUpdate,
  },
  'person.profile.get': {
    id: 'person.profile.get',
    description: "Read a household member's structured food profile (accepted/rejected foods, allergies, notes).",
    narrationType: 'person.profile.get',
    contextProfile: {},
    interpreterDescription:
      "Read a person's structured food profile — what they accept, reject, are allergic to, and notes — to plan meals that work for them or answer \"what does X eat?\". Omit person to see every household member's profile.",
    exampleAction: { capability: 'person.profile.get', input: { person: 'Bizzy' } },
    normalizeActionInput: normalizePersonProfileGetActionInput,
    execute: executePersonProfileGet,
  },
};

export function getKbSkill(capability) {
  return KB_SKILLS[String(capability ?? '').trim()] || null;
}

export function listKbSkills() {
  return Object.values(KB_SKILLS);
}

function filterSkillsForInterpreter(skills, opts = {}) {
  return (Array.isArray(skills) ? skills : []).filter((skill) => {
    if (!skill) return false;
    if (skill.id === 'web.search' && !opts.webSearchEnabled) return false;
    return true;
  });
}

export function buildKbInterpreterSkillList(opts = {}) {
  const skills = filterSkillsForInterpreter(listKbSkills(), opts);
  return skills
    .map((skill) => `${skill.id}: ${skill.interpreterDescription || skill.description}`)
    .join('\n');
}

export function buildKbInterpreterActionExamples(opts = {}) {
  const skills = filterSkillsForInterpreter(listKbSkills(), opts);
  return skills
    .map((skill) => JSON.stringify(skill.exampleAction))
    .concat([
      JSON.stringify({ capability: 'grocery.write', input: { items: [{ name: 'powdered sugar' }], source: 'explicit_items' } }),
      JSON.stringify({ capability: 'grocery.write', input: { mode: 'replace' } }),
    ])
    .join('\n');
}

export function mergeKbContextProfiles(...profiles) {
  const out = {
    includeDefaults: false,
    includeCookbook: false,
    includePantry: false,
    includeGrocery: false,
    includeWorkingContext: false,
  };
  for (const profile of profiles) {
    if (!profile || typeof profile !== 'object') continue;
    if (profile.includeDefaults) out.includeDefaults = true;
    if (profile.includeCookbook) out.includeCookbook = true;
    if (profile.includePantry) out.includePantry = true;
    if (profile.includeGrocery) out.includeGrocery = true;
    if (profile.includeWorkingContext) out.includeWorkingContext = true;
  }
  return out;
}

export function getKbContextProfileForActions(actions) {
  const list = Array.isArray(actions) ? actions : [];
  return mergeKbContextProfiles(
    ...list.map((action) => getKbSkill(action?.capability)?.contextProfile || null)
  );
}

function findGroundedObject(groundedTurn, predicate) {
  const objects = Array.isArray(groundedTurn?.activeObjects) ? groundedTurn.activeObjects : [];
  return objects.find((object) => predicate(object)) || null;
}

function applyGroundedSkillInput(capability, input, context = {}) {
  const groundedTurn = context.groundedTurn && typeof context.groundedTurn === 'object' ? context.groundedTurn : null;
  if (!groundedTurn) return input;
  const out = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
  const currentObject = groundedTurn.currentObject && typeof groundedTurn.currentObject === 'object' ? groundedTurn.currentObject : null;

  if (capability === 'cookbook.save' && !out.targetRecipe && currentObject?.objectType === 'chat_recipe') {
    out.targetRecipe = {
      type: 'chat_recipe',
      title: safeTrim(currentObject.title),
      label: safeTrim(currentObject.title || currentObject.versionSummary),
      recipeText: safeTrim(currentObject.recipeText),
      recipeRecord: currentObject.recipeRecord,
    };
  }

  if (capability === 'cookbook.update') {
    const targetEntry = findGroundedObject(groundedTurn, (object) => object?.type === 'cookbook_entry');
    if (targetEntry) {
      if (!Number.isFinite(Number(out.id)) && Number.isFinite(Number(targetEntry.id))) out.id = Number(targetEntry.id);
      if (!safeTrim(out.name) && safeTrim(targetEntry.title || targetEntry.label)) out.name = safeTrim(targetEntry.title || targetEntry.label);
      if (!out.targetCookbookEntry) out.targetCookbookEntry = targetEntry;
    }
    if (!out.targetRecipe && currentObject?.objectType === 'chat_recipe') {
      out.targetRecipe = {
        type: 'chat_recipe',
        title: safeTrim(currentObject.title),
        label: safeTrim(currentObject.title || currentObject.versionSummary),
        recipeText: safeTrim(currentObject.recipeText),
        recipeRecord: currentObject.recipeRecord,
      };
    }
  }

  if (capability.startsWith('grocery.') && !safeTrim(out.targetList)) {
    const targetList = findGroundedObject(groundedTurn, (object) => object?.type === 'grocery_list');
    if (targetList) out.targetList = 'household_grocery_list';
  }
  if (capability === 'grocery.write') {
    if (!out.sourceRecipe && currentObject?.objectType === 'chat_recipe') {
      out.sourceRecipe = {
        type: 'chat_recipe',
        title: safeTrim(currentObject.title),
        label: safeTrim(currentObject.title || currentObject.versionSummary),
        recipeText: safeTrim(currentObject.recipeText),
        recipeRecord: currentObject.recipeRecord,
      };
      out.source = safeTrim(out.source || 'chat_recipe');
    }
    if (!out.sourceMealSet && currentObject?.objectType === 'meal_set') {
      out.sourceMealSet = currentObject;
      out.source = safeTrim(out.source || 'meal_set');
    }
    if (!out.sourceMealSetSelection && currentObject?.objectType === 'meal_set_selection') {
      out.sourceMealSetSelection = currentObject;
      out.source = safeTrim(out.source || 'meal_set_selection');
    }
    if (!out.sourceGroceryProposal && currentObject?.objectType === 'grocery_proposal') {
      out.sourceGroceryProposal = currentObject;
      out.source = safeTrim(out.source || 'grocery_proposal');
    }
  }

  if (capability.startsWith('pantry.') && !safeTrim(out.targetPantry)) {
    const pantry = findGroundedObject(groundedTurn, (object) => object?.type === 'pantry_item_or_list');
    if (pantry) out.targetPantry = 'household_pantry';
  }

  if (capability === 'memory.save' && !safeTrim(out.targetEntity)) {
    const entity = findGroundedObject(groundedTurn, (object) => object?.type === 'memory_entity');
    if (entity) out.targetEntity = safeTrim(entity.label);
  }

  if (capability === 'chat.rename' && !Number.isFinite(Number(out.targetChatId))) {
    const chatThread = findGroundedObject(groundedTurn, (object) => object?.type === 'chat_thread');
    if (chatThread && Number.isFinite(Number(chatThread.id))) out.targetChatId = Number(chatThread.id);
  }

  return out;
}

export function normalizeKbSkillAction(action, context = {}) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
  const capability = safeTrim(action.capability);
  if (!capability) return null;
  const skill = getKbSkill(capability);
  if (!skill) return null;
  if (capability === 'web.search' && !context.webSearchEnabled) return null;
  const input = skill.normalizeActionInput ? skill.normalizeActionInput(action.input, context) : action.input ?? {};
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return null;
  return { capability, input: applyGroundedSkillInput(capability, input, context) };
}

export function buildKbHelpText() {
  const skillDescriptions = Object.values(KB_SKILLS).map((skill, index) => `${index + 1}. ${skill.description}`);
  return [
    'I can help in these ways right now:',
    ...skillDescriptions,
    `${skillDescriptions.length + 1}. Talk things through and help you think.`,
    '',
    'I do not silently change the app. If I changed memory or the grocery list, I will say so plainly.',
  ].join('\n');
}
