import crypto from 'crypto';
import { insertAnthropicUsageLedgerRow } from './db.mjs';

const MODEL_PRICING_USD_PER_MILLION = {
  'claude-sonnet-5': { input: 3, output: 15, cacheCreation: 3.75, cacheRead: 0.3 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheCreation: 3.75, cacheRead: 0.3 },
  'claude-3-7-sonnet-latest': { input: 3, output: 15, cacheCreation: 3.75, cacheRead: 0.3 },
  'claude-3-5-sonnet-latest': { input: 3, output: 15, cacheCreation: 3.75, cacheRead: 0.3 },
  'claude-3-5-haiku-latest': { input: 0.8, output: 4, cacheCreation: 1, cacheRead: 0.08 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheCreation: 1.25, cacheRead: 0.1 },
};

function normalizeAnthropicModelForPricing(rawModel) {
  const model = String(rawModel ?? '').trim();
  if (!model) return '';
  if (MODEL_PRICING_USD_PER_MILLION[model]) return model;

  if (/^claude-sonnet-5-\d{8}$/.test(model)) return 'claude-sonnet-5';
  if (/^claude-sonnet-4-5-\d{8}$/.test(model)) return 'claude-sonnet-4-5';
  if (/^claude-3-7-sonnet-\d{8}$/.test(model)) return 'claude-3-7-sonnet-latest';
  if (/^claude-3-5-sonnet-\d{8}$/.test(model)) return 'claude-3-5-sonnet-latest';
  if (/^claude-3-5-haiku-\d{8}$/.test(model)) return 'claude-3-5-haiku-latest';
  if (/^claude-haiku-4-5-\d{8}$/.test(model)) return 'claude-haiku-4-5-20251001';

  return '';
}

function asNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeTrim(text) {
  return String(text ?? '').trim();
}

function normalizePromptExcerpt(rawPrompt) {
  const text = safeTrim(rawPrompt).replace(/\s+/g, ' ');
  if (!text) return '';
  return text.slice(0, 180);
}

function hashPrompt(rawPrompt) {
  const text = safeTrim(rawPrompt);
  if (!text) return '';
  return crypto.createHash('sha256').update(text).digest('hex');
}

function normalizeActionQuery(rawQuery) {
  const text = safeTrim(rawQuery).replace(/\s+/g, ' ');
  return text ? text.slice(0, 240) : '';
}

export function classifyAnthropicUsageFunction(callPurpose) {
  const purpose = String(callPurpose ?? '').trim();
  if (!purpose) return 'Other';
  if (purpose === 'chat_reply') return 'Conversation replies';
  if (purpose.startsWith('kb_turn_interpretation') || purpose.startsWith('kb_turn_grounding')) return 'Turn interpretation';
  if (purpose === 'kb_working_context') return 'Context loading';
  if (purpose === 'meal_refine' || purpose === 'kb_memory_shape') {
    return 'Meal planning / refinement';
  }
  if (purpose.startsWith('grocery_draft_generation')) return 'Grocery drafting';
  if (purpose === 'inventory_section_classification') return 'Inventory classification';
  if (purpose === 'recipe_import_image_structure' || purpose === 'recipe_import_url_structure') {
    return 'Recipe importing';
  }
  if (purpose === 'web_search') return 'Web search';
  if (purpose === 'web_fetch') return 'Web fetch';
  if (purpose === 'chat_title') return 'Chat titles';
  return 'Other';
}

function compareUsageGroups(a, b) {
  const aCost = a.estimatedCostKnownCallCount > 0 ? Number(a.estimatedCostUsd ?? 0) : -1;
  const bCost = b.estimatedCostKnownCallCount > 0 ? Number(b.estimatedCostUsd ?? 0) : -1;
  if (bCost !== aCost) return bCost - aCost;
  if (b.inputTokens !== a.inputTokens) return b.inputTokens - a.inputTokens;
  return b.callCount - a.callCount;
}

