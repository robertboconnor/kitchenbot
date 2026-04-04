/**
 * Interaction engine (v1): turn-level routing decisions for POST /chat.
 * No side effects — persistence, Anthropic, and HTTP stay in kitchenbot.mjs.
 *
 * Covers: recovery + routePrompt, short-affirmative fallback, NL intent + duplicate-grocery
 * suppression, private !love / !help, then command vs stream routing after Anthropic is available.
 */
import { getChatThreadContext, getMessages } from './db.mjs';
import {
  sanitizePendingAction,
  routePromptFromSanitizedPendingAction,
  recoverPendingActionFromLastAssistantMessage,
  isPendingActionConfirmation,
  isShortAffirmativeConfirm,
} from './pending-state.mjs';

/** True when weekly_plan_draft_json has planning content (label, meals, or notes). */
export function weeklyPlanDraftHasMeaningfulContent(draft) {
  if (!draft || typeof draft !== 'object') return false;
  const label = String(draft.label ?? '').trim();
  const meals = Array.isArray(draft.meals) ? draft.meals.filter((m) => String(m).trim()) : [];
  const notes = String(draft.notes ?? '').trim();
  return (
    (label && label.length > 0) ||
    meals.length > 0 ||
    (notes && notes.length > 0)
  );
}

/**
 * Conservative gate: await weekly plan draft auto-updater before persisting assistant text only on
 * turns that clearly concern weekly dinner planning. False negatives are acceptable.
 * @param {string} routePrompt
 * @param {object} [weeklyPlanDraft] — current chat draft (for swap/faster follow-ups when a plan exists)
 */
