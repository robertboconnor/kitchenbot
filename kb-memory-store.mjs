import {
  getGroceryItems,
  getHouseholdDefaults,
  getPantryItems,
  listCookbookEntries,
  listHouseholdUsers,
  listPersonProfiles,
} from './db.mjs';
import {
  buildAppliedCookbookText,
  formatCookbookEntriesText,
  selectRelevantCookbookEntries,
} from './cookbook-store.mjs';
import { normalizePantrySection } from './inventory-classification.mjs';
import { getAssistantPersonaSettings } from './kb-persona.mjs';

// NOTE: KitchenBot deliberately has NO freeform "memory" store. The two durable stores
// are structured and user-visible: household_defaults (portions, cooking style, the
// assistant's name/tone) and person_profiles (per-person foods + allergies). This module
// builds the always-on context packet from those, plus live pantry/grocery/cookbook state.
// There is intentionally no household_note / freeform kb_memories path for the brain to
// read or write — it was removed so nothing invisible can drift or be picked by accident.

function normalizeLabel(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
}

function normalizeSummary(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 500);
}

function uniqueTextList(values) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = normalizeSummary(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function formatHouseholdDefaultsText(defaults = {}) {
  const portions =
    defaults.defaultDinnerPortions == null || !Number.isFinite(Number(defaults.defaultDinnerPortions))
      ? null
      : Number(defaults.defaultDinnerPortions);
  const style = normalizeLabel(defaults.weeknightCookingStyle || '');
  const lines = [];
  if (portions) lines.push(`default dinner portions: ${portions}`);
  if (style) lines.push(`cooking style: ${style.toLowerCase()}`);
  return lines.length > 0 ? lines.join('\n') : '(none)';
}

function safePantryName(name) {
  return String(name ?? '').trim().replace(/\s+/g, ' ');
}

function safeGroceryName(name) {
  return String(name ?? '').trim().replace(/\s+/g, ' ');
}

function formatPantryItemsText(items = []) {
  const names = uniqueTextList((Array.isArray(items) ? items : []).map((item) => safePantryName(item?.name)));
  return names.length > 0 ? `pantry items: ${names.join(', ')}` : '(none)';
}

function grocerySectionLabel(section) {
  const key = String(section ?? '').trim().toLowerCase();
  if (key === 'dry') return 'dry goods';
  if (key) return key;
  return 'other';
}

function formatGroceryItemsText(items = [], maxItems = 18) {
  const activeItems = (Array.isArray(items) ? items : []).filter((item) => !item?.checked);
  if (activeItems.length === 0) return '(none)';
  const grouped = new Map();
  for (const item of activeItems.slice(0, maxItems)) {
    const section = grocerySectionLabel(item?.section);
    const name = safeGroceryName(item?.name);
    const amount = String(item?.amount ?? '').trim();
    if (!name) continue;
    const line = amount ? `${name} (${amount})` : name;
    if (!grouped.has(section)) grouped.set(section, []);
    grouped.get(section).push(line);
  }
  const lines = [];
  for (const [section, entries] of grouped.entries()) {
    lines.push(`${section}: ${entries.join(', ')}`);
  }
  if (activeItems.length > maxItems) {
    lines.push(`and ${activeItems.length - maxItems} more unchecked items`);
  }
  return lines.length > 0 ? `current grocery list: ${lines.join(' | ')}` : '(none)';
}

function buildAppliedGroceryText(items = []) {
  const activeItems = (Array.isArray(items) ? items : []).filter((item) => !item?.checked);
  if (activeItems.length === 0) return '(none)';
  const names = uniqueTextList(activeItems.map((item) => safeGroceryName(item?.name))).slice(0, 20);
  const lines = [
    'Treat these as the current live Grocery List tab items for this household:',
    `- ${names.join(', ')}`,
    'If the user asks what is on the grocery list or whether something is already there, answer from this state instead of saying you cannot see it.',
  ];
  if (activeItems.length > names.length) {
    lines[1] += `, and ${activeItems.length - names.length} more`;
  }
  return lines.join('\n');
}

function buildGroceryPantryOverlapText(groceryItems = [], pantryItems = []) {
  const pantryNames = new Set(uniqueTextList((Array.isArray(pantryItems) ? pantryItems : []).map((item) => safePantryName(item?.name).toLowerCase())));
  const overlap = [];
  const pantryLike = [];
  for (const item of Array.isArray(groceryItems) ? groceryItems : []) {
    if (item?.checked) continue;
    const name = safeGroceryName(item?.name);
    const key = name.toLowerCase();
    if (!name) continue;
    if (pantryNames.has(key)) overlap.push(name);
    const inferredPantrySection = normalizePantrySection('', name);
    if (inferredPantrySection !== 'other_pantry') pantryLike.push(name);
  }
  const uniqueOverlap = uniqueTextList(overlap);
  const uniquePantryLike = uniqueTextList(pantryLike);
  if (uniqueOverlap.length === 0 && uniquePantryLike.length === 0) return '(none)';
  const lines = [];
  if (uniqueOverlap.length > 0) {
    lines.push(`Items already in both Pantry and Grocery List: ${uniqueOverlap.join(', ')}`);
  }
  if (uniquePantryLike.length > 0) {
    lines.push(`Pantry-like items currently on the Grocery List: ${uniquePantryLike.join(', ')}`);
  }
  return lines.join('\n');
}

function buildAppliedDefaultsText(defaults = {}) {
  const portions =
    defaults.defaultDinnerPortions == null || !Number.isFinite(Number(defaults.defaultDinnerPortions))
      ? null
      : Number(defaults.defaultDinnerPortions);
  const style = normalizeLabel(defaults.weeknightCookingStyle || '');
  const lines = ['Use these household defaults as stronger operating assumptions when relevant:'];
  if (portions) {
    lines.push(`- Default dinner portions: ${portions}`);
  }
  if (style) {
    lines.push(`- Cooking style: ${style.toLowerCase()}`);
  }
  if (lines.length === 1) return '(none)';
  lines.push('If the current turn touches groceries, meal sizing, or weeknight cooking decisions, apply these defaults naturally.');
  return lines.join('\n');
}

function buildAppliedPantryText(items = []) {
  const names = uniqueTextList((Array.isArray(items) ? items : []).map((item) => safePantryName(item?.name)));
  if (names.length === 0) return '(none)';
  return [
    'Treat these pantry items as already on hand unless the conversation clearly says you need more of them:',
    `- ${names.join(', ')}`,
  ].join('\n');
}

// ALWAYS-INCLUDED household roster + food profiles. Every member appears on every turn —
// names, allergies (hard constraints), and a few likes/dislikes — so the brain can reason
// about Elle and Bizzy, not just whoever is typing. Sourced from household_users (logins)
// and the structured person_profiles store.
function normalizePersonNameKey(raw) {
  return String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildHouseholdPeopleText(householdUsers = [], personProfiles = []) {
  const names = new Map(); // key -> display name (first seen wins)
  const remember = (raw) => {
    const display = String(raw ?? '').trim();
    const key = normalizePersonNameKey(display);
    if (display && key && !names.has(key)) names.set(key, display);
  };
  for (const u of Array.isArray(householdUsers) ? householdUsers : []) remember(u?.display_name ?? u?.displayName);
  for (const p of Array.isArray(personProfiles) ? personProfiles : []) remember(p?.person);
  if (names.size === 0) return '';

  const profileByKey = new Map(
    (Array.isArray(personProfiles) ? personProfiles : []).map((p) => [normalizePersonNameKey(p?.person), p])
  );

  const lines = [];
  for (const [key, name] of names) {
    const parts = [];
    const prof = profileByKey.get(key);
    if (prof) {
      if (prof.allergies?.length) parts.push(`ALLERGIC to ${prof.allergies.join(', ')}`);
      if (prof.acceptedFoods?.length) parts.push(`likes ${prof.acceptedFoods.slice(0, 4).join(', ')}`);
      if (prof.rejectedFoods?.length) parts.push(`won't eat ${prof.rejectedFoods.slice(0, 4).join(', ')}`);
      if (prof.notes?.length) parts.push(prof.notes.slice(0, 1).join('; '));
    }
    lines.push(parts.length ? `- ${name} — ${parts.join('; ')}` : `- ${name}`);
  }
  return lines.join('\n');
}

export async function buildKbContextPacket(householdId, prompt = '', opts = {}) {
  const householdUsers = await listHouseholdUsers(householdId).catch(() => []);
  const personProfiles = await listPersonProfiles(householdId).catch(() => []);
  const includeDefaults = opts.includeDefaults !== false;
  const includePantry = opts.includePantry !== false;
  const includeGrocery = opts.includeGrocery !== false;
  const includeCookbook = opts.includeCookbook === true;
  const capabilities =
    opts.capabilities && typeof opts.capabilities === 'object' && !Array.isArray(opts.capabilities)
      ? {
          webSearchEnabled: !!opts.capabilities.webSearchEnabled,
        }
      : {
          webSearchEnabled: false,
        };
  let pantryItems = [];
  let pantryContextStatus = includePantry ? 'unavailable' : 'not_requested';
  if (includePantry) {
    try {
      pantryItems = await getPantryItems(householdId);
      pantryContextStatus = pantryItems.length > 0 ? 'available' : 'empty';
    } catch {
      pantryItems = [];
      pantryContextStatus = 'unavailable';
    }
  }
  const groceryItems = includeGrocery ? await getGroceryItems(householdId).catch(() => []) : [];
  const cookbookEntries = includeCookbook ? await listCookbookEntries(householdId).catch(() => []) : [];
  const fullHouseholdDefaults = await getHouseholdDefaults(householdId).catch(() => ({
    defaultDinnerPortions: null,
    weeknightCookingStyle: null,
    assistantName: 'KitchenBot',
    assistantTone: 'concise',
  }));
  const assistantPersona = getAssistantPersonaSettings(fullHouseholdDefaults);
  const householdDefaults = includeDefaults
    ? {
        defaultDinnerPortions: fullHouseholdDefaults.defaultDinnerPortions,
        weeknightCookingStyle: fullHouseholdDefaults.weeknightCookingStyle,
      }
    : {
        defaultDinnerPortions: null,
        weeknightCookingStyle: null,
      };
  const selectedCookbookEntries = includeCookbook
    ? selectRelevantCookbookEntries(cookbookEntries, prompt, Number.isFinite(opts.cookbookLimit) ? Number(opts.cookbookLimit) : 8)
    : [];
  return {
    householdUsers,
    personProfiles,
    householdPeopleText: buildHouseholdPeopleText(householdUsers, personProfiles),
    pantryItems,
    pantryContextStatus,
    pantryContextAvailable: pantryContextStatus === 'available' || pantryContextStatus === 'empty',
    pantryItemCount: pantryItems.length,
    groceryItems,
    cookbookEntries,
    selectedCookbookEntries,
    capabilities,
    householdDefaults,
    assistantPersona,
    defaultsText: formatHouseholdDefaultsText(householdDefaults),
    appliedDefaultsText: buildAppliedDefaultsText(householdDefaults),
    pantryText: formatPantryItemsText(pantryItems),
    appliedPantryText: buildAppliedPantryText(pantryItems),
    groceryText: formatGroceryItemsText(groceryItems),
    appliedGroceryText: buildAppliedGroceryText(groceryItems),
    cookbookText: formatCookbookEntriesText(selectedCookbookEntries),
    appliedCookbookText: buildAppliedCookbookText(selectedCookbookEntries),
    groceryPantryOverlapText:
      includeGrocery && includePantry ? buildGroceryPantryOverlapText(groceryItems, pantryItems) : '(none)',
  };
}
