import {
  getGroceryItems,
  getMessages,
} from './db.mjs';
import { createLoggedAnthropicMessage } from './anthropic-usage.mjs';
import { resolveAnthropicModelForCallPurpose } from './anthropic-model-policy.mjs';
import { resolveInventoryItems } from './inventory-classification.mjs';
import { buildKbContextSystemText } from './kb-prompt-context.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

function buildGroceryChoiceNextStep({ optionModes, question, reply, actionInputBase = {}, choiceLabels = {} }) {
  const choices = optionModes.map((mode) => ({
    id: mode,
    label: String(choiceLabels?.[mode] ?? mode).trim() || mode,
    actionInput: { ...actionInputBase, mode },
  }));
  return {
    active: true,
    type: 'choice',
    createdAt: Date.now(),
    action: { capability: 'grocery.write', input: {} },
    choices,
    question,
    visibleReplySummary: String(reply ?? '').trim().slice(0, 400),
  };
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

  async function parseDraftItems(groceryResponse) {
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
    return await resolveInventoryItems({
      target: 'grocery',
      items,
      anthropic: anthropic || null,
      householdId: req.householdId,
      chatId,
      runtimeEnabled: !!kbModeEnabled,
      callSurface: runtimeManagedResponse ? 'kb_action' : 'chat',
    });
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

  let normalizedItems = await parseDraftItems(groceryResponse);
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
    normalizedItems = await parseDraftItems(groceryResponse);
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
    conversationContextCompact,
    normalizedItems,
    priorKeys,
    runKeys,
    likelyRemovedKeys,
    likelyAddedKeys,
    draftChatOfferCommit,
  };
}

export async function previewGroceryListFromConversation(runtimeAction, context) {
  const draft = await generateGroceryDraft(runtimeAction, context);
  const hasExistingList = draft.existingGroceryItems.length > 0;
  const optionModes = hasExistingList ? ['append', 'replace'] : ['append'];
  const question =
    hasExistingList
      ? 'If you want, I can add these items to your Grocery List tab or replace the current Grocery List tab with them.'
      : 'If you want, I can add these items to your Grocery List tab.';
  return {
    capability: 'grocery.preview',
    status: draft.normalizedItems.length > 0 ? 'previewed' : 'empty',
    parsedItemCount: draft.normalizedItems.length,
    items: draft.normalizedItems,
    hasExistingList,
    optionModes,
    question,
    proposedNextAction:
      draft.normalizedItems.length > 0
        ? buildGroceryChoiceNextStep({
            optionModes,
            question,
            reply: question,
            actionInputBase: { source: 'draft_chat_offer' },
            choiceLabels: {
              append: 'add this to the Grocery List tab',
              replace: 'replace current list',
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
    conversationContextCompact,
    normalizedItems,
    runKeys,
    likelyRemovedKeys,
    draftChatOfferCommit,
  } = draft;
  if (requestedGroceryMode == null && existingGroceryItems.length > 0 && normalizedItems.length > 0) {
    const optionModes =
      !draftChatOfferCommit && likelyRemovedKeys.size > 0
        ? ['replace', 'append', 'prune']
        : ['replace', 'append'];
    const question =
      optionModes.includes('prune')
        ? 'I found items already on your Grocery List tab. I can start fresh, add these on top, or remove the items that no longer fit. Which do you want?'
        : ((await deps.generateSmartGroceryModeChoiceReply?.({
            anthropic,
            prompt,
            contextSummary: conversationContextCompact,
            choiceMode: 'replace_or_append',
            householdId: req.householdId,
            chatId,
          })) ||
          "I found items already on your Grocery List tab. I can either replace that list with this week's ingredients or add these on top. Which do you want?");
    const replyForStore = question;
    if (!runtimeManagedResponse && !persistedUserLine) {
      await deps.addMessage?.(chatId, req.householdId, 'user', name, prompt);
    }
    if (!runtimeManagedResponse) {
      await deps.addMessage?.(chatId, req.householdId, 'assistant', 'KitchenBot', replyForStore);
      deps.broadcastToChat?.(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });
    }
    return {
      capability: 'grocery.write',
      status: 'needs_mode_choice',
      question,
      reply: replyForStore,
      optionModes,
      proposedNextAction: buildGroceryChoiceNextStep({
        optionModes,
        question,
        reply: replyForStore,
      }),
    };
  }

  const effectiveGroceryMode = requestedGroceryMode || 'append';
  const beforeGroceryCount = existingGroceryItems.length;
  let replaceClearedCount = 0;
  let prunedCount = 0;
  if (effectiveGroceryMode === 'replace') {
    replaceClearedCount = await deps.clearGroceryItems(req.householdId);
  } else if (effectiveGroceryMode === 'prune') {
    try {
      prunedCount = await deps.pruneStaleGroceryItemsForChat(req.householdId, runKeys, chatId, likelyRemovedKeys);
    } catch (e) {
      console.error('Grocery prune failed:', e?.message || e);
    }
  }

  let mergeStats = { insertedCount: 0, updatedCount: 0, backfilledCount: 0, changedCount: 0 };
  if (normalizedItems.length > 0) {
    mergeStats = await deps.mergeGroceryItemsFromAi(req.householdId, normalizedItems, chatId);
  }

  const afterGroceryItems = await getGroceryItems(req.householdId);
  const afterGroceryCount = afterGroceryItems.length;
  const totalDbContentChanges = replaceClearedCount + prunedCount + mergeStats.changedCount;
  const groceryListWasUpdated = totalDbContentChanges > 0;

  const outcome = {
    capability: 'grocery.write',
    status: 'committed',
    changed: groceryListWasUpdated,
    mode: effectiveGroceryMode,
    parsedItemCount: normalizedItems.length,
    counts: {
      inserted: mergeStats.insertedCount,
      updated: mergeStats.updatedCount,
      pruned: prunedCount,
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