export function isWeeklyPlanningLikeUserTurn(routePrompt, weeklyPlanDraft) {
  const t = String(routePrompt ?? '').trim().toLowerCase();
  if (!t) return false;
  if (/\bmeals?\s+for\s+(?:the\s+)?week\b/.test(t)) return true;
  if (/\bdinner\s+(?:plan|ideas?)\s+for\s+(?:the\s+)?week\b/.test(t)) return true;
  if (/\bweekly\s+(?:dinner|meal)\s+plan\b/.test(t)) return true;
  if (/\bplan\s+(?:our|my)\s+week\b/.test(t) && /\b(?:dinner|meal|eat|food|cook)\b/.test(t)) return true;
  if (
    /\bwhat\s+(?:are\s+we|should\s+we)\s+(?:having|eating|cooking)\s+(?:for\s+)?(?:this\s+)?week\b/.test(t)
  ) {
    return true;
  }
  if (/\b(?:rough|whole)\s+week(?:'|’)?s?\s+(?:of\s+)?(?:dinners?|meals?)\b/.test(t)) return true;
  if (/\b(?:menu|dinners?)\s+for\s+(?:the\s+)?week\b/.test(t)) return true;
  if (weeklyPlanDraftHasMeaningfulContent(weeklyPlanDraft)) {
    if (/\b(?:swap|replace|switch)\b/.test(t) && /\b(?:for|with|instead)\b/.test(t)) return true;
    if (/\b(?:replace|swap|change|update|keep|make)\b[\s\S]{0,40}\b(?:first|second|third|fourth|fifth|\d+(?:st|nd|rd|th)?)\s+(?:meal|dinner|slot)\b/.test(t)) {
      return true;
    }
    if (/\bkeep\b[\s\S]{0,40}\bbut\b/.test(t) && /\b(?:meal|dinner|chicken|tofu|salmon|fish|stew|curry)\b/.test(t)) {
      return true;
    }
    if (/\bmake\s+(?:one|it|that|this)\s+(?:of\s+)?(?:these\s+)?(?:faster|quicker|simpler|easier)\b/.test(t)) {
      return true;
    }
  }
  return false;
}

/** User is asking about the live saved list in the app tab, not a plan-based draft. */
function matchesLiveGroceryTabReadIntent(raw) {
  const t = String(raw ?? '').trim().toLowerCase();
  if (!t) return false;
  if (/\bgrocery\s+list\s+tab\b/.test(t)) return true;
  if (/\bshopping\s+list\s+tab\b/.test(t)) return true;
  if (/\bin\s+(?:the\s+)?(?:grocery|shopping)\s+list\s+tab\b/.test(t)) return true;
  if (/\bwhat(?:'s|s| is)\s+in\s+(?:my\s+)?(?:the\s+)?grocery\s+list\s+tab\b/.test(t)) return true;
  if (/\bshow\s+me\s+(?:what(?:'s|s| is)\s+in\s+)?(?:my\s+)?(?:the\s+)?grocery\s+list\s+tab\b/.test(t)) {
    return true;
  }
  if (/\bis\s+(?:my\s+)?(?:the\s+)?grocery\s+list\s+tab\s+empty\b/.test(t)) return true;
  if (/\bare\s+there\s+(?:any\s+)?items\s+in\s+(?:my\s+)?(?:the\s+)?grocery\s+list\s+tab\b/.test(t)) {
    return true;
  }
  return false;
}

/**
 * User wants a shopping/grocery list from the meal plan, not a read of the live tab.
 * Mutually exclusive with matchesLiveGroceryTabReadIntent in routing (check tab intent first).
 */
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

/**
 * @param {object} input
 * @param {string} [input.prompt]
 * @param {number} input.chatId
 * @param {number} input.householdId
 * @param {unknown} input.bodyExecutePending
 * @param {Map<string, string>} input.memoriesByKey
 * @param {boolean} [input.smartModeEnabled] when true, NL intent may treat more phrasings as pending offers (no execution change)
 * @param {object} input.deps
 * @param {(text: string) => string} input.deps.stripStoredMessageContentForDisplay
 * @param {(summary: string, assistantContents: string[]) => boolean} input.deps.threadHasConcreteGroceryDraftForFollowUp
 * @param {(prompt: string, memoriesByKey: Map<string, string>, intentOpts?: object) => { pendingAction: object | null }} input.deps.detectCommandIntentFromNaturalLanguage
 * @param {(prompt: string) => boolean} input.deps.isPrivateChatCommand
 * @param {(ctx: object) => Promise<{ kind: 'pending_offer', pendingAction: object } | { kind: 'execute_direct', pendingAction: object } | { kind: 'execute_plan', actions: object[] } | { kind: 'proceed', mixedMemoryHint?: boolean, clarifyHint?: boolean } | null>} [input.deps.runSmartModeInterpreter] Smart Mode LLM layer (no execution); null skips
 */
export async function decideChatTurn(input) {
  const {
    prompt,
    chatId,
    householdId,
    bodyExecutePending,
    memoriesByKey,
    smartModeEnabled = false,
    deps: {
      stripStoredMessageContentForDisplay,
      threadHasConcreteGroceryDraftForFollowUp,
      detectCommandIntentFromNaturalLanguage,
      isPrivateChatCommand,
      runSmartModeInterpreter,
    },
  } = input;

  let executePendingAction = sanitizePendingAction(bodyExecutePending);
  let routePrompt = routePromptFromSanitizedPendingAction(executePendingAction, prompt);

  let recoveredPending = null;
  if (!executePendingAction && prompt) {
    recoveredPending = await recoverPendingActionFromLastAssistantMessage(chatId, householdId);
    if (recoveredPending && isPendingActionConfirmation(prompt, recoveredPending)) {
      executePendingAction = recoveredPending;
      routePrompt = routePromptFromSanitizedPendingAction(recoveredPending, prompt);
    }
  }

  const commandUserTextForPersistence = executePendingAction ? prompt : routePrompt;

  if (
    !executePendingAction &&
    prompt &&
    isShortAffirmativeConfirm(prompt) &&
    !String(routePrompt ?? '').trim().startsWith('!')
  ) {
    return {
      kind: 'short_affirmative_fallback',
      commandUserTextForPersistence,
    };
  }

  if (!executePendingAction && routePrompt && !String(routePrompt).trim().startsWith('!')) {
    if (!isShortAffirmativeConfirm(prompt)) {
      if (smartModeEnabled) {
        const threadCtxWeeklyShop = await getChatThreadContext(chatId, householdId);
        const convWeeklyShop = await getMessages(chatId, householdId);
        const assistantWeeklyShop = convWeeklyShop
          .filter((m) => m.role === 'assistant')
          .slice(-3)
          .map((m) => stripStoredMessageContentForDisplay(m.content));
        const hasGroceryDraftWeeklyShop = threadHasConcreteGroceryDraftForFollowUp(
          threadCtxWeeklyShop.threadGrocerySummary,
          assistantWeeklyShop
        );
        if (
          weeklyPlanDraftHasMeaningfulContent(threadCtxWeeklyShop.weeklyPlanDraft) &&
          !hasGroceryDraftWeeklyShop &&
          !matchesLiveGroceryTabReadIntent(prompt) &&
          matchesWeeklyPlanShoppingListIntent(prompt)
        ) {
          return {
            kind: 'weekly_plan_grocery_draft',
            routePrompt: prompt,
            executePendingAction: null,
            recoveredPending,
            commandUserTextForPersistence: prompt,
          };
        }
      }

      if (
        smartModeEnabled &&
        typeof runSmartModeInterpreter === 'function' &&
        prompt &&
        !executePendingAction
      ) {
        try {
          const ir = await runSmartModeInterpreter({
            prompt,
            chatId,
            householdId,
            memoriesByKey,
            recoveredPending,
            bodyExecutePending,
            routePrompt,
            stripStoredMessageContentForDisplay,
          });
          if (ir?.kind === 'pending_offer' && ir.pendingAction) {
            const dupGroceryOffer =
              recoveredPending &&
              recoveredPending.command === '!grocerylist' &&
              ir.pendingAction.command === '!grocerylist';
            if (!dupGroceryOffer) {
              return {
                kind: 'pending_offer',
                pendingAction: ir.pendingAction,
                routePrompt,
                commandUserTextForPersistence,
              };
            }
          } else if (ir?.kind === 'execute_direct' && ir.pendingAction) {
            const dupGroceryOffer =
              recoveredPending &&
              recoveredPending.command === '!grocerylist' &&
              ir.pendingAction.command === '!grocerylist';
            if (!dupGroceryOffer) {
              const sanitized = sanitizePendingAction(ir.pendingAction);
              if (sanitized) {
                return {
                  kind: 'execute_direct',
                  pendingAction: sanitized,
                  routePrompt: routePromptFromSanitizedPendingAction(sanitized, prompt),
                  commandUserTextForPersistence: prompt,
                };
              }
            }
          } else if (ir?.kind === 'execute_plan' && Array.isArray(ir.actions) && ir.actions.length >= 1) {
            const dupGroceryOffer =
              recoveredPending &&
              recoveredPending.command === '!grocerylist' &&
              ir.actions.some((a) => sanitizePendingAction(a)?.command === '!grocerylist');
            if (!dupGroceryOffer) {
              const sanitizedList = [];
              for (const raw of ir.actions) {
                const s = sanitizePendingAction(raw);
                if (!s) {
                  sanitizedList.length = 0;
                  break;
                }
                sanitizedList.push(s);
              }
              if (sanitizedList.length === ir.actions.length && sanitizedList.length >= 1) {
                return {
                  kind: 'execute_plan',
                  actions: sanitizedList,
                  routePrompt,
                  commandUserTextForPersistence: prompt,
                };
              }
            }
          } else if (ir?.kind === 'proceed') {
            return {
              kind: 'proceed_with_anthropic',
              routePrompt,
              executePendingAction,
              recoveredPending,
              commandUserTextForPersistence,
              smartModeMixedMemoryHint: !!ir.mixedMemoryHint,
              smartModeClarifyHint: !!ir.clarifyHint,
            };
          }
        } catch {
          /* fall through to heuristic NL */
        }
      }

      if (smartModeEnabled) {
        const threadCtxForIntent = await getChatThreadContext(chatId, householdId);
        const convForDraft = await getMessages(chatId, householdId);
        const assistantContents = convForDraft
          .filter((m) => m.role === 'assistant')
          .slice(-3)
          .map((m) => stripStoredMessageContentForDisplay(m.content));
        const hasGroceryDraft = threadHasConcreteGroceryDraftForFollowUp(
          threadCtxForIntent.threadGrocerySummary,
          assistantContents
        );
        const intent = detectCommandIntentFromNaturalLanguage(routePrompt, memoriesByKey, {
          hasGroceryDraft,
          smartModeEnabled,
        });
        if (intent.pendingAction) {
          const dupGroceryOffer =
            recoveredPending &&
            recoveredPending.command === '!grocerylist' &&
            intent.pendingAction.command === '!grocerylist';
          if (!dupGroceryOffer) {
            return {
              kind: 'pending_offer',
              pendingAction: intent.pendingAction,
              routePrompt,
              commandUserTextForPersistence,
            };
          }
        }
      }
    }
  }

  if (isPrivateChatCommand(routePrompt) && /^!love(?:\s|$)/.test(routePrompt)) {
    const loveRest = routePrompt.match(/^!love\s*(.*)$/);
    const targetName = loveRest && loveRest[1] != null ? String(loveRest[1]).trim() : '';
    if (!targetName) {
      return { kind: 'private_love_usage' };
    }
    return { kind: 'private_love_resolve', targetName };
  }

  if (routePrompt === '!help' && isPrivateChatCommand(routePrompt)) {
    return { kind: 'private_help' };
  }

  if (!smartModeEnabled && routePrompt && !String(routePrompt).trim().startsWith('!')) {
    const intent = detectCommandIntentFromNaturalLanguage(routePrompt, memoriesByKey, {
      hasGroceryDraft: false,
      smartModeEnabled: false,
    });
    const pendingAction = sanitizePendingAction(intent?.pendingAction);
    if (pendingAction) {
      return {
        kind: 'legacy_command_guidance',
        pendingAction,
        routePrompt,
        executePendingAction,
        recoveredPending,
        commandUserTextForPersistence,
        smartModeMixedMemoryHint: false,
        smartModeClarifyHint: false,
      };
    }
  }

  return {
    kind: 'proceed_with_anthropic',
    routePrompt,
    executePendingAction,
    recoveredPending,
    commandUserTextForPersistence,
    smartModeMixedMemoryHint: false,
    smartModeClarifyHint: false,
  };
}

/**
 * Routing after Anthropic client is available (rename, memories, shared commands, unknown !, stream).
 * @param {object} input
 * @param {string} [input.routePrompt]
 * @param {ReturnType<typeof sanitizePendingAction>} input.executePendingAction
 * @param {(p: string) => boolean} input.isMemoriesCommand
 * @param {(p: string) => boolean} input.isGroceryListCommand
 * @param {(p: string, memoryParsed: unknown) => boolean} input.isSharedChatCommand
 * @param {(p: string) => boolean} input.isPrivateChatCommand
 * @param {(p: string) => object | null} input.parseMemoryCommand
 */
export function decideCommandRoute(input) {
  const {
    routePrompt,
    executePendingAction,
    isMemoriesCommand,
    isGroceryListCommand,
    isSharedChatCommand,
    isPrivateChatCommand,
    parseMemoryCommand,
  } = input;

  const renameMatch = routePrompt?.match(/^!rename\s*(.*)$/);
  if (renameMatch) {
    const arg = typeof renameMatch[1] === 'string' ? renameMatch[1].trim() : '';
    return { kind: 'rename', arg };
  }

  const memoriesCommand = isMemoriesCommand(routePrompt);

  const memoryParsed =
    executePendingAction?.command === '!remember'
      ? { key: executePendingAction.args.key, value: executePendingAction.args.value }
      : parseMemoryCommand(routePrompt);
  const groceryListCommand = isGroceryListCommand(routePrompt);

  if (memoriesCommand && isPrivateChatCommand(routePrompt)) {
    return { kind: 'private_memories_list' };
  }

  if (memoryParsed && isSharedChatCommand(routePrompt, memoryParsed)) {
    return { kind: 'remember_shared', memoryParsed };
  }

  if (groceryListCommand && isSharedChatCommand(routePrompt, memoryParsed)) {
    return { kind: 'grocery_shared' };
  }

  if (String(routePrompt ?? '').trim().startsWith('!')) {
    return { kind: 'unknown_bang_command' };
  }

  if (!routePrompt) {
    return { kind: 'prompt_required' };
  }

  return { kind: 'stream_chat' };
}
