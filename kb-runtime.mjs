import { getMessages } from './db.mjs';
import crypto from 'crypto';
import { respondWithKbErrorReply } from './kb-reply.mjs';
import { runKbAgentLoop } from './kb-agent-loop.mjs';
import { NARRATION_READING } from './kb-narration.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

function anthropicRuntimeFailureReply(error, deps) {
  if (deps?.isAnthropicSdkAuthOrKeyError?.(error)) {
    return safeTrim(deps?.ANTHROPIC_KEY_USER_MESSAGE) || 'Invalid or missing Anthropic key.';
  }
  const mapped =
    typeof deps?.getAnthropicUserFacingErrorMessage === 'function'
      ? safeTrim(deps.getAnthropicUserFacingErrorMessage(error))
      : '';
  if (mapped) return mapped;
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  const type = safeTrim(error?.error?.type ?? error?.type).toLowerCase();
  const message = safeTrim(error?.error?.message ?? error?.message);
  if (
    status === 429 ||
    status === 529 ||
    type === 'rate_limit_error' ||
    type === 'overloaded_error' ||
    /rate\s*limit|overloaded|capacity|quota|credit balance|usage limit|too many requests|temporarily unavailable/i.test(message)
  ) {
    return 'There’s a problem with Anthropic right now. Please try again in a bit.';
  }
  return '';
}

async function respondWithKbAnthropicFailure({ error, req, res, name, chatId, promptText, deps }) {
  const replyText = anthropicRuntimeFailureReply(error, deps);
  if (!replyText) throw error;
  return respondWithKbErrorReply({
    req,
    res,
    name,
    chatId,
    turnId: req.kbTurnId || null,
    routePrompt: promptText,
    replyText,
    replyPlan: null,
    memoryContext: null,
    groundedTurn: null,
    workingContext: null,
    userMessageAlreadyPersisted: !!req.kbUserMessagePersisted,
    deps,
  });
}

// The KitchenBot brain: one native tool-use agent loop. It reads the turn,
// decides which tools to use (and in what order) from what they return, then
// replies. There is no deterministic interpreter / grounding / capability switch
// anymore — the model is the brain, the executors are the hands.
export async function handleKbChatTurn({ req, res, name, chatId, prompt, deps }) {
  const promptText = String(prompt ?? '').trim();
  const turnId = crypto.randomUUID();
  req.kbTurnId = turnId;
  await deps.emitKbProgress?.({
    chatId,
    householdId: req.householdId,
    turnId,
    text: NARRATION_READING,
    phase: 'runtime.read_context',
    senderRes: res,
  });
  const recentMessages = await getMessages(chatId, req.householdId).catch(() => []);
  try {
    const ac = await deps.getAnthropicClient(req.householdId);
    const anthropic = ac.client;
    const webSearchEnabled = !!ac.webSearchEnabled;
    req.kbCapabilities = { webSearchEnabled };
    return await runKbAgentLoop({
      req,
      res,
      name,
      chatId,
      prompt: promptText,
      deps,
      anthropic,
      webSearchEnabled,
      recentMessages,
    });
  } catch (error) {
    return await respondWithKbAnthropicFailure({ error, req, res, name, chatId, promptText, deps });
  }
}
