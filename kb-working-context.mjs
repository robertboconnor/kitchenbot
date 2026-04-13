import { getMessages } from './db.mjs';
import { createLoggedAnthropicMessage } from './anthropic-usage.mjs';
import { resolveAnthropicModelForCallPurpose } from './anthropic-model-policy.mjs';

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

function formatRecentConversation(messages, deps) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-10)
    .map((message) =>
      message.role === 'user'
        ? `${message.name}: ${safeTrim(message.content)}`
        : `KitchenBot: ${safeTrim(deps.stripStoredMessageContentForDisplay?.(message.content) ?? message.content)}`
    )
    .filter(Boolean)
    .join('\n\n');
}

function extractLikelyDishPhrase(text) {
  const cleaned = safeTrim(
    String(text ?? '')
      .replace(/^[-*]\s*/, '')
      .replace(/^\d+\.\s*/, '')
      .replace(/\*\*/g, '')
  );
  if (!cleaned) return '';
  return safeTrim(
    cleaned
      .split(/\s+(?:with|served|topped|plus|alongside|paired with|finished with)\s+/i)[0]
      .replace(/[—–-]\s.*$/, '')
      .replace(/[.?!]\s.*$/, '')
  ).slice(0, 120);
}

function extractMealIdeasFromAssistantMessage(content) {
  const ideas = [];
  const lines = String(content ?? '').split(/\n+/);
  for (const rawLine of lines) {
    const line = safeTrim(rawLine);
    if (!line) continue;
    const normalizedLine = line.replace(/\*\*/g, '');
    const colonIndex = normalizedLine.indexOf(':');
    if (colonIndex > 0) {
      const dish = extractLikelyDishPhrase(normalizedLine.slice(colonIndex + 1));
      if (dish) ideas.push(dish);
      continue;
    }
    const listed = line.match(/^(?:[-*]\s+|\d+\.\s+)(.+)$/);
    if (listed) {
      const dish = extractLikelyDishPhrase(listed[1]);
      if (dish) ideas.push(dish);
    }
  }
  return sanitizeList(ideas);
}

