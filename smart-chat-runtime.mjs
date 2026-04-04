import {
  clearChatRuntimeState,
  getChatRuntimeState,
  getHouseholdById,
  getMemories,
} from './db.mjs';
import {
  normalizeRuntimeAction,
  pendingActionToRuntimeAction,
  renderSmartHelpReply,
} from './capability-registry.mjs';
import { decideSmartRuntimeTurn } from './smart-turn-policy.mjs';
import {
  respondWithSmartClarify,
  respondWithSmartOutcomes,
  respondWithSmartPending,
  respondWithSmartReply,
  runSmartConversationReply,
} from './smart-response-runtime.mjs';

const SMART_RUNTIME_MODE = 'smart';
const PLANNER_RESUME_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeCheckpoint(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.active !== true) return null;
  const kind = String(raw.kind ?? '');
  if (kind !== 'grocery_disambiguation_resume' && kind !== 'grocery_preview_commit') return null;
  const createdAt = Number(raw.createdAt);
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > PLANNER_RESUME_MAX_AGE_MS) return null;
  const remainingActions = Array.isArray(raw.remainingActions)
    ? raw.remainingActions.map((a) => normalizeRuntimeAction(a) || pendingActionToRuntimeAction(a)).filter(Boolean)
    : [];
  if (remainingActions.length !== 1) return null;
  if (remainingActions[0].capability !== 'grocery.generate_and_commit') return null;
  return {
    active: true,
    kind,
    createdAt,
    remainingActions,
    optionModes: Array.isArray(raw.optionModes)
      ? raw.optionModes
          .map((mode) => String(mode ?? '').trim())
          .filter((mode) => mode === 'append' || mode === 'replace' || mode === 'prune')
      : [],
    priorOutcomes: Array.isArray(raw.priorOutcomes)
      ? raw.priorOutcomes.filter((o) => o && typeof o === 'object' && !Array.isArray(o))
      : [],
    rememberAckFragment:
      typeof raw.rememberAckFragment === 'string' && raw.rememberAckFragment.trim()
        ? raw.rememberAckFragment.trim()
        : null,
  };
}

