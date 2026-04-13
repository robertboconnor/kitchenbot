import { getMessages } from './db.mjs';
import { createLoggedAnthropicMessage } from './anthropic-usage.mjs';
import { resolveAnthropicModelForCallPurpose } from './anthropic-model-policy.mjs';
import {
  buildKbAssistantPersonaSystemText,
  formatKbRecentConversation,
  getKbPromptContextSections,
} from './kb-prompt-context.mjs';
import { normalizeProposedNextAction } from './kb-next-action.mjs';
import {
  buildKbInterpreterActionExamples,
  buildKbInterpreterSkillList,
  normalizeKbSkillAction,
} from './kb-skills.mjs';
import { looksLikeMealRefineRequest } from './meal-refine-executor.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

function parseJsonObject(raw) {
  let s = safeTrim(raw);
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)```$/im);
  if (fence) s = safeTrim(fence[1]);
  try {
    return JSON.parse(s);
  } catch {
    const match = s.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function promptExplicitlyRequestsWebSearch(prompt) {
  const text = safeTrim(prompt).toLowerCase();
  if (!text) return false;
  return (
    /\bsearch (?:the )?web\b/.test(text) ||
    /\blook up\b/.test(text) ||
    /\blook (?:that|it|this) up\b/.test(text) ||
    /\bgoogle\b/.test(text) ||
    /\bfind\b/.test(text)
  );
}

function promptAcceptsPendingWebSearch(prompt) {
  const text = safeTrim(prompt).toLowerCase();
  if (!text) return false;
  return /^(yes|yeah|yep|sure|ok|okay|do it|go ahead|just that|that|search it|search that)$/i.test(text);
}

function promptClearlyNeedsLiveOutsideLookup(prompt) {
  const text = safeTrim(prompt).toLowerCase();
  if (!text) return false;
  return (
    /\b(latest|today|right now|currently|current|news|headline|weather|forecast|score|scores|price|prices|stock|stocks|election|breaking)\b/.test(text) ||
    /\b(this week|this weekend|tonight|tomorrow)\b/.test(text)
  );
}

function webSearchAllowedForTurn(prompt, pendingAction = null) {
  if (promptExplicitlyRequestsWebSearch(prompt)) return true;
  if (promptClearlyNeedsLiveOutsideLookup(prompt)) return true;
  const pendingCapability = safeTrim(pendingAction?.action?.capability);
  if (pendingCapability === 'web.search' && promptAcceptsPendingWebSearch(prompt)) return true;
  return false;
}

function normalizeInterpretedTurn(raw, opts = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const kind = safeTrim(raw.kind);
  if (kind === 'clarify') {
    const question = safeTrim(raw.question);
    if (!question) return null;
    const proposedNextAction = normalizeProposedNextAction(raw.proposedNextAction || raw.pendingAction || null);
    return proposedNextAction ? { kind, question, proposedNextAction } : { kind, question };
  }
  if (kind === 'execute_action') {
    const actions = (Array.isArray(raw.actions) ? raw.actions : [])
      .map((action) => {
        const normalized = normalizeKbSkillAction(action, opts);
        if (!normalized) return null;
        if (
          safeTrim(normalized.capability) === 'web.search' &&
          !webSearchAllowedForTurn(opts.originalPrompt || opts.prompt, opts.pendingAction)
        ) {
          return null;
        }
        return normalized;
      })
      .filter(Boolean);
    if (actions.length === 0) return null;
    return { kind, actions };
  }
  if (kind === 'reply_only') {
    const replyText = safeTrim(raw.replyText);
    return replyText ? { kind, replyText } : { kind, replyPlan: { kind: 'generate_reply' } };
  }
  return null;
}

function isWeakClarifyQuestion(question) {
  const text = safeTrim(question).toLowerCase();
  if (!text) return true;
  if (text.length < 12) return true;
  return /^(can you clarify|please clarify|clarify|what do you want|what should i do)\??$/.test(text);
}

function isReferentialPrompt(prompt) {
  const text = safeTrim(prompt).toLowerCase();
  if (!text) return false;
  return /\b(this|that|those|these|it|them)\b/.test(text) || /\bone of those\b/.test(text);
}

function promptLooksLikeRecipeBuild(prompt) {
  const text = safeTrim(prompt).toLowerCase();
  if (!text) return false;
  return (
    /\b(recipe|ingredients|instructions|directions)\b/.test(text) ||
    /\bhow (?:do i|to) make\b/.test(text) ||
    /\bshow me\b/.test(text)
  );
}

function promptClearlyRequestsGroceryWrite(prompt) {
  const text = safeTrim(prompt).toLowerCase();
  if (!text) return false;
  const mentionsGrocery = /\b(grocery list|groceries|shopping list|list)\b/.test(text);
  const wantsMutation = /\b(add|buy|get|put|write|update|make|build|create|need|necessary)\b/.test(text);
  return mentionsGrocery && wantsMutation;
}

function promptLooksLikeMemoryAdvisoryQuestion(prompt) {
  const text = safeTrim(prompt).toLowerCase();
  if (!text) return false;
  const asksHow = /\b(what(?:'s| is) the (?:right|best|cleanest) way|how should|what should|how do i|what kind of memory)\b/.test(text);
  const mentionsMemory = /\b(remember|memory|store|saved|preference|preferences)\b/.test(text);
  return asksHow && mentionsMemory;
}

function hasActiveMealThread(workingContext) {
  const context = workingContext && typeof workingContext === 'object' && !Array.isArray(workingContext) ? workingContext : null;
  if (!context) return false;
  const mealIdeas = Array.isArray(context.mealIdeas) ? context.mealIdeas.filter(Boolean) : [];
  const subjectItems = Array.isArray(context.subjectItems) ? context.subjectItems.filter(Boolean) : [];
  return mealIdeas.length > 0 || subjectItems.length > 0;
}

function isPantryConfirmationClarify(question) {
  const text = safeTrim(question).toLowerCase();
  if (!text) return false;
  return (
    /\bpantry\b/.test(text) ||
    /\bon hand\b/.test(text) ||
    /\balready have\b/.test(text) ||
    /\bdo you (?:already )?have\b/.test(text)
  );
}

function hasSingleDominantRecipeTarget(workingContext) {
  const context = workingContext && typeof workingContext === 'object' && !Array.isArray(workingContext) ? workingContext : null;
  if (!context) return false;
  const subjectItems = Array.isArray(context.subjectItems) ? context.subjectItems.filter(Boolean) : [];
  if (subjectItems.length > 0) return true;
  const mealIdeas = Array.isArray(context.mealIdeas) ? context.mealIdeas.filter(Boolean) : [];
  return mealIdeas.length === 1;
}

function getDominantWorkingSubject(workingContext) {
  const context = workingContext && typeof workingContext === 'object' && !Array.isArray(workingContext) ? workingContext : null;
  if (!context) return '';
  const subjectItems = Array.isArray(context.subjectItems) ? context.subjectItems.filter(Boolean) : [];
  if (subjectItems.length > 0) return safeTrim(subjectItems[0]);
  const mealIdeas = Array.isArray(context.mealIdeas) ? context.mealIdeas.filter(Boolean) : [];
  if (mealIdeas.length > 0) return safeTrim(mealIdeas[0]);
  return '';
}

function isComponentVsFullRecipeClarify(question) {
  const text = safeTrim(question).toLowerCase();
  if (!text) return false;
  const asksChoice = /\b(do you mean|are you looking for|did you want)\b/.test(text);
  const mentionsComponent = /\b(component|base recipe|standalone|itself|just the|sub-recipe|sub recipe)\b/.test(text);
  const mentionsWholeDish = /\b(full|whole|entire|assembly|the full thing|whole thing)\b/.test(text);
  return asksChoice && mentionsComponent && mentionsWholeDish;
}

function isDominantDishVsWholeSetRecipeClarify(turn, workingContext) {
  if (!hasSingleDominantRecipeTarget(workingContext)) return false;
  const options = Array.isArray(turn?.proposedNextAction?.candidateOptions) ? turn.proposedNextAction.candidateOptions : [];
  if (options.length === 0) return false;
  return options.some((option) => /\ball (?:three|recipes|dishes|meals)\b/i.test(safeTrim(option?.label)));
}

function isDominantDishVsOtherDishOptionsClarify(turn, workingContext) {
  const context = workingContext && typeof workingContext === 'object' && !Array.isArray(workingContext) ? workingContext : null;
  const subjectItems = Array.isArray(context?.subjectItems) ? context.subjectItems.filter(Boolean) : [];
  if (subjectItems.length !== 1) return false;
  const options = Array.isArray(turn?.proposedNextAction?.candidateOptions) ? turn.proposedNextAction.candidateOptions : [];
  if (options.length < 2) return false;
  const dominantKey = safeTrim(subjectItems[0]).toLowerCase();
  const optionLabels = options.map((option) => safeTrim(option?.label).toLowerCase()).filter(Boolean);
  if (optionLabels.length < 2) return false;
  const mentionsDominant = optionLabels.some((label) => dominantKey && (label.includes(dominantKey) || dominantKey.includes(label)));
  return mentionsDominant;
}

function shouldForceRecipeReplyOverClarify(turn, { prompt = '', memoryContext = null } = {}) {
  const workingContext = memoryContext?.workingContext;
  if (!turn || turn.kind !== 'clarify') return false;
  if (!promptLooksLikeRecipeBuild(prompt)) return false;
  if (!hasSingleDominantRecipeTarget(workingContext)) return false;
  return (
    isComponentVsFullRecipeClarify(turn.question) ||
    isDominantDishVsWholeSetRecipeClarify(turn, workingContext) ||
    isDominantDishVsOtherDishOptionsClarify(turn, workingContext)
  );
}

function needsInterpreterFallback(turn, { prompt = '', memoryContext = null } = {}) {
  if (!turn) return true;
  const workingContext = memoryContext?.workingContext;
  const hasWorkingContext =
    workingContext && typeof workingContext === 'object' && !Array.isArray(workingContext) && Object.keys(workingContext).length > 0;
  const referential = isReferentialPrompt(prompt) && hasWorkingContext;

  if (turn.kind === 'clarify') {
    if (
      !!memoryContext?.pantryContextAvailable &&
      promptClearlyRequestsGroceryWrite(prompt) &&
      isPantryConfirmationClarify(turn.question)
    ) {
      return true;
    }
    if (
      promptLooksLikeRecipeBuild(prompt) &&
      hasSingleDominantRecipeTarget(workingContext) &&
      (
        isComponentVsFullRecipeClarify(turn.question) ||
        isDominantDishVsWholeSetRecipeClarify(turn, workingContext) ||
        isDominantDishVsOtherDishOptionsClarify(turn, workingContext)
      )
    ) {
      return true;
    }
    return isWeakClarifyQuestion(turn.question) || referential;
  }

    if (turn.kind === 'execute_action') {
    const capabilities = (Array.isArray(turn.actions) ? turn.actions : []).map((action) => safeTrim(action?.capability));
    if (capabilities.length === 0) return true;
    if (capabilities.includes('memory.save') && promptLooksLikeMemoryAdvisoryQuestion(prompt)) return true;
    if (referential) return true;
    return capabilities.some((capability) =>
      [
        'meal.refine',
        'grocery.write',
        'grocery.remove',
        'grocery.check',
        'grocery.uncheck',
        'grocery.clear',
        'household.defaults.update',
        'pantry.remove',
        'pantry.move_to_grocery',
        'grocery.move_to_pantry',
        'web.search',
      ].includes(capability)
    );
  }

  return false;
}

async function runKbTurnInterpretation({
  anthropic,
  req,
  chatId,
  prompt,
  turnId,
  activeSpeakerName,
  memoryContext,
  runtimeProposedNextAction,
  deps,
  callPurpose,
}) {
  const conversation = await getMessages(chatId, req.householdId);
  const recentConversation =
    formatKbRecentConversation(conversation, deps, {
      limit: 12,
      assistantPersona: memoryContext?.assistantPersona,
    }) || '(none)';
  const contextSections = getKbPromptContextSections(memoryContext);
  const webSearchEnabled = !!memoryContext?.capabilities?.webSearchEnabled;
  const skillList = buildKbInterpreterSkillList({ webSearchEnabled });
  const actionExamples = buildKbInterpreterActionExamples({ webSearchEnabled });

  const response = await createLoggedAnthropicMessage(
    anthropic,
    {
      model: resolveAnthropicModelForCallPurpose(callPurpose),
      max_tokens: 400,
      system: `${buildKbAssistantPersonaSystemText(memoryContext, { role: 'interpreter' })}

