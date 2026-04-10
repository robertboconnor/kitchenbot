import {
  addMessage,
  clearChatRuntimeState,
  getChatThreadContext,
  getMessages,
  setChatRuntimeState,
} from './db.mjs';
import { createLoggedAnthropicMessage } from './anthropic-usage.mjs';
import { resolveAnthropicModelForCallPurpose } from './anthropic-model-policy.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

export async function respondWithSmartClarify(params) {
  const { req, res, name, chatId, routePrompt, question, deps, statusEmitter = null } = params;
  const reply = safeTrim(question) || 'Can you clarify what you want me to do?';
  statusEmitter?.emit?.('writing_reply');
  await addMessage(chatId, req.householdId, 'user', name, routePrompt);
  await deps.incrementUserMessageCountForSender(req);
  await addMessage(chatId, req.householdId, 'assistant', 'KitchenBot', reply);
  if (typeof deps.maybeAutoNameChatOnTurn === 'function') {
    await deps.maybeAutoNameChatOnTurn({
      anthropic: null,
      householdId: req.householdId,
      chatId,
      smartModeEnabled: true,
      getMessages: deps.getMessages,
      updateChatTitleAutoIfUnlocked: deps.updateChatTitleAutoIfUnlocked,
      stripStoredMessageContentForDisplay: deps.stripStoredMessageContentForDisplay,
      isAnthropicSdkAuthOrKeyError: deps.isAnthropicSdkAuthOrKeyError,
      broadcastToChat: deps.broadcastToChat,
      broadcastUser: name,
    }).catch(() => {});
  }
  await clearChatRuntimeState(chatId, req.householdId).catch(() => {});
  if (typeof deps.broadcastToChat === 'function') {
    deps.broadcastToChat(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return res.end(reply);
}

export async function respondWithSmartReply(params) {
  const {
    anthropic = null,
    req,
    res,
    name,
    chatId,
    routePrompt,
    replyText,
    replyPlan = null,
    userMessageAlreadyPersisted = false,
    proposedNextAction = null,
    householdWebSearchEnabled = false,
    durableMemoryScope = undefined,
    statusEmitter = null,
    deps,
  } = params;

  if (!userMessageAlreadyPersisted) {
    await addMessage(chatId, req.householdId, 'user', name, routePrompt);
    await deps.incrementUserMessageCountForSender(req);
  }

  let plannedReply = null;
  if (!safeTrim(replyText) && replyPlan?.kind === 'generate_reply') {
    statusEmitter?.emit?.('writing_reply');
    plannedReply = await resolveSmartReplyPlan({
      anthropic,
      req,
      chatId,
      routePrompt,
      householdWebSearchEnabled,
      durableMemoryScope,
      statusEmitter,
      deps,
    });
  }

  let finalReply = safeTrim(replyText) || safeTrim(plannedReply?.replyText);
  finalReply = finalReply || 'Done.';
  statusEmitter?.emit?.('writing_reply');
  await addMessage(chatId, req.householdId, 'assistant', 'KitchenBot', finalReply);
  if (typeof deps.maybeAutoNameChatOnTurn === 'function') {
    await deps.maybeAutoNameChatOnTurn({
      anthropic,
      householdId: req.householdId,
      chatId,
      smartModeEnabled: true,
      getMessages: deps.getMessages,
      updateChatTitleAutoIfUnlocked: deps.updateChatTitleAutoIfUnlocked,
      stripStoredMessageContentForDisplay: deps.stripStoredMessageContentForDisplay,
      isAnthropicSdkAuthOrKeyError: deps.isAnthropicSdkAuthOrKeyError,
      broadcastToChat: deps.broadcastToChat,
      broadcastUser: name,
    }).catch(() => {});
  }
  const nextActionToPersist =
    proposedNextAction && typeof proposedNextAction === 'object' && !Array.isArray(proposedNextAction)
      ? proposedNextAction
      : null;

  if (nextActionToPersist && typeof nextActionToPersist === 'object' && !Array.isArray(nextActionToPersist)) {
    await setChatRuntimeState(chatId, req.householdId, {
      mode: 'smart',
      proposedNextAction: nextActionToPersist,
    }).catch(() => {});
  } else {
    await clearChatRuntimeState(chatId, req.householdId).catch(() => {});
  }
  if (typeof deps.broadcastToChat === 'function') {
    deps.broadcastToChat(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return res.end(finalReply);
}

async function resolveSmartReplyPlan(params) {
  const {
    req,
    chatId,
    routePrompt,
    anthropic,
    householdWebSearchEnabled,
    durableMemoryScope,
    statusEmitter,
    deps,
  } = params;

  const conversation = await getMessages(chatId, req.householdId);
  const conversationForContext = conversation.filter(
    (m) => m.role !== 'user' || !String(m.content || '').trim().startsWith('!')
  );
  const recentConversation = conversationForContext.length > 40 ? conversationForContext.slice(-40) : conversationForContext;
  const threadCtx = await getChatThreadContext(chatId, req.householdId);
  statusEmitter?.emit?.('reading_memories', 'Getting memories/preferences...');
  const smartMemoryContext = await deps.getSmartDurableMemoryPromptContext(
    req.householdId,
    {
      routePrompt,
    },
    { limit: 6, durableMemoryScope }
  );
  const memoryText = smartMemoryContext.promptText || '(none)';
  const claudeMessages = recentConversation.map((message) => ({
    role: message.role,
    content:
      message.role === 'user'
        ? `${message.name}: ${message.content}`
        : deps.stripStoredMessageContentForDisplay(message.content),
  }));

  const useWebSearchTool = householdWebSearchEnabled && deps.shouldEnableWebSearchForPrompt(routePrompt);
  const webSearchCapabilityBlock = useWebSearchTool
    ? `Web (this request): Anthropic web_search IS attached. Only attribute content to a site or URL if the search tool actually returned that material this turn.`
    : householdWebSearchEnabled
      ? `Web (this request): Web search is NOT attached—no live fetch of links for this reply.`
      : `Web (this request): Web search is off for this household.`;
  const streamParams = {
    model: resolveAnthropicModelForCallPurpose('chat_reply'),
    max_tokens: useWebSearchTool ? 4096 : 800,
    system: `You are KitchenBot: a concise household assistant. Always use first person (I/me/my).

App contract: This message is plain text only; it does not directly execute app actions or change stored state by itself.
- Do not claim I saved, updated, or changed the app this turn unless the thread shows a real server-confirmed outcome.
- Do not say I saved or updated Smart durable memory unless the thread history clearly shows the real confirmed save outcome.
${webSearchCapabilityBlock}
Ingredient vs grocery rules:
- If the user asks for ingredients, what goes into a meal, or what they would need to buy, answer directly in plain language unless the thread already shows a real server-confirmed grocery action outcome.
- Do not invent previews, confirmations, or app updates unless the thread already shows that outcome.
For meal ideas, dinner ideas, and "what should I make" brainstorming, stay conversational by default. Do not treat those turns as stored weekly-plan updates unless the user clearly asks to save, update, replace, or commit the plan.

Smart durable memory (read-only; selected cross-chat memories for this turn; user-editable in Settings):
${memoryText}

Personalization rules for food/planning/grocery turns:
- If Smart durable memory includes saved people, treat them as household preferences to satisfy by default for meal ideas, weekly plans, substitutions, and grocery outputs.
- Avoid ingredients or suggestions that clearly conflict with saved dislikes or constraints.
- If the user names one person, weight that person's saved notes most heavily.
- If household preferences mention style constraints like concise recipes, let that steer the options you suggest.`,
    messages: claudeMessages,
  };
  if (useWebSearchTool) {
    streamParams.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
  }

  const response = await createLoggedAnthropicMessage(anthropic, streamParams, {
    householdId: req.householdId,
    chatId,
    smartModeEnabled: true,
    callSurface: 'chat',
    callPurpose: 'chat_reply',
    webSearchEnabledAtCall: householdWebSearchEnabled,
    usedWebSearchTool: useWebSearchTool,
  });
  let finalReply = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  finalReply = deps.stripFakeGroceryOperationalLines(finalReply);
  finalReply = deps.stripFakeMemoryPendingOfferLines(finalReply);
  finalReply = deps.stripModelAuthoredMemoryOfferLines(finalReply);

  finalReply = deps.scrubUnsavedMemoryClaimsInNormalChatReply(finalReply);

  return {
    replyText: finalReply,
  };
}
