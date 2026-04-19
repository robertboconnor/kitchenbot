import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGroundedContextProfile,
  groundTurnFinal,
  groundTurnProvisional,
} from '../kb-grounding.mjs';

function makeAnthropic(responses) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  return {
    messages: {
      create: async () => ({
        model: 'claude-haiku-4-5-20251001',
        usage: { input_tokens: 10, output_tokens: 10 },
        content: [{ type: 'text', text: JSON.stringify(queue.shift() ?? {}) }],
      }),
    },
  };
}

test('groundTurnFinal keeps terse recipe edits on the active chat recipe surface', async () => {
  const grounded = await groundTurnFinal({
    anthropic: makeAnthropic({
      turnMode: 'execute_action',
      surface: 'conversation',
      intent: 'revise_recipe',
      confidence: 'high',
    }),
    prompt: 'Add Tajin to the dressing too.',
    recentMessages: [
      { role: 'user', name: 'Rob', content: 'Give me a good elotes-style pasta salad recipe.' },
      {
        role: 'assistant',
        name: 'KitchenBot',
        content: `Elotes-Style Pasta Salad

Ingredients
- 1 lb pasta
- 4 cups corn kernels
- 1/2 cup mayonnaise
- 1/2 cup Mexican crema

Instructions
1. Cook the pasta.
2. Make the dressing.
3. Toss everything together.`,
      },
    ],
    activeSpeakerName: 'Rob',
    workingContext: {
      offeredIngredients: ['cotija', 'corn', 'lime'],
    },
  });

  assert.equal(grounded.surface, 'conversation');
  assert.equal(grounded.intent, 'revise_recipe');
  assert.equal(grounded.turnMode, 'execute_action');
  assert.equal(grounded.activeObjects.some((object) => object.type === 'chat_recipe'), true);
  assert.equal(grounded.currentObject?.objectType, 'chat_recipe');
  assert.equal(grounded.currentObject?.title, 'Elotes-Style Pasta Salad');
});

test('groundTurnFinal prefers explicit cookbook mutations over active chat recipe context', async () => {
  const grounded = await groundTurnFinal({
    anthropic: makeAnthropic({
      turnMode: 'execute_action',
      surface: 'cookbook',
      intent: 'update_saved_recipe',
      confidence: 'high',
    }),
    prompt: 'Update Poblano White Chicken Chili in our cookbook to add cream cheese at the end.',
    recentMessages: [
      {
        role: 'assistant',
        name: 'KitchenBot',
        content: `Elotes-Style Pasta Salad

Ingredients
- 1 lb pasta

Instructions
1. Toss the salad.`,
      },
    ],
    activeSpeakerName: 'Rob',
    memoryContext: {
      cookbookEntries: [
        { id: 7, title: 'Poblano White Chicken Chili' },
        { id: 9, title: 'Elotes-Style Pasta Salad' },
      ],
      selectedCookbookEntries: [{ id: 7, title: 'Poblano White Chicken Chili' }],
    },
  });

  assert.equal(grounded.surface, 'cookbook');
  assert.equal(grounded.intent, 'update_saved_recipe');
  assert.equal(grounded.turnMode, 'execute_action');
  assert.equal(
    grounded.activeObjects.some((object) => object.type === 'cookbook_entry' && Number(object.id) === 7),
    true
  );
});

test('groundTurnFinal derives a meal_set current object for grocery commits against the revised meal thread', async () => {
  const grounded = await groundTurnFinal({
    anthropic: makeAnthropic({
      turnMode: 'execute_action',
      surface: 'grocery',
      intent: 'add_grocery_items',
      confidence: 'high',
    }),
    prompt: 'Add all of that to the grocery list.',
    recentMessages: [
      { role: 'user', name: 'Rob', content: 'Give me 3 weeknight dinner ideas.' },
      { role: 'assistant', name: 'KitchenBot', content: 'Try lemon pasta, salmon bowls, and chicken tortilla soup.' },
      { role: 'user', name: 'Rob', content: 'Okay swap out the salmon for cod.' },
    ],
    activeSpeakerName: 'Rob',
    workingContext: {
      topicSummary: 'Weeknight dinner ideas',
      mealIdeas: ['lemon pasta', 'cod bowls', 'chicken tortilla soup'],
      subjectItems: ['lemon pasta', 'cod bowls', 'chicken tortilla soup'],
      activeConstraints: ['salmon swapped to cod'],
      groceryFocus: ['lemon pasta', 'cod bowls', 'chicken tortilla soup'],
    },
  });

  assert.equal(grounded.surface, 'grocery');
  assert.equal(grounded.currentObject?.objectType, 'meal_set');
  assert.deepEqual(grounded.currentObject?.mealIdeas, ['lemon pasta', 'cod bowls', 'chicken tortilla soup']);
});

