import { getHouseholdDefaults, saveHouseholdDefaults } from './db.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

function buildDefaultsOutcomeReply(outcome) {
  if (!outcome || typeof outcome !== 'object') return 'I could not update the household defaults.';
  if (outcome.status === 'invalid') return safeTrim(outcome.error) || 'I could not update the household defaults.';
  const changedLabels = Array.isArray(outcome.changedFields) ? outcome.changedFields : [];
  if (outcome.status === 'unchanged') {
    return 'Those household defaults were already set that way.';
  }
  if (changedLabels.length === 0) {
    return 'I updated the household defaults.';
  }
  return `I updated the household defaults for ${changedLabels.join(', ')}.`;
}

function fieldLabel(key) {
  if (key === 'defaultDinnerPortions') return 'dinner portions';
  if (key === 'weeknightCookingStyle') return 'weeknight cooking style';
  if (key === 'assistantName') return 'my name';
  if (key === 'assistantTone') return 'my tone';
  return key;
}

export async function executeHouseholdDefaultsUpdate(runtimeAction, context) {
  const {
    req,
    name,
    chatId,
    prompt,
    skipIncrement = false,
    userMessageAlreadyPersisted = false,
    runtimeManagedResponse = false,
    deps = {},
  } = context;

  if (!skipIncrement) {
    await deps.incrementUserMessageCountForSender?.(req);
  }

  const update =
    runtimeAction?.input && typeof runtimeAction.input === 'object' && !Array.isArray(runtimeAction.input)
      ? runtimeAction.input
      : null;

  if (!update || Object.keys(update).length === 0) {
    return {
      capability: 'household.defaults.update',
      status: 'invalid',
      error: 'No household defaults were provided.',
    };
  }

  const current = await getHouseholdDefaults(req.householdId);
  const next = await saveHouseholdDefaults(req.householdId, update);
  const changedFields = [];
  if (
    update.defaultDinnerPortions !== undefined &&
    Number(current.defaultDinnerPortions || 0) !== Number(next.defaultDinnerPortions || 0)
  ) {
    changedFields.push(fieldLabel('defaultDinnerPortions'));
  }
  if (
    update.weeknightCookingStyle !== undefined &&
    String(current.weeknightCookingStyle || '') !== String(next.weeknightCookingStyle || '')
  ) {
    changedFields.push(fieldLabel('weeknightCookingStyle'));
  }
  if (
    update.assistantName !== undefined &&
    String(current.assistantName || '') !== String(next.assistantName || '')
  ) {
    changedFields.push(fieldLabel('assistantName'));
  }
  if (
    update.assistantTone !== undefined &&
    String(current.assistantTone || '') !== String(next.assistantTone || '')
  ) {
    changedFields.push(fieldLabel('assistantTone'));
  }

  const outcome = {
    capability: 'household.defaults.update',
    status: changedFields.length > 0 ? 'updated' : 'unchanged',
    changedFields,
    defaults: next,
  };
  outcome.reply = buildDefaultsOutcomeReply(outcome);

  if (!runtimeManagedResponse) {
    if (!userMessageAlreadyPersisted) {
      await deps.addMessage?.(chatId, req.householdId, 'user', name, prompt);
    }
    await deps.addMessage?.(chatId, req.householdId, 'assistant', 'KitchenBot', outcome.reply);
    deps.broadcastToChat?.(chatId, {
      type: 'chat_updated',
      householdId: req.householdId,
      chatId,
      user: name,
    });
  }

  return outcome;
}
