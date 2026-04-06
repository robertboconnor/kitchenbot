import { normalizeRuntimeAction, renderSmartExecutionOutcomes } from './capability-registry.mjs';
import { dispatchTypedAction } from './typed-action-executor.mjs';

function normalizeAction(rawAction) {
  return normalizeRuntimeAction(rawAction);
}

function buildExecutionFailureResult({ outcomes, replyText }) {
  return {
    replyText,
    outcomes,
    userMessageAlreadyPersisted: true,
  };
}

function buildExecutionReplyText(outcomes) {
  return renderSmartExecutionOutcomes(outcomes) || 'Done.';
}

export async function executeSmartActions({
  req,
  res,
  name,
  chatId,
  prompt,
  actions,
  memories: memoriesInitial,
  anthropic,
  smartModeEnabled,
  deps,
}) {
  const rawActions = Array.isArray(actions) ? actions : [];
  const outcomes = [];
  const normalizedActions = [];

  for (const rawAction of rawActions) {
    const normalizedAction = normalizeAction(rawAction);
    if (!normalizedAction) {
      console.error('executeSmartActions: invalid action before dispatch', {
        rawAction,
        prompt,
        chatId,
        householdId: req?.householdId ?? null,
      });
      return buildExecutionFailureResult({
        outcomes,
        replyText: "I hit a snag turning that into an app action. Try asking me again and I'll take another pass.",
      });
    }
    normalizedActions.push(normalizedAction);
  }

  await deps.addMessage(chatId, req.householdId, 'user', name, prompt);
  await deps.incrementUserMessageCountForSender(req);
  deps.broadcastToChat?.(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });

  let memories = memoriesInitial;

  for (const action of normalizedActions) {
    let outcome;
    try {
      outcome = await dispatchTypedAction(action, {
        req,
        res,
        name,
        chatId,
        prompt,
        memories,
        anthropic,
        skipIncrement: true,
        userMessageAlreadyPersisted: true,
        smartModeEnabled,
        runtimeManagedResponse: true,
        deps,
      });
    } catch (error) {
      console.error('executeSmartActions: typed action dispatch failed', {
        rawAction: error?.rawAction || action,
        normalizedAction: error?.normalizedAction || null,
        prompt,
        chatId,
        householdId: req?.householdId ?? null,
        error: error?.message || error,
      });
      return buildExecutionFailureResult({
        outcomes,
        replyText: "I hit a snag turning that into an app action. Try asking me again and I’ll take another pass.",
      });
    }

    if (!outcome || typeof outcome !== 'object') {
      return buildExecutionFailureResult({
        outcomes,
        replyText: "I wasn't able to finish that app action cleanly. Try asking me again and I'll take another pass.",
      });
    }

    if (outcome.capability === 'memory.save') {
      if (smartModeEnabled && typeof deps.loadSmartDurableMemoryCompatRows === 'function') {
        memories = await deps.loadSmartDurableMemoryCompatRows(req.householdId);
      }
    }

    outcomes.push(outcome);

    const nextStep =
      outcome.proposedNextAction && typeof outcome.proposedNextAction === 'object' && !Array.isArray(outcome.proposedNextAction)
        ? outcome.proposedNextAction
        : null;
    if (nextStep) {
      return {
        replyText: String(outcome.reply ?? '').trim() || buildExecutionReplyText(outcomes),
        proposedNextAction: nextStep,
        outcomes,
        userMessageAlreadyPersisted: true,
      };
    }
  }

  if (outcomes.length > 0) {
    return {
      replyText: buildExecutionReplyText(outcomes),
      outcomes,
      userMessageAlreadyPersisted: true,
    };
  }

  return {
    replyText: 'Done.',
    userMessageAlreadyPersisted: true,
  };
}
