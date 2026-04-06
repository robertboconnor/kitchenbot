import { listCapabilitiesForInterpreter, parseExplicitBangCommand } from './capability-registry.mjs';

function looksExplicitWeeklyPlanMutationIntent(raw) {
  const t = String(raw ?? '').trim().toLowerCase();
  if (!t) return false;
  if (/\b(save|store|commit|update|set|make)\b[\s\S]{0,50}\b(?:this\s+week'?s|the)\s+(?:dinner|meal)\s+plan\b/.test(t)) return true;
  if (/\b(save|store|commit|update|set|make)\b[\s\S]{0,50}\bweekly\s+(?:dinner|meal)\s+plan\b/.test(t)) return true;
  if (/\bmake\s+that\b[\s\S]{0,40}\b(?:this\s+week'?s|the)\s+(?:plan|dinner plan|meal plan)\b/.test(t)) return true;
  if (/\b(?:replace|swap|switch|change|update|remove|delete)\b[\s\S]{0,50}\b(?:dinner|meal|slot)\b/.test(t)) return true;
  if (/\b(?:replace|swap|switch|change|update)\b[\s\S]{0,50}\b(?:first|second|third|fourth|fifth|\d+(?:st|nd|rd|th)?)\b/.test(t)) return true;
  return false;
}

export async function decideSmartRuntimeTurn(input) {
  const {
    prompt,
    chatId,
    householdId,
    memoriesByKey,
    runtimeProposedNextAction,
    detectSmartActionIntentFromNaturalLanguage,
    isPrivateChatCommand,
    parseMemoryCommand,
    isGroceryListCommand,
    runSmartModeInterpreter,
    interpretSmartSkillFollowUp,
  } = input;

  const promptText = String(prompt ?? '').trim();
  const explicitRuntimeAction = parseExplicitBangCommand(promptText, {
    parseMemoryCommand,
    isGroceryListCommand,
    isPrivateChatCommand,
  });
  if (explicitRuntimeAction) {
    return {
      kind: 'execute_action',
      actions: [explicitRuntimeAction],
      routePrompt: promptText,
      commandUserTextForPersistence: promptText,
    };
  }

  if (runtimeProposedNextAction && promptText) {
    if (typeof interpretSmartSkillFollowUp === 'function') {
      const followUpTurn = interpretSmartSkillFollowUp(promptText, runtimeProposedNextAction);
      if (followUpTurn) {
        return followUpTurn;
      }
    }
  }
  const includeWeeklyPlanCapability = looksExplicitWeeklyPlanMutationIntent(promptText);
  const allowedCapabilities = listCapabilitiesForInterpreter({ includeWeeklyPlanPatch: includeWeeklyPlanCapability });

  if (typeof runSmartModeInterpreter === 'function' && promptText) {
    const ir = await runSmartModeInterpreter({
      prompt: promptText,
      chatId,
      householdId,
      memoriesByKey,
      allowedCapabilities,
      includeWeeklyPlanArtifactContext: includeWeeklyPlanCapability,
    });
    if (ir?.kind === 'reply') {
      return {
        kind: 'reply_only',
        routePrompt: promptText,
        commandUserTextForPersistence: promptText,
        replyPlan: { kind: 'generate_reply', style: 'conversation' },
      };
    }
    if (ir?.kind === 'actions' && Array.isArray(ir.actions) && ir.actions.length >= 1) {
      return {
        kind: 'execute_action',
        actions: ir.actions,
        routePrompt: promptText,
        commandUserTextForPersistence: promptText,
      };
    }
    if (ir?.kind === 'clarify') {
      return {
        kind: 'clarify',
        question: String(ir.question ?? '').trim() || 'Can you clarify what you want me to do?',
      };
    }
  }

  const heuristicAction = detectSmartActionIntentFromNaturalLanguage(promptText, memoriesByKey, {});
  if (heuristicAction) {
    return {
      kind: 'execute_action',
      actions: [heuristicAction],
      routePrompt: promptText,
      commandUserTextForPersistence: promptText,
    };
  }

  return {
    kind: 'reply_only',
    routePrompt: promptText,
    commandUserTextForPersistence: promptText,
    replyPlan: { kind: 'generate_reply', style: 'conversation' },
  };
}
