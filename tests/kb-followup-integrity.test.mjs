import test from 'node:test';
import assert from 'node:assert/strict';

import { buildClarifyActionState } from '../kb-next-action.mjs';
import { interpretKbSkillFollowUp, normalizeKbSkillAction } from '../kb-skills.mjs';
import {
  rewriteUngroundedActionOfferReply,
  rewriteUngroundedMutationClaimReply,
  shouldForceDeterministicOutcomeReply,
} from '../kb-reply.mjs';

test('web.search action normalization reuses offered search topic for referential search acceptance', () => {
  const action = normalizeKbSkillAction(
    { capability: 'web.search', input: {} },
    {
      webSearchEnabled: true,
      originalPrompt: 'sure search the web',
      workingContext: {
        offeredSearchTopic: 'classic Transfusion cocktail recipe with grape juice and ginger ale',
      },
      memoryContext: {
        workingContext: {
          offeredSearchTopic: 'classic Transfusion cocktail recipe with grape juice and ginger ale',
        },
      },
    }
  );

  assert.deepEqual(action, {
    capability: 'web.search',
    input: { query: 'classic Transfusion cocktail recipe with grape juice and ginger ale' },
  });
});

test('web.search skill follow-up executes stored search query on just-that confirmation', () => {
  const nextAction = buildClarifyActionState({
    capability: 'web.search',
    input: { query: 'classic Transfusion cocktail recipe with grape juice and ginger ale' },
    question: 'If you want, I can search for the classic version.',
    contextSummary: 'Continue the pending web search.',
  });

  const turn = interpretKbSkillFollowUp('just that', nextAction, {
    memoryContext: { capabilities: { webSearchEnabled: true } },
  });

  assert.deepEqual(turn, {
    kind: 'execute_action',
    actions: [{ capability: 'web.search', input: { query: 'classic Transfusion cocktail recipe with grape juice and ginger ale' } }],
    routePrompt: 'just that',
  });
});

test('grocery.write skill follow-up carries offered ingredients through all', () => {
  const nextAction = buildClarifyActionState({
    capability: 'grocery.write',
    input: {
      source: 'offered_items',
      items: [
        { name: 'vodka', amount: '', section: '' },
        { name: 'Concord grape juice', amount: '', section: '' },
        { name: 'fresh limes', amount: '', section: '' },
        { name: 'ginger ale', amount: '', section: '' },
      ],
    },
    question: 'If you want, I can add those ingredients to the Grocery List tab.',
    contextSummary: 'Continue the pending grocery add for the offered ingredients.',
  });

  const turn = interpretKbSkillFollowUp('all', nextAction, {});

  assert.deepEqual(turn, {
    kind: 'execute_action',
    actions: [{
      capability: 'grocery.write',
      input: {
        source: 'offered_items',
        items: [
          { name: 'vodka', amount: '', section: '' },
          { name: 'Concord grape juice', amount: '', section: '' },
          { name: 'fresh limes', amount: '', section: '' },
          { name: 'ginger ale', amount: '', section: '' },
        ],
      },
    }],
    routePrompt: 'all',
  });
});

test('grocery.write follow-up does not hijack a terse recipe edit into the grocery lane', () => {
  const nextAction = buildClarifyActionState({
    capability: 'grocery.write',
    input: {
      source: 'offered_items',
      items: [
        { name: 'cotija cheese', amount: '', section: '' },
        { name: 'lime', amount: '', section: '' },
      ],
    },
    question: 'If you want, I can add those ingredients to the Grocery List tab.',
    contextSummary: 'Continue the pending grocery add for the offered ingredients.',
  });

  const turn = interpretKbSkillFollowUp('add tajin', nextAction, {});

  assert.equal(turn, null);
});

test('grocery.write normalization rejects non-grocery recipe edit prompts', () => {
  const action = normalizeKbSkillAction(
    { capability: 'grocery.write', input: {} },
    {
      originalPrompt: 'add tajin',
      workingContext: {
        offeredIngredients: ['cotija cheese', 'lime'],
      },
      memoryContext: {
        workingContext: {
          offeredIngredients: ['cotija cheese', 'lime'],
        },
      },
    }
  );

  assert.equal(action, null);
});