test('groundTurnFinal applies visible dish swaps when deriving the current meal_set from conversation', async () => {
  const grounded = await groundTurnFinal({
    anthropic: makeAnthropic({
      turnMode: 'reply_only',
      surface: 'conversation',
      intent: 'answer_question',
      confidence: 'medium',
    }),
    prompt: 'Okay now add all of that to the grocery list.',
    recentMessages: [
      { role: 'user', name: 'Rob', content: 'Give me 3 easy weeknight dinner ideas: one pasta, one salmon bowl, and one soup.' },
      {
        role: 'assistant',
        name: 'KitchenBot',
        content: `Here are three easy weeknight dinners for you:

**Pasta: Cacio e Pepe**
Fast and cheesy.

**Salmon Bowl: Miso Glazed Salmon with Rice and Greens**
Fast and savory.

**Soup: White Bean and Parmesan Soup**
Cozy and easy.`,
      },
      { role: 'user', name: 'Rob', content: 'Okay swap out the salmon bowl for cod.' },
      {
        role: 'assistant',
        name: 'KitchenBot',
        content: `**Miso Glazed Cod with Rice and Greens**

Use the same glaze and bowl format, just with cod instead of salmon.

The other two stay as-is: Cacio e Pepe and White Bean Parmesan Soup.`,
      },
    ],
    activeSpeakerName: 'Rob',
  });

  assert.equal(grounded.currentObject?.objectType, 'meal_set');
  assert.deepEqual(grounded.currentObject?.mealIdeas, [
    'Cacio e Pepe',
    'Miso Glazed Cod with Rice and Greens',
    'White Bean and Parmesan Soup',
  ]);
  assert.deepEqual(
    grounded.currentObject?.mealEntries?.map((entry) => entry.label),
    ['Pasta', 'cod Bowl', 'Soup']
  );
});

test('groundTurnFinal narrows a meal_set into a selected subset for partial grocery commits', async () => {
  const grounded = await groundTurnFinal({
    anthropic: makeAnthropic({
      turnMode: 'execute_action',
      surface: 'grocery',
      intent: 'add_grocery_items',
      confidence: 'high',
    }),
    prompt: 'Just add the pasta and soup to the grocery list.',
    recentMessages: [
      { role: 'user', name: 'Rob', content: 'Give me 3 easy weeknight dinner ideas: one pasta, one salmon bowl, and one soup.' },
      {
        role: 'assistant',
        name: 'KitchenBot',
        content: `Here are three easy weeknight dinners for you:

**Pasta: Cacio e Pepe**
Fast and cheesy.

**Salmon Bowl: Miso Glazed Salmon with Rice and Greens**
Fast and savory.

**Soup: White Bean and Parmesan Soup**
Cozy and easy.`,
      },
    ],
    activeSpeakerName: 'Rob',
  });

  assert.equal(grounded.currentObject?.objectType, 'meal_set_selection');
  assert.deepEqual(grounded.currentObject?.mealIdeas, ['Cacio e Pepe', 'White Bean and Parmesan Soup']);
});

