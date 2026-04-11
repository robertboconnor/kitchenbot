import { getMessages } from './db.mjs';
import { createLoggedAnthropicMessage } from './anthropic-usage.mjs';
import { resolveAnthropicModelForCallPurpose } from './anthropic-model-policy.mjs';
import { buildClarifyActionState } from './kb-next-action.mjs';
import { buildKbContextSystemText, formatKbRecentConversation } from './kb-prompt-context.mjs';
import { formatAppliedWorkingContextText, formatWorkingContextText, normalizeWorkingContext } from './kb-working-context.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
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

function sanitizeMealIdeas(items) {
  const seen = new Set();
  const list = [];
  for (const item of Array.isArray(items) ? items : []) {
    const text = safeTrim(item).replace(/\s+/g, ' ').slice(0, 120);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    list.push(text);
    if (list.length >= 6) break;
  }
  return list;
}

function sanitizeConstraints(items) {
  return sanitizeMealIdeas(items);
}

function buildMealRefineClarifyState(request, question) {
  return buildClarifyActionState({
    capability: 'meal.refine',
    input: request ? { request } : {},
    question,
    contextSummary: 'Continue the pending meal refinement request once the user says which current meals or dinner ideas should change.',
    unresolvedFields: ['request'],
    visibleReplySummary: question,
  });
}

export async function executeMealRefine(runtimeAction, context) {
  const {
    req,
    chatId,
    prompt,
    anthropic,
    memoryContext = null,
    workingContext = null,
    deps = {},
  } = context;

  const existingWorkingContext =
    normalizeWorkingContext(workingContext) || normalizeWorkingContext(memoryContext?.workingContext);
  const request = safeTrim(runtimeAction?.input?.request || prompt);

  if (!existingWorkingContext) {
    const question = 'What meals or dinner ideas do you want me to revise?';
    return {
      capability: 'meal.refine',
      status: 'needs_context',
      request,
      question,
      proposedNextAction: buildMealRefineClarifyState(request, question),
    };
  }

  if (!anthropic) {
    const question = 'Tell me which meals you want to revise, and I can adjust them from there.';
    return {
      capability: 'meal.refine',
      status: 'needs_context',
      request,
      question,
      proposedNextAction: buildMealRefineClarifyState(request, question),
    };
  }

  const conversation = await getMessages(chatId, req.householdId);
  const recentConversation = formatKbRecentConversation(conversation, deps, { limit: 12 }) || '(none)';

  try {
    const response = await createLoggedAnthropicMessage(
      anthropic,
      {
        model: resolveAnthropicModelForCallPurpose('meal_refine'),
        max_tokens: 500,
        system: `You revise the current KitchenBot meal thread for one chat.

Goal:
- Use the existing short-term working context as the meal set under discussion.
- Apply the user's latest refinement request to that meal set.
- Return a revised meal set and an updated working context.

        Rules:
- Return ONLY JSON.
- Shape:
  {"status":"refined","topicSummary":"...","mealIdeas":["..."],"activeConstraints":["..."],"groceryFocus":["..."],"replySummary":"..."}
- mealIdeas should be the revised current meal set, not a full essay.
- Keep strings short and concrete.
- Preserve the useful parts of the existing meal thread when possible.
- Apply durable memory and household defaults naturally.
- Use the user's local time context when timing, deadlines, or relative-time phrasing materially affects the refinement.
- If the user asks to swap one meal, revise only that part when reasonable.
- If the user asks to make one meal vegetarian or otherwise refine the set, update the set instead of starting from scratch unless the request clearly asks for a full redo.
- replySummary should briefly say what changed in natural language, ready for KitchenBot to build on.
- If there is not enough context to revise safely, return {"status":"needs_context","question":"..."}.
- Do not claim anything was committed to the grocery list.`,
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              latestRequest: request,
              currentWorkingContext: existingWorkingContext,
              workingContextText: formatWorkingContextText(existingWorkingContext),
              appliedWorkingContext: formatAppliedWorkingContextText(existingWorkingContext),
              sharedContext: buildKbContextSystemText(memoryContext),
              recentConversation,
            }),
          },
        ],
      },
      {
        householdId: req.householdId,
        chatId,
        runtimeEnabled: true,
        callSurface: 'kb_action',
        callPurpose: 'meal_refine',
        webSearchEnabledAtCall: false,
        usedWebSearchTool: false,
      }
    );

    const raw = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
    const parsed = parseJsonObject(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const question = 'What part of the current meal ideas do you want me to change?';
      return {
        capability: 'meal.refine',
        status: 'needs_context',
        request,
        question,
        proposedNextAction: buildMealRefineClarifyState(request, question),
      };
    }

    if (safeTrim(parsed.status) === 'needs_context') {
      const question = safeTrim(parsed.question) || 'What part of the current meal ideas do you want me to change?';
      return {
        capability: 'meal.refine',
        status: 'needs_context',
        request,
        question,
        proposedNextAction: buildMealRefineClarifyState(request, question),
      };
    }

    const nextWorkingContext = normalizeWorkingContext({
      topicSummary: parsed.topicSummary,
      mealIdeas: sanitizeMealIdeas(parsed.mealIdeas),
      activeConstraints: sanitizeConstraints(parsed.activeConstraints),
      groceryFocus: sanitizeMealIdeas(parsed.groceryFocus),
    });

    if (!nextWorkingContext) {
      const question = 'What part of the current meal ideas do you want me to change?';
      return {
        capability: 'meal.refine',
        status: 'needs_context',
        request,
        question,
        proposedNextAction: buildMealRefineClarifyState(request, question),
      };
    }

    return {
      capability: 'meal.refine',
      status: 'refined',
      request,
      topicSummary: nextWorkingContext.topicSummary,
      revisedMeals: nextWorkingContext.mealIdeas,
      activeConstraints: nextWorkingContext.activeConstraints,
      groceryFocus: nextWorkingContext.groceryFocus,
      replySummary: safeTrim(parsed.replySummary),
      workingContext: nextWorkingContext,
    };
  } catch (error) {
    console.error('Meal refinement failed:', error?.message || error);
    const question = 'What part of the current meal ideas do you want me to change?';
    return {
      capability: 'meal.refine',
      status: 'needs_context',
      request,
      question,
      proposedNextAction: buildMealRefineClarifyState(request, question),
    };
  }
}
