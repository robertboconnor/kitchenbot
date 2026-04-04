import {
  addMessage,
  clearChatRuntimeState,
  ensureUserComplimentStateRow,
  getChatThreadContext,
  getMemories,
  getHouseholdUserById,
  getMessages,
  getUserComplimentState,
  recordCompliment,
  selectComplimentAvoidingRecent,
  setChatRuntimeState,
  shouldTriggerCompliment,
  updateChatTitle,
} from './db.mjs';
import {
  appendPendingMarkerToAssistantContent,
  groceryTabOfferTextMatchesForPending,
} from './pending-state.mjs';
import {
  pendingActionToRuntimeAction,
  renderSmartExecutionOutcomes,
  renderSmartHelpReply,
  renderSmartPendingReply,
  runtimeActionToPendingAction,
} from './capability-registry.mjs';
import { weeklyPlanDraftHasMeaningfulContent, isWeeklyPlanningLikeUserTurn } from './interaction-engine.mjs';
import { createLoggedAnthropicMessage, finalizeLoggedAnthropicStream } from './anthropic-usage.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

function formatSmartWeeklyArtifactFromDeps(deps, draft) {
  if (typeof deps.formatSmartWeeklyPlanArtifact === 'function') {
    return deps.formatSmartWeeklyPlanArtifact(draft);
  }
  return deps.formatWeeklyPlanDraftVisibleBlock(draft);
}

async function generateSmartPendingExplanation({
  anthropic,
  req,
  chatId,
  routePrompt,
  runtimeAction,
  fallback,
  deps,
}) {
  if (!anthropic || !runtimeAction || typeof runtimeAction !== 'object') {
    return fallback;
  }
  try {
    const threadCtx = await getChatThreadContext(chatId, req.householdId);
    const payload = {
      userMessage: safeTrim(routePrompt),
      capability: String(runtimeAction.capability ?? ''),
      input: runtimeAction.input && typeof runtimeAction.input === 'object' ? runtimeAction.input : {},
      weeklyPlanDraftCompact: deps.formatWeeklyPlanDraftForPrompt(threadCtx.weeklyPlanDraft ?? {}),
      threadMealPlanSummary: safeTrim(threadCtx.mealPlanSummary) || '(none)',
      threadGrocerySummary: safeTrim(threadCtx.threadGrocerySummary) || '(none)',
      fallback,
    };
    const response = await createLoggedAnthropicMessage(anthropic, {
      model: 'claude-sonnet-4-5',
      max_tokens: 120,
      system: `You write one short KitchenBot follow-up before an app action happens.

Output plain text only.
Use first person.
Be natural, concise, and human.
Do not mention capabilities, JSON, commands, hidden state, internal workflow, or code.
Do not claim the action already happened.
If confirmation is needed, ask it naturally in one short line.
If the user already clearly asked for the action, do not sound redundant or robotic.
The fallback line is safe but should only be copied if needed.`,
      messages: [
        {
          role: 'user',
          content: `Context JSON:\n${JSON.stringify(payload)}`,
        },
      ],
    }, {
      householdId: req.householdId,
      chatId,
      smartModeEnabled: true,
      callSurface: 'background',
      callPurpose: 'smart_pending_explanation',
      webSearchEnabledAtCall: false,
      usedWebSearchTool: false,
    });
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    return text || fallback;
  } catch (e) {
    console.error('Smart pending explanation generation failed:', e?.message || e);
    return fallback;
  }
}