Choose exactly one of:
- reply_only
- clarify
- execute_action

Rules:
- Use execute_action only when the user clearly wants a real app action.
- Never pretend an action happened. If no action should happen, choose reply_only.
- Prefer normal conversation when the user is brainstorming, asking for ideas, explanations, or advice.
- If the user asks what you can do, what you cannot do, or asks for help, choose reply_only and answer using the available skills.
- If the user asks who you are, what your name is, or what your tone is supposed to be, choose reply_only and answer from the configured assistant persona above.
- If the user asks whether you can search the web or why you did not look something up, choose reply_only and answer from the household capability context below.
- For memory.save, interpret who the memory is about using the active speaker, mentioned people, and household context.
- First-person durable preferences usually belong to the active speaker.
- Treat applied memory and resolved entities as real context for deciding whether the user wants conversation, preview, or a real mutation.
- Treat the working context as short-term chat continuity for referential turns like "this", "that", or "one of those".
- Treat the app map below as current product structure when the user asks where to find something in the app.
- Treat the Grocery List below as live household app state, just like Pantry.
- If the user asks what is on the grocery list or whether something is already there, reason from that live state instead of acting like it is unavailable.
- Treat Pantry context status below as authoritative for whether KitchenBot already knows the current Pantry state.
- If Pantry context status is available or empty, do not ask the user to confirm what is in the Pantry before taking a grocery action that should use Pantry.
- Use the user's local time context when a request depends on timing, deadlines, "tonight/tomorrow", or how long cooking will take.
- Do not mention the time unless it is actually relevant.
- Use grocery.remove when the user wants a Grocery List tab item deleted or taken off the list.
- Use grocery.check when the user wants a Grocery List tab item checked off, marked bought, or marked done.
- Use grocery.uncheck when the user wants a Grocery List tab item put back on the active list or marked not bought.
- Use grocery.clear when the user clearly wants the entire Grocery List tab emptied.
- Use household.defaults.update when the user is setting default dinner portions or weeknight cooking style for the household.
- Use pantry.add when the user is telling you which items the household usually keeps on hand in the Pantry.
- Use pantry.remove when the user wants an item deleted or removed from the Pantry.
- Use pantry.move_to_grocery when the user wants to move an on-hand Pantry item onto the Grocery List tab because they need to buy it.
- Use grocery.move_to_pantry when the user wants to move a Grocery List tab item into the Pantry after buying it.
- For person-specific durable food/preferences, use person-scoped preference memories and store only the new fact being saved.
- For memory.save, include only the new fact being saved. Do not merge with older saved memory.
- Use grocery.preview when the user wants to see, show, preview, draft, or list the groceries needed without asking to update the tab.
- Use grocery.write only when the user clearly wants the grocery list tab created, updated, appended to, replaced, or otherwise changed.
- Treat ordinary grocery writes like "add this to the grocery list" as additive by default.
- Only choose grocery.write with replace intent when the user explicitly asks to replace, reset, clear, wipe, or start fresh with the Grocery List tab.
- For direct item-add requests, use grocery.write rather than reply_only.
- Use meal.refine when the user asks to revise the current meals in this chat, such as narrowing one slot to a concrete dish or changing one of the active meal ideas.
- Treat natural follow-ups inside an active meal thread as real continuity, not as a fresh parsing problem. If the user says things like "show me the recipe", "save it", "make it spicier", "switch the fish one", or "make the handheld one fish tacos", use the current meal thread and dominant dish to decide whether to reply, refine, or act.
- When a user selects or swaps one dish within an active meal set, prefer meal.refine instead of reply_only unless the request is plainly just conversation.
- If working context already has a dominant first subject item, treat generic follow-ups as referring to that dominant subject by default. Do not widen back out to the whole meal set unless the latest user turn clearly reopened comparison or ambiguity.
- Use cookbook.save when the user clearly wants to save the current recipe, meal idea, or web-inspired dish for later reuse.
- Use cookbook.list when the user asks what is already saved in the household cookbook.
- Use cookbook.delete when the user clearly wants a saved cookbook recipe removed.
- Use web.search only when the household capability says web search is enabled and the user explicitly asks to search/look something up, clearly accepts an already-offered search, or the request is unmistakably about current/live outside information.
- Do not use web.search for purely local pantry, grocery, or household-state questions.
- Do not use web.search for ordinary cooking, recipe, brainstorming, or household questions just because outside information might exist.
- If the user says they are not sure and they are asking you to tell them, do not ask another near-duplicate narrowing question when the topic is already narrow enough from the conversation or working context.
- If the user accepts a previously offered search topic or offered ingredient set with referential language like "sure", "just that", "all", or "add them", continue that action instead of asking the same setup question again.
- If the user asks for a recipe for a currently active meal idea, default to the full actionable dish unless they explicitly ask for only one sub-component.
- Do not ask a component-vs-full-dish clarify question just because the dish includes multiple sub-recipes or parts.
- Only clarify recipe requests when there are multiple genuinely plausible dish-level targets still active in the current conversation.
- If one dish is already dominant in the recent conversation or working context, do not widen back out and ask which dish the user means unless they clearly reopened ambiguity.
- Never print raw tool syntax like search_web(...) in chat.
- If the user wants an action but you lack enough detail to act safely, choose clarify.
- If a pending action context exists below, treat it as the continuation of an already-selected action. Use it to continue, clarify, or cancel that same action rather than starting a new deterministic interpretation path.
- If you choose clarify for an already-selected action, include a structured proposedNextAction so KitchenBot can continue that same action on the next turn.

