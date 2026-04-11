import { getMessages } from './db.mjs';
import { createLoggedAnthropicMessage } from './anthropic-usage.mjs';
import { resolveAnthropicModelForCallPurpose } from './anthropic-model-policy.mjs';
import {
  formatKbRecentConversation,
  getKbPromptContextSections,
} from './kb-prompt-context.mjs';
import { normalizeProposedNextAction } from './kb-next-action.mjs';
import {
  buildKbInterpreterActionExamples,
  buildKbInterpreterSkillList,
  normalizeKbSkillAction,
} from './kb-skills.mjs';

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
      .map((action) => normalizeKbSkillAction(action, opts))
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

function needsInterpreterFallback(turn, { prompt = '', memoryContext = null } = {}) {
  if (!turn) return true;
  const workingContext = memoryContext?.workingContext;
  const hasWorkingContext =
    workingContext && typeof workingContext === 'object' && !Array.isArray(workingContext) && Object.keys(workingContext).length > 0;
  const referential = isReferentialPrompt(prompt) && hasWorkingContext;

  if (turn.kind === 'clarify') {
    return isWeakClarifyQuestion(turn.question) || referential;
  }

  if (turn.kind === 'execute_action') {
    const capabilities = (Array.isArray(turn.actions) ? turn.actions : []).map((action) => safeTrim(action?.capability));
    if (capabilities.length === 0) return true;
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
  activeSpeakerName,
  memoryContext,
  runtimeProposedNextAction,
  deps,
  callPurpose,
}) {
  const conversation = await getMessages(chatId, req.householdId);
  const recentConversation = formatKbRecentConversation(conversation, deps, { limit: 12 }) || '(none)';
  const contextSections = getKbPromptContextSections(memoryContext);
  const skillList = buildKbInterpreterSkillList();
  const actionExamples = buildKbInterpreterActionExamples();

  const response = await createLoggedAnthropicMessage(
    anthropic,
    {
      model: resolveAnthropicModelForCallPurpose(callPurpose),
      max_tokens: 400,
      system: `You are KitchenBot's turn interpreter.

Choose exactly one of:
- reply_only
- clarify
- execute_action

Rules:
- Use execute_action only when the user clearly wants a real app action.
- Never pretend an action happened. If no action should happen, choose reply_only.
- Prefer normal conversation when the user is brainstorming, asking for ideas, explanations, or advice.
- If the user asks what you can do, what you cannot do, or asks for help, choose reply_only and answer using the available skills.
- For memory.save, interpret who the memory is about using the active speaker, mentioned people, and household context.
- First-person durable preferences usually belong to the active speaker.
- Treat applied memory and resolved entities as real context for deciding whether the user wants conversation, preview, or a real mutation.
- Treat the working context as short-term chat continuity for referential turns like "this", "that", or "one of those".
- Treat the app map below as current product structure when the user asks where to find something in the app.
- Treat the Grocery List below as live household app state, just like Pantry.
- If the user asks what is on the grocery list or whether something is already there, reason from that live state instead of acting like it is unavailable.
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
- For person-specific durable food/preferences, use keys like "rob_preferences" and values like "doesn't like beets" or "loves tacos".
- For memory.save, include only the new fact being saved. Do not merge with older saved memory.
- Use grocery.preview when the user wants to see, show, preview, draft, or list the groceries needed without asking to update the tab.
- Use grocery.write only when the user clearly wants the grocery list tab created, updated, appended to, replaced, or otherwise changed.
- Use meal.refine when the user asks to revise the current meals in this chat, like "make one of those vegetarian" or "swap the salmon one".
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
            pantryItems: contextSections.pantryItems,
            appliedPantry: contextSections.appliedPantry,
            groceryItems: contextSections.groceryItems,
            appliedGrocery: contextSections.appliedGrocery,
            groceryPantryOverlap: contextSections.groceryPantryOverlap,
            appMap: contextSections.appMap,
            localTimeContext: contextSections.localTimeContext,
            workingContext: contextSections.workingContext,
            appliedWorkingContext: contextSections.appliedWorkingContext,
            availableSkills: skillList,
            recentConversation,
          }),
        },
      ],
    },
    {
      householdId: req.householdId,
      chatId,
      runtimeEnabled: true,
      callSurface: 'chat',
      callPurpose,
      webSearchEnabledAtCall: false,
      usedWebSearchTool: false,
    }
  );

  const raw = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
  return parseJsonObject(raw);
}

export async function interpretKbTurn({
  anthropic,
  req,
  chatId,
  prompt,
  activeSpeakerName = '',
  memoryContext = null,
  runtimeProposedNextAction = null,
  memoriesByKey = new Map(),
  deps = {},
}) {
  if (!anthropic) return null;
  try {
    const primaryParsed = await runKbTurnInterpretation({
      anthropic,
      req,
      chatId,
      prompt,
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
    });
    if (!needsInterpreterFallback(primaryTurn, { prompt, memoryContext })) {
      return primaryTurn;
    }

    const fallbackParsed = await runKbTurnInterpretation({
      anthropic,
      req,
      chatId,
      prompt,
      activeSpeakerName,
      memoryContext,
      runtimeProposedNextAction,
      deps,
      callPurpose: 'kb_turn_interpretation_fallback',
    });
    return normalizeInterpretedTurn(fallbackParsed, {
      memoriesByKey,
      activeSpeakerName,
      originalPrompt: prompt,
    }) || primaryTurn;
  } catch (error) {
    console.error('KitchenBot turn interpretation failed:', error?.message || error);
    return null;
  }
}