async function generateSmartOutcomeExplanation({
  anthropic,
  req,
  chatId,
  routePrompt,
  outcomes,
  appendWeeklyPlanVisible = false,
  deps,
}) {
  const fallback = renderSmartExecutionOutcomes(outcomes) || 'Done.';
  if (!anthropic || !Array.isArray(outcomes) || outcomes.length === 0) {
    return fallback;
  }

  try {
    const threadCtx = await getChatThreadContext(chatId, req.householdId);
    const memories = await getMemories(req.householdId);
    const compactMemories = memories
      .filter((memory) => memory.key !== 'assistant_name')
      .map((memory) => `${memory.key}: ${memory.value}`)
      .join('\n');
    const payload = {
      userMessage: String(routePrompt ?? '').trim(),
      trustedExecutedOutcomes: outcomes,
      fallbackTrustedSummary: fallback,
      weeklyPlanDraftCompact: deps.formatWeeklyPlanDraftForPrompt(threadCtx.weeklyPlanDraft ?? {}),
      weeklyPlanMealsIndexed:
        Array.isArray(threadCtx.weeklyPlanDraft?.meals) && threadCtx.weeklyPlanDraft.meals.length > 0
          ? threadCtx.weeklyPlanDraft.meals
              .map((meal, index) => `${index + 1}. ${String(meal ?? '').trim()}`)
              .filter(Boolean)
              .join('\n')
          : '(none)',
      threadMealPlanSummary: String(threadCtx.mealPlanSummary ?? '').trim() || '(none)',
      threadGrocerySummary: String(threadCtx.threadGrocerySummary ?? '').trim() || '(none)',
      householdMemoriesCompact: compactMemories || '(none)',
      serverAppendsWeeklyPlanBlock: appendWeeklyPlanVisible === true,
    };
    const response = await createLoggedAnthropicMessage(anthropic, {
      model: 'claude-sonnet-4-5',
      max_tokens: 260,
      system: `You write KitchenBot's final reply after the server has already completed app-side actions.

Output plain text only.
Use first person ("I").
Be natural and concise.
Ground every claim ONLY in trustedExecutedOutcomes and the supplied state.
Do not mention capabilities, JSON, commands, hidden state, or internal tooling.
Do not claim any action happened unless it appears in trustedExecutedOutcomes.
If there were multiple outcomes, combine them into one natural reply.
If serverAppendsWeeklyPlanBlock is true, do not reproduce the full weekly plan in your reply because the server will append it separately.
If fallbackTrustedSummary contains a confirmed fact, you may reuse that fact naturally, but do not copy it mechanically.
Do not ask for confirmation. The actions already happened.
For weekly plan updates, sound like a collaborative meal planner rather than a state editor.
Prefer language like "I swapped in miso-glazed salmon and kept the rest of the plan intact" over slot numbers, targeted updates, or patch terminology.
When the current weekly plan helps explain the change, you may briefly mention the new meal idea, but keep it concise.`,
      messages: [
        {
          role: 'user',
          content: `Context JSON:\n${JSON.stringify(payload)}`,
        },
      ],
    }, {
      householdId: req.householdId,
      chatId,
      smartModeEnabled: true,
      callSurface: 'background',
      callPurpose: 'smart_outcome_explanation',
      webSearchEnabledAtCall: false,
      usedWebSearchTool: false,
    });
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    return text || fallback;
  } catch (e) {
    console.error('Smart outcome explanation generation failed:', e?.message || e);
    return fallback;
  }
}

async function persistSmartRuntimePending(chatId, householdId, pendingAction = null, checkpoint = {}) {
  if (pendingAction) {
    return setChatRuntimeState(chatId, householdId, {
      mode: 'smart',
      pending: { action: pendingAction },
      checkpoint: checkpoint && typeof checkpoint === 'object' && !Array.isArray(checkpoint) ? checkpoint : {},
    });
  }
  return setChatRuntimeState(chatId, householdId, {
    mode: 'smart',
    pending: {},
    checkpoint: checkpoint && typeof checkpoint === 'object' && !Array.isArray(checkpoint) ? checkpoint : {},
  });
}

