import { getChatRuntimeState, getMessages } from './db.mjs';
import crypto from 'crypto';
import { interpretKbTurn } from './kb-interpreter.mjs';
import { normalizeProposedNextAction } from './kb-next-action.mjs';
import {
  decideKbNextActionFollowUp,
} from './kb-turn-decider.mjs';
import {
  executeKbActions,
  getKbContextProfileForActions,
  interpretKbSkillFollowUp,
  mergeKbContextProfiles,
} from './kb-skills.mjs';
import { respondWithKbClarify, respondWithKbErrorReply, respondWithKbReply } from './kb-reply.mjs';
import {
  buildPromptContextProfile,
  buildRuntimeKbContext,
  normalizeClientTimeContext,
  profileNeedsRefresh,
} from './kb-context-policy.mjs';
import {
  normalizeWorkingContext,
  selectContinuationWorkingContext,
} from './kb-working-context.mjs';
import {
  groundTurnFinal,
  groundTurnProvisional,
  normalizeGroundedTurn,
} from './kb-grounding.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

function selectRuntimeWorkingContext(workingContext, proposedNextAction = null) {
  return selectContinuationWorkingContext(workingContext, proposedNextAction);
}

function logKbTurnTrace(label, payload = null) {
  if (process.env.KB_TRACE_TURNS !== '1') return;
  try {
    const rendered =
      payload == null
        ? ''
        : ` ${JSON.stringify(payload, (_key, value) => {
            if (Array.isArray(value) && value.length > 8) return [...value.slice(0, 8), `...(${value.length} total)`];
            return value;
          })}`;
    console.log(`[kb-trace] ${label}${rendered}`);
  } catch {
    console.log(`[kb-trace] ${label}`);
  }
}

function looksLikeTerseFollowUp(prompt = '') {
  const text = safeTrim(prompt).toLowerCase();
  if (!text) return false;
  if (text.split(/\s+/).filter(Boolean).length > 6) return false;
  return /^(yes|yeah|yep|sure|ok|okay|do it|go ahead|sounds good|that one|this one|the first one|first one|the second one|second one|no|nope|cancel|stop|never mind|nevermind)$/i.test(text);
}

export function resolveClarifyProposedNextAction(turn, runtimeProposedNextAction) {
  if (turn?.kind !== 'clarify') return turn?.proposedNextAction ?? null;
  if (turn?.proposedNextAction) return turn.proposedNextAction;
  return runtimeProposedNextAction?.type === 'clarify_action' ? runtimeProposedNextAction : null;
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

async function respondWithKbAnthropicFailure({
  error,
  anthropic = null,
  req,
  res,
  name,
  chatId,
  promptText,
  memoryContext = null,
  groundedTurn = null,
  workingContext = null,
  deps,
}) {
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
    memoryContext,
    groundedTurn,
    workingContext,
    userMessageAlreadyPersisted: !!req.kbUserMessagePersisted,
    deps,
  });
}

