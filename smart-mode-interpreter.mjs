import { normalizeRuntimeAction, normalizeRuntimeActionList } from './capability-registry.mjs';

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
    if (parsed.pending_action != null) return null;
    return { kind: 'reply' };
  }

  if (type === 'clarify') {
    const question = String(parsed.question ?? '').trim();
    if (!question) return null;
    if (parsed.actions != null || parsed.pending_action != null) return null;
    return { kind: 'clarify', question };
  }

  if (type === 'pending') {
    const action = normalizeRuntimeAction(parsed.pending_action);
    if (!action) return null;
    return { kind: 'pending', action };
  }

  if (type === 'actions') {
    const actions = normalizeRuntimeActionList(parsed.actions);
    if (actions.length === 0) return null;
    if (actions.length >= 2 && confidence < TWO_ACTION_CONFIDENCE_FLOOR) return null;
    return { kind: 'actions', actions };
  }

  return null;
}

export async function runSmartModeInterpreter(anthropic, context) {
  const userPayload = typeof context === 'object' && context !== null ? JSON.stringify(context, null, 0) : '{}';
  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    system: `You are a strict Smart Mode interpreter for a household chat app. Output ONLY one JSON object.

Required envelope:
{"version":2,"type":"reply|clarify|pending|actions","confidence":0.0}

Allowed result types:
- reply: no action is needed; the normal assistant reply path should handle the turn
- clarify: ask one short clarifying question before any action
- pending: propose exactly one action that likely needs explicit user confirmation
- actions: return one or more strict typed actions for the server to validate and execute

Action shape:
{"capability":"capability_id","input":{...}}

Allowed capabilities appear in context.allowedCapabilities.

Current capabilities and valid inputs:
- memory.save
  input: {"key":"snake_case_key","value":"natural text"}
- grocery.generate_and_commit
  input: {} or {"mode":"append"|"replace"|"prune"} or {"source":"draft_chat_offer"}
- weekly_plan.patch
  input: {"patch":{"label"?:string,"meals"?:string[],"mealEdits"?:Array<{"op":"set","slot":number,"meal":string}|{"op":"replace_match","match":string,"meal":string}|{"op":"append","meal":string}|{"op":"remove","slot":number}>,"notes"?:string,"status"?: "empty"}}
- chat.rename
  input: {"mode":"auto"} or {"mode":"manual","args":{"title":"short title"}}
- help.show
  input: {}

Rules:
- version must be 2
- confidence must be 0.0 to 1.0
- If type is actions, include actions: [...]
- If type is pending, include pending_action only
- If type is clarify, include question only
- If type is reply, include no actions and no pending_action
- Never say an action already happened
- Prefer reply unless an action is clearly requested
- Prefer pending only when a real confirmation or missing decision is necessary before the app should change state
- Use actions when the user is clearly asking KitchenBot to execute something and the action is well specified
- Treat this classifier as the primary Smart Mode decision-maker for reply vs actions vs clarify
- Use pending sparingly; prefer actions when the user explicitly asked KitchenBot to do something in the app
- For memory.save:
  - Use actions when the user explicitly says to remember, save, note, or keep something for later and the key/value can be inferred
  - Use pending only when the user is tentative or asking whether KitchenBot should remember it
- For chat.rename:
  - Use actions for explicit rename requests, including "rename this chat" and "rename this chat to ..."
  - Use clarify only if the user wants a rename but the requested title is genuinely unclear
- For help.show:
  - Prefer actions or reply, not pending
- For grocery.generate_and_commit:
  - Use actions when the user clearly asks to create, update, refresh, or populate the Grocery List tab
  - If they are only asking what they would need to buy, prefer reply unless a shopping-list preview/action is clearly desired
- For collaborative weekly meal planning turns, prefer weekly_plan.patch actions over plain reply when the user is actively shaping the plan
- For weekly planning, preserve existing dinners unless the user clearly replaces the whole plan
- For weekly planning, expand rough placeholders into plausible dinner concepts instead of echoing vague text when the request gives enough context
- For weekly planning, if the user refines or swaps one dinner, prefer weekly_plan.patch with mealEdits instead of replacing the whole meals array
- If the user asks for ingredients, what is in a meal, or what goes into the current weekly plan, that is usually a reply, not a grocery action
- If the user asks what they would need to buy or shop for, that can still be a reply-style shopping preview unless they clearly ask to create, update, or populate the Grocery List tab
- Grocery tab changes are actions only when the user is clearly asking to update app state, such as generate/create/update the grocery list
- If the user explicitly asks to create or update a grocery list, prefer actions over pending
- Weekly plan patch must never be combined with grocery.generate_and_commit in the same response
- If you return two actions, confidence must be at least 0.85
- Do not output markdown or commentary`,
    messages: [
      {
        role: 'user',
        content: `Context (JSON):\n${userPayload}`,
      },
    ],
  });

  const blocks = res.content.filter((b) => b.type === 'text');
  const raw = blocks.map((b) => b.text).join('\n').trim();
  const parsed = parseJsonObjectFromModelText(raw);
  return validateSmartRuntimeInterpreterOutput(parsed);
}

export { CONFIDENCE_FLOOR, TWO_ACTION_CONFIDENCE_FLOOR, parseJsonObjectFromModelText };
