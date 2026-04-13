import {
  getGroceryItems,
  getMessages,
} from './db.mjs';
import { createLoggedAnthropicMessage } from './anthropic-usage.mjs';
import { resolveAnthropicModelForCallPurpose } from './anthropic-model-policy.mjs';
import { resolveInventoryItems } from './inventory-classification.mjs';
import { buildKbContextSystemText } from './kb-prompt-context.mjs';
import { buildClarifyActionState } from './kb-next-action.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

function formatInventoryLines(items = [], limit = 80) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => safeTrim(item?.name))
    .slice(0, limit)
    .map((item) => {
      const section = safeTrim(item?.section).toLowerCase() || 'other';
      const name = safeTrim(item?.name);
      const amount = safeTrim(item?.amount);
      return amount ? `${section} | ${name} | ${amount}` : `${section} | ${name}`;
    })
    .join('\n');
}

function formatPantryContextForPrompt(pantryItems = []) {
  const lines = formatInventoryLines(pantryItems, 120);
  if (!lines) return 'Already on hand now:\n(none)';
  return [
    'Already on hand now:',
    lines,
    'Do not include these pantry items in the final grocery list unless the meals clearly require buying more.',
  ].join('\n');
}

function buildGroceryAddNextStep({ question, visibleReplySummary = '', input = {} }) {
  return buildClarifyActionState({
    capability: 'grocery.write',
    input,
    question,
    contextSummary: 'Continue the pending grocery add using the current chat context.',
    unresolvedFields: [],
    visibleReplySummary: String(visibleReplySummary || question || '').trim().slice(0, 400),
  });
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

function buildGroceryConversationContextForPrompt(recentConversation, deps) {
  const parts = [];
  const conversationSnippet = Array.isArray(recentConversation)
    ? recentConversation
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .slice(-6)
        .map((message) =>
          message.role === 'user'
            ? `${message.name}: ${String(message.content ?? '').trim()}`
            : `KitchenBot: ${String(deps.stripStoredMessageContentForDisplay?.(message.content) ?? message.content ?? '').trim()}`
        )
        .filter(Boolean)
        .join('\n\n')
    : '';
  if (conversationSnippet) {
    parts.push(`Recent conversation:\n${conversationSnippet}`);
  }

  const compact = parts.filter(Boolean).join('\n\n').trim();
  return compact || '(none)';
}

function hasUsableWorkingContext(memoryContext) {
  const workingContext = memoryContext?.workingContext;
  return !!(
    workingContext &&
    typeof workingContext === 'object' &&
    !Array.isArray(workingContext) &&
    (((Array.isArray(workingContext.mealIdeas) ? workingContext.mealIdeas.length : 0) > 0) ||
      safeTrim(workingContext.topicSummary))
  );
}

function isReferentialPrompt(prompt) {
  const text = safeTrim(prompt).toLowerCase();
  if (!text) return false;
  return /\b(this|that|those|these|it|them)\b/.test(text) || /\bone of those\b/.test(text);
}

function countActiveRelevantPeople(memoryContext) {
  const entityContext = memoryContext?.entityContext || {};
  const active = new Set();
  const speaker = safeTrim(entityContext.activeSpeakerLabel || entityContext.activeSpeakerName).toLowerCase();
  if (speaker) active.add(speaker);
  for (const label of Array.isArray(entityContext.mentionedPersonLabels) ? entityContext.mentionedPersonLabels : []) {
    const text = safeTrim(label).toLowerCase();
    if (text) active.add(text);
  }
  return active.size;
}

function hasComplexDefaultsOrMemory(memoryContext) {
  const pantryCount = Array.isArray(memoryContext?.pantryItems) ? memoryContext.pantryItems.length : 0;
  const selectedMemoryCount = Array.isArray(memoryContext?.selectedItems) ? memoryContext.selectedItems.length : 0;
  return pantryCount > 20 || selectedMemoryCount > 5;
}

function shouldUsePrimaryGroceryModel(runtimeAction, context) {
  const promptText = safeTrim(context?.prompt).toLowerCase();
  const memoryContext = context?.memoryContext || null;
  if (!hasUsableWorkingContext(memoryContext)) return false;
  if (isReferentialPrompt(promptText)) return false;
  if (/\b(swap|replace one|redo|revise|change one|make one)\b/.test(promptText)) return false;
  if (countActiveRelevantPeople(memoryContext) > 2) return false;
  if (hasComplexDefaultsOrMemory(memoryContext)) return false;
  const source = safeTrim(runtimeAction?.input?.source).toLowerCase();
  if (source && source !== 'draft_chat_offer') return false;
  return true;
}

function minimumExpectedItems(memoryContext) {
  const mealIdeas = Array.isArray(memoryContext?.workingContext?.mealIdeas) ? memoryContext.workingContext.mealIdeas.length : 0;
  if (mealIdeas >= 3) return 8;
  if (mealIdeas === 2) return 6;
  if (mealIdeas === 1) return 4;
  return 1;
}

function shouldEscalatePrimaryGroceryDraft(normalizedItems, memoryContext) {
  const count = Array.isArray(normalizedItems) ? normalizedItems.length : 0;
  if (count === 0) return true;
  return count < minimumExpectedItems(memoryContext);
}

async function requestGroceryDraft({
  anthropic,
  callPurpose,
  req,
  chatId,
  kbModeEnabled,
  runtimeManagedResponse,
  claudeMessages,
  systemPrompt,
  conversationContextCompact,
}) {
  return await createLoggedAnthropicMessage(anthropic, {
    model: resolveAnthropicModelForCallPurpose(callPurpose),
    max_tokens: 400,
    system: systemPrompt,
    messages: [
      ...claudeMessages,
      {
        role: 'user',
        content:
          'Based on the cooking and meal discussion we have had, build a complete grocery list using the format "section | product | amount", one item per line. Do not include any commentary, headers, or bullet points—only raw lines in that format.\n\nConversation context:\n' +
          conversationContextCompact,
      },
    ],
  }, {
    householdId: req.householdId,
    chatId,
    runtimeEnabled: !!kbModeEnabled,
    callSurface: runtimeManagedResponse ? 'kb_action' : 'chat',
    callPurpose,
    webSearchEnabledAtCall: false,
    usedWebSearchTool: false,
  });
}

async function requestPantryAwareReconciliation({
  anthropic,
  req,
  chatId,
  kbModeEnabled,
  runtimeManagedResponse,
  systemPrompt,
  conversationContextCompact,
  pantryItems = [],
  draftItems = [],
}) {
  return await createLoggedAnthropicMessage(anthropic, {
    model: resolveAnthropicModelForCallPurpose('grocery_draft_reconciliation'),
    max_tokens: 350,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: [
          'Revise this grocery draft using the current pantry state.',
          '',
          formatPantryContextForPrompt(pantryItems),
          '',
          'Current grocery draft:',
          formatInventoryLines(draftItems, 120) || '(none)',
          '',
          'Return ONLY the final grocery list using the format "section | product | amount", one item per line.',
          'Remove items that should be treated as already on hand. Keep items that still need to be bought.',
          '',
          `Conversation context:\n${conversationContextCompact}`,
        ].join('\n'),
      },
    ],
  }, {
    householdId: req.householdId,
    chatId,
    runtimeEnabled: !!kbModeEnabled,
    callSurface: runtimeManagedResponse ? 'kb_action' : 'chat',
    callPurpose: 'grocery_draft_reconciliation',
    webSearchEnabledAtCall: false,
    usedWebSearchTool: false,
  });
}