export async function handleKbChatTurn({ req, res, name, chatId, prompt, deps }) {
  const promptText = String(prompt ?? '').trim();
  const turnId = crypto.randomUUID();
  req.kbTurnId = turnId;
  await deps.emitKbProgress?.({
    chatId,
    householdId: req.householdId,
    turnId,
    text: 'Reading context…',
    phase: 'runtime.read_context',
    senderRes: res,
  });
  const timeContext = normalizeClientTimeContext(req.body?.timeContext);
  const runtimeState = await getChatRuntimeState(chatId, req.householdId);
  const runtimeProposedNextAction = normalizeProposedNextAction(runtimeState.proposedNextAction);
  const workingContext = selectRuntimeWorkingContext(runtimeState.workingContext, runtimeProposedNextAction);
  const recentMessages = await getMessages(chatId, req.householdId).catch(() => []);

  let anthropic = null;
  let webSearchEnabled = false;
  let memoryContext = null;
  let finalGroundedTurn = null;
  try {
    const ac = await deps.getAnthropicClient(req.householdId);
    anthropic = ac.client;
    webSearchEnabled = !!ac.webSearchEnabled;
    req.kbCapabilities = { webSearchEnabled };

    let turn = null;
    const provisionalGrounding = await groundTurnProvisional({
      anthropic,
      req,
      chatId,
      turnId,
      prompt: promptText,
      recentMessages,
      activeSpeakerName: name,
      workingContext,
      runtimeProposedNextAction,
      deps,
    });
    let contextProfile = turn?.kind === 'execute_action'
      ? mergeKbContextProfiles(getKbContextProfileForActions(turn.actions), { includeWorkingContext: !!runtimeProposedNextAction })
      : buildPromptContextProfile({
          runtimeProposedNextAction,
          workingContext,
          provisionalGrounding,
        });
    if (runtimeProposedNextAction?.type === 'clarify_action' && runtimeProposedNextAction.action?.capability) {
      contextProfile = mergeKbContextProfiles(
        contextProfile,
        getKbContextProfileForActions([runtimeProposedNextAction.action]),
        { includeWorkingContext: !!workingContext }
      );
    }
    contextProfile = { ...contextProfile, pendingAction: runtimeProposedNextAction };
    let baseMemoryContext = await deps.buildKbContextPacket(req.householdId, promptText, {
      limit: 6,
      activeSpeakerName: name,
      includeDefaults: contextProfile.includeDefaults,
      includeCookbook: contextProfile.includeCookbook,
      includePantry: contextProfile.includePantry,
      includeGrocery: contextProfile.includeGrocery,
      capabilities: { webSearchEnabled },
    });
    finalGroundedTurn = await groundTurnFinal({
      anthropic,
      req,
      chatId,
      turnId,
      prompt: promptText,
      recentMessages,
      activeSpeakerName: name,
      memoryContext: baseMemoryContext,
      workingContext,
      runtimeProposedNextAction,
      provisionalGrounding,
      deps,
    });
    logKbTurnTrace('grounded.final', {
      chatId,
      prompt: promptText,
      turnMode: finalGroundedTurn?.turnMode,
      surface: finalGroundedTurn?.surface,
      intent: finalGroundedTurn?.intent,
      currentObjectType: finalGroundedTurn?.currentObject?.objectType,
      currentObjectTitle:
        finalGroundedTurn?.currentObject?.title ||
        finalGroundedTurn?.currentObject?.recipe?.title ||
        finalGroundedTurn?.currentObject?.name ||
        '',
      clarifyChoices: Array.isArray(finalGroundedTurn?.clarifyChoices)
        ? finalGroundedTurn.clarifyChoices.map((choice) => choice?.label || choice?.value || '').filter(Boolean)
        : [],
    });
    memoryContext = buildRuntimeKbContext({
      baseContext: baseMemoryContext,
      timeContext,
      workingContext,
      profile: contextProfile,
      groundedTurn: finalGroundedTurn,
    });

    if (runtimeProposedNextAction && looksLikeTerseFollowUp(promptText)) {
      turn =
        interpretKbSkillFollowUp(promptText, runtimeProposedNextAction, { workingContext, memoryContext }) ||
        decideKbNextActionFollowUp(promptText, runtimeProposedNextAction, workingContext);
    }

    if (!turn) {
      await deps.emitKbProgress?.({
        chatId,
        householdId: req.householdId,
        turnId,
        text: 'Plotting something delicious…',
        phase: 'runtime.plan',
        senderRes: res,
      });
      turn = (await interpretKbTurn({
        req,
        chatId,
        prompt: promptText,
        memoryContext,
        groundedTurn: finalGroundedTurn,
        runtimeProposedNextAction,
      })) || {
        kind: 'reply_only',
        routePrompt: promptText,
        replyPlan: { kind: 'generate_reply' },
        groundedTurn: finalGroundedTurn,
      };
      logKbTurnTrace('turn.interpreted', {
        chatId,
        prompt: promptText,
        kind: turn?.kind,
        actions: Array.isArray(turn?.actions) ? turn.actions.map((action) => action?.capability || '') : [],
        groundedTurnMode: turn?.groundedTurn?.turnMode,
        groundedSurface: turn?.groundedTurn?.surface,
        groundedIntent: turn?.groundedTurn?.intent,
        groundedCurrentObjectType: turn?.groundedTurn?.currentObject?.objectType,
      });
      if (turn?.groundedTurn) {
        finalGroundedTurn = normalizeGroundedTurn(turn.groundedTurn, finalGroundedTurn);
        memoryContext = buildRuntimeKbContext({
          baseContext: baseMemoryContext,
          timeContext,
          workingContext,
          profile: { ...contextProfile, pendingAction: runtimeProposedNextAction },
          groundedTurn: finalGroundedTurn,
        });
      }
    }

    if (turn.kind === 'execute_action') {
      const requiredProfile = mergeKbContextProfiles(contextProfile, getKbContextProfileForActions(turn.actions));
      if (profileNeedsRefresh(contextProfile, requiredProfile)) {
        contextProfile = requiredProfile;
        baseMemoryContext = await deps.buildKbContextPacket(req.householdId, promptText, {
          limit: 6,
          activeSpeakerName: name,
          includeDefaults: contextProfile.includeDefaults,
          includeCookbook: contextProfile.includeCookbook,
          includePantry: contextProfile.includePantry,
          includeGrocery: contextProfile.includeGrocery,
          capabilities: { webSearchEnabled },
        });
        finalGroundedTurn = await groundTurnFinal({
          anthropic,
          req,
          chatId,
          turnId,
          prompt: promptText,
          recentMessages,
          activeSpeakerName: name,
          memoryContext: baseMemoryContext,
          workingContext,
          runtimeProposedNextAction,
          provisionalGrounding,
          deps,
        });
        memoryContext = buildRuntimeKbContext({
          baseContext: baseMemoryContext,
          timeContext,
          workingContext,
          profile: { ...contextProfile, pendingAction: runtimeProposedNextAction },
          groundedTurn: finalGroundedTurn,
        });
      }
      const actionResult = await executeKbActions(turn.actions, {
        req,
        res,
        name,
        chatId,
        prompt: promptText,
        turnId,
        anthropic,
        memories: memoryContext.rows,
        memoryContext,
        workingContext,
        groundedTurn: finalGroundedTurn,
        recentMessages,
        deps,
        webSearchEnabled,
      });
      turn = {
        kind: 'reply_only',
        routePrompt: promptText,
        replyText: actionResult.replyText,
        replyPlan: actionResult.replyPlan,
        proposedNextAction: actionResult.proposedNextAction ?? null,
        workingContext: actionResult.workingContext ?? workingContext,
        outcomes: actionResult.outcomes ?? [],
        userMessageAlreadyPersisted: !!actionResult.userMessageAlreadyPersisted,
      };
    }

    if (turn.kind === 'clarify') {
      return respondWithKbClarify({
        anthropic,
        req,
        res,
        name,
        chatId,
        turnId,
        routePrompt: turn.routePrompt || promptText,
        question: turn.question,
        proposedNextAction: resolveClarifyProposedNextAction(turn, runtimeProposedNextAction),
        memoryContext,
        workingContext,
        groundedTurn: finalGroundedTurn,
        deps,
      });
    }

    return respondWithKbReply({
        anthropic,
        req,
        res,
        name,
        chatId,
        turnId,
      routePrompt: turn.routePrompt || promptText,
        replyText: turn.replyText,
        replyPlan: turn.replyPlan,
        memoryContext,
        groundedTurn: finalGroundedTurn,
        workingContext: turn.workingContext ?? workingContext,
        outcomes: turn.outcomes ?? [],
        userMessageAlreadyPersisted: !!turn.userMessageAlreadyPersisted,
        proposedNextAction: turn.proposedNextAction ?? null,
        deps,
      });
  } catch (error) {
    return await respondWithKbAnthropicFailure({
      error,
      req,
      res,
      name,
      chatId,
      promptText,
      memoryContext,
      groundedTurn: finalGroundedTurn,
      workingContext,
      deps,
    });
  }
}
