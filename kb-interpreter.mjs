import { buildClarifyActionState } from './kb-next-action.mjs';
import { normalizeGroundedTurn } from './kb-grounding.mjs';
import { normalizeKbSkillAction } from './kb-skills.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

function promptMentionsGrocerySurface(prompt = '') {
  return /\b(grocery list|groceries|shopping list|shopping)\b/i.test(safeTrim(prompt));
}

function promptMentionsCookbookSurface(prompt = '') {
  return /\b(cookbook|saved recipes?|saved meals?|favorites?)\b/i.test(safeTrim(prompt));
}

function promptLooksLikeQuestion(prompt = '') {
  const text = safeTrim(prompt);
  if (!text) return false;
  return /\?\s*$/.test(text) || /^(what|which|when|where|why|how|can you tell me|do we have)\b/i.test(text);
}

function promptRequestsCommit(prompt = '') {
  const text = safeTrim(prompt);
  if (!text) return false;
  return /\b(add|put|make|build|create|write|load|update|get|buy|grab|need|use)\b/i.test(text);
}

function promptRequestsSave(prompt = '') {
  const text = safeTrim(prompt);
  if (!text) return false;
  return /\b(save|add|put|keep|store)\b/i.test(text);
}

function hasCommittableCurrentObject(groundedTurn = null) {
  const currentObject = groundedTurn?.currentObject;
  const type = safeTrim(currentObject?.objectType);
  return ['meal_set', 'meal_set_selection', 'grocery_proposal', 'chat_recipe'].includes(type);
}

function shouldPromoteCurrentObjectToGroceryWrite(groundedTurn = null, prompt = '') {
  const grounded = normalizeGroundedTurn(groundedTurn);
  if (grounded.turnMode === 'execute_action') return false;
  if (!hasCommittableCurrentObject(grounded)) return false;
  if (!promptMentionsGrocerySurface(prompt)) return false;
  if (promptLooksLikeQuestion(prompt)) return false;
  return promptRequestsCommit(prompt);
}

function shouldPromoteCurrentObjectToCookbookSave(groundedTurn = null, prompt = '') {
  const grounded = normalizeGroundedTurn(groundedTurn);
  if (grounded.turnMode === 'execute_action') return false;
  if (safeTrim(grounded.currentObject?.objectType) !== 'chat_recipe') return false;
  if (!promptMentionsCookbookSurface(prompt)) return false;
  if (promptLooksLikeQuestion(prompt)) return false;
  return promptRequestsSave(prompt);
}

function capabilityForIntent(intent = '') {
  switch (safeTrim(intent)) {
    case 'revise_recipe':
      return 'recipe.revise';
    case 'save_recipe':
      return 'cookbook.save';
    case 'update_saved_recipe':
      return 'cookbook.update';
    case 'list_saved_recipes':
      return 'cookbook.list';
    case 'delete_saved_recipe':
      return 'cookbook.delete';
    case 'rename_chat':
      return 'chat.rename';
    case 'add_grocery_items':
    case 'add_recipe_ingredients_to_grocery_list':
      return 'grocery.write';
    case 'remove_grocery_items':
      return 'grocery.remove';
    case 'check_grocery_items':
      return 'grocery.check';
    case 'uncheck_grocery_items':
      return 'grocery.uncheck';
    case 'clear_grocery_list':
      return 'grocery.clear';
    case 'add_pantry_items':
      return 'pantry.add';
    case 'remove_pantry_items':
      return 'pantry.remove';
    case 'move_pantry_to_grocery':
      return 'pantry.move_to_grocery';
    case 'move_grocery_to_pantry':
      return 'grocery.move_to_pantry';
    case 'save_memory':
      return 'memory.save';
    case 'revise_meal_plan':
      return 'meal.refine';
    case 'search_web':
      return 'web.search';
    default:
      return '';
  }
}

function inputForIntent(intent = '', prompt = '') {
  const text = safeTrim(prompt);
  switch (safeTrim(intent)) {
    case 'revise_recipe':
      return { request: text };
    case 'save_recipe':
      return { request: text };
    case 'update_saved_recipe':
      return { request: text };
    case 'delete_saved_recipe':
      return { name: text };
    case 'rename_chat':
      return { request: text };
    case 'add_grocery_items':
    case 'add_recipe_ingredients_to_grocery_list':
      return {};
    case 'remove_grocery_items':
    case 'check_grocery_items':
    case 'uncheck_grocery_items':
    case 'move_pantry_to_grocery':
    case 'move_grocery_to_pantry':
    case 'remove_pantry_items':
      return { name: text };
    case 'add_pantry_items':
      return { payload: text };
    case 'save_memory':
      return { payload: text };
    case 'revise_meal_plan':
      return { request: text };
    case 'search_web':
      return { query: text };
    default:
      return {};
  }
}

