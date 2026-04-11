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
  const activeConstraints = sanitizeList(raw.activeConstraints);
  const groceryFocus = sanitizeList(raw.groceryFocus);
  if (!topicSummary && mealIdeas.length === 0 && activeConstraints.length === 0 && groceryFocus.length === 0) {
    return null;
  }
  return {
    topicSummary,
    mealIdeas,
    activeConstraints,
    groceryFocus,
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

export function formatWorkingContextText(workingContext) {
  const context = normalizeWorkingContext(workingContext);
  if (!context) return '(none)';
  const parts = [];
  if (context.topicSummary) parts.push(`Current meal/grocery thread: ${context.topicSummary}`);
  if (context.mealIdeas.length > 0) parts.push(`Meals or dishes under discussion: ${context.mealIdeas.join('; ')}`);
  if (context.activeConstraints.length > 0) {
    parts.push(`Current constraints in this chat: ${context.activeConstraints.join('; ')}`);
  }
  if (context.groceryFocus.length > 0) {
    parts.push(`Grocery-relevant focus: ${context.groceryFocus.join('; ')}`);
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
  if (context.activeConstraints.length > 0) {
    parts.push(`Active refinements to honor: ${context.activeConstraints.join('; ')}.`);
  }
  if (context.groceryFocus.length > 0) {
    parts.push(`If groceries are requested, start from: ${context.groceryFocus.join('; ')}.`);
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
    return capability === 'grocery.preview' || capability === 'grocery.write' || capability === 'meal.refine';
  });
  if (hasRelevantOutcome) return true;
  if (!text) return !!normalizeWorkingContext(workingContext);

  const directKeywords =
    /\b(grocery|groceries|list|dinner|meal|meals|cook|cooking|recipe|recipes|vegetarian|vegan|salmon|taco|tacos|chicken|pasta|bowl|bowls|weeknight|lunch|breakfast)\b/;
  if (directKeywords.test(text)) return true;

  if (normalizeWorkingContext(workingContext) && isReferentialFollowUp(text)) return true;
  if (normalizeWorkingContext(workingContext) && /\b(swap|replace|change|revise|redo|make one|show me|add it)\b/.test(text)) {
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
- Track only short-term meal and grocery continuity for this specific chat.
- Preserve enough context for follow-ups like "show me the grocery list for this" or "make one of those vegetarian".
- Do not create a visible planning workflow or a long artifact.

Rules:
- Return ONLY JSON.
- If the conversation no longer has useful meal/grocery continuity, return {"keep":false}.
- Otherwise return:
  {"keep":true,"topicSummary":"...","mealIdeas":["..."],"activeConstraints":["..."],"groceryFocus":["..."]}
- Keep all strings short and concrete.
- mealIdeas should be the current dishes or meal ideas under discussion.
- activeConstraints should capture refinements introduced in this chat, like "one meal should be vegetarian".
- groceryFocus should capture the items or meal set a grocery request would most likely refer to.
- Prefer preserving the current meal set when the latest turn is referential ("this", "that", "one of those").
- This is short-term chat context only. Do not restate durable household memory or defaults unless they materially shape the current meal thread.
- If the turn is unrelated and no meal/grocery thread remains active, return {"keep":false}.`,
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
        runtimeEnabled: true,
        callSurface: 'background',
        callPurpose: 'kb_working_context',
        webSearchEnabledAtCall: false,
        usedWebSearchTool: false,
      }
    );

    const raw = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
    const parsed = parseJsonObject(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return existingContext;
    if (parsed.keep === false) return null;
    if (parsed.keep !== true) return existingContext;
    return normalizeWorkingContext(parsed) || existingContext;
  } catch (error) {
    console.error('KitchenBot working context refresh failed:', error?.message || error);
    return existingContext;
  }
}