async function parseGroceryDraftItems({
  groceryResponse,
  anthropic,
  householdId,
  chatId,
  kbModeEnabled = false,
  runtimeManagedResponse = false,
  deps = {},
}) {
  const textBlocks = groceryResponse.content.filter((block) => block.type === 'text');
  const fullText = textBlocks.map((b) => b.text).join('\n');
  const lines = fullText.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  const items = [];
  for (const line of lines) {
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length < 2) continue;
    const [sectionRaw, nameRaw, amountRaw] = parts;
    const nameTrim = String(nameRaw).trim();
    if (!sectionRaw || !nameTrim) continue;
    items.push({
      section: sectionRaw,
      name: nameTrim,
      amount: amountRaw != null ? String(amountRaw).trim() : '',
    });
  }
  if (typeof deps.normalizeGroceryItemsForPost === 'function') {
    return await deps.normalizeGroceryItemsForPost(items, {
      householdId,
      chatId,
      runtimeEnabled: !!kbModeEnabled,
      callSurface: runtimeManagedResponse ? 'kb_action' : 'chat',
    });
  }
  return await resolveInventoryItems({
    target: 'grocery',
    items,
    anthropic: anthropic || null,
    householdId,
    chatId,
    runtimeEnabled: !!kbModeEnabled,
    callSurface: runtimeManagedResponse ? 'kb_action' : 'chat',
  });
}