test('grocery.write normalization uses the grounded meal_set current object for referential grocery commits', () => {
  const action = normalizeKbSkillAction(
    { capability: 'grocery.write', input: {} },
    {
      originalPrompt: 'add all of that to the grocery list',
      groundedTurn: {
        surface: 'grocery',
        intent: 'add_grocery_items',
        activeObjects: [{ type: 'grocery_list', label: 'Household grocery list' }],
        currentObject: {
          objectType: 'meal_set',
          versionSummary: 'Weeknight dinner plan',
          mealIdeas: ['lemon pasta', 'cod bowls', 'chicken tortilla soup'],
          subjectItems: ['lemon pasta', 'cod bowls', 'chicken tortilla soup'],
          activeConstraints: ['salmon swapped to cod'],
          groceryFocus: ['lemon pasta', 'cod bowls', 'chicken tortilla soup'],
        },
      },
    }
  );

  assert.deepEqual(action, {
    capability: 'grocery.write',
    input: {
      source: 'meal_set',
      sourceMealSet: {
        objectType: 'meal_set',
        versionSummary: 'Weeknight dinner plan',
        mealIdeas: ['lemon pasta', 'cod bowls', 'chicken tortilla soup'],
        subjectItems: ['lemon pasta', 'cod bowls', 'chicken tortilla soup'],
        activeConstraints: ['salmon swapped to cod'],
        groceryFocus: ['lemon pasta', 'cod bowls', 'chicken tortilla soup'],
      },
      targetList: 'household_grocery_list',
    },
  });
});

test('grocery.write normalization uses the grounded meal_set_selection current object for partial grocery commits', () => {
  const action = normalizeKbSkillAction(
    { capability: 'grocery.write', input: {} },
    {
      originalPrompt: 'just add the pasta and soup to the grocery list',
      groundedTurn: {
        surface: 'grocery',
        intent: 'add_grocery_items',
        activeObjects: [{ type: 'grocery_list', label: 'Household grocery list' }],
        currentObject: {
          objectType: 'meal_set_selection',
          versionSummary: 'Selected meals from the current meal set',
          mealIdeas: ['cacio e pepe', 'white bean soup'],
          subjectItems: ['cacio e pepe', 'white bean soup'],
          selectionScope: 'Selected meals from the current meal set',
        },
      },
    }
  );

  assert.deepEqual(action, {
    capability: 'grocery.write',
    input: {
      source: 'meal_set_selection',
      sourceMealSetSelection: {
        objectType: 'meal_set_selection',
        versionSummary: 'Selected meals from the current meal set',
        mealIdeas: ['cacio e pepe', 'white bean soup'],
        subjectItems: ['cacio e pepe', 'white bean soup'],
        selectionScope: 'Selected meals from the current meal set',
      },
      targetList: 'household_grocery_list',
    },
  });
});

test('cookbook.save normalization uses the grounded chat_recipe current object', () => {
  const action = normalizeKbSkillAction(
    { capability: 'cookbook.save', input: {} },
    {
      originalPrompt: 'save it to our cookbook',
      groundedTurn: {
        surface: 'cookbook',
        intent: 'save_recipe',
        currentObject: {
          objectType: 'chat_recipe',
          title: 'Easy Thai Coconut Soup',
          versionSummary: 'Easy Thai Coconut Soup',
          recipeText: 'Easy Thai Coconut Soup\\n\\nIngredients\\n- coconut milk\\n- broth\\n\\nInstructions\\n1. Simmer.',
          recipeRecord: {
            title: 'Easy Thai Coconut Soup',
            summary: 'A very simple coconut soup.',
            ingredients: ['coconut milk', 'broth'],
            instructions: ['Simmer.'],
            sourceKind: 'kb_generated',
          },
        },
      },
    }
  );

  assert.equal(action.capability, 'cookbook.save');
  assert.equal(action.input.targetRecipe.type, 'chat_recipe');
  assert.equal(action.input.targetRecipe.title, 'Easy Thai Coconut Soup');
});

