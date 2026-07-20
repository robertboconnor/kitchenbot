import {
  addMessage,
  clearChatRuntimeState,
  getChatSummary,
  getMessages,
  setChatRuntimeState,
  updateChatTitle,
} from './db.mjs';
import { generateChatTitle } from './chat-title.mjs';
import { getKbAssistantPersona } from './kb-prompt-context.mjs';
import {
  formatAppliedWorkingContextText,
  formatWorkingContextText,
  normalizeWorkingContext,
  refreshKbWorkingContext,
  selectContinuationWorkingContext,
} from './kb-working-context.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

function promptMentionsGrocerySurface(prompt = '') {
  return /\b(grocery list|groceries|shopping list|shopping)\b/i.test(safeTrim(prompt));
}

function chunkReplyForStreaming(text, maxChunkLength = 160) {
  const source = String(text ?? '');
  if (!source) return [];
  const chunks = [];
  let remaining = source;
  while (remaining.length > maxChunkLength) {
    let boundary = remaining.lastIndexOf('\n', maxChunkLength);
    if (boundary < Math.floor(maxChunkLength * 0.5)) {
      boundary = remaining.lastIndexOf(' ', maxChunkLength);
    }
    if (boundary < Math.floor(maxChunkLength * 0.5)) {
      boundary = maxChunkLength;
    }
    chunks.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary);
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter((chunk) => chunk.length > 0);
}

function writeChatStreamEvent(res, event) {
  if (typeof res?.write !== 'function') return;
  if (!res.headersSent) {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-KitchenBot-Stream-Format', 'ndjson');
  }
  res.write(`${JSON.stringify(event)}\n`);
}

