import { createLoggedAnthropicMessage } from './anthropic-usage.mjs';
import { resolveAnthropicModelForCallPurpose } from './anthropic-model-policy.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

export const COOKBOOK_CATEGORY_OPTIONS = [
  { value: 'soups', label: 'Soups' },
  { value: 'sauces', label: 'Sauces' },
  { value: 'pasta', label: 'Pasta' },
  { value: 'lunch_dishes', label: 'Lunch Dishes' },
  { value: 'fish', label: 'Fish' },
  { value: 'poultry', label: 'Poultry' },
  { value: 'meat', label: 'Meat' },
  { value: 'vegetables', label: 'Vegetables' },
  { value: 'dessert_cakes', label: 'Dessert & Cakes' },
];

const COOKBOOK_CATEGORY_VALUES = new Set(COOKBOOK_CATEGORY_OPTIONS.map((option) => option.value));

function toTitleCase(text) {
  return safeTrim(text)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function extractFirstUrl(raw) {
  const match = String(raw ?? '').match(/https?:\/\/[^\s)]+/i);
  return match ? safeTrim(match[0]) : '';
}

export function extractPreferredCookbookLabel(raw, url = '') {
  const text = safeTrim(raw).replace(url || '', '').replace(/\s+/g, ' ').trim();
  if (!text) return '';

  const quotedMatch =
    text.match(/\bas\s+["“]([^"”]+)["”]/i) ||
    text.match(/\bas\s+'([^']+)'/i);
  if (quotedMatch) return normalizeCookbookTitle(quotedMatch[1]);

  const aliasMatch = text.match(
    /\bas\s+(.+?)(?:\s+\b(?:in|into|to)\b\s+(?:our\s+)?(?:cookbook|recipes?)\b|\s*$)/i
  );
  if (aliasMatch) {
    const normalized = normalizeCookbookTitle(
      aliasMatch[1]
        .replace(/\b(?:please|following|recipe|dish|meal idea|meal)\b/gi, ' ')
        .replace(/[:]+/g, ' ')
        .replace(/["“”'`]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    );
    const key = normalizeCookbookTitleKey(normalized);
    if (!key || /^[^a-z0-9]*$/.test(normalized)) return '';
    return normalized;
  }

  const stripped = text
    .replace(/\bplease\b/gi, ' ')
    .replace(/\b(save|add|put|store|bookmark)\b/gi, ' ')
    .replace(/\b(this|that|the)\b/gi, ' ')
    .replace(/\b(recipe|dish|meal idea|meal|following|recipes)\b/gi, ' ')
    .replace(/\b(to|into|in)\b/gi, ' ')
    .replace(/\bour\b/gi, ' ')
    .replace(/\bcookbook\b/gi, ' ')
    .replace(/\bas\b/gi, ' ')
    .replace(/[:]+/g, ' ')
    .replace(/["“”'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const normalized = normalizeCookbookTitle(stripped);
  const key = normalizeCookbookTitleKey(normalized);
  if (!key || /^[^a-z0-9]*$/.test(normalized) || key === 'our' || key === 'recipes' || key === 'our recipes') return '';
  return normalized;
}

export function normalizeCookbookTitle(raw) {
  return safeTrim(raw).replace(/\s+/g, ' ').slice(0, 160);
}

export function normalizeCookbookTitleKey(raw) {
  return normalizeCookbookTitle(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeRecipeFailureText(text) {
  const lowered = safeTrim(text).toLowerCase();
  if (!lowered) return false;
  return (
    /\b(recipe unavailable|unable to fetch|could not fetch|could not access|could not read enough|failed to fetch)\b/.test(lowered) ||
    /\b(user may need to manually add|fetch failed)\b/.test(lowered)
  );
}

export function looksLikeRecipeText(raw) {
  const text = String(raw ?? '');
  if (!text.trim()) return false;
  const lines = text.split('\n').map((line) => safeTrim(line)).filter(Boolean);
  if (lines.length < 6) return false;
  const joined = lines.join('\n').toLowerCase();
  const hasSectionHeaders =
    /(^|\n)(?:[*#\s-]*)ingredients?\s*:?(?:\n|$)/i.test(joined) &&
    /(^|\n)(?:[*#\s-]*)(?:instructions?|directions?|method)\s*:?(?:\n|$)/i.test(joined);
  const ingredientishLines = lines.filter((line) =>
    /^(\d+\/?\d*|\d+\.\d+|one|two|three|four|five|six|seven|eight|nine|ten|pinch|salt|pepper)\b/i.test(line)
  ).length;
  return hasSectionHeaders || ingredientishLines >= 5;
}

export function extractManualCookbookRecipePayload(raw, { sourceUrl = '' } = {}) {
  const text = String(raw ?? '');
  const lines = text.split('\n');
  const nonEmptyLines = lines.map((line) => safeTrim(line)).filter(Boolean);
  if (nonEmptyLines.length === 0) return { requestedCookbookTitle: '', recipeBodyText: '', sourceUrl: normalizeCookbookUrl(sourceUrl) };

  const firstLine = nonEmptyLines[0];
  const hasSaveInstruction = /\b(save|add|store|bookmark)\b/i.test(firstLine) && /\b(cookbook|recipes?|recipe|dish|meal)\b/i.test(firstLine);
  const requestedCookbookTitle = extractPreferredCookbookLabel(firstLine, sourceUrl);

  let recipeBodyText = text;
  if (hasSaveInstruction && nonEmptyLines.length > 1) {
    const firstNonEmptyIndex = lines.findIndex((line) => safeTrim(line));
    let bodyStartIndex = firstNonEmptyIndex + 1;
    while (bodyStartIndex < lines.length && !safeTrim(lines[bodyStartIndex])) bodyStartIndex += 1;
    recipeBodyText = lines.slice(bodyStartIndex).join('\n').trim();
  }

  return {
    requestedCookbookTitle,
    recipeBodyText: recipeBodyText.trim(),
    sourceUrl: normalizeCookbookUrl(sourceUrl),
  };
}

function normalizeCookbookSummary(raw) {
  return safeTrim(raw).replace(/\s+/g, ' ').slice(0, 600);
}

function normalizeCookbookUrl(raw) {
  const value = safeTrim(raw).slice(0, 1000);
  return /^https?:\/\//i.test(value) ? value : '';
}

function stripCookbookMarkdown(raw) {
  return safeTrim(raw)
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[(.*?)\]\((https?:\/\/[^)]+)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeCookbookSourceTitle(raw, { title = '' } = {}) {
  const text = normalizeCookbookTitle(stripCookbookMarkdown(raw));
  if (!text) return '';
  const lowered = text.toLowerCase();
  if (
    lowered.startsWith("here's the full recipe for ") ||
    lowered.startsWith('here is the full recipe for ') ||
    lowered.startsWith('full recipe for ') ||
    lowered === 'saved recipe'
  ) {
    return '';
  }
  if (normalizeCookbookTitleKey(text) === normalizeCookbookTitleKey(title)) return text;
  return text;
}

function sanitizeCookbookDisplayTitle(raw) {
  let text = normalizeCookbookTitle(stripCookbookMarkdown(raw));
  if (!text) return '';
  text = text
    .replace(/^#{1,6}\s*/i, '')
    .replace(/^here'?s the (?:full )?recipe for\s+/i, '')
    .replace(/^here is the (?:full )?recipe for\s+/i, '')
    .replace(/^full recipe for\s+/i, '')
    .replace(/^the recipe for\s+/i, '')
    .replace(/^recipe for\s+/i, '')
    .replace(/\s*[:\-–—]+\s*$/g, '')
    .trim();
  return normalizeCookbookTitle(text);
}

export function getCookbookDisplayTitle(raw) {
  const entry = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return sanitizeCookbookDisplayTitle(entry.title) || normalizeCookbookTitle(entry.title || 'Saved recipe');
}

export function getCookbookDisplaySource(raw) {
  const entry = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const title = getCookbookDisplayTitle(entry);
  const sourceUrl = normalizeCookbookUrl(entry.sourceUrl);
  const sourceTitle = sanitizeCookbookSourceTitle(entry.sourceTitle, { title });
  if (!sourceTitle && !sourceUrl) return null;
  return {
    label: sourceTitle || sourceUrl,
    url: sourceUrl || '',
  };
}

function normalizeCookbookType(raw) {
  const value = safeTrim(raw).toLowerCase();
  return ['saved_recipe', 'meal_idea', 'web_recipe'].includes(value) ? value : 'meal_idea';
}

export function normalizeCookbookCategory(raw) {
  const value = safeTrim(raw).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return COOKBOOK_CATEGORY_VALUES.has(value) ? value : '';
}

export function getCookbookCategoryLabel(category) {
  const normalized = normalizeCookbookCategory(category);
  if (!normalized) return 'Uncategorized';
  return COOKBOOK_CATEGORY_OPTIONS.find((option) => option.value === normalized)?.label || 'Uncategorized';
}

function normalizeStringList(values, limit = 12, maxLength = 180) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = safeTrim(value).replace(/\s+/g, ' ').slice(0, maxLength);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeNotesList(values, limit = 20, maxLength = 220) {
  if (Array.isArray(values)) return normalizeStringList(values, limit, maxLength);
  const text = safeTrim(values);
  if (!text) return [];
  return normalizeStringList(text.split(/\s+\|\s+|\n+/), limit, maxLength);
}

function flattenNotesText(values) {
  return normalizeNotesList(values, 20, 220).join(' | ');
}

function singularizeCookbookNoun(word) {
  const text = safeTrim(word).toLowerCase();
  if (text.endsWith('ies') && text.length > 4) return text.slice(0, -3) + 'y';
  if (text.endsWith('oes') && text.length > 4) return text.slice(0, -2);
  if (text.endsWith('s') && !text.endsWith('ss') && text.length > 3) return text.slice(0, -1);
  return text;
}

function looksLikeStapleIngredient(text) {
  return [
    'salt',
    'pepper',
    'water',
    'oil',
    'olive oil',
    'vegetable oil',
    'canola oil',
    'butter',
    'garlic',
    'onion',
    'flour',
    'sugar',
    'brown sugar',
    'powdered sugar',
    'egg',
    'eggs',
    'milk',
    'stock',
    'broth',
    'pasta water',
  ].includes(text);
}

function extractCookbookIngredientEssence(line) {
  const cleaned = safeTrim(line)
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/^[\d/.\s]+/, ' ')
    .replace(/\b(?:cups?|cup|tablespoons?|tbsp|teaspoons?|tsp|ounces?|ounce|oz|pounds?|pound|lb|cloves?|clove|cans?|can|packages?|package|sticks?|stick|pinch|dash)\b/g, ' ')
    .replace(/\b(?:fresh|dried|large|small|medium|extra|virgin|whole|plain|unsalted|salted|minced|chopped|diced|crumbled|shredded|grated|softened|removed|seeded|peeled|thinly|sliced|plus|more|for|to|taste|optional)\b/g, ' ')
    .replace(/[^a-z0-9&\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const phrase = cleaned
    .split(' ')
    .filter(Boolean)
    .slice(0, 3)
    .join(' ');
  return phrase && !looksLikeStapleIngredient(phrase) ? phrase : '';
}

function dedupeCookbookTerms(values = [], limit = 3) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const text = safeTrim(value);
    const key = singularizeCookbookNoun(text);
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function inferCookbookDishType(title = '', category = '') {
  const lowered = safeTrim(title).toLowerCase();
  if (/\bpasta\b|\bspaghetti\b|\brigatoni\b|\bpenne\b|\blinguine\b|\borzo\b|\blasagna\b/.test(lowered)) return 'pasta';
  if (/\bstew\b/.test(lowered)) return 'stew';
  if (/\bchili\b/.test(lowered)) return 'chili';
  if (/\bsoup\b/.test(lowered)) return 'soup';
  if (/\bsandwich\b|\bsub\b|\bhero\b|\bhoagie\b|\bmuffaletta\b|\bpanini\b/.test(lowered)) return 'sandwich';
  if (/\bcake\b|\bcookie\b|\bbrownie\b|\btart\b|\bpie\b/.test(lowered)) return 'dessert';
  if (category === 'pasta') return 'pasta';
  if (category === 'soups') return 'soup';
  if (category === 'dessert_cakes') return 'dessert';
  if (category === 'lunch_dishes') return 'lunch dish';
  if (category === 'fish') return 'fish dish';
  if (category === 'poultry') return 'chicken dish';
  if (category === 'meat') return 'meat dish';
  if (category === 'vegetables') return 'vegetable dish';
  return 'dish';
}

function inferCookbookDescriptors(title = '', ingredients = []) {
  const haystack = `${safeTrim(title)} ${normalizeStringList(ingredients, 24, 180).join(' ')}`.toLowerCase();
  const descriptors = [];
  if (/\b(?:miso|mushroom|beef|garlic|parmesan|anchovy|stock|chorizo|bacon)\b/.test(haystack)) descriptors.push('savory');
  if (/\b(?:cream|crema|butter|cheese|yogurt|cotija|brie|ricotta|aioli)\b/.test(haystack)) descriptors.push('rich');
  if (/\b(?:lemon|lime|citrus|vinegar|herb|dill|cilantro|parsley)\b/.test(haystack)) descriptors.push('bright');
  if (/\b(?:smoked|paprika|chorizo|bacon|charred|roasted)\b/.test(haystack)) descriptors.push('smoky');
  if (/\b(?:chili|tajin|pepperoncini|harissa|gochujang|jalapeno|poblano)\b/.test(haystack)) descriptors.push('lively');
  if (/\b(?:stew|chili|braise|bake)\b/.test(haystack)) descriptors.push('comforting');
  return dedupeCookbookTerms(descriptors, 2);
}

function inferCookbookUseCase(title = '', category = '', ingredients = []) {
  const haystack = `${safeTrim(title)} ${normalizeStringList(ingredients, 24, 180).join(' ')}`.toLowerCase();
  if (/\b(?:stew|chili|braise|roast)\b/.test(haystack)) return 'Especially good for a cozy cold-weather dinner or a slow Sunday cook.';
  if (/\b(?:sandwich|sub|hero|hoagie|muffaletta|panini|salad|toast|quiche)\b/.test(haystack) || category === 'lunch_dishes') {
    return 'Especially good for a casual dinner, lunch spread, or having people over.';
  }
  if (/\b(?:cake|dessert|cookie|brownie|tart|pie)\b/.test(haystack) || category === 'dessert_cakes') {
    return 'Especially good for sharing at the table or bringing out as a proper dessert.';
  }
  if (category === 'pasta' || /\bpasta\b|\bskillet\b/.test(haystack)) {
    return 'Especially good for a high-reward weeknight dinner that still feels a little special.';
  }
  return 'Especially good for a dinner that feels polished without being fussy.';
}

function joinCookbookList(values = []) {
  if (values.length === 0) return '';
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values[0]}, ${values[1]}, and ${values[2]}`;
}

function buildSummaryFromParsedRecipe(title, ingredients = [], category = '') {
  const dishType = inferCookbookDishType(title, category);
  const descriptors = inferCookbookDescriptors(title, ingredients);
  const heroes = dedupeCookbookTerms(ingredients.map(extractCookbookIngredientEssence), 3);
  const descriptorText = descriptors.length > 0 ? `${joinCookbookList(descriptors)} ` : '';
  const heroText = heroes.length > 0 ? `built around ${joinCookbookList(heroes)}` : 'with a lot of flavor and texture';
  const useCase = inferCookbookUseCase(title, category, ingredients);
  return normalizeCookbookSummary(`A ${descriptorText}${dishType} ${heroText}. ${useCase}`);
}

function cleanRecipeLine(line) {
  return safeTrim(line)
    .replace(/^[\u2022*\-]+\s*/, '')
    .replace(/^\d+\.\s*/, '')
    .replace(/^\*\*(.+?)\*\*[:\s]*/,'$1: ')
    .replace(/\s+/g, ' ');
}

function normalizeRecipeHeader(line) {
  return safeTrim(line)
    .replace(/^[#*\-\s]+/, '')
    .replace(/[:\s]+$/, '')
    .toLowerCase();
}

export function inferCookbookCategory(raw) {
  const haystack = [
    safeTrim(raw?.title),
    safeTrim(raw?.summary),
    ...(Array.isArray(raw?.tags) ? raw.tags : []),
    ...(Array.isArray(raw?.ingredients) ? raw.ingredients : []),
  ]
    .join(' ')
    .toLowerCase();
  if (!haystack) return '';

  const matches = (patterns) => patterns.some((pattern) => pattern.test(haystack));

  if (matches([/\bsoup\b/, /\bstew\b/, /\bchili\b/, /\bbisque\b/, /\bchowder\b/, /\bbroth\b/])) {
    return 'soups';
  }
  if (matches([/\bpasta\b/, /\bspaghetti\b/, /\brigatoni\b/, /\bpenne\b/, /\bfusilli\b/, /\borzo\b/, /\bmacaroni\b/, /\bravioli\b/, /\blinguine\b/, /\bfettuccine\b/, /\bgnocchi\b/, /\blasagna\b/])) {
    return 'pasta';
  }
  if (matches([/\bsandwich\b/, /\bsub\b/, /\bhero\b/, /\bhoagie\b/, /\bmuffaletta\b/, /\bpanini\b/, /\bsalad\b/, /\bwrap\b/, /\btoast\b/, /\bquiche\b/, /\bfrittata\b/, /\btart\b/])) {
    return 'lunch_dishes';
  }
  if (matches([/\bsauce\b/, /\bgravy\b/, /\bpesto\b/, /\bvinaigrette\b/, /\bdressing\b/, /\baioli\b/, /\bchimichurri\b/])) {
    return 'sauces';
  }
  if (matches([/\bcake\b/, /\bcookie\b/, /\bbrownie\b/, /\btart\b/, /\bpie\b/, /\bcupcake\b/, /\bmuffin\b/, /\bpudding\b/, /\bice cream\b/, /\bdessert\b/])) {
    return 'dessert_cakes';
  }
  if (matches([/\bchicken\b/, /\bturkey\b/, /\bduck\b/, /\bpoultry\b/])) {
    return 'poultry';
  }
  if (matches([/\bfish\b/, /\bsalmon\b/, /\btuna\b/, /\btrout\b/, /\bshrimp\b/, /\bscallop\b/, /\bseafood\b/, /\bhalibut\b/, /\bcod\b/])) {
    return 'fish';
  }
  if (matches([/\bbeef\b/, /\bpork\b/, /\blamb\b/, /\bsausage\b/, /\bmeatball\b/, /\bsteak\b/, /\bveal\b/])) {
    return 'meat';
  }
  if (matches([/\bvegetable\b/, /\bvegetarian\b/, /\basparagus\b/, /\bbroccoli\b/, /\bcauliflower\b/, /\beggplant\b/, /\bmushroom\b/, /\bcarrot\b/, /\bzucchini\b/])) {
    return 'vegetables';
  }
  return '';
}

export function parseCookbookRecipeText(raw, { preferredTitle = '', sourceUrl = '', sourceTitle = '' } = {}) {
  const text = String(raw ?? '');
  if (!looksLikeRecipeText(text)) return null;
  const lines = text.split('\n').map((line) => safeTrim(line));
  const compact = lines.filter(Boolean);
  if (compact.length === 0) return null;

  let title = '';
  let ingredients = [];
  let instructions = [];
  const notes = [];
  let section = 'preamble';

  for (const originalLine of lines) {
    const line = safeTrim(originalLine);
    if (!line) continue;
    const lowered = normalizeRecipeHeader(line);
    if (/^ingredients?$/i.test(lowered)) {
      section = 'ingredients';
      continue;
    }
    if (/^(instructions?|directions?|method)$/i.test(lowered)) {
      section = 'instructions';
      continue;
    }
    if (/^notes?$/i.test(lowered)) {
      section = 'notes';
      continue;
    }
    if (!title && section === 'preamble') {
      if (!/^(jump to recipe|prep|cook|active|total|serves|yield)$/i.test(lowered)) {
        title = line;
        continue;
      }
    }
    if (section === 'ingredients') {
      ingredients.push(cleanRecipeLine(line));
      continue;
    }
    if (section === 'instructions') {
      instructions.push(cleanRecipeLine(line));
      continue;
    }
    if (/^(prep|cook|active|total|serves|yield|special equipment)$/i.test(lowered)) {
      notes.push(line);
      continue;
    }
    if (section === 'preamble' && /^(jump to recipe)$/i.test(lowered)) continue;
    if (section === 'preamble' && /^special equipment$/i.test(lowered)) {
      section = 'notes';
      continue;
    }
    if (section === 'notes') {
      notes.push(cleanRecipeLine(line));
    }
  }

  const parsedTitle = normalizeCookbookTitle(title || 'Saved recipe');
  title = normalizeCookbookTitle(preferredTitle || parsedTitle || 'Saved recipe');
  ingredients = normalizeStringList(ingredients, 40, 220);
  instructions = normalizeStringList(instructions, 24, 320);
  const parsedNotes = normalizeNotesList(notes, 20, 220);

  if (!title || ingredients.length === 0 || instructions.length === 0) return null;
  const tags = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 4)
    .slice(0, 4)
    .map((term) => toTitleCase(term));

  return buildCookbookRecordForStorage({
    title,
    summary: buildSummaryFromParsedRecipe(title, ingredients, inferCookbookCategory({ title, ingredients })),
    recipeType: 'saved_recipe',
    ingredients,
    instructions,
    tags,
    notes: parsedNotes,
    sourceTitle: normalizeCookbookTitle(sourceTitle || (preferredTitle && parsedTitle && preferredTitle !== parsedTitle ? parsedTitle : '')),
    sourceUrl: safeTrim(sourceUrl),
    sourceKind: 'manual',
  });
}

export function getCookbookRecordQuality(raw) {
  const record = buildCookbookRecordForStorage(raw);
  if (!record) return { label: 'meal_idea', rank: 0 };
  const ingredientCount = Array.isArray(record.ingredients) ? record.ingredients.length : 0;
  const instructionCount = Array.isArray(record.instructions) ? record.instructions.length : 0;
  const structuredRecipe = ingredientCount >= 3 && instructionCount >= 2;

  if ((record.sourceKind === 'web_fetch' || record.sourceKind === 'server_fetch') && structuredRecipe && !looksLikeRecipeFailureText(`${record.summary} ${flattenNotesText(record.notes)}`)) {
    return { label: 'fetched_recipe', rank: 4 };
  }
  if (record.sourceKind === 'manual' && structuredRecipe) {
    return { label: 'manual_recipe', rank: 3 };
  }
  if (record.recipeType === 'saved_recipe' && (ingredientCount > 0 || instructionCount > 0)) {
    return { label: 'saved_recipe', rank: 2 };
  }
  return { label: 'meal_idea', rank: 1 };
}

function isStructuredCookbookRecipe(record) {
  const ingredientCount = Array.isArray(record?.ingredients) ? record.ingredients.length : 0;
  const instructionCount = Array.isArray(record?.instructions) ? record.instructions.length : 0;
  return ingredientCount >= 3 && instructionCount >= 2;
}

function hasCookbookExternalSource(record) {
  return (
    !!record?.sourceUrl ||
    record?.sourceKind === 'web_fetch' ||
    record?.sourceKind === 'server_fetch' ||
    (!!record?.sourceTitle && record?.recipeType === 'web_recipe')
  );
}

export function getCookbookDisplayProvenance(raw) {
  const record = buildCookbookRecordForStorage(raw);
  if (!record) return 'Meal idea';
  const structuredRecipe = isStructuredCookbookRecipe(record);
  if (!structuredRecipe) return 'Meal idea';
  if (hasCookbookExternalSource(record)) return 'Source recipe';
  if (record.sourceKind === 'kb_action') return 'KitchenBot generated';
  return 'Saved recipe';
}

export function buildCookbookRecordForStorage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const title = sanitizeCookbookDisplayTitle(raw.title);
  const summary = normalizeCookbookSummary(raw.summary);
  if (!title || !summary) return null;
  const category =
    raw.category === undefined
      ? inferCookbookCategory(raw)
      : normalizeCookbookCategory(raw.category);
  return {
    title,
    normalizedTitle: normalizeCookbookTitleKey(raw.normalizedTitle || title),
    summary,
    category,
    recipeType: normalizeCookbookType(raw.recipeType),
    ingredients: normalizeStringList(raw.ingredients, 24, 180),
    instructions: normalizeStringList(raw.instructions, 16, 240),
    tags: normalizeStringList(raw.tags, 12, 60).map((tag) => tag.toLowerCase()),
    sourceTitle: sanitizeCookbookSourceTitle(raw.sourceTitle, { title }).slice(0, 160),
    sourceUrl: normalizeCookbookUrl(raw.sourceUrl),
    notes: normalizeNotesList(raw.notes, 20, 220),
    sourceKind: safeTrim(raw.sourceKind || 'manual').slice(0, 60) || 'manual',
    sourceChatId: Number.isFinite(Number(raw.sourceChatId)) ? Number(raw.sourceChatId) : null,
    lastUsedAt: raw.lastUsedAt ? String(raw.lastUsedAt) : null,
  };
}

function looksLikeSectionHeader(line) {
  return /^(ingredients?|instructions?|directions?|method|notes?|special equipment|prep|cook|active|total|serves|yield)$/i.test(
    safeTrim(line)
  );
}

function looksLikeIngredientLine(line) {
  const text = safeTrim(line);
  if (!text) return false;
  return /^(\d+\/?\d*|\d+\.\d+|one|two|three|four|five|six|seven|eight|nine|ten|pinch|dash|salt|pepper)\b/i.test(text);
}

function looksLikeInstructionLine(line) {
  const text = safeTrim(line);
  if (!text) return false;
  return /^\d+\./.test(text) || /[.!?]$/.test(text) || /\b(cook|heat|stir|add|simmer|bake|serve|transfer|mix|combine|whisk)\b/i.test(text);
}

function isolateRecipeRegionHeuristically(raw) {
  const lines = String(raw ?? '').split('\n').map((line) => safeTrim(line));
  const nonEmpty = lines.map((line, index) => ({ line, index })).filter((item) => item.line);
  const ingredientHeaderIdx = nonEmpty.findIndex((item) => /^ingredients?$/i.test(item.line));
  const instructionHeaderIdx = nonEmpty.findIndex(
    (item, idx) => idx > ingredientHeaderIdx && /^(instructions?|directions?|method)$/i.test(item.line)
  );
  if (ingredientHeaderIdx === -1 || instructionHeaderIdx === -1) return '';

  let titleIdx = Math.max(0, ingredientHeaderIdx - 1);
  for (let idx = ingredientHeaderIdx - 1; idx >= Math.max(0, ingredientHeaderIdx - 8); idx -= 1) {
    const candidate = nonEmpty[idx]?.line || '';
    if (!candidate) continue;
    if (looksLikeSectionHeader(candidate)) continue;
    titleIdx = idx;
    break;
  }

  let endIdx = nonEmpty.length;
  for (let idx = instructionHeaderIdx + 1; idx < nonEmpty.length; idx += 1) {
    const candidate = nonEmpty[idx]?.line || '';
    if (
      /^(nutrition|related|more from|filed in|read more|comments|author|advertisement)$/i.test(candidate) ||
      (/^[A-Z][A-Za-z\s]{0,40}$/.test(candidate) && !looksLikeInstructionLine(candidate) && !looksLikeIngredientLine(candidate) && !looksLikeSectionHeader(candidate))
    ) {
      endIdx = idx;
      break;
    }
  }

  const region = nonEmpty.slice(titleIdx, endIdx).map((item) => item.line).join('\n').trim();
  return looksLikeRecipeText(region) ? region : '';
}

function parseJsonObject(raw) {
  let text = safeTrim(raw);
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)```$/im);
  if (fenced) text = safeTrim(fenced[1]);
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

export async function shapeCookbookRecordForStorage({
  anthropic,
  householdId,
  chatId,
  prompt = '',
  candidateRecord,
  recentConversation = [],
  latestAssistantText = '',
  memoryContext = null,
  sourceKind = '',
}) {
  const baseRecord = buildCookbookRecordForStorage({
    ...(candidateRecord || {}),
    sourceKind: sourceKind || candidateRecord?.sourceKind || 'manual',
    sourceChatId: Number.isFinite(Number(candidateRecord?.sourceChatId)) ? Number(candidateRecord.sourceChatId) : chatId,
  });
  if (!baseRecord) return null;
  if (!anthropic) return baseRecord;

  try {
    const response = await createLoggedAnthropicMessage(
      anthropic,
      {
        model: resolveAnthropicModelForCallPurpose('cookbook_shape'),
        max_tokens: 260,
        system: `You clean up KitchenBot cookbook entries after the recipe has already been structured.

Return ONLY JSON:
{"title":"...","summary":"...","category":"soups|sauces|pasta|lunch_dishes|fish|poultry|meat|vegetables|dessert_cakes|","tags":["..."],"sourceTitle":"..."}

Rules:
- Work from the structured candidate recipe and source metadata provided.
- Give the entry a clean household-cookbook title, not assistant framing.
- Summary should answer what it is, why it is good, and what it is especially good for.
- Choose the single best cookbook category from the allowed list.
- Tags should be short, useful retrieval tags.
- Preserve the real source identity when it exists.
- Never invent a URL.
- Never use assistant framing like "Here's the recipe for..." as title or sourceTitle.
- If the candidate already has a strong clean source title, keep it clean rather than embellishing it.`,
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              latestPrompt: prompt,
              candidateRecord: baseRecord,
              recentConversation: compactRecentConversation(recentConversation),
              latestAssistantText: safeTrim(latestAssistantText),
              appliedMemory: safeTrim(memoryContext?.applicationText || ''),
              appliedDefaults: safeTrim(memoryContext?.appliedDefaultsText || ''),
            }),
          },
        ],
      },
      {
        householdId,
        chatId,
        runtimeEnabled: true,
        callSurface: 'kb_action',
        callPurpose: 'cookbook_shape',
        webSearchEnabledAtCall: !!memoryContext?.capabilities?.webSearchEnabled,
        usedWebSearchTool: false,
      }
    );
    const text = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
    const shaped = parseJsonObject(text);
    return (
      buildCookbookRecordForStorage({
        ...baseRecord,
        title: shaped?.title || baseRecord.title,
        summary: shaped?.summary || baseRecord.summary,
        category: shaped?.category || baseRecord.category,
        tags: Array.isArray(shaped?.tags) && shaped.tags.length > 0 ? shaped.tags : baseRecord.tags,
        sourceTitle: baseRecord.sourceTitle || shaped?.sourceTitle || '',
        sourceUrl: baseRecord.sourceUrl,
        sourceKind: baseRecord.sourceKind,
        sourceChatId: baseRecord.sourceChatId,
      }) || baseRecord
    );
  } catch (error) {
    console.error('Cookbook final shaping failed:', error?.message || error);
    return baseRecord;
  }
}

function compactRecentConversation(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-12)
    .map((message) => `${message.role === 'user' ? message.name || 'User' : message.name || 'KitchenBot'}: ${safeTrim(message.content)}`)
    .filter(Boolean)
    .join('\n\n');
}

function getImmediateCookbookContextTitle(workingContext = null) {
  return (
    safeTrim(workingContext?.linkedRecipeTitle) ||
    safeTrim(workingContext?.subjectItems?.[0]) ||
    ''
  );
}

export async function inferCookbookRecord({
  anthropic,
  householdId,
  chatId,
  prompt,
  workingContext = null,
  memoryContext = null,
  recentConversation = [],
  latestAssistantText = '',
}) {
  const immediateContextTitle = getImmediateCookbookContextTitle(workingContext);
  const parsedFromText = parseCookbookRecipeText(prompt, {
    preferredTitle: immediateContextTitle,
    sourceUrl: safeTrim(workingContext?.linkedRecipeUrl),
  });
  if (parsedFromText) {
    return buildCookbookRecordForStorage({
      ...parsedFromText,
      sourceKind: 'manual',
      sourceChatId: chatId,
    });
  }

  const parsedFromLatestAssistantRecipe = parseCookbookRecipeText(latestAssistantText, {
    preferredTitle: immediateContextTitle,
    sourceUrl: safeTrim(workingContext?.linkedRecipeUrl),
  });
  if (parsedFromLatestAssistantRecipe) {
    return buildCookbookRecordForStorage({
      ...parsedFromLatestAssistantRecipe,
      sourceKind: 'kb_action',
      sourceChatId: chatId,
    });
  }

  const fallbackTitle =
    immediateContextTitle ||
    safeTrim(workingContext?.mealIdeas?.[0]) ||
    safeTrim(prompt)
      .replace(/^(save|add)\s+(this|that)\s+(recipe|meal idea|idea|dish)\s+(to|in)\s+(our\s+)?cookbook\b/i, '')
      .replace(/^(save|add)\s+/i, '')
      .trim() ||
    'Saved recipe';
  const fallback = buildCookbookRecordForStorage({
    title: fallbackTitle,
    summary:
      safeTrim(workingContext?.topicSummary) ||
      safeTrim(latestAssistantText) ||
      safeTrim(prompt) ||
      'Saved cookbook entry',
    recipeType: safeTrim(latestAssistantText).includes('http') ? 'web_recipe' : 'meal_idea',
    ingredients: Array.isArray(workingContext?.groceryFocus) ? workingContext.groceryFocus : [],
    instructions: [],
    tags: [],
    sourceTitle: '',
    sourceUrl: '',
    notes: [],
    sourceKind: 'kb_action',
    sourceChatId: chatId,
  });
  if (!anthropic) return fallback;

  try {
    const response = await createLoggedAnthropicMessage(
      anthropic,
      {
        model: resolveAnthropicModelForCallPurpose('cookbook_shape'),
        max_tokens: 450,
        system: `You turn a KitchenBot chat moment into one reusable household cookbook entry.

Return ONLY JSON:
{"title":"...","summary":"...","recipeType":"saved_recipe|meal_idea|web_recipe","ingredients":["..."],"instructions":["..."],"tags":["..."],"sourceTitle":"...","sourceUrl":"...","notes":["..."]}

Rules:
- Create one concise reusable recipe or meal idea record.
- Prefer a real dish title when one is clear.
- Use web_recipe when the save comes from outside/web-derived material.
- Write summary like cookbook blurb copy: what the dish is, why it is appealing, and what it is especially good for.
- ingredients should be lightweight grocery-friendly items, not long prose.
- instructions can be short step-like lines when available.
- tags should be compact and useful for later retrieval.
- Keep summary durable and reusable.
- Preserve source title/url when clearly available in the supplied context.
- Never use assistant framing like "Here's the full recipe for..." as sourceTitle.
- Do not invent URLs.
- If the conversation is too vague, still produce the best compact meal_idea record you can from the context.`,
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              latestPrompt: prompt,
              workingContext,
              recentConversation: compactRecentConversation(recentConversation),
              latestAssistantText: safeTrim(latestAssistantText),
              appliedMemory: safeTrim(memoryContext?.applicationText || ''),
              appliedDefaults: safeTrim(memoryContext?.appliedDefaultsText || ''),
            }),
          },
        ],
      },
      {
        householdId,
        chatId,
        runtimeEnabled: true,
        callSurface: 'kb_action',
        callPurpose: 'cookbook_shape',
        webSearchEnabledAtCall: !!memoryContext?.capabilities?.webSearchEnabled,
        usedWebSearchTool: false,
      }
    );
    const text = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
    return buildCookbookRecordForStorage({
      ...fallback,
      ...parseJsonObject(text),
      sourceKind: fallback?.sourceKind || 'kb_action',
      sourceChatId: chatId,
    }) || fallback;
  } catch (error) {
    console.error('Cookbook shaping failed:', error?.message || error);
    return fallback;
  }
}

export async function extractCookbookRecordFromFetchedPage({
  anthropic,
  householdId,
  chatId,
  prompt,
  preferredTitle = '',
  sourceUrl = '',
  sourceTitle = '',
  fetchedPageText = '',
  memoryContext = null,
}) {
  const pageText = safeTrim(fetchedPageText);
  if (!pageText) {
    return {
      status: 'extraction_failed',
      failureReason: 'The linked page was fetched, but there was not enough page content to extract a recipe from it.',
      record: null,
    };
  }

  const heuristicRecipeRegion = isolateRecipeRegionHeuristically(pageText) || pageText;
  const parsedFromText = parseCookbookRecipeText(heuristicRecipeRegion, {
    preferredTitle,
    sourceUrl,
    sourceTitle,
  });
  if (parsedFromText) {
    return {
      status: 'extracted',
      failureReason: '',
      record: buildCookbookRecordForStorage({
        ...parsedFromText,
        sourceTitle: normalizeCookbookTitle(parsedFromText.sourceTitle || sourceTitle),
        sourceUrl: sourceUrl || parsedFromText.sourceUrl || '',
        sourceKind: 'web_fetch',
        sourceChatId: chatId,
      }),
    };
  }

  if (!anthropic) {
    return {
      status: 'extraction_failed',
      failureReason: 'I fetched the page, but I could not reliably extract a full recipe from it.',
      record: null,
    };
  }

  try {
    const isolationResponse = await createLoggedAnthropicMessage(
      anthropic,
      {
        model: resolveAnthropicModelForCallPurpose('cookbook_shape'),
        max_tokens: 700,
        system: `You identify the recipe area within fetched page text for KitchenBot.

Return ONLY JSON:
{"status":"isolated|not_recipe|insufficient_detail","sourceTitle":"...","recipeText":"..."}

Rules:
- Work only from the fetched page text provided.
- Find the smallest contiguous recipe region that contains the actual recipe title, ingredients, instructions, and recipe notes when present.
- Do not summarize or rewrite the recipe here.
- recipeText should be the extracted recipe area as plain text.
- If the page does not clearly contain a usable recipe, return not_recipe or insufficient_detail.`,
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              latestUserPrompt: prompt,
              preferredCookbookTitle: safeTrim(preferredTitle),
              sourceTitle: safeTrim(sourceTitle),
              sourceUrl: safeTrim(sourceUrl),
              fetchedPageText: pageText.slice(0, 24000),
            }),
          },
        ],
      },
      {
        householdId,
        chatId,
        runtimeEnabled: true,
        callSurface: 'kb_action',
        callPurpose: 'cookbook_shape',
        webSearchEnabledAtCall: !!memoryContext?.capabilities?.webSearchEnabled,
        usedWebSearchTool: false,
      }
    );
    const isolationText = isolationResponse.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
    const isolated = parseJsonObject(isolationText);
    const isolatedRecipeText = safeTrim(isolated?.recipeText);
    const extractedSourceTitle = normalizeCookbookTitle(isolated?.sourceTitle || sourceTitle);
    const recipeRegion = isolatedRecipeText || heuristicRecipeRegion || pageText;
    const parsedIsolatedRecipe = parseCookbookRecipeText(recipeRegion, {
      preferredTitle,
      sourceUrl,
      sourceTitle: extractedSourceTitle || sourceTitle,
    });
    if (parsedIsolatedRecipe) {
      return {
        status: 'extracted',
        failureReason: '',
        record: buildCookbookRecordForStorage({
          ...parsedIsolatedRecipe,
          sourceTitle: normalizeCookbookTitle(parsedIsolatedRecipe.sourceTitle || extractedSourceTitle || sourceTitle),
          sourceUrl: sourceUrl || parsedIsolatedRecipe.sourceUrl || '',
          sourceKind: 'web_fetch',
          sourceChatId: chatId,
        }),
      };
    }

    const response = await createLoggedAnthropicMessage(
      anthropic,
      {
        model: resolveAnthropicModelForCallPurpose('cookbook_shape'),
        max_tokens: 500,
        system: `You extract one cookbook-ready recipe from an isolated recipe text region for KitchenBot.

Return ONLY JSON:
{"status":"extracted|not_recipe|insufficient_detail","title":"...","summary":"...","recipeType":"web_recipe","ingredients":["..."],"instructions":["..."],"tags":["..."],"sourceTitle":"...","sourceUrl":"...","notes":["..."]}

Rules:
- Work only from the isolated recipe text provided.
- Do not invent recipe content not supported by the recipe text.
- If the recipe text still does not contain a usable recipe, return status not_recipe or insufficient_detail.
- ingredients should be grocery-friendly items.
- instructions should be compact step-like lines.
- Keep notes separate from instructions.
- If the user provided a preferred cookbook label, use that as title when it is a clean label; preserve the actual recipe/page title in sourceTitle.
- sourceUrl must be the provided source URL.`,
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              latestUserPrompt: prompt,
              preferredCookbookTitle: safeTrim(preferredTitle),
              sourceTitle: extractedSourceTitle || safeTrim(sourceTitle),
              sourceUrl: safeTrim(sourceUrl),
              recipeRegionText: recipeRegion.slice(0, 20000),
              appliedMemory: safeTrim(memoryContext?.applicationText || ''),
              appliedDefaults: safeTrim(memoryContext?.appliedDefaultsText || ''),
            }),
          },
        ],
      },
      {
        householdId,
        chatId,
        runtimeEnabled: true,
        callSurface: 'kb_action',
        callPurpose: 'cookbook_shape',
        webSearchEnabledAtCall: !!memoryContext?.capabilities?.webSearchEnabled,
        usedWebSearchTool: false,
      }
    );
    const text = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
    const parsed = parseJsonObject(text);
    const record = buildCookbookRecordForStorage({
      ...(parsed || {}),
      title: normalizeCookbookTitle(parsed?.title || preferredTitle || extractedSourceTitle || sourceTitle),
      sourceTitle: normalizeCookbookTitle(parsed?.sourceTitle || extractedSourceTitle || sourceTitle || parsed?.title || ''),
      sourceUrl,
      sourceKind: 'web_fetch',
      sourceChatId: chatId,
    });
    const ingredientCount = Array.isArray(record?.ingredients) ? record.ingredients.length : 0;
    const instructionCount = Array.isArray(record?.instructions) ? record.instructions.length : 0;
    if (!record || ingredientCount < 3 || instructionCount < 2) {
      return {
        status: 'extraction_failed',
        failureReason: 'I fetched the page, but I could not reliably extract a full recipe from it.',
        record: null,
      };
    }
    return {
      status: 'extracted',
      failureReason: '',
      record,
    };
  } catch (error) {
    console.error('Cookbook extraction from fetched page failed:', error?.message || error);
    return {
      status: 'extraction_failed',
      failureReason: 'I fetched the page, but I could not reliably extract a full recipe from it.',
      record: null,
    };
  }
}