test('groundTurnFinal narrows a meal_set by exclusion for grocery commits', async () => {
  const grounded = await groundTurnFinal({
    anthropic: makeAnthropic({
      turnMode: 'execute_action',
      surface: 'grocery',
      intent: 'add_grocery_items',
      confidence: 'high',
    }),
    prompt: 'Add everything except the cod bowl to the grocery list.',
    recentMessages: [
      { role: 'user', name: 'Rob', content: 'Give me 3 easy weeknight dinner ideas: one pasta, one salmon bowl, and one soup.' },
      {
        role: 'assistant',
        name: 'KitchenBot',
        content: `Here are three easy weeknight dinners for you:

**Pasta: Cacio e Pepe**
Fast and cheesy.

**Salmon Bowl: Miso Glazed Salmon with Rice and Greens**
Fast and savory.

**Soup: White Bean and Parmesan Soup**
Cozy and easy.`,
      },
      { role: 'user', name: 'Rob', content: 'Okay swap out the salmon bowl for cod.' },
      {
        role: 'assistant',
        name: 'KitchenBot',
        content: `**Miso Glazed Cod with Rice and Greens**

Use the same glaze and bowl format, just with cod instead of salmon.

The other two stay as-is: Cacio e Pepe and White Bean Parmesan Soup.`,
      },
    ],
    activeSpeakerName: 'Rob',
  });

  assert.equal(grounded.currentObject?.objectType, 'meal_set_selection');
  assert.deepEqual(grounded.currentObject?.mealIdeas, ['Cacio e Pepe', 'White Bean and Parmesan Soup']);
});

test('groundTurnFinal promotes the just-expanded recipe over the broader meal set for cookbook saves', async () => {
  const grounded = await groundTurnFinal({
    anthropic: makeAnthropic({
      turnMode: 'reply_only',
      surface: 'conversation',
      intent: 'answer_question',
      confidence: 'medium',
    }),
    prompt: 'Okay this looks really good. Add it to our cookbook.',
    recentMessages: [
      { role: 'user', name: 'Rob', content: 'Plan three easy meals for Elle this week.' },
      { role: 'assistant', name: 'KitchenBot', content: '1. Cheat wonton soup\n2. Broccoli pesto pasta\n3. Sheet-pan chicken fajitas' },
      { role: 'user', name: 'Rob', content: 'Give me the recipe for the wonton soup stock.' },
      {
        role: 'assistant',
        name: 'KitchenBot',
        content: `Wonton Soup Stock

Ingredients:
10 cups water
6-inch piece fresh ginger
1 bunch scallions

Instructions:
1. Simmer everything for 30 minutes.
2. Strain and refrigerate.`,
      },
    ],
    activeSpeakerName: 'Rob',
  });

  assert.equal(grounded.currentObject?.objectType, 'chat_recipe');
  assert.equal(grounded.currentObject?.title, 'Wonton Soup Stock');
});

test('groundTurnFinal keeps memory advisory questions in reply mode', async () => {
  const grounded = await groundTurnFinal({
    anthropic: makeAnthropic({
      turnMode: 'reply_only',
      surface: 'memory',
      intent: 'answer_question',
      confidence: 'high',
    }),
    prompt: "What is the cleanest way to remember that Elle likes olives in sandwiches but not as the main ingredient?",
    activeSpeakerName: 'Rob',
    memoryContext: {
      entityContext: {
        activeSpeakerName: 'Rob',
        activeSpeakerLabel: 'Rob',
        mentionedPersonLabels: ['Elle'],
        householdRelevant: true,
      },
    },
  });

  assert.equal(grounded.surface, 'memory');
  assert.equal(grounded.intent, 'answer_question');
  assert.equal(grounded.turnMode, 'reply_only');
});