async function generateGroceryDraft(runtimeAction, context) {
  const {
    req,
    chatId,
    memories = [],
    memoryContext = null,
    anthropic,
    kbModeEnabled = false,
    runtimeManagedResponse = false,
    deps = {},
  } = context;
  const requestedSource = runtimeAction?.input?.source || null;
  const directOfferedItems = Array.isArray(runtimeAction?.input?.items)
    ? runtimeAction.input.items
        .map((item) => ({
          section: safeTrim(item?.section),
          name: safeTrim(item?.name),
          amount: safeTrim(item?.amount),
        }))
        .filter((item) => item.name)
    : [];
  const conversation = await getMessages(chatId, req.householdId);
  const conversationForContext = conversation.filter(
    (m) => m.role !== 'user' || !String(m.content || '').trim().startsWith('!')
  );
  const recentConversation = conversationForContext.length > 40 ? conversationForContext.slice(-40) : conversationForContext;

  const existingGroceryItems = await getGroceryItems(req.householdId);
  const conversationContextCompact = buildGroceryConversationContextForPrompt(recentConversation, deps);

  const claudeMessages = recentConversation.map((message) => ({
    role: message.role,
    content:
      message.role === 'user'
        ? `${message.name}: ${message.content}`
        : deps.stripStoredMessageContentForDisplay?.(message.content) ?? String(message.content ?? ''),
  }));

  const systemPrompt = `You are a household assistant that generates grocery lists.

${buildKbContextSystemText(memoryContext)}

Conversation context for this chat:
${conversationContextCompact}

Personalization rules:
- Treat the applied household context as real constraints for the grocery draft, not as optional decoration.
- Treat the applied household defaults as stronger operating assumptions when relevant.
- Treat the applied working context as the best short-term guide to what "this" or "that" refers to in the current chat.
- Use the local time context when the grocery request depends on tonight/tomorrow timing, deadline-sensitive cooking, or speed.
- Treat pantry items as already on hand unless the conversation clearly implies the household needs more of them.
- Pantry items are a primary constraint, not a background hint.
- If Pantry context status is available or empty, trust it directly and do not ask the user to confirm what is already on hand.
- Only ask the user about Pantry contents if Pantry context status is unavailable.
- Treat the current Grocery List as real live household state when deciding what is already on the buy-now list.
- If a default dinner portion count exists, scale grocery quantities to match it unless the conversation clearly implies another serving size.
- If a weeknight cooking style exists, let that shape ingredient ambition and prep burden.
- If the active speaker or another clearly relevant person has a saved dislike or preference, account for it directly in the list unless the conversation clearly overrides it.
- If multiple people are relevant, try to make the list work for the group rather than optimizing for only one person.
- Avoid ingredients that clearly conflict with saved dislikes or food constraints.
- If household preferences imply simpler cooking, prefer leaner ingredient sets when reasonable.

When the user asks for a grocery list, respond ONLY with plain text lines in the format:
section | product | amount

Where:
- section is one of: produce, meat, dairy, frozen, dry, other
- product is a short item name
- amount is a human-readable quantity (like "2 lbs", "3", "1 carton")`;

  const groceryReconciliationSystemPrompt = `You revise household grocery drafts using current pantry state.

${buildKbContextSystemText(memoryContext)}

Rules:
- Pantry items listed as already on hand should not appear in the final grocery list unless more is clearly needed.
- If Pantry context status is available or empty, trust it directly and do not ask the user to confirm Pantry contents.
- Keep the list grounded in the same meals and conversation context.
- Remove pantry duplicates and keep true buy-now items.
- Return ONLY plain text lines in the format:
section | product | amount

Where:
- section is one of: produce, meat, dairy, frozen, dry, other
- product is a short item name
- amount is a human-readable quantity`;

  if ((requestedSource === 'offered_items' || requestedSource === 'explicit_items') && directOfferedItems.length > 0) {
    const normalizedItems =
      typeof deps.normalizeGroceryItemsForPost === 'function'
        ? await deps.normalizeGroceryItemsForPost(directOfferedItems, {
            householdId: req.householdId,
            chatId,
            runtimeEnabled: !!kbModeEnabled,
            callSurface: runtimeManagedResponse ? 'kb_action' : 'chat',
          })
        : await resolveInventoryItems({
            target: 'grocery',
            items: directOfferedItems,
            anthropic: anthropic || null,
            householdId: req.householdId,
            chatId,
            runtimeEnabled: !!kbModeEnabled,
            callSurface: runtimeManagedResponse ? 'kb_action' : 'chat',
          });
    const priorKeys = new Set(
      existingGroceryItems
        .map((item) => deps.normalizeInventoryNameKey(item?.name))
        .filter(Boolean)
    );
    const runKeys = new Set(normalizedItems.map((i) => deps.normalizeInventoryNameKey(i.name)).filter(Boolean));
    const likelyRemovedKeys = new Set([...priorKeys].filter((k) => !runKeys.has(k)));
    const likelyAddedKeys = new Set([...runKeys].filter((k) => !priorKeys.has(k)));
    return {
      recentConversation,
      existingGroceryItems,
      pantryItems: Array.isArray(memoryContext?.pantryItems) ? memoryContext.pantryItems : [],
      pantryContextStatus: safeTrim(memoryContext?.pantryContextStatus) || 'unavailable',
      pantryContextAvailable: !!memoryContext?.pantryContextAvailable,
      pantryItemCount: Number.isFinite(Number(memoryContext?.pantryItemCount)) ? Number(memoryContext.pantryItemCount) : 0,
      conversationContextCompact,
      normalizedItems,
      systemPrompt,
      groceryReconciliationSystemPrompt,
      priorKeys,
      runKeys,
      likelyRemovedKeys,
      likelyAddedKeys,
      draftChatOfferCommit: false,
    };
  }

  const usePrimary = shouldUsePrimaryGroceryModel(runtimeAction, context);
  let groceryResponse = await requestGroceryDraft({
    anthropic,
    callPurpose: usePrimary ? 'grocery_draft_generation_primary' : 'grocery_draft_generation_fallback',
    req,
    chatId,
    kbModeEnabled,
    runtimeManagedResponse,
    claudeMessages,
    systemPrompt,
    conversationContextCompact,
  });

  let normalizedItems = await parseGroceryDraftItems({
    groceryResponse,
    anthropic,
    householdId: req.householdId,
    chatId,
    kbModeEnabled,
    runtimeManagedResponse,
    deps,
  });
  if (usePrimary && shouldEscalatePrimaryGroceryDraft(normalizedItems, memoryContext)) {
    groceryResponse = await requestGroceryDraft({
      anthropic,
      callPurpose: 'grocery_draft_generation_fallback',
      req,
      chatId,
      kbModeEnabled,
      runtimeManagedResponse,
      claudeMessages,
      systemPrompt,
      conversationContextCompact,
    });
    normalizedItems = await parseGroceryDraftItems({
      groceryResponse,
      anthropic,
      householdId: req.householdId,
      chatId,
      kbModeEnabled,
      runtimeManagedResponse,
      deps,
    });
  }
  const priorKeys = new Set(
    existingGroceryItems
      .map((item) => deps.normalizeInventoryNameKey(item?.name))
      .filter(Boolean)
  );
  const runKeys = new Set(normalizedItems.map((i) => deps.normalizeInventoryNameKey(i.name)).filter(Boolean));
  const likelyRemovedKeys = new Set([...priorKeys].filter((k) => !runKeys.has(k)));
  const likelyAddedKeys = new Set([...runKeys].filter((k) => !priorKeys.has(k)));
  const draftChatOfferCommit = requestedSource === 'draft_chat_offer';

  return {
    recentConversation,
    existingGroceryItems,
    pantryItems: Array.isArray(memoryContext?.pantryItems) ? memoryContext.pantryItems : [],
    pantryContextStatus: safeTrim(memoryContext?.pantryContextStatus) || 'unavailable',
    pantryContextAvailable: !!memoryContext?.pantryContextAvailable,
    pantryItemCount: Number.isFinite(Number(memoryContext?.pantryItemCount)) ? Number(memoryContext.pantryItemCount) : 0,
    conversationContextCompact,
    normalizedItems,
    systemPrompt,
    groceryReconciliationSystemPrompt,
    priorKeys,
    runKeys,
    likelyRemovedKeys,
    likelyAddedKeys,
    draftChatOfferCommit,
  };
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
    proposedNextAction:
      draft.normalizedItems.length > 0
        ? buildGroceryAddNextStep({
            question,
            visibleReplySummary: question,
            input: {
              source: 'draft_chat_offer',
              ...(explicitReplace ? { mode: 'replace' } : {}),
            },
          })
        : null,
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
  const {
    existingGroceryItems,
    pantryItems,
    pantryContextStatus,
    pantryContextAvailable,
    pantryItemCount,
    conversationContextCompact,
    normalizedItems,
    groceryReconciliationSystemPrompt,
    runKeys,
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

  if (anthropic && initialNormalizedItems.length > 0 && pantryItems.length > 0) {
    await deps.emitKbProgress?.({
      chatId,
      householdId: req.householdId,
      turnId: req.kbTurnId || null,
      text: 'Checking pantry…',
      phase: 'grocery.write.pantry_reconcile',
      senderRes: context.res,
    });
    try {
      const reconciliationResponse = await requestPantryAwareReconciliation({
        anthropic,
        req,
        chatId,
        kbModeEnabled,
        runtimeManagedResponse,
        systemPrompt: groceryReconciliationSystemPrompt,
        conversationContextCompact,
        pantryItems,
        draftItems: initialNormalizedItems,
      });
      const reconciledItems = await parseGroceryDraftItems({
        groceryResponse: reconciliationResponse,
        anthropic,
        householdId: req.householdId,
        chatId,
        kbModeEnabled,
        runtimeManagedResponse,
        deps,
      });
      if (Array.isArray(reconciledItems) && reconciledItems.length > 0) {
        finalNormalizedItems = reconciledItems;
        reconciledWithPantry = true;
        pantryAdjustedItemCount = Math.max(0, initialNormalizedItems.length - reconciledItems.length);
      }
    } catch (error) {
      console.error('Grocery pantry reconciliation failed:', error?.message || error);
    }
  }

  const finalRunKeys = new Set(finalNormalizedItems.map((i) => deps.normalizeInventoryNameKey(i.name)).filter(Boolean));
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

  const outcome = {
    capability: 'grocery.write',
    status: 'committed',
    changed: groceryListWasUpdated,
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