async function persistCheckpointRuntimeState(chatId, householdId, checkpoint) {
  const { setChatRuntimeState } = await import('./db.mjs');
  return setChatRuntimeState(chatId, householdId, {
    mode: SMART_RUNTIME_MODE,
    pending: {},
    checkpoint,
  });
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
  const smartModeEnabled = Number(householdChatSettings.smart_mode_enabled) === 1;
  if (!smartModeEnabled) {
    throw new Error('handleSmartModeChatTurn called while Smart Mode is disabled');
  }

  let anthropicForInterpreter = null;
  try {
    const acInterp = await deps.getAnthropicClient(req.householdId);
    anthropicForInterpreter = acInterp.client;
  } catch {
    anthropicForInterpreter = null;
  }

  let memories = await getMemories(req.householdId);
  let memoriesByKey = new Map(memories.map((m) => [m.key, m.value]));
  const runtimeState = await getChatRuntimeState(chatId, req.householdId);
  const runtimePendingAction = pendingActionToRuntimeAction(runtimeState.pending?.action);
  const runtimeCheckpoint = normalizeCheckpoint(runtimeState.checkpoint);

  const runSmartModeInterpreter =
    anthropicForInterpreter
      ? async (ctx) => {
          try {
            const payload = await deps.buildSmartModeInterpreterContext({
              ...ctx,
              stripStoredMessageContentForDisplay: deps.stripStoredMessageContentForDisplay,
              smartModeEnabled,
            });
            return await deps.invokeSmartModeInterpreterModel(anthropicForInterpreter, payload);
          } catch {
            return null;
          }
        }
      : undefined;

  let turn = await decideSmartRuntimeTurn({
    prompt,
    chatId,
    householdId: req.householdId,
    bodyExecutePending: req.body.executePendingAction,
    memoriesByKey,
    runtimePendingAction,
    runtimeCheckpoint,
    stripStoredMessageContentForDisplay: deps.stripStoredMessageContentForDisplay,
    threadHasConcreteGroceryDraftForFollowUp: deps.threadHasConcreteGroceryDraftForFollowUp,
    detectCommandIntentFromNaturalLanguage: deps.detectCommandIntentFromNaturalLanguage,
    isPrivateChatCommand: deps.isPrivateChatCommand,
    parseMemoryCommand: deps.parseMemoryCommand,
    isGroceryListCommand: deps.isGroceryListCommand,
    runSmartModeInterpreter,
  });

  if (turn.kind !== 'pending_offer') {
    await clearChatRuntimeState(chatId, req.householdId).catch(() => {});
  }

  if (turn.kind === 'short_affirmative_fallback') {
    const reply =
      "Looks like I thought there was an action ready to confirm here, but there wasn't. You can keep chatting normally, or tell me a bit more about what you want me to do.";
    await deps.addMessage(chatId, req.householdId, 'user', name, turn.commandUserTextForPersistence);
    await deps.addMessage(chatId, req.householdId, 'assistant', 'KitchenBot', reply);
    await deps.incrementUserMessageCountForSender(req);
    deps.broadcastToChat?.(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end(reply);
  }

  if (turn.kind === 'pending_offer') {
    const { action, routePrompt } = turn;
    if (action?.capability === 'memory.save') {
      const applyGuard = deps.shouldApplyDurableAutoMemoryGuard({
        commandUserTextForPersistence: turn.commandUserTextForPersistence,
        executePendingAction: null,
        bodyExecutePending: req.body?.executePendingAction,
      });
      if (applyGuard) {
        const threadCtxOffer = await deps.getChatThreadContext(chatId, req.householdId);
        const ok = deps.isDurableAutoMemoryCandidate({
          key: action.input?.key,
          value: action.input?.value,
          routePrompt,
          threadCtx: threadCtxOffer,
          userPrompt: prompt,
        });
        if (!ok) {
          turn = {
            kind: 'proceed_with_anthropic',
            routePrompt,
            executePendingAction: null,
            recoveredPending: null,
            commandUserTextForPersistence: turn.commandUserTextForPersistence,
            smartModeMixedMemoryHint: false,
            smartModeClarifyHint: false,
          };
        }
      }
    }
  }

  if (turn.kind === 'private_love_usage') {
    const reply =
      "Usage: !love <display name> — boosts that household user's compliment chances for their next messages. Example: !love Jamie";
    res.setHeader('X-KitchenBot-Ephemeral', '1');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end(reply);
  }

  if (turn.kind === 'private_love_resolve') {
    const targetUser = await deps.getUserByHouseholdAndDisplayName(req.householdId, turn.targetName);
    if (!targetUser) {
      const reply = 'No household user with that display name. Check spelling or add them under Settings.';
      res.setHeader('X-KitchenBot-Ephemeral', '1');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(reply);
    }
    await deps.ensureUserComplimentStateRow(targetUser.id);
    await deps.setUserLoveBoost(targetUser.id, true);
    const reply =
      'Love boost activated for ' +
      turn.targetName +
      '. Their next few messages are extra likely to get a compliment.';
    res.setHeader('X-KitchenBot-Ephemeral', '1');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end(reply);
  }

  if (turn.kind === 'private_help') {
    const reply = renderSmartHelpReply();
    await deps.incrementUserMessageCountForSender(req);
    res.setHeader('X-KitchenBot-Ephemeral', '1');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end(reply);
  }

  let anthropic;
  let householdWebSearchEnabled = false;
  try {
    const ac = await deps.getAnthropicClient(req.householdId);
    anthropic = ac.client;
    householdWebSearchEnabled = ac.webSearchEnabled;
  } catch (keyErr) {
    const m = keyErr && String(keyErr.message);
    if (m && m.includes('Household not found')) {
      return res.status(503).json({ reply: 'Household not found.' });
    }
    return res.status(503).json({ reply: deps.ANTHROPIC_KEY_USER_MESSAGE });
  }

  if (turn.kind === 'weekly_plan_grocery_draft') {
    await deps.runWeeklyPlanGroceryDraftOfferResponse({
      req,
      res,
      name,
      chatId,
      prompt,
      memories,
      memoriesByKey,
      anthropic,
    });
    return;
  }

  const promptText = String(prompt ?? '').trim();
  const explicitBangEarly = promptText.startsWith('!');
  if (explicitBangEarly) {
    await clearChatRuntimeState(chatId, req.householdId).catch(() => {});
  }

  const execResumeRaw =
    req.body?.executePendingAction ??
    null;
  const execForResume = pendingActionToRuntimeAction(execResumeRaw);

  if (
    turn.kind !== 'execute_plan' &&
    !explicitBangEarly &&
    runtimeCheckpoint &&
    execForResume?.capability === 'grocery.generate_and_commit' &&
    (execForResume.input?.mode === 'append' || execForResume.input?.mode === 'replace' || execForResume.input?.mode === 'prune')
  ) {
    const merged = normalizeCheckpoint({
      active: true,
      kind: 'grocery_disambiguation_resume',
      createdAt: Date.now(),
      remainingActions: [execForResume],
      optionModes: runtimeCheckpoint.optionModes,
      rememberAckFragment: runtimeCheckpoint.rememberAckFragment,
    })?.remainingActions?.[0] || execForResume;
    if (merged) {
      const planOut = await deps.runTypedPlan({
        req,
        res,
        name,
        chatId,
        prompt,
        actions: [merged],
        memories,
        anthropic,
        smartModeEnabled,
        runtimeCheckpointOutcomes: runtimeCheckpoint.priorOutcomes || [],
        persistCheckpointRuntimeState,
        clearChatRuntimeState,
        deps,
      });
      if (planOut.handled) return;
      turn = planOut.turn;
      memories = await getMemories(req.householdId);
      memoriesByKey = new Map(memories.map((m) => [m.key, m.value]));
    }
  }

  if (turn.kind === 'execute_plan') {
    await clearChatRuntimeState(chatId, req.householdId).catch(() => {});
    const planOut = await deps.runTypedPlan({
      req,
      res,
      name,
      chatId,
      prompt,
      actions: turn.actions,
      memories,
      anthropic,
      smartModeEnabled,
      runtimeCheckpointOutcomes: [],
      persistCheckpointRuntimeState,
      clearChatRuntimeState,
      deps,
    });
    if (planOut.handled) return;
    turn = planOut.turn;
    memories = await getMemories(req.householdId);
    memoriesByKey = new Map(memories.map((m) => [m.key, m.value]));
  }

  if (turn.kind === 'clarify') {
    return respondWithSmartClarify({
      req,
      res,
      name,
      chatId,
      routePrompt: turn.routePrompt || promptText,
      question: turn.question,
      deps,
    });
  }

  if (turn.kind === 'pending_offer') {
    return respondWithSmartPending({
      anthropic,
      req,
      res,
      name,
      chatId,
      routePrompt: turn.routePrompt || promptText,
      runtimeAction: turn.action,
      memoriesByKey,
      plannerUserMessageAlreadyPersisted: !!turn.plannerUserMessageAlreadyPersisted,
      deps,
    });
  }

  if (turn.kind === 'pending_choice') {
    return respondWithSmartPending({
      anthropic,
      req,
      res,
      name,
      chatId,
      routePrompt: turn.routePrompt || promptText,
      replyText: turn.replyText,
      pendingHeader: turn.pendingHeader,
      checkpoint: turn.checkpoint,
      memoriesByKey,
      plannerUserMessageAlreadyPersisted: !!turn.plannerUserMessageAlreadyPersisted,
      deps,
    });
  }

  if (turn.kind === 'reply') {
    return respondWithSmartReply({
      req,
      res,
      name,
      chatId,
      routePrompt: turn.routePrompt || promptText,
      replyText: turn.replyText,
      plannerUserMessageAlreadyPersisted: !!turn.plannerUserMessageAlreadyPersisted,
      appendWeeklyPlanVisible: !!turn.skipWeeklyPlanDraftAutoUpdater,
      deps,
    });
  }

  if (turn.kind === 'outcomes') {
    return respondWithSmartOutcomes({
      req,
      res,
      name,
      chatId,
      anthropic,
      routePrompt: turn.routePrompt || promptText,
      outcomes: turn.outcomes,
      plannerUserMessageAlreadyPersisted: !!turn.plannerUserMessageAlreadyPersisted,
      appendWeeklyPlanVisible: !!turn.skipWeeklyPlanDraftAutoUpdater,
      deps,
    });
  }

  return runSmartConversationReply({
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
  });
}