test('groundTurnFinal canonicalizes grocery commit intent aliases onto add_grocery_items', async () => {
  const grounded = await groundTurnFinal({
    anthropic: makeAnthropic({
      turnMode: 'execute_action',
      surface: 'grocery',
      intent: 'add_recipe_ingredients_to_grocery_list',
      confidence: 'high',
    }),
    prompt: 'Add all of that to the grocery list.',
    recentMessages: [
      { role: 'user', name: 'Rob', content: 'Give me 3 weeknight dinner ideas.' },
      { role: 'assistant', name: 'KitchenBot', content: 'Try lemon pasta, cod bowls, and chicken tortilla soup.' },
    ],
    activeSpeakerName: 'Rob',
  });

  assert.equal(grounded.surface, 'grocery');
  assert.equal(grounded.intent, 'add_grocery_items');

  const proposalGrounded = await groundTurnFinal({
    anthropic: makeAnthropic({
      turnMode: 'execute_action',
      surface: 'grocery',
      intent: 'add_proposed_list_to_grocery',
      confidence: 'high',
    }),
    prompt: 'Okay add it to the grocery list.',
    recentMessages: [
      { role: 'user', name: 'Rob', content: 'Give me a simple grocery list for mushroom pasta and a chickpea salad, but do not add it yet.' },
      { role: 'assistant', name: 'KitchenBot', content: "Here's a simple grocery list for mushroom pasta and chickpea salad." },
    ],
    activeSpeakerName: 'Rob',
  });

  assert.equal(proposalGrounded.surface, 'grocery');
  assert.equal(proposalGrounded.intent, 'add_grocery_items');
});

test('groundTurnFinal canonicalizes cookbook save intent aliases onto save_recipe', async () => {
  const grounded = await groundTurnFinal({
    anthropic: makeAnthropic({
      turnMode: 'execute_action',
      surface: 'cookbook',
      intent: 'save_recipe_to_cookbook',
      confidence: 'high',
    }),
    prompt: 'Okay this looks really good. Add it to our cookbook.',
    recentMessages: [
      { role: 'user', name: 'Rob', content: 'Give me the recipe for weeknight cheat wonton soup stock.' },
      {
        role: 'assistant',
        name: 'KitchenBot',
        content: `# Weeknight Cheat Wonton Soup Stock

## Ingredients
- 6 cups chicken stock
- 2 cups water

## Instructions
1. Simmer.
2. Strain.`,
      },
    ],
    activeSpeakerName: 'Rob',
  });

  assert.equal(grounded.surface, 'cookbook');
  assert.equal(grounded.intent, 'save_recipe');
});

test('groundTurnFinal canonicalizes meal-plan draft intent aliases onto revise_meal_plan', async () => {
  const grounded = await groundTurnFinal({
    anthropic: makeAnthropic({
      turnMode: 'execute_action',
      surface: 'meal_plan',
      intent: 'create_meal_plan_with_specific_dishes',
      confidence: 'high',
    }),
    prompt: 'Plan three easy meals for Elle this week.',
    activeSpeakerName: 'Rob',
  });

  assert.equal(grounded.surface, 'meal_plan');
  assert.equal(grounded.intent, 'revise_meal_plan');
});

test('groundTurnFinal keeps fresh meal-planning drafts in reply mode when there is no active meal thread', async () => {
  const grounded = await groundTurnFinal({
    anthropic: makeAnthropic({
      turnMode: 'execute_action',
      surface: 'meal_plan',
      intent: 'create_meal_plan_with_specific_dishes',
      confidence: 'high',
    }),
    prompt: 'Plan three easy meals for Elle this week. One should be cheat wonton soup, one an easy pasta, and one dealers choice.',
    activeSpeakerName: 'Rob',
  });

  assert.equal(grounded.surface, 'meal_plan');
  assert.equal(grounded.intent, 'revise_meal_plan');
  assert.equal(grounded.turnMode, 'reply_only');
});

test('groundTurnFinal keeps slot-structured first-turn meal planning in reply mode without explicit planning verbs', async () => {
  const grounded = await groundTurnFinal({
    anthropic: makeAnthropic({
      turnMode: 'execute_action',
      surface: 'meal_plan',
      intent: 'create_meal_plan_with_specific_dishes',
      confidence: 'high',
    }),
    prompt: "I'm out of town this week and tomorrow I am going grocery shopping so that Elle can make 3 easy meals. Ignore our ambitious cooking style and go easy. One should be cheat wonton soup with make-ahead stock, one should be an easy pasta, one can be dealers choice.",
    activeSpeakerName: 'Rob',
  });

  assert.equal(grounded.surface, 'meal_plan');
  assert.equal(grounded.intent, 'revise_meal_plan');
  assert.equal(grounded.turnMode, 'reply_only');
});

