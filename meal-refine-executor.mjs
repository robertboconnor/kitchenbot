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

function normalizeKey(text) {
  return safeTrim(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function stripLeadingArticle(text) {
  return safeTrim(text).replace(/^(?:the|a|an)\s+/i, '').trim();
}

function tokenizeForMatching(text) {
  return normalizeKey(text)
    .split(/\s+/)
    .filter((token) => token && !new Set(['the', 'a', 'an', 'this', 'that', 'one', 'slot', 'meal', 'dish', 'idea', 'option']).has(token));
}

function scoreTokenOverlap(a, b) {
  const aTokens = tokenizeForMatching(a);
  const bTokens = tokenizeForMatching(b);
  if (aTokens.length === 0 || bTokens.length === 0) return 0;
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.includes(token)) overlap += 1;
  }
  return overlap / Math.max(aTokens.length, bTokens.length);
}

function sourceLooksLikeSlotAlias(source) {
  const text = safeTrim(source).toLowerCase();
  if (!text) return false;
  return /\b(one|slot|meal|dish|idea|option)\b/.test(text);
}

function extractConcreteMealSelection(request) {
  const text = safeTrim(request);
  if (!text) return null;
  const patterns = [
    /^(?:make|turn|change)\s+(?:the\s+|this\s+|that\s+)?(.+?)\s+the\s+(.+)$/i,
    /^(?:make|turn|change)\s+(?:the\s+|this\s+|that\s+)?(.+?)\s+(?:into|to|become)\s+(?:the\s+|a\s+|an\s+)?(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const source = stripLeadingArticle(match[1]);
    const target = stripLeadingArticle(match[2]);
    if (!source || !target) continue;
    if (/\b(spicier|milder|vegetarian|vegan|bigger|smaller|lighter|heavier)\b/i.test(target)) continue;
    if (target.split(/\s+/).length < 2) continue;
    return { source, target };
  }
  const aliasPattern = /^(?:make|turn|change)\s+(?:the\s+|this\s+|that\s+)?(.+?)\s+(?:a|an)\s+(.+)$/i;
  const aliasMatch = text.match(aliasPattern);
  if (aliasMatch) {
    const source = stripLeadingArticle(aliasMatch[1]);
    const target = stripLeadingArticle(aliasMatch[2]);
    if (
      source &&
      target &&
      sourceLooksLikeSlotAlias(source) &&
      target.split(/\s+/).length >= 2 &&
      !/\b(spicier|milder|vegetarian|vegan|bigger|smaller|lighter|heavier)\b/i.test(target)
    ) {
      return { source, target };
    }
  }
  const bareAliasMatch = text.match(
    /^(?:make|turn|change)\s+(?:the\s+|this\s+|that\s+)?(.+?\b(?:one|slot|meal|dish|idea|option))\s+(.+)$/i
  );
  if (bareAliasMatch) {
    const source = stripLeadingArticle(bareAliasMatch[1]);
    const target = stripLeadingArticle(bareAliasMatch[2]);
    if (
      source &&
      target &&
      sourceLooksLikeSlotAlias(source) &&
      target.split(/\s+/).length >= 2 &&
      !/\b(spicier|milder|vegetarian|vegan|bigger|smaller|lighter|heavier)\b/i.test(target)
    ) {
      return { source, target };
    }
  }
  return null;
}

export function looksLikeMealRefineRequest(request) {
  return !!extractConcreteMealSelection(request);
}

function parseLabeledMealSlots(conversation, deps) {
  const slots = [];
  for (const message of Array.isArray(conversation) ? conversation.slice(-8) : []) {
    if (message?.role !== 'assistant') continue;
    const text = safeTrim(deps.stripStoredMessageContentForDisplay?.(message.content) ?? message.content);
    for (const line of text.split(/\n+/)) {
      const cleaned = safeTrim(line.replace(/^[*-]\s*/, ''));
      if (!cleaned) continue;
      const match = cleaned.match(/^\*{0,2}([^:*]+?)\*{0,2}\s*:\s+(.+)$/);
      if (!match) continue;
      const label = safeTrim(match[1]);
      const value = safeTrim(match[2]);
      if (!label || !value) continue;
      slots.push({ label, value });
    }
  }
  return slots;
}

function resolveCandidateFromItems(source, items) {
  const sourceKey = normalizeKey(source);
  let bestMatch = '';
  let bestScore = 0;
  for (const item of Array.isArray(items) ? items : []) {
    const text = safeTrim(item);
    if (!text) continue;
    const itemKey = normalizeKey(text);
    if (sourceKey && (itemKey.includes(sourceKey) || sourceKey.includes(itemKey))) return text;
    const overlap = scoreTokenOverlap(source, text);
    if (overlap > bestScore) {
      bestScore = overlap;
      bestMatch = text;
    }
  }
  return bestScore >= 0.5 ? bestMatch : '';
}

function resolveSelectionSource(source, existingWorkingContext, conversation, deps) {
  const directItems = [
    ...(Array.isArray(existingWorkingContext?.mealIdeas) ? existingWorkingContext.mealIdeas : []),
    ...(Array.isArray(existingWorkingContext?.subjectItems) ? existingWorkingContext.subjectItems : []),
  ];
  const directMatch = resolveCandidateFromItems(source, directItems);
  if (directMatch) return directMatch;

  for (const slot of parseLabeledMealSlots(conversation, deps)) {
    const labelOverlap = scoreTokenOverlap(source, slot.label);
    if (labelOverlap < 0.5 && !normalizeKey(slot.label).includes(normalizeKey(source))) continue;
    const valueMatch = resolveCandidateFromItems(slot.value, directItems);
    if (valueMatch) return valueMatch;
    return slot.value;
  }
  return source;
}

function resolveConcreteMealSelection(selection, existingWorkingContext, conversation, deps) {
  if (!selection) return null;
  return {
    ...selection,
    source: resolveSelectionSource(selection.source, existingWorkingContext, conversation, deps),
  };
}

function replaceOrPrependMeal(items, source, target) {
  const sourceKey = normalizeKey(source);
  const targetKey = normalizeKey(target);
  const out = [];
  let replaced = false;
  for (const item of Array.isArray(items) ? items : []) {
    const text = safeTrim(item);
    if (!text) continue;
    const key = normalizeKey(text);
    if (!replaced && sourceKey && (key.includes(sourceKey) || sourceKey.includes(key))) {
      out.push(target);
      replaced = true;
      continue;
    }
    if (key === targetKey) continue;
    out.push(text);
  }
  if (!replaced) out.unshift(target);
  return sanitizeMealIdeas(out);
}

function prioritizeMeal(items, target) {
  const targetKey = normalizeKey(target);
  const rest = [];
  for (const item of Array.isArray(items) ? items : []) {
    const text = safeTrim(item);
    if (!text) continue;
    if (normalizeKey(text) === targetKey) continue;
    rest.push(text);
  }
  return sanitizeMealIdeas([target, ...rest]);
}

function buildRefinedWorkingContextFromSelection(existingWorkingContext, selection) {
  const existing = normalizeWorkingContext(existingWorkingContext) || {};
  const target = safeTrim(selection?.target);
  const source = safeTrim(selection?.source);
  if (!target) return normalizeWorkingContext(existingWorkingContext);
  const nextMealIdeas = prioritizeMeal(replaceOrPrependMeal(existing.mealIdeas, source, target), target);
  const nextSubjectItems = sanitizeMealIdeas([target]);
  const nextGroceryFocus = sanitizeMealIdeas([
    `${target} ingredients`,
    ...(Array.isArray(existing.groceryFocus) ? existing.groceryFocus : []),
  ]);
  return normalizeWorkingContext({
    topicSummary:
      safeTrim(existing.topicSummary) ||
      `Planning meals with ${target} now chosen for ${source || 'one slot'}.`,
    mealIdeas: nextMealIdeas,
    subjectItems: nextSubjectItems,
    activeConstraints: sanitizeConstraints(existing.activeConstraints),
    groceryFocus: nextGroceryFocus,
  });
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
  const rawConcreteSelection = extractConcreteMealSelection(prompt) || extractConcreteMealSelection(request);

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

  const conversation = await getMessages(chatId, req.householdId);
  const concreteSelection = resolveConcreteMealSelection(rawConcreteSelection, existingWorkingContext, conversation, deps);

  if (concreteSelection && !anthropic) {
    const nextWorkingContext = buildRefinedWorkingContextFromSelection(existingWorkingContext, concreteSelection);
    return {
      capability: 'meal.refine',
      status: 'refined',
      request,
      topicSummary: nextWorkingContext?.topicSummary || '',
      revisedMeals: nextWorkingContext?.mealIdeas || [],
      activeConstraints: nextWorkingContext?.activeConstraints || [],
      groceryFocus: nextWorkingContext?.groceryFocus || [],
      replySummary: `Got it—I made the ${concreteSelection.source} the ${concreteSelection.target}.`,
      workingContext: nextWorkingContext,
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
  {"status":"refined","topicSummary":"...","mealIdeas":["..."],"subjectItems":["..."],"activeConstraints":["..."],"groceryFocus":["..."],"replySummary":"..."}
- mealIdeas should be the revised current meal set, not a full essay.
- subjectItems should list the currently dominant dishes or recipe targets in order, with the most active one first.
- Keep strings short and concrete.
- Preserve the useful parts of the existing meal thread when possible.
- Apply durable memory and household defaults naturally.
- Use the user's local time context when timing, deadlines, or relative-time phrasing materially affects the refinement.
- If the user asks to swap one meal, revise only that part when reasonable.
- If the user asks to make one meal vegetarian or otherwise refine the set, update the set instead of starting from scratch unless the request clearly asks for a full redo.
- If the user chooses one concrete dish for a previously open slot, treat that as a successful refinement immediately. Do not ask for another round of optional toppings, cheese, bread, or customization details unless the user explicitly asked for that kind of customization or the missing detail is truly required.
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
      if (concreteSelection) {
        const nextWorkingContext = buildRefinedWorkingContextFromSelection(existingWorkingContext, concreteSelection);
        return {
          capability: 'meal.refine',
          status: 'refined',
          request,
          topicSummary: nextWorkingContext?.topicSummary || '',
          revisedMeals: nextWorkingContext?.mealIdeas || [],
          activeConstraints: nextWorkingContext?.activeConstraints || [],
          groceryFocus: nextWorkingContext?.groceryFocus || [],
          replySummary: `Got it—I made the ${concreteSelection.source} the ${concreteSelection.target}.`,
          workingContext: nextWorkingContext,
        };
      }
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
      if (concreteSelection) {
        const nextWorkingContext = buildRefinedWorkingContextFromSelection(existingWorkingContext, concreteSelection);
        return {
          capability: 'meal.refine',
          status: 'refined',
          request,
          topicSummary: nextWorkingContext?.topicSummary || '',
          revisedMeals: nextWorkingContext?.mealIdeas || [],
          activeConstraints: nextWorkingContext?.activeConstraints || [],
          groceryFocus: nextWorkingContext?.groceryFocus || [],
          replySummary: `Got it—I made the ${concreteSelection.source} the ${concreteSelection.target}.`,
          workingContext: nextWorkingContext,
        };
      }
      const question = safeTrim(parsed.question) || 'What part of the current meal ideas do you want me to change?';
      return {
        capability: 'meal.refine',
        status: 'needs_context',
        request,
        question,
        proposedNextAction: buildMealRefineClarifyState(request, question),
      };
    }

    let nextWorkingContext = normalizeWorkingContext({
      topicSummary: parsed.topicSummary,
      mealIdeas: sanitizeMealIdeas(parsed.mealIdeas),
      subjectItems: sanitizeMealIdeas(parsed.subjectItems),
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

    if (concreteSelection) {
      nextWorkingContext = {
        ...nextWorkingContext,
        mealIdeas: prioritizeMeal(
          replaceOrPrependMeal(nextWorkingContext.mealIdeas, concreteSelection.source, concreteSelection.target),
          concreteSelection.target
        ),
        subjectItems: sanitizeMealIdeas([concreteSelection.target]),
        groceryFocus: sanitizeMealIdeas([
          `${concreteSelection.target} ingredients`,
          ...nextWorkingContext.groceryFocus,
        ]),
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
