import { getKbMemoryByTypeAndLabel, saveKbMemory } from './db.mjs';
import {
  buildMemoryRecordForStorage,
  mergeMemoryRecord,
  resolveMemoryRecordDeterministic,
} from './kb-memory-store.mjs';

function buildMemoryOutcomeReply(outcome) {
  if (!outcome || typeof outcome !== 'object') return 'I could not save that to memory.';
  if (outcome.status === 'invalid') return outcome.error || 'I could not save that to memory.';
  const label = String(outcome.label ?? '').trim();
  const isPerson = outcome.memoryType === 'person' && label;
  const isHousehold = outcome.memoryType === 'household_note';
  if (outcome.status === 'saved') {
    if (isPerson) return `I saved that for ${label}.`;
    if (isHousehold) return 'I saved that to household memory.';
    return 'I saved that to memory.';
  }
  if (outcome.status === 'updated') {
    if (isPerson) return `I updated what I know about ${label}.`;
    if (isHousehold) return 'I updated the household memory for that.';
    return 'I updated that memory.';
  }
  if (outcome.status === 'unchanged') {
    if (isPerson) return `I already had that saved for ${label}.`;
    if (isHousehold) return 'I already had that in household memory.';
    return 'I already had that saved.';
  }
  if (outcome.status === 'skipped') return 'I did not save that to memory.';
  return 'I could not save that to memory.';
}

export async function executeMemorySave(runtimeAction, context) {
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

  // ONE BRAIN: the brain decides scope (person vs household) + who; we build the record
  // deterministically from what it passed. No side-model shaping, no side-model "scope"
  // decision. A value is required; a person name is what makes it a person memory.
  const input =
    runtimeAction?.input && typeof runtimeAction.input === 'object' && !Array.isArray(runtimeAction.input)
      ? runtimeAction.input
      : {};
  const record = buildMemoryRecordForStorage(
    resolveMemoryRecordDeterministic({
      scope: input.scope,
      person: input.person,
      value: input.value,
      key: input.key,
    })
  );

  let outcome;
  if (!record) {
    outcome = {
      capability: 'memory.save',
      status: 'invalid',
      error: 'A value to remember is required (and a person name for a person-scoped memory).',
    };
  } else {
    const prior = await getKbMemoryByTypeAndLabel(req.householdId, record.memoryType, record.normalizedLabel);
    if (!prior) {
      await saveKbMemory(req.householdId, record, { sourceKind: 'kb_action', sourceChatId: chatId });
      outcome = {
        capability: 'memory.save',
        status: 'saved',
        storedValue: record.summary,
        previousValue: null,
        memoryType: record.memoryType,
        label: record.label,
      };
    } else {
      const merged = mergeMemoryRecord(prior, record);
      if ((merged.summary || '').trim() === String(prior.summary ?? '').trim()) {
        outcome = {
          capability: 'memory.save',
          status: 'unchanged',
          storedValue: String(prior.summary ?? ''),
          previousValue: String(prior.summary ?? ''),
          memoryType: merged.memoryType,
          label: merged.label,
        };
      } else {
        await saveKbMemory(req.householdId, merged, { id: prior.id, sourceKind: 'kb_action', sourceChatId: chatId });
        outcome = {
          capability: 'memory.save',
          status: 'updated',
          storedValue: merged.summary,
          previousValue: String(prior.summary ?? ''),
          memoryType: merged.memoryType,
          label: merged.label,
        };
      }
    }
  }

  outcome.reply = buildMemoryOutcomeReply(outcome);

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
