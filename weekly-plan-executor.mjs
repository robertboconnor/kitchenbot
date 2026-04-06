import { getChatThreadContext, updateWeeklyPlanDraft } from './db.mjs';
import { createLoggedAnthropicMessage } from './anthropic-usage.mjs';
import { resolveAnthropicModelForCallPurpose } from './anthropic-model-policy.mjs';

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

function sanitizeMealTitle(raw) {
  return String(raw ?? '').trim().slice(0, 120);
}

function sanitizeMealList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 20)
    .map((meal) => sanitizeMealTitle(meal))
    .filter(Boolean);
}

function sanitizeMealEdit(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const op = String(raw.op ?? '').trim().toLowerCase();
  if (op === 'set') {
    const slot = Math.trunc(Number(raw.slot));
    const meal = sanitizeMealTitle(raw.meal);
    if (!Number.isFinite(slot) || slot < 1 || slot > 20 || !meal) return null;
    return { op: 'set', slot, meal };
  }
  if (op === 'append') {
    const meal = sanitizeMealTitle(raw.meal);
    if (!meal) return null;
    return { op: 'append', meal };
  }
  if (op === 'remove') {
    const slot = Math.trunc(Number(raw.slot));
    if (!Number.isFinite(slot) || slot < 1 || slot > 20) return null;
    return { op: 'remove', slot };
  }
  if (op === 'replace_match') {
    const match = String(raw.match ?? '').trim().slice(0, 120);
    const meal = sanitizeMealTitle(raw.meal);
    if (!match || !meal) return null;
    return { op: 'replace_match', match, meal };
  }
  return null;
}

function sanitizeCollaborativeWeeklyPatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(raw, 'label') && typeof raw.label === 'string') {
    patch.label = raw.label.trim().slice(0, 200);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'meals')) {
    if (!Array.isArray(raw.meals)) return null;
    patch.meals = sanitizeMealList(raw.meals);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'mealEdits')) {
    if (!Array.isArray(raw.mealEdits)) return null;
    patch.mealEdits = raw.mealEdits.map((edit) => sanitizeMealEdit(edit)).filter(Boolean);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'notes') && typeof raw.notes === 'string') {
    patch.notes = raw.notes.trim().slice(0, 500);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'status')) {
    const status = String(raw.status ?? '').trim().toLowerCase();
    if (status === 'empty') patch.status = status;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

function countSlotChanges(beforeMeals, afterMeals) {
  const before = Array.isArray(beforeMeals) ? beforeMeals : [];
  const after = Array.isArray(afterMeals) ? afterMeals : [];
  const max = Math.max(before.length, after.length);
  let changed = 0;
  let preserved = 0;
  for (let i = 0; i < max; i += 1) {
    const b = String(before[i] ?? '').trim();
    const a = String(after[i] ?? '').trim();
    if (b && a && b === a) preserved += 1;
    if (b !== a) changed += 1;
  }
  return { changedSlots: changed, preservedSlots: preserved };
}

async function resolveWeeklyPlanPatchWithModel({
  anthropic,
  prompt,
  priorDraft,
  rawPatch,
  householdId = null,
  chatId = null,
  deps = {},
}) {
  if (!anthropic) return sanitizeCollaborativeWeeklyPatch(rawPatch);
  const weeklyPlanDraftCompact = typeof deps.formatWeeklyPlanDraftForPrompt === 'function'
    ? deps.formatWeeklyPlanDraftForPrompt(priorDraft ?? {})
    : JSON.stringify(priorDraft ?? {});
  const payload = {
    priorWeeklyPlanDraft: priorDraft ?? {},
    priorWeeklyPlanDraftCompact: weeklyPlanDraftCompact,
    userMessage: String(prompt ?? '').trim(),
    hintedPatch: rawPatch ?? {},
  };
  const callPurpose = 'weekly_plan_auto_update';
  const res = await createLoggedAnthropicMessage(anthropic, {
    model: resolveAnthropicModelForCallPurpose(callPurpose),
    max_tokens: 700,
    system: `You resolve weekly dinner plan updates for a household planner. Output ONLY one JSON object.

Allowed keys:
- "label": short string
- "meals": full replacement array of short dinner titles
- "mealEdits": array of targeted edits. Each item must be one of:
  {"op":"set","slot":1-based integer,"meal":"short dinner title"}
  {"op":"replace_match","match":"prior meal text","meal":"short dinner title"}
  {"op":"append","meal":"short dinner title"}
  {"op":"remove","slot":1-based integer}
- "notes": short string
- "status": "empty"

Rules:
- Preserve other dinners unless the user clearly replaces the whole weekly plan.
- If the user refines one dinner, prefer mealEdits over replacing the whole meals array.
- Expand rough placeholders into plausible dinner concepts. Avoid storing vague text like "some tofu thing" when you can turn it into a concrete dinner idea grounded in the request.
- Keep meal titles short and natural, like "miso-glazed salmon" or "crispy baked tofu bowls".
- If the user references a numbered dinner or one specific prior meal, update only that slot when possible.
- If the user clearly gives a brand-new complete set of dinners, you may return "meals" as a full replacement array.
- Do not use "status" unless the user is clearly clearing or abandoning the plan for now.
- Do not ask questions. Do not add commentary.`,
    messages: [
      {
        role: 'user',
        content: `Context JSON:\n${JSON.stringify(payload)}`,
      },
    ],
  }, {
    householdId,
    chatId,
    smartModeEnabled: true,
    callSurface: 'background',
    callPurpose,
    webSearchEnabledAtCall: false,
    usedWebSearchTool: false,
  });
  const blocks = res.content.filter((b) => b.type === 'text');
  const raw = blocks.map((b) => b.text).join('\n').trim();
  return sanitizeCollaborativeWeeklyPatch(parseJsonObjectFromModelText(raw));
}

export async function executeWeeklyPlanPatch(runtimeAction, context) {
  const { req, chatId, prompt, anthropic, deps = {} } = context;
  const rawPatch = runtimeAction?.input?.patch;
  if (!rawPatch || typeof rawPatch !== 'object') {
    return { capability: 'weekly_plan.patch', status: 'invalid', error: 'Patch is required.' };
  }

  const threadCtx = await getChatThreadContext(chatId, req.householdId);
  const priorDraft = threadCtx.weeklyPlanDraft ?? {};
  const resolvedPatch =
    (await resolveWeeklyPlanPatchWithModel({
      anthropic,
      prompt,
      priorDraft,
      rawPatch,
      householdId: req.householdId,
      chatId,
      deps,
    }).catch(() => null)) || sanitizeCollaborativeWeeklyPatch(rawPatch);

  if (!resolvedPatch) {
    return { capability: 'weekly_plan.patch', status: 'invalid', error: 'Patch is required.' };
  }

  await updateWeeklyPlanDraft(chatId, req.householdId, resolvedPatch);
  const updatedCtx = await getChatThreadContext(chatId, req.householdId);
  const updatedDraft = updatedCtx.weeklyPlanDraft ?? {};
  const diff = countSlotChanges(priorDraft.meals, updatedDraft.meals);

  return {
    capability: 'weekly_plan.patch',
    status: 'patched',
    patch: rawPatch,
    resolvedPatch,
    updatedDraft,
    changedSlots: diff.changedSlots,
    preservedSlots: diff.preservedSlots,
  };
}
