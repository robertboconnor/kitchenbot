import { getMemories } from './db.mjs';
import { normalizeRuntimeAction, pendingActionToRuntimeAction } from './capability-registry.mjs';
import { dispatchTypedAction } from './typed-action-executor.mjs';

function matchesExplicitGroceryBuildIntent(raw) {
  const t = String(raw ?? '').trim().toLowerCase();
  if (!t) return false;
  if (/\b(?:make|build|create|generate|add|update|refresh|fill|populate)\b[\s\S]{0,40}\b(?:grocery|shopping)\s+list\b/.test(t)) {
    return true;
  }
  if (/\b(?:make|build|create|generate|add|update|refresh|fill|populate)\b[\s\S]{0,40}\bgrocery\s+list\s+tab\b/.test(t)) {
    return true;
  }
  if (/\bput\b[\s\S]{0,30}\bon\b[\s\S]{0,20}\b(?:the\s+)?grocery\s+list\b/.test(t)) return true;
  return false;
}

function looksGroceryishAction(rawAction) {
  if (!rawAction || typeof rawAction !== 'object') return false;
  const capability = String(rawAction.capability ?? '').trim().toLowerCase();
  const command = String(rawAction.command ?? '').trim().toLowerCase();
  return (
    capability.includes('grocery') ||
    capability.includes('shopping') ||
    command === '!grocerylist' ||
    command.includes('grocery') ||
    command.includes('shopping')
  );
}

function normalizePlanAction(rawAction) {
  return normalizeRuntimeAction(rawAction) || pendingActionToRuntimeAction(rawAction);
}

function repairPlanAction(rawAction, prompt) {
  const normalized = normalizePlanAction(rawAction);
  if (normalized) return normalized;
  if (matchesExplicitGroceryBuildIntent(prompt) || looksGroceryishAction(rawAction)) {
    return { capability: 'grocery.generate_and_commit', input: {} };
  }
  return null;
}

function buildPlanFailureTurn({ prompt, outcomes, replyText }) {
  return {
    handled: false,
    turn: {
      kind: 'reply',
      routePrompt: prompt,
      commandUserTextForPersistence: prompt,
      replyText,
      plannerUserMessageAlreadyPersisted: true,
      skipWeeklyPlanDraftAutoUpdater: outcomes.some((o) => o.capability === 'weekly_plan.patch'),
    },
  };
}