test('cookbook.update follow-up executes replace-it confirmation from a revised recipe offer', () => {
  const nextAction = buildClarifyActionState({
    capability: 'cookbook.update',
    input: {
      id: 12,
      revisedRecord: {
        title: 'Elotes-Style Pasta Salad',
        summary: 'A creamy pasta salad with Tajin.',
        ingredients: ['1 lb pasta', '1 tsp Tajin'],
        instructions: ['Cook the pasta.', 'Whisk in the Tajin.'],
      },
    },
    question: 'If you want, I can replace Elotes-Style Pasta Salad in your cookbook with this revised version.',
    contextSummary: 'Continue the pending cookbook replacement.',
  });

  const turn = interpretKbSkillFollowUp('replace it', nextAction, {});

  assert.deepEqual(turn, {
    kind: 'execute_action',
    actions: [{
      capability: 'cookbook.update',
      input: {
        id: 12,
        revisedRecord: {
          title: 'Elotes-Style Pasta Salad',
          summary: 'A creamy pasta salad with Tajin.',
          ingredients: ['1 lb pasta', '1 tsp Tajin'],
          instructions: ['Cook the pasta.', 'Whisk in the Tajin.'],
        },
      },
    }],
    routePrompt: 'replace it',
  });
});

test('fragile outcomes force deterministic fallback narration', () => {
  assert.equal(
    shouldForceDeterministicOutcomeReply([{ capability: 'web.search', status: 'unavailable' }]),
    true
  );
  assert.equal(
    shouldForceDeterministicOutcomeReply([{ capability: 'grocery.write', status: 'already_present' }]),
    true
  );
  assert.equal(
    shouldForceDeterministicOutcomeReply([{ capability: 'grocery.write', status: 'committed' }]),
    false
  );
});

test('reply guard rewrites bare yes invitations when no next action exists', () => {
  const rewritten = rewriteUngroundedActionOfferReply(
    "Say yes and I'll search for the classic Transfusion cocktail recipe with grape juice and ginger ale."
  );

  assert.doesNotMatch(rewritten, /\bsay yes\b/i);
  assert.match(rewritten, /if you want that, ask me to/i);
});

test('reply guard rewrites ungrounded save invitations when no next action exists', () => {
  const rewritten = rewriteUngroundedActionOfferReply(
    'Would you like me to save this as a preference note like: Elle | olives okay in sandwiches as a supporting ingredient, not as the main focus?'
  );

  assert.doesNotMatch(rewritten, /\bwould you like me to save\b/i);
  assert.match(rewritten, /if you want me to save/i);
});

test('reply guard rewrites if-you-would-like-save invitations when no next action exists', () => {
  const rewritten = rewriteUngroundedActionOfferReply(
    "If you'd like me to save that for Elle now, just let me know."
  );

  assert.doesNotMatch(rewritten, /\bif you'd like me to save\b/i);
  assert.match(rewritten, /if you want me to save/i);
});

test('reply guard rewrites ungrounded grocery success claims when no grocery action ran', () => {
  const rewritten = rewriteUngroundedMutationClaimReply(
    "I've added all of those ingredients to your Grocery List. All set!",
    {
      outcomes: [],
      routePrompt: 'okay add it to the grocery list',
      groundedTurn: {
        currentObject: {
          objectType: 'grocery_proposal',
          versionSummary: 'Updated grocery list without mushrooms',
        },
      },
      proposedNextAction: null,
    }
  );

  assert.doesNotMatch(rewritten, /\bi(?:'ve| have)? added\b/i);
  assert.match(rewritten, /if you want me to add/i);
});

test('reply guard rewrites ungrounded cookbook success claims when no cookbook action ran', () => {
  const rewritten = rewriteUngroundedMutationClaimReply(
    "I've saved Wonton Soup Stock to your cookbook. You'll find it there whenever you need it.",
    {
      outcomes: [],
      routePrompt: 'okay this looks really good. add it to our cookbook',
      groundedTurn: {
        currentObject: {
          objectType: 'chat_recipe',
          versionSummary: 'Wonton Soup Stock',
        },
      },
      proposedNextAction: null,
    }
  );

  assert.doesNotMatch(rewritten, /\bi(?:'ve| have)? saved\b/i);
  assert.match(rewritten, /if you want me to save/i);
});
