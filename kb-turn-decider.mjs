import { detectMemorySaveIntent } from './kb-memory-policy.mjs';
import { normalizeProposedNextAction } from './kb-next-action.mjs';
import { inferHouseholdDefaultsUpdateFromPrompt, inferPantryAddItemsFromPrompt } from './kb-skills.mjs';
import { extractFirstUrl } from './cookbook-store.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

function promptMatchesChoice(promptText, choice, index) {
  const text = safeTrim(promptText).toLowerCase();
  const id = safeTrim(choice?.id).toLowerCase();
  const label = safeTrim(choice?.label).toLowerCase();
  if (!text || !id || !label) return false;
  if (text === id || text === label || text.includes(label)) return true;
  if (/\boption\s+/i.test(text) && new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) {
    return true;
  }
  const ordinal = index === 0 ? 'first' : index === 1 ? 'second' : index === 2 ? 'third' : '';
  if (ordinal && new RegExp(`\\b${ordinal}\\s+one\\b`, 'i').test(text)) return true;
  return false;
}

function promptAcceptsDefaultChoice(promptText) {
  const text = safeTrim(promptText).toLowerCase();
  if (!text) return false;
  return /^(yes|yeah|yep|sure|ok|okay|do it|go ahead)$/i.test(text) ||
    /\b(go with that|go with this|go with that one|go with this one|that one|this one|sounds good|let'?s do that|use that)\b/i.test(text);
}

function isExplicitLinkedRecipeSavePrompt(promptText) {
  const text = safeTrim(promptText).toLowerCase();
  if (!text) return false;
  const hasUrl = !!extractFirstUrl(text);
  if (!hasUrl) return false;
  return (
    /\b(save|add|store|bookmark)\b/.test(text) &&
    /\b(recipe|dish|meal idea|cookbook)\b/.test(text)
  );
}

function inferCookbookFallbackAction(promptText) {
  const text = String(promptText ?? '').trim();
  if (!text) return null;
  if (!isExplicitLinkedRecipeSavePrompt(text)) return null;
  return {
    kind: 'execute_action',
    actions: [{ capability: 'cookbook.save', input: { request: text } }],
    routePrompt: text,
  };
}

export function decideKbActionIntegrityOverride(prompt, interpretedTurn) {
  const cookbookTurn = inferCookbookFallbackAction(prompt);
  if (!cookbookTurn) return null;

  if (interpretedTurn?.kind === 'execute_action') {
    const actions = Array.isArray(interpretedTurn.actions) ? interpretedTurn.actions : [];
    const alreadyCookbookSave = actions.some((action) => String(action?.capability || '').trim() === 'cookbook.save');
    if (alreadyCookbookSave) return null;
  }

  if (!isExplicitLinkedRecipeSavePrompt(prompt)) return null;
  return cookbookTurn;
}

export function decideKbProtectedActionTurn(prompt) {
  if (!isExplicitLinkedRecipeSavePrompt(prompt)) return null;
  const cookbookTurn = inferCookbookFallbackAction(prompt);
  if (!cookbookTurn) return null;
  return {
    ...cookbookTurn,
    decisionSource: 'pre_router',
  };
}

export function decideKbNextActionFollowUp(prompt, nextAction, workingContext = null) {
  const action = normalizeProposedNextAction(nextAction);
  if (!action) return null;
  const text = String(prompt ?? '').trim().toLowerCase();
  if (!text) return null;

  if (action.type === 'choice') {
    const matchedChoice = action.choices.find((choice, index) => promptMatchesChoice(text, choice, index));
    if (matchedChoice) {
      return {
        kind: 'execute_action',
        actions: [{
          capability: matchedChoice.capability || action.action.capability,
          input: matchedChoice.actionInput,
        }],
        routePrompt: prompt,
      };
    }
    if (promptAcceptsDefaultChoice(text)) {
      const defaultChoice = action.defaultChoiceId
        ? action.choices.find((choice) => String(choice.id) === String(action.defaultChoiceId))
        : null;
      if (defaultChoice) {
        return {
          kind: 'execute_action',
          actions: [{
            capability: defaultChoice.capability || action.action.capability,
            input: defaultChoice.actionInput,
          }],
          routePrompt: prompt,
        };
      }
      return {
        kind: 'clarify',
        question: action.question || 'Which option do you want?',
      };
    }
    if (/^(no|nope|stop|cancel|never mind|nevermind)$/i.test(text)) {
      return { kind: 'reply_only', routePrompt: prompt, replyText: 'Okay, I left the grocery list alone.' };
    }
  }

  return null;
}

// This file is a narrow fallback/follow-up lane. It must not become a second feature brain.
// `decideKbTurnFallback` is only used when model interpretation does not return a usable turn.
export function decideKbTurnFallback({ prompt, memoriesByKey, activeSpeakerName = '' }) {
  const promptText = String(prompt ?? '').trim();

  const cookbookTurn = inferCookbookFallbackAction(promptText);
  if (cookbookTurn) return cookbookTurn;

  const defaultsUpdate = inferHouseholdDefaultsUpdateFromPrompt(promptText);
  if (defaultsUpdate && Object.keys(defaultsUpdate).length > 0) {
    return {
      kind: 'execute_action',
      actions: [{ capability: 'household.defaults.update', input: defaultsUpdate }],
      routePrompt: promptText,
    };
  }

  const pantryItems = inferPantryAddItemsFromPrompt(promptText);
  if (Array.isArray(pantryItems) && pantryItems.length > 0) {
    return {
      kind: 'execute_action',
      actions: [{ capability: 'pantry.add', input: { items: pantryItems } }],
      routePrompt: promptText,
    };
  }

  const memoryIntent = detectMemorySaveIntent(promptText, memoriesByKey, { activeSpeakerName });
  if (memoryIntent?.key && memoryIntent?.value) {
    return {
      kind: 'execute_action',
      actions: [{ capability: 'memory.save', input: memoryIntent }],
      routePrompt: promptText,
    };
  }

  return {
    kind: 'reply_only',
    routePrompt: promptText,
    replyPlan: { kind: 'generate_reply' },
  };
}
