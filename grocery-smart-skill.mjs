function normalizeText(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

function isShortAffirmativeReply(raw) {
  const text = normalizeText(raw);
  if (!text) return false;
  return (
    /^(?:yes|yep|yeah|sure|okay|ok|go ahead|do it|please do|yes please|sounds good|that works)\b/.test(text) ||
    /^please\b/.test(text)
  );
}

function isShortNegativeReply(raw) {
  const text = normalizeText(raw);
  if (!text) return false;
  return (
    /^(?:no|nope|nah|naw)\b/.test(text) ||
    /\b(?:not now|maybe later|another time)\b/.test(text) ||
    /\b(?:no thanks|no thank you)\b/.test(text)
  );
}

function matchesGroceryPreviewReadIntent(raw) {
  const text = normalizeText(raw);
  if (!text) return false;
  return (
    /\b(?:show|read|see|review|look\s+at|preview)\s+(?:me\s+)?(?:the\s+)?(?:list|preview|that|it)\b/.test(text) ||
    /\b(?:what(?:'s|s| is)\s+(?:on|in)\s+(?:the\s+)?)?(?:grocery|shopping)\s+list\b/.test(text) ||
    /\bshow\s+me\s+(?:the\s+)?list(?:\s+first)?\b/.test(text) ||
    /\blet\s+me\s+(?:read|see|review|look\s+at)\s+(?:the\s+)?list(?:\s+first)?\b/.test(text) ||
    /\bwhat\s+would\s+i\s+need\s+to\s+buy\b/.test(text)
  );
}

function inferChoiceIdFromText(raw, choices) {
  const text = normalizeText(raw);
  const choiceList = Array.isArray(choices) ? choices : [];
  if (!text || choiceList.length === 0) return null;

  for (const choice of choiceList) {
    const id = normalizeText(choice?.id);
    if (id && new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)) {
      return id;
    }
  }

  if (/\b(start fresh|replace|overwrite|clear (?:it|the list|what'?s there)|replace what'?s there)\b/.test(text)) {
    return 'replace';
  }
  if (/\b(add (?:it|them|those|this)?(?: on top)?|append|keep what'?s there|add to what'?s there|add these on top)\b/.test(text)) {
    return 'append';
  }
  if (/\b(prune|remove the old|remove what doesn'?t fit|drop the old items|remove the ones that no longer fit)\b/.test(text)) {
    return 'prune';
  }

  for (const choice of choiceList) {
    const label = normalizeText(choice?.label);
    if (!label) continue;
    const labelTokens = label.split(/\s+/).filter((token) => token.length >= 4);
    if (labelTokens.length > 0 && labelTokens.every((token) => text.includes(token))) {
      return normalizeText(choice?.id);
    }
  }

  return null;
}

function buildGenericConfirmDeclineReply(action) {
  const capability = String(action?.capability ?? '').trim();
  if (capability === 'grocery.generate_and_commit') return "Okay — I'll leave the Grocery List tab unchanged.";
  if (capability === 'grocery.preview') return "Okay — I won't build a grocery preview right now.";
  return "Okay — I'll leave that alone for now.";
}

function buildGroceryChoiceQuestion(optionModes) {
  const modes = Array.isArray(optionModes) ? optionModes.map((mode) => String(mode ?? '').trim()) : [];
  if (modes.includes('prune')) {
    return 'I found items already on your Grocery List tab. I can start fresh, add these on top, or remove the items that no longer fit. Which do you want?';
  }
  return 'I found items already on your Grocery List tab. I can either start fresh or add these on top. Which do you want?';
}

function labelForGroceryMode(mode) {
  if (mode === 'replace') return 'Start fresh';
  if (mode === 'append') return 'Add on top';
  if (mode === 'prune') return 'Remove old items';
  return String(mode ?? '').trim() || 'Choose';
}

export function buildGroceryChoiceNextStep({
  optionModes,
  question,
  reply,
  actionCapability = 'grocery.generate_and_commit',
  actionInput = {},
  priorOutcomes = [],
}) {
  const modes = Array.isArray(optionModes)
    ? optionModes.map((mode) => String(mode ?? '').trim()).filter(Boolean)
    : [];
  if (modes.length === 0) return null;

  const finalQuestion = String(question ?? '').trim() || buildGroceryChoiceQuestion(modes);
  return {
    active: true,
    type: 'choice',
    createdAt: Date.now(),
    action: { capability: actionCapability, input: { ...actionInput } },
    choices: modes.map((mode) => ({
      id: mode,
      label: labelForGroceryMode(mode),
      actionInput: { mode },
    })),
    question: finalQuestion,
    visibleReplySummary: String(reply || finalQuestion).trim().slice(0, 400),
    priorOutcomes: Array.isArray(priorOutcomes) ? priorOutcomes : [],
  };
}

export function interpretGrocerySkillFollowUp(promptText, runtimeProposedNextAction) {
  if (!runtimeProposedNextAction || typeof runtimeProposedNextAction !== 'object') return null;
  const capability = String(runtimeProposedNextAction.action?.capability ?? '').trim();
  if (capability !== 'grocery.generate_and_commit') return null;

  if (runtimeProposedNextAction.type === 'confirm') {
    if (matchesGroceryPreviewReadIntent(promptText)) {
      return {
        kind: 'execute_action',
        actions: [{ capability: 'grocery.preview', input: {} }],
        routePrompt: promptText,
        commandUserTextForPersistence: promptText,
      };
    }
    if (isShortAffirmativeReply(promptText)) {
      return {
        kind: 'execute_action',
        actions: [runtimeProposedNextAction.action],
        routePrompt: promptText,
        commandUserTextForPersistence: promptText,
      };
    }
    if (isShortNegativeReply(promptText)) {
      return {
        kind: 'reply_only',
        routePrompt: promptText,
        commandUserTextForPersistence: promptText,
        replyText: buildGenericConfirmDeclineReply(runtimeProposedNextAction.action),
      };
    }
    return null;
  }

  if (runtimeProposedNextAction.type === 'choice') {
    if (matchesGroceryPreviewReadIntent(promptText)) {
      return {
        kind: 'execute_action',
        actions: [{ capability: 'grocery.preview', input: {} }],
        routePrompt: promptText,
        commandUserTextForPersistence: promptText,
      };
    }
    const selectedChoiceId = inferChoiceIdFromText(promptText, runtimeProposedNextAction.choices);
    if (selectedChoiceId) {
      const choice = runtimeProposedNextAction.choices.find((candidate) => normalizeText(candidate?.id) === selectedChoiceId);
      if (!choice) return null;
      return {
        kind: 'execute_action',
        actions: [
          {
            capability: runtimeProposedNextAction.action.capability,
            input: choice.actionInput,
          },
        ],
        routePrompt: promptText,
        commandUserTextForPersistence: promptText,
      };
    }
    if (isShortAffirmativeReply(promptText)) {
      return {
        kind: 'reply_only',
        routePrompt: promptText,
        commandUserTextForPersistence: promptText,
        replyText: runtimeProposedNextAction.question,
        proposedNextAction: runtimeProposedNextAction,
      };
    }
    if (isShortNegativeReply(promptText)) {
      return {
        kind: 'reply_only',
        routePrompt: promptText,
        commandUserTextForPersistence: promptText,
        replyText: buildGenericConfirmDeclineReply(runtimeProposedNextAction.action),
      };
    }
  }

  return null;
}