export function mergeCookbookRecord(existingItem, incomingItem) {
  const existing = buildCookbookRecordForStorage(existingItem) || {};
  const incoming = buildCookbookRecordForStorage(incomingItem) || {};
  const existingQuality = getCookbookRecordQuality(existing);
  const incomingQuality = getCookbookRecordQuality(incoming);
  const incomingWins = incomingQuality.rank >= existingQuality.rank;
  const summaryOptions = [normalizeCookbookSummary(existing.summary), normalizeCookbookSummary(incoming.summary)].filter(Boolean);
  const summary = incomingWins
    ? normalizeCookbookSummary(incoming.summary) || normalizeCookbookSummary(existing.summary) || ''
    : summaryOptions.sort((a, b) => b.length - a.length)[0] || '';
  const ingredients = incomingWins
    ? normalizeStringList(incoming.ingredients, 24, 180)
    : normalizeStringList([...(existing.ingredients || []), ...(incoming.ingredients || [])], 24, 180);
  const instructions = incomingWins
    ? normalizeStringList(incoming.instructions, 16, 240)
    : normalizeStringList([...(existing.instructions || []), ...(incoming.instructions || [])], 16, 240);
  const notes = incomingWins
    ? normalizeNotesList(incoming.notes, 20, 220)
    : normalizeNotesList([...(Array.isArray(existing.notes) ? existing.notes : []), ...(Array.isArray(incoming.notes) ? incoming.notes : [])], 20, 220);
  return buildCookbookRecordForStorage({
    title: incoming.title || existing.title,
    summary,
    category: incoming.category === undefined || incoming.category === ''
      ? existing.category || inferCookbookCategory({ ...existing, ...incoming })
      : incoming.category,
    recipeType: incomingWins ? (incoming.recipeType || existing.recipeType || 'meal_idea') : (existing.recipeType || incoming.recipeType || 'meal_idea'),
    ingredients,
    instructions,
    tags: incomingWins
      ? normalizeStringList(incoming.tags, 12, 60)
      : normalizeStringList([...(existing.tags || []), ...(incoming.tags || [])], 12, 60),
    sourceTitle: incoming.sourceTitle || existing.sourceTitle || '',
    sourceUrl: incoming.sourceUrl || existing.sourceUrl || '',
    notes,
    sourceKind: incomingWins ? (incoming.sourceKind || existing.sourceKind || 'manual') : (existing.sourceKind || incoming.sourceKind || 'manual'),
    sourceChatId: incoming.sourceChatId ?? existing.sourceChatId ?? null,
    lastUsedAt: incoming.lastUsedAt || existing.lastUsedAt || null,
  });
}

