import { normalizeInventoryNameKey } from './inventory-service.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

const MATCH_STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'my',
  'our',
  'your',
  'item',
  'items',
  'grocery',
  'groceries',
  'list',
  'pantry',
  'tab',
  'to',
  'from',
  'in',
  'on',
  'of',
]);

const FOOD_FORM_TOKENS = new Set([
  'cheese',
  'fresh',
  'dried',
  'ground',
  'shredded',
  'grated',
  'chopped',
]);

const EXACT_NAME_ALIASES = new Map([
  ['parmesan cheese', 'parmesan'],
]);

function singularizeToken(token) {
  const text = safeTrim(token).toLowerCase();
  if (!text) return '';
  if (text.endsWith('ies') && text.length > 3) return `${text.slice(0, -3)}y`;
  if (text.endsWith('oes') && text.length > 3) return text.slice(0, -2);
  if (text.endsWith('es') && /(ches|shes|sses|xes|zes)$/.test(text)) return text.slice(0, -2);
  if (text.endsWith('s') && !text.endsWith('ss') && text.length > 3) return text.slice(0, -1);
  return text;
}

function normalizeMatchSourceText(text) {
  const normalized = normalizeInventoryNameKey(text);
  return EXACT_NAME_ALIASES.get(normalized) || normalized;
}

function toMatchTokens(text) {
  const tokens = normalizeMatchSourceText(text)
    .split(/[^a-z0-9]+/i)
    .map((token) => singularizeToken(token))
    .filter((token) => token && !MATCH_STOP_WORDS.has(token));
  if (tokens.length <= 1) return tokens;
  const stripped = tokens.filter((token) => !FOOD_FORM_TOKENS.has(token));
  return stripped.length > 0 ? stripped : tokens;
}

function uniqueList(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function buildItemMatchMeta(item) {
  const normalizedName = normalizeMatchSourceText(item?.name);
  const tokens = uniqueList(toMatchTokens(item?.name));
  return {
    item,
    normalizedName,
    singularName: tokens.join(' '),
    tokenSet: new Set(tokens),
  };
}

function matchesByExactName(meta, requestKey, requestSingularKey) {
  return meta.normalizedName === requestKey || (requestSingularKey && meta.singularName === requestSingularKey);
}

function matchesByTokenContainment(meta, requestTokens) {
  if (!requestTokens.length) return false;
  return requestTokens.every((token) => meta.tokenSet.has(token));
}

export function resolveInventoryItemMatch(items, rawName) {
  const requestedName = safeTrim(rawName);
  if (!requestedName) {
    return { status: 'invalid', requestedName: '' };
  }

  const metas = (Array.isArray(items) ? items : []).map(buildItemMatchMeta);
  const requestKey = normalizeMatchSourceText(requestedName);
  const requestTokens = uniqueList(toMatchTokens(requestedName));
  const requestSingularKey = requestTokens.join(' ');

  const exactMatches = metas.filter((meta) => matchesByExactName(meta, requestKey, requestSingularKey));
  if (exactMatches.length === 1) {
    return { status: 'found', item: exactMatches[0].item, requestedName };
  }
  if (exactMatches.length > 1) {
    return {
      status: 'ambiguous',
      requestedName,
      matches: exactMatches.map((meta) => meta.item),
    };
  }

  const partialMatches = metas.filter((meta) => matchesByTokenContainment(meta, requestTokens));
  if (partialMatches.length === 1) {
    return { status: 'found', item: partialMatches[0].item, requestedName };
  }
  if (partialMatches.length > 1) {
    return {
      status: 'ambiguous',
      requestedName,
      matches: partialMatches.map((meta) => meta.item),
    };
  }

  return { status: 'missing', requestedName };
}
