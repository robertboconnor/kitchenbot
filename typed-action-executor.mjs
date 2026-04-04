import {
  classifyRuntimeAction,
  normalizeRuntimeAction,
  pendingActionToRuntimeAction,
} from './capability-registry.mjs';
import { executeChatRename, executeHelpShow } from './chat-executor.mjs';
import { executeGroceryGenerateAndCommit } from './grocery-executor.mjs';
import { executeMemorySave } from './memory-executor.mjs';
import { executeWeeklyPlanPatch } from './weekly-plan-executor.mjs';

export async function dispatchTypedAction(action, context) {
  const normalizedAction = normalizeRuntimeAction(action) || pendingActionToRuntimeAction(action);
  const classified = normalizedAction ? classifyRuntimeAction(normalizedAction) : null;
  if (!classified) {
    console.error('dispatchTypedAction: unknown typed action', {
      rawAction: action,
      normalizedAction: normalizedAction || null,
      prompt: context?.prompt ?? null,
      chatId: context?.chatId ?? null,
      householdId: context?.req?.householdId ?? null,
    });
    const err = new Error('Unknown typed action');
    err.rawAction = action;
    err.normalizedAction = normalizedAction || null;
    throw err;
  }

  switch (classified.capability) {
    case 'memory.save':
      return executeMemorySave(classified.action, context);
    case 'grocery.generate_and_commit':
      return executeGroceryGenerateAndCommit(classified.action, context);
    case 'weekly_plan.patch':
      return executeWeeklyPlanPatch(classified.action, context);
    case 'chat.rename':
      return executeChatRename(classified.action, context);
    case 'help.show':
      return executeHelpShow(classified.action, context);
    default:
      throw new Error(`No executor for capability ${classified.capability}`);
  }
}

export async function dispatchTypedActionPlan(actions, context) {
  const results = [];
  for (const action of actions) {
    results.push(await dispatchTypedAction(action, context));
  }
  return results;
}