function buildFallbackWorkingContextFromConversation({ routePrompt = '', conversation = [], existingContext = null, deps = {} } = {}) {
  if (existingContext) return existingContext;
  const recentAssistant = [...(Array.isArray(conversation) ? conversation : [])]
    .reverse()
    .find((message) => message?.role === 'assistant' && safeTrim(message.content));
  if (!recentAssistant) return existingContext;
  const visibleContent = deps.stripStoredMessageContentForDisplay?.(recentAssistant.content) ?? recentAssistant.content;
  const mealIdeas = extractMealIdeasFromAssistantMessage(visibleContent);
  if (mealIdeas.length < 2) return existingContext;
  const promptText = safeTrim(routePrompt);
  return normalizeWorkingContext({
    topicSummary: promptText ? `Current meal planning thread: ${promptText}` : 'Current meal planning thread.',
    mealIdeas,
    subjectItems: mealIdeas,
    groceryFocus: mealIdeas,
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
  const parts = ['Use this as short-term chat continuity when the user refers to "this", "that", or earlier meal ideas.'];
  if (context.mealIdeas.length > 0) {
    parts.push(`Current meal set: ${context.mealIdeas.join('; ')}.`);
  }
  if (context.subjectItems.length > 0) {
    parts.push(`Current dishes, drinks, or recipes under discussion: ${context.subjectItems.join('; ')}.`);
  }
  if (context.subjectItems.length > 0) {
    parts.push(`Treat the first listed subject item as the dominant current dish unless the latest turn clearly reopens ambiguity.`);
  }
  if (context.activeConstraints.length > 0) {
    parts.push(`Active refinements to honor: ${context.activeConstraints.join('; ')}.`);
  }
  if (context.groceryFocus.length > 0) {
    parts.push(`If groceries are requested, start from: ${context.groceryFocus.join('; ')}.`);
  }
  if (context.offeredIngredients.length > 0) {
    parts.push(`If the user says "add them", "all", or similar, treat these offered ingredients as the likely target: ${context.offeredIngredients.join('; ')}.`);
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
  if (!text) return !!normalizeWorkingContext(workingContext);

  const broadCulinaryIntent =
    /\b(grocery|groceries|shopping list|grocery list|pantry|cookbook|recipe|recipes|ingredients|instructions|directions|cook|cooking|meal|meals|dinner|dinners|lunch|breakfast|dish|dishes|menu|menus|drink|drinks|cocktail|cocktails)\b/;
  if (broadCulinaryIntent.test(text)) return true;

  if (normalizeWorkingContext(workingContext) && isReferentialFollowUp(text)) return true;
  if (normalizeWorkingContext(workingContext) && /\b(swap|replace|change|revise|redo|show me|add it|add them|search that|just that|save it|make it)\b/.test(text)) {
    return true;
  }
  return false;
}

export async function refreshKbWorkingContext({
  anthropic,
  req,
  chatId,
  routePrompt,
  currentWorkingContext = null,
  memoryContext = null,
  outcomes = [],
  deps = {},
}) {
  const existingContext = normalizeWorkingContext(currentWorkingContext);
  const shouldRefresh = isMealGroceryRelevantTurn({
    prompt: routePrompt,
    outcomes,
    workingContext: existingContext,
  });
  if (!shouldRefresh) return existingContext;
  if (!anthropic) return existingContext;

  const conversation = await getMessages(chatId, req.householdId);
  const recentConversation = formatRecentConversation(conversation, deps) || '(none)';
  const outcomeSummary = (Array.isArray(outcomes) ? outcomes : [])
    .map((outcome) => {
      const capability = safeTrim(outcome?.capability || outcome?.narrationType);
      const status = safeTrim(outcome?.status);
      if (!capability) return '';
      return `${capability}${status ? ` (${status})` : ''}`;
    })
    .filter(Boolean)
    .join(', ');

  try {
    const response = await createLoggedAnthropicMessage(
      anthropic,
      {
        model: resolveAnthropicModelForCallPurpose('kb_working_context'),
        max_tokens: 300,
        system: `You maintain a tiny, background working context for one KitchenBot chat.

Goal:
- Track only short-term culinary continuity for this specific chat.
- Preserve enough context for follow-ups like "show me the grocery list for this", "make one of those vegetarian", "search that", or "add them".
- Do not create a visible planning workflow or a long artifact.

Rules:
- Return ONLY JSON.
- If the conversation no longer has useful culinary continuity, return {"keep":false}.
- Otherwise return:
  {"keep":true,"topicSummary":"...","mealIdeas":["..."],"subjectItems":["..."],"activeConstraints":["..."],"offeredIngredients":["..."],"offeredSearchTopic":"...","groceryFocus":["..."]}
- Keep all strings short and concrete.
- mealIdeas should be the current dishes or meal ideas under discussion.
- subjectItems should include the concrete dishes, drinks, recipes, or natural shorthand variants currently being discussed.
- Order subjectItems from most active to least active. If one dish is clearly dominant, put it first.
- If the user chooses one concrete dish for a previously open slot, treat that chosen dish as dominant immediately instead of keeping the whole option set equally active.
- When that happens, move the chosen dish to the front of subjectItems and, when possible, rewrite the matching mealIdeas slot to use the chosen dish name rather than the old generic slot label.
- If the user explicitly zooms in on a self-contained sub-recipe or prep within an active dish, keep the parent dish in context but let that more specific target become the first subject item for immediate follow-up.
- activeConstraints should capture refinements introduced in this chat.
- offeredIngredients should capture the specific ingredients KitchenBot most recently proposed or confirmed when they are likely to be referred to as "them" or "all".
- offeredSearchTopic should capture the concrete thing KitchenBot most recently offered to search for.
- groceryFocus should capture the items or meal set a grocery request would most likely refer to.
- Prefer preserving the current meal set when the latest turn is referential ("this", "that", "one of those").
- Prefer preserving the currently dominant dish when the user narrows from several meal ideas to one dish, or asks for the full recipe for one of them.
- This is short-term chat context only. Do not restate durable household memory or defaults unless they materially shape the current culinary thread.
- If the turn is unrelated and no culinary thread remains active, return {"keep":false}.`,
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              latestPrompt: routePrompt,
              currentWorkingContext: existingContext || null,
              recentConversation,
              relevantMemory: memoryContext?.promptText || '(none)',
              appliedMemory: memoryContext?.applicationText || '(none)',
              structuredHouseholdDefaults: memoryContext?.defaultsText || '(none)',
              appliedHouseholdDefaults: memoryContext?.appliedDefaultsText || '(none)',
              executedOutcomes: outcomeSummary || '(none)',
            }),
          },
        ],
      },
      {
        householdId: req.householdId,
        chatId,
        turnId: req.kbTurnId || null,
        prompt: routePrompt,
        runtimeEnabled: true,
        callSurface: 'background',
        callPurpose: 'kb_working_context',
        webSearchEnabledAtCall: false,
        usedWebSearchTool: false,
      }
    );

    const raw = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
    const parsed = parseJsonObject(raw);
    const fallbackContext = buildFallbackWorkingContextFromConversation({
      routePrompt,
      conversation,
      existingContext,
      deps,
    });
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallbackContext;
    if (parsed.keep === false) return fallbackContext && !existingContext ? fallbackContext : null;
    if (parsed.keep !== true) return fallbackContext;
    return normalizeWorkingContext(parsed) || fallbackContext;
  } catch (error) {
    console.error('KitchenBot working context refresh failed:', error?.message || error);
    return buildFallbackWorkingContextFromConversation({
      routePrompt,
      conversation,
      existingContext,
      deps,
    });
  }
}