export async function runSmartTypedPlan({
  req,
  res,
  name,
  chatId,
  prompt,
  actions,
  memories: memoriesInitial,
  anthropic,
  smartModeEnabled,
  runtimeCheckpointOutcomes = [],
  persistCheckpointRuntimeState = null,
  clearChatRuntimeState = null,
  deps,
}) {
  const rawActions = Array.isArray(actions) ? actions : [];
  const outcomes = Array.isArray(runtimeCheckpointOutcomes) ? runtimeCheckpointOutcomes.filter(Boolean) : [];
  const normalizedActions = [];

  for (const rawAction of rawActions) {
    const repairedAction = repairPlanAction(rawAction, prompt);
    if (!repairedAction) {
      console.error('runSmartTypedPlan: invalid plan action before dispatch', {
        rawAction,
        prompt,
        chatId,
        householdId: req?.householdId ?? null,
      });
      return buildPlanFailureTurn({
        prompt,
        outcomes,
        replyText: "I hit a snag turning that into an app action. Try asking me to build the grocery list from this plan again.",
      });
    }
    if (
      !normalizePlanAction(rawAction) &&
      repairedAction.capability === 'grocery.generate_and_commit'
    ) {
      console.warn('runSmartTypedPlan: repaired malformed action into grocery.generate_and_commit', {
        rawAction,
        prompt,
        chatId,
        householdId: req?.householdId ?? null,
      });
    }
    normalizedActions.push(repairedAction);
  }

  let actionsToRun = normalizedActions;
  if (
    normalizedActions.length === 2 &&
    normalizedActions.filter((a) => a.capability === 'memory.save').length === 1 &&
    normalizedActions.filter((a) => a.capability === 'grocery.generate_and_commit').length === 1
  ) {
    const rem = normalizedActions.find((a) => a.capability === 'memory.save');
    const gro = normalizedActions.find((a) => a.capability === 'grocery.generate_and_commit');
    if (rem && gro) actionsToRun = [rem, gro];
  }

  await deps.addMessage(chatId, req.householdId, 'user', name, prompt);
  await deps.incrementUserMessageCountForSender(req);
  deps.broadcastToChat?.(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });

  let memories = memoriesInitial;

  for (const action of actionsToRun) {
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
        plannerMode: true,
        skipIncrement: true,
        plannerUserLineAlreadyAdded: true,
        smartModeEnabled,
        runtimeManagedResponse: true,
        deps,
      });
    } catch (error) {
      if (error?.message === 'Unknown typed action' && matchesExplicitGroceryBuildIntent(prompt)) {
        console.warn('runSmartTypedPlan: falling back to canonical grocery action after dispatch failure', {
          rawAction: error.rawAction || action,
          normalizedAction: error.normalizedAction || null,
          prompt,
          chatId,
          householdId: req?.householdId ?? null,
        });
        outcome = await dispatchTypedAction(
          { capability: 'grocery.generate_and_commit', input: {} },
          {
            req,
            res,
            name,
            chatId,
            prompt,
            memories,
            anthropic,
            plannerMode: true,
            skipIncrement: true,
            plannerUserLineAlreadyAdded: true,
            smartModeEnabled,
            runtimeManagedResponse: true,
            deps,
          }
        );
      } else {
        console.error('runSmartTypedPlan: typed action dispatch failed', {
          rawAction: error?.rawAction || action,
          normalizedAction: error?.normalizedAction || null,
          prompt,
          chatId,
          householdId: req?.householdId ?? null,
          error: error?.message || error,
        });
        return buildPlanFailureTurn({
          prompt,
          outcomes,
          replyText: "I hit a snag turning that into an app action. Try asking me again and I’ll take another pass.",
        });
      }
    }

    if (!outcome || typeof outcome !== 'object') {
      return {
        handled: false,
        turn: {
          kind: 'proceed_with_anthropic',
          routePrompt: prompt,
          commandUserTextForPersistence: prompt,
          plannerUserMessageAlreadyPersisted: true,
          plannerSkipMixedMemoryOffer: actionsToRun.some((a) => a.capability === 'memory.save'),
          plannerStreamCompletedActionsAck: null,
          skipWeeklyPlanDraftAutoUpdater: outcomes.some((o) => o.capability === 'weekly_plan.patch'),
        },
      };
    }

    if (outcome.capability === 'memory.save' && outcome.status === 'skipped') {
      continue;
    }

    if (outcome.capability === 'memory.save') {
      memories = await getMemories(req.householdId);
    }

    if (outcome.capability === 'grocery.generate_and_commit' && outcome.status === 'needs_mode_choice') {
      const checkpoint = {
        active: true,
        kind: 'grocery_disambiguation_resume',
        createdAt: Date.now(),
        remainingActions: [{ capability: 'grocery.generate_and_commit', input: {} }],
        optionModes: Array.isArray(outcome.options) ? outcome.options.filter(Boolean) : [],
        priorOutcomes: outcomes,
      };
      if (typeof persistCheckpointRuntimeState === 'function') {
        await persistCheckpointRuntimeState(chatId, req.householdId, checkpoint).catch(() => {});
      }
      return {
        handled: false,
        turn: {
          kind: 'pending_choice',
          routePrompt: prompt,
          commandUserTextForPersistence: prompt,
          replyText: outcome.reply,
          pendingHeader: outcome.pendingHeader,
          checkpoint,
          plannerUserMessageAlreadyPersisted: true,
          skipWeeklyPlanDraftAutoUpdater: outcomes.some((o) => o.capability === 'weekly_plan.patch'),
        },
      };
    }

    outcomes.push(outcome);
  }

  if (typeof clearChatRuntimeState === 'function') {
    await clearChatRuntimeState(chatId, req.householdId).catch(() => {});
  }

  if (outcomes.length > 0) {
    return {
      handled: false,
      turn: {
        kind: 'outcomes',
        routePrompt: prompt,
        commandUserTextForPersistence: prompt,
        outcomes,
        plannerUserMessageAlreadyPersisted: true,
        skipWeeklyPlanDraftAutoUpdater: outcomes.some((o) => o.capability === 'weekly_plan.patch'),
      },
    };
  }

  return {
    handled: false,
    turn: {
      kind: 'proceed_with_anthropic',
      routePrompt: prompt,
      commandUserTextForPersistence: prompt,
      plannerUserMessageAlreadyPersisted: true,
      plannerSkipMixedMemoryOffer: actionsToRun.some((a) => a.capability === 'memory.save'),
      plannerStreamCompletedActionsAck: null,
      skipWeeklyPlanDraftAutoUpdater: false,
    },
  };
}
