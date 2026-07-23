import {
  clearGroceryItems,
  deleteGroceryItem,
  getGroceryItems,
  setGroceryItemAmount,
  updateGroceryItem,
  updateGroceryItemSection,
} from './db.mjs';
import { GROCERY_SECTION_KEYS } from './inventory-classification.mjs';
import { resolveInventoryItemMatch } from './inventory-item-resolver.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

function buildResolveResult(capability, resolution) {
  if (resolution?.status === 'ambiguous') {
    const candidateOptions = (Array.isArray(resolution.matches) ? resolution.matches : []).map((item) => ({
      id: String(item?.id ?? ''),
      label: [safeTrim(item?.name), safeTrim(item?.amount)].filter(Boolean).join(' - ') || safeTrim(item?.name),
    }));
    const question =
      candidateOptions.length > 0
        ? `I found more than one possible match for ${safeTrim(resolution.requestedName)} on the Grocery List tab. Which one did you mean: ${candidateOptions
            .map((option) => option.label)
            .join(', ')}?`
        : `I found more than one possible Grocery List tab item for ${safeTrim(resolution.requestedName)}. Which one did you mean?`;
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

async function resolveRequiredGroceryItem(capability, runtimeAction, context) {
  const input =
    runtimeAction?.input && typeof runtimeAction.input === 'object' && !Array.isArray(runtimeAction.input)
      ? runtimeAction.input
      : {};
  const name = safeTrim(input.name);
  if (!name) {
    return {
      capability,
      status: 'invalid',
      error: 'No grocery item was provided.',
    };
  }
  const groceryItems = await getGroceryItems(context.req.householdId);
  const resolution = resolveInventoryItemMatch(groceryItems, name);
  if (resolution?.status !== 'found') {
    return buildResolveResult(capability, resolution);
  }
  return { capability, item: resolution.item };
}

export async function executeGroceryRemove(runtimeAction, context) {
  const resolved = await resolveRequiredGroceryItem('grocery.remove', runtimeAction, context);
  if (!resolved?.item) return resolved;
  await deleteGroceryItem(context.req.householdId, resolved.item.id);
  return {
    capability: 'grocery.remove',
    status: 'removed',
    removedName: resolved.item.name,
    item: resolved.item,
  };
}

async function executeGroceryCheckedMutation(runtimeAction, context, checked) {
  const capability = checked ? 'grocery.check' : 'grocery.uncheck';
  const resolved = await resolveRequiredGroceryItem(capability, runtimeAction, context);
  if (!resolved?.item) return resolved;
  const alreadyChecked = !!resolved.item.checked;
  if (alreadyChecked === checked) {
    return {
      capability,
      status: 'unchanged',
      itemName: resolved.item.name,
      item: resolved.item,
    };
  }
  await updateGroceryItem(context.req.householdId, resolved.item.id, { checked });
  return {
    capability,
    status: checked ? 'checked' : 'unchecked',
    itemName: resolved.item.name,
    item: { ...resolved.item, checked },
  };
}

export async function executeGroceryCheck(runtimeAction, context) {
  return await executeGroceryCheckedMutation(runtimeAction, context, true);
}

export async function executeGroceryUncheck(runtimeAction, context) {
  return await executeGroceryCheckedMutation(runtimeAction, context, false);
}

export async function executeGroceryClear(_runtimeAction, context) {
  const clearedCount = await clearGroceryItems(context.req.householdId);
  return {
    capability: 'grocery.clear',
    status: clearedCount > 0 ? 'cleared' : 'unchanged',
    clearedCount,
  };
}

function buildUpdateSummary(name, { amountChanged, nextAmount, checkedChanged, nextChecked, prevChecked, sectionChanged, nextSection }) {
  const parts = [];
  if (amountChanged) parts.push(`set the amount to ${nextAmount}`);
  if (sectionChanged) parts.push(`moved it to the ${nextSection} section`);
  if (checkedChanged) {
    parts.push(nextChecked ? 'marked it as bought' : 'put it back on the active list');
  } else if (amountChanged && prevChecked) {
    // Amount changed on an item still marked bought — worth stating so the reply is honest.
    parts.push('(it is still marked as bought)');
  }
  if (parts.length === 0) return `${name} was already set that way.`;
  return `Updated ${name}: ${parts.join(' and ')}.`;
}

// Change an existing Grocery List item's amount and/or checked state. This is the
// EXPLICIT counterpart to the fuzzy grocery.write merge: the user is intentionally
// targeting one item (e.g. "make the eggs 12" or "put the eggs back on the list"),
// so it can update the amount of a bought item too — grocery.write can't, by design.
export async function executeGroceryUpdateItem(runtimeAction, context) {
  const capability = 'grocery.update_item';
  const resolved = await resolveRequiredGroceryItem(capability, runtimeAction, context);
  if (!resolved?.item) return resolved;

  const input =
    runtimeAction?.input && typeof runtimeAction.input === 'object' && !Array.isArray(runtimeAction.input)
      ? runtimeAction.input
      : {};
  const item = resolved.item;

  const amountProvided = safeTrim(input.amount) !== '';
  const nextAmount = safeTrim(input.amount);
  const checkedProvided = typeof input.checked === 'boolean';
  const nextChecked = checkedProvided ? input.checked : !!item.checked;
  const sectionProvided = safeTrim(input.section) !== '';
  const nextSection = safeTrim(input.section).toLowerCase();

  // Reject an explicitly-provided but invalid section rather than silently ignoring it.
  if (sectionProvided && !GROCERY_SECTION_KEYS.has(nextSection)) {
    return {
      capability,
      status: 'invalid_section',
      itemName: item.name,
      name: item.name,
      requestedSection: safeTrim(input.section),
      validSections: [...GROCERY_SECTION_KEYS],
      error: `"${safeTrim(input.section)}" is not a valid grocery section. Valid sections: ${[...GROCERY_SECTION_KEYS].join(', ')}.`,
    };
  }

  const prevAmount = safeTrim(item.amount);
  const prevChecked = !!item.checked;
  const prevSection = safeTrim(item.section);
  const amountChanged = amountProvided && nextAmount !== prevAmount;
  const checkedChanged = checkedProvided && nextChecked !== prevChecked;
  const sectionChanged = sectionProvided && nextSection !== prevSection;

  if (!amountProvided && !checkedProvided && !sectionProvided) {
    return {
      capability,
      status: 'unchanged',
      itemName: item.name,
      name: item.name,
      item,
      note: 'No new amount, checked state, or section was provided, so nothing changed.',
    };
  }
  if (!amountChanged && !checkedChanged && !sectionChanged) {
    return {
      capability,
      status: 'unchanged',
      itemName: item.name,
      name: item.name,
      item,
      note: `${item.name} is already set that way — nothing to change.`,
    };
  }

  // Apply the checked change first so a follow-on amount update is not blocked if
  // the item is being put back on the active list; then set the amount + section.
  if (checkedChanged) {
    await updateGroceryItem(context.req.householdId, item.id, { checked: nextChecked });
  }
  if (amountChanged) {
    await setGroceryItemAmount(context.req.householdId, item.id, nextAmount);
  }
  if (sectionChanged) {
    await updateGroceryItemSection(context.req.householdId, item.id, nextSection);
  }

  const finalAmount = amountChanged ? nextAmount : prevAmount;
  const finalSection = sectionChanged ? nextSection : prevSection;
  return {
    capability,
    status: 'updated',
    itemName: item.name,
    name: item.name,
    previousAmount: prevAmount,
    amount: finalAmount,
    previousChecked: prevChecked,
    checked: nextChecked,
    previousSection: prevSection,
    section: finalSection,
    amountChanged,
    checkedChanged,
    sectionChanged,
    summary: buildUpdateSummary(item.name, { amountChanged, nextAmount, checkedChanged, nextChecked, prevChecked, sectionChanged, nextSection }),
    item: { ...item, amount: finalAmount, checked: nextChecked, section: finalSection },
  };
}