export function buildAnthropicUsageReport(rows) {
  const totals = {
    callCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    estimatedCostUsd: 0,
    estimatedCostAvailable: true,
    estimatedCostPartial: false,
    estimatedCostKnownCallCount: 0,
    estimatedCostUnknownCallCount: 0,
  };

  const byHousehold = new Map();
  const byPurpose = new Map();
  const byFunction = new Map();
  const byWebSearchEnabled = new Map();
  const byWebSearchUsage = new Map();

  function bump(map, key, row, costUsd) {
    const k = String(key);
    if (!map.has(k)) {
      map.set(k, {
        key: k,
        callCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        estimatedCostUsd: 0,
        estimatedCostAvailable: true,
        estimatedCostPartial: false,
        estimatedCostKnownCallCount: 0,
        estimatedCostUnknownCallCount: 0,
      });
    }
    const entry = map.get(k);
    entry.callCount += 1;
    entry.inputTokens += Number(row.input_tokens ?? 0) || 0;
    entry.outputTokens += Number(row.output_tokens ?? 0) || 0;
    entry.cacheCreationInputTokens += Number(row.cache_creation_input_tokens ?? 0) || 0;
    entry.cacheReadInputTokens += Number(row.cache_read_input_tokens ?? 0) || 0;
    if (costUsd == null) {
      entry.estimatedCostUnknownCallCount += 1;
    } else {
      entry.estimatedCostKnownCallCount += 1;
      entry.estimatedCostUsd += costUsd;
    }
    entry.estimatedCostAvailable = entry.estimatedCostKnownCallCount > 0;
    entry.estimatedCostPartial = entry.estimatedCostUnknownCallCount > 0;
  }

  for (const row of rows) {
    totals.callCount += 1;
    totals.inputTokens += Number(row.input_tokens ?? 0) || 0;
    totals.outputTokens += Number(row.output_tokens ?? 0) || 0;
    totals.cacheCreationInputTokens += Number(row.cache_creation_input_tokens ?? 0) || 0;
    totals.cacheReadInputTokens += Number(row.cache_read_input_tokens ?? 0) || 0;
    const costUsd = estimateAnthropicLedgerCostUsd(row);
    if (costUsd == null) {
      totals.estimatedCostUnknownCallCount += 1;
    } else {
      totals.estimatedCostKnownCallCount += 1;
      totals.estimatedCostUsd += costUsd;
    }
    totals.estimatedCostAvailable = totals.estimatedCostKnownCallCount > 0;
    totals.estimatedCostPartial = totals.estimatedCostUnknownCallCount > 0;
    bump(byHousehold, row.household_id, row, costUsd);
    bump(byPurpose, row.call_purpose, row, costUsd);
    bump(byFunction, classifyAnthropicUsageFunction(row.call_purpose), row, costUsd);
    bump(
      byWebSearchEnabled,
      Number(row.web_search_enabled_at_call) === 1 ? 'enabled' : 'disabled',
      row,
      costUsd
    );
    bump(
      byWebSearchUsage,
      Number(row.used_web_search_tool) === 1 ? 'used' : 'not_used',
      row,
      costUsd
    );
  }

  function finalizeGroups(map) {
    return Array.from(map.values()).sort(compareUsageGroups);
  }

  return {
    totals,
    byHousehold: finalizeGroups(byHousehold),
    byPurpose: finalizeGroups(byPurpose),
    byFunction: finalizeGroups(byFunction),
    byWebSearchEnabled: finalizeGroups(byWebSearchEnabled),
    byWebSearchUsage: finalizeGroups(byWebSearchUsage),
  };
}

export function detectAnthropicWebSearchUsage(response) {
  const count = Number(response?.usage?.server_tool_use?.web_search_requests ?? 0);
  if (Number.isFinite(count) && count > 0) return true;
  return (Array.isArray(response?.content) ? response.content : []).some((block) => {
    const type = String(block?.type ?? '').trim();
    if (type === 'web_search_tool_result') return true;
    if (type === 'server_tool_use' && String(block?.name ?? '').trim() === 'web_search') return true;
    return false;
  });
}

