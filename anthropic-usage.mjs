import { insertAnthropicUsageLedgerRow } from './db.mjs';

const MODEL_PRICING_USD_PER_MILLION = {
  'claude-sonnet-4-5': { input: 3, output: 15, cacheCreation: 3.75, cacheRead: 0.3 },
  'claude-3-7-sonnet-latest': { input: 3, output: 15, cacheCreation: 3.75, cacheRead: 0.3 },
  'claude-3-5-sonnet-latest': { input: 3, output: 15, cacheCreation: 3.75, cacheRead: 0.3 },
};

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
  const pricing = MODEL_PRICING_USD_PER_MILLION[String(row?.model ?? '').trim()];
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
      smartModeEnabled: !!context.smartModeEnabled,
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