test('groundTurnFinal keeps shopping-context first-turn meal planning in reply mode', async () => {
  const grounded = await groundTurnFinal({
    anthropic: makeAnthropic({
      turnMode: 'execute_action',
      surface: 'meal_plan',
      intent: 'create_meal_plan_with_shopping_list',
      confidence: 'high',
    }),
    prompt: "I'm grocery shopping tomorrow and need 3 easy meals for Elle next week.",
    activeSpeakerName: 'Rob',
  });

  assert.equal(grounded.surface, 'meal_plan');
  assert.equal(grounded.intent, 'revise_meal_plan');
  assert.equal(grounded.turnMode, 'reply_only');
});

test('groundTurnFinal still clarifies true meal-plan revisions when no meal thread exists', async () => {
  const grounded = await groundTurnFinal({
    anthropic: makeAnthropic({
      turnMode: 'execute_action',
      surface: 'meal_plan',
      intent: 'revise_meal_plan',
      confidence: 'high',
    }),
    prompt: 'Swap the fish one for cod.',
    activeSpeakerName: 'Rob',
  });

  assert.equal(grounded.surface, 'meal_plan');
  assert.equal(grounded.intent, 'revise_meal_plan');
  assert.equal(grounded.turnMode, 'clarify');
  assert.match(grounded.clarifyQuestion || '', /what meals or dinner ideas do you want me to revise/i);
});

test('groundTurnFinal routes chat rename requests onto the chat surface', async () => {
  const grounded = await groundTurnFinal({
    anthropic: makeAnthropic({
      turnMode: 'execute_action',
      surface: 'chat',
      intent: 'rename_chat',
      confidence: 'high',
    }),
    prompt: 'Rename this chat to Cod And Asparagus Plan.',
    chatId: 42,
    activeSpeakerName: 'Rob',
  });

  assert.equal(grounded.surface, 'chat');
  assert.equal(grounded.intent, 'rename_chat');
  assert.equal(grounded.turnMode, 'execute_action');
  assert.equal(grounded.activeObjects.some((object) => object.type === 'chat_thread' && Number(object.id) === 42), true);
});

test('groundTurnProvisional steers retrieval and buildGroundedContextProfile follows it', async () => {
  const defaultsProvisional = await groundTurnProvisional({
    anthropic: makeAnthropic({
      surface: 'conversation',
      intent: 'answer_question',
      candidateObjectTypes: ['memory_entity'],
      likelyAmbiguous: false,
      confidence: 'high',
      rationale: 'defaults_question',
    }),
    prompt: 'What do you know about my cooking style?',
    activeSpeakerName: 'Rob',
  });
  const provenanceProvisional = await groundTurnProvisional({
    anthropic: makeAnthropic({
      surface: 'conversation',
      intent: 'answer_question',
      candidateObjectTypes: ['linked_recipe'],
      likelyAmbiguous: false,
      confidence: 'high',
    }),
    prompt: 'Did you actually read the URL?',
    activeSpeakerName: 'Rob',
  });

  const defaultsProfile = buildGroundedContextProfile({ provisionalGrounding: defaultsProvisional });
  const provenanceProfile = buildGroundedContextProfile({ provisionalGrounding: provenanceProvisional });

  assert.equal(defaultsProfile.includeDefaults, true);
  assert.equal(provenanceProfile.includeCookbook, true);
});

test('groundTurnFinal clarifies ambiguous explicit cookbook updates', async () => {
  const grounded = await groundTurnFinal({
    anthropic: makeAnthropic({
      turnMode: 'execute_action',
      surface: 'cookbook',
      intent: 'update_saved_recipe',
      confidence: 'high',
    }),
    prompt: 'Update the chili recipe in our cookbook.',
    activeSpeakerName: 'Rob',
    memoryContext: {
      cookbookEntries: [
        { id: 1, title: 'Weeknight White Chicken Chili' },
        { id: 2, title: 'Poblano White Chicken Chili' },
      ],
    },
  });

  assert.equal(grounded.surface, 'cookbook');
  assert.equal(grounded.turnMode, 'clarify');
  assert.equal(grounded.clarifyChoices.length, 2);
});
