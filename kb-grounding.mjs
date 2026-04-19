import { createLoggedAnthropicMessage } from './anthropic-usage.mjs';
import { resolveAnthropicModelForCallPurpose } from './anthropic-model-policy.mjs';
import { findCookbookMatches, looksLikeRecipeText, parseCookbookRecipeText } from './cookbook-store.mjs';
import { formatKbRecentConversation, getKbPromptContextSections } from './kb-prompt-context.mjs';
import { normalizeWorkingContext } from './kb-working-context.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

function normalizeTextKey(text) {
  return safeTrim(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeMealEntryLabel(text = '') {
  return safeTrim(text)
    .replace(/^[\d.\-\s]+/, '')
    .replace(/[.!?]+$/, '')
    .trim();
}

function normalizeMealEntryTitle(text = '') {
  return safeTrim(text)
    .replace(/^[\d.\-\s]+/, '')
    .replace(/\s{2,}.*/g, '')
    .replace(/[.!?]+$/, '')
    .trim();
}

function extractCategoryAliasTerms(text = '') {
  const knownCategories = [
    'bowl',
    'bowls',
    'burger',
    'burgers',
    'curry',
    'curries',
    'fajita',
    'fajitas',
    'pasta',
    'rice',
    'salad',
    'salads',
    'sandwich',
    'sandwiches',
    'skillet',
    'soup',
    'soups',
    'stew',
    'stews',
    'taco',
    'tacos',
    'wonton',
    'dumpling',
  ];
  const normalized = normalizeTextKey(text);
  if (!normalized) return [];
  return dedupeStrings(
    normalized
      .split(' ')
      .map((token) => safeTrim(token))
      .filter((token) => knownCategories.includes(token))
  );
}

function buildMealEntry({ label = '', title = '', aliasTerms = [] } = {}) {
  const normalizedLabel = normalizeMealEntryLabel(label);
  const normalizedTitle = normalizeMealEntryTitle(title);
  const aliases = dedupeStrings([
    normalizedLabel,
    normalizedTitle,
    ...extractCategoryAliasTerms(normalizedLabel),
    ...extractCategoryAliasTerms(normalizedTitle),
    ...(Array.isArray(aliasTerms) ? aliasTerms : []),
  ]);
  if (!normalizedLabel && !normalizedTitle && aliases.length === 0) return null;
  return {
    label: normalizedLabel,
    title: normalizedTitle || normalizedLabel,
    aliasTerms: aliases,
  };
}

function normalizeMealEntries(entries = []) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const normalized = buildMealEntry(entry || {});
    if (!normalized) continue;
    const key = normalizeTextKey(`${normalized.label}::${normalized.title}`);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
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

function dedupeStrings(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = safeTrim(value);
    const key = normalizeTextKey(text);
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function dedupeObjects(objects = []) {
  const seen = new Set();
  const out = [];
  for (const object of Array.isArray(objects) ? objects : []) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) continue;
    const type = safeTrim(object.type);
    const label = safeTrim(object.label || object.title || object.name);
    const id = Number.isFinite(Number(object.id)) ? Number(object.id) : null;
    const key = JSON.stringify({ type, label: normalizeTextKey(label), id });
    if (!type || seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...object,
      ...(id != null ? { id } : {}),
      type,
      label: label || type,
    });
  }
  return out;
}

function clonePlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return JSON.parse(JSON.stringify(value));
}

function buildEntitySnapshot(memoryContext = null, activeSpeakerName = '') {
  const entityContext = memoryContext?.entityContext && typeof memoryContext.entityContext === 'object' ? memoryContext.entityContext : {};
  return {
    activeSpeakerName: safeTrim(entityContext.activeSpeakerName || activeSpeakerName),
    activeSpeakerLabel: safeTrim(entityContext.activeSpeakerLabel || activeSpeakerName),
    mentionedPeople: (Array.isArray(entityContext.mentionedPersonLabels) ? entityContext.mentionedPersonLabels : [])
      .map((label) => safeTrim(label))
      .filter(Boolean),
    householdRelevant: !!entityContext.householdRelevant,
  };
}

export function findLatestAssistantRecipe(messages = []) {
  const assistantMessages = [...(Array.isArray(messages) ? messages : [])]
    .filter((message) => message?.role === 'assistant')
    .reverse();
  for (const message of assistantMessages) {
    const text = safeTrim(message?.content);
    if (!looksLikeRecipeText(text)) continue;
    const parsed = parseCookbookRecipeText(text, {}) || {};
    const title = safeTrim(parsed.title || text.split('\n')[0]);
    return {
      type: 'chat_recipe',
      label: title || 'Active recipe in chat',
      title: title || 'Active recipe in chat',
      source: 'recent_conversation',
      recipeText: text,
      recipeRecord: parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? clonePlainObject(parsed)
        : null,
      sourceMessages: [
        {
          role: 'assistant',
          id: Number.isFinite(Number(message?.id)) ? Number(message.id) : null,
          contentPreview: text.slice(0, 240),
        },
      ],
    };
  }
  return null;
}

function extractMealEntriesFromAssistantText(text = '') {
  const lines = safeTrim(text).split('\n').map((line) => safeTrim(line)).filter(Boolean);
  const entries = [];
  for (const line of lines) {
    let candidateLabel = '';
    let candidateTitle = '';
    const boldMatch = line.match(/^\*\*(.+?)\*\*/);
    if (boldMatch?.[1]) {
      const candidate = safeTrim(boldMatch[1]).replace(/^\d+\.\s*/, '');
      if (candidate.includes(':')) {
        const [label, ...rest] = candidate.split(':');
        candidateLabel = safeTrim(label);
        candidateTitle = safeTrim(rest.join(':'));
      } else {
        candidateTitle = candidate;
      }
    } else {
      const plainMatch = line.match(/^(?:[-*]\s*)?([^:]{1,40}):\s+(.+)$/);
      const label = safeTrim(plainMatch?.[1]);
      if (plainMatch?.[2] && looksLikeMealIdeaLabel(label)) {
        candidateLabel = label;
        candidateTitle = safeTrim(plainMatch[2]);
      }
    }
    const entry = buildMealEntry({ label: candidateLabel, title: candidateTitle });
    if (entry) entries.push(entry);
  }
  return normalizeMealEntries(entries).slice(0, 8);
}

function extractMealIdeasFromAssistantText(text = '') {
  return extractMealEntriesFromAssistantText(text).map((entry) => entry.title).filter(Boolean);
}

function looksLikeMealIdeaLabel(label = '') {
  const normalized = normalizeTextKey(label);
  if (!normalized) return false;
  const words = normalized.split(' ').filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;
  if (/^(the|this|that|these|those|all|both)\b/.test(normalized)) return false;
  return true;
}

function extractSingleMealIdeaFromAssistantText(text = '') {
  const ideas = extractMealIdeasFromAssistantText(text);
  return ideas.length === 1 ? ideas[0] : '';
}

function extractSingleMealEntryFromAssistantText(text = '') {
  const entries = extractMealEntriesFromAssistantText(text);
  return entries.length === 1 ? entries[0] : null;
}

function looksLikeMealSetRevisionPrompt(text = '') {
  const lower = safeTrim(text).toLowerCase();
  if (!lower) return false;
  return /\b(swap|replace|change|instead|use the|make the|turn the)\b/.test(lower);
}

function extractMealRevisionTargetText(text = '') {
  const raw = safeTrim(text);
  if (!raw) return '';
  const patterns = [
    /\bswap(?:\s+out)?\s+(?:the\s+)?(.+?)\s+(?:for|with)\b/i,
    /\breplace\s+(?:the\s+)?(.+?)\s+(?:with|for)\b/i,
    /\bchange\s+(?:the\s+)?(.+?)\s+(?:to|into)\b/i,
    /\bmake\s+(?:the\s+)?(.+?)\s+instead\b/i,
    /\buse\s+(?:the\s+)?(.+?)\s+instead\b/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[1]) return safeTrim(match[1]);
  }
  return raw;
}

