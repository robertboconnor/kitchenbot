import { normalizeRuntimeAction, normalizeRuntimeActionList } from './capability-registry.mjs';
import { normalizeDurableMemoryScopeFromInterpreter } from './smart-durable-memory.mjs';
import { createLoggedAnthropicMessage } from './anthropic-usage.mjs';
import { resolveAnthropicModelForCallPurpose } from './anthropic-model-policy.mjs';

const CONFIDENCE_FLOOR = 0.6;
const TWO_ACTION_CONFIDENCE_FLOOR = 0.85;

function parseJsonObjectFromModelText(raw) {
  let s = String(raw ?? '').trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)```$/im);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

export function validateSmartRuntimeInterpreterOutput(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const version = Number(parsed.version);
  if (version !== 2) return null;
  const type = String(parsed.type ?? '').trim();
  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence) || confidence < CONFIDENCE_FLOOR || confidence > 1) return null;

  if (type === 'reply') {
    if (parsed.actions != null) return null;
    const durableMemoryScope = normalizeDurableMemoryScopeFromInterpreter(parsed.durable_memory_scope);
    return { kind: 'reply', durableMemoryScope };
  }

  if (type === 'clarify') {
    const question = String(parsed.question ?? '').trim();
    if (!question) return null;
    if (parsed.actions != null) return null;
    return { kind: 'clarify', question };
  }

  if (type === 'actions') {
    const actions = normalizeRuntimeActionList(parsed.actions);
    if (actions.length === 0) return null;
    if (actions.length >= 2 && confidence < TWO_ACTION_CONFIDENCE_FLOOR) return null;
    return { kind: 'actions', actions };
  }
  return null;
}

function buildInterpreterCapabilitySpec(allowedCapabilities) {
  const caps = Array.isArray(allowedCapabilities) ? allowedCapabilities : [];
  const lines = [];
  for (const entry of caps) {
    const capability = String(entry?.capability ?? '').trim();
    if (!capability) continue;
    if (capability === 'memory.save') {
      lines.push('- memory.save');
      lines.push('  input: {"key":"snake_case_key","value":"natural text"}');
    } else if (capability === 'grocery.generate_and_commit') {
      lines.push('- grocery.generate_and_commit');
      lines.push('  input: {} or {"mode":"append"|"replace"|"prune"} or {"source":"draft_chat_offer"}');
    } else if (capability === 'grocery.preview') {
      lines.push('- grocery.preview');
      lines.push('  input: {}');
    } else if (capability === 'weekly_plan.patch') {
      lines.push('- weekly_plan.patch');
      lines.push('  input: {"patch":{"label"?:string,"meals"?:string[],"mealEdits"?:Array<{"op":"set","slot":number,"meal":string}|{"op":"replace_match","match":string,"meal":string}|{"op":"append","meal":string}|{"op":"remove","slot":number}>,"notes"?:string,"status"?: "empty"}}');
    } else if (capability === 'chat.rename') {
      lines.push('- chat.rename');
      lines.push('  input: {"mode":"auto"} or {"mode":"manual","args":{"title":"short title"}}');
    } else if (capability === 'help.show') {
      lines.push('- help.show');
      lines.push('  input: {}');
    }
  }
  return lines.length > 0 ? lines.join('\n') : '(none)';
}

export async function runSmartModeInterpreter(anthropic, context) {
  const userPayload = typeof context === 'object' && context !== null ? JSON.stringify(context, null, 0) : '{}';
  const allowedCapabilitySet = new Set(
    (Array.isArray(context?.allowedCapabilities) ? context.allowedCapabilities : [])
      .map((entry) => String(entry?.capability ?? '').trim())
      .filter(Boolean)
  );
  const capabilitySpec = buildInterpreterCapabilitySpec(context?.allowedCapabilities);
  const callPurpose = 'smart_interpreter';
  const res = await createLoggedAnthropicMessage(anthropic, {
    model: resolveAnthropicModelForCallPurpose(callPurpose),
    max_tokens: 1024,
    system: `You are a strict Smart Mode interpreter for a household chat app. Output ONLY one JSON object.

Required envelope:
{"version":2,"type":"reply|clarify|actions","confidence":0.0}

Optional for type reply only:
- durable_memory_scope: tells the server how much Smart durable memory (person + household_note entities) to inject before generating the visible reply.
  - Omit or "auto": default keyword/relevance selection (existing behavior).
  - "none": inject no saved entity memory this turn (rare: user rejects using saved prefs).
  - "all_people": load all saved person entities (bounded by server caps).
  - "all_household_notes": load all household-wide notes.
  - "full": load people and household notes (bounded by server caps).
  - {"mode":"labels","labels":["Name1","Name2"]}: load entities whose labels match those names (for questions about specific people or notes).

Allowed result types:
- reply: no action is needed; the normal assistant reply path should handle the turn
- clarify: ask one short clarifying question before any action
- actions: return one or more strict typed actions for the server to validate and execute

Action shape:
{"capability":"capability_id","input":{...}}

Allowed capabilities appear in context.allowedCapabilities.
Treat each allowed capability as a skill the server can execute for this turn.

Current capabilities and valid inputs for this turn:
${capabilitySpec}

