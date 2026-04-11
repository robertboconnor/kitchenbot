import { executeMemorySave } from './memory-executor.mjs';
import { previewGroceryListFromConversation, writeGroceryListFromConversation } from './grocery-executor.mjs';
import { executeGroceryCheck, executeGroceryClear, executeGroceryRemove, executeGroceryUncheck } from './grocery-action-executor.mjs';
import { executeHouseholdDefaultsUpdate } from './household-defaults-executor.mjs';
import { executeMealRefine } from './meal-refine-executor.mjs';
import { executeGroceryMoveToPantry, executePantryAdd, executePantryMoveToGrocery, executePantryRemove } from './pantry-executor.mjs';
import {
  inferMemoryKeyAndValue,
  normalizeMemoryKey,
  normalizeMemoryValue,
} from './kb-memory-policy.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

function normalizeMemorySaveActionInput(input, context = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const directKey = normalizeMemoryKey(raw.key);
  const directValue = normalizeMemoryValue(raw.value);
  if (directKey && directValue) {
    return { key: directKey, value: directValue };
  }

  const person = safeTrim(raw.person || raw.label || raw.entity);
  const personNote = normalizeMemoryValue(raw.note || raw.summary || raw.preference || raw.fact);
  if (person && personNote) {
    return {
      key: normalizeMemoryKey(`${person}_preferences`),
      value: personNote,
    };
  }

  const payload = safeTrim(raw.payload || raw.text || raw.note || raw.summary || raw.fact || raw.memory);
  if (payload) {
    return inferMemoryKeyAndValue(payload, context.memoriesByKey, {
      activeSpeakerName: context.activeSpeakerName,
    });
  }

  return null;
}

function normalizeGroceryWriteActionInput(input) {
  const mode = safeTrim(input?.mode).toLowerCase();
  return mode && ['append', 'replace', 'prune'].includes(mode) ? { mode } : {};
}

function normalizeGroceryPreviewActionInput() {
  return {};
}

function normalizeEmptyActionInput() {
  return {};
}

function normalizeMealRefineActionInput(input, context = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const request = safeTrim(raw.request || raw.payload || raw.text || raw.change || raw.refinement || context.originalPrompt);
  return request ? { request } : null;
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
  'grocery.write': {
    id: 'grocery.write',
    description: 'Write grocery items into the household grocery list based on the conversation.',
    narrationType: 'grocery.write',
    contextProfile: {
      includeDefaults: true,
      includePantry: true,
      includeGrocery: true,
      includeWorkingContext: true,
    },
    interpreterDescription:
      'Generate or update the household grocery list when the user clearly wants list changes.',
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
  'meal.refine': {
    id: 'meal.refine',
    description: 'Revise the current meal ideas or dinner thread for this chat.',
    narrationType: 'meal.refine',
    contextProfile: {
      includeDefaults: true,
      includeWorkingContext: true,
    },
    interpreterDescription:
      'Revise the current meal ideas in this chat when the user asks to swap, tweak, redo, or adjust one of the meals under discussion.',
    exampleAction: {
      capability: 'meal.refine',
      input: { request: 'make one of those vegetarian' },
    },
    normalizeActionInput: normalizeMealRefineActionInput,
    execute: executeMealRefine,
  },
};

export function getKbSkill(capability) {
  return KB_SKILLS[String(capability ?? '').trim()] || null;
}

export function listKbSkills() {
  return Object.values(KB_SKILLS);
}

export function buildKbInterpreterSkillList() {
  return listKbSkills()
    .map((skill) => `${skill.id}: ${skill.interpreterDescription || skill.description}`)
    .join('\n');
}

export function buildKbInterpreterActionExamples() {
  return listKbSkills()
    .map((skill) => JSON.stringify(skill.exampleAction))
    .join('\n');
}

export function mergeKbContextProfiles(...profiles) {
  const out = {
    includeDefaults: false,
    includePantry: false,
    includeGrocery: false,
    includeWorkingContext: false,
  };
  for (const profile of profiles) {
    if (!profile || typeof profile !== 'object') continue;
    if (profile.includeDefaults) out.includeDefaults = true;
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

export function normalizeKbSkillAction(action, context = {}) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
  const capability = safeTrim(action.capability);
  if (!capability) return null;
  const skill = getKbSkill(capability);
  if (!skill) return null;
  const input = skill.normalizeActionInput ? skill.normalizeActionInput(action.input, context) : action.input ?? {};
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return null;
  return { capability, input };
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

export async function executeKbActions(actions, context) {
  const list = Array.isArray(actions) ? actions : [];
  const outcomes = [];
  let nextWorkingContext = null;

  await context.deps.addMessage(context.chatId, context.req.householdId, 'user', context.name, context.prompt);
  await context.deps.incrementUserMessageCountForSender?.(context.req);
  context.deps.broadcastToChat?.(context.chatId, {
    type: 'chat_updated',
    householdId: context.req.householdId,
    chatId: context.chatId,
    user: context.name,
  });

  for (const action of list) {
    const id = String(action?.capability ?? '').trim();
    const skill = getKbSkill(id);
    if (!skill) {
      return {
        replyText: "I couldn't turn that into one of my available actions.",
        outcomes,
        userMessageAlreadyPersisted: true,
      };
    }
    const outcome = await skill.execute(action, {
      ...context,
      userMessageAlreadyPersisted: true,
      runtimeManagedResponse: true,
      kbModeEnabled: true,
    });
    if (outcome && typeof outcome === 'object' && !Array.isArray(outcome) && !outcome.narrationType) {
      outcome.narrationType = skill.narrationType || skill.id;
    }
    if (outcome?.workingContext && typeof outcome.workingContext === 'object' && !Array.isArray(outcome.workingContext)) {
      nextWorkingContext = outcome.workingContext;
    }
    outcomes.push(outcome);
    if (outcome?.proposedNextAction) {
      return {
        replyPlan: {
          kind: 'skill_outcomes',
          outcomes,
        },
        proposedNextAction: outcome.proposedNextAction,
        workingContext: nextWorkingContext,
        outcomes,
        userMessageAlreadyPersisted: true,
      };
    }
  }

  const lastOutcome = outcomes[outcomes.length - 1];
  return {
    replyPlan: lastOutcome
      ? {
          kind: 'skill_outcomes',
          outcomes,
        }
      : null,
    workingContext: nextWorkingContext,
    outcomes,
    userMessageAlreadyPersisted: true,
  };
}
