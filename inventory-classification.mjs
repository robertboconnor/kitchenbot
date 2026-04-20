import { createLoggedAnthropicMessage } from './anthropic-usage.mjs';
import { resolveAnthropicModelForCallPurpose } from './anthropic-model-policy.mjs';

export const GROCERY_SECTION_KEYS = new Set(['produce', 'meat', 'dairy', 'frozen', 'dry', 'other']);
export const PANTRY_SECTION_KEYS = new Set([
  'spices_herbs',
  'oils_vinegars',
  'baking',
  'sweeteners',
  'condiments_sauces',
  'pasta_grains_dry_goods',
  'other_pantry',
]);

function safeTrim(text) {
  return String(text ?? '').trim();
}

function normalizeNameKey(name) {
  return safeTrim(name).toLowerCase().replace(/\s+/g, ' ');
}

const INVENTORY_PREP_SUFFIX_PATTERN =
  /\s*,\s*(?:peeled|minced|chopped|diced|roughly chopped|roughly diced|thinly sliced|thinly cut|sliced|halved|quartered|drained|rinsed|softened|melted|seeded|cored|trimmed|crushed|grated|zested|juiced|beaten|room temperature|washed|patted dry)\b.*$/i;

function pluralizeSimple(noun) {
  const base = safeTrim(noun).toLowerCase();
  if (!base) return '';
  if (base.endsWith('s')) return base;
  return `${base}s`;
}

export function normalizeInventoryItemName(rawName, { target = 'grocery' } = {}) {
  let name = safeTrim(rawName)
    .replace(/^[-*\u2022]+\s*/, '')
    .replace(/\s+/g, ' ');
  if (!name) return '';

  name = name
    .replace(INVENTORY_PREP_SUFFIX_PATTERN, '')
    .replace(/\s+(?:for serving|to serve|plus more|plus extra|divided|optional)\b.*$/i, '')
    .replace(/^(?:small|medium|large|extra-large|extra large)\s+/i, '')
    .replace(/\bgarlic cloves?\b/i, 'garlic')
    .replace(/\bcelery stalks?\b/i, 'celery')
    .replace(/\b(white|yellow|red|sweet) onions?\b/i, '$1 onion')
    .replace(/^onions?$/i, 'onion')
    .replace(/\s+/g, ' ')
    .replace(/^[,;:\-]+\s*/, '')
    .replace(/\s*[,;:\-]+\s*$/, '')
    .trim();

  const freshCitrusJuiceMatch = name.match(/^(?:fresh|freshly[-\s]+squeezed)\s+(lemon|lime|orange|grapefruit)\s+juice$/i);
  if (freshCitrusJuiceMatch && target === 'grocery') {
    return pluralizeSimple(freshCitrusJuiceMatch[1]);
  }

  return name;
}

function normalizeBooleanLike(raw) {
  if (raw === true || raw === 1 || raw === '1') return true;
  if (typeof raw === 'string') {
    const value = safeTrim(raw).toLowerCase();
    if (value === 'true' || value === 'yes') return true;
    if (value === 'false' || value === 'no') return false;
  }
  return false;
}