export async function respondWithSmartPending(params) {
  const {
    anthropic = null,
    req,
    res,
    name,
    chatId,
    routePrompt,
    runtimeAction = null,
    pendingAction: pendingActionRaw = null,
    pendingHeader = null,
    replyText = '',
    memoriesByKey,
    checkpoint = null,
    plannerUserMessageAlreadyPersisted = false,
    deps,
  } = params;

  const pendingAction = pendingActionRaw || (runtimeAction ? runtimeActionToPendingAction(runtimeAction) : null);
  const pendingRuntimeAction = runtimeAction || pendingActionToRuntimeAction(pendingAction);
  const reply =
    safeTrim(replyText) ||
    (pendingRuntimeAction
      ? await generateSmartPendingExplanation({
          anthropic,
          req,
          chatId,
          routePrompt,
          runtimeAction: pendingRuntimeAction,
          fallback: renderSmartPendingReply(pendingRuntimeAction, memoriesByKey),
          deps,
        })
      : 'I need a quick confirmation before I do that.');

  if (!plannerUserMessageAlreadyPersisted) {
    await addMessage(chatId, req.householdId, 'user', name, routePrompt);
    await deps.incrementUserMessageCountForSender(req);
  }
  const storedAssistant = pendingAction ? appendPendingMarkerToAssistantContent(reply, pendingAction) : reply;
  await addMessage(chatId, req.householdId, 'assistant', 'KitchenBot', storedAssistant);
  if (typeof deps.broadcastToChat === 'function') {
    deps.broadcastToChat(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });
  }
  await persistSmartRuntimePending(chatId, req.householdId, pendingAction, checkpoint || {}).catch(() => {});

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  if (pendingAction) {
    res.setHeader('X-KitchenBot-Pending-Action', encodeURIComponent(JSON.stringify(pendingAction)));
  } else if (pendingHeader) {
    res.setHeader('X-KitchenBot-Pending-Action', pendingHeader);
  }
  return res.end(reply);
}

