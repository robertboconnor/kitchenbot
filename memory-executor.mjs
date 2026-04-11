import { getKbMemoryByTypeAndLabel, saveKbMemory } from './db.mjs';
import {
  mergeMemoryProposal,
  normalizeMemoryKey,
  normalizeMemoryValue,
} from './kb-memory-policy.mjs';
import {
  buildMemoryRecordForStorage,
  inferMemoryRecord,
  mergeMemoryRecord,
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
    memories = [],
    anthropic,
    skipIncrement = false,
    userMessageAlreadyPersisted = false,
    runtimeManagedResponse = false,
    kbModeEnabled = false,
    deps = {},
  } = context;

  if (!skipIncrement) {
    await deps.incrementUserMessageCountForSender?.(req);
  }

  const keyRaw = runtimeAction?.input?.key;
  const valueRaw = runtimeAction?.input?.value;
  const normKey = normalizeMemoryKey(keyRaw);
  const newValue = normalizeMemoryValue(valueRaw);

  if (!normKey || !newValue) {
    return {
      capability: 'memory.save',
      status: 'invalid',
      error: 'Memory key and value are required.',
    };
  }

  const existing = Array.isArray(memories) ? memories.find((r) => r.key === normKey) : null;
  let outcome;
  if (kbModeEnabled) {
    const shaped = await inferMemoryRecord({
      anthropic,
      householdId: req.householdId,
      chatId,
      key: normKey,
      value: newValue,
    });
    const record = buildMemoryRecordForStorage(shaped);
    if (!record) {
      outcome = {
        capability: 'memory.save',
        status: 'invalid',
        key: normKey,
        error: 'I could not shape that into KitchenBot memory.',
      };
    } else {
      const priorStructured = await getKbMemoryByTypeAndLabel(
        req.householdId,
        record.memoryType,
        record.normalizedLabel
      );
      if (!priorStructured) {
        await saveKbMemory(req.householdId, record, {
          sourceKind: 'kb_action',
          sourceChatId: chatId,
        });
        outcome = {
          capability: 'memory.save',
          status: 'saved',
          key: normKey,
          storedValue: record.summary,
          previousValue: null,
          memoryType: record.memoryType,
          label: record.label,
        };
      } else {
        const mergedStructured = mergeMemoryRecord(priorStructured, record);
        if ((mergedStructured.summary || '').trim() === String(priorStructured.summary ?? '').trim()) {
          outcome = {
            capability: 'memory.save',
            status: 'unchanged',
            key: normKey,
            storedValue: String(priorStructured.summary ?? ''),
            previousValue: String(priorStructured.summary ?? ''),
            memoryType: mergedStructured.memoryType,
            label: mergedStructured.label,
          };
        } else {
          await saveKbMemory(req.householdId, mergedStructured, {
            id: priorStructured.id,
            sourceKind: 'kb_action',
            sourceChatId: chatId,
          });
          outcome = {
            capability: 'memory.save',
            status: 'updated',
            key: normKey,
            storedValue: mergedStructured.summary,
            previousValue: String(priorStructured.summary ?? ''),
            memoryType: mergedStructured.memoryType,
            label: mergedStructured.label,
          };
        }
      }
    }
  } else {
    const existingValue = String(existing?.value ?? '');
    const merged = mergeMemoryProposal(existingValue, newValue);
    if (merged === null || merged.trim() === existingValue.trim()) {
      outcome = {
        capability: 'memory.save',
        status: existingValue ? 'unchanged' : 'invalid',
        key: normKey,
        storedValue: existingValue,
        previousValue: existingValue,
        error: existingValue ? undefined : 'Memory key and value are required.',
      };
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