function parseJson(raw, fallback) {
  let text = safeTrim(raw);
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)```$/im);
  if (fenced) text = safeTrim(fenced[1]);
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function normalizeExplicitSection(target, rawSection) {
  const section = safeTrim(rawSection).toLowerCase();
  if (!section) return null;
  const validKeys = target === 'pantry' ? PANTRY_SECTION_KEYS : GROCERY_SECTION_KEYS;
  return validKeys.has(section) ? section : null;
}

function inferPantrySectionFallback(rawName) {
  const name = normalizeNameKey(rawName);
  if (!name) return 'other_pantry';

  if (
    /\b(salt|pepper|white pepper|black pepper|thyme|oregano|rosemary|basil|parsley|sage|cumin|coriander|turmeric|paprika|smoked paprika|cardamom|sumac|chili powder|ancho|chipotle|cayenne|garlic powder|onion powder|red pepper flakes|bay leaf|seasoning|spice blend|spices|herbs)\b/.test(
      name
    )
  ) {
    return 'spices_herbs';
  }
  if (
    /\b(oil|olive oil|vegetable oil|canola oil|sesame oil|vinegar|soy sauce|fish sauce|tamari|mirin|worcestershire)\b/.test(
      name
    )
  ) {
    return 'oils_vinegars';
  }
  if (
    /\b(flour|bread flour|ap flour|all purpose flour|self rising flour|baking soda|baking powder|yeast|cocoa powder|cornstarch)\b/.test(
      name
    )
  ) {
    return 'baking';
  }
  if (/\b(sugar|brown sugar|white sugar|honey|molasses|maple syrup|agave|corn syrup)\b/.test(name)) {
    return 'sweeteners';
  }
  if (
    /\b(ketchup|mustard|dijon|honey mustard|yellow mustard|mayo|mayonnaise|hot sauce|barbecue sauce|bbq sauce|salsa|relish)\b/.test(
      name
    )
  ) {
    return 'condiments_sauces';
  }
  if (
    /\b(spaghetti|pasta|rotini|penne|rigatoni|fusilli|farfalle|macaroni|orzo|rice|bean|beans|lentil|lentils|oat|oats|breadcrumb|breadcrumbs|quinoa|couscous|noodle|noodles|farro|barley|polenta)\b/.test(
      name
    )
  ) {
    return 'pasta_grains_dry_goods';
  }

  return 'other_pantry';
}

function mapPantrySectionToGroceryFallback(rawSection) {
  const section = safeTrim(rawSection).toLowerCase();
  if (['spices_herbs', 'baking', 'sweeteners', 'pasta_grains_dry_goods'].includes(section)) return 'dry';
  return 'other';
}

function inferProbablyPantryFallbackFromName(rawName) {
  const pantrySection = inferPantrySectionFallback(rawName);
  return ['spices_herbs', 'oils_vinegars', 'baking', 'sweeteners', 'pasta_grains_dry_goods'].includes(pantrySection);
}

function inferGrocerySectionFallback(rawName, sourceSection = '', sourceListType = '', rawAmount = '') {
  const name = normalizeNameKey(rawName);
  const amount = normalizeNameKey(rawAmount);
  if (!name) return 'other';

  if (
    /\b(stock|broth|bouillon|base)\b/.test(name) ||
    (/\b(artichoke hearts?|tomatoes?|beans?|chiles?|chilies)\b/.test(name) && /\b(jars?|cans?|boxes?|cartons?)\b/.test(amount))
  ) {
    return 'dry';
  }

  if (
    /\b(dried|ground|smoked)\s+(thyme|oregano|rosemary|basil|parsley|sage|cumin|coriander|turmeric|paprika|cardamom|sumac)\b/.test(
      name
    ) ||
    /\b(chili powder|red pepper flakes|garlic powder|onion powder|bay leaves?|bay leaf|spice blend|spices)\b/.test(name)
  ) {
    return 'dry';
  }

  if (
    /\b(chicken|thighs|breast|drumstick|turkey|beef|steak|ground beef|ground turkey|pork|chop|bacon|sausage|lamb|fish|salmon|cod|shrimp|tuna)\b/.test(
      name
    )
  ) {
    return 'meat';
  }
  if (
    /\b(milk|cream|cheese|yogurt|butter|egg|eggs|labneh|tofu|sour cream|cottage cheese)\b/.test(name)
  ) {
    return 'dairy';
  }
  if (
    /\b(frozen|ice cream|sorbet)\b/.test(name)
  ) {
    return 'frozen';
  }
  if (
    /\b(apple|apples|spinach|lettuce|greens|broccoli|asparagus|celery|parsley|thyme|cilantro|lemon|lemons|lime|limes|garlic|onion|onions|potato|potatoes|carrot|carrots|pepper|peppers|tomato|tomatoes|cucumber|zucchini|mushroom|mushrooms|herb|herbs)\b/.test(
      name
    )
  ) {
    return 'produce';
  }
  if (
    /\b(pasta|rotini|penne|rigatoni|spaghetti|rice|bean|beans|lentil|lentils|oat|oats|flour|sugar|salt|paprika|cumin|vinegar|oil|soy sauce|fish sauce|mustard|ketchup|breadcrumbs|quinoa|couscous|polenta|cornstarch|baking soda|baking powder|canned)\b/.test(
      name
    )
  ) {
    return 'dry';
  }

  if (safeTrim(sourceListType).toLowerCase() === 'pantry') {
    return mapPantrySectionToGroceryFallback(sourceSection);
  }

  return 'other';
}

function inferInventorySectionFallback({ target, name, amount = '', sourceSection = '', sourceListType = '' }) {
  if (target === 'pantry') return inferPantrySectionFallback(name);
  return inferGrocerySectionFallback(name, sourceSection, sourceListType, amount);
}

function allowedSectionKeys(target) {
  return target === 'pantry' ? [...PANTRY_SECTION_KEYS] : [...GROCERY_SECTION_KEYS];
}

async function classifyAutoSections({
  target,
  unresolved,
  anthropic,
  householdId = null,
  chatId = null,
  runtimeEnabled = false,
  callSurface = 'background',
}) {
  if (!anthropic || !Array.isArray(unresolved) || unresolved.length === 0) return new Map();
  const allowed = allowedSectionKeys(target);
  try {
    const response = await createLoggedAnthropicMessage(
      anthropic,
      {
        model: resolveAnthropicModelForCallPurpose('inventory_section_classification'),
        max_tokens: 250,
        system: `You classify household inventory items into one fixed section taxonomy.

Target taxonomy: ${target}
Allowed section keys: ${allowed.join(', ')}

