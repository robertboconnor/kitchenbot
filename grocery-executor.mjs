import { getGroceryItems } from './db.mjs';
import { resolveInventoryItems } from './inventory-classification.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

function buildExistingGroceryKey(item, normalizeInventoryNameKey) {
  const normalizedName = normalizeInventoryNameKey(item?.name);
  if (!normalizedName) return '';
  const section = safeTrim(item?.section).toLowerCase();
  return `${section || 'other'}::${normalizedName}`;
}

function buildRequestedGroceryKey(item, normalizeInventoryNameKey) {
  const normalizedName = normalizeInventoryNameKey(item?.name);
  if (!normalizedName) return '';
  const section = safeTrim(item?.section).toLowerCase();
  return `${section || 'other'}::${normalizedName}`;
}

function findExistingGroceryMatches(existingItems, requestedItems, normalizeInventoryNameKey) {
  const activeItems = (Array.isArray(existingItems) ? existingItems : []).filter((item) => Number(item?.checked) !== 1);
  const byKey = new Map();
  const byName = new Map();
  for (const item of activeItems) {
    const key = buildExistingGroceryKey(item, normalizeInventoryNameKey);
    if (key && !byKey.has(key)) byKey.set(key, item);
    const nameKey = normalizeInventoryNameKey(item?.name);
    if (nameKey && !byName.has(nameKey)) byName.set(nameKey, item);
  }
  const matched = [];
  const missing = [];
  for (const item of Array.isArray(requestedItems) ? requestedItems : []) {
    const keyMatch = byKey.get(buildRequestedGroceryKey(item, normalizeInventoryNameKey));
    const nameMatch = byName.get(normalizeInventoryNameKey(item?.name));
    const match = keyMatch || nameMatch || null;
    if (match) {
      matched.push(match);
    } else {
      missing.push(item);
    }
  }
  return { matched, missing };
}

async function generateGroceryDraft(runtimeAction, context) {
  const {
    req,
    chatId,
    memoryContext = null,
    anthropic,
    kbModeEnabled = false,
    runtimeManagedResponse = false,
    deps = {},
  } = context;
  const requestedSource = safeTrim(runtimeAction?.input?.source);
  const sourceGroceryProposal =
    runtimeAction?.input?.sourceGroceryProposal &&
    typeof runtimeAction.input.sourceGroceryProposal === 'object' &&
    !Array.isArray(runtimeAction.input.sourceGroceryProposal)
      ? runtimeAction.input.sourceGroceryProposal
      : null;
  const toItems = (raw) =>
    (Array.isArray(raw) ? raw : [])
      .map((item) => ({ section: safeTrim(item?.section), name: safeTrim(item?.name), amount: safeTrim(item?.amount) }))
      .filter((item) => item.name);
  const directOfferedItems = toItems(runtimeAction?.input?.items);
  const proposalItems = toItems(sourceGroceryProposal?.items);

  const existingGroceryItems = await getGroceryItems(req.householdId);
  const pantryFields = {
    existingGroceryItems,
    pantryContextStatus: safeTrim(memoryContext?.pantryContextStatus) || 'unavailable',
    pantryContextAvailable: !!memoryContext?.pantryContextAvailable,
    pantryItemCount: Number.isFinite(Number(memoryContext?.pantryItemCount)) ? Number(memoryContext.pantryItemCount) : 0,
  };

  // ONE BRAIN (KITCHENBOT_BRAIN_CONTRACT.md - "Smart Brain, Dumb Executors"): the brain
  // enumerates the grocery items itself - scaled to portions, minus what pantry.list shows is
  // already on hand - and passes them explicitly as an items array (source 'explicit_items',
  // or a brain-built proposal). This executor NEVER re-reads the chat to figure out which
  // recipe the user means or to derive a shopping list, and NEVER runs a side-model to
  // generate one. If no items were provided, return a flagged empty draft so the write/preview
  // path tells the brain to enumerate the items and pass them.
  const brainProvidedItems =
    (requestedSource === 'offered_items' || requestedSource === 'explicit_items') && directOfferedItems.length > 0
      ? directOfferedItems
      : (requestedSource === 'grocery_proposal' || requestedSource === 'explicit_items') && proposalItems.length > 0
        ? proposalItems
        : null;

  if (!brainProvidedItems) {
    return { ...pantryFields, normalizedItems: [], noItemsProvided: true };
  }

  const normalizedItems =
    typeof deps.normalizeGroceryItemsForPost === 'function'
      ? await deps.normalizeGroceryItemsForPost(brainProvidedItems, {
          householdId: req.householdId,
          chatId,
          runtimeEnabled: !!kbModeEnabled,
          callSurface: runtimeManagedResponse ? 'kb_action' : 'chat',
        })
      : await resolveInventoryItems({
          target: 'grocery',
          items: brainProvidedItems,
          anthropic: anthropic || null,
          householdId: req.householdId,
          chatId,
          runtimeEnabled: !!kbModeEnabled,
          callSurface: runtimeManagedResponse ? 'kb_action' : 'chat',
        });

  return { ...pantryFields, normalizedItems };
}