function fallbackClarifyQuestion(groundedTurn, prompt = '') {
  const grounded = normalizeGroundedTurn(groundedTurn);
  if (safeTrim(grounded.clarifyQuestion)) return safeTrim(grounded.clarifyQuestion);
  if (grounded.surface === 'conversation' && grounded.intent === 'revise_recipe') {
    return 'Which recipe do you want me to revise?';
  }
  if (grounded.surface === 'cookbook' && grounded.intent === 'update_saved_recipe') {
    return 'Which saved cookbook recipe do you want me to update?';
  }
  if (grounded.surface === 'cookbook' && grounded.intent === 'delete_saved_recipe') {
    return 'Which saved cookbook recipe do you want me to delete?';
  }
  if (grounded.surface === 'chat' && grounded.intent === 'rename_chat') {
    return 'What should I rename this chat to?';
  }
  if (grounded.surface === 'memory' && grounded.intent === 'save_memory') {
    return 'What do you want me to remember, and who should it be about?';
  }
  if (grounded.surface === 'meal_plan' && grounded.intent === 'revise_meal_plan') {
    return 'What meals or dinner ideas do you want me to revise?';
  }
  return safeTrim(prompt) ? 'Can you clarify what you want me to do?' : 'Can you clarify that?';
}

function buildClarifyTurn(groundedTurn, prompt = '') {
  const grounded = normalizeGroundedTurn(groundedTurn);
  const question = fallbackClarifyQuestion(grounded, prompt);
  const capability = capabilityForIntent(grounded.intent);
  if (!capability) return { kind: 'clarify', question, groundedTurn: grounded };

  const proposedNextAction = buildClarifyActionState({
    capability,
    input: inputForIntent(grounded.intent, prompt),
    question,
    contextSummary: `Continue the pending ${capability} action once the missing target or detail is resolved.`,
    unresolvedFields: ['target'],
    candidateOptions: grounded.clarifyChoices || [],
    visibleReplySummary: question,
  });
  return {
    kind: 'clarify',
    question,
    proposedNextAction,
    groundedTurn: grounded,
  };
}

function buildExecuteTurn({ groundedTurn, prompt = '', runtimeProposedNextAction = null, memoryContext = null }) {
  const grounded = normalizeGroundedTurn(groundedTurn);
  const capability = capabilityForIntent(grounded.intent);
  if (!capability) {
    return { kind: 'reply_only', replyPlan: { kind: 'generate_reply' }, groundedTurn: grounded };
  }

  const normalizedAction = normalizeKbSkillAction(
    {
      capability,
      input: inputForIntent(grounded.intent, prompt),
    },
    {
      originalPrompt: prompt,
      pendingAction: runtimeProposedNextAction,
      webSearchEnabled: !!memoryContext?.capabilities?.webSearchEnabled,
      workingContext: memoryContext?.workingContext,
      memoryContext,
      groundedTurn: grounded,
    }
  );

  if (!normalizedAction) {
    return buildClarifyTurn(grounded, prompt);
  }

  return {
    kind: 'execute_action',
    actions: [normalizedAction],
    groundedTurn: grounded,
  };
}

export async function interpretKbTurn({
  prompt = '',
  groundedTurn = null,
  runtimeProposedNextAction = null,
  memoryContext = null,
} = {}) {
  const grounded = normalizeGroundedTurn(groundedTurn);
  if (shouldPromoteCurrentObjectToCookbookSave(grounded, prompt)) {
    return buildExecuteTurn({
      groundedTurn: {
        ...grounded,
        turnMode: 'execute_action',
        surface: 'cookbook',
        intent: 'save_recipe',
        confidence: grounded.confidence || 'medium',
        rationale: safeTrim(grounded.rationale || 'current_object_cookbook_save'),
      },
      prompt,
      runtimeProposedNextAction,
      memoryContext,
    });
  }
  if (shouldPromoteCurrentObjectToGroceryWrite(grounded, prompt)) {
    return buildExecuteTurn({
      groundedTurn: {
        ...grounded,
        turnMode: 'execute_action',
        surface: 'grocery',
        intent: 'add_grocery_items',
        confidence: grounded.confidence || 'medium',
        rationale: safeTrim(grounded.rationale || 'current_object_grocery_commit'),
      },
      prompt,
      runtimeProposedNextAction,
      memoryContext,
    });
  }
  if (grounded.turnMode === 'clarify') return buildClarifyTurn(grounded, prompt);
  if (grounded.turnMode === 'execute_action') {
    return buildExecuteTurn({
      groundedTurn: grounded,
      prompt,
      runtimeProposedNextAction,
      memoryContext,
    });
  }
  return {
    kind: 'reply_only',
    replyPlan: { kind: 'generate_reply' },
    groundedTurn: grounded,
  };
}