export function detectAnthropicWebFetchUsage(response) {
  return (Array.isArray(response?.content) ? response.content : []).some((block) => {
    const type = String(block?.type ?? '').trim();
    if (type === 'web_fetch_tool_result') return true;
    if (type === 'server_tool_use' && String(block?.name ?? '').trim() === 'web_fetch') return true;
    return false;
  });
}

export function extractAnthropicUsageFields(response) {
  const usage = response?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = asNumberOrNull(usage.input_tokens);
  const outputTokens = asNumberOrNull(usage.output_tokens);
  const cacheCreationInputTokens = asNumberOrNull(usage.cache_creation_input_tokens);
  const cacheReadInputTokens = asNumberOrNull(usage.cache_read_input_tokens);

  if (
    inputTokens == null &&
    outputTokens == null &&
    cacheCreationInputTokens == null &&
    cacheReadInputTokens == null
  ) {
    return null;
  }

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheCreationInputTokens,
    cacheReadInputTokens,
  };
}

export function estimateAnthropicLedgerCostUsd(row) {
  const normalizedModel = normalizeAnthropicModelForPricing(row?.model);
  const pricing = MODEL_PRICING_USD_PER_MILLION[normalizedModel];
  if (!pricing) return null;
  const inputTokens = Number(row?.input_tokens ?? row?.inputTokens ?? 0) || 0;
  const outputTokens = Number(row?.output_tokens ?? row?.outputTokens ?? 0) || 0;
  const cacheCreationInputTokens = Number(
    row?.cache_creation_input_tokens ?? row?.cacheCreationInputTokens ?? 0
  ) || 0;
  const cacheReadInputTokens = Number(
    row?.cache_read_input_tokens ?? row?.cacheReadInputTokens ?? 0
  ) || 0;

  return (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output +
    (cacheCreationInputTokens / 1_000_000) * pricing.cacheCreation +
    (cacheReadInputTokens / 1_000_000) * pricing.cacheRead
  );
}

export async function recordAnthropicUsageFromResponse(response, context = {}) {
  const usage = extractAnthropicUsageFields(response);
  if (!usage) return false;
  const householdId = Number(context.householdId);
  if (!Number.isFinite(householdId)) return false;

  try {
    await insertAnthropicUsageLedgerRow({
      householdId,
      chatId: context.chatId != null ? Number(context.chatId) : null,
      runtimeEnabled: context.runtimeEnabled !== false,
      turnId: safeTrim(context.turnId) || null,
      actionCapability: safeTrim(context.actionCapability) || null,
      actionQuery: normalizeActionQuery(context.actionQuery) || null,
      promptHash: hashPrompt(context.prompt) || null,
      promptExcerpt: normalizePromptExcerpt(context.prompt) || null,
      callSurface: String(context.callSurface ?? 'background'),
      callPurpose: String(context.callPurpose ?? 'unknown'),
      model: String(response?.model ?? context.model ?? 'unknown'),
      requestKind: String(context.requestKind ?? 'create'),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      webSearchEnabledAtCall: !!context.webSearchEnabledAtCall,
      usedWebSearchTool:
        context.usedWebSearchTool == null
          ? detectAnthropicWebSearchUsage(response)
          : !!context.usedWebSearchTool,
    });
    return true;
  } catch (e) {
    console.error('Anthropic usage ledger write failed:', e?.message || e);
    return false;
  }
}

export async function createLoggedAnthropicMessage(anthropic, params, context = {}) {
  const response = await anthropic.messages.create(params);
  await recordAnthropicUsageFromResponse(response, {
    ...context,
    requestKind: 'create',
    model: params?.model,
  });
  return response;
}

export async function finalizeLoggedAnthropicStream(stream, context = {}) {
  if (!stream || typeof stream.finalMessage !== 'function') return null;
  try {
    const finalMessage = await stream.finalMessage();
    await recordAnthropicUsageFromResponse(finalMessage, {
      ...context,
      requestKind: 'stream',
    });
    return finalMessage;
  } catch (e) {
    console.error('Anthropic stream usage finalization failed:', e?.message || e);
    return null;
  }
}
