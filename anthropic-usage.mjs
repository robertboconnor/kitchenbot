import { insertAnthropicUsageLedgerRow } from './db.mjs';

const MODEL_PRICING_USD_PER_MILLION = {
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
      callSurface: String(context.callSurface ?? 'background'),
      callPurpose: String(context.callPurpose ?? 'unknown'),
      model: String(response?.model ?? context.model ?? 'unknown'),
      requestKind: String(context.requestKind ?? 'create'),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      webSearchEnabledAtCall: !!context.webSearchEnabledAtCall,
      usedWebSearchTool: !!context.usedWebSearchTool,
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
