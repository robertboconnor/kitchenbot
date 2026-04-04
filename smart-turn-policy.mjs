import { getChatThreadContext, getMessages } from './db.mjs';
import {
  inferGroceryModeChoiceFromText,
  isPendingActionConfirmation,
  isNaturalLanguageGroceryPendingConfirmation,
  isShortAffirmativeConfirm,
  recoverPendingActionFromLastAssistantMessage,
  sanitizePendingAction,
} from './pending-state.mjs';
import {
  listCapabilitiesForInterpreter,
  parseExplicitBangCommand,
  pendingActionToRuntimeAction,
  runtimeActionToPendingAction,
} from './capability-registry.mjs';
import { weeklyPlanDraftHasMeaningfulContent } from './interaction-engine.mjs';

function matchesLiveGroceryTabReadIntent(raw) {
  const t = String(raw ?? '').trim().toLowerCase();
  if (!t) return false;
  if (/\bgrocery\s+list\s+tab\b/.test(t)) return true;
  if (/\bshopping\s+list\s+tab\b/.test(t)) return true;
  if (/\bin\s+(?:the\s+)?(?:grocery|shopping)\s+list\s+tab\b/.test(t)) return true;
  if (/\bwhat(?:'s|s| is)\s+in\s+(?:my\s+)?(?:the\s+)?grocery\s+list\s+tab\b/.test(t)) return true;
  if (/\bshow\s+me\s+(?:what(?:'s|s| is)\s+in\s+)?(?:my\s+)?(?:the\s+)?grocery\s+list\s+tab\b/.test(t)) return true;
  if (/\bis\s+(?:my\s+)?(?:the\s+)?grocery\s+list\s+tab\s+empty\b/.test(t)) return true;
  if (/\bare\s+there\s+(?:any\s+)?items\s+in\s+(?:my\s+)?(?:the\s+)?grocery\s+list\s+tab\b/.test(t)) return true;
  return false;
}

function matchesWeeklyPlanShoppingListIntent(raw) {
  const t = String(raw ?? '').trim().toLowerCase();
  if (!t) return false;
  if (/\bwhat\s+(?:do|should)\s+i\s+(?:need\s+to\s+)?buy\b/.test(t)) return true;
  if (/\bwhat\s+should\s+i\s+shop\s+for\b/.test(t)) return true;
  if (/\bshow\s+me\s+what\s+to\s+go\s+shopping\s+for\b/.test(t)) return true;
  if (/\bwhat(?:'s|s| is)\s+(?:the\s+)?(?:grocery|shopping)\s+list\b/.test(t)) return true;
  if (/\bshow\s+me\s+(?:the\s+)?(?:grocery|shopping)\s+list\b/.test(t)) return true;
  return false;
}

function matchesIngredientReadIntent(raw) {
  const t = String(raw ?? '').trim().toLowerCase();
  if (!t) return false;
  if (/\bshow\s+me\s+the\s+ingredients\b/.test(t)) return true;
  if (/\bshow\s+me\s+ingredients\b/.test(t)) return true;
  if (/\bwhat\s+are\s+the\s+ingredients\b/.test(t)) return true;
  if (/\bwhat\s+ingredients\s+(?:do\s+i|would\s+i|will\s+i)\s+need\b/.test(t)) return true;
  if (/\bingredients?\s+for\b/.test(t) && !/\b(?:grocery|shopping)\s+list\b/.test(t)) return true;
  return false;
}

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

function looksExplicitMemorySaveIntent(raw) {
  const t = String(raw ?? '').trim().toLowerCase();
  if (!t) return false;
  if (/\b(can|could|should)\s+you\s+(?:remember|save|note)\b/.test(t)) return false;
  if (/^(?:please\s+)?remember\s+that\b/.test(t)) return true;
  if (/^(?:please\s+)?save\s+that\b/.test(t)) return true;
  if (/^(?:please\s+)?save\s+this\b/.test(t)) return true;
  if (/\b(?:remember|save|note|keep)\s+that\b/.test(t) && /\bfor\s+later\b/.test(t)) return true;
  if (/\b(?:save|remember|note)\b[\s\S]{0,30}\b(?:in|to)\s+(?:household\s+)?memory\b/.test(t)) return true;
  return false;
}

function looksExplicitRenameIntent(raw) {
  const t = String(raw ?? '').trim().toLowerCase();
  if (!t) return false;
  if (/\brename\s+this\s+chat\b/.test(t)) return true;
  if (/^!rename(?:\s|$)/.test(t)) return true;
  return false;
}

function looksExplicitHelpIntent(raw) {
  const t = String(raw ?? '').trim().toLowerCase();
  if (!t) return false;
  if (t === 'help' || t === '!help') return true;
  if (/\bwhat\s+can\s+you\s+do\b/.test(t)) return true;
  if (/\bshow\s+me\s+(?:the\s+)?help\b/.test(t)) return true;
  if (/\bi\s+need\s+help\b/.test(t)) return true;
  return false;
}

function shouldExecuteInterpreterPending(action, promptText) {
  if (!action || typeof action !== 'object') return false;
  const capability = String(action.capability ?? '');
  if (capability === 'weekly_plan.patch') return true;
  if (capability === 'help.show') return true;
  if (capability === 'chat.rename') return looksExplicitRenameIntent(promptText);
  if (capability === 'memory.save') return looksExplicitMemorySaveIntent(promptText);
  if (capability === 'grocery.generate_and_commit') return matchesExplicitGroceryBuildIntent(promptText);
  return false;
}

function dedupeRecoveredAction(runtimePendingAction, recoveredPendingAction) {
  if (!runtimePendingAction || !recoveredPendingAction) return false;
  const r0 = JSON.stringify(runtimePendingAction);
  const r1 = JSON.stringify(recoveredPendingAction);
  return r0 === r1;
}

function isRuntimeActionConfirmation(text, runtimeAction, explicitPendingAction, recoveredPendingAction) {
  const pending =
    explicitPendingAction ||
    recoveredPendingAction ||
    runtimeActionToPendingAction(runtimeAction);
  if (!pending) return false;
  return isPendingActionConfirmation(text, pending);
}

export async function decideSmartRuntimeTurn(input) {
  const {
    prompt,
    chatId,
    householdId,
  bodyExecutePending,
  memoriesByKey,
  runtimePendingAction,
  runtimeCheckpoint,
  stripStoredMessageContentForDisplay,
    threadHasConcreteGroceryDraftForFollowUp,
    detectCommandIntentFromNaturalLanguage,
    isPrivateChatCommand,
    parseMemoryCommand,
    isGroceryListCommand,
    runSmartModeInterpreter,
  } = input;

  const promptText = String(prompt ?? '').trim();
  const explicitRuntimeAction = parseExplicitBangCommand(promptText, {
    parseMemoryCommand,
    isGroceryListCommand,
    isPrivateChatCommand,
  });
  if (explicitRuntimeAction) {
    return {
      kind: 'execute_plan',
      actions: [explicitRuntimeAction],
      routePrompt: promptText,
      commandUserTextForPersistence: promptText,
    };
  }

  if (isPrivateChatCommand(promptText) && /^!love(?:\s|$)/.test(promptText)) {
    const loveRest = promptText.match(/^!love\s*(.*)$/);
    const targetName = loveRest && loveRest[1] != null ? String(loveRest[1]).trim() : '';
    if (!targetName) return { kind: 'private_love_usage' };
    return { kind: 'private_love_resolve', targetName };
  }

  const executePendingAction = sanitizePendingAction(bodyExecutePending);
  const explicitPendingRuntimeAction = pendingActionToRuntimeAction(executePendingAction);
  if (explicitPendingRuntimeAction) {
    return {
      kind: 'execute_plan',
      actions: [explicitPendingRuntimeAction],
      routePrompt: promptText,
      commandUserTextForPersistence: promptText,
    };
  }

  let recoveredPendingAction = null;
  let recoveredRuntimeAction = null;
  if (!runtimePendingAction && promptText) {
    recoveredPendingAction = await recoverPendingActionFromLastAssistantMessage(chatId, householdId);
    recoveredRuntimeAction = pendingActionToRuntimeAction(recoveredPendingAction);
  }

  const primaryPendingAction =
    explicitPendingRuntimeAction ||
    runtimePendingAction ||
    (dedupeRecoveredAction(runtimePendingAction, recoveredRuntimeAction) ? null : recoveredRuntimeAction);

  if (primaryPendingAction && isRuntimeActionConfirmation(promptText, primaryPendingAction, executePendingAction, recoveredPendingAction)) {
    return {
      kind: 'execute_plan',
      actions: [primaryPendingAction],
      routePrompt: promptText,
      commandUserTextForPersistence: promptText,
    };
  }

  if (!primaryPendingAction && runtimeCheckpoint?.kind === 'grocery_preview_commit' && promptText) {
    const inferredMode = inferGroceryModeChoiceFromText(promptText, { allowPrune: false });
    if (inferredMode === 'append' || inferredMode === 'replace') {
      return {
        kind: 'execute_plan',
        actions: [{ capability: 'grocery.generate_and_commit', input: { mode: inferredMode } }],
        routePrompt: promptText,
        commandUserTextForPersistence: promptText,
      };
    }
    if (
      isShortAffirmativeConfirm(promptText) ||
      isNaturalLanguageGroceryPendingConfirmation(promptText) ||
      matchesExplicitGroceryBuildIntent(promptText)
    ) {
      return {
        kind: 'execute_plan',
        actions: runtimeCheckpoint.remainingActions,
        routePrompt: promptText,
        commandUserTextForPersistence: promptText,
      };
    }
  }

  if (!primaryPendingAction && runtimeCheckpoint?.kind === 'grocery_disambiguation_resume' && promptText) {
    const inferredMode = inferGroceryModeChoiceFromText(promptText, { allowPrune: true });
    if (inferredMode === 'append' || inferredMode === 'replace' || inferredMode === 'prune') {
      return {
        kind: 'execute_plan',
        actions: [{ capability: 'grocery.generate_and_commit', input: { mode: inferredMode } }],
        routePrompt: promptText,
        commandUserTextForPersistence: promptText,
      };
    }
    if (isShortAffirmativeConfirm(promptText)) {
      const optionModes =
        Array.isArray(runtimeCheckpoint.optionModes) && runtimeCheckpoint.optionModes.length > 0
          ? runtimeCheckpoint.optionModes
          : ['replace', 'append'];
      const options = optionModes.map((mode) => ({ command: '!grocerylist', mode }));
      const replyText = optionModes.includes('prune')
        ? 'I can do that. Do you want me to keep the older items too, or remove the ones that no longer fit this version of the plan?'
        : "I can do that. Do you want me to start fresh with this week's ingredients, or keep what's already there and add these on top?";
      return {
        kind: 'pending_choice',
        routePrompt: promptText,
        commandUserTextForPersistence: promptText,
        replyText,
        pendingHeader: encodeURIComponent(JSON.stringify({ type: 'grocery_mode_choice', options })),
        checkpoint: runtimeCheckpoint,
      };
    }
  }

  if (!primaryPendingAction && promptText && isShortAffirmativeConfirm(promptText) && !promptText.startsWith('!')) {
    return {
      kind: 'short_affirmative_fallback',
      commandUserTextForPersistence: promptText,
    };
  }

  const threadCtx = await getChatThreadContext(chatId, householdId);
  const conv = await getMessages(chatId, householdId);
  const assistantContents = conv
    .filter((m) => m.role === 'assistant')
    .slice(-3)
    .map((m) => stripStoredMessageContentForDisplay(m.content));
  const hasGroceryDraft = threadHasConcreteGroceryDraftForFollowUp(threadCtx.threadGrocerySummary, assistantContents);
  const wantsWeeklyPlanShoppingPreview =
    promptText &&
    weeklyPlanDraftHasMeaningfulContent(threadCtx.weeklyPlanDraft) &&
    !hasGroceryDraft &&
    !matchesLiveGroceryTabReadIntent(promptText) &&
    matchesWeeklyPlanShoppingListIntent(promptText);
  const wantsExplicitGroceryBuild = promptText && matchesExplicitGroceryBuildIntent(promptText);
  const wantsIngredientRead = promptText && matchesIngredientReadIntent(promptText);

  if (typeof runSmartModeInterpreter === 'function' && promptText) {
    const ir = await runSmartModeInterpreter({
      prompt: promptText,
      chatId,
      householdId,
      memoriesByKey,
      runtimePendingAction,
      bodyExecutePending,
      allowedCapabilities: listCapabilitiesForInterpreter(),
    });
    if (ir?.kind === 'reply') {
      return {
        kind: 'proceed_with_anthropic',
        routePrompt: promptText,
        commandUserTextForPersistence: promptText,
      };
    }
    if (ir?.kind === 'actions' && Array.isArray(ir.actions) && ir.actions.length >= 1) {
      const groceryOnlyAction =
        ir.actions.length === 1 && ir.actions[0]?.capability === 'grocery.generate_and_commit'
          ? ir.actions[0]
          : null;
      if (groceryOnlyAction && wantsWeeklyPlanShoppingPreview && !wantsExplicitGroceryBuild) {
        if (wantsWeeklyPlanShoppingPreview) {
          return {
            kind: 'weekly_plan_grocery_draft',
            routePrompt: promptText,
            commandUserTextForPersistence: promptText,
          };
        }
      }
      return {
        kind: 'execute_plan',
        actions: ir.actions,
        routePrompt: promptText,
        commandUserTextForPersistence: promptText,
      };
    }
    if (ir?.kind === 'pending' && ir.action) {
      if (shouldExecuteInterpreterPending(ir.action, promptText)) {
        return {
          kind: 'execute_plan',
          actions: [{ capability: ir.action.capability, input: ir.action.input ?? {} }],
          routePrompt: promptText,
          commandUserTextForPersistence: promptText,
        };
      }
      if (ir.action.capability === 'grocery.generate_and_commit' && (wantsWeeklyPlanShoppingPreview || wantsExplicitGroceryBuild)) {
        if (wantsWeeklyPlanShoppingPreview && !wantsExplicitGroceryBuild) {
          return {
            kind: 'weekly_plan_grocery_draft',
            routePrompt: promptText,
            commandUserTextForPersistence: promptText,
          };
        }
        return {
          kind: 'execute_plan',
          actions: [{ capability: 'grocery.generate_and_commit', input: ir.action.input ?? {} }],
          routePrompt: promptText,
          commandUserTextForPersistence: promptText,
        };
      }
      return {
        kind: 'pending_offer',
        action: ir.action,
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

  if (!wantsIngredientRead && (wantsWeeklyPlanShoppingPreview || wantsExplicitGroceryBuild)) {
    if (wantsExplicitGroceryBuild) {
      return {
        kind: 'execute_plan',
        actions: [{ capability: 'grocery.generate_and_commit', input: {} }],
        routePrompt: promptText,
        commandUserTextForPersistence: promptText,
      };
    }
    if (wantsWeeklyPlanShoppingPreview && weeklyPlanDraftHasMeaningfulContent(threadCtx.weeklyPlanDraft) && !hasGroceryDraft && !matchesLiveGroceryTabReadIntent(promptText)) {
      return {
        kind: 'weekly_plan_grocery_draft',
        routePrompt: promptText,
        commandUserTextForPersistence: promptText,
      };
    }
    return {
      kind: 'execute_plan',
      actions: [{ capability: 'grocery.generate_and_commit', input: {} }],
      routePrompt: promptText,
      commandUserTextForPersistence: promptText,
    };
  }

  const heuristicIntent = detectCommandIntentFromNaturalLanguage(promptText, memoriesByKey, {
    hasGroceryDraft,
    smartModeEnabled: true,
  });
  if (heuristicIntent.pendingAction && !looksExplicitHelpIntent(promptText) && !looksExplicitRenameIntent(promptText)) {
    const runtimeAction = pendingActionToRuntimeAction(heuristicIntent.pendingAction);
    if (runtimeAction) {
      return {
        kind: 'pending_offer',
        action: runtimeAction,
        routePrompt: promptText,
        commandUserTextForPersistence: promptText,
      };
    }
  }

  if (promptText === '!help' && isPrivateChatCommand(promptText)) {
    return { kind: 'private_help' };
  }

  return {
    kind: 'proceed_with_anthropic',
    routePrompt: promptText,
    commandUserTextForPersistence: promptText,
  };
}
