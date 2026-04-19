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

function pendingCapabilityBucket(proposedNextAction = null) {
  const capability = safeTrim(proposedNextAction?.action?.capability);
  if (!capability) return '';
  if (capability === 'meal.refine') return 'meal';
  if (capability === 'grocery.write') return 'grocery';
  if (capability === 'web.search') return 'search';
  if (capability.startsWith('cookbook.')) return 'cookbook';
  return 'other';
}

export function selectContinuationWorkingContext(workingContext, proposedNextAction = null) {
  const context = normalizeWorkingContext(workingContext);
  if (!context) return null;
  const bucket = pendingCapabilityBucket(proposedNextAction);
  if (!bucket) {
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
  if (bucket === 'meal') return context;
  if (bucket === 'grocery') {
    return normalizeWorkingContext({
      offeredIngredients: Array.isArray(context.offeredIngredients) ? context.offeredIngredients : [],
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
  if (bucket === 'search') {
    return normalizeWorkingContext({
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
  if (bucket === 'cookbook') {
    return normalizeWorkingContext({
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
  return normalizeWorkingContext({
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
- If the conversation no longer has useful immediate culinary continuity, return {"keep":false}.
- Otherwise return:
  {"keep":true,"topicSummary":"...","mealIdeas":["..."],"subjectItems":["..."],"activeConstraints":["..."],"offeredIngredients":["..."],"offeredSearchTopic":"...","groceryFocus":["..."]}
- Keep all strings short and concrete.
- mealIdeas should contain only still-relevant meal ideas or dishes from the recent part of the chat.
- subjectItems should include any concrete dishes, drinks, recipes, or natural shorthand variants that are still immediately relevant.
- Do not treat subjectItems as an authoritative hidden workflow state. They are only a lightweight compression of recent continuity.
- If the latest user turn clearly starts a fresh cooking-help moment, a different night, or a different dish, drop stale older meal ideas instead of stretching them forward.
- If the user explicitly zooms in on a self-contained sub-recipe or prep within an active dish, it is okay to include both the parent dish and the more specific prep, but keep only what is immediately relevant now.
- activeConstraints should capture refinements introduced in this chat.
- offeredIngredients should capture the specific ingredients KitchenBot most recently proposed or confirmed when they are likely to be referred to as "them" or "all".
- offeredSearchTopic should capture the concrete thing KitchenBot most recently offered to search for.
- groceryFocus should capture the items or meal set a grocery request would most likely refer to.
- Prefer keeping continuity only when the latest turn is clearly referential or continuing the same immediate task.
- If the latest turn or recent transcript says this is a new night, they are making something now, or they already finished the prior dish, treat that as fresh context and stop carrying old meal state forward.
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
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (parsed.keep === false) return null;
    if (parsed.keep !== true) return null;
    return normalizeWorkingContext(parsed);
  } catch (error) {
    console.error('KitchenBot working context refresh failed:', error?.message || error);
    return null;
  }
}
