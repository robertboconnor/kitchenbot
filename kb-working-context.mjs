import { getMessages } from './db.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

function sanitizeList(items, limit = 6) {
  const seen = new Set();
  const list = [];
  for (const item of Array.isArray(items) ? items : []) {
    const text = safeTrim(item).replace(/\s+/g, ' ').slice(0, 120);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    list.push(text);
    if (list.length >= limit) break;
  }
  return list;
}

export function normalizeWorkingContext(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const topicSummary = safeTrim(raw.topicSummary).slice(0, 240);
  const mealIdeas = sanitizeList(raw.mealIdeas);
  const subjectItems = sanitizeList(raw.subjectItems);
  const activeConstraints = sanitizeList(raw.activeConstraints);
  const groceryFocus = sanitizeList(raw.groceryFocus);
  const offeredIngredients = sanitizeList(raw.offeredIngredients, 12);
  const offeredSearchTopic = safeTrim(raw.offeredSearchTopic).slice(0, 240);
  const linkedRecipeUrl = safeTrim(raw.linkedRecipeUrl).slice(0, 1000);
  const linkedRecipeTitle = safeTrim(raw.linkedRecipeTitle).slice(0, 160);
  const linkedRecipeFetchStatus = safeTrim(raw.linkedRecipeFetchStatus).slice(0, 80);
  const linkedRecipeFailureReason = safeTrim(raw.linkedRecipeFailureReason).slice(0, 280);
  const linkedRecipeSuggestedRecoveryAction = safeTrim(raw.linkedRecipeSuggestedRecoveryAction).slice(0, 80);
  const linkedRecipeFetchBlocked = !!raw.linkedRecipeFetchBlocked;
  const linkedRecipeBlockerKind = safeTrim(raw.linkedRecipeBlockerKind).slice(0, 80);
  const linkedRecipeFailureKind = safeTrim(raw.linkedRecipeFailureKind).slice(0, 80);
  const linkedRecipeHttpStatus = Number(raw.linkedRecipeHttpStatus) || 0;
  if (
    !topicSummary &&
    mealIdeas.length === 0 &&
    subjectItems.length === 0 &&
    activeConstraints.length === 0 &&
    groceryFocus.length === 0 &&
    offeredIngredients.length === 0 &&
    !offeredSearchTopic &&
    !linkedRecipeUrl &&
    !linkedRecipeTitle &&
    !linkedRecipeFetchStatus &&
    !linkedRecipeFailureReason &&
    !linkedRecipeSuggestedRecoveryAction &&
    !linkedRecipeFetchBlocked &&
    !linkedRecipeBlockerKind &&
    !linkedRecipeFailureKind &&
    !linkedRecipeHttpStatus
  ) {
    return null;
  }
  return {
    topicSummary,
    mealIdeas,
    subjectItems,
    activeConstraints,
    groceryFocus,
    offeredIngredients,
    offeredSearchTopic: offeredSearchTopic || '',
    linkedRecipeUrl: linkedRecipeUrl || '',
    linkedRecipeTitle: linkedRecipeTitle || '',
    linkedRecipeFetchStatus: linkedRecipeFetchStatus || '',
    linkedRecipeFailureReason: linkedRecipeFailureReason || '',
    linkedRecipeSuggestedRecoveryAction: linkedRecipeSuggestedRecoveryAction || '',
    linkedRecipeFetchBlocked,
    linkedRecipeBlockerKind: linkedRecipeBlockerKind || '',
    linkedRecipeFailureKind: linkedRecipeFailureKind || '',
    linkedRecipeHttpStatus,
    refreshedAt: new Date().toISOString(),
  };
}

export function selectContinuationWorkingContext(workingContext) {
  const context = normalizeWorkingContext(workingContext);
  if (!context) return null;
  return normalizeWorkingContext({
    offeredIngredients: Array.isArray(context.offeredIngredients) ? context.offeredIngredients : [],
    offeredSearchTopic: safeTrim(context.offeredSearchTopic),
    linkedRecipeUrl: safeTrim(context.linkedRecipeUrl),
    linkedRecipeTitle: safeTrim(context.linkedRecipeTitle),
    linkedRecipeFetchStatus: safeTrim(context.linkedRecipeFetchStatus),
    linkedRecipeFailureReason: safeTrim(context.linkedRecipeFailureReason),
    linkedRecipeSuggestedRecoveryAction: safeTrim(context.linkedRecipeSuggestedRecoveryAction),
    linkedRecipeFetchBlocked: !!context.linkedRecipeFetchBlocked,
    linkedRecipeBlockerKind: safeTrim(context.linkedRecipeBlockerKind),
    linkedRecipeFailureKind: safeTrim(context.linkedRecipeFailureKind),
    linkedRecipeHttpStatus: Number(context.linkedRecipeHttpStatus) || 0,
  });
}

