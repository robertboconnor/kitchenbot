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
  normalizeWorkingContext,
  selectContinuationWorkingContext,
} from './kb-working-context.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
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

  let finalReply = safeTrim(replyText) || 'Okay.';
  // NOTE: both ungrounded-offer phrasing and unbacked "I saved it" claims are handled where
  // they belong — the loop's system prompt keeps offers honest by construction, and
  // kb-claim-guard verifies completion claims against the real tool trace. We do NOT run a
  // post-hoc regex over the brain's own words to "fix" them.

  await addMessage(chatId, req.householdId, 'assistant', assistantName, finalReply);
  // ONE BRAIN: no post-reply working-context sub-model. The loop reads the full conversation
  // each turn and never consumes a maintained working context, so we carry through whatever was
  // passed rather than paying a haiku call to rebuild it.
  const refreshedWorkingContext =
    normalizeWorkingContext(workingContext) || normalizeWorkingContext(memoryContext?.workingContext);
  await persistKbRuntimeState({
    chatId,
    householdId: req.householdId,
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


async function persistKbRuntimeState({ chatId, householdId, workingContext }) {
  const normalizedWorkingContext = normalizeWorkingContext(workingContext);
  const persistedWorkingContext = selectPersistentWorkingContext(normalizedWorkingContext);
  if (!persistedWorkingContext) {
    await clearChatRuntimeState(chatId, householdId).catch(() => {});
    return;
  }
  await setChatRuntimeState(chatId, householdId, {
    mode: 'kb',
    workingContext: persistedWorkingContext,
  }).catch(() => {});
}

function selectPersistentWorkingContext(workingContext) {
  return selectContinuationWorkingContext(workingContext);
}
