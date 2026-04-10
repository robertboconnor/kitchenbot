import {
  clearChatRuntimeState,
  getChatRuntimeState,
  getHouseholdById,
} from './db.mjs';
import {
  normalizeRuntimeAction,
  renderSmartHelpReply,
} from './capability-registry.mjs';
import { decideSmartRuntimeTurn } from './smart-turn-policy.mjs';
import { createChatStatusEmitter } from './chat-status-runtime.mjs';
import {
  respondWithSmartClarify,
  respondWithSmartReply,
} from './smart-response-runtime.mjs';

const SMART_RUNTIME_MODE = 'smart';
const PLANNER_RESUME_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeProposedNextAction(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.active !== true) return null;
  const type = String(raw.type ?? '').trim();
  const target = String(raw.target ?? '').trim();
  const createdAt = Number(raw.createdAt);
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > PLANNER_RESUME_MAX_AGE_MS) return null;
  const visibleReplySummary =
    typeof raw.visibleReplySummary === 'string' ? raw.visibleReplySummary.trim().slice(0, 400) : '';
  const action = normalizeRuntimeAction(raw.action);

  if (type === 'confirm') {
    if (!action) return null;
    return {
      active: true,
      type,
      target,
      createdAt,
      visibleReplySummary,
      action,
    };
  }

  if (type === 'choice') {
    const choices = Array.isArray(raw.choices)
      ? raw.choices
          .map((choice) => {
            const id = String(choice?.id ?? '').trim();
            const label = String(choice?.label ?? '').trim();
            const actionInput =
              choice?.actionInput && typeof choice.actionInput === 'object' && !Array.isArray(choice.actionInput)
                ? choice.actionInput
                : null;
            if (!id || !label || !actionInput) return null;
            return { id, label, actionInput };
          })
          .filter(Boolean)
      : [];
    const question = typeof raw.question === 'string' ? raw.question.trim().slice(0, 300) : '';
    if (!action || choices.length === 0 || !question) {
      return null;
    }
    return {
      active: true,
      type,
      target,
      createdAt,
      visibleReplySummary,
      action,
      choices,
      question,
      priorOutcomes: Array.isArray(raw.priorOutcomes) ? raw.priorOutcomes.filter((o) => o && typeof o === 'object' && !Array.isArray(o)) : [],
      rememberAckFragment:
        typeof raw.rememberAckFragment === 'string' && raw.rememberAckFragment.trim()
          ? raw.rememberAckFragment.trim()
          : null,
    };
  }

  return null;
}