export async function previewGroceryListFromConversation(runtimeAction, context) {
  const draft = await generateGroceryDraft(runtimeAction, context);
  const explicitReplace = safeTrim(runtimeAction?.input?.mode).toLowerCase() === 'replace';
  const question = explicitReplace
    ? 'If you want, I can replace the current Grocery List tab with these items.'
    : 'If you want, I can add these items to your Grocery List tab.';
  return {
    capability: 'grocery.preview',
    status: draft.normalizedItems.length > 0 ? 'previewed' : 'empty',
    parsedItemCount: draft.normalizedItems.length,
    items: draft.normalizedItems,
    hasExistingList: draft.existingGroceryItems.length > 0,
    optionModes: [explicitReplace ? 'replace' : 'append'],
    question,
  };
}

export async function writeGroceryListFromConversation(runtimeAction, context) {
  const {
    req,
    name,
    chatId,
    prompt,
    memories = [],
    anthropic,
    skipIncrement = false,
    userMessageAlreadyPersisted = false,
    kbModeEnabled = false,
    runtimeManagedResponse = false,
    deps = {},
  } = context;
  const persistedUserLine = !!userMessageAlreadyPersisted;

  if (!skipIncrement) {
    await deps.incrementUserMessageCountForSender?.(req);
  }

  const requestedGroceryMode = runtimeAction?.input?.mode || null;
  const draft = await generateGroceryDraft(runtimeAction, context);
  if (draft.noItemsProvided) {
    return {
      capability: 'grocery.write',
      status: 'no_items',
      changed: false,
      addedItems: [],
      alreadyOnList: [],
      note:
        'No items were provided to add. Decide the grocery items yourself — enumerate them ' +
        '(with a section and quantity each, minus anything pantry.list shows is already on hand) — ' +
        'and call grocery.write again with an explicit items array.',
    };
  }
  const {
    existingGroceryItems,
    pantryContextStatus,
    pantryContextAvailable,
    pantryItemCount,
    normalizedItems,
  } = draft;
  const effectiveGroceryMode = requestedGroceryMode || 'append';
  const initialNormalizedItems = Array.isArray(normalizedItems) ? normalizedItems : [];
  const isExplicitItemAdd = safeTrim(runtimeAction?.input?.source).toLowerCase() === 'explicit_items';
  if (isExplicitItemAdd && initialNormalizedItems.length > 0) {
    await deps.emitKbProgress?.({
      chatId,
      householdId: req.householdId,
      turnId: req.kbTurnId || null,
      text: 'Checking grocery list…',
      phase: 'grocery.write.live_check',
      senderRes: context.res,
    });
    const { matched, missing } = findExistingGroceryMatches(
      existingGroceryItems,
      initialNormalizedItems,
      deps.normalizeInventoryNameKey
    );
    if (missing.length === 0) {
      return {
        capability: 'grocery.write',
        status: 'already_present',
        changed: false,
        addedItems: [],
        alreadyOnList: matched.map((item) => safeTrim(item?.name)).filter(Boolean),
        checkedLiveGroceryList: true,
        mode: effectiveGroceryMode,
        parsedItemCount: initialNormalizedItems.length,
        matchedItems: matched.map((item) => ({
          name: safeTrim(item?.name),
          section: safeTrim(item?.section),
          amount: safeTrim(item?.amount),
        })),
      };
    }
  }
  let finalNormalizedItems = initialNormalizedItems;
  let reconciledWithPantry = false;
  let pantryAdjustedItemCount = 0;
  const usedPantryContext = !!pantryContextAvailable;
  const pantryClarificationNeeded = !pantryContextAvailable;

  // ONE BRAIN: deciding which drafted items are "already on hand" (and excluding them) is
  // the brain's job — it has the pantry.list read-tool and omits on-hand staples before it
  // ever calls grocery.write. No side-model reconciliation here; we commit what the brain sent.

  const beforeGroceryCount = existingGroceryItems.length;
  let replaceClearedCount = 0;
  if (effectiveGroceryMode === 'replace') {
    replaceClearedCount = await deps.clearGroceryItems(req.householdId);
  }

  let mergeStats = { insertedCount: 0, updatedCount: 0, backfilledCount: 0, changedCount: 0 };
  if (finalNormalizedItems.length > 0) {
    mergeStats = await deps.mergeGroceryItemsFromAi(req.householdId, finalNormalizedItems, chatId);
  }

  const afterGroceryItems = await getGroceryItems(req.householdId);
  const afterGroceryCount = afterGroceryItems.length;
  const totalDbContentChanges = replaceClearedCount + mergeStats.changedCount;
  const groceryListWasUpdated = totalDbContentChanges > 0;

  // Truthfulness: report which requested items were actually NEW vs already on
  // the list, so the brain never claims it "added" a duplicate.
  const beforeKeySet = new Set(
    (Array.isArray(existingGroceryItems) ? existingGroceryItems : [])
      .map((i) => deps.normalizeInventoryNameKey?.(i?.name))
      .filter(Boolean)
  );
  const addedItems = [];
  const alreadyOnList = [];
  for (const item of finalNormalizedItems) {
    const nm = safeTrim(item?.name);
    if (!nm) continue;
    const key = deps.normalizeInventoryNameKey?.(nm);
    if (effectiveGroceryMode !== 'replace' && key && beforeKeySet.has(key)) alreadyOnList.push(nm);
    else addedItems.push(nm);
  }

  const outcome = {
    capability: 'grocery.write',
    status: 'committed',
    changed: groceryListWasUpdated,
    addedItems,
    alreadyOnList,
    usedPantryContext,
    pantryClarificationNeeded,
    pantryContextStatus,
    pantryItemCount,
    missingFromPantry: finalNormalizedItems.map((item) => safeTrim(item?.name)).filter(Boolean),
    reconciledWithPantry,
    initialParsedItemCount: initialNormalizedItems.length,
    finalParsedItemCount: finalNormalizedItems.length,
    pantryAdjustedItemCount,
    mode: effectiveGroceryMode,
    parsedItemCount: finalNormalizedItems.length,
    checkedLiveGroceryList: isExplicitItemAdd,
    counts: {
      inserted: mergeStats.insertedCount,
      updated: mergeStats.updatedCount,
      replacedCleared: replaceClearedCount,
      backfilled: mergeStats.backfilledCount,
      changedTotal: totalDbContentChanges,
      beforeCount: beforeGroceryCount,
      afterCount: afterGroceryCount,
    },
  };

  if (!runtimeManagedResponse) {
    await deps.addMessage?.(chatId, req.householdId, 'user', name, prompt);
    const reply =
      outcome.changed
        ? 'I updated the grocery list.'
        : Number(outcome.parsedItemCount || 0) > 0
          ? "The grocery list already had those items, so there wasn't anything new to update."
          : 'I was not able to build a grocery list from our conversation.';
    await deps.addMessage?.(chatId, req.householdId, 'assistant', 'KitchenBot', reply);
  }

  if (!runtimeManagedResponse) {
    deps.broadcastToChat?.(chatId, {
      type: 'chat_updated',
      householdId: req.householdId,
      chatId,
      user: name,
    });
  }

  return outcome;
}
