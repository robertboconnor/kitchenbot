function safeTrim(text) {
  return String(text ?? '').trim();
}

function normalizeActionObject(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) && safeTrim(raw.capability)
    ? {
        capability: safeTrim(raw.capability),
        input: raw.input && typeof raw.input === 'object' && !Array.isArray(raw.input) ? raw.input : {},
      }
    : null;
}

function normalizeCandidateOptions(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((option, index) => {
      if (typeof option === 'string') {
        const label = safeTrim(option);
        return label ? { id: String(index + 1), label } : null;
      }
      const label = safeTrim(option?.label || option?.name || option?.value);
      const id = safeTrim(option?.id || String(index + 1));
      if (!label || !id) return null;
      const value = safeTrim(option?.value || option?.text);
      return value ? { id, label, value } : { id, label };
    })
    .filter(Boolean);
}

export function normalizeProposedNextAction(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.active !== true) return null;
  const type = safeTrim(raw.type);
  const action = normalizeActionObject(raw.action);
  if (!type || !action?.capability) return null;
  if (type === 'choice') {
    const choices = Array.isArray(raw.choices)
      ? raw.choices
          .map((choice) => {
            const id = safeTrim(choice?.id);
            const label = safeTrim(choice?.label);
            const capability = safeTrim(choice?.capability);
            const actionInput =
              choice?.actionInput && typeof choice.actionInput === 'object' && !Array.isArray(choice.actionInput)
                ? choice.actionInput
                : null;
            if (!id || !label || !actionInput) return null;
            return { id, label, capability: capability || '', actionInput };
          })
          .filter(Boolean)
      : [];
    if (choices.length === 0) return null;
    const defaultChoiceId = safeTrim(raw.defaultChoiceId);
    return {
      active: true,
      type,
      action,
      choices,
      defaultChoiceId: choices.some((choice) => choice.id === defaultChoiceId) ? defaultChoiceId : '',
      question: safeTrim(raw.question),
      visibleReplySummary: safeTrim(raw.visibleReplySummary),
    };
  }
  if (type === 'clarify_action') {
    const unresolvedFields = (Array.isArray(raw.unresolvedFields) ? raw.unresolvedFields : [])
      .map((field) => safeTrim(field))
      .filter(Boolean)
      .slice(0, 8);
    return {
      active: true,
      type,
      action,
      question: safeTrim(raw.question),
      visibleReplySummary: safeTrim(raw.visibleReplySummary),
      contextSummary: safeTrim(raw.contextSummary),
      unresolvedFields,
      candidateOptions: normalizeCandidateOptions(raw.candidateOptions),
    };
  }
  return {
    active: true,
    type,
    action,
    question: safeTrim(raw.question),
    visibleReplySummary: safeTrim(raw.visibleReplySummary),
  };
}

export function buildClarifyActionState({
  capability,
  input = {},
  question = '',
  contextSummary = '',
  unresolvedFields = [],
  candidateOptions = [],
  visibleReplySummary = '',
}) {
  const normalized = normalizeProposedNextAction({
    active: true,
    type: 'clarify_action',
    action: { capability, input },
    question,
    contextSummary,
    unresolvedFields,
    candidateOptions,
    visibleReplySummary,
  });
  return normalized;
}

export function buildChoiceActionState({
  capability,
  input = {},
  choices = [],
  question = '',
  visibleReplySummary = '',
  defaultChoiceId = '',
}) {
  return normalizeProposedNextAction({
    active: true,
    type: 'choice',
    action: { capability, input },
    choices,
    question,
    visibleReplySummary,
    defaultChoiceId,
  });
}
