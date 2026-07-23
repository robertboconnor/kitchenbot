import {
  addGroceryItems,
  addPantryItems,
  deleteGroceryItem,
  deletePantryItem,
  getGroceryItems,
  getPantryItems,
  updatePantryItemSection,
} from './db.mjs';
import { resolveInventoryItems, PANTRY_SECTION_KEYS } from './inventory-classification.mjs';
import { resolveInventoryItemMatch } from './inventory-item-resolver.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

function normalizeNameKey(name) {
  return safeTrim(name).toLowerCase().replace(/\s+/g, ' ');
}

async function normalizePantryActionItems(rawItems, context = {}) {
  const list = Array.isArray(rawItems) ? rawItems : [];
  const seen = new Set();
  const rawResolved = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const name = safeTrim(raw.name);
    const key = normalizeNameKey(name);
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    rawResolved.push({
      name,
      section: safeTrim(raw.section),
      amount: safeTrim(raw.amount),
    });
  }
  return await resolveInventoryItems({
    target: 'pantry',
    items: rawResolved,
    anthropic: context.anthropic || null,
    householdId: context.req?.householdId,
    chatId: context.chatId,
    runtimeEnabled: true,
    callSurface: 'kb_action',
  });
}

function buildResolveResult(capability, resolution) {
  if (resolution?.status === 'ambiguous') {
    const candidateOptions = (Array.isArray(resolution.matches) ? resolution.matches : []).map((item) => ({
      id: String(item?.id ?? ''),
      label: [safeTrim(item?.name), safeTrim(item?.amount)].filter(Boolean).join(' - ') || safeTrim(item?.name),
    }));
    const question =
      candidateOptions.length > 0
        ? `I found more than one possible match for ${safeTrim(resolution.requestedName)} in the Pantry. Which one did you mean: ${candidateOptions
            .map((option) => option.label)
            .join(', ')}?`
        : `I found more than one possible Pantry item for ${safeTrim(resolution.requestedName)}. Which one did you mean?`;
    return {
      capability,
      status: 'ambiguous',
      requestedName: safeTrim(resolution.requestedName),
      matches: (Array.isArray(resolution.matches) ? resolution.matches : []).map((item) => ({
        id: item?.id,
        name: safeTrim(item?.name),
        amount: safeTrim(item?.amount),
        section: safeTrim(item?.section),
        checked: !!item?.checked,
      })),
      question,
    };
  }
  if (resolution?.status === 'missing') {
    return {
      capability,
      status: 'missing',
      missingName: safeTrim(resolution.requestedName),
    };
  }
  return null;
}

async function resolveRequiredPantryItem(capability, runtimeAction, context) {
  const input =
    runtimeAction?.input && typeof runtimeAction.input === 'object' && !Array.isArray(runtimeAction.input)
      ? runtimeAction.input
      : {};
  const name = safeTrim(input.name);
  if (!name) {
    return {
      capability,
      status: 'invalid',
      error: 'No pantry item was provided.',
    };
  }
  const pantryItems = await getPantryItems(context.req.householdId);
  const resolution = resolveInventoryItemMatch(pantryItems, name);
  if (resolution?.status !== 'found') {
    return buildResolveResult(capability, resolution);
  }
  return { capability, item: resolution.item };
}

export async function executePantryAdd(runtimeAction, context) {
  const input =
    runtimeAction?.input && typeof runtimeAction.input === 'object' && !Array.isArray(runtimeAction.input)
      ? runtimeAction.input
      : {};
  const items = await normalizePantryActionItems(input.items, context);
  if (items.length === 0) {
    return {
      capability: 'pantry.add',
      status: 'invalid',
      error: 'No pantry items were provided.',
    };
  }
  const addedCount = await addPantryItems(context.req.householdId, items);
  return {
    capability: 'pantry.add',
    status: addedCount > 0 ? 'added' : 'unchanged',
    addedCount,
    items,
  };
}

