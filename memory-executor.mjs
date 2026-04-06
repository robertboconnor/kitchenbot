import {
  getMemories,
  getSmartDurableMemoryByTypeAndLabel,
  listSmartDurableMemories,
  saveSmartDurableMemory,
  upsertMemory,
} from './db.mjs';
import {
  mergeMemoryProposalWithExisting,
  normalizeRememberKeyForStorage,
  normalizeRememberValueForStorage,
} from './smart-memory-policy.mjs';
import {
  buildSmartDurableMemoryRecordForStorage,
  formatSmartDurableMemoriesForPrompt,
  inferSmartDurableMemoryRecord,
  mergeSmartDurableMemoryForUpsert,
} from './smart-durable-memory.mjs';

function buildLegacyRememberReply(outcome) {
  if (!outcome || typeof outcome !== 'object') return 'I could not save that to memory.';
  if (outcome.status === 'invalid') return outcome.error || 'I could not save that to memory.';
  if (outcome.status === 'saved' || outcome.status === 'updated') {
    return `Got it. I saved memory ${outcome.key} = ${outcome.storedValue}.`;
  }
  if (outcome.status === 'unchanged') {
    return `No change — ${outcome.key} already includes that.`;
  }
  if (outcome.status === 'skipped') {
    return 'I did not save that to household memory.';
  }
  return 'I could not save that to memory.';
}

function buildMemoryOutcomeReply(outcome) {
  if (!outcome || typeof outcome !== 'object') return 'I could not save that to memory.';
  if (outcome.status === 'invalid') return outcome.error || 'I could not save that to memory.';
  if (outcome.status === 'saved') return `I saved that to memory as ${outcome.key}.`;
  if (outcome.status === 'updated') return `I updated the saved memory for ${outcome.key}.`;
  if (outcome.status === 'unchanged') return `I already had that saved for ${outcome.key}.`;
  if (outcome.status === 'skipped') return 'I did not save that to memory.';
  return 'I could not save that to memory.';
}

function buildLegacyRememberAckFragment(normKey, displayValue) {
  const v = String(displayValue ?? '').trim();
  const nv = v.length > 120 ? v.slice(0, 119) + '…' : v;
  const nk = String(normKey ?? '').trim();
  if (nv && nk) return `I saved that ${nk}: ${nv}.`;
  if (nv) return `I saved that ${nv}.`;
  if (nk) return `I updated memory for ${nk}.`;
  return 'I saved that in memory.';
}

export async function executeMemorySave(runtimeAction, context) {
  const {
    req,
    name,
    chatId,
    prompt,
    memories = [],
    anthropic,
    legacyCommandMode = false,
    skipIncrement = false,
    userMessageAlreadyPersisted = false,
    runtimeManagedResponse = false,
    smartModeEnabled = false,
    deps = {},
  } = context;
  const legacyCommand = !!legacyCommandMode;

  if (!skipIncrement) {
    await deps.incrementUserMessageCountForSender?.(req);
  }

  const keyRaw = runtimeAction?.input?.key;
  const valueRaw = runtimeAction?.input?.value;
  const normKey = normalizeRememberKeyForStorage(keyRaw);
  const newValue = normalizeRememberValueForStorage(valueRaw);

  if (!normKey || !newValue) {
    return {
      capability: 'memory.save',
      status: 'invalid',
      error: 'Memory key and value are required.',
    };
  }

  const existing = Array.isArray(memories) ? memories.find((r) => r.key === normKey) : null;
  let outcome;
  if (smartModeEnabled) {
    const shaped = await inferSmartDurableMemoryRecord({
      anthropic,
      householdId: req.householdId,
      chatId,
      key: normKey,
      value: newValue,
    });
    const record = buildSmartDurableMemoryRecordForStorage(shaped);
    if (!record) {
      outcome = {
        capability: 'memory.save',
        status: 'invalid',
        key: normKey,
        error: 'I could not shape that into Smart durable memory.',
      };
    } else {
      const priorStructured = await getSmartDurableMemoryByTypeAndLabel(
        req.householdId,
        record.memoryType,
        record.normalizedLabel
      );
      if (!priorStructured) {
        await saveSmartDurableMemory(req.householdId, record, {
          sourceKind: 'smart_action',
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
        const mergedStructured = mergeSmartDurableMemoryForUpsert(priorStructured, record);
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
          await saveSmartDurableMemory(req.householdId, mergedStructured, {
            id: priorStructured.id,
            sourceKind: 'smart_action',
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
  } else if (!existing) {
    await upsertMemory(req.householdId, normKey, newValue);
    outcome = {
      capability: 'memory.save',
      status: 'saved',
      key: normKey,
      storedValue: newValue,
      previousValue: null,
    };
  } else {
    const existingValue = String(existing.value ?? '');
    const merged = mergeMemoryProposalWithExisting(existingValue, newValue);
    if (merged === null || merged.trim() === existingValue.trim()) {
      outcome = {
        capability: 'memory.save',
        status: 'unchanged',
        key: normKey,
        storedValue: existingValue,
        previousValue: existingValue,
      };
    } else {
      const mergedStored = normalizeRememberValueForStorage(merged);
      await upsertMemory(req.householdId, normKey, mergedStored);
      outcome = {
        capability: 'memory.save',
        status: 'updated',
        key: normKey,
        storedValue: mergedStored,
        previousValue: existingValue,
      };
    }
  }

  outcome.reply = buildMemoryOutcomeReply(outcome);

  if (!runtimeManagedResponse) {
    if (!userMessageAlreadyPersisted) {
      await deps.addMessage?.(chatId, req.householdId, 'user', name, prompt);
    }
    await deps.addMessage?.(chatId, req.householdId, 'assistant', 'KitchenBot', smartModeEnabled ? outcome.reply : buildLegacyRememberReply(outcome));
    deps.broadcastToChat?.(chatId, {
      type: 'chat_updated',
      householdId: req.householdId,
      chatId,
      user: name,
    });
  }

  if ((outcome.status === 'saved' || outcome.status === 'updated') && legacyCommand) {
    outcome.legacyAckFragment = buildLegacyRememberAckFragment(normKey, outcome.storedValue);
  }

  return outcome;
}

export async function runRememberSharedCommandEffects(params) {
  const {
    req,
    name,
    chatId,
    commandUserTextForPersistence,
    memoryParsed,
    memories,
    anthropic,
    routePrompt,
    legacyCommandMode = false,
    smartModeEnabled = false,
    deps = {},
  } = params;

  let outcome;
  if (memoryParsed?.error) {
    outcome = {
      capability: 'memory.save',
      status: 'invalid',
      error: memoryParsed.error,
    };
    if (!legacyCommandMode) {
      await deps.addMessage?.(chatId, req.householdId, 'user', name, commandUserTextForPersistence);
      await deps.addMessage?.(chatId, req.householdId, 'assistant', 'KitchenBot', memoryParsed.error);
      deps.broadcastToChat?.(chatId, {
        type: 'chat_updated',
        householdId: req.householdId,
        chatId,
        user: name,
      });
    }
  } else {
    outcome = await executeMemorySave(
      { capability: 'memory.save', input: { key: memoryParsed.key, value: memoryParsed.value } },
      {
        req,
        name,
        chatId,
        prompt: commandUserTextForPersistence,
        memories,
        anthropic,
        legacyCommandMode,
        smartModeEnabled,
        deps,
      }
    );
  }

  return {
    reply: buildLegacyRememberReply(outcome),
    legacyRememberAck: outcome?.legacyAckFragment || null,
    outcome,
  };
}