Rules:
- Return ONLY JSON.
- Shape for pantry: {"items":[{"index":0,"section":"allowed_key"}]}
- Shape for grocery: {"items":[{"index":0,"section":"allowed_key","probablyPantryItem":true|false}]}
- Choose exactly one allowed section key for each item index.
- Use the item name as the primary signal.
- Use amount, sourceSection, and sourceListType only as secondary hints.
- For grocery items, set probablyPantryItem to true only when the item is usually something households keep on hand in Pantry:
  spices, herbs, flours, baking items, oils, vinegars, sweeteners, pasta, grains, beans, lentils, or similar dry goods.
- For grocery items, set probablyPantryItem to false for things that are usually refrigerated.
- If unsure, choose the best allowed section instead of inventing a new one.`,
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              target,
              allowedSectionKeys: allowed,
              items: unresolved.map((entry) => ({
                index: entry.index,
                name: entry.name,
                amount: entry.amount,
                sourceSection: entry.sourceSection,
                sourceListType: entry.sourceListType,
              })),
            }),
          },
        ],
      },
      {
        householdId,
        chatId,
        runtimeEnabled,
        callSurface,
        callPurpose: 'inventory_section_classification',
        webSearchEnabledAtCall: false,
        usedWebSearchTool: false,
      }
    );

    const raw = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
    const parsed = parseJson(raw, null);
    const rows = Array.isArray(parsed?.items) ? parsed.items : [];
    const out = new Map();
    for (const row of rows) {
      const index = Number(row?.index);
      const section = normalizeExplicitSection(target, row?.section);
      if (!Number.isInteger(index) || !section) continue;
      out.set(index, {
        section,
        probablyPantryItem: target === 'grocery' ? normalizeBooleanLike(row?.probablyPantryItem) : false,
      });
    }
    return out;
  } catch {
    return new Map();
  }
}

export function mapPantrySectionToGrocerySection(rawSection) {
  return mapPantrySectionToGroceryFallback(rawSection);
}

export function normalizePantrySection(rawSection, rawName = '') {
  return normalizeExplicitSection('pantry', rawSection) || inferPantrySectionFallback(rawName);
}

export function normalizeGrocerySection(rawSection, rawName = '', sourceSection = '', sourceListType = '') {
  return normalizeExplicitSection('grocery', rawSection) || inferGrocerySectionFallback(rawName, sourceSection, sourceListType);
}

export async function resolveInventoryItems({
  target,
  items,
  anthropic = null,
  householdId = null,
  chatId = null,
  runtimeEnabled = false,
  callSurface = 'background',
}) {
  const normalizedTarget = safeTrim(target).toLowerCase();
  if (normalizedTarget !== 'grocery' && normalizedTarget !== 'pantry') return [];

  const rows = Array.isArray(items) ? items : [];
  const cleaned = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const name = normalizeInventoryItemName(raw.name, { target: normalizedTarget });
    if (!name) continue;
    const amount = safeTrim(raw.amount);
    const sourceSection = safeTrim(raw.sourceSection || raw.section);
    const sourceListType = safeTrim(raw.sourceListType);
    const explicitSection = normalizeExplicitSection(normalizedTarget, raw.section);
    const inheritedProbablyPantryItem = raw?.probablyPantryItem === true;
    cleaned.push({
      name,
      amount,
      sourceSection,
      sourceListType,
      explicitSection,
      inheritedProbablyPantryItem,
    });
  }

  const unresolved = cleaned
    .map((item, index) => ({ ...item, index }))
    .filter((item) => !item.explicitSection);
  const classified = await classifyAutoSections({
    target: normalizedTarget,
    unresolved,
    anthropic,
    householdId,
    chatId,
    runtimeEnabled,
    callSurface,
  });

  return cleaned.map((item, index) => {
    const classifiedRow = classified.get(index);
    const section =
      item.explicitSection ||
      classifiedRow?.section ||
      inferInventorySectionFallback({
        target: normalizedTarget,
        name: item.name,
        amount: item.amount,
        sourceSection: item.sourceSection,
        sourceListType: item.sourceListType,
      });
    const resolved = {
      name: item.name,
      section,
      amount: item.amount,
    };
    if (normalizedTarget === 'grocery') {
      const refrigerated = /\b(milk|cream|cheese|yogurt|butter|egg|eggs|labneh|tofu|sour cream|cottage cheese|cream cheese|kefir)\b/.test(
        normalizeNameKey(item.name)
      );
      let probablyPantryItem = false;
      if (item.inheritedProbablyPantryItem || item.sourceListType.toLowerCase() === 'pantry') {
        probablyPantryItem = true;
      } else if (!refrigerated) {
        probablyPantryItem =
          classifiedRow?.probablyPantryItem === true ||
          inferProbablyPantryFallbackFromName(item.name);
      }
      resolved.probablyPantryItem = probablyPantryItem;
    }
    return resolved;
  });
}