// Re-file an existing pantry item into a different section. The brain supplies the
// target section directly (it knows the valid sections from the tool schema), so the
// auto-classifier is not involved — this is the "actually move things" capability.
export async function executePantryRecategorize(runtimeAction, context) {
  const resolved = await resolveRequiredPantryItem('pantry.recategorize', runtimeAction, context);
  if (!resolved?.item) return resolved;
  const input =
    runtimeAction?.input && typeof runtimeAction.input === 'object' && !Array.isArray(runtimeAction.input)
      ? runtimeAction.input
      : {};
  const section = safeTrim(input.section).toLowerCase();
  if (!PANTRY_SECTION_KEYS.has(section)) {
    return {
      capability: 'pantry.recategorize',
      status: 'invalid_section',
      requestedSection: safeTrim(input.section),
      validSections: [...PANTRY_SECTION_KEYS],
      error: `"${safeTrim(input.section)}" is not a valid pantry section. Valid sections: ${[...PANTRY_SECTION_KEYS].join(', ')}.`,
    };
  }
  const item = resolved.item;
  const prevSection = safeTrim(item.section);
  if (prevSection === section) {
    return { capability: 'pantry.recategorize', status: 'unchanged', itemName: item.name, section };
  }
  await updatePantryItemSection(context.req.householdId, item.id, section, item.name);
  return {
    capability: 'pantry.recategorize',
    status: 'recategorized',
    itemName: item.name,
    previousSection: prevSection,
    section,
  };
}

export async function executePantryRemove(runtimeAction, context) {
  const resolved = await resolveRequiredPantryItem('pantry.remove', runtimeAction, context);
  if (!resolved?.item) return resolved;
  await deletePantryItem(context.req.householdId, resolved.item.id);
  return {
    capability: 'pantry.remove',
    status: 'removed',
    removedName: resolved.item.name,
    item: resolved.item,
  };
}

export async function executePantryMoveToGrocery(runtimeAction, context) {
  const resolved = await resolveRequiredPantryItem('pantry.move_to_grocery', runtimeAction, context);
  if (!resolved?.item) return resolved;
  const match = resolved.item;
  const [resolvedItem] = await resolveInventoryItems({
    target: 'grocery',
    items: [{ name: match.name, section: '', amount: match.amount, sourceSection: match.section, sourceListType: 'pantry', probablyPantryItem: true }],
    anthropic: context.anthropic || null,
    householdId: context.req.householdId,
    chatId: context.chatId,
    runtimeEnabled: true,
    callSurface: 'kb_action',
  });
  await addGroceryItems(context.req.householdId, [resolvedItem]);
  await deletePantryItem(context.req.householdId, match.id);
  return {
    capability: 'pantry.move_to_grocery',
    status: 'moved',
    movedName: match.name,
    sourceName: match.name,
    destinationName: resolvedItem?.name || match.name,
    item: match,
  };
}

export async function executeGroceryMoveToPantry(runtimeAction, context) {
  const input =
    runtimeAction?.input && typeof runtimeAction.input === 'object' && !Array.isArray(runtimeAction.input)
      ? runtimeAction.input
      : {};
  const name = safeTrim(input.name);
  if (!name) {
    return {
      capability: 'grocery.move_to_pantry',
      status: 'invalid',
      error: 'No grocery item was provided.',
    };
  }
  const groceryItems = await getGroceryItems(context.req.householdId);
  const resolution = resolveInventoryItemMatch(groceryItems, name);
  if (resolution?.status !== 'found') {
    return buildResolveResult('grocery.move_to_pantry', resolution);
  }
  const match = resolution.item;
  const [resolvedItem] = await resolveInventoryItems({
    target: 'pantry',
    items: [{ name: match.name, section: '', amount: match.amount, sourceSection: match.section, sourceListType: 'grocery' }],
    anthropic: context.anthropic || null,
    householdId: context.req.householdId,
    chatId: context.chatId,
    runtimeEnabled: true,
    callSurface: 'kb_action',
  });
  await addPantryItems(context.req.householdId, [resolvedItem]);
  await deleteGroceryItem(context.req.householdId, match.id);
  return {
    capability: 'grocery.move_to_pantry',
    status: 'moved',
    movedName: match.name,
    sourceName: match.name,
    destinationName: resolvedItem?.name || match.name,
    item: match,
  };
}