function extractMealRevisionReplacementText(text = '') {
  const raw = safeTrim(text);
  if (!raw) return '';
  const patterns = [
    /\bswap(?:\s+out)?\s+(?:the\s+)?(.+?)\s+(?:for|with)\s+(.+?)$/i,
    /\breplace\s+(?:the\s+)?(.+?)\s+(?:with|for)\s+(.+?)$/i,
    /\bchange\s+(?:the\s+)?(.+?)\s+(?:to|into)\s+(.+?)$/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[2]) return safeTrim(match[2]);
  }
  return '';
}

function tokenizeMeaningfulText(text = '') {
  const stopwords = new Set([
    'a', 'an', 'and', 'as', 'at', 'be', 'bowl', 'dish', 'dinner', 'for', 'idea', 'ideas', 'into',
    'it', 'make', 'meal', 'meals', 'of', 'on', 'one', 'out', 'please', 'recipe', 'replace', 'swap',
    'that', 'the', 'them', 'there', 'these', 'this', 'to', 'turn', 'use', 'with',
  ]);
  return normalizeTextKey(text)
    .split(' ')
    .map((token) => safeTrim(token))
    .filter((token) => token.length >= 3 && !stopwords.has(token));
}

function findBestMealSetRevisionIndex(mealEntries = [], userPrompt = '', revisedIdea = '') {
  const targetTokens = tokenizeMeaningfulText(extractMealRevisionTargetText(userPrompt));
  const revisedTokens = tokenizeMeaningfulText(revisedIdea);
  let bestIndex = -1;
  let bestScore = 0;
  for (let index = 0; index < mealEntries.length; index += 1) {
    const entry = mealEntries[index] && typeof mealEntries[index] === 'object' ? mealEntries[index] : {};
    const normalizedIdea = normalizeTextKey([
      safeTrim(entry.label),
      safeTrim(entry.title),
      ...(Array.isArray(entry.aliasTerms) ? entry.aliasTerms : []),
    ].join(' '));
    if (!normalizedIdea) continue;
    let score = 0;
    for (const token of targetTokens) {
      if (normalizedIdea.includes(token)) score += 3;
    }
    for (const token of revisedTokens) {
      if (normalizedIdea.includes(token)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestScore > 0 ? bestIndex : -1;
}

function applyMealSetConversationRevisions(baseMealSet = null, messages = []) {
  if (!baseMealSet || typeof baseMealSet !== 'object' || Array.isArray(baseMealSet)) return baseMealSet;
  const allMessages = Array.isArray(messages) ? messages : [];
  const baseMessageId = Number.isFinite(Number(baseMealSet?.sourceMessages?.[0]?.id)) ? Number(baseMealSet.sourceMessages[0].id) : null;
  const baseIndex =
    baseMessageId != null
      ? allMessages.findIndex((message) => Number(message?.id) === baseMessageId)
      : -1;
  const mealEntries = normalizeMealEntries(
    Array.isArray(baseMealSet.mealEntries) && baseMealSet.mealEntries.length > 0
      ? baseMealSet.mealEntries
      : dedupeStrings(baseMealSet.mealIdeas || baseMealSet.subjectItems || []).map((title) => ({ title }))
  );
  if (mealEntries.length < 2) return baseMealSet;

  for (let index = Math.max(0, baseIndex + 1); index < allMessages.length; index += 1) {
    const message = allMessages[index];
    if (safeTrim(message?.role) !== 'user') continue;
    const userPrompt = safeTrim(message?.content);
    if (!looksLikeMealSetRevisionPrompt(userPrompt)) continue;
    const assistantMessage = allMessages.slice(index + 1).find((entry) => safeTrim(entry?.role) === 'assistant');
    if (!assistantMessage) continue;
    const revisedEntry = extractSingleMealEntryFromAssistantText(assistantMessage?.content);
    const revisedIdea = safeTrim(revisedEntry?.title || extractSingleMealIdeaFromAssistantText(assistantMessage?.content));
    if (!revisedIdea) continue;
    const replaceIndex = findBestMealSetRevisionIndex(mealEntries, userPrompt, revisedIdea);
    if (replaceIndex >= 0) {
      const previousEntry = mealEntries[replaceIndex] || {};
      const replacementText = normalizeMealEntryLabel(extractMealRevisionReplacementText(userPrompt));
      const previousLabel = safeTrim(previousEntry.label);
      const derivedLabel =
        (
          replacementText &&
          /\b(bowl|soup|pasta|salad|tacos|fajitas|skillet)\b/i.test(previousLabel) &&
          !/\b(bowl|soup|pasta|salad|tacos|fajitas|skillet)\b/i.test(replacementText)
        )
          ? `${replacementText} ${previousLabel.split(/\s+/).slice(-1)[0]}`
          : previousLabel;
      const carriedLabel = safeTrim(revisedEntry?.label) || derivedLabel;
      mealEntries[replaceIndex] = buildMealEntry({
        label: carriedLabel,
        title: revisedIdea,
        aliasTerms: [
          ...(Array.isArray(previousEntry.aliasTerms) ? previousEntry.aliasTerms : []),
          ...(Array.isArray(revisedEntry?.aliasTerms) ? revisedEntry.aliasTerms : []),
          replacementText,
          carriedLabel,
        ],
      }) || mealEntries[replaceIndex];
    }
  }

  const mealIdeas = mealEntries.map((entry) => safeTrim(entry.title)).filter(Boolean);

  return {
    ...baseMealSet,
    mealEntries,
    mealIdeas: dedupeStrings(mealIdeas),
    subjectItems: dedupeStrings(mealIdeas),
  };
}

function looksLikeMealSetText(text = '') {
  return extractMealIdeasFromAssistantText(text).length >= 2;
}

function findLatestAssistantMealSet(messages = []) {
  const assistantMessages = [...(Array.isArray(messages) ? messages : [])]
    .filter((message) => message?.role === 'assistant')
    .reverse();
  for (const message of assistantMessages) {
    const text = safeTrim(message?.content);
    if (!looksLikeMealSetText(text)) continue;
    const mealEntries = extractMealEntriesFromAssistantText(text);
    const mealIdeas = mealEntries.map((entry) => entry.title).filter(Boolean);
    if (mealIdeas.length < 2) continue;
    return applyMealSetConversationRevisions({
      type: 'meal_plan_or_meal_set',
      label: 'Current meal set in chat',
      topicSummary: 'Current meal set in chat',
      mealEntries,
      mealIdeas,
      subjectItems: mealIdeas,
      source: 'recent_conversation',
      sourceMessages: [
        {
          role: 'assistant',
          id: Number.isFinite(Number(message?.id)) ? Number(message.id) : null,
          contentPreview: text.slice(0, 240),
        },
      ],
    }, messages);
  }
  return null;
}

function extractGroceryProposalItemsFromAssistantText(text = '') {
  const lines = safeTrim(text).split('\n').map((line) => safeTrim(line)).filter(Boolean);
  const items = [];
  for (const line of lines) {
    const match = line.match(/^-\s+(.+)$/);
    if (!match?.[1]) continue;
    const raw = safeTrim(match[1]).replace(/\s*\([^)]*\)\s*$/, '');
    if (!raw || /^from the\b/i.test(raw)) continue;
    items.push({
      name: raw.replace(/\s+\d.*$/, '').trim(),
      amount: '',
      section: '',
    });
  }
  const seen = new Set();
  return items.filter((item) => {
    const key = normalizeTextKey(item.name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 40);
}

function looksLikeGroceryProposalText(text = '') {
  const lower = safeTrim(text).toLowerCase();
  if (!/\bgrocery list\b/.test(lower) && !/\bhere(?:'s| is) .*list\b/.test(lower)) return false;
  return extractGroceryProposalItemsFromAssistantText(text).length >= 3;
}

function findLatestAssistantGroceryProposal(messages = []) {
  const assistantMessages = [...(Array.isArray(messages) ? messages : [])]
    .filter((message) => message?.role === 'assistant')
    .reverse();
  for (const message of assistantMessages) {
    const text = safeTrim(message?.content);
    if (!looksLikeGroceryProposalText(text)) continue;
    const items = extractGroceryProposalItemsFromAssistantText(text);
    if (items.length < 3) continue;
    return {
      type: 'grocery_proposal',
      label: 'Current grocery proposal in chat',
      items,
      source: 'recent_conversation',
      sourceMessages: [
        {
          role: 'assistant',
          id: Number.isFinite(Number(message?.id)) ? Number(message.id) : null,
          contentPreview: text.slice(0, 240),
        },
      ],
    };
  }
  return null;
}

function buildMessageSourceList(messages = [], limit = 6) {
  return (Array.isArray(messages) ? messages : [])
    .slice(-limit)
    .map((message) => ({
      role: safeTrim(message?.role),
      id: Number.isFinite(Number(message?.id)) ? Number(message.id) : null,
      contentPreview: safeTrim(message?.content).slice(0, 240),
    }))
    .filter((message) => message.role && message.contentPreview);
}

function normalizeRecipeRecordForCurrentObject(record = null) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const title = safeTrim(record.title);
  const ingredients = Array.isArray(record.ingredients) ? record.ingredients.map((item) => safeTrim(item)).filter(Boolean) : [];
  const instructions = Array.isArray(record.instructions) ? record.instructions.map((item) => safeTrim(item)).filter(Boolean) : [];
  if (!title && ingredients.length === 0 && instructions.length === 0) return null;
  return {
    title: title || '',
    summary: safeTrim(record.summary || record.description),
    ingredients,
    instructions,
    tags: Array.isArray(record.tags) ? record.tags.map((item) => safeTrim(item)).filter(Boolean) : [],
    notes: Array.isArray(record.notes) ? record.notes.map((item) => safeTrim(item)).filter(Boolean) : [],
    sourceTitle: safeTrim(record.sourceTitle),
    sourceUrl: safeTrim(record.sourceUrl),
    sourceKind: safeTrim(record.sourceKind || 'kb_generated'),
    recipeType: safeTrim(record.recipeType || 'saved_recipe'),
  };
}

function buildChatRecipeCurrentObject(recipe = null) {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) return null;
  const recipeRecord = normalizeRecipeRecordForCurrentObject(recipe.recipeRecord);
  const title = safeTrim(recipe.title || recipe.label || recipeRecord?.title);
  const versionSummary = recipeRecord?.summary || title || 'Active recipe in chat';
  return {
    objectType: 'chat_recipe',
    sourceMessages: Array.isArray(recipe.sourceMessages) ? recipe.sourceMessages : [],
    versionSummary,
    title: title || 'Active recipe in chat',
    recipeText: safeTrim(recipe.recipeText),
    recipeRecord,
    source: safeTrim(recipe.source || 'recent_conversation'),
    confidence: title || recipeRecord ? 'high' : 'medium',
    stale: false,
  };
}

function buildMealSetCurrentObject(mealThread = null, recentMessages = []) {
  if (!mealThread || typeof mealThread !== 'object' || Array.isArray(mealThread)) return null;
  const mealEntries = normalizeMealEntries(mealThread.mealEntries || []);
  const mealIdeas = dedupeStrings(mealThread.mealIdeas || mealThread.subjectItems || []);
  const subjectItems = dedupeStrings(mealThread.subjectItems || mealThread.mealIdeas || []);
  const activeConstraints = dedupeStrings(mealThread.activeConstraints || []);
  const groceryFocus = dedupeStrings(mealThread.groceryFocus || []);
  const versionSummary = safeTrim(mealThread.label || mealThread.topicSummary) || mealIdeas.join('; ');
  if (!versionSummary && mealIdeas.length === 0 && subjectItems.length === 0) return null;
  return {
    objectType: 'meal_set',
    sourceMessages: buildMessageSourceList(recentMessages),
    versionSummary: versionSummary || 'Current meal set',
    topicSummary: safeTrim(mealThread.topicSummary || mealThread.label),
    mealEntries,
    mealIdeas,
    subjectItems,
    activeConstraints,
    groceryFocus,
    source: safeTrim(mealThread.source || 'working_context'),
    confidence: mealIdeas.length > 0 ? 'high' : 'medium',
    stale: false,
  };
}

function promptClearlyRequestsCookbookSave(prompt = '') {
  const lower = safeTrim(prompt).toLowerCase();
  if (!lower) return false;
  const mentionsCookbook = /\b(cookbook|saved recipes?|saved meals?|favorites?)\b/.test(lower);
  const asksToSave = /\b(save|add|put|store|keep)\b/.test(lower);
  return mentionsCookbook && asksToSave;
}

function buildMealSelectionAliases(entry = null) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
  return dedupeStrings([
    safeTrim(entry.label),
    safeTrim(entry.title),
    ...extractCategoryAliasTerms(entry.label),
    ...extractCategoryAliasTerms(entry.title),
    ...(Array.isArray(entry.aliasTerms) ? entry.aliasTerms : []),
  ]).filter((alias) => normalizeTextKey(alias).length >= 3);
}

function promptHasSubsetSignal(prompt = '') {
  const lower = safeTrim(prompt).toLowerCase();
  if (!lower) return false;
  return /\b(just|only|except|everything except|all but|without|besides|other than)\b/.test(lower);
}

function matchMealSelectionEntries(mealEntries = [], prompt = '') {
  const promptKey = ` ${normalizeTextKey(prompt)} `;
  if (!promptKey.trim()) return [];
  return normalizeMealEntries(mealEntries)
    .map((entry, index) => {
      const aliases = buildMealSelectionAliases(entry);
      let score = 0;
      for (const alias of aliases) {
        const aliasKey = normalizeTextKey(alias);
        if (!aliasKey) continue;
        if (promptKey.includes(` ${aliasKey} `)) score = Math.max(score, aliasKey.split(' ').length + 1);
      }
      return score > 0 ? { index, entry, score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

function buildMealSetSelectionCurrentObject(mealSet = null, selectionEntries = [], selectionScope = '') {
  if (!mealSet || typeof mealSet !== 'object' || Array.isArray(mealSet)) return null;
  const entries = normalizeMealEntries(selectionEntries);
  if (entries.length === 0) return null;
  const mealIdeas = entries.map((entry) => safeTrim(entry.title)).filter(Boolean);
  return {
    objectType: 'meal_set_selection',
    parentObjectType: 'meal_set',
    sourceMessages: Array.isArray(mealSet.sourceMessages) ? mealSet.sourceMessages : [],
    versionSummary: safeTrim(selectionScope) || mealIdeas.join('; '),
    topicSummary: safeTrim(mealSet.topicSummary || mealSet.versionSummary),
    mealEntries: entries,
    mealIdeas,
    subjectItems: mealIdeas,
    activeConstraints: Array.isArray(mealSet.activeConstraints) ? mealSet.activeConstraints.slice() : [],
    groceryFocus: mealIdeas.slice(),
    selectionScope: safeTrim(selectionScope),
    source: safeTrim(mealSet.source || 'recent_conversation'),
    confidence: entries.length > 0 ? 'high' : 'medium',
    stale: false,
  };
}

function deriveMealSetSelectionCurrentObject(mealSet = null, prompt = '') {
  if (!mealSet || typeof mealSet !== 'object' || Array.isArray(mealSet)) return { currentObject: null, subsetRequested: false };
  const mealEntries = normalizeMealEntries(mealSet.mealEntries || []);
  if (mealEntries.length < 2) return { currentObject: null, subsetRequested: false };
  const matches = matchMealSelectionEntries(mealEntries, prompt);
  const subsetRequested = promptHasSubsetSignal(prompt) || (matches.length > 0 && matches.length < mealEntries.length);
  if (!subsetRequested) return { currentObject: null, subsetRequested: false };

  const lower = safeTrim(prompt).toLowerCase();
  if (/\b(except|all but|without|besides|other than)\b/.test(lower)) {
    const excludedIndexes = new Set(matches.map((match) => match.index));
    const remaining = mealEntries.filter((_, index) => !excludedIndexes.has(index));
    return {
      currentObject: buildMealSetSelectionCurrentObject(mealSet, remaining, 'Selected meals from the current meal set'),
      subsetRequested: true,
    };
  }

  const selected = matches.map((match) => match.entry);
  return {
    currentObject: buildMealSetSelectionCurrentObject(mealSet, selected, 'Selected meals from the current meal set'),
    subsetRequested: true,
  };
}

function buildGroceryProposalCurrentObject(source = null, recentMessages = []) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const items = (Array.isArray(source.items) ? source.items : [])
    .map((item) => ({
      name: safeTrim(typeof item === 'string' ? item : item?.name),
      amount: safeTrim(item?.amount),
      section: safeTrim(item?.section),
    }))
    .filter((item) => item.name);
  if (items.length === 0) return null;
  return {
    objectType: 'grocery_proposal',
    sourceMessages: buildMessageSourceList(recentMessages),
    versionSummary: safeTrim(source.label) || `${items.length} grocery items`,
    items,
    source: safeTrim(source.source || 'working_context'),
    confidence: 'medium',
    stale: false,
  };
}

export function deriveCurrentObject({
  prompt = '',
  recentMessages = [],
  groundedTurn = null,
  memoryContext = null,
  workingContext = null,
} = {}) {
  const grounded = normalizeGroundedTurn(groundedTurn);
  const activeObjects = Array.isArray(grounded.activeObjects) ? grounded.activeObjects : [];
  const lowerPrompt = safeTrim(prompt).toLowerCase();
  const chatRecipe = activeObjects.find((object) => safeTrim(object?.type) === 'chat_recipe') || findLatestAssistantRecipe(recentMessages);
  const recentMealSet = findLatestAssistantMealSet(recentMessages);
  const mealThread =
    activeObjects.find((object) => safeTrim(object?.type) === 'meal_plan_or_meal_set') ||
    recentMealSet ||
    buildWorkingContextObjects(workingContext || memoryContext?.workingContext, { includeMealThread: true })
      .find((object) => safeTrim(object?.type) === 'meal_plan_or_meal_set');
  const groceryProposal =
    activeObjects.find((object) => safeTrim(object?.type) === 'grocery_proposal') ||
    findLatestAssistantGroceryProposal(recentMessages);
  const offeredIngredients =
    activeObjects.find((object) => safeTrim(object?.type) === 'offered_ingredients') ||
    buildWorkingContextObjects(workingContext || memoryContext?.workingContext, { includeMealThread: false })
      .find((object) => safeTrim(object?.type) === 'offered_ingredients');

  if (chatRecipe && promptClearlyRequestsCookbookSave(prompt)) {
    return buildChatRecipeCurrentObject(chatRecipe);
  }

  if (
    grounded.surface === 'cookbook' &&
    ['save_recipe', 'update_saved_recipe'].includes(safeTrim(grounded.intent)) &&
    chatRecipe
  ) {
    return buildChatRecipeCurrentObject(chatRecipe);
  }

  if (
    grounded.surface === 'conversation' &&
    safeTrim(grounded.intent) === 'revise_recipe' &&
    chatRecipe
  ) {
    return buildChatRecipeCurrentObject(chatRecipe);
  }

  if (
    grounded.surface === 'meal_plan' ||
    (grounded.surface === 'grocery' && mealThread) ||
    /\b(swap|replace|change one|revise|make one|all of that|all of them)\b/.test(lowerPrompt)
  ) {
    const mealSet = buildMealSetCurrentObject(mealThread, recentMessages);
    if (mealSet) {
      if (grounded.surface === 'grocery') {
        const selection = deriveMealSetSelectionCurrentObject(mealSet, prompt);
        if (selection.currentObject) return selection.currentObject;
      }
      return mealSet;
    }
  }

  if (grounded.surface === 'grocery' && offeredIngredients) {
    return buildGroceryProposalCurrentObject({
      label: safeTrim(offeredIngredients.label),
      items: Array.isArray(offeredIngredients.items)
        ? offeredIngredients.items.map((name) => ({ name }))
        : [],
      source: offeredIngredients.source,
    }, recentMessages);
  }

  if (grounded.surface === 'grocery' && groceryProposal) {
    return buildGroceryProposalCurrentObject(groceryProposal, recentMessages);
  }

  if (grounded.surface === 'conversation' && chatRecipe) {
    return buildChatRecipeCurrentObject(chatRecipe);
  }

  return null;
}

function extractCookbookTargetName(prompt = '') {
  const text = safeTrim(prompt);
  if (!text) return '';
  const patterns = [
    /^(?:please\s+)?(?:update|replace|revise|edit|delete|remove)\s+(.+?)\s+(?:in|from)\s+(?:our|my|the)\s+cookbook\b/i,
    /^(?:please\s+)?(?:update|replace|revise|edit|delete|remove)\s+(.+?)\s+recipe\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return safeTrim(match[1])
        .replace(/^["']|["']$/g, '')
        .replace(/^(?:the|our|my)\s+/i, '')
        .replace(/\s+recipe$/i, '');
    }
  }
  return '';
}

function findExplicitCookbookMatches(prompt = '', cookbookEntries = []) {
  const targetName = safeTrim(extractCookbookTargetName(prompt));
  if (!targetName) return [];
  return findCookbookMatches(Array.isArray(cookbookEntries) ? cookbookEntries.filter(Boolean) : [], targetName);
}

function promptClearlyRequestsChatRename(prompt = '') {
  const text = safeTrim(prompt).replace(/[.!?]+$/, '');
  if (!text) return false;
  return [
    /^(?:please\s+)?rename\s+(?:this|the)\s+chat(?:\s+to\s+.+)?$/i,
    /^(?:please\s+)?retitle\s+(?:this|the)\s+chat(?:\s+to\s+.+)?$/i,
    /^(?:please\s+)?call\s+(?:this|the)\s+chat\s+.+$/i,
    /^(?:please\s+)?name\s+(?:this|the)\s+chat\s+.+$/i,
    /^(?:please\s+)?title\s+(?:this|the)\s+chat\s+.+$/i,
  ].some((pattern) => pattern.test(text));
}

function buildWorkingContextObjects(workingContext, { includeMealThread = true } = {}) {
  const context = normalizeWorkingContext(workingContext);
  if (!context) return [];
  const objects = [];
  if (Array.isArray(context.offeredIngredients) && context.offeredIngredients.length > 0) {
    objects.push({
      type: 'offered_ingredients',
      label: 'Recently offered ingredients',
      items: context.offeredIngredients.slice(0, 24),
      source: 'working_context',
    });
  }
  if (safeTrim(context.offeredSearchTopic)) {
    objects.push({
      type: 'offered_search_topic',
      label: safeTrim(context.offeredSearchTopic),
      topic: safeTrim(context.offeredSearchTopic),
      source: 'working_context',
    });
  }
  if (safeTrim(context.linkedRecipeUrl) || safeTrim(context.linkedRecipeTitle)) {
    objects.push({
      type: 'linked_recipe',
      label: safeTrim(context.linkedRecipeTitle || context.linkedRecipeUrl || 'Linked recipe'),
      title: safeTrim(context.linkedRecipeTitle),
      url: safeTrim(context.linkedRecipeUrl),
      source: 'working_context',
    });
  }
  const mealIdeas = Array.isArray(context.mealIdeas) ? context.mealIdeas.map((item) => safeTrim(item)).filter(Boolean) : [];
  const subjectItems = Array.isArray(context.subjectItems) ? context.subjectItems.map((item) => safeTrim(item)).filter(Boolean) : [];
  if (includeMealThread && (mealIdeas.length > 0 || subjectItems.length > 0)) {
    objects.push({
      type: 'meal_plan_or_meal_set',
      label: safeTrim(context.topicSummary) || 'Active meal thread',
      mealIdeas: mealIdeas.slice(0, 12),
      subjectItems: subjectItems.slice(0, 12),
      source: 'working_context',
    });
  }
  return objects;
}

function buildCandidateObjects({
  recentMessages = [],
  activeSpeakerName = '',
  chatId = null,
  memoryContext = null,
  workingContext = null,
  includeMealThread = true,
  includeSurfaceObjects = false,
  surface = '',
} = {}) {
  const objects = [];
  if (Number.isFinite(Number(chatId))) {
    objects.push({
      type: 'chat_thread',
      id: Number(chatId),
      label: 'Current chat',
      source: 'chat_context',
    });
  }
  const activeChatRecipe = findLatestAssistantRecipe(recentMessages);
  if (activeChatRecipe) objects.push(activeChatRecipe);
  const activeMealSet = findLatestAssistantMealSet(recentMessages);
  if (activeMealSet) objects.push(activeMealSet);
  const activeGroceryProposal = findLatestAssistantGroceryProposal(recentMessages);
  if (activeGroceryProposal) objects.push(activeGroceryProposal);

  const selectedCookbookEntries = Array.isArray(memoryContext?.selectedCookbookEntries)
    ? memoryContext.selectedCookbookEntries.filter(Boolean)
    : [];
  if (selectedCookbookEntries.length === 1) {
    objects.push({
      type: 'cookbook_entry',
      id: Number(selectedCookbookEntries[0].id),
      label: safeTrim(selectedCookbookEntries[0].title),
      title: safeTrim(selectedCookbookEntries[0].title),
      source: 'selected_context',
    });
  }

  const explicitMatches = findExplicitCookbookMatches('', []);
  void explicitMatches;

  objects.push(...buildWorkingContextObjects(workingContext || memoryContext?.workingContext, { includeMealThread }));

  if (includeSurfaceObjects && safeTrim(surface) === 'grocery') {
    objects.push({ type: 'grocery_list', label: 'Household grocery list', source: 'surface_context' });
  }
  if (includeSurfaceObjects && safeTrim(surface) === 'pantry') {
    objects.push({ type: 'pantry_item_or_list', label: 'Household pantry', source: 'surface_context' });
  }
  if (includeSurfaceObjects && safeTrim(surface) === 'memory') {
    objects.push({
      type: 'memory_entity',
      label: safeTrim(memoryContext?.entityContext?.activeSpeakerLabel || activeSpeakerName || 'Household memory'),
      source: 'entity_context',
    });
  }
  if (includeSurfaceObjects && safeTrim(surface) === 'meal_plan') {
    const mealThread = buildWorkingContextObjects(workingContext || memoryContext?.workingContext, { includeMealThread: true })
      .find((object) => object.type === 'meal_plan_or_meal_set');
    if (mealThread) objects.push(mealThread);
  }
  if (includeSurfaceObjects && safeTrim(surface) === 'chat' && Number.isFinite(Number(chatId))) {
    objects.push({
      type: 'chat_thread',
      id: Number(chatId),
      label: 'Current chat',
      source: 'surface_context',
    });
  }

  return dedupeObjects(objects);
}

function pendingCapabilityToSurfaceAndIntent(runtimeProposedNextAction = null) {
  const capability = safeTrim(runtimeProposedNextAction?.action?.capability);
  switch (capability) {
    case 'recipe.revise':
      return { surface: 'conversation', intent: 'revise_recipe' };
    case 'cookbook.save':
      return { surface: 'cookbook', intent: 'save_recipe' };
    case 'cookbook.update':
      return { surface: 'cookbook', intent: 'update_saved_recipe' };
    case 'cookbook.list':
      return { surface: 'cookbook', intent: 'list_saved_recipes' };
    case 'cookbook.delete':
      return { surface: 'cookbook', intent: 'delete_saved_recipe' };
    case 'chat.rename':
      return { surface: 'chat', intent: 'rename_chat' };
    case 'grocery.write':
      return { surface: 'grocery', intent: 'add_grocery_items' };
    case 'grocery.remove':
      return { surface: 'grocery', intent: 'remove_grocery_items' };
    case 'grocery.check':
      return { surface: 'grocery', intent: 'check_grocery_items' };
    case 'grocery.uncheck':
      return { surface: 'grocery', intent: 'uncheck_grocery_items' };
    case 'grocery.clear':
      return { surface: 'grocery', intent: 'clear_grocery_list' };
    case 'pantry.add':
      return { surface: 'pantry', intent: 'add_pantry_items' };
    case 'pantry.remove':
      return { surface: 'pantry', intent: 'remove_pantry_items' };
    case 'pantry.move_to_grocery':
      return { surface: 'grocery', intent: 'move_pantry_to_grocery' };
    case 'grocery.move_to_pantry':
      return { surface: 'pantry', intent: 'move_grocery_to_pantry' };
    case 'memory.save':
      return { surface: 'memory', intent: 'save_memory' };
    case 'meal.refine':
      return { surface: 'meal_plan', intent: 'revise_meal_plan' };
    case 'web.search':
      return { surface: 'conversation', intent: 'search_web' };
    default:
      return { surface: 'conversation', intent: 'answer_question' };
  }
}

function promptLooksLikeFreshMealPlanDraft(prompt = '') {
  const text = safeTrim(prompt).toLowerCase();
  if (!text) return false;
  const soundsLikeRevision =
    /\b(revise|update|swap|replace|change|edit|make the .* instead|keep the rest)\b/.test(text);
  if (soundsLikeRevision) return false;

  const mealRequest =
    /\b(?:\d+|one|two|three|four|five)\s+(?:easy\s+|quick\s+|weeknight\s+)?(?:meal|meals|dinner|dinners)\b/.test(text) ||
    /\b(?:meal|meals|dinner|dinners)\b/.test(text);
  const planningVerb = /\b(plan|map out|come up with|give me|draft|figure out|build|need)\b/.test(text);
  const slotStructure =
    /\bone should\b/.test(text) ||
    /\banother should\b/.test(text) ||
    /\bthe other can\b/.test(text) ||
    /\bone can be\b/.test(text);
  const planningContext =
    /\b(out of town|grocery shopping|shopping tomorrow|for next week|this week|weeknight|easy meals?|easy dinners?)\b/.test(text) ||
    /\b(ignore .* cooking style|ignore our ambitious cooking style)\b/.test(text) ||
    /\belle can make\b/.test(text);

  return mealRequest && (planningVerb || slotStructure || planningContext);
}

function normalizeProvisionalGrounding(raw, fallback = {}) {
  const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const fallbackBase = fallback && typeof fallback === 'object' && !Array.isArray(fallback) ? fallback : {};
  const surface = safeTrim(base.surface || fallbackBase.surface || 'conversation');
  const intent = safeTrim(base.intent || fallbackBase.intent || 'answer_question');
  const candidateObjectTypes = dedupeStrings([...(fallbackBase.candidateObjectTypes || []), ...(base.candidateObjectTypes || [])]);
  return {
    surface: surface || 'conversation',
    intent: intent || 'answer_question',
    candidateObjectTypes,
    likelyAmbiguous: !!(base.likelyAmbiguous ?? fallbackBase.likelyAmbiguous),
    confidence: ['low', 'medium', 'high'].includes(safeTrim(base.confidence)) ? safeTrim(base.confidence) : safeTrim(fallbackBase.confidence || 'medium'),
    rationale: safeTrim(base.rationale || fallbackBase.rationale),
  };
}

function canonicalizeGroundingIntent(surface = '', intent = '') {
  const normalizedSurface = safeTrim(surface);
  const normalizedIntent = safeTrim(intent);
  const intentKey = normalizeTextKey(normalizedIntent);
  if (normalizedSurface === 'cookbook') {
    const intentWords = new Set(intentKey.split(/\s+/).filter(Boolean));
    const hasWord = (word) => intentWords.has(word);
    if (intentKey === 'save recipe') return 'save_recipe';
    if (
      (hasWord('save') || hasWord('add') || hasWord('store') || hasWord('keep')) &&
      (intentKey.includes('cookbook') || intentKey.includes('saved recipe') || intentKey.includes('saved meal'))
    ) {
      return 'save_recipe';
    }
    if (
      (hasWord('update') || hasWord('replace') || hasWord('revise') || hasWord('edit')) &&
      (intentKey.includes('cookbook') || intentKey.includes('saved recipe') || intentKey.includes('saved meal'))
    ) {
      return 'update_saved_recipe';
    }
    if (hasWord('list') && (intentKey.includes('cookbook') || intentKey.includes('saved recipe'))) {
      return 'list_saved_recipes';
    }
    if (
      (hasWord('delete') || hasWord('remove')) &&
      (intentKey.includes('cookbook') || intentKey.includes('saved recipe') || intentKey.includes('saved meal'))
    ) {
      return 'delete_saved_recipe';
    }
    return normalizedIntent;
  }
  if (normalizedSurface === 'meal_plan') {
    if (intentKey === 'revise meal plan') return 'revise_meal_plan';
    const wantsMealPlanning =
      intentKey.includes('meal plan') ||
      intentKey.includes('dinner plan') ||
      intentKey.includes('weeknight dinner') ||
      intentKey.includes('weekly dinner') ||
      intentKey.includes('plan dinners') ||
      intentKey.includes('plan meals');
    if (wantsMealPlanning) {
      return 'revise_meal_plan';
    }
    return normalizedIntent;
  }
  if (normalizedSurface === 'grocery') {
    if (intentKey === 'add grocery items') return 'add_grocery_items';
    if (intentKey === 'remove grocery items') return 'remove_grocery_items';
    if (intentKey === 'check grocery items') return 'check_grocery_items';
    if (intentKey === 'uncheck grocery items') return 'uncheck_grocery_items';
    if (intentKey === 'clear grocery list') return 'clear_grocery_list';
    if (intentKey.includes('move') && intentKey.includes('pantry')) {
      return intentKey.includes('to grocery') ? 'move_pantry_to_grocery' : 'move_grocery_to_pantry';
    }
    const looksLikeGroceryListMutation =
      (
        intentKey.includes('grocery list') ||
        intentKey.includes('shopping list') ||
        intentKey.includes('to grocery') ||
        intentKey.includes('to the grocery')
      ) &&
      (
        intentKey.includes('add') ||
        intentKey.includes('write') ||
        intentKey.includes('update') ||
        intentKey.includes('ingredient') ||
        intentKey.includes('proposed list')
      );
    if (looksLikeGroceryListMutation) return 'add_grocery_items';
    return normalizedIntent;
  }
  return normalizedIntent;
}

export function normalizeGroundedTurn(raw, fallback = {}) {
  const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const fallbackBase = fallback && typeof fallback === 'object' && !Array.isArray(fallback) ? fallback : {};
  const turnMode = safeTrim(base.turnMode || fallbackBase.turnMode || 'reply_only');
  const surface = safeTrim(base.surface || fallbackBase.surface || 'conversation');
  const intent = canonicalizeGroundingIntent(surface, safeTrim(base.intent || fallbackBase.intent || 'answer_question'));
  return {
    turnMode: ['reply_only', 'execute_action', 'clarify'].includes(turnMode) ? turnMode : 'reply_only',
    surface: surface || 'conversation',
    intent: intent || 'answer_question',
    entities: {
      ...(fallbackBase.entities && typeof fallbackBase.entities === 'object' ? fallbackBase.entities : {}),
      ...(base.entities && typeof base.entities === 'object' ? base.entities : {}),
    },
    activeObjects: dedupeObjects([...(fallbackBase.activeObjects || []), ...(base.activeObjects || [])]),
    currentObject:
      clonePlainObject(base.currentObject) ||
      clonePlainObject(fallbackBase.currentObject) ||
      null,
    clarifyChoices: dedupeObjects([...(fallbackBase.clarifyChoices || []), ...(base.clarifyChoices || [])]),
    confidence: ['low', 'medium', 'high'].includes(safeTrim(base.confidence)) ? safeTrim(base.confidence) : safeTrim(fallbackBase.confidence || 'medium'),
    rationale: safeTrim(base.rationale || fallbackBase.rationale),
    clarifyQuestion: safeTrim(base.clarifyQuestion || fallbackBase.clarifyQuestion),
  };
}

function candidateObjectTypesFromObjects(objects = []) {
  return dedupeStrings((Array.isArray(objects) ? objects : []).map((object) => safeTrim(object?.type)).filter(Boolean));
}

function buildGroundingFallback({
  runtimeProposedNextAction = null,
  recentMessages = [],
  memoryContext = null,
  workingContext = null,
  activeSpeakerName = '',
  chatId = null,
} = {}) {
  const pending = pendingCapabilityToSurfaceAndIntent(runtimeProposedNextAction);
  const candidateObjects = buildCandidateObjects({
    recentMessages,
    activeSpeakerName,
    chatId,
    memoryContext,
    workingContext,
    includeMealThread: true,
    includeSurfaceObjects: false,
  });
  return {
    surface: pending.surface,
    intent: pending.intent,
    candidateObjectTypes: candidateObjectTypesFromObjects(candidateObjects),
    likelyAmbiguous: false,
    confidence: runtimeProposedNextAction ? 'high' : 'low',
    rationale: runtimeProposedNextAction ? 'pending_action' : 'fallback',
  };
}

function summarizeCandidateObjects(objects = []) {
  const list = (Array.isArray(objects) ? objects : [])
    .slice(0, 10)
    .map((object) => ({
      type: safeTrim(object?.type),
      label: safeTrim(object?.label || object?.title || object?.name),
      id: Number.isFinite(Number(object?.id)) ? Number(object.id) : undefined,
      source: safeTrim(object?.source),
    }))
    .filter((object) => object.type);
  return list;
}

async function runGroundingModel({
  anthropic,
  req,
  chatId,
  turnId = '',
  prompt = '',
  system = '',
  payload = {},
  callPurpose = '',
}) {
  if (!anthropic) return null;
  const response = await createLoggedAnthropicMessage(
    anthropic,
    {
      model: resolveAnthropicModelForCallPurpose(callPurpose),
      max_tokens: 320,
      system,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    },
    {
      householdId: req?.householdId,
      chatId,
      turnId: turnId || null,
      prompt,
      runtimeEnabled: true,
      callSurface: 'chat',
      callPurpose,
      webSearchEnabledAtCall: !!req?.kbCapabilities?.webSearchEnabled,
      usedWebSearchTool: false,
    }
  );
  const raw = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
  return parseJsonObject(raw);
}

export async function groundTurnProvisional({
  anthropic,
  req,
  chatId,
  turnId = '',
  prompt = '',
  recentMessages = [],
  activeSpeakerName = '',
  memoryContext = null,
  workingContext = null,
  runtimeProposedNextAction = null,
  deps = {},
} = {}) {
  const entitySnapshot = buildEntitySnapshot(memoryContext, activeSpeakerName);
  const candidateObjects = buildCandidateObjects({
    recentMessages,
    activeSpeakerName,
    chatId,
    memoryContext,
    workingContext,
    includeMealThread: true,
    includeSurfaceObjects: false,
  });
  const fallback = buildGroundingFallback({
    runtimeProposedNextAction,
    recentMessages,
    memoryContext,
    workingContext,
    activeSpeakerName,
    chatId,
  });
  const parsed = await runGroundingModel({
    anthropic,
    req,
    chatId,
    turnId,
    prompt,
    callPurpose: 'kb_turn_grounding_provisional',
    system: `You are KitchenBot's provisional turn grounding model.

Decide the likely app surface and likely intent for this turn before full retrieval.

Return ONLY JSON:
{"surface":"conversation|chat|cookbook|grocery|pantry|memory|meal_plan","intent":"...","candidateObjectTypes":["chat_thread|chat_recipe|cookbook_entry|grocery_list|grocery_proposal|pantry_item_or_list|memory_entity|meal_plan_or_meal_set|offered_ingredients|offered_search_topic|linked_recipe"],"likelyAmbiguous":true|false,"confidence":"low|medium|high","rationale":"..."}

Rules:
- Use the latest visible conversation over stale continuity.
- Treat a bounded pending action as a continuation hint, not a hidden workflow.
- Prefer conversation when the user is asking a question, asking for advice, or recalling a recipe.
- Choose chat when the user explicitly wants to rename or retitle the current chat.
- If the user says "rename this chat" or "rename this chat to X", that is a chat rename action.
- Choose cookbook only for explicit saved-recipe operations or cookbook questions.
- Choose grocery or pantry only when the user is actually talking about those app surfaces.
- Choose memory only when the user is discussing saving or asking about memory/preference behavior.
- Choose meal_plan only when the user is actively revising or asking for meal planning, not just cooking a previously mentioned dish tonight.`,
    payload: {
      prompt: safeTrim(prompt),
      activeSpeaker: entitySnapshot.activeSpeakerLabel || entitySnapshot.activeSpeakerName,
      mentionedPeople: entitySnapshot.mentionedPeople,
      householdRelevant: entitySnapshot.householdRelevant,
      pendingAction: runtimeProposedNextAction || null,
      recentConversation: formatKbRecentConversation(recentMessages, deps, {
        limit: 10,
        assistantPersona: memoryContext?.assistantPersona,
      }) || '(none)',
      candidateObjects: summarizeCandidateObjects(candidateObjects),
    },
  }).catch(() => null);

  if (promptClearlyRequestsChatRename(prompt)) {
    return normalizeProvisionalGrounding({
      surface: 'chat',
      intent: 'rename_chat',
      candidateObjectTypes: ['chat_thread'],
      likelyAmbiguous: false,
      confidence: 'high',
      rationale: 'explicit_chat_rename',
    }, fallback);
  }

  return normalizeProvisionalGrounding(parsed, fallback);
}

function filterActiveObjectsForGrounding({ candidateObjects = [], surface = '' } = {}) {
  const normalizedSurface = safeTrim(surface);
  const keepTypes = new Set();
  if (normalizedSurface === 'conversation') {
    ['chat_recipe', 'cookbook_entry', 'linked_recipe', 'offered_ingredients', 'offered_search_topic', 'meal_plan_or_meal_set', 'grocery_proposal'].forEach((type) => keepTypes.add(type));
  } else if (normalizedSurface === 'chat') {
    ['chat_thread'].forEach((type) => keepTypes.add(type));
  } else if (normalizedSurface === 'cookbook') {
    ['chat_recipe', 'cookbook_entry', 'linked_recipe'].forEach((type) => keepTypes.add(type));
  } else if (normalizedSurface === 'grocery') {
    ['offered_ingredients', 'offered_search_topic', 'linked_recipe', 'meal_plan_or_meal_set', 'grocery_proposal', 'chat_recipe'].forEach((type) => keepTypes.add(type));
  } else if (normalizedSurface === 'meal_plan') {
    ['meal_plan_or_meal_set', 'chat_recipe', 'cookbook_entry'].forEach((type) => keepTypes.add(type));
  }
  return dedupeObjects((Array.isArray(candidateObjects) ? candidateObjects : []).filter((object) => keepTypes.has(safeTrim(object?.type))));
}

function explicitCookbookClarifyQuestion(intent = '') {
  switch (safeTrim(intent)) {
    case 'delete_saved_recipe':
      return 'Which saved cookbook recipe do you want me to delete?';
    case 'update_saved_recipe':
      return 'Which saved cookbook recipe do you want me to update?';
    default:
      return 'Which saved cookbook recipe do you mean?';
  }
}

function fallbackClarifyQuestion({ surface = '', intent = '' } = {}) {
  if (surface === 'conversation' && intent === 'revise_recipe') return 'Which recipe do you want me to revise?';
  if (surface === 'meal_plan' && intent === 'revise_meal_plan') return 'What meals or dinner ideas do you want me to revise?';
  if (surface === 'memory' && intent === 'save_memory') return 'What do you want me to remember, and who should it be about?';
  if (surface === 'chat' && intent === 'rename_chat') return 'What should I rename this chat to?';
  if (surface === 'cookbook' && intent === 'update_saved_recipe') return 'Which saved cookbook recipe do you want me to update?';
  if (surface === 'cookbook' && intent === 'delete_saved_recipe') return 'Which saved cookbook recipe do you want me to delete?';
  return 'Can you clarify what you want me to do?';
}

export async function groundTurnFinal({
  anthropic,
  req,
  chatId,
  turnId = '',
  prompt = '',
  recentMessages = [],
  activeSpeakerName = '',
  memoryContext = null,
  workingContext = null,
  runtimeProposedNextAction = null,
  provisionalGrounding = null,
  deps = {},
} = {}) {
  const entitySnapshot = buildEntitySnapshot(memoryContext, activeSpeakerName);
  const candidateObjects = buildCandidateObjects({
    recentMessages,
    activeSpeakerName,
    chatId,
    memoryContext,
    workingContext,
    includeMealThread: true,
    includeSurfaceObjects: false,
  });
  const cookbookEntries = Array.isArray(memoryContext?.cookbookEntries) ? memoryContext.cookbookEntries : [];
  const cookbookMatches = findExplicitCookbookMatches(prompt, cookbookEntries);
  const fallbackBase = normalizeProvisionalGrounding(provisionalGrounding, buildGroundingFallback({
    runtimeProposedNextAction,
    recentMessages,
    memoryContext,
    workingContext,
    activeSpeakerName,
    chatId,
  }));

  const sections = getKbPromptContextSections(memoryContext || {});
  const parsed = await runGroundingModel({
    anthropic,
    req,
    chatId,
    turnId,
    prompt,
    callPurpose: 'kb_turn_grounding_final',
    system: `You are KitchenBot's final turn grounding model.

Your job is to decide:
- whether KitchenBot should reply, act, or clarify
- which app surface the user means
- which high-level intent best describes the turn

Return ONLY JSON:
{"turnMode":"reply_only|execute_action|clarify","surface":"conversation|chat|cookbook|grocery|pantry|memory|meal_plan","intent":"...","confidence":"low|medium|high","rationale":"...","clarifyQuestion":"optional"}

Rules:
- Fresh visible conversation beats stale continuity.
- A bounded pending action is only a continuation hint.
- Do not choose a mutation just because a verb like "add" or "remember" appears.
- Memory advisory questions stay reply_only unless the user explicitly asks to save.
- Chat rename requests are for the current chat and should use the chat surface.
- If the user says "rename this chat" or "rename this chat to X", that is an execute_action on the chat surface.
- A fresh cooking turn about tonight or "what do I do first?" is usually conversation, not meal_plan.
- Cookbook mutations are for saved entries; recipe tweaks in the current conversation stay on the conversation surface.
- If ambiguity remains and a safe action requires a target, choose clarify.
- The candidate objects below are the only concrete objects already in view. Prefer them over guessing invisible targets.`,
    payload: {
      prompt: safeTrim(prompt),
      activeSpeaker: entitySnapshot.activeSpeakerLabel || entitySnapshot.activeSpeakerName,
      mentionedPeople: entitySnapshot.mentionedPeople,
      householdRelevant: entitySnapshot.householdRelevant,
      pendingAction: runtimeProposedNextAction || null,
      provisionalGrounding: fallbackBase,
      candidateObjects: summarizeCandidateObjects(candidateObjects),
      explicitCookbookMatches: cookbookMatches.map((entry) => ({ id: Number(entry.id), title: safeTrim(entry.title) })),
      recentConversation: formatKbRecentConversation(recentMessages, deps, {
        limit: 12,
        assistantPersona: memoryContext?.assistantPersona,
      }) || '(none)',
      relevantMemory: sections.relevantMemory,
      appliedMemory: sections.appliedMemory,
      householdDefaults: sections.appliedHouseholdDefaults,
      cookbookEntries: sections.cookbookEntries,
      pantryItems: sections.pantryItems,
      groceryItems: sections.groceryItems,
      workingContext: sections.appliedWorkingContext,
      pendingActionText: sections.pendingAction,
    },
  }).catch(() => null);

  if (promptClearlyRequestsChatRename(prompt)) {
    return normalizeGroundedTurn({
      turnMode: 'execute_action',
      surface: 'chat',
      intent: 'rename_chat',
      confidence: 'high',
      rationale: 'explicit_chat_rename',
      entities: entitySnapshot,
      activeObjects: candidateObjects.filter((object) => safeTrim(object?.type) === 'chat_thread'),
    }, fallbackBase);
  }

  let grounded = normalizeGroundedTurn(parsed, {
    turnMode: fallbackBase.intent === 'answer_question' ? 'reply_only' : 'execute_action',
    surface: fallbackBase.surface,
    intent: fallbackBase.intent,
    confidence: fallbackBase.confidence,
    rationale: fallbackBase.rationale,
    entities: entitySnapshot,
  });

  let activeObjects = filterActiveObjectsForGrounding({ candidateObjects, surface: grounded.surface });
  activeObjects = dedupeObjects([
    ...activeObjects,
    ...buildCandidateObjects({
      recentMessages,
      activeSpeakerName,
      chatId,
      memoryContext,
      workingContext,
      includeMealThread: grounded.surface === 'meal_plan',
      includeSurfaceObjects: true,
      surface: grounded.surface,
    }).filter((object) => ['grocery_list', 'pantry_item_or_list', 'memory_entity', 'meal_plan_or_meal_set'].includes(safeTrim(object?.type))),
  ]);

  let clarifyChoices = [];
  let clarifyQuestion = safeTrim(grounded.clarifyQuestion);

  if (
    grounded.surface === 'cookbook' &&
    ['update_saved_recipe', 'delete_saved_recipe'].includes(grounded.intent) &&
    cookbookMatches.length > 1
  ) {
    grounded = normalizeGroundedTurn(
      {
        ...grounded,
        turnMode: 'clarify',
        confidence: 'high',
      },
      grounded
    );
    clarifyChoices = cookbookMatches.slice(0, 6).map((entry) => ({
      type: 'cookbook_entry',
      id: Number(entry.id),
      label: safeTrim(entry.title),
    }));
    clarifyQuestion = clarifyQuestion || explicitCookbookClarifyQuestion(grounded.intent);
  }

  if (grounded.turnMode === 'execute_action' && grounded.surface === 'conversation' && grounded.intent === 'revise_recipe') {
    const hasRecipeTarget = activeObjects.some((object) => ['chat_recipe', 'cookbook_entry', 'linked_recipe'].includes(safeTrim(object?.type)));
    if (!hasRecipeTarget) {
      grounded = normalizeGroundedTurn({ ...grounded, turnMode: 'clarify', confidence: 'high' }, grounded);
      clarifyQuestion = clarifyQuestion || fallbackClarifyQuestion(grounded);
    }
  }

  if (grounded.turnMode === 'execute_action' && grounded.surface === 'meal_plan' && grounded.intent === 'revise_meal_plan') {
    const hasMealThread = activeObjects.some((object) => safeTrim(object?.type) === 'meal_plan_or_meal_set');
    if (!hasMealThread) {
      if (promptLooksLikeFreshMealPlanDraft(prompt)) {
        grounded = normalizeGroundedTurn({ ...grounded, turnMode: 'reply_only', confidence: 'medium' }, grounded);
      } else {
        grounded = normalizeGroundedTurn({ ...grounded, turnMode: 'clarify', confidence: 'high' }, grounded);
        clarifyQuestion = clarifyQuestion || fallbackClarifyQuestion(grounded);
      }
    }
  }

  const derivedCurrentObject = deriveCurrentObject({
    prompt,
    recentMessages,
    groundedTurn: {
      ...grounded,
      activeObjects,
    },
    memoryContext,
    workingContext,
  });

  if (
    grounded.turnMode === 'execute_action' &&
    grounded.surface === 'grocery' &&
    grounded.intent === 'add_grocery_items' &&
    safeTrim(derivedCurrentObject?.objectType) === 'meal_set' &&
    promptHasSubsetSignal(prompt)
  ) {
    grounded = normalizeGroundedTurn({ ...grounded, turnMode: 'clarify', confidence: 'high' }, grounded);
    clarifyQuestion = clarifyQuestion || 'Which meals from the current plan do you want me to add to the Grocery List tab?';
  }

  if (grounded.turnMode === 'clarify' && !clarifyQuestion) {
    clarifyQuestion = fallbackClarifyQuestion(grounded);
  }

  return normalizeGroundedTurn({
    ...grounded,
    entities: entitySnapshot,
    activeObjects,
    currentObject: derivedCurrentObject,
    clarifyChoices,
    clarifyQuestion,
  }, grounded);
}

export function buildGroundedContextProfile({ groundedTurn = null, provisionalGrounding = null, runtimeProposedNextAction = null, workingContext = null } = {}) {
  const grounded = groundedTurn ? normalizeGroundedTurn(groundedTurn) : null;
  const provisional = normalizeProvisionalGrounding(provisionalGrounding, grounded || {});
  const surface = safeTrim(grounded?.surface || provisional.surface);
  const intent = safeTrim(grounded?.intent || provisional.intent);
  const rawIntentText = dedupeStrings([safeTrim(grounded?.intent), safeTrim(provisional.intent)])
    .map((value) => normalizeTextKey(value))
    .join(' ')
    .toLowerCase();
  const objectTypes = grounded
    ? candidateObjectTypesFromObjects(grounded.activeObjects)
    : dedupeStrings(provisional.candidateObjectTypes || []);
  const working = normalizeWorkingContext(workingContext);
  const includeWorkingContext =
    !!runtimeProposedNextAction ||
    objectTypes.some((type) => ['offered_ingredients', 'offered_search_topic', 'linked_recipe', 'meal_plan_or_meal_set'].includes(type)) ||
    !!working;

  const explicitCookbookRecall =
    surface === 'cookbook' ||
    ['update_saved_recipe', 'save_recipe', 'list_saved_recipes', 'delete_saved_recipe'].includes(intent) ||
    /\b(cookbook|saved recipes?|saved meals?|favorites?)\b/.test(rawIntentText) ||
    objectTypes.some((type) => ['cookbook_entry', 'linked_recipe'].includes(type));

  const includeCookbook =
    explicitCookbookRecall;

  const includeGrocery =
    surface === 'grocery' ||
    ['add_grocery_items', 'remove_grocery_items', 'check_grocery_items', 'uncheck_grocery_items', 'clear_grocery_list', 'move_pantry_to_grocery'].includes(intent);

  const includePantry =
    surface === 'pantry' ||
    surface === 'grocery' ||
    ['add_pantry_items', 'remove_pantry_items', 'move_grocery_to_pantry', 'move_pantry_to_grocery'].includes(intent);

  const includeDefaults =
    surface === 'meal_plan' ||
    surface === 'grocery' ||
    ['revise_meal_plan', 'add_grocery_items'].includes(intent) ||
    safeTrim(grounded?.rationale || provisional.rationale).includes('defaults');

  return {
    includeDefaults,
    includePantry,
    includeGrocery,
    includeCookbook,
    includeWorkingContext,
  };
}

export function formatGroundedTurnText(groundedTurn = null) {
  const grounded = normalizeGroundedTurn(groundedTurn);
  const lines = [
    `Turn mode: ${grounded.turnMode}`,
    `Surface: ${grounded.surface || 'conversation'}`,
    `Intent: ${grounded.intent || 'answer_question'}`,
    `Confidence: ${grounded.confidence || 'medium'}`,
  ];
  const speaker = safeTrim(grounded.entities?.activeSpeakerLabel || grounded.entities?.activeSpeakerName);
  if (speaker) lines.push(`Active speaker: ${speaker}`);
  const mentioned = Array.isArray(grounded.entities?.mentionedPeople) ? grounded.entities.mentionedPeople.filter(Boolean) : [];
  if (mentioned.length > 0) lines.push(`Mentioned people: ${mentioned.join(', ')}`);
  const objects = Array.isArray(grounded.activeObjects) ? grounded.activeObjects : [];
  if (objects.length > 0) {
    lines.push('Active objects:');
    for (const object of objects.slice(0, 8)) {
      const label = safeTrim(object.label || object.title || object.name || object.type);
      const source = safeTrim(object.source);
      lines.push(`- ${safeTrim(object.type)}: ${label}${source ? ` (${source})` : ''}`);
    }
  } else {
    lines.push('Active objects: (none)');
  }
  if (grounded.currentObject && typeof grounded.currentObject === 'object') {
    lines.push(`Current object: ${safeTrim(grounded.currentObject.objectType)} - ${safeTrim(grounded.currentObject.versionSummary)}`);
  }
  const choices = Array.isArray(grounded.clarifyChoices) ? grounded.clarifyChoices : [];
  if (choices.length > 0) {
    lines.push('Clarify choices:');
    for (const choice of choices.slice(0, 8)) {
      lines.push(`- ${safeTrim(choice.type)}: ${safeTrim(choice.label)}`);
    }
  }
  if (safeTrim(grounded.clarifyQuestion)) lines.push(`Clarify question: ${safeTrim(grounded.clarifyQuestion)}`);
  if (safeTrim(grounded.rationale)) lines.push(`Rationale: ${safeTrim(grounded.rationale)}`);
  return lines.join('\n');
}