export function formatWorkingContextText(workingContext) {
  const context = normalizeWorkingContext(workingContext);
  if (!context) return '(none)';
  const parts = [];
  if (context.topicSummary) parts.push(`Current meal/grocery thread: ${context.topicSummary}`);
  if (context.mealIdeas.length > 0) parts.push(`Meals or dishes under discussion: ${context.mealIdeas.join('; ')}`);
  if (context.subjectItems.length > 0) parts.push(`Current dishes, drinks, or recipes under discussion: ${context.subjectItems.join('; ')}`);
  if (context.activeConstraints.length > 0) {
    parts.push(`Current constraints in this chat: ${context.activeConstraints.join('; ')}`);
  }
  if (context.groceryFocus.length > 0) {
    parts.push(`Grocery-relevant focus: ${context.groceryFocus.join('; ')}`);
  }
  if (context.offeredIngredients.length > 0) {
    parts.push(`Most recently offered ingredients: ${context.offeredIngredients.join('; ')}`);
  }
  if (context.offeredSearchTopic) {
    parts.push(`Most recently offered search topic: ${context.offeredSearchTopic}`);
  }
  if (context.linkedRecipeUrl || context.linkedRecipeFetchStatus || context.linkedRecipeFailureReason) {
    parts.push(
      [
        context.linkedRecipeTitle ? `Linked recipe title: ${context.linkedRecipeTitle}` : '',
        context.linkedRecipeUrl ? `Linked recipe URL: ${context.linkedRecipeUrl}` : '',
        context.linkedRecipeFetchStatus ? `Linked recipe fetch status: ${context.linkedRecipeFetchStatus}` : '',
        context.linkedRecipeFailureReason ? `Linked recipe failure reason: ${context.linkedRecipeFailureReason}` : '',
        context.linkedRecipeSuggestedRecoveryAction
          ? `Linked recipe suggested recovery action: ${context.linkedRecipeSuggestedRecoveryAction}`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }
  return parts.join('\n') || '(none)';
}

export function formatAppliedWorkingContextText(workingContext) {
  const context = normalizeWorkingContext(workingContext);
  if (!context) return '(none)';
  const parts = ['Use this only as lightweight short-term continuity for immediately recent follow-ups.'];
  if (context.mealIdeas.length > 0) {
    parts.push(`Recent meal or dish ideas still in the conversation: ${context.mealIdeas.join('; ')}.`);
  }
  if (context.subjectItems.length > 0) {
    parts.push(`Recent dishes, drinks, or recipes mentioned near the current turn: ${context.subjectItems.join('; ')}.`);
  }
  if (context.activeConstraints.length > 0) {
    parts.push(`Active refinements to honor: ${context.activeConstraints.join('; ')}.`);
  }
  if (context.groceryFocus.length > 0) {
    parts.push(`If groceries are requested, start from: ${context.groceryFocus.join('; ')}.`);
  }
  if (context.offeredIngredients.length > 0) {
    parts.push(`If the user clearly refers back to the offered ingredient set as "them", "those", "all of that", or explicitly asks to add those items to the Grocery List tab, treat these offered ingredients as the likely target: ${context.offeredIngredients.join('; ')}.`);
  }
  if (context.offeredSearchTopic) {
    parts.push(`If the user says "search that", "just that", or similar, treat this as the likely search topic: ${context.offeredSearchTopic}.`);
  }
  if (context.linkedRecipeUrl || context.linkedRecipeFetchStatus || context.linkedRecipeFailureReason) {
    parts.push('Use any linked-recipe fetch details below as factual provenance for follow-up questions about whether a URL was actually read.');
    if (context.linkedRecipeTitle) parts.push(`Linked recipe title: ${context.linkedRecipeTitle}.`);
    if (context.linkedRecipeUrl) parts.push(`Linked recipe URL: ${context.linkedRecipeUrl}.`);
    if (context.linkedRecipeFetchStatus) parts.push(`Linked recipe fetch status: ${context.linkedRecipeFetchStatus}.`);
    if (context.linkedRecipeFailureReason) parts.push(`Linked recipe failure reason: ${context.linkedRecipeFailureReason}.`);
    if (context.linkedRecipeSuggestedRecoveryAction) {
      parts.push(`Linked recipe suggested recovery action: ${context.linkedRecipeSuggestedRecoveryAction}.`);
    }
  }
  return parts.join('\n');
}

function isReferentialFollowUp(prompt) {
  const text = safeTrim(prompt).toLowerCase();
  if (!text) return false;
  return /\b(this|that|those|these|it|them)\b/.test(text) || /\bone of those\b/.test(text);
}

export function isMealGroceryRelevantTurn({ prompt = '', outcomes = [], workingContext = null } = {}) {
  const text = safeTrim(prompt).toLowerCase();
  const hasRelevantOutcome = (Array.isArray(outcomes) ? outcomes : []).some((outcome) => {
    const capability = safeTrim(outcome?.capability || outcome?.narrationType);
    return capability === 'grocery.preview' || capability === 'grocery.write' || capability === 'meal.refine' || capability === 'web.search';
  });
  if (hasRelevantOutcome) return true;
  if (!text) return false;

  const broadCulinaryIntent =
    /\b(grocery|groceries|shopping list|grocery list|pantry|cookbook|recipe|recipes|ingredients|instructions|directions|cook|cooking|meal|meals|dinner|dinners|lunch|breakfast|dish|dishes|menu|menus|drink|drinks|cocktail|cocktails)\b/;
  if (broadCulinaryIntent.test(text)) return true;

  if (normalizeWorkingContext(workingContext) && isReferentialFollowUp(text)) return true;
  if (normalizeWorkingContext(workingContext) && /\b(show me|make it|make one|add them|search that|just that)\b/.test(text)) {
    return true;
  }
  return false;
}