Return ONLY JSON.

Shapes:
{"kind":"reply_only"}
{"kind":"reply_only","replyText":"..."}
{"kind":"clarify","question":"..."}
{"kind":"clarify","question":"...","proposedNextAction":{"active":true,"type":"clarify_action","action":{"capability":"...","input":{}},"unresolvedFields":["..."],"contextSummary":"...","candidateOptions":[{"id":"1","label":"..."}]}}
{"kind":"execute_action","actions":[...]}

Valid action examples:
${actionExamples}`,
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            activeSpeakerName,
            userPrompt: prompt,
            pendingAction: runtimeProposedNextAction || null,
            resolvedEntities: contextSections.resolvedEntities,
            relevantMemory: contextSections.relevantMemory,
            appliedMemory: contextSections.appliedMemory,
            structuredHouseholdDefaults: contextSections.structuredHouseholdDefaults,
            appliedHouseholdDefaults: contextSections.appliedHouseholdDefaults,
            cookbookEntries: contextSections.cookbookEntries,
            appliedCookbook: contextSections.appliedCookbook,
            pantryItems: contextSections.pantryItems,
            appliedPantry: contextSections.appliedPantry,
            pantryContextStatus: contextSections.pantryContextStatus,
            groceryItems: contextSections.groceryItems,
            appliedGrocery: contextSections.appliedGrocery,
            groceryPantryOverlap: contextSections.groceryPantryOverlap,
            appMap: contextSections.appMap,
            localTimeContext: contextSections.localTimeContext,
            capabilities: contextSections.capabilities,
            workingContext: contextSections.workingContext,
            appliedWorkingContext: contextSections.appliedWorkingContext,
            dominantWorkingSubject: getDominantWorkingSubject(memoryContext?.workingContext),
            availableSkills: skillList,
            recentConversation,
          }),
        },
      ],
    },
    {
      householdId: req.householdId,
      chatId,
      turnId,
      prompt,
      runtimeEnabled: true,
      callSurface: 'chat',
      callPurpose,
      webSearchEnabledAtCall: webSearchEnabled,
      usedWebSearchTool: false,
    }
  );

  const raw = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
  return parseJsonObject(raw);
}

async function maybeRescueMealRefineTurn({
  anthropic,
  req,
  chatId,
  prompt,
  turnId,
  memoryContext,
  deps,
}) {
  if (!looksLikeMealRefineRequest(prompt)) return null;

  const conversation = await getMessages(chatId, req.householdId);
  const recentConversation =
    formatKbRecentConversation(conversation, deps, {
      limit: 12,
      assistantPersona: memoryContext?.assistantPersona,
    }) || '(none)';

  const response = await createLoggedAnthropicMessage(
    anthropic,
    {
      model: resolveAnthropicModelForCallPurpose('kb_turn_interpretation_fallback'),
      max_tokens: 220,
      system: `${buildKbAssistantPersonaSystemText(memoryContext, { role: 'interpreter' })}

