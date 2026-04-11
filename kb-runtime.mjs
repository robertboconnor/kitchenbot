import { getChatRuntimeState } from './db.mjs';
import { interpretKbTurn } from './kb-interpreter.mjs';
import { normalizeProposedNextAction } from './kb-next-action.mjs';
import { decideKbNextActionFollowUp, decideKbTurnFallback } from './kb-turn-decider.mjs';
import { executeKbActions, getKbContextProfileForActions, mergeKbContextProfiles } from './kb-skills.mjs';
import { respondWithKbClarify, respondWithKbReply } from './kb-reply.mjs';
import {
  buildPromptContextProfile,
  buildRuntimeKbContext,
  normalizeClientTimeContext,
  profileNeedsRefresh,
} from './kb-context-policy.mjs';
import {
  normalizeWorkingContext,
} from './kb-working-context.mjs';

export function resolveClarifyProposedNextAction(turn, runtimeProposedNextAction) {
  if (turn?.kind !== 'clarify') return turn?.proposedNextAction ?? null;
  if (turn?.proposedNextAction) return turn.proposedNextAction;
  return runtimeProposedNextAction?.type === 'clarify_action' ? runtimeProposedNextAction : null;
}

export async function handleKbChatTurn({ req, res, name, chatId, prompt, deps }) {
  const promptText = String(prompt ?? '').trim();
  const timeContext = normalizeClientTimeContext(req.body?.timeContext);
  const runtimeState = await getChatRuntimeState(chatId, req.householdId);
  const runtimeProposedNextAction = normalizeProposedNextAction(runtimeState.proposedNextAction);
  const workingContext = normalizeWorkingContext(runtimeState.workingContext);

  let anthropic = null;
  let webSearchEnabled = false;
  try {
    const ac = await deps.getAnthropicClient(req.householdId);
    anthropic = ac.client;
    webSearchEnabled = !!ac.webSearchEnabled;
  } catch (error) {
    if (deps.isAnthropicSdkAuthOrKeyError?.(error)) {
      return res.status(503).json({ reply: deps.ANTHROPIC_KEY_USER_MESSAGE });
    }
  }
  req.kbCapabilities = { webSearchEnabled };

  let turn = decideKbNextActionFollowUp(promptText, runtimeProposedNextAction);
  let contextProfile = turn?.kind === 'execute_action'
    ? mergeKbContextProfiles(getKbContextProfileForActions(turn.actions), { includeWorkingContext: !!runtimeProposedNextAction })
    : buildPromptContextProfile({ prompt: promptText, runtimeProposedNextAction, workingContext });
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
    includePantry: contextProfile.includePantry,
    includeGrocery: contextProfile.includeGrocery,
    capabilities: { webSearchEnabled },
  });
  let memoryContext = buildRuntimeKbContext({
    baseContext: baseMemoryContext,
    timeContext,
    workingContext,
    profile: contextProfile,
  });
  let memoriesByKey = new Map((memoryContext.rows || []).map((row) => [row.key, row.value]));

  if (!turn) {
    turn =
    (await interpretKbTurn({
      anthropic,
      req,
      chatId,
      prompt: promptText,
      activeSpeakerName: name,
      memoryContext,
      runtimeProposedNextAction,
      memoriesByKey,
      deps,
    })) ||
    decideKbTurnFallback({
      prompt: promptText,
      memoriesByKey,
      activeSpeakerName: name,
    });
  }

  if (turn.kind === 'execute_action') {
    const requiredProfile = mergeKbContextProfiles(contextProfile, getKbContextProfileForActions(turn.actions));
    if (profileNeedsRefresh(contextProfile, requiredProfile)) {
      contextProfile = requiredProfile;
      baseMemoryContext = await deps.buildKbContextPacket(req.householdId, promptText, {
        limit: 6,
        activeSpeakerName: name,
        includeDefaults: contextProfile.includeDefaults,
        includePantry: contextProfile.includePantry,
        includeGrocery: contextProfile.includeGrocery,
        capabilities: { webSearchEnabled },
      });
      memoryContext = buildRuntimeKbContext({
        baseContext: baseMemoryContext,
        timeContext,
        workingContext,
        profile: { ...contextProfile, pendingAction: runtimeProposedNextAction },
      });
      memoriesByKey = new Map((memoryContext.rows || []).map((row) => [row.key, row.value]));
    }
    const actionResult = await executeKbActions(turn.actions, {
      req,
      res,
      name,
      chatId,
      prompt: promptText,
      anthropic,
      memories: memoryContext.rows,
      memoryContext,
      workingContext,
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
      routePrompt: turn.routePrompt || promptText,
      question: turn.question,
      proposedNextAction: resolveClarifyProposedNextAction(turn, runtimeProposedNextAction),
      memoryContext,
      workingContext,
      deps,
    });
  }

  return respondWithKbReply({
      anthropic,
      req,
      res,
      name,
      chatId,
    routePrompt: turn.routePrompt || promptText,
      replyText: turn.replyText,
      replyPlan: turn.replyPlan,
      memoryContext,
      workingContext: turn.workingContext ?? workingContext,
      outcomes: turn.outcomes ?? [],
      userMessageAlreadyPersisted: !!turn.userMessageAlreadyPersisted,
      proposedNextAction: turn.proposedNextAction ?? null,
      deps,
    });
}