export async function handleSmartModeChatTurn(params) {
  const {
    req,
    res,
    name,
    chatId,
    prompt,
    deps,
  } = params;

  const householdChatSettings = await getHouseholdById(req.householdId);
  if (!householdChatSettings) {
    return res.status(404).json({ reply: 'Household not found.' });
  }
  const statusEmitter = createChatStatusEmitter({
    broadcastToChat: deps.broadcastToChat,
    householdId: req.householdId,
    chatId,
    user: name,
    requestId: req.body?.requestId,
  });
  statusEmitter.emit('thinking');
  const smartModeEnabled = Number(householdChatSettings.smart_mode_enabled) === 1;
  if (!smartModeEnabled) {
    throw new Error('handleSmartModeChatTurn called while Smart Mode is disabled');
  }

  const promptText = String(prompt ?? '').trim();
  if (deps.isPrivateChatCommand(promptText) && /^!love(?:\s|$)/.test(promptText)) {
    const loveRest = promptText.match(/^!love\s*(.*)$/);
    const targetName = loveRest && loveRest[1] != null ? String(loveRest[1]).trim() : '';
    if (!targetName) {
      const reply =
        "Usage: !love <display name> — boosts that household user's compliment chances for their next messages. Example: !love Jamie";
      statusEmitter.done();
      res.setHeader('X-KitchenBot-Ephemeral', '1');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(reply);
    }
    const targetUser = await deps.getUserByHouseholdAndDisplayName(req.householdId, targetName);
    if (!targetUser) {
      const reply = 'No household user with that display name. Check spelling or add them under Settings.';
      statusEmitter.done();
      res.setHeader('X-KitchenBot-Ephemeral', '1');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(reply);
    }
    await deps.ensureUserComplimentStateRow(targetUser.id);
    await deps.setUserLoveBoost(targetUser.id, true);
    const reply =
      'Love boost activated for ' +
      targetName +
      '. Their next few messages are extra likely to get a compliment.';
    statusEmitter.done();
    res.setHeader('X-KitchenBot-Ephemeral', '1');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end(reply);
  }

  if (promptText === '!help' && deps.isPrivateChatCommand(promptText)) {
    const reply = renderSmartHelpReply();
    await deps.incrementUserMessageCountForSender(req);
    statusEmitter.done();
    res.setHeader('X-KitchenBot-Ephemeral', '1');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end(reply);
  }

  let anthropicForInterpreter = null;
  try {
    const acInterp = await deps.getAnthropicClient(req.householdId);
    anthropicForInterpreter = acInterp.client;
  } catch {
    anthropicForInterpreter = null;
  }

  statusEmitter.emit('reading_memories', 'Getting memories/preferences...');
  let smartMemoryContext = await deps.getSmartDurableMemoryPromptContext(req.householdId, { prompt }, { limit: 6 });
  let memories = smartMemoryContext.compatRows;
  let memoriesByKey = new Map(memories.map((m) => [m.key, m.value]));
  const runtimeState = await getChatRuntimeState(chatId, req.householdId);
  const runtimeProposedNextAction = normalizeProposedNextAction(runtimeState.proposedNextAction);

  const runSmartModeInterpreter =
    anthropicForInterpreter
      ? async (ctx) => {
          try {
            const payload = await deps.buildSmartModeInterpreterContext({
              ...ctx,
              runtimeProposedNextAction,
              stripStoredMessageContentForDisplay: deps.stripStoredMessageContentForDisplay,
              smartModeEnabled,
            });
            return await deps.invokeSmartModeInterpreterModel(anthropicForInterpreter, payload);
          } catch {
            return null;
          }
        }
      : undefined;

  statusEmitter.emit('planning');
  let turn = await decideSmartRuntimeTurn({
    prompt,
    chatId,
    householdId: req.householdId,
    memoriesByKey,
    runtimeProposedNextAction,
    detectSmartActionIntentFromNaturalLanguage: deps.detectSmartActionIntentFromNaturalLanguage,
    isPrivateChatCommand: deps.isPrivateChatCommand,
    parseMemoryCommand: deps.parseMemoryCommand,
    isGroceryListCommand: deps.isGroceryListCommand,
    runSmartModeInterpreter,
  });

  res.setHeader('X-KitchenBot-Server-Action-Managed', '1');

  let anthropic;
  let householdWebSearchEnabled = false;
  try {
    const ac = await deps.getAnthropicClient(req.householdId);
    anthropic = ac.client;
    householdWebSearchEnabled = ac.webSearchEnabled;
  } catch (keyErr) {
    const m = keyErr && String(keyErr.message);
    if (m && m.includes('Household not found')) {
      statusEmitter.done();
      return res.status(503).json({ reply: 'Household not found.' });
    }
    statusEmitter.done();
    return res.status(503).json({ reply: deps.ANTHROPIC_KEY_USER_MESSAGE });
  }

  const explicitBangEarly = promptText.startsWith('!');
  if (explicitBangEarly) {
    await clearChatRuntimeState(chatId, req.householdId).catch(() => {});
  }

  if (turn.kind === 'execute_action') {
    const actions = Array.isArray(turn.actions)
      ? turn.actions
      : turn.action?.capability
        ? [turn.action]
        : [];
    await clearChatRuntimeState(chatId, req.householdId).catch(() => {});
    const actionResult = await deps.executeSmartActions({
      req,
      res,
      name,
      chatId,
      prompt,
      actions,
      memories,
      anthropic,
      smartModeEnabled,
      statusEmitter,
      deps,
    });
    turn = {
      kind: 'reply_only',
      routePrompt: promptText,
      replyText: actionResult?.replyText,
      proposedNextAction: actionResult?.proposedNextAction ?? null,
      userMessageAlreadyPersisted: !!actionResult?.userMessageAlreadyPersisted,
    };
  }

  try {
    if (turn.kind === 'clarify') {
      return respondWithSmartClarify({
        req,
        res,
        name,
        chatId,
        routePrompt: turn.routePrompt || promptText,
        question: turn.question,
        statusEmitter,
        deps,
      });
    }

    if (turn.kind === 'reply_only') {
      return respondWithSmartReply({
        anthropic,
        req,
        res,
        name,
        chatId,
        routePrompt: turn.routePrompt || promptText,
        replyText: turn.replyText,
        replyPlan: turn.replyPlan,
        userMessageAlreadyPersisted: !!turn.userMessageAlreadyPersisted,
        proposedNextAction: turn.proposedNextAction,
        householdWebSearchEnabled,
        durableMemoryScope: turn.durableMemoryScope,
        statusEmitter,
        deps,
      });
    }
  } finally {
    statusEmitter.done();
  }
}