async function streamReplyText({ res, deps, chatId, householdId, turnId, text }) {
  const chunks = chunkReplyForStreaming(text);
  if (typeof res.write !== 'function') {
    if (Array.isArray(chunks) && chunks.length > 0) {
      for (const chunk of chunks) {
        deps.broadcastToChat?.(chatId, {
          type: 'stream_delta',
          householdId,
          chatId,
          turnId,
          delta: chunk,
        });
      }
    }
    res.end(text);
    return;
  }
  for (const chunk of chunks) {
    deps.broadcastToChat?.(chatId, {
      type: 'stream_delta',
      householdId,
      chatId,
      turnId,
      delta: chunk,
    });
    writeChatStreamEvent(res, {
      type: 'delta',
      turnId: turnId ? String(turnId) : null,
      delta: chunk,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  writeChatStreamEvent(res, {
    type: 'done',
    turnId: turnId ? String(turnId) : null,
  });
  res.end();
}

// Emit ONE real token delta to the sender (NDJSON) + co-viewers (WS), as the model
// writes it. Used by the agent loop for true token streaming of the final reply.
export function streamReplyDelta({ res, deps, chatId, householdId, turnId, delta }) {
  if (!delta) return;
  deps?.broadcastToChat?.(chatId, { type: 'stream_delta', householdId, chatId, turnId, delta });
  writeChatStreamEvent(res, { type: 'delta', turnId: turnId ? String(turnId) : null, delta });
}

// Tell the sender + co-viewers to DISCARD whatever reply text has streamed so far
// this turn. The loop streams every model turn's text live, but only the FINAL
// (non-tool) turn's text is the real reply — if an earlier turn narrated before
// calling a tool ("I'll update that now…"), that narration must be cleared before
// the final turn streams, or the two mash together ("…now.Done!").
export function resetReplyStream({ res, deps, chatId, householdId, turnId }) {
  deps?.broadcastToChat?.(chatId, { type: 'stream_delta_reset', householdId, chatId, turnId });
  writeChatStreamEvent(res, { type: 'delta_reset', turnId: turnId ? String(turnId) : null });
}

// Terminate a truly-streamed reply: signal done to the sender (NDJSON) + co-viewers
// (WS) and end the response. No text is re-sent (the loop already streamed it).
export function finishReplyStream({ res, deps, chatId, householdId, turnId }) {
  deps?.broadcastToChat?.(chatId, { type: 'stream_done', householdId, chatId, turnId });
  writeChatStreamEvent(res, { type: 'done', turnId: turnId ? String(turnId) : null });
  if (typeof res?.end === 'function') res.end();
}

function getAssistantNameFromContext(memoryContext = null) {
  return getKbAssistantPersona(memoryContext).assistantName;
}

async function resolveAssistantName({ req, routePrompt = '', memoryContext = null, deps }) {
  if (memoryContext) return getAssistantNameFromContext(memoryContext);
  if (!deps?.buildKbContextPacket) return getAssistantNameFromContext(null);
  const resolvedMemoryContext = await deps.buildKbContextPacket(req.householdId, routePrompt, {
    limit: 6,
    activeSpeakerName: req.user,
    includeCookbook: false,
    capabilities: req.kbCapabilities,
  }).catch(() => null);
  return getAssistantNameFromContext(resolvedMemoryContext);
}

async function maybeAutoTitleChat({ anthropic, req, chatId, routePrompt, deps }) {
  const chat = await getChatSummary(chatId, req.householdId).catch(() => null);
  if (Number(chat?.title_locked) === 1) return;
  const messages = await getMessages(chatId, req.householdId);
  const userMessages = messages.filter((message) => message.role === 'user');
  const userMessageCount = userMessages.length;
  if (userMessageCount !== 1 && userMessageCount !== 3) return;

  const nextTitle = await generateChatTitle({
    anthropic,
    req,
    chatId,
    turnId: req.kbTurnId || null,
    prompt: routePrompt,
    messages,
    includePromptInTitleContext: true,
  });
  if (!nextTitle) return;
  await updateChatTitle(chatId, req.householdId, nextTitle).catch(() => {});
}

export function rewriteUngroundedActionOfferReply(replyText, proposedNextAction = null) {
  const reply = safeTrim(replyText);
  if (!reply || proposedNextAction) return reply;
  let next = reply;
  next = next.replace(
    /\b(?:Would you like|Do you want|Want)\s+me\s+to\s+search(?: the web)?\s+for\s+(.+?)\?/i,
    'If you want me to search for $1, ask me to search for it.'
  );
  next = next.replace(
    /\bShould I search(?: the web)?\s+for\s+(.+?)\?/i,
    'If you want me to search for $1, ask me to search for it.'
  );
  next = next.replace(
    /\b(?:Would you like|Do you want|Want)\s+me\s+to\s+add\s+(.+?)\s+to\s+your\s+Grocery List(?: tab)?\?/i,
    'If you want me to add $1 to the Grocery List tab, ask me to add it.'
  );
  next = next.replace(
    /\b(?:Would you like|Do you want|Want)\s+me\s+to\s+save\s+(.+?)\?/i,
    'If you want me to save $1, ask me to save it.'
  );
  next = next.replace(
    /\bShould I\s+save\s+(.+?)\?/i,
    'If you want me to save $1, ask me to save it.'
  );
  next = next.replace(
    /\bIf you(?:'d| would)\s+like\s+me\s+to\s+save\s+(.+?),\s+just let me know\.?/i,
    'If you want me to save $1, ask me to save it.'
  );
  next = next.replace(/\bSay yes and I(?:'|’)ll\s+/gi, 'If you want that, ask me to ');
  next = next.replace(/\bGot it[—-]I(?:'|’)ll\s+/gi, 'If you want that, ask me to ');
  return next;
}

export function rewriteUngroundedMutationClaimReply(
  replyText,
  { outcomes = [], groundedTurn = null, routePrompt = '', proposedNextAction = null } = {}
) {
  const reply = safeTrim(replyText);
  if (!reply || proposedNextAction) return reply;
  const list = Array.isArray(outcomes) ? outcomes.filter(Boolean) : [];
  const hasGroceryWrite = list.some((outcome) => safeTrim(outcome?.capability || outcome?.narrationType) === 'grocery.write');
  const currentObjectType = safeTrim(groundedTurn?.currentObject?.objectType);
  if (
    !['meal_set', 'meal_set_selection', 'grocery_proposal', 'chat_recipe'].includes(currentObjectType)
  ) return reply;

  if (!hasGroceryWrite && promptMentionsGrocerySurface(routePrompt)) {
    if (
      /\b(i(?:'ve| have)? added|i added|i updated the grocery list|all set! you can find .*grocery list|the list is ready whenever you want to head to the store)\b/i
        .test(reply)
    ) {
      return 'If you want me to add the ingredients from that to the Grocery List tab, ask me to add them.';
    }
  }

  const hasCookbookMutation = list.some((outcome) => String(outcome?.capability || outcome?.narrationType || '').startsWith('cookbook.'));
  if (!hasCookbookMutation && /\b(cookbook|saved recipes?|saved meals?|favorites?)\b/i.test(routePrompt)) {
    if (/\b(i(?:'ve| have)? saved|i saved|i(?:'ve| have)? added .* to your cookbook|you(?:'ll| will) find .* in your cookbook)\b/i.test(reply)) {
      return 'If you want me to save that to your cookbook, ask me to save it.';
    }
  }
  return reply;
}

export async function respondWithKbErrorReply({
  req,
  res,
  name,
  chatId,
  turnId = null,
  routePrompt = '',
  replyText = '',
  memoryContext = null,
  groundedTurn = null,
  workingContext = null,
  userMessageAlreadyPersisted = false,
  deps,
}) {
  return respondWithKbReply({
    anthropic: null,
    req,
    res,
    name,
    chatId,
    turnId,
    routePrompt,
    replyText,
    replyPlan: null,
    memoryContext,
    groundedTurn,
    workingContext,
    outcomes: [],
    userMessageAlreadyPersisted,
    proposedNextAction: null,
    deps,
  });
}

export async function respondWithKbReply({
  anthropic,
  req,
  res,
  name,
  chatId,
  routePrompt,
  replyText,
  replyPlan = null,
  memoryContext = null,
  groundedTurn = null,
  workingContext = null,
  outcomes = [],
  userMessageAlreadyPersisted = false,
  proposedNextAction = null,
  suppressStreaming = false,
  deps,
}) {
  if (!userMessageAlreadyPersisted) {
    await addMessage(chatId, req.householdId, 'user', name, routePrompt);
    req.kbUserMessagePersisted = true;
    await deps.incrementUserMessageCountForSender?.(req);
  } else {
    req.kbUserMessagePersisted = true;
  }
  const assistantName = await resolveAssistantName({ req, routePrompt, memoryContext, deps });

  const finalProposedNextAction = proposedNextAction || null;
  let finalReply = safeTrim(replyText) || 'Okay.';
  // Pre-send proofread of the CURRENT reply (never an already-sent message). Skipped
  // when the reply was streamed live — you can't rewrite text already on the wire, so
  // the loop's system prompt keeps streamed replies clean by construction instead.
  if (!suppressStreaming) {
    finalReply = rewriteUngroundedActionOfferReply(finalReply, finalProposedNextAction);
    finalReply = rewriteUngroundedMutationClaimReply(finalReply, {
      outcomes,
      groundedTurn,
      routePrompt,
      proposedNextAction: finalProposedNextAction,
    });
  }

  await addMessage(chatId, req.householdId, 'assistant', assistantName, finalReply);
  const refreshedWorkingContext = await maybeRefreshWorkingContext({
    anthropic,
    req,
    chatId,
    routePrompt,
    memoryContext,
    workingContext,
    outcomes,
    deps,
  }).catch(() => normalizeWorkingContext(workingContext) || normalizeWorkingContext(memoryContext?.workingContext));
  await persistKbRuntimeState({
    chatId,
    householdId: req.householdId,
    proposedNextAction: finalProposedNextAction,
    workingContext: refreshedWorkingContext,
  });

  await maybeAutoTitleChat({ anthropic, req, chatId, routePrompt, deps }).catch(() => {});
  if (suppressStreaming) {
    // The agent loop already streamed this reply token-by-token; just finalize it.
    finishReplyStream({ res, deps, chatId, householdId: req.householdId, turnId: req.kbTurnId || null });
  } else {
    await streamReplyText({
      res,
      deps,
      chatId,
      householdId: req.householdId,
      turnId: req.kbTurnId || null,
      text: finalReply,
    });
  }
  deps.broadcastToChat?.(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });
  return;
}

async function maybeRefreshWorkingContext({
  anthropic,
  req,
  chatId,
  routePrompt,
  memoryContext,
  workingContext,
  outcomes = [],
  deps,
}) {
  const resolvedWorkingContext =
    normalizeWorkingContext(workingContext) ||
    normalizeWorkingContext(memoryContext?.workingContext);
  return await refreshKbWorkingContext({
    anthropic,
    req,
    chatId,
    routePrompt,
    currentWorkingContext: resolvedWorkingContext,
    memoryContext: {
      ...memoryContext,
      workingContext: resolvedWorkingContext,
      workingContextText: formatWorkingContextText(resolvedWorkingContext),
      appliedWorkingContextText: formatAppliedWorkingContextText(resolvedWorkingContext),
    },
    outcomes,
    deps,
  });
}

async function persistKbRuntimeState({ chatId, householdId, proposedNextAction, workingContext }) {
  const normalizedWorkingContext = normalizeWorkingContext(workingContext);
  const hasProposedNextAction =
    proposedNextAction && typeof proposedNextAction === 'object' && !Array.isArray(proposedNextAction);
  const persistedWorkingContext = selectPersistentWorkingContext(normalizedWorkingContext, proposedNextAction);
  if (!hasProposedNextAction && !persistedWorkingContext) {
    await clearChatRuntimeState(chatId, householdId).catch(() => {});
    return;
  }
  await setChatRuntimeState(chatId, householdId, {
    mode: 'kb',
    proposedNextAction: hasProposedNextAction ? proposedNextAction : null,
    workingContext: persistedWorkingContext,
  }).catch(() => {});
}

function selectPersistentWorkingContext(workingContext, proposedNextAction = null) {
  return selectContinuationWorkingContext(workingContext, proposedNextAction);
}