export async function respondWithSmartClarify(params) {
  const { req, res, name, chatId, routePrompt, question, deps } = params;
  const reply = safeTrim(question) || 'Can you clarify what you want me to do?';
  await addMessage(chatId, req.householdId, 'user', name, routePrompt);
  await deps.incrementUserMessageCountForSender(req);
  await addMessage(chatId, req.householdId, 'assistant', 'KitchenBot', reply);
  await clearChatRuntimeState(chatId, req.householdId).catch(() => {});
  if (typeof deps.broadcastToChat === 'function') {
    deps.broadcastToChat(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return res.end(reply);
}

export async function respondWithSmartReply(params) {
  const {
    req,
    res,
    name,
    chatId,
    routePrompt,
    replyText,
    plannerUserMessageAlreadyPersisted = false,
    appendWeeklyPlanVisible = false,
    deps,
  } = params;

  if (!plannerUserMessageAlreadyPersisted) {
    await addMessage(chatId, req.householdId, 'user', name, routePrompt);
    await deps.incrementUserMessageCountForSender(req);
  }

  let finalReply = safeTrim(replyText) || 'Done.';
  if (appendWeeklyPlanVisible) {
    const threadCtx = await getChatThreadContext(chatId, req.householdId);
    if (weeklyPlanDraftHasMeaningfulContent(threadCtx.weeklyPlanDraft ?? {})) {
      const visible = formatSmartWeeklyArtifactFromDeps(deps, threadCtx.weeklyPlanDraft ?? {});
      if (visible) finalReply += `\n\n${visible}`;
    }
  }

  await addMessage(chatId, req.householdId, 'assistant', 'KitchenBot', finalReply);
  await clearChatRuntimeState(chatId, req.householdId).catch(() => {});
  if (typeof deps.broadcastToChat === 'function') {
    deps.broadcastToChat(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return res.end(finalReply);
}

export async function respondWithSmartOutcomes(params) {
  const {
    outcomes = [],
    anthropic = null,
    req,
    chatId,
    routePrompt,
    appendWeeklyPlanVisible = false,
    deps,
    ...rest
  } = params;
  const replyText = await generateSmartOutcomeExplanation({
    anthropic,
    req,
    chatId,
    routePrompt,
    outcomes,
    appendWeeklyPlanVisible,
    deps,
  });
  return respondWithSmartReply({
    req,
    chatId,
    routePrompt,
    appendWeeklyPlanVisible,
    deps,
    ...rest,
    replyText,
  });
}

export async function runSmartConversationReply(params) {
  const {
    req,
    res,
    name,
    chatId,
    prompt,
    turn,
    memories,
    memoriesByKey,
    anthropic,
    householdWebSearchEnabled,
    smartModeEnabled,
    deps,
  } = params;

  const {
    routePrompt,
    plannerUserMessageAlreadyPersisted = false,
    plannerSkipMixedMemoryOffer = false,
    plannerStreamCompletedActionsAck = null,
    skipWeeklyPlanDraftAutoUpdater = false,
    smartModeMixedMemoryHint = false,
    smartModeClarifyHint = false,
  } = turn;

  if (!plannerUserMessageAlreadyPersisted) {
    await addMessage(chatId, req.householdId, 'user', name, routePrompt);
    await deps.incrementUserMessageCountForSender(req);
    if (typeof deps.broadcastToChat === 'function') {
      deps.broadcastToChat(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });
    }
  }

  const conversation = await getMessages(chatId, req.householdId);
  const conversationForContext = conversation.filter(
    (m) => m.role !== 'user' || !String(m.content || '').trim().startsWith('!')
  );
  const recentConversation = conversationForContext.length > 40 ? conversationForContext.slice(-40) : conversationForContext;
  const memoryText = memories.map((memory) => `${memory.key}: ${memory.value}`).join('\n');
  const threadCtx = await getChatThreadContext(chatId, req.householdId);
  const mainThreadScene =
    threadCtx.threadScene && typeof threadCtx.threadScene === 'object' && !Array.isArray(threadCtx.threadScene)
      ? threadCtx.threadScene
      : {};
  const threadSceneCompactMain = Object.keys(mainThreadScene).length === 0
    ? '(empty)'
    : deps.truncateSmartModeContext(JSON.stringify(mainThreadScene), 800);
  const weeklyPlanDraftCompact = deps.formatWeeklyPlanDraftForPrompt(threadCtx.weeklyPlanDraft ?? {});
  const claudeMessages = recentConversation.map((message) => ({
    role: message.role,
    content:
      message.role === 'user'
        ? `${message.name}: ${message.content}`
        : deps.stripStoredMessageContentForDisplay(message.content),
  }));
  const userMessagesForTitle = conversation.filter((m) => m.role === 'user');
  const shouldNameChat = userMessagesForTitle.length === 1 || userMessagesForTitle.length === 3;

  if (shouldNameChat) {
    try {
      const titleResponse = await createLoggedAnthropicMessage(anthropic, {
        model: 'claude-sonnet-4-5',
        max_tokens: 30,
        system:
          'You generate very short chat titles (3-6 words) based on the conversation. Respond with ONLY the title text, no quotes or punctuation.',
        messages: [
          ...claudeMessages.slice(-10),
          {
            role: 'user',
            content: 'Based on this conversation, generate a very short, descriptive title for this chat (3-6 words only, no quotes).',
          },
        ],
      }, {
        householdId: req.householdId,
        chatId,
        smartModeEnabled: true,
        callSurface: 'background',
        callPurpose: 'chat_title_generation',
        webSearchEnabledAtCall: false,
        usedWebSearchTool: false,
      });
      const titleBlocks = titleResponse.content.filter((b) => b.type === 'text');
      const rawTitle = titleBlocks.map((b) => b.text).join(' ').trim().split('\n')[0].trim();
      const safeTitle = rawTitle && rawTitle.length > 0 ? rawTitle.slice(0, 80) : 'New chat';
      await updateChatTitle(chatId, req.householdId, safeTitle);
    } catch (e) {
      if (deps.isAnthropicSdkAuthOrKeyError?.(e)) throw e;
      console.error('Title generation failed:', e);
    }
  }

  const allowLegacyMixedMemoryProposal = false;
  let mixedMemoryProposal = null;
  let mixedMemoryOfferLine = null;
  if (allowLegacyMixedMemoryProposal && smartModeEnabled && deps.hasStrongMemoryIntentKeywords(routePrompt) && !plannerSkipMixedMemoryOffer) {
    const proposed = await deps.tryAiMemoryProposal(anthropic, routePrompt, memories, threadCtx, {
      isAnthropicSdkAuthOrKeyError: deps.isAnthropicSdkAuthOrKeyError,
      householdId: req.householdId,
      chatId,
    });
    if (proposed) {
      const mixed = deps.isMixedIntentMemoryMessage(routePrompt) || !!smartModeMixedMemoryHint;
      if (!mixed) {
        return respondWithSmartPending({
          req,
          res,
          name,
          chatId,
          routePrompt,
          pendingAction: proposed,
          replyText: renderSmartPendingReply(pendingActionToRuntimeAction(proposed), memoriesByKey),
          memoriesByKey,
          plannerUserMessageAlreadyPersisted,
          deps,
        });
      }
      mixedMemoryProposal = proposed;
      mixedMemoryOfferLine = deps.buildMixedMemoryOfferLine(proposed, routePrompt);
    }
  }

  const mixedIntentBlock = mixedMemoryProposal
    ? `\n\nMixed-intent (this user message): They asked for a primary task plus a memory-like fact. Complete the primary task first; apply the memory fact in-context. Do NOT add any line offering to save to household memory or asking to confirm a save.`
    : '';
  const useWebSearchTool = householdWebSearchEnabled && deps.shouldEnableWebSearchForPrompt(routePrompt);
  const webSearchCapabilityBlock = useWebSearchTool
    ? `Web (this request): Anthropic web_search IS attached. Only attribute content to a site or URL if the search tool actually returned that material this turn.`
    : householdWebSearchEnabled
      ? `Web (this request): Web search is NOT attached—no live fetch of links for this reply.`
      : `Web (this request): Web search is off for this household.`;
  const smartModeClarifyBlock =
    smartModeEnabled && smartModeClarifyHint
      ? `\nSmart Mode hint: If the user message is ambiguous, ask one short clarifying question before answering.`
      : '';
  const plannerCompletedActionsBlock = plannerStreamCompletedActionsAck
    ? `\nPlanner (this request): The server already completed these actions; you may acknowledge them as fact:\n${plannerStreamCompletedActionsAck}`
    : '';
  const weeklyPlanServerVisibleHint =
    smartModeEnabled &&
    (skipWeeklyPlanDraftAutoUpdater || isWeeklyPlanningLikeUserTurn(routePrompt, threadCtx.weeklyPlanDraft ?? {}))
      ? `\nWeekly plan visibility: When this turn updates the chat's weekly dinner plan, the server appends a fixed "Weekly plan" block after your reply.`
      : '';
  const streamParams = {
    model: 'claude-sonnet-4-5',
    max_tokens: useWebSearchTool ? 4096 : 800,
    system: `You are KitchenBot: a concise household assistant. Always use first person (I/me/my).

App contract: This message is plain text only; it does not directly execute app actions or change stored state by itself.
- Do not claim I saved, updated, or changed the app this turn unless the thread shows a real server-confirmed outcome.
- Do not say I saved or updated household memory unless the thread history clearly shows the real confirmed save outcome.
${mixedIntentBlock}
${webSearchCapabilityBlock}
${smartModeClarifyBlock}
${plannerCompletedActionsBlock}
${weeklyPlanServerVisibleHint}

Ingredient vs grocery rules:
- If the user asks for ingredients, what goes into a meal, or what the current weekly plan includes, answer directly in plain language. That is usually a read-only reply.
- Only shift into grocery-list preview behavior when the user is asking what to buy, what to shop for, or for a grocery/shopping list.
- Only imply a Grocery List tab update or confirmation path when the reply truly includes a grocery/shopping list draft or the user clearly asked to change app state.

Thread meal-plan summary (read-only; updated when the Grocery List tab is refreshed; not the live Grocery tab):
${threadCtx.mealPlanSummary.trim() || '(none yet)'}

Thread grocery intent (read-only; not the live grocery_items list):
${threadCtx.threadGrocerySummary.trim() || '(none yet)'}

Weekly dinner plan draft (read-only; chat-scoped):
${weeklyPlanDraftCompact}

Thread scene (server-owned compact JSON for this chat; read-only):
${threadSceneCompactMain}

Household memory (read-only; edits via Settings or a confirmed save offer):
${memoryText}`,
    messages: claudeMessages,
  };
  if (useWebSearchTool) {
    streamParams.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
  }

  const stream = await anthropic.messages.stream(streamParams);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Accel-Buffering', 'no');
  if (mixedMemoryProposal) {
    res.setHeader('X-KitchenBot-Pending-Action', encodeURIComponent(JSON.stringify(mixedMemoryProposal)));
  }

  let finalReply = '';
  let streamRawAccum = '';
  const pendingOfferMarker = '[[KB_OFFER_GROCERY_UPDATE]]';
  let pendingOfferDecisionMade = false;
  let pendingOfferAction = null;
  let pendingOfferBuffer = '';
  let streamEnded = false;
  let displayEmittedLen = 0;

  function flushDisplayEmit() {
    const cleaned = deps.stripKitchenBotHiddenMarkers(streamRawAccum);
    let persistPlain = pendingOfferAction && !mixedMemoryProposal ? cleaned : deps.stripFakeGroceryOperationalLines(cleaned);
    if (!mixedMemoryProposal) persistPlain = deps.stripFakeMemoryPendingOfferLines(persistPlain);
    finalReply = persistPlain;
    if (mixedMemoryProposal) return;
    let emitPlain;
    if (pendingOfferAction) {
      emitPlain = deps.stripFakeMemoryPendingOfferLines(cleaned);
    } else {
      emitPlain = persistPlain;
      if (!streamEnded) {
        const lastNl = emitPlain.lastIndexOf('\n');
        if (lastNl === -1) return;
        emitPlain = emitPlain.slice(0, lastNl + 1);
      }
    }
    displayEmittedLen = Math.min(displayEmittedLen, emitPlain.length);
    const newSuffix = emitPlain.slice(displayEmittedLen);
    if (!newSuffix) return;
    displayEmittedLen += newSuffix.length;
    res.write(newSuffix);
    if (typeof deps.broadcastToChat === 'function') {
      deps.broadcastToChat(chatId, {
        type: 'stream_delta',
        householdId: req.householdId,
        chatId,
        delta: newSuffix,
        user: name,
      });
    }
  }

  function writeChatDelta(delta) {
    if (!delta) return;
    streamRawAccum += delta;
    flushDisplayEmit();
  }

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      const delta = event.delta.text;
      pendingOfferBuffer += delta;
      if (!pendingOfferDecisionMade) {
        if (pendingOfferBuffer.length >= pendingOfferMarker.length || pendingOfferBuffer.includes('\n') || pendingOfferBuffer.includes('\r')) {
          if (pendingOfferBuffer.startsWith(pendingOfferMarker)) {
            pendingOfferAction = { command: '!grocerylist', source: 'draft_chat_offer' };
            if (!mixedMemoryProposal) {
              res.setHeader('X-KitchenBot-Pending-Action', encodeURIComponent(JSON.stringify(pendingOfferAction)));
            }
            pendingOfferBuffer = pendingOfferBuffer.slice(pendingOfferMarker.length).replace(/^\s*\n/, '');
          }
          pendingOfferDecisionMade = true;
          if (pendingOfferBuffer) {
            writeChatDelta(pendingOfferBuffer);
            pendingOfferBuffer = '';
          }
        }
        continue;
      }
      writeChatDelta(delta);
    }
  }
  if (!pendingOfferDecisionMade) {
    if (pendingOfferBuffer.startsWith(pendingOfferMarker)) {
      pendingOfferAction = { command: '!grocerylist', source: 'draft_chat_offer' };
      if (!mixedMemoryProposal) {
        res.setHeader('X-KitchenBot-Pending-Action', encodeURIComponent(JSON.stringify(pendingOfferAction)));
      }
      pendingOfferBuffer = pendingOfferBuffer.slice(pendingOfferMarker.length).replace(/^\s*\n/, '');
    }
    if (pendingOfferBuffer) writeChatDelta(pendingOfferBuffer);
  }

  streamEnded = true;
  flushDisplayEmit();
  await finalizeLoggedAnthropicStream(stream, {
    householdId: req.householdId,
    chatId,
    smartModeEnabled: true,
    callSurface: 'chat',
    callPurpose: 'chat_reply',
    webSearchEnabledAtCall: householdWebSearchEnabled,
    usedWebSearchTool: useWebSearchTool,
  });

  const cleanedStreamForGroceryOffer = deps.stripKitchenBotHiddenMarkers(streamRawAccum);
  if (!pendingOfferAction && !mixedMemoryProposal && groceryTabOfferTextMatchesForPending(cleanedStreamForGroceryOffer)) {
    pendingOfferAction = { command: '!grocerylist', source: 'draft_chat_offer' };
    res.setHeader('X-KitchenBot-Pending-Action', encodeURIComponent(JSON.stringify(pendingOfferAction)));
    finalReply = deps.stripFakeMemoryPendingOfferLines(cleanedStreamForGroceryOffer);
  }
  if (!pendingOfferAction && !mixedMemoryProposal) finalReply = deps.stripFakeGroceryOperationalLines(finalReply);
  if (!mixedMemoryProposal) finalReply = deps.stripFakeMemoryPendingOfferLines(finalReply);

  if (mixedMemoryProposal) {
    finalReply = deps.stripModelAuthoredMemoryOfferLines(finalReply);
    if (mixedMemoryOfferLine) finalReply += '\n\n' + mixedMemoryOfferLine;
    res.write(finalReply);
    if (typeof deps.broadcastToChat === 'function') {
      deps.broadcastToChat(chatId, {
        type: 'stream_delta',
        householdId: req.householdId,
        chatId,
        delta: finalReply,
        user: name,
      });
    }
  }

  const senderForCompliment = await getHouseholdUserById(req.householdId, req.userId);
  const complimentsEnabled =
    senderForCompliment &&
    (senderForCompliment.compliments_enabled == null || Number(senderForCompliment.compliments_enabled) === 1);
  if (complimentsEnabled) {
    await ensureUserComplimentStateRow(req.userId);
    const state = await getUserComplimentState(req.userId);
    const { trigger } = shouldTriggerCompliment(state);
    if (trigger) {
      const { compliment, template } = selectComplimentAvoidingRecent(
        deps.compliments,
        deps.complimentTemplates,
        state
      );
      const complimentAppend = '\n\n' + template.replace('%s', compliment);
      finalReply += complimentAppend;
      await recordCompliment(req.userId, compliment, template);
      res.write(complimentAppend);
      if (typeof deps.broadcastToChat === 'function') {
        deps.broadcastToChat(chatId, {
          type: 'stream_delta',
          householdId: req.householdId,
          chatId,
          delta: complimentAppend,
          user: name,
        });
      }
    }
  }

  {
    const offerSep = mixedMemoryProposal && mixedMemoryOfferLine ? '\n\n' + mixedMemoryOfferLine : null;
    let beforeScrub = finalReply;
    let afterScrub = '';
    if (offerSep && finalReply.includes(offerSep)) {
      const idx = finalReply.lastIndexOf(offerSep);
      beforeScrub = finalReply.slice(0, idx);
      afterScrub = finalReply.slice(idx);
    }
    finalReply = deps.scrubUnsavedMemoryClaimsInNormalChatReply(beforeScrub) + afterScrub;
  }

  let weeklyPlanDraftSyncAwaited = false;
  let threadCtxForWeeklyVisible = threadCtx;
  if (smartModeEnabled && !skipWeeklyPlanDraftAutoUpdater && isWeeklyPlanningLikeUserTurn(routePrompt, threadCtx.weeklyPlanDraft ?? {})) {
    await deps.runWeeklyPlanDraftAutoUpdaterAfterNormalChat(anthropic, {
      smartModeEnabled,
      chatId,
      householdId: req.householdId,
      priorWeeklyPlanDraft: threadCtx.weeklyPlanDraft ?? {},
      routePrompt,
      finalAssistantReply: finalReply,
      threadMealPlanSummary: threadCtx.mealPlanSummary,
      threadGrocerySummary: threadCtx.threadGrocerySummary,
      skipBecausePlannerPatched: false,
    });
    weeklyPlanDraftSyncAwaited = true;
    threadCtxForWeeklyVisible = await getChatThreadContext(chatId, req.householdId);
  }

  let weeklyPlanVisibleAppend = '';
  if (skipWeeklyPlanDraftAutoUpdater && weeklyPlanDraftHasMeaningfulContent(threadCtx.weeklyPlanDraft ?? {})) {
    weeklyPlanVisibleAppend = formatSmartWeeklyArtifactFromDeps(deps, threadCtx.weeklyPlanDraft ?? {});
  } else if (weeklyPlanDraftSyncAwaited && weeklyPlanDraftHasMeaningfulContent(threadCtxForWeeklyVisible.weeklyPlanDraft ?? {})) {
    weeklyPlanVisibleAppend = formatSmartWeeklyArtifactFromDeps(deps, threadCtxForWeeklyVisible.weeklyPlanDraft ?? {});
  }
  if (weeklyPlanVisibleAppend) {
    const append = '\n\n' + weeklyPlanVisibleAppend;
    finalReply += append;
    res.write(append);
    if (typeof deps.broadcastToChat === 'function') {
      deps.broadcastToChat(chatId, {
        type: 'stream_delta',
        householdId: req.householdId,
        chatId,
        delta: append,
        user: name,
      });
    }
  }

  const streamPendingForMarker = mixedMemoryProposal || pendingOfferAction || null;
  const finalReplyToPersist = streamPendingForMarker
    ? appendPendingMarkerToAssistantContent(finalReply, streamPendingForMarker)
    : finalReply;
  await addMessage(chatId, req.householdId, 'assistant', 'KitchenBot', finalReplyToPersist);
  if (streamPendingForMarker) {
    await persistSmartRuntimePending(chatId, req.householdId, streamPendingForMarker, {}).catch(() => {});
  } else {
    await clearChatRuntimeState(chatId, req.householdId).catch(() => {});
  }

  void deps.runThreadSceneAutoUpdaterAfterNormalChat(anthropic, {
    smartModeEnabled,
    chatId,
    householdId: req.householdId,
    priorThreadScene: mainThreadScene,
    routePrompt,
    finalAssistantReply: finalReply,
    threadMealPlanSummary: threadCtxForWeeklyVisible.mealPlanSummary,
    threadGrocerySummary: threadCtxForWeeklyVisible.threadGrocerySummary,
    householdMemoriesCompact: memoryText,
    recentConversationForContext: recentConversation,
    trustedActionSummary: null,
  });
  void deps.runWeeklyPlanDraftAutoUpdaterAfterNormalChat(anthropic, {
    smartModeEnabled,
    chatId,
    householdId: req.householdId,
    priorWeeklyPlanDraft: threadCtx.weeklyPlanDraft ?? {},
    routePrompt,
    finalAssistantReply: finalReply,
    threadMealPlanSummary: threadCtx.mealPlanSummary,
    threadGrocerySummary: threadCtx.threadGrocerySummary,
    skipBecausePlannerPatched: skipWeeklyPlanDraftAutoUpdater || weeklyPlanDraftSyncAwaited,
  });
  if (typeof deps.broadcastToChat === 'function') {
    deps.broadcastToChat(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });
  }

  return res.end();
}

export { renderSmartHelpReply };