Rules:
- version must be 2
- confidence must be 0.0 to 1.0
- If type is actions, include actions: [...]
- If type is clarify, include question only
- If type is reply, include no actions; you may include durable_memory_scope as described above
- Never say an action already happened
- Prefer reply unless an action is clearly requested
- Use actions when the user is clearly asking KitchenBot to execute something and the action is well specified
- The core runtime only reads, classifies, executes allowed skills, and replies. Do not invent hidden planners, draft state, or extra runtime phases.
- Do not output or reference pending_action or any pending result type; if a server-side follow-up choice or confirmation is needed, still choose actions for the immediate executable step and let runtime attach a lightweight next-step state after execution
- Treat this classifier as the primary Smart Mode decision-maker for reply vs actions vs clarify
- context.weeklyPlanDraftCompact is a special-case artifact, not the default frame for all food conversations
- context.activeProposedNextActionSummary is the current lightweight server-owned next-step object when one exists; use it to interpret follow-ups semantically instead of requiring exact yes/no phrasing
- Prefer the current user message, recent visible conversation, and active next-step state over stale stored artifacts
- For meal ideas, dinner ideas, "what should I make", and similar brainstorming or option-generation turns, prefer reply unless the user clearly asks to save, update, replace, swap, or commit stored weekly-plan state
- Weekly-plan drafts and meal-plan summaries are background context, not first-class instructions
- For memory.save:
  - Use actions when the user explicitly says to remember, save, note, or keep something for later and the key/value can be inferred
  - Use clarify only when the key/value is genuinely too ambiguous to execute safely
- For chat.rename:
  - Use actions for explicit rename requests, including "rename this chat" and "rename this chat to ..."
  - Use clarify only if the user wants a rename but the requested title is genuinely unclear
- For help.show:
- Use actions when the user is asking what KitchenBot can or cannot do, for help, for commands, or for capabilities
- For grocery.generate_and_commit:
  - Use actions when the user clearly asks to create, update, refresh, or populate the Grocery List tab
  - If they are only asking what they would need to buy, prefer reply unless a shopping-list preview/action is clearly desired
  - If context.activeProposedNextActionSummary is a grocery follow-up and the user says things like "generate the grocery list", "make the grocery list", "update the grocery list", or equivalent follow-up phrasing, treat that as intent to proceed with the next grocery step rather than forcing another preview
  - If they ask to see, read, review, or preview the list, prefer reply or the read-first preview path
- One-off cooking, hosting, ingredient-use, or pairing conversations are often reply turns unless the user clearly requests an app action
- For collaborative weekly meal planning turns, use weekly_plan.patch only when the user is clearly asking to save, update, replace, swap, or commit the stored plan
- For weekly planning, preserve existing dinners unless the user clearly replaces the whole plan
- For weekly planning, expand rough placeholders into plausible dinner concepts instead of echoing vague text when the request gives enough context
- For weekly planning, if the user refines or swaps one dinner, prefer weekly_plan.patch with mealEdits instead of replacing the whole meals array
- If the user asks for ingredients, what is in a meal, or what goes into the current weekly plan, that is usually a reply, not a grocery action
- If the user asks what they would need to buy or shop for, that can still be a reply-style shopping preview unless they clearly ask to create, update, or populate the Grocery List tab
- Grocery tab changes are actions only when the user is clearly asking to update app state, such as generate/create/update the grocery list
- If the user explicitly asks to create or update a grocery list, prefer actions
- context.householdMemoriesCompact contains selected Smart durable memory for this turn; on meal/grocery/planning turns it may include all saved people plus relevant household notes
- Use durable_memory_scope all_people, all_household_notes, full, or labels when the user asks what is saved, who is in the household, facts about a named person, or needs an answer grounded in stored entities; use auto for casual turns that may still benefit from keyword-matched memories; use none only when injecting saved memory would mislead
- For meal ideas, weekly planning, substitutions, and grocery actions, treat saved people/preferences as real household constraints by default unless the user narrows the audience
- For meal ideas / dinner brainstorming / "what should I make" / weekly-plan ideation where audience is broad ("we", "everyone", household implied) or unspecified, prefer durable_memory_scope = "full" so the final reply can consider both people and household notes before suggesting meals
- If the user explicitly names a person, weight that person's saved notes most heavily; for direct questions about that person, labels scope is often appropriate
- Weekly plan patch must never be combined with grocery.generate_and_commit in the same response
- If you return two actions, confidence must be at least 0.85
- Do not output markdown or commentary`,
    messages: [
      {
        role: 'user',
        content: `Context (JSON):\n${userPayload}`,
      },
    ],
  }, {
    householdId: context?.householdId,
    chatId: context?.chatId,
    smartModeEnabled: true,
    callSurface: 'background',
    callPurpose,
    webSearchEnabledAtCall: false,
    usedWebSearchTool: false,
  });

  const blocks = res.content.filter((b) => b.type === 'text');
  const raw = blocks.map((b) => b.text).join('\n').trim();
  const parsed = parseJsonObjectFromModelText(raw);
  const validated = validateSmartRuntimeInterpreterOutput(parsed);
  if (!validated) return null;
  if (validated.kind === 'actions') {
    const allAllowed = validated.actions.every((action) => allowedCapabilitySet.has(String(action?.capability ?? '').trim()));
    if (!allAllowed) return null;
  }
  return validated;
}

export { CONFIDENCE_FLOOR, TWO_ACTION_CONFIDENCE_FLOOR, parseJsonObjectFromModelText };
