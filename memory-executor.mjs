import { getChatThreadContext, getMemories, updateChatThreadScene, upsertMemory } from './db.mjs';
import {
  mergeMemoryProposalWithExisting,
  normalizeRememberKeyForStorage,
  normalizeRememberValueForStorage,
} from './smart-memory-policy.mjs';

const THREAD_SCENE_REMEMBER_PREVIEW_MAX = 120;

function threadSceneRememberValuePreview(value) {
  const s = String(value ?? '');
  if (s.length <= THREAD_SCENE_REMEMBER_PREVIEW_MAX) return s;
  return s.slice(0, THREAD_SCENE_REMEMBER_PREVIEW_MAX - 1) + '…';
}

async function safeUpdateThreadScene(chatId, householdId, patch) {
  return updateChatThreadScene(chatId, householdId, patch).catch((e) => {
    console.error('safeUpdateThreadScene failed:', e?.message || e);
  });
}

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

function buildPlannerRememberAckFragment(normKey, displayValue) {
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
    plannerMode = false,
    smartModeEnabled = false,
    deps = {},
  } = context;

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
  if (!existing) {
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

  if ((outcome.status === 'saved' || outcome.status === 'updated') && smartModeEnabled) {
    await safeUpdateThreadScene(chatId, req.householdId, {
      lastAction: 'remember',
      lastRememberKey: normKey,
      lastRememberValuePreview: threadSceneRememberValuePreview(outcome.storedValue),
      lastActionAt: Date.now(),
      openLoop: null,
    });

    try {
      const ctxScene = await getChatThreadContext(chatId, req.householdId);
      const memoriesRefreshed = await getMemories(req.householdId);
      const memCompact = memoriesRefreshed
        .filter((m) => m.key !== 'assistant_name')
        .map((m) => `${m.key}: ${m.value}`)
        .join('\n');
      const conv = await deps.getMessages?.(chatId, req.householdId);
      const conversationForContext = Array.isArray(conv)
        ? conv.filter((m) => m.role !== 'user' || !String(m.content || '').trim().startsWith('!'))
        : [];
      const recentForUpdater =
        conversationForContext.length > 40 ? conversationForContext.slice(-40) : conversationForContext;
      void deps.runThreadSceneAutoUpdaterAfterNormalChat?.(anthropic, {
        smartModeEnabled: true,
        chatId,
        householdId: req.householdId,
        priorThreadScene: ctxScene.threadScene,
        routePrompt: prompt,
        finalAssistantReply: buildLegacyRememberReply(outcome),
        threadMealPlanSummary: ctxScene.mealPlanSummary,
        threadGrocerySummary: ctxScene.threadGrocerySummary,
        householdMemoriesCompact: memCompact,
        recentConversationForContext: recentForUpdater,
        trustedActionSummary: `remember saved key ${normKey}`,
      });
    } catch (e) {
      console.error('thread scene auto-update (remember) setup failed:', e?.message || e);
    }
  }

  if (!plannerMode) {
    await deps.addMessage?.(chatId, req.householdId, 'user', name, prompt);
    await deps.addMessage?.(chatId, req.householdId, 'assistant', 'KitchenBot', buildLegacyRememberReply(outcome));
    deps.broadcastToChat?.(chatId, {
      type: 'chat_updated',
      householdId: req.householdId,
      chatId,
      user: name,
    });
  }

  if ((outcome.status === 'saved' || outcome.status === 'updated') && plannerMode) {
    outcome.plannerAckFragment = buildPlannerRememberAckFragment(normKey, outcome.storedValue);
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
    plannerMode = false,
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
    if (!plannerMode) {
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
        plannerMode,
        smartModeEnabled,
        deps,
      }
    );
  }

  return {
    reply: buildLegacyRememberReply(outcome),
    plannerRememberAck: outcome?.plannerAckFragment || null,
    outcome,
  };
}
