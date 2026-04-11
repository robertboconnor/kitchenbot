import { detectMemorySaveIntent } from './kb-memory-policy.mjs';
import { normalizeProposedNextAction } from './kb-next-action.mjs';
import { inferHouseholdDefaultsUpdateFromPrompt, inferPantryAddItemsFromPrompt } from './kb-skills.mjs';

export function decideKbNextActionFollowUp(prompt, nextAction) {
  const action = normalizeProposedNextAction(nextAction);
  if (!action) return null;
  const text = String(prompt ?? '').trim().toLowerCase();
  if (!text) return null;

  if (action.type === 'choice') {
    const matchedChoice = action.choices.find((choice) => {
      const id = String(choice.id).toLowerCase();
      const label = String(choice.label).toLowerCase();
      return text === id || text === label || text.includes(id) || text.includes(label);
    });
    if (matchedChoice) {
      return {
        kind: 'execute_action',
        actions: [{ capability: action.action.capability, input: matchedChoice.actionInput }],
        routePrompt: prompt,
      };
    }
    if (/^(yes|yeah|yep|sure|ok|okay|do it|go ahead)$/i.test(text)) {
      return {
        kind: 'clarify',
        question: action.question || 'Do you want me to append, replace, or prune the current list?',
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
