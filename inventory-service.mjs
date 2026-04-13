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
      probablyPantryItem: raw.probablyPantryItem === true,
    }))
    .filter((item) => item.name);
}

const CORE_PANTRY_SECTION_KEYS = new Set([
  'spices_herbs',
  'oils_vinegars',
  'baking',
  'sweeteners',
  'pasta_grains_dry_goods',
]);

function normalizeNameKey(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function inferCorePantrySectionFromName(rawName) {
  const name = normalizeNameKey(rawName);
  if (!name) return '';
  if (
    /\b(salt|pepper|thyme|oregano|rosemary|basil|parsley|sage|cumin|coriander|turmeric|paprika|smoked paprika|chili powder|ancho|chipotle|cayenne|garlic powder|onion powder|red pepper flakes|bay leaf|seasoning)\b/.test(
      name
    )
  ) return 'spices_herbs';
  if (
    /\b(oil|olive oil|vegetable oil|canola oil|sesame oil|vinegar|soy sauce|fish sauce|tamari|mirin|worcestershire)\b/.test(
      name
    )
  ) return 'oils_vinegars';
  if (
    /\b(flour|bread flour|ap flour|all purpose flour|self rising flour|baking soda|baking powder|yeast|cocoa powder|cornstarch)\b/.test(
      name
    )
  ) return 'baking';
  if (/\b(sugar|brown sugar|white sugar|honey|molasses|maple syrup|agave|corn syrup)\b/.test(name)) {
    return 'sweeteners';
  }
  if (
    /\b(spaghetti|pasta|rotini|penne|rigatoni|fusilli|farfalle|macaroni|orzo|rice|bean|beans|lentil|lentils|oat|oats|breadcrumb|breadcrumbs|quinoa|couscous|noodle|noodles|farro|barley|polenta|canned)\b/.test(
      name
    )
  ) return 'pasta_grains_dry_goods';
  return '';
}

function isUsuallyRefrigeratedName(rawName) {
  const name = normalizeNameKey(rawName);
  if (!name) return false;
  return /\b(milk|cream|cheese|yogurt|butter|egg|eggs|labneh|tofu|sour cream|cottage cheese|kefir)\b/.test(name);
}

export function inferProbablyPantryItem({
  name = '',
  section = '',
  sourceSection = '',
  sourceListType = '',
  probablyPantryItem = false,
} = {}) {
  if (probablyPantryItem === true) return true;
  if (String(sourceListType ?? '').trim().toLowerCase() === 'pantry') return true;
  if (String(section ?? '').trim().toLowerCase() !== 'dry') return false;
  if (isUsuallyRefrigeratedName(name)) return false;
  const inferredSection = inferCorePantrySectionFromName(name);
  if (CORE_PANTRY_SECTION_KEYS.has(inferredSection)) return true;
  return CORE_PANTRY_SECTION_KEYS.has(String(sourceSection ?? '').trim().toLowerCase());
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
  const resolved = await resolveInventoryItemsForHousehold({
    target: 'grocery',
    householdId: opts.householdId,
    chatId: opts.chatId ?? null,
    items,
    callSurface: opts.callSurface || 'chat',
    runtimeEnabled: !!opts.runtimeEnabled,
    getAnthropicClient: opts.getAnthropicClient,
  });
  return resolved.map((item, index) => ({
    ...item,
    probablyPantryItem:
      item?.probablyPantryItem === true ||
      inferProbablyPantryItem({
        ...item,
        sourceSection: items[index]?.sourceSection,
        sourceListType: items[index]?.sourceListType,
        probablyPantryItem: items[index]?.probablyPantryItem,
      }),
  }));
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
  updateGroceryItemProbablyPantry,
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
      const matchProbablyPantry = match.probablyPantryItem === true || Number(match.probably_pantry_item) === 1;
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
      if (!matchProbablyPantry && item.probablyPantryItem) {
        try {
          await updateGroceryItemProbablyPantry(householdId, match.id, true);
          match.probablyPantryItem = true;
        } catch {}
      }
    } else if (pendingByKey.has(k)) {
      const pend = pendingByKey.get(k);
      if (newAmt !== '' && newAmt !== String(pend.amount ?? '').trim()) {
        pend.amount = newAmt;
      }
      if (item.probablyPantryItem) {
        pend.probablyPantryItem = true;
      }
    } else {
      const row = { name: nameDisp, section, amount: newAmt, probablyPantryItem: !!item.probablyPantryItem };
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
  updateGroceryItemProbablyPantry,
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
        updateGroceryItemProbablyPantry,
        backfillGroceryItemSourceChatIfSafe,
        addGroceryItems,
      }),
    normalizeInventoryNameKey,
  };
}
