import {
  getGroceryItems,
  getMessages,
  setChatRuntimeState,
} from './db.mjs';
import { createLoggedAnthropicMessage } from './anthropic-usage.mjs';
import { resolveAnthropicModelForCallPurpose } from './anthropic-model-policy.mjs';
import { buildGroceryChoiceNextStep } from './grocery-smart-skill.mjs';

function buildLegacyGroceryReply(outcome) {
  if (!outcome || typeof outcome !== 'object') return 'I was not able to build a grocery list from our conversation.';
  if (outcome.status === 'needs_mode_choice') return outcome.question;
  if (outcome.status === 'committed') {
    if (outcome.changed) return 'I updated the grocery list. Head over to the Grocery List tab to check it.';
    if (Number(outcome.parsedItemCount || 0) > 0) {
      return "The grocery list already had those items, so there wasn't anything new to update.";
    }
    return 'I was not able to build a grocery list from our conversation.';
  }
  return 'I was not able to build a grocery list from our conversation.';
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

export async function runWeeklyPlanGroceryDraftOfferResponse(params) {
  const {
    req,
    name,
    chatId,
    prompt,
    memories,
    anthropic,
    deps,
    res,
  } = params;

  const outcome = await executeGroceryPreview(
    { capability: 'grocery.preview', input: {} },
    { req, name, chatId, prompt, memories, anthropic, legacyCommandMode: true, runtimeManagedResponse: true, deps }
  );
  const reply = String(outcome?.reply || '').trim() || 'I couldn’t generate a grocery preview right now.';

  await deps.incrementUserMessageCountForSender(req);
  await deps.addMessage(chatId, req.householdId, 'user', name, prompt);
  await deps.addMessage(chatId, req.householdId, 'assistant', 'KitchenBot', reply);
  await setChatRuntimeState(chatId, req.householdId, {
    mode: 'smart',
    proposedNextAction:
      outcome?.proposedNextAction && typeof outcome.proposedNextAction === 'object' && !Array.isArray(outcome.proposedNextAction)
        ? outcome.proposedNextAction
        : {},
  }).catch(() => {});
  deps.broadcastToChat?.(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return res.end(reply);
}

export async function executeGroceryPreview(runtimeAction, context) {
  const {
    req,
    chatId,
    prompt,
    memories = [],
    anthropic,
    deps = {},
  } = context;

  const memoryText = memories.map((m) => `${m.key}: ${m.value}`).join('\n');
  const conversation = await getMessages(chatId, req.householdId);
  const conversationForContext = conversation.filter(
    (m) => m.role !== 'user' || !String(m.content || '').trim().startsWith('!')
  );
  const recentConversation = conversationForContext.length > 40 ? conversationForContext.slice(-40) : conversationForContext;
  const conversationContextCompact = buildGroceryConversationContextForPrompt(recentConversation, deps);

  let reply =
    'I couldn’t generate a draft list in chat right now. The Grocery List tab is unchanged, but I can still try updating it from this conversation.';
  let previewRendered = false;
  try {
    const callPurpose = 'grocery_draft_generation';
    const groceryResponse = await createLoggedAnthropicMessage(anthropic, {
      model: resolveAnthropicModelForCallPurpose(callPurpose),
      max_tokens: 400,
      system: `You suggest ingredients to buy based on the cooking and meal discussion in a household chat. Output ONLY lines in this format (no other text):
section | product | amount
section is one of: produce, meat, dairy, frozen, dry, other

Household memory:
${memoryText || '(none)'}

Conversation context for this chat:
${conversationContextCompact}

Personalization rules:
- Treat saved people/preferences in household memory as real constraints for the list.
- Avoid ingredients that clearly conflict with saved dislikes or food constraints.
- Use household-style notes like concise recipes to prefer simpler ingredient sets when reasonable.`,
      messages: [
        {
          role: 'user',
          content: `User said: ${String(prompt).trim()}\n\nBuild a shopping list from the cooking and meal discussion in this chat.`,
        },
      ],
    }, {
      householdId: req.householdId,
      chatId,
      smartModeEnabled: true,
      callSurface: 'background',
      callPurpose,
      webSearchEnabledAtCall: false,
      usedWebSearchTool: false,
    });
    const textBlocks = groceryResponse.content.filter((block) => block.type === 'text');
    const fullText = textBlocks.map((b) => b.text).join('\n');
    const rawLines = fullText.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    const items = [];
    for (const line of rawLines) {
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
    const normalizedItems = deps.normalizeGroceryItemsForPost(items);
    if (normalizedItems.length > 0) {
      const lead = await deps.generateSmartGroceryPreviewLead?.({
        anthropic,
        prompt,
        contextSummary: conversationContextCompact,
        itemCount: normalizedItems.length,
        householdId: req.householdId,
        chatId,
      });
      const artifact = String(deps.formatSmartGroceryPreviewArtifact?.(normalizedItems) ?? '').trim();
      if (artifact) {
        const followUp =
          (await deps.generateSmartGroceryPreviewCommitReply?.({
            anthropic,
            prompt,
            contextSummary: conversationContextCompact,
            itemCount: normalizedItems.length,
            householdId: req.householdId,
            chatId,
          })) || "If you'd like, I can put this into your Grocery List tab next.";
        reply = [lead, artifact, followUp].filter(Boolean).join('\n\n');
        previewRendered = true;
      } else {
        reply =
          "I wasn't able to render the grocery preview in chat this time, so I left the Grocery List tab unchanged.";
      }
    } else {
      reply =
        "I wasn’t able to turn this conversation into specific ingredient lines in chat this time. The Grocery List tab is still unchanged. If you want, I can still try building the list into the tab from what we discussed.";
    }
  } catch (e) {
    console.error('Weekly plan grocery draft generation failed:', e?.message || e);
  }

  const proposedNextAction = previewRendered
    ? {
      active: true,
        type: 'confirm',
        createdAt: Date.now(),
        action: { capability: 'grocery.generate_and_commit', input: {} },
        question: "If you'd like, I can put this into your Grocery List tab next.",
        visibleReplySummary: String(reply ?? '').trim().slice(0, 400),
      }
    : null;

  return {
    capability: 'grocery.preview',
    status: previewRendered ? 'preview_ready' : 'preview_unavailable',
    reply,
    previewRendered,
    proposedNextAction,
  };
}

export async function executeGroceryGenerateAndCommit(runtimeAction, context) {
  const {
    req,
    name,
    chatId,
    prompt,
    memories = [],
    anthropic,
    legacyCommandMode = false,
    skipIncrement = false,
    userMessageAlreadyPersisted = false,
    smartModeEnabled = false,
    legacyRememberAck = null,
    legacyWeeklyPatchAck = null,
    runtimeManagedResponse = false,
    deps = {},
  } = context;
  const persistedUserLine = !!userMessageAlreadyPersisted;

  if (!skipIncrement) {
    await deps.incrementUserMessageCountForSender?.(req);
  }

  const requestedGroceryMode = runtimeAction?.input?.mode || null;
  const requestedSource = runtimeAction?.input?.source || null;
  const conversation = await getMessages(chatId, req.householdId);
  const conversationForContext = conversation.filter(
    (m) => m.role !== 'user' || !String(m.content || '').trim().startsWith('!')
  );
  const recentConversation = conversationForContext.length > 40 ? conversationForContext.slice(-40) : conversationForContext;

  const existingGroceryItems = await getGroceryItems(req.householdId);

  const memoryText = memories.map((memory) => `${memory.key}: ${memory.value}`).join('\n');
  const conversationContextCompact = buildGroceryConversationContextForPrompt(recentConversation, deps);
  const disambigPrefix =
    [legacyWeeklyPatchAck, legacyRememberAck]
      .map((x) => (x && String(x).trim()) || '')
      .filter(Boolean)
      .join(' ') || null;

  const claudeMessages = recentConversation.map((message) => ({
    role: message.role,
    content:
      message.role === 'user'
        ? `${message.name}: ${message.content}`
        : deps.stripStoredMessageContentForDisplay(message.content),
  }));

  const groceryCallPurpose = 'grocery_draft_generation';
  const groceryResponse = await createLoggedAnthropicMessage(anthropic, {
    model: resolveAnthropicModelForCallPurpose(groceryCallPurpose),
    max_tokens: 400,
    system: `You are a household assistant that generates grocery lists.

Household memory:
${memoryText}

Conversation context for this chat:
${conversationContextCompact}

Personalization rules:
- Treat saved people/preferences in household memory as real constraints for the list.
- Avoid ingredients that clearly conflict with saved dislikes or food constraints.
- If household preferences imply simpler cooking, prefer leaner ingredient sets when reasonable.

When the user asks for a grocery list, respond ONLY with plain text lines in the format:
section | product | amount

Where:
- section is one of: produce, meat, dairy, frozen, dry, other
- product is a short item name
- amount is a human-readable quantity (like "2 lbs", "3", "1 carton")`,
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
    smartModeEnabled: !!smartModeEnabled,
    callSurface: runtimeManagedResponse ? 'smart_action' : 'command',
    callPurpose: groceryCallPurpose,
    webSearchEnabledAtCall: false,
    usedWebSearchTool: false,
  });

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

  const normalizedItems = deps.normalizeGroceryItemsForPost(items);
  const priorKeys = new Set(
    existingGroceryItems
      .map((item) => deps.normalizeGroceryNameKey(item?.name))
      .filter(Boolean)
  );
  const runKeys = new Set(normalizedItems.map((i) => deps.normalizeGroceryNameKey(i.name)).filter(Boolean));
  const likelyRemovedKeys = new Set([...priorKeys].filter((k) => !runKeys.has(k)));
  const likelyAddedKeys = new Set([...runKeys].filter((k) => !priorKeys.has(k)));
  const draftChatOfferCommit = requestedSource === 'draft_chat_offer';
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
    let replyForStore = deps.combinePlannerDisambiguationWithRememberAck(disambigPrefix, question);
    if (!runtimeManagedResponse && !persistedUserLine) {
      await deps.addMessage?.(chatId, req.householdId, 'user', name, prompt);
    }
    if (!runtimeManagedResponse) {
      await deps.addMessage?.(chatId, req.householdId, 'assistant', 'KitchenBot', replyForStore);
      deps.broadcastToChat?.(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });
    }
    return {
      capability: 'grocery.generate_and_commit',
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
    capability: 'grocery.generate_and_commit',
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
    await deps.addMessage?.(chatId, req.householdId, 'assistant', 'KitchenBot', buildLegacyGroceryReply(outcome));
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

export async function runGrocerySharedCommandEffects(params) {
  const {
    req,
    name,
    chatId,
    commandUserTextForPersistence,
    routePrompt,
    executePendingAction,
    memories,
    anthropic,
    legacyCommandMode = false,
    skipIncrement = false,
    userMessageAlreadyPersisted = false,
    smartModeEnabled = false,
    legacyRememberAck = null,
    legacyWeeklyPatchAck = null,
    runtimeManagedResponse = false,
    deps = {},
  } = params;

  const runtimeAction = {
    capability: 'grocery.generate_and_commit',
    input: {
      mode: executePendingAction?.command === '!grocerylist' ? executePendingAction.mode : undefined,
      source: executePendingAction?.command === '!grocerylist' ? executePendingAction.source : undefined,
    },
  };
  const outcome = await executeGroceryGenerateAndCommit(runtimeAction, {
    req,
    name,
    chatId,
    prompt: commandUserTextForPersistence,
    routePrompt,
    executePendingAction,
    memories,
    anthropic,
    legacyCommandMode,
    skipIncrement,
    userMessageAlreadyPersisted,
    smartModeEnabled,
    legacyRememberAck,
    legacyWeeklyPatchAck,
    runtimeManagedResponse,
    deps,
  });

  if (outcome.status === 'needs_mode_choice') {
    const optionModes = Array.isArray(outcome.optionModes) ? outcome.optionModes : [];
    const pendingHeader = encodeURIComponent(
      JSON.stringify({
        type: 'grocery_mode_choice',
        options: optionModes.map((mode) => ({ command: '!grocerylist', mode })),
      })
    );
    return {
      type: 'disambiguation',
      reply: outcome.reply,
      pendingHeader,
      outcome,
    };
  }

  return {
    type: 'done',
    reply: buildLegacyGroceryReply(outcome),
    outcome,
  };
}