Decide whether the latest user prompt is a concrete request to revise the currently active meal thread.

Rules:
- Use the active working context and recent conversation as the current meal thread.
- If the user is clearly choosing or swapping one dish within that active meal thread, return ONLY:
{"kind":"execute_action","actions":[{"capability":"meal.refine","input":{"request":"<latest user prompt>"}}]}
- If the user is not clearly refining the active meal thread, return ONLY:
{"kind":"no_override"}
- Do not ask a clarify question here.
- Do not invent any other capability.`,
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            latestUserPrompt: prompt,
            workingContext: memoryContext?.workingContext || null,
            recentConversation,
          }),
        },
      ],
    },
    {
      householdId: req.householdId,
      chatId,
      turnId,
      prompt,
      runtimeEnabled: true,
      callSurface: 'chat',
      callPurpose: 'kb_turn_interpretation_fallback',
      webSearchEnabledAtCall: !!memoryContext?.capabilities?.webSearchEnabled,
      usedWebSearchTool: false,
    }
  );

  const raw = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
  const parsed = parseJsonObject(raw);
  const rescued = normalizeInterpretedTurn(parsed, {
    originalPrompt: prompt,
    webSearchEnabled: !!memoryContext?.capabilities?.webSearchEnabled,
    workingContext: memoryContext?.workingContext,
    memoryContext,
  });
  if (rescued?.kind !== 'execute_action') return null;
  const capabilities = (rescued.actions || []).map((action) => safeTrim(action?.capability));
  return capabilities.includes('meal.refine') ? rescued : null;
}

export async function interpretKbTurn({
  anthropic,
  req,
  chatId,
  prompt,
  turnId = '',
  activeSpeakerName = '',
  memoryContext = null,
  runtimeProposedNextAction = null,
  memoriesByKey = new Map(),
  deps = {},
}) {
  if (!anthropic) return null;
  try {
    const recentMessages = await getMessages(chatId, req.householdId);
    const primaryParsed = await runKbTurnInterpretation({
      anthropic,
      req,
      chatId,
      prompt,
      turnId,
      activeSpeakerName,
      memoryContext,
      runtimeProposedNextAction,
      deps,
      callPurpose: 'kb_turn_interpretation_primary',
    });
    const primaryTurn = normalizeInterpretedTurn(primaryParsed, {
      memoriesByKey,
      activeSpeakerName,
      originalPrompt: prompt,
      pendingAction: runtimeProposedNextAction,
      webSearchEnabled: !!memoryContext?.capabilities?.webSearchEnabled,
      workingContext: memoryContext?.workingContext,
      memoryContext,
    });
    if (
      primaryTurn?.kind === 'execute_action' &&
      (primaryTurn.actions || []).some((action) => safeTrim(action?.capability) === 'memory.save') &&
      promptLooksLikeMemoryAdvisoryQuestion(prompt)
    ) {
      return { kind: 'reply_only', replyPlan: { kind: 'generate_reply' } };
    }
    if (shouldForceRecipeReplyOverClarify(primaryTurn, { prompt, memoryContext })) {
      return { kind: 'reply_only', replyPlan: { kind: 'generate_reply' } };
    }
    if (
      primaryTurn &&
      primaryTurn.kind !== 'execute_action' &&
      looksLikeMealRefineRequest(prompt)
    ) {
      const rescuedPrimaryMealRefineTurn = await maybeRescueMealRefineTurn({
        anthropic,
        req,
        chatId,
        prompt,
        turnId,
        memoryContext,
        deps,
      });
      if (rescuedPrimaryMealRefineTurn) return rescuedPrimaryMealRefineTurn;
    }
    if (!needsInterpreterFallback(primaryTurn, { prompt, memoryContext })) {
      return primaryTurn;
    }

    const fallbackParsed = await runKbTurnInterpretation({
      anthropic,
      req,
      chatId,
      prompt,
      turnId,
      activeSpeakerName,
      memoryContext,
      runtimeProposedNextAction,
      deps,
      callPurpose: 'kb_turn_interpretation_fallback',
    });
    const fallbackTurn = normalizeInterpretedTurn(fallbackParsed, {
      memoriesByKey,
      activeSpeakerName,
      originalPrompt: prompt,
      pendingAction: runtimeProposedNextAction,
      webSearchEnabled: !!memoryContext?.capabilities?.webSearchEnabled,
      workingContext: memoryContext?.workingContext,
      memoryContext,
    }) || primaryTurn;
    if (
      fallbackTurn?.kind === 'execute_action' &&
      (fallbackTurn.actions || []).some((action) => safeTrim(action?.capability) === 'memory.save') &&
      promptLooksLikeMemoryAdvisoryQuestion(prompt)
    ) {
      return { kind: 'reply_only', replyPlan: { kind: 'generate_reply' } };
    }
    if (shouldForceRecipeReplyOverClarify(fallbackTurn, { prompt, memoryContext })) {
      return { kind: 'reply_only', replyPlan: { kind: 'generate_reply' } };
    }
    if (fallbackTurn?.kind !== 'execute_action') {
      const rescuedMealRefineTurn = await maybeRescueMealRefineTurn({
        anthropic,
        req,
        chatId,
        prompt,
        turnId,
        memoryContext,
        deps,
      });
      if (rescuedMealRefineTurn) return rescuedMealRefineTurn;
    }
    return fallbackTurn;
  } catch (error) {
    console.error('KitchenBot turn interpretation failed:', error?.message || error);
    return null;
  }
}