export function isFailedCookbookPlaceholder(raw) {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const sourceKind = safeTrim(record.sourceKind).toLowerCase();
  if (sourceKind !== 'web_fetch' && sourceKind !== 'server_fetch') return false;
  const summaryAndNotes = `${safeTrim(record.summary)} ${flattenNotesText(record.notes)}`;
  const instructions = Array.isArray(record.instructions)
    ? record.instructions.map((item) => safeTrim(item)).filter(Boolean)
    : [];
  const ingredients = Array.isArray(record.ingredients)
    ? record.ingredients.map((item) => safeTrim(item)).filter(Boolean)
    : [];
  const placeholderIngredient = ingredients.some((item) => /\bpending full recipe fetch\b/i.test(String(item ?? '')));
  return (
    looksLikeRecipeFailureText(summaryAndNotes) &&
    instructions.length === 0
  ) || placeholderIngredient;
}

export function selectRelevantCookbookEntries(entries, prompt, limit = 8) {
  const ignoredTerms = new Set([
    'with',
    'from',
    'that',
    'this',
    'what',
    'have',
    'cookbook',
    'saved',
    'recipe',
    'recipes',
    'use',
    'our',
    'one',
  ]);
  const textTerms = normalizeStringList(
    String(prompt ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length >= 3 && !ignoredTerms.has(term)),
    16,
    40
  ).map((term) => term.toLowerCase());

  const wantsCookbookOverview =
    /\b(cookbook|saved recipes?|saved meals?|favorites?)\b/i.test(String(prompt ?? '')) &&
    /\b(what|show|list|saved|have|in|our)\b/i.test(String(prompt ?? ''));

  const sorted = [...(Array.isArray(entries) ? entries : [])].sort(
    (a, b) =>
      String(b.lastUsedAt || b.updatedAt || '').localeCompare(String(a.lastUsedAt || a.updatedAt || '')) ||
      String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
  );

  if (wantsCookbookOverview || textTerms.length === 0) return sorted.slice(0, limit);

  return sorted
    .map((entry) => {
      const haystack = [
        entry.title,
        entry.summary,
        ...(Array.isArray(entry.tags) ? entry.tags : []),
        ...(Array.isArray(entry.ingredients) ? entry.ingredients : []),
      ]
        .join(' ')
        .toLowerCase();
      let score = 0;
      for (const term of textTerms) {
        if (haystack.includes(term)) score += 3;
        if (String(entry.title || '').toLowerCase().includes(term)) score += 2;
      }
      return { entry, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.entry);
}

export function formatCookbookEntriesText(entries = []) {
  const rows = (Array.isArray(entries) ? entries : [])
    .slice(0, 10)
    .map((entry) => {
      const title = normalizeCookbookTitle(entry?.title);
      const summary = normalizeCookbookSummary(entry?.summary);
      const tags = normalizeStringList(entry?.tags, 6, 60);
      const source = normalizeCookbookTitle(entry?.sourceTitle);
      const sourceKind = safeTrim(entry?.sourceKind);
      const sourceUrl = normalizeCookbookUrl(entry?.sourceUrl);
      const notes = normalizeNotesList(entry?.notes, 4, 80);
      const bits = [title, summary].filter(Boolean);
      if (tags.length > 0) bits.push(`tags: ${tags.join(', ')}`);
      if (notes.length > 0) bits.push(`notes: ${notes.join(', ')}`);
      if (source) bits.push(`source: ${source}`);
      if (sourceKind) bits.push(`sourceKind: ${sourceKind}`);
      if (sourceUrl) bits.push(`sourceUrl: ${sourceUrl}`);
      return bits.join(' | ');
    })
    .filter(Boolean);
  return rows.length > 0 ? rows.join('\n') : '(none)';
}

export function buildAppliedCookbookText(entries = []) {
  const rows = (Array.isArray(entries) ? entries : [])
    .slice(0, 8)
    .map((entry) => {
      const title = normalizeCookbookTitle(entry?.title);
      const ingredients = normalizeStringList(entry?.ingredients, 8, 120);
      const summary = normalizeCookbookSummary(entry?.summary);
      const notes = normalizeNotesList(entry?.notes, 4, 80);
      const source = normalizeCookbookTitle(entry?.sourceTitle);
      const sourceKind = safeTrim(entry?.sourceKind);
      if (!title) return '';
      const parts = [`- ${title}`];
      if (summary) parts.push(`summary: ${summary}`);
      if (ingredients.length > 0) parts.push(`ingredients: ${ingredients.join(', ')}`);
      if (notes.length > 0) parts.push(`notes: ${notes.join(', ')}`);
      if (source) parts.push(`source: ${source}`);
      if (sourceKind) parts.push(`sourceKind: ${sourceKind}`);
      return parts.join(' | ');
    })
    .filter(Boolean);
  if (rows.length === 0) return '(none)';
  return [
    'Treat these as saved cookbook entries you can plan from, suggest again, or use for grocery generation when relevant:',
    ...rows,
  ].join('\n');
}

export function findCookbookMatches(entries, rawName) {
  const query = normalizeCookbookTitleKey(rawName);
  if (!query) return [];
  const list = Array.isArray(entries) ? entries : [];
  const exact = list.filter((entry) => normalizeCookbookTitleKey(entry?.title) === query);
  if (exact.length > 0) return exact;
  return list.filter((entry) => normalizeCookbookTitleKey(entry?.title).includes(query));
}
