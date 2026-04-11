import { resolveInventoryItems } from './inventory-classification.mjs';

function normalizePostedInventoryRows(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .filter((raw) => raw && typeof raw === 'object')
    .map((raw) => ({
      name: String(raw.name ?? '').trim(),
      section: String(raw.section ?? '').trim().toLowerCase(),
      amount: raw.amount != null && String(raw.amount).trim() !== '' ? String(raw.amount).trim() : '',
      sourceSection: String(raw.sourceSection ?? '').trim().toLowerCase(),
      sourceListType: String(raw.sourceListType ?? '').trim().toLowerCase(),
    }))
    .filter((item) => item.name);
}

export async function resolveInventoryItemsForHousehold({
  target,
  householdId,
  chatId = null,
  items,
  callSurface = 'chat',
  runtimeEnabled = false,
  getAnthropicClient,
}) {
  let anthropic = null;
  try {
    anthropic = (await getAnthropicClient(householdId)).client;
  } catch {
    anthropic = null;
  }
  return await resolveInventoryItems({
    target,
    items,
    anthropic,
    householdId,
    chatId,
    callSurface,
    runtimeEnabled,
  });
}

export async function normalizeGroceryItemsForPost(rawItems, opts = {}) {
  const items = normalizePostedInventoryRows(rawItems);
  return await resolveInventoryItemsForHousehold({
    target: 'grocery',
    householdId: opts.householdId,
    chatId: opts.chatId ?? null,
    items,
    callSurface: opts.callSurface || 'chat',
    runtimeEnabled: !!opts.runtimeEnabled,
    getAnthropicClient: opts.getAnthropicClient,
  });
}

export async function normalizePantryItemsForPost(rawItems, opts = {}) {
  const items = normalizePostedInventoryRows(rawItems);
  return await resolveInventoryItemsForHousehold({
    target: 'pantry',
    householdId: opts.householdId,
    chatId: opts.chatId ?? null,
    items,
    callSurface: opts.callSurface || 'chat',
    runtimeEnabled: !!opts.runtimeEnabled,
    getAnthropicClient: opts.getAnthropicClient,
  });
}

export function normalizeInventoryNameKey(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export async function mergeGroceryItemsFromAi({
  householdId,
  parsedItems,
  sourceChatId,
  getGroceryItems,
  updateGroceryItemAmount,
  backfillGroceryItemSourceChatIfSafe,
  addGroceryItems,
}) {
  const empty = { insertedCount: 0, updatedCount: 0, backfilledCount: 0, changedCount: 0 };
  if (!parsedItems.length) return empty;
  let insertedCount = 0;
  let updatedCount = 0;
  let backfilledCount = 0;
  const existing = await getGroceryItems(householdId);
  const byKey = new Map();
  for (const e of existing) {
    if (!e.checked) {
      const k = `${e.section}::${normalizeInventoryNameKey(e.name)}`;
      byKey.set(k, e);
    }
  }
  const toInsert = [];
  const pendingByKey = new Map();
  for (const item of parsedItems) {
    const nameDisp = String(item.name).trim();
    if (!nameDisp) continue;
    const section = item.section;
    const newAmt = String(item.amount ?? '').trim();
    const k = `${section}::${normalizeInventoryNameKey(nameDisp)}`;
    if (byKey.has(k)) {
      const match = byKey.get(k);
      if (Number.isFinite(Number(sourceChatId))) {
        try {
          const n = await backfillGroceryItemSourceChatIfSafe(householdId, match.id, sourceChatId);
          backfilledCount += Number(n) || 0;
        } catch {}
      }
      const oldAmt = String(match.amount ?? '').trim();
      if (newAmt !== '' && newAmt !== oldAmt) {
        try {
          await updateGroceryItemAmount(householdId, match.id, newAmt);
          updatedCount += 1;
          match.amount = newAmt;
        } catch {}
      }
    } else if (pendingByKey.has(k)) {
      const pend = pendingByKey.get(k);
      if (newAmt !== '' && newAmt !== String(pend.amount ?? '').trim()) {
        pend.amount = newAmt;
      }
    } else {
      const row = { name: nameDisp, section, amount: newAmt };
      toInsert.push(row);
      pendingByKey.set(k, row);
    }
  }
  if (toInsert.length) {
    await addGroceryItems(householdId, toInsert, {
      sourceChatId: Number.isFinite(Number(sourceChatId)) ? Number(sourceChatId) : null,
    });
    insertedCount = toInsert.length;
  }
  const changedCount = insertedCount + updatedCount;
  return { insertedCount, updatedCount, backfilledCount, changedCount };
}

export function createInventoryServices({
  getAnthropicClient,
  getGroceryItems,
  updateGroceryItemAmount,
  backfillGroceryItemSourceChatIfSafe,
  addGroceryItems,
}) {
  return {
    normalizeGroceryItemsForPost: (rawItems, opts = {}) =>
      normalizeGroceryItemsForPost(rawItems, { ...opts, getAnthropicClient }),
    normalizePantryItemsForPost: (rawItems, opts = {}) =>
      normalizePantryItemsForPost(rawItems, { ...opts, getAnthropicClient }),
    mergeGroceryItemsFromAi: (householdId, parsedItems, sourceChatId) =>
      mergeGroceryItemsFromAi({
        householdId,
        parsedItems,
        sourceChatId,
        getGroceryItems,
        updateGroceryItemAmount,
        backfillGroceryItemSourceChatIfSafe,
        addGroceryItems,
      }),
    normalizeInventoryNameKey,
  };
}
