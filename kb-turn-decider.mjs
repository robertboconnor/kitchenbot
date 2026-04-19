import { normalizeProposedNextAction } from './kb-next-action.mjs';

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
