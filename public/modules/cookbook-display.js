// Cookbook presentation logic: titles, source/provenance labels, card summaries, and the
// client-side recipe search ranking. Pure functions — no DOM, no shared mutable state — which is
// why they could be lifted out of app.js first and why they are unit-testable in Node.
import { COOKBOOK_CATEGORY_OPTIONS } from './boot-data.js';

export function safeCookbookTrim(value) {
  return String(value ?? '').trim();
}

export function normalizeCookbookDisplayTitleText(value) {
  return safeCookbookTrim(value).replace(/\s+/g, ' ').slice(0, 160);
}

export function normalizeCookbookDisplayTitleKey(value) {
  return normalizeCookbookDisplayTitleText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeCookbookDisplayUrl(value) {
  const text = safeCookbookTrim(value).slice(0, 1000);
  return /^https?:\/\//i.test(text) ? text : '';
}

export function stripCookbookDisplayMarkdown(value) {
  return safeCookbookTrim(value)
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[(.*?)\]\((https?:\/\/[^)]+)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sanitizeCookbookDisplayTitle(value) {
  let text = normalizeCookbookDisplayTitleText(stripCookbookDisplayMarkdown(value));
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
  return normalizeCookbookDisplayTitleText(text);
}

export function sanitizeCookbookDisplaySourceTitle(value, { title = '' } = {}) {
  const text = normalizeCookbookDisplayTitleText(stripCookbookDisplayMarkdown(value));
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
  if (normalizeCookbookDisplayTitleKey(text) === normalizeCookbookDisplayTitleKey(title)) return text;
  return text;
}

export function getCookbookDisplayTitle(entry) {
  const record = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
  return sanitizeCookbookDisplayTitle(record.title) || normalizeCookbookDisplayTitleText(record.title || 'Saved recipe');
}

export function getCookbookDisplaySource(entry) {
  const record = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
  const title = getCookbookDisplayTitle(record);
  const sourceBookTitle = sanitizeCookbookDisplaySourceTitle(record.sourceBookTitle, { title });
  const sourceUrl = normalizeCookbookDisplayUrl(record.sourceUrl);
  const sourceTitle = sanitizeCookbookDisplaySourceTitle(record.sourceTitle, { title });
  if (!sourceBookTitle && !sourceTitle && !sourceUrl) return null;
  return {
    label: sourceUrl ? (sourceTitle || sourceUrl) : (sourceBookTitle || sourceTitle || sourceUrl),
    url: sourceUrl || '',
  };
}

export function getCookbookDisplayProvenance(entry) {
  const record = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
  const ingredients = Array.isArray(record.ingredients) ? record.ingredients : [];
  const instructions = Array.isArray(record.instructions) ? record.instructions : [];
  const structuredRecipe = ingredients.length >= 3 && instructions.length >= 2;
  if (!structuredRecipe) return 'Meal idea';
  const hasExternalSource =
    !!safeCookbookTrim(record.sourceBookTitle) ||
    !!normalizeCookbookDisplayUrl(record.sourceUrl) ||
    record.sourceKind === 'web_fetch' ||
    record.sourceKind === 'server_fetch' ||
    (!!safeCookbookTrim(record.sourceTitle) && record.recipeType === 'web_recipe');
  if (hasExternalSource) return 'Sourced recipe';
  if (safeCookbookTrim(record.sourceKind).toLowerCase() === 'kb_action') return 'KitchenBot generated';
  return 'Saved recipe';
}

export function formatCookbookBullets(items) {
  const values = Array.isArray(items)
    ? items
        .map((item) => {
          if (typeof item === 'string') return item.trim();
          if (item && typeof item === 'object') {
            return String(item.text || item.name || item.step || item.summary || '').trim();
          }
          return '';
        })
        .filter(Boolean)
    : [];
  return values;
}

export function formatCookbookCategoryLabel(category) {
  const normalized = String(category || '').trim();
  if (!normalized) return 'Uncategorized';
  const match = COOKBOOK_CATEGORY_OPTIONS.find((option) => option.value === normalized);
  return match ? match.label : 'Uncategorized';
}

export function normalizeCookbookSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function tokenizeCookbookSearch(value) {
  return normalizeCookbookSearchText(value)
    .split(' ')
    .map((part) => part.trim())
    .filter(Boolean);
}

export function buildCookbookSearchFields(entry) {
  const title = getCookbookDisplayTitle(entry);
  const summary = String(entry && entry.summary ? entry.summary : '');
  const sourceDisplay = getCookbookSourceDisplay(entry);
  const sourceTitle = String(sourceDisplay && sourceDisplay.label ? sourceDisplay.label : '');
  const category = formatCookbookCategoryLabel(entry && entry.category ? entry.category : '');
  const tags = Array.isArray(entry && entry.tags) ? entry.tags.map((tag) => String(tag || '').trim()).filter(Boolean) : [];
  const ingredients = formatCookbookBullets(entry && entry.ingredients);
  const instructions = formatCookbookBullets(entry && entry.instructions);
  const notes = formatCookbookBullets(Array.isArray(entry && entry.notes) ? entry.notes : entry && entry.notes ? [entry.notes] : []);
  return {
    title,
    summary,
    sourceTitle,
    category,
    tags,
    ingredients,
    instructions,
    notes,
  };
}

export function scoreCookbookSearchMatch(entry, query) {
  const tokens = tokenizeCookbookSearch(query);
  if (tokens.length === 0) return 0;
  const fields = buildCookbookSearchFields(entry);
  const title = normalizeCookbookSearchText(fields.title);
  const summary = normalizeCookbookSearchText(fields.summary);
  const sourceTitle = normalizeCookbookSearchText(fields.sourceTitle);
  const category = normalizeCookbookSearchText(fields.category);
  const tags = fields.tags.map(normalizeCookbookSearchText);
  const ingredients = fields.ingredients.map(normalizeCookbookSearchText);
  const instructions = fields.instructions.map(normalizeCookbookSearchText);
  const notes = fields.notes.map(normalizeCookbookSearchText);
  const haystack = [title, summary, sourceTitle, category]
    .concat(tags, ingredients, instructions, notes)
    .filter(Boolean)
    .join(' ');
  if (!tokens.every((token) => haystack.includes(token))) return -1;

  let score = 0;
  for (const token of tokens) {
    if (title === token) score += 120;
    else if (title.startsWith(token + ' ') || title.includes(' ' + token + ' ')) score += 60;
    else if (title.includes(token)) score += 45;

    if (tags.some((tag) => tag === token)) score += 90;
    else if (tags.some((tag) => tag.startsWith(token) || tag.includes(token))) score += 55;

    if (sourceTitle === token) score += 40;
    else if (sourceTitle.includes(token)) score += 24;

    if (category === token) score += 24;
    else if (category.includes(token)) score += 16;

    if (summary.includes(token)) score += 10;
    if (ingredients.some((line) => line.includes(token))) score += 8;
    if (instructions.some((line) => line.includes(token))) score += 5;
    if (notes.some((line) => line.includes(token))) score += 6;
  }
  return score;
}

export function getCookbookProvenanceLabel(entry) {
  return getCookbookDisplayProvenance(entry);
}

export function getCookbookSourceDisplay(entry) {
  return getCookbookDisplaySource(entry);
}

export function getCookbookCardSummary(entry) {
  return safeCookbookTrim(entry.summary || '');
}

export function getCookbookCardMetaText(entry) {
  const meta = [];
  meta.push(formatCookbookCategoryLabel(entry.category));
  meta.push(getCookbookProvenanceLabel(entry));
  if (entry.updatedAt) meta.push('updated ' + new Date(entry.updatedAt).toLocaleDateString());
  return meta.join(' • ');
}

export function cookbookDetailHash(id) {
  return id ? '#cookbook/' + encodeURIComponent(String(id)) : '';
}

export function splitCookbookEditorLines(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
