import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('parseCookbookRecipeText extracts structured ingredients and directions from pasted recipe text', async () => {
  const module = await import(new URL(`../cookbook-store.mjs?recipe-parse=${Date.now()}`, import.meta.url).href);
  const parsed = module.parseCookbookRecipeText(`All-American Beef Stew

Ingredients
4 cups stock
3 pounds beef chuck roast
10 ounces mushrooms
4 medium carrots

  Directions
Brown the beef.
Cook the mushrooms and carrots.
Add stock and simmer until tender.
Serve hot.`, { preferredTitle: 'favorite beef stew' });

  assert.equal(parsed.title, 'favorite beef stew');
  assert.equal(parsed.sourceTitle, 'All-American Beef Stew');
  assert.equal(parsed.recipeType, 'saved_recipe');
  assert.deepEqual(parsed.ingredients.slice(0, 3), ['4 cups stock', '3 pounds beef chuck roast', '10 ounces mushrooms']);
  assert.deepEqual(parsed.instructions.slice(0, 2), ['Brown the beef.', 'Cook the mushrooms and carrots.']);
  assert.equal(parsed.category, 'soups');
});

test('selectRelevantCookbookEntries does not hijack fresh conversational recipe asks into cookbook recall', async () => {
  const module = await import(new URL(`../cookbook-store.mjs?cookbook-selection-fresh=${Date.now()}`, import.meta.url).href);
  const entries = [
    {
      title: 'Elotes-Style Pasta Salad',
      summary: 'A creamy pasta salad with charred corn and cotija.',
      ingredients: ['1 lb pasta', 'corn', 'cotija'],
      updatedAt: '2026-04-18 12:00:00',
    },
  ];

  const selected = module.selectRelevantCookbookEntries(entries, 'Give me a good elotes-style pasta salad recipe.');
  assert.deepEqual(selected, []);
});

test('selectRelevantCookbookEntries still finds saved recipes for direct recall asks', async () => {
  const module = await import(new URL(`../cookbook-store.mjs?cookbook-selection-recall=${Date.now()}`, import.meta.url).href);
  const entries = [
    {
      title: 'The Loaded Italian Sub Reimagined',
      summary: 'A sandwich dinner favorite.',
      ingredients: ['sub rolls', 'salami'],
      updatedAt: '2026-04-18 12:00:00',
    },
  ];

  const selected = module.selectRelevantCookbookEntries(entries, 'Show me the full recipe for loaded italian sub.');
  assert.equal(selected.length, 1);
  assert.equal(selected[0].title, 'The Loaded Italian Sub Reimagined');
});

test('parseCookbookRecipeText handles KB-style recipe headers with colons and classifies pasta correctly', async () => {
  const module = await import(new URL(`../cookbook-store.mjs?recipe-parse-colons=${Date.now()}`, import.meta.url).href);
  const parsed = module.parseCookbookRecipeText(`Mexican Street Corn Pasta

Serves 4

Ingredients:
1 lb pasta
8 oz Mexican chorizo
3 cups corn kernels
2 limes

Instructions:
1. Cook the pasta until al dente.
2. Brown the chorizo in a skillet.
3. Toss with corn, lime, and crema.
4. Finish with cotija and cilantro.

Notes:
Use extra lime juice if it needs more brightness.`, {});

  assert.equal(parsed.title, 'Mexican Street Corn Pasta');
  assert.equal(parsed.category, 'pasta');
  assert.deepEqual(parsed.ingredients.slice(0, 3), ['1 lb pasta', '8 oz Mexican chorizo', '3 cups corn kernels']);
  assert.deepEqual(parsed.instructions.slice(0, 2), ['Cook the pasta until al dente.', 'Brown the chorizo in a skillet.']);
  assert.match(parsed.summary, /^A .*pasta .* Especially good for /i);
  assert.match(parsed.summary, /chorizo|corn|lime|cotija/i);
  assert.deepEqual(parsed.notes, ['Use extra lime juice if it needs more brightness.']);
  assert.deepEqual(parsed.tags, ['mexican', 'street', 'corn', 'pasta']);
});

test('parseCookbookRecipeText handles decorated headers with serving notes in the section title', async () => {
  const module = await import(new URL(`../cookbook-store.mjs?recipe-parse-decorated=${Date.now()}`, import.meta.url).href);
  const parsed = module.parseCookbookRecipeText(`Cheat Wonton Soup with Frozen Pot Stickers & Bok Choy

**Ingredients (serves 2):**
- 6 cups chicken or vegetable broth
- 2 cloves garlic, minced
- 1-inch piece fresh ginger, sliced thin
- 12-16 frozen pot stickers
- 2-3 heads baby bok choy

**Instructions:**
1. Bring the broth to a boil.
2. Add garlic and ginger and simmer for 5 minutes.
3. Add the pot stickers and cook through.
4. Add the bok choy during the last few minutes.
5. Serve hot.`, {});

  assert.equal(parsed.title, 'Cheat Wonton Soup with Frozen Pot Stickers & Bok Choy');
  assert.ok(parsed.ingredients.includes('6 cups chicken or vegetable broth'));
  assert.ok(parsed.ingredients.includes('12-16 frozen pot stickers'));
  assert.ok(parsed.instructions.some((line) => /pot stickers/i.test(line)));
  assert.equal(parsed.category, 'soups');
});

test('parseCookbookRecipeText understands KB markdown recipe replies with intro text and strips app offers', async () => {
  const module = await import(new URL(`../cookbook-store.mjs?recipe-parse-markdown-intro=${Date.now()}`, import.meta.url).href);
  const parsed = module.parseCookbookRecipeText(`Here's an elotes-style pasta salad recipe that brings those Mexican street corn flavors to pasta:

## Elotes Pasta Salad

**Serves:** 6-8
**Prep time:** 25 minutes

**Ingredients:**

*Salad:*
- 1 lb pasta
- 4 cups corn kernels
- 1 cup cotija

*Creamy Elotes Dressing:*
- 3/4 cup mayonnaise
- juice of 2 limes
- 1 tsp chili powder

**Instructions:**

1. Cook the pasta.
2. Char the corn.
3. Make the dressing.
4. Combine and chill.

**Tips:**
- The charred corn really makes this.

Would you like me to save this to your Cookbook or add any ingredients to your Grocery List?`, {});

  assert.equal(parsed.title, 'Elotes Pasta Salad');
  assert.ok(parsed.ingredients.includes('Salad:'));
  assert.ok(parsed.ingredients.includes('Creamy Elotes Dressing:'));
  assert.ok(parsed.instructions[0].startsWith('Cook the pasta'));
  assert.equal(parsed.notes.some((note) => /cookbook|grocery list/i.test(note)), false);
});

test('parseCookbookRecipeText understands live KB recipe replies that use Steps and a conversational outro', async () => {
  const module = await import(new URL(`../cookbook-store.mjs?recipe-parse-live-steps=${Date.now()}`, import.meta.url).href);
  const parsed = module.parseCookbookRecipeText(`Here's a great elotes-style pasta salad that plays into your love of cheese!

**Elotes Pasta Salad**

*Ingredients:*
- 1 lb pasta (small shapes like fusilli or penne work best)
- 3 cups corn (fresh, frozen, or roasted)
- 1 cup crumbled cotija cheese
- 1/2 cup mayonnaise
- 1/4 cup sour cream or Mexican crema
- 2 limes, juiced
- 1/2 cup fresh cilantro, chopped
- 2 green onions, sliced
- Salt and pepper to taste

*Steps:*
1. Cook pasta according to package directions, drain, and let cool slightly.
2. In a large bowl, whisk together mayo, sour cream, and lime juice until smooth.
3. Add the cooled pasta and corn. Toss until coated.
4. Fold in most of the cotija cheese, reserving some for topping.
5. Season with salt and pepper. Chill until ready to serve.
6. Top with remaining cotija and green onions just before serving.

The cheese really shines here. You can make this ahead.
Would you like me to save this to your cookbook, or do you want to adjust anything before cooking?`, {});

  assert.equal(parsed.title, 'Elotes Pasta Salad');
  assert.ok(parsed.ingredients.some((line) => /cotija cheese/i.test(line)));
  assert.ok(parsed.instructions.some((line) => /whisk together mayo, sour cream, and lime juice/i.test(line)));
  assert.equal(parsed.notes.some((note) => /save this to your cookbook|adjust anything before cooking/i.test(note)), false);
});

test('looksLikeRecipeText recognizes KB markdown recipes that use Steps headers and bullet-prefixed ingredients', async () => {
  const module = await import(new URL(`../cookbook-store.mjs?looks-like-recipe-steps=${Date.now()}`, import.meta.url).href);
  assert.equal(
    module.looksLikeRecipeText(`Here's a great elotes-style pasta salad:\n\n**Elotes Pasta Salad**\n\n**Ingredients:**\n- 1 lb pasta\n- 3 cups corn\n- 1 cup cotija\n- 4 tbsp mayo\n- 2 tbsp lime juice\n\n**Steps:**\n1. Cook pasta.\n2. Whisk the dressing.\n3. Toss and chill.`),
    true
  );
});

test('cookbook provenance labels distinguish source recipes, KB-generated recipes, saved recipes, and meal ideas', async () => {
  const module = await import(new URL(`../cookbook-store.mjs?cookbook-provenance=${Date.now()}`, import.meta.url).href);

  assert.equal(
    module.getCookbookDisplayProvenance({
      title: 'Mexican Street Corn Pasta',
      summary: 'A bright, smoky pasta with charred corn, chorizo, and lime.',
      recipeType: 'saved_recipe',
      ingredients: ['1 lb pasta', '8 oz chorizo', '3 cups corn kernels'],
      instructions: ['Cook the pasta.', 'Brown the chorizo.', 'Toss everything together.'],
      sourceKind: 'kb_action',
    }),
    'KitchenBot generated'
  );

  assert.equal(
    module.getCookbookDisplayProvenance({
      title: 'Serious Eats Beef Stew',
      summary: 'A rich beef stew with carrots, stock, and mushrooms.',
      recipeType: 'saved_recipe',
      ingredients: ['3 pounds beef chuck roast', '4 cups stock', '10 ounces mushrooms'],
      instructions: ['Brown the beef.', 'Cook the mushrooms.', 'Simmer until tender.'],
      sourceTitle: 'All-American Beef Stew',
      sourceUrl: 'https://www.seriouseats.com/all-american-beef-stew-recipe',
      sourceKind: 'manual',
    }),
    'Sourced recipe'
  );

  assert.equal(
    module.getCookbookDisplayProvenance({
      title: 'Family Roast Chicken',
      summary: 'A roast chicken with lemon and herbs.',
      recipeType: 'saved_recipe',
      ingredients: ['whole chicken', 'lemon', 'butter'],
      instructions: ['Season the chicken.', 'Roast until done.', 'Rest and carve.'],
      sourceKind: 'manual',
    }),
    'Saved recipe'
  );

  assert.equal(
    module.getCookbookDisplayProvenance({
      title: 'Fancy sandwich night',
      summary: 'An idea for a sandwich-forward dinner.',
      recipeType: 'meal_idea',
      ingredients: [],
      instructions: [],
      sourceKind: 'kb_action',
    }),
    'Meal idea'
  );
});

test('cookbook source shaping suppresses assistant framing residue but preserves real source titles', async () => {
  const module = await import(new URL(`../cookbook-store.mjs?cookbook-source-sanitize=${Date.now()}`, import.meta.url).href);

  const assistantFraming = module.buildCookbookRecordForStorage({
    title: 'Miso Butter Pasta',
    summary: 'A rich, savory pasta with roasted mushrooms and soft eggs.',
    recipeType: 'saved_recipe',
    ingredients: ['1 lb pasta', 'miso paste', 'butter'],
    instructions: ['Cook the pasta.', 'Make the sauce.', 'Finish with eggs.'],
    sourceTitle: "Here's the updated Poblano White Chicken Chili with cream cheese added:",
    sourceKind: 'kb_action',
  });
  const realSource = module.buildCookbookRecordForStorage({
    title: 'our favorite beef stew',
    summary: 'A rich beef stew with carrots and stock.',
    recipeType: 'saved_recipe',
    ingredients: ['3 pounds beef chuck roast', '4 cups stock', '4 medium carrots'],
    instructions: ['Brown the beef.', 'Build the braise.', 'Simmer until tender.'],
    sourceTitle: 'All-American Beef Stew',
    sourceUrl: 'https://www.seriouseats.com/all-american-beef-stew-recipe',
    sourceKind: 'manual',
  });

  assert.equal(assistantFraming.sourceTitle, '');
  assert.equal(realSource.sourceTitle, 'All-American Beef Stew');
});

test('cookbook display helpers clean assistant framing out of titles and suppress bad historical source junk', async () => {
  const module = await import(new URL(`../cookbook-store.mjs?cookbook-display-cleanup=${Date.now()}`, import.meta.url).href);

  assert.equal(
    module.getCookbookDisplayTitle({
      title: "Here's the recipe for **The Loaded Italian Sub Reimagined**:",
    }),
    'The Loaded Italian Sub Reimagined'
  );

  assert.equal(
    module.getCookbookDisplayTitle({
      title: '## Lobster Roll Meets Italian Beef',
    }),
    'Lobster Roll Meets Italian Beef'
  );

  assert.equal(
    module.getCookbookDisplaySource({
      title: 'Miso butter pasta',
      sourceTitle: "Here's the full recipe for **Mi o Butter Pa ta with Roa ted Mu hroom & Soft Scrambled Egg **:",
      sourceUrl: '',
    }),
    null
  );

  assert.deepEqual(
    module.getCookbookDisplaySource({
      title: 'Serious Eats beef stew',
      sourceTitle: 'All-American Beef Stew',
      sourceUrl: 'https://www.seriouseats.com/all-american-beef-stew-recipe',
    }),
    {
      label: 'All-American Beef Stew',
      url: 'https://www.seriouseats.com/all-american-beef-stew-recipe',
    }
  );
});

test('buildCookbookRecordForStorage treats sandwich-style titles as lunch dishes before sauce fallbacks', async () => {
  const module = await import(new URL(`../cookbook-store.mjs?lunch-category=${Date.now()}`, import.meta.url).href);
  const inferred = module.buildCookbookRecordForStorage({
    title: 'The Loaded Italian Sub Reimagined',
    summary: 'A rich, layered deli sandwich with anchovy-garlic aioli, giardiniera, and crispy pancetta.',
    ingredients: ['Italian sub roll', 'capicola', 'mortadella', 'aged provolone', 'anchovy-garlic aioli'],
    instructions: ['Make the aioli.', 'Toast the bread.', 'Layer the fillings and serve.'],
    tags: ['sandwich', 'italian'],
  });

  assert.equal(inferred.category, 'lunch_dishes');
});

test('buildCookbookRecordForStorage infers a category and honors explicit uncategorized edits', async () => {
  const module = await import(new URL(`../cookbook-store.mjs?recipe-category=${Date.now()}`, import.meta.url).href);
  const inferred = module.buildCookbookRecordForStorage({
    title: 'Roast Chicken',
    summary: 'A simple roast chicken with lemon and herbs.',
    ingredients: ['whole chicken', 'lemon', 'butter'],
    instructions: ['Season the chicken.', 'Roast until done.'],
    tags: ['weeknight'],
  });
  const explicitNone = module.buildCookbookRecordForStorage({
    title: 'Roast Chicken',
    summary: 'A simple roast chicken with lemon and herbs.',
    category: '',
    ingredients: ['whole chicken', 'lemon', 'butter'],
    instructions: ['Season the chicken.', 'Roast until done.'],
    tags: ['weeknight'],
  });

  assert.equal(inferred.category, 'poultry');
  assert.equal(explicitNone.category, '');
});

test('buildCookbookRecordForStorage infers pasta as a first-class category', async () => {
  const module = await import(new URL(`../cookbook-store.mjs?pasta-category=${Date.now()}`, import.meta.url).href);
  const inferred = module.buildCookbookRecordForStorage({
    title: 'Mexican Street Corn Pasta',
    summary: 'A creamy pasta with charred corn, chorizo, lime, and cotija.',
    ingredients: ['pasta', 'chorizo', 'corn', 'cotija'],
    instructions: ['Boil the pasta.', 'Brown the chorizo.', 'Toss everything together.'],
    tags: ['pasta', 'corn', 'weeknight'],
  });

  assert.equal(inferred.category, 'pasta');
});

test('extractPreferredCookbookLabel ignores cookbook boilerplate without alias and keeps clean aliases', async () => {
  const module = await import(new URL(`../cookbook-store.mjs?label-parse=${Date.now()}`, import.meta.url).href);
  assert.equal(
    module.extractPreferredCookbookLabel(
      'save this to our cookbook: https://www.thekitchn.com/cold-weather-recipe-white-chicken-chili-recipes-from-the-kitchn-181533',
      'https://www.thekitchn.com/cold-weather-recipe-white-chicken-chili-recipes-from-the-kitchn-181533'
    ),
    ''
  );
  assert.equal(
    module.extractPreferredCookbookLabel(
      'save this to our cookbook as favorite beef stew: https://www.seriouseats.com/all-american-beef-stew-recipe',
      'https://www.seriouseats.com/all-american-beef-stew-recipe'
    ),
    'favorite beef stew'
  );
});

test('findCookbookMatches treats shared title tokens as an ambiguity instead of a miss', async () => {
  const module = await import(new URL(`../cookbook-store.mjs?cookbook-matches-token-overlap=${Date.now()}`, import.meta.url).href);
  const matches = module.findCookbookMatches(
    [
      { id: 1, title: 'Codex Test Chili One 1776515712' },
      { id: 2, title: 'Codex Test Chili Two 1776515712' },
    ],
    'Codex Test Chili 1776515712'
  );

  assert.deepEqual(
    matches.map((entry) => entry.id),
    [1, 2]
  );
});

test('cookbook entries persist and become selectable context for cookbook prompts', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-cookbook-context-'));
  const dbPath = path.join(tempDir, 'cookbook.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const store = await import(new URL('./kb-memory-store.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });

    await db.saveCookbookEntry(created.householdId, {
      title: 'Lemony Orzo Chicken Skillet',
      normalizedTitle: 'lemony orzo chicken skillet',
      summary: 'A bright one-pan chicken dinner with orzo, lemon, and spinach.',
      category: 'poultry',
      recipeType: 'saved_recipe',
      ingredients: ['chicken thighs', 'orzo', 'spinach', 'lemon'],
      instructions: ['Brown the chicken', 'Cook the orzo', 'Finish with lemon and spinach'],
      tags: ['chicken', 'weeknight'],
      sourceTitle: '',
      sourceUrl: '',
      notes: '',
    });

    await db.saveCookbookEntry(created.householdId, {
      title: 'Mushroom Pasta Bake',
      normalizedTitle: 'mushroom pasta bake',
      summary: 'A cozy baked pasta with mushrooms and fontina.',
      recipeType: 'meal_idea',
      ingredients: ['mushrooms', 'pasta', 'fontina'],
      instructions: ['Saute the mushrooms', 'Bake with pasta and cheese'],
      tags: ['vegetarian', 'bake'],
      sourceTitle: '',
      sourceUrl: '',
      notes: '',
    });

    const entries = await db.listCookbookEntries(created.householdId);
    const context = await store.buildKbContextPacket(created.householdId, 'use one of our saved chicken recipes', {
      includeCookbook: true,
      includeDefaults: false,
      includePantry: false,
      includeGrocery: false,
      activeSpeakerName: 'Rob',
    });
    process.stdout.write(JSON.stringify({ entries, context }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0].title, 'Mushroom Pasta Bake');
  assert.equal(parsed.entries[1].category, 'poultry');
  assert.equal(Array.isArray(parsed.context.selectedCookbookEntries), true);
  assert.equal(parsed.context.selectedCookbookEntries.length, 1);
  assert.equal(parsed.context.selectedCookbookEntries[0].title, 'Lemony Orzo Chicken Skillet');
  assert.match(parsed.context.cookbookText, /Lemony Orzo Chicken Skillet/);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('executeCookbookSave shapes and stores a reusable cookbook entry from chat context', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-cookbook-save-'));
  const dbPath = path.join(tempDir, 'cookbook-save.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const executor = await import(new URL('./cookbook-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Cookbook save');
    await db.addMessage(created.householdId, chatId, 'user', 'Rob', 'Save that lemony chicken orzo situation.');
    await db.addMessage(
      created.householdId,
      chatId,
      'assistant',
      'KitchenBot',
      'A lemony chicken and orzo skillet would be bright, cozy, and very saveable.'
    );
    const anthropic = {
      messages: {
        create: async () => ({
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 25, output_tokens: 90 },
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                title: 'Lemony Chicken Orzo Skillet',
                summary: 'A bright chicken-and-orzo skillet with lemon and greens.',
                recipeType: 'saved_recipe',
                ingredients: ['chicken thighs', 'orzo', 'lemon', 'spinach'],
                instructions: ['Brown the chicken', 'Simmer the orzo', 'Finish with lemon and spinach'],
                tags: ['chicken', 'skillet', 'weeknight'],
              }),
            },
          ],
        }),
      },
    };
    const outcome = await executor.executeCookbookSave(
      { capability: 'cookbook.save', input: { request: 'save that recipe' } },
      {
        req: { householdId: created.householdId },
        chatId,
        prompt: 'save that recipe',
        anthropic,
        memoryContext: { capabilities: { webSearchEnabled: false } },
        workingContext: { topicSummary: 'Lemony chicken orzo skillet', mealIdeas: ['Lemony chicken orzo skillet'] },
      }
    );
    const entries = await db.listCookbookEntries(created.householdId);
    process.stdout.write(JSON.stringify({ outcome, count: entries.length, entry: entries[0] }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.outcome.capability, 'cookbook.save');
  assert.equal(parsed.outcome.status, 'saved');
  assert.equal(parsed.outcome.title, 'Lemony Chicken Orzo Skillet');
  assert.equal(parsed.count, 1);
  assert.equal(parsed.entry.title, 'Lemony Chicken Orzo Skillet');
  assert.equal(parsed.entry.category, 'pasta');
  assert.deepEqual(parsed.entry.ingredients.slice(0, 3), ['chicken thighs', 'orzo', 'lemon']);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('executeCookbookSave saves the most recently expanded recipe instead of stale meal-plan context', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-cookbook-expanded-recipe-'));
  const dbPath = path.join(tempDir, 'cookbook-expanded-recipe.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const executor = await import(new URL('./cookbook-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Cookbook expanded recipe save');
    await db.addMessage(created.householdId, chatId, 'user', 'Rob', 'Help me plan 3 dinners for the week.');
    await db.addMessage(
      created.householdId,
      chatId,
      'assistant',
      'KitchenBot',
      'You could do Bacon & Cheddar Burger Night, Muffaletta Night, and White Chicken Chili.'
    );
    await db.addMessage(created.householdId, chatId, 'user', 'Rob', 'Expand on the muffaletta.');
    await db.addMessage(
      created.householdId,
      chatId,
      'assistant',
      'KitchenBot',
      \`Muffaletta

Ingredients
1 round loaf sesame bread
1 cup chopped green olives
1 cup chopped roasted red peppers
1/2 cup sliced pepperoncini
8 ounces salami
8 ounces mortadella
8 ounces provolone

Instructions
Mix the olives, peppers, and pepperoncini into a chunky olive salad.
Slice the bread and spread the olive salad generously on both halves.
Layer the salami, mortadella, and provolone, then close the sandwich tightly.
Wrap and press the muffaletta for at least 30 minutes before slicing and serving.

Notes
The olive salad is the soul of the sandwich, so do not skimp on it.\`
    );
    const outcome = await executor.executeCookbookSave(
      { capability: 'cookbook.save', input: { request: 'add this recipe to our cookbook' } },
      {
        req: { householdId: created.householdId },
        chatId,
        prompt: 'add this recipe to our cookbook',
        anthropic: null,
        memoryContext: { capabilities: { webSearchEnabled: false } },
        workingContext: {
          topicSummary: 'Dinner plan for the week',
          mealIdeas: ['Bacon & Cheddar Burger Night', 'Muffaletta Night', 'White Chicken Chili'],
          subjectItems: ['Muffaletta'],
        },
      }
    );
    const entries = await db.listCookbookEntries(created.householdId);
    process.stdout.write(JSON.stringify({ outcome, count: entries.length, entry: entries[0] }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.outcome.status, 'saved');
  assert.equal(parsed.outcome.title, 'Muffaletta');
  assert.equal(parsed.count, 1);
  assert.equal(parsed.entry.title, 'Muffaletta');
  assert.deepEqual(parsed.entry.ingredients.slice(0, 3), [
    '1 round loaf sesame bread',
    '1 cup chopped green olives',
    '1 cup chopped roasted red peppers',
  ]);
  assert.doesNotMatch(parsed.entry.title, /bacon/i);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('executeCookbookSave can save directly from a grounded chat_recipe object', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-cookbook-save-current-object-'));
  const dbPath = path.join(tempDir, 'cookbook-save-current-object.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const executor = await import(new URL('./cookbook-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Cookbook save current object');
    await db.addMessage(created.householdId, chatId, 'assistant', 'KitchenBot', 'Here is a meal plan with three weeknight dinners.');

    const outcome = await executor.executeCookbookSave(
      {
        capability: 'cookbook.save',
        input: {
          request: 'save it to our cookbook',
          targetRecipe: {
            type: 'chat_recipe',
            title: 'Easy Thai Coconut Soup',
            recipeRecord: {
              title: 'Easy Thai Coconut Soup',
              summary: 'A very simple coconut soup for weeknights.',
              recipeType: 'saved_recipe',
              ingredients: ['1 can coconut milk', '2 cups chicken broth', '8 oz chicken breast'],
              instructions: ['Simmer the broth and coconut milk.', 'Add the chicken and cook until done.'],
              tags: ['soup', 'weeknight'],
              sourceKind: 'kb_generated',
            },
          },
        },
      },
      {
        req: { householdId: created.householdId },
        chatId,
        prompt: 'save it to our cookbook',
        anthropic: null,
        memoryContext: { capabilities: { webSearchEnabled: false } },
        workingContext: {
          topicSummary: 'Three weeknight dinners',
          mealIdeas: ['sheet-pan sausages', 'easy thai coconut soup', 'baked potatoes'],
        },
      }
    );

    const entries = await db.listCookbookEntries(created.householdId);
    process.stdout.write(JSON.stringify({ outcome, entries }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.outcome.status, 'saved');
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].title, 'Easy Thai Coconut Soup');
  assert.deepEqual(parsed.entries[0].ingredients, ['1 can coconut milk', '2 cups chicken broth', '8 oz chicken breast']);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('executeCookbookSave can save the latest assistant-generated recipe from recent conversation', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-cookbook-save-recent-assistant-'));
  const dbPath = path.join(tempDir, 'cookbook-save-recent-assistant.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const executor = await import(new URL('./cookbook-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Cookbook save recent assistant');
    await db.addMessage(created.householdId, chatId, 'user', 'Rob', 'Can you give me the dumpling soup recipe again?');
    await db.addMessage(created.householdId, chatId, 'assistant', 'KitchenBot', \`Cheat Wonton Soup with Frozen Pot Stickers & Bok Choy

Ingredients (serves 2)
6 cups chicken or vegetable broth
2 cloves garlic, minced
1-inch piece fresh ginger, sliced thin
12-16 frozen pot stickers
2-3 heads baby bok choy

Instructions
1. Bring the broth to a boil.
2. Add garlic and ginger and simmer for 5 minutes.
3. Add the pot stickers and cook through.
4. Add the bok choy during the last few minutes.
5. Serve hot.\`);

    const outcome = await executor.executeCookbookSave(
      { capability: 'cookbook.save', input: { request: 'Add this to our cookbook please' } },
      {
        req: { householdId: created.householdId },
        chatId,
        prompt: 'Add this to our cookbook please',
        anthropic: null,
        memoryContext: { capabilities: { webSearchEnabled: false } },
        workingContext: null,
      }
    );

    const entries = await db.listCookbookEntries(created.householdId);
    process.stdout.write(JSON.stringify({ outcome, entries }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.outcome.status, 'saved');
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].title, 'Cheat Wonton Soup with Frozen Pot Stickers & Bok Choy');
  assert.ok(parsed.entries[0].ingredients.some((line) => /pot stickers/i.test(line)));

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('executeCookbookSave can save the latest user-pasted recipe from recent conversation', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-cookbook-save-recent-user-'));
  const dbPath = path.join(tempDir, 'cookbook-save-recent-user.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const executor = await import(new URL('./cookbook-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Cookbook save recent user');
    await db.addMessage(created.householdId, chatId, 'user', 'Elle', \`Lemony Artichoke Soup

Ingredients
1/4 cup butter
1 small white onion, diced
1 celery stalk, diced
3 garlic cloves, minced
6 cups chicken or vegetable stock
3 (14-ounce) jars artichoke hearts, drained
1/4 cup freshly-squeezed lemon juice

Instructions
1. Melt the butter and sauté the onion and celery.
2. Add the garlic and cook until fragrant.
3. Add the stock and artichokes and simmer.
4. Blend until smooth.
5. Stir in the lemon juice and serve.\`);

    const outcome = await executor.executeCookbookSave(
      { capability: 'cookbook.save', input: { request: 'Save that to our cookbook' } },
      {
        req: { householdId: created.householdId },
        chatId,
        prompt: 'Save that to our cookbook',
        anthropic: null,
        memoryContext: { capabilities: { webSearchEnabled: false } },
        workingContext: null,
      }
    );

    const entries = await db.listCookbookEntries(created.householdId);
    process.stdout.write(JSON.stringify({ outcome, entries }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.outcome.status, 'saved');
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].title, 'Lemony Artichoke Soup');
  assert.ok(parsed.entries[0].ingredients.some((line) => /artichoke hearts/i.test(line)));

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('executeCookbookSave does not let generic save prompt wording override the grounded recipe title', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-cookbook-save-generic-prompt-title-'));
  const dbPath = path.join(tempDir, 'cookbook-save-generic-prompt-title.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const executor = await import(new URL('./cookbook-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Cookbook save generic prompt title');

    const outcome = await executor.executeCookbookSave(
      {
        capability: 'cookbook.save',
        input: {
          request: 'Okay this looks really good. Add it to our cookbook.',
          targetRecipe: {
            type: 'chat_recipe',
            title: 'Make-Ahead Stock for Wonton Soup',
            recipeRecord: {
              title: 'Make-Ahead Stock for Wonton Soup',
              summary: 'A flavorful stock to reheat with frozen wontons and greens.',
              recipeType: 'saved_recipe',
              ingredients: ['6 cups low-sodium chicken broth', '3 cloves garlic', '2-inch piece fresh ginger'],
              instructions: ['Combine the ingredients.', 'Simmer for 20 minutes.', 'Strain and store.'],
              tags: ['soup', 'stock', 'weeknight'],
              sourceKind: 'kb_generated',
            },
          },
        },
      },
      {
        req: { householdId: created.householdId },
        chatId,
        prompt: 'Okay this looks really good. Add it to our cookbook.',
        anthropic: null,
        memoryContext: { capabilities: { webSearchEnabled: false } },
        workingContext: null,
      }
    );

    const entries = await db.listCookbookEntries(created.householdId);
    process.stdout.write(JSON.stringify({ outcome, entries }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.outcome.status, 'saved');
  assert.equal(parsed.outcome.title, 'Make-Ahead Stock for Wonton Soup');
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].title, 'Make-Ahead Stock for Wonton Soup');

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('executeCookbookSave saves the last expanded recipe cleanly after a cookbook clarification follow-up', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-cookbook-clarify-save-'));
  const dbPath = path.join(tempDir, 'cookbook-clarify-save.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const executor = await import(new URL('./cookbook-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Cookbook clarify save');
    await db.addMessage(created.householdId, chatId, 'user', 'Rob', 'help me plan 3 dinners for the week. One bacon-heavy, one a fun fancy sandwich type meal, and one way out of left field');
    await db.addMessage(
      created.householdId,
      chatId,
      'assistant',
      'KitchenBot',
      '1. Bacon cheeseburger night\\n2. Fancy sandwich\\n3. Mexican street corn pasta'
    );
    await db.addMessage(created.householdId, chatId, 'user', 'Rob', 'give me the full recipe for mexican street corn pasta');
    await db.addMessage(
      created.householdId,
      chatId,
      'assistant',
      'KitchenBot',
      \`Mexican Street Corn Pasta

Serves 4

Ingredients:
1 lb pasta (rigatoni, penne, or shells work great)
8 oz Mexican chorizo, casings removed
2 poblano peppers
3 cups corn kernels (fresh or frozen)
4 cloves garlic, minced
1/2 cup Mexican crema
3/4 cup crumbled cotija cheese
2 limes (zest and juice)
1/4 cup fresh cilantro, chopped

Instructions:
1. Roast the poblanos until blackened, then peel, seed, and dice.
2. Boil the pasta in salted water until al dente.
3. Brown the chorizo in a skillet and set aside.
4. Char the corn, then add garlic and smoked paprika.
5. Toss in the poblanos, chorizo, pasta, crema, cotija, and lime.
6. Finish with cilantro and adjust seasoning.
7. Serve with extra cotija and Tajin.

Notes:
Use extra lime juice if it needs more brightness.\`
    );
    await db.addMessage(created.householdId, chatId, 'user', 'Rob', 'can you add this recipe to our cookbook?');
    await db.addMessage(
      created.householdId,
      chatId,
      'assistant',
      'KitchenBot',
      'Which recipe would you like me to save to your cookbook? The Mexican Street Corn Pasta we just discussed, or one of the other two dinners from the plan?'
    );

    const outcome = await executor.executeCookbookSave(
      { capability: 'cookbook.save', input: { request: 'street corn pasta', preferredTitle: 'street corn pasta' } },
      {
        req: { householdId: created.householdId },
        chatId,
        prompt: 'street corn pasta',
        anthropic: null,
        memoryContext: { capabilities: { webSearchEnabled: false } },
        workingContext: {
          topicSummary: 'Mexican Street Corn Pasta',
          mealIdeas: ['Bacon Cheeseburger Night', 'Fancy Sandwich', 'Mexican Street Corn Pasta'],
          subjectItems: ['Mexican Street Corn Pasta'],
        },
      }
    );
    const entries = await db.listCookbookEntries(created.householdId);
    process.stdout.write(JSON.stringify({ outcome, count: entries.length, entry: entries[0] }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.outcome.status, 'saved');
  assert.equal(parsed.count, 1);
  assert.equal(parsed.entry.title, 'Mexican Street Corn Pasta');
  assert.equal(parsed.entry.category, 'pasta');
  assert.match(parsed.entry.summary, /^A .*pasta .* Especially good for /i);
  assert.match(parsed.entry.summary, /chorizo|corn|lime|cotija/i);
  assert.deepEqual(parsed.entry.ingredients.slice(0, 3), [
    '1 lb pasta (rigatoni, penne, or shells work great)',
    '8 oz Mexican chorizo, casings removed',
    '2 poblano peppers',
  ]);
  assert.deepEqual(parsed.entry.instructions.slice(0, 2), [
    'Roast the poblanos until blackened, then peel, seed, and dice.',
    'Boil the pasta in salted water until al dente.',
  ]);
  assert.deepEqual(parsed.entry.notes, ['Use extra lime juice if it needs more brightness.']);
  assert.deepEqual(parsed.entry.tags, ['mexican', 'street', 'corn', 'pasta']);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('executeCookbookSave fetches linked recipe details before saving when exact web fetch succeeds', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-cookbook-url-save-'));
  const dbPath = path.join(tempDir, 'cookbook-url-save.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const executor = await import(new URL('./cookbook-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Cookbook url save');
    const anthropic = null;
    const fetch = async () => ({
      ok: true,
      status: 200,
      url: 'https://www.seriouseats.com/all-american-beef-stew-recipe',
      headers: { get: (name) => name === 'content-type' ? 'text/html; charset=utf-8' : '' },
      text: async () => '<html><head><title>All-American Beef Stew Recipe</title><script type="application/ld+json">' + JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Recipe',
        name: 'All-American Beef Stew Recipe',
        description: 'A deeply savory beef stew with carrots, potatoes, and rich stock.',
        recipeIngredient: ['beef chuck', 'carrots', 'potatoes', 'stock'],
        recipeInstructions: [
          { '@type': 'HowToStep', text: 'Brown the beef' },
          { '@type': 'HowToStep', text: 'Build the braise' },
          { '@type': 'HowToStep', text: 'Simmer until tender' }
        ]
      }) + '</script></head><body><h1>All-American Beef Stew Recipe</h1></body></html>',
    });
    const outcome = await executor.executeCookbookSave(
      { capability: 'cookbook.save', input: { request: 'save this recipe as our favorite beef stew https://www.seriouseats.com/all-american-beef-stew-recipe' } },
      {
        req: { householdId: created.householdId, kbCapabilities: { webSearchEnabled: true } },
        chatId,
        prompt: 'save this recipe as our favorite beef stew https://www.seriouseats.com/all-american-beef-stew-recipe',
        anthropic,
        memoryContext: { capabilities: { webSearchEnabled: true } },
        workingContext: null,
        deps: { fetch },
      }
    );
    const entries = await db.listCookbookEntries(created.householdId);
    process.stdout.write(JSON.stringify({ outcome, count: entries.length, entry: entries[0] }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.outcome.status, 'saved');
  assert.equal(parsed.outcome.fetchPerformed, true);
  assert.equal(parsed.outcome.fetchedExactUrl, true);
  assert.equal(parsed.outcome.sourceKind, 'server_fetch');
  assert.equal(parsed.entry.title, 'our favorite beef stew');
  assert.equal(parsed.entry.category, 'soups');
  assert.equal(parsed.entry.sourceTitle, 'All-American Beef Stew Recipe');
  assert.equal(parsed.entry.sourceKind, 'server_fetch');
  assert.deepEqual(parsed.entry.ingredients.slice(0, 3), ['beef chuck', 'carrots', 'potatoes']);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('executeCookbookSave does not save linked recipes when only web search-style evidence exists', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-cookbook-search-not-fetch-'));
  const dbPath = path.join(tempDir, 'cookbook-search-not-fetch.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const executor = await import(new URL('./cookbook-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Cookbook search not fetch');
    const anthropic = null;
    const fetch = async () => ({
      ok: false,
      status: 403,
      url: 'https://www.seriouseats.com/all-american-beef-stew-recipe',
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => 'Forbidden',
    });
    const outcome = await executor.executeCookbookSave(
      { capability: 'cookbook.save', input: { request: 'save this recipe as our favorite beef stew https://www.seriouseats.com/all-american-beef-stew-recipe' } },
      {
        req: { householdId: created.householdId, kbCapabilities: { webSearchEnabled: true } },
        chatId,
        prompt: 'save this recipe as our favorite beef stew https://www.seriouseats.com/all-american-beef-stew-recipe',
        anthropic,
        memoryContext: { capabilities: { webSearchEnabled: true } },
        workingContext: null,
        deps: { fetch },
      }
    );
    const entries = await db.listCookbookEntries(created.householdId);
    process.stdout.write(JSON.stringify({ outcome, count: entries.length }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.outcome.status, 'unavailable');
  assert.equal(parsed.outcome.fetchPerformed, true);
  assert.equal(parsed.outcome.fetchedExactUrl, false);
  assert.equal(parsed.outcome.sourceKind, 'server_fetch');
  assert.equal(parsed.outcome.proposedNextAction?.type, 'choice');
  assert.equal(parsed.outcome.proposedNextAction?.defaultChoiceId, 'retry_fetch');
  assert.equal(parsed.outcome.proposedNextAction?.choices?.[0]?.capability, 'cookbook.save');
  assert.equal(parsed.count, 0);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('executeCookbookSave classifies bot-blocked linked recipe fetches and pivots to manual paste', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-cookbook-blocked-fetch-'));
  const dbPath = path.join(tempDir, 'cookbook-blocked-fetch.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const executor = await import(new URL('./cookbook-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Cookbook blocked save');
    const headers = new Headers();
    headers.set('content-type', 'text/html; charset=utf-8');
    headers.set('server', 'cloudflare');
    headers.set('cf-ray', '12345');
    headers.set('set-cookie', '__cf_bm=blocked');
    const outcome = await executor.executeCookbookSave(
      { capability: 'cookbook.save', input: { request: 'save this recipe as our favorite beef stew https://www.seriouseats.com/all-american-beef-stew-recipe' } },
      {
        req: { householdId: created.householdId, kbCapabilities: { webSearchEnabled: true } },
        chatId,
        prompt: 'save this recipe as our favorite beef stew https://www.seriouseats.com/all-american-beef-stew-recipe',
        anthropic: null,
        memoryContext: { capabilities: { webSearchEnabled: true } },
        workingContext: null,
        deps: {
          fetch: async () => ({
            ok: false,
            status: 403,
            url: 'https://www.seriouseats.com/all-american-beef-stew-recipe',
            headers,
            text: async () => '<html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>',
          }),
        },
      }
    );
    const entries = await db.listCookbookEntries(created.householdId);
    process.stdout.write(JSON.stringify({ outcome, count: entries.length }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.outcome.status, 'blocked');
  assert.equal(parsed.outcome.fetchBlocked, true);
  assert.equal(parsed.outcome.blockerKind, 'cloudflare');
  assert.equal(parsed.outcome.failureKind, 'blocked');
  assert.equal(parsed.outcome.proposedNextAction?.type, 'clarify_action');
  assert.match(parsed.outcome.error, /blocked automated page access/i);
  assert.equal(parsed.count, 0);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('executeCookbookSave distinguishes fetched-page extraction failure from fetch failure', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-cookbook-extraction-failure-'));
  const dbPath = path.join(tempDir, 'cookbook-extraction-failure.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const executor = await import(new URL('./cookbook-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Cookbook extraction failure');
    const anthropic = {
      messages: {
        create: async () => {
          return {
            model: 'claude-sonnet-4-5',
            usage: { input_tokens: 20, output_tokens: 60 },
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: 'insufficient_detail',
                  title: 'White Chicken Chili',
                  summary: 'A page about white chicken chili.',
                  recipeType: 'web_recipe',
                  ingredients: ['chicken'],
                  instructions: ['Cook it'],
                  sourceTitle: 'White Chicken Chili',
                  sourceUrl: 'https://example.com/not-really-a-recipe',
                }),
              },
            ],
          };
        },
      },
    };
    const outcome = await executor.executeCookbookSave(
      { capability: 'cookbook.save', input: { request: 'save this to our cookbook: https://example.com/not-really-a-recipe' } },
      {
        req: { householdId: created.householdId, kbCapabilities: { webSearchEnabled: true } },
        chatId,
        prompt: 'save this to our cookbook: https://example.com/not-really-a-recipe',
        anthropic,
        memoryContext: { capabilities: { webSearchEnabled: true } },
        workingContext: null,
        deps: {
          fetch: async () => ({
            ok: true,
            status: 200,
            url: 'https://example.com/not-really-a-recipe',
            headers: { get: () => 'text/html; charset=utf-8' },
            text: async () => '<html><head><title>White Chicken Chili</title></head><body><p>This page talks about why white chicken chili is comforting, but does not provide a full ingredient list or full instructions.</p></body></html>',
          }),
        },
      }
    );
    const entries = await db.listCookbookEntries(created.householdId);
    process.stdout.write(JSON.stringify({ outcome, count: entries.length }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.outcome.status, 'extraction_failed');
  assert.equal(parsed.outcome.fetchPerformed, true);
  assert.equal(parsed.outcome.fetchSucceeded, true);
  assert.equal(parsed.outcome.extractionSucceeded, false);
  assert.match(parsed.outcome.error, /fetched the page/i);
  assert.equal(parsed.count, 0);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('executeCookbookSave refuses linked recipe saves when web search is disabled', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-cookbook-url-disabled-'));
  const dbPath = path.join(tempDir, 'cookbook-url-disabled.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const executor = await import(new URL('./cookbook-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Cookbook disabled save');
    const outcome = await executor.executeCookbookSave(
      { capability: 'cookbook.save', input: { request: 'save this recipe https://example.com/beef-stew' } },
      {
        req: { householdId: created.householdId, kbCapabilities: { webSearchEnabled: false } },
        chatId,
        prompt: 'save this recipe https://example.com/beef-stew',
        anthropic: null,
        memoryContext: { capabilities: { webSearchEnabled: false } },
        workingContext: null,
      }
    );
    const entries = await db.listCookbookEntries(created.householdId);
    process.stdout.write(JSON.stringify({ outcome, count: entries.length }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.outcome.status, 'unavailable');
  assert.match(parsed.outcome.error, /disabled/i);
  assert.equal(parsed.count, 0);
  assert.equal(parsed.outcome.workingContext.linkedRecipeUrl, 'https://example.com/beef-stew');
  assert.equal(parsed.outcome.workingContext.linkedRecipeFetchStatus, 'unavailable');
  assert.equal(parsed.outcome.proposedNextAction?.type, 'clarify_action');

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('cookbook skill owns pasted recipe follow-up after linked save failure', async () => {
  const module = await import(new URL(`../kb-skills.mjs?cookbook-followup=${Date.now()}`, import.meta.url).href);
  const nextAction = {
    active: true,
    type: 'clarify_action',
    action: {
      capability: 'cookbook.save',
      input: {
        request: '',
        preferredTitle: 'our favorite beef stew',
        sourceUrl: 'https://www.seriouseats.com/all-american-beef-stew-recipe?print',
        recoveryMode: 'manual_paste',
      },
    },
    question: 'Paste the ingredients and directions for our favorite beef stew, and I will save it manually.',
  };
  const turn = module.interpretKbSkillFollowUp(
    `All-American Beef Stew

Ingredients
2 pounds beef chuck
4 carrots
2 potatoes

Directions
Brown the beef.
Simmer until tender.`,
    nextAction,
    {
      workingContext: {
        linkedRecipeTitle: 'our favorite beef stew',
        linkedRecipeUrl: 'https://www.seriouseats.com/all-american-beef-stew-recipe?print',
      },
    }
  );

  assert.equal(turn.kind, 'execute_action');
  assert.equal(turn.actions[0].capability, 'cookbook.save');
  assert.equal(turn.actions[0].input.preferredTitle, 'our favorite beef stew');
  assert.equal(turn.actions[0].input.sourceUrl, 'https://www.seriouseats.com/all-american-beef-stew-recipe?print');
  assert.equal(turn.actions[0].input.recoveryMode, 'manual_paste');
});

test('cookbook skill owns generic recipe-choice follow-up after cookbook save clarification', async () => {
  const module = await import(new URL(`../cookbook-executor.mjs?cookbook-choice=${Date.now()}`, import.meta.url).href);
  const nextAction = {
    active: true,
    type: 'clarify_action',
    action: {
      capability: 'cookbook.save',
      input: {
        request: 'can you add this recipe to our cookbook?',
      },
    },
    question:
      'Which recipe would you like me to save to your cookbook? The Mexican Street Corn Pasta we just discussed, or one of the other dinners from the plan?',
    unresolvedFields: ['recipe'],
    candidateOptions: [
      { id: '1', label: 'Mexican Street Corn Pasta' },
      { id: '2', label: 'Bacon Cheeseburger Night' },
      { id: '3', label: 'Fancy Sandwich' },
    ],
  };

  const turn = module.interpretCookbookSaveFollowUp('street corn pasta', nextAction, {
    workingContext: {
      topicSummary: 'Three dinner ideas for the week',
      mealIdeas: ['Bacon Cheeseburger Night', 'Mexican Street Corn Pasta', 'Fancy Sandwich'],
      subjectItems: ['Mexican Street Corn Pasta'],
    },
  });

  assert.equal(turn.kind, 'execute_action');
  assert.equal(turn.actions[0].capability, 'cookbook.save');
  assert.equal(turn.actions[0].input.request, 'can you add this recipe to our cookbook?');
  assert.equal(turn.actions[0].input.preferredTitle, 'street corn pasta');
});

test('executeRecipeRevise updates the active recipe in chat and offers cookbook replacement without mutating groceries', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-recipe-revise-'));
  const dbPath = path.join(tempDir, 'recipe-revise.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const recipe = await import(new URL('./recipe-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Recipe revise');
    await db.addMessage(created.householdId, chatId, 'assistant', 'KitchenBot', \`Elotes-Style Pasta Salad

Ingredients
1 lb pasta
4 cups corn kernels
1 cup cotija cheese
2 limes

Instructions
Cook the pasta.
Char the corn.
Whisk the dressing.
Fold in the cotija and serve.\`);

    const cookbookId = await db.saveCookbookEntry(created.householdId, {
      title: 'Elotes-Style Pasta Salad',
      normalizedTitle: 'elotes style pasta salad',
      summary: 'A creamy pasta salad with charred corn, lime, and cotija.',
      category: 'pasta',
      recipeType: 'saved_recipe',
      ingredients: ['1 lb pasta', '4 cups corn kernels', '1 cup cotija cheese', '2 limes'],
      instructions: ['Cook the pasta.', 'Char the corn.', 'Whisk the dressing.', 'Fold in the cotija and serve.'],
      tags: ['corn', 'pasta'],
      sourceTitle: 'Elotes Pasta Salad',
      sourceUrl: 'https://example.com/elotes-pasta',
      notes: [],
      sourceKind: 'web_fetch',
      sourceChatId: chatId,
      lastUsedAt: null,
    }, {
      sourceKind: 'web_fetch',
      sourceChatId: chatId,
    });

    const entry = await db.getCookbookEntryById(created.householdId, cookbookId);
    const anthropic = {
      messages: {
        create: async () => ({
          model: 'claude-haiku-4-5',
          usage: { input_tokens: 10, output_tokens: 10 },
          content: [{
            type: 'text',
            text: JSON.stringify({
              title: 'Elotes-Style Pasta Salad',
              summary: 'A creamy pasta salad with charred corn, lime, cotija, and Tajin.',
              ingredients: ['1 lb pasta', '4 cups corn kernels', '1 cup cotija cheese', '2 limes', '1-2 tsp Tajin'],
              instructions: ['Cook the pasta.', 'Char the corn.', 'Whisk the dressing with Tajin.', 'Fold in the cotija, finish with more Tajin, and serve.'],
              tags: ['corn', 'pasta', 'tajin'],
              notes: [],
            }),
          }],
        }),
      },
    };

    const outcome = await recipe.executeRecipeRevise(
      { capability: 'recipe.revise', input: { request: 'add tajin' } },
      {
        req: { householdId: created.householdId },
        chatId,
        prompt: 'add tajin',
        anthropic,
        memoryContext: {
          cookbookEntries: [entry],
          selectedCookbookEntries: [entry],
          applicationText: '',
          appliedDefaultsText: '',
          capabilities: { webSearchEnabled: false },
        },
      }
    );

    const groceryItems = await db.getGroceryItems(created.householdId);
    process.stdout.write(JSON.stringify({ outcome, groceryItems }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });

  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.outcome.capability, 'recipe.revise');
  assert.equal(parsed.outcome.status, 'revised');
  assert.match(parsed.outcome.replyText, /Tajin/i);
  assert.match(parsed.outcome.replyText, /Whisk the dressing with Tajin/i);
  assert.equal(parsed.outcome.proposedNextAction?.action?.capability, 'cookbook.update');
  assert.equal(parsed.groceryItems.length, 0);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('executeRecipeRevise relies on the structured model revision for swap edits instead of semantic fallback rewriting', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-recipe-revise-swap-'));
  const dbPath = path.join(tempDir, 'recipe-revise-swap.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const recipe = await import(new URL('./recipe-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Recipe revise swap');
    await db.addMessage(created.householdId, chatId, 'assistant', 'KitchenBot', \`Elotes-Style Pasta Salad

Ingredients
For the salad:
- 1 lb pasta
- 4 cups corn kernels
- 1/4 cup cilantro
- 2 scallions

Instructions
1. Cook the pasta.
2. Toss the corn, cilantro, and scallions together.
3. Dress and chill.\`);

    const anthropic = {
      messages: {
        create: async () => ({
          model: 'claude-haiku-4-5',
          usage: { input_tokens: 10, output_tokens: 10 },
          content: [{
            type: 'text',
            text: JSON.stringify({
              title: 'Elotes-Style Pasta Salad',
              summary: 'A creamy pasta salad with charred corn, lime, cotija, and extra scallions.',
              ingredients: ['For the salad:', '1 lb pasta', '4 cups corn kernels', '4 scallions, thinly sliced', '2 limes'],
              instructions: ['Cook the pasta.', 'Toss the corn and scallions together.', 'Dress and chill.'],
              tags: ['corn', 'pasta'],
              notes: [],
            }),
          }],
        }),
      },
    };

    const outcome = await recipe.executeRecipeRevise(
      { capability: 'recipe.revise', input: { request: 'swap the cilantro for extra scallions' } },
      {
        req: { householdId: created.householdId },
        chatId,
        prompt: 'swap the cilantro for extra scallions',
        anthropic,
        memoryContext: {
          applicationText: '',
          appliedDefaultsText: '',
          capabilities: { webSearchEnabled: false },
        },
      }
    );

    process.stdout.write(JSON.stringify({ outcome }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });

  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.outcome.capability, 'recipe.revise');
  assert.equal(parsed.outcome.status, 'revised');
  assert.match(parsed.outcome.replyText, /4 scallions, thinly sliced/i);
  assert.doesNotMatch(parsed.outcome.replyText, /cilantro/i);
  assert.doesNotMatch(parsed.outcome.replyText, /\*\*|::/);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('executeRecipeRevise retries additive edits with explicit required additions before giving up', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-recipe-revise-additive-retry-'));
  const dbPath = path.join(tempDir, 'recipe-revise-additive-retry.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const recipe = await import(new URL('./recipe-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Recipe additive retry');
    await db.addMessage(created.householdId, chatId, 'assistant', 'KitchenBot', \`Elotes Pasta Salad

Ingredients
For the dressing:
- 3/4 cup mayonnaise
- 2 tbsp lime juice
- 1 tsp chili powder

Instructions
1. Cook the pasta.
2. Whisk the dressing.
3. Toss and chill.\`);

    let callCount = 0;
    const anthropic = {
      messages: {
        create: async ({ messages }) => {
          callCount += 1;
          const payload = JSON.parse(messages[0].content);
          if (callCount === 1 || callCount === 2) {
            return {
              model: 'claude-haiku-4-5',
              usage: { input_tokens: 10, output_tokens: 10 },
              content: [{
                type: 'text',
                text: JSON.stringify({
                  title: 'Elotes Pasta Salad',
                  summary: 'A creamy pasta salad with corn and lime.',
                  ingredients: ['For the dressing:', '3/4 cup mayonnaise', '2 tbsp lime juice', '1 tsp chili powder'],
                  instructions: ['Cook the pasta.', 'Whisk the dressing.', 'Toss and chill.'],
                  tags: ['pasta'],
                  notes: [],
                }),
              }],
            };
          }
          if (callCount === 4 && payload.requiredAdditions) {
            return {
              model: 'claude-haiku-4-5',
              usage: { input_tokens: 10, output_tokens: 10 },
              content: [{
                type: 'text',
                text: JSON.stringify({
                  title: 'Elotes Pasta Salad',
                  summary: 'A creamy pasta salad with corn, lime, and Tajin in the dressing.',
                  ingredients: ['For the dressing:', '3/4 cup mayonnaise', '2 tbsp lime juice', '1 tsp chili powder', '1 tsp Tajin'],
                  instructions: ['Cook the pasta.', 'Whisk the dressing with Tajin.', 'Toss and chill.'],
                  tags: ['pasta'],
                  notes: [],
                }),
              }],
            };
          }
          return {
            model: 'claude-haiku-4-5',
            usage: { input_tokens: 10, output_tokens: 10 },
            content: [{
              type: 'text',
              text: JSON.stringify({
                ingredientAdds: ['1 tsp Tajin'],
                instructionAdds: ['Whisk the dressing with Tajin.'],
                ingredientSection: 'dressing',
                instructionCue: 'whisk the dressing',
              }),
            }],
          };
        },
      },
    };

    const outcome = await recipe.executeRecipeRevise(
      { capability: 'recipe.revise', input: { request: 'add tajin to the dressing too' } },
      {
        req: { householdId: created.householdId },
        chatId,
        prompt: 'add tajin to the dressing too',
        anthropic,
        memoryContext: {
          applicationText: '',
          appliedDefaultsText: '',
          capabilities: { webSearchEnabled: false },
        },
      }
    );

    process.stdout.write(JSON.stringify({ callCount, outcome }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });

  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.callCount, 4);
  assert.equal(parsed.outcome.capability, 'recipe.revise');
  assert.equal(parsed.outcome.status, 'revised');
  assert.match(parsed.outcome.replyText, /1 tsp Tajin/i);
  assert.match(parsed.outcome.replyText, /Whisk the dressing with Tajin/i);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('executeCookbookUpdate replaces recipe body fields without merging duplicates and preserves source metadata', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-cookbook-update-'));
  const dbPath = path.join(tempDir, 'cookbook-update.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const executor = await import(new URL('./cookbook-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Cookbook update');
    const cookbookId = await db.saveCookbookEntry(created.householdId, {
      title: 'Poblano White Chicken Chili',
      normalizedTitle: 'poblano white chicken chili',
      summary: 'A creamy white chili with poblanos, chicken, and beans.',
      category: 'soups',
      recipeType: 'web_recipe',
      ingredients: ['2 poblano peppers', '1 1/2 lbs chicken', '2 cans white beans'],
      instructions: ['Roast the poblanos.', 'Simmer the chili.', 'Serve hot.'],
      tags: ['chili', 'poblano'],
      sourceTitle: 'Poblano White Chicken Chili',
      sourceUrl: 'https://www.gimmesomeoven.com/poblano-white-chicken-chili/',
      notes: ['Original version'],
      sourceKind: 'web_fetch',
      sourceChatId: chatId,
      lastUsedAt: null,
    }, {
      sourceKind: 'web_fetch',
      sourceChatId: chatId,
    });

    const anthropic = {
      messages: {
        create: async () => ({
          model: 'claude-haiku-4-5',
          usage: { input_tokens: 10, output_tokens: 10 },
          content: [{
            type: 'text',
            text: JSON.stringify({
              title: 'Poblano White Chicken Chili',
              summary: 'A creamy white chili with poblanos, chicken, beans, and cream cheese stirred in at the end.',
              ingredients: ['2 poblano peppers', '1 1/2 lbs chicken', '2 cans white beans', '1 block cream cheese'],
              instructions: ['Roast the poblanos.', 'Simmer the chili.', 'Stir in the cream cheese at the end and serve.'],
              tags: ['chili', 'poblano'],
              notes: [],
            }),
          }],
        }),
      },
    };

    const outcome = await executor.executeCookbookUpdate(
      { capability: 'cookbook.update', input: { id: cookbookId, request: 'add a block of cream cheese at the end' } },
      {
        req: { householdId: created.householdId },
        chatId,
        prompt: 'replace it',
        anthropic,
        memoryContext: {
          selectedCookbookEntries: [await db.getCookbookEntryById(created.householdId, cookbookId)],
          applicationText: '',
          appliedDefaultsText: '',
          capabilities: { webSearchEnabled: false },
        },
      }
    );

    const updated = await db.getCookbookEntryById(created.householdId, cookbookId);
    process.stdout.write(JSON.stringify({ outcome, updated }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });

  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.outcome.capability, 'cookbook.update');
  assert.equal(parsed.outcome.status, 'updated');
  assert.equal(parsed.updated.sourceTitle, 'Poblano White Chicken Chili');
  assert.equal(parsed.updated.sourceUrl, 'https://www.gimmesomeoven.com/poblano-white-chicken-chili/');
  assert.equal(parsed.updated.summary, 'A creamy white chili with poblanos, chicken, beans, and cream cheese stirred in at the end.');
  assert.equal(parsed.updated.category, 'soups');
  assert.deepEqual(parsed.updated.tags, ['chili', 'poblano']);
  assert.equal(parsed.updated.ingredients.filter((item) => /cream cheese/i.test(item)).length, 1);
  assert.equal(parsed.updated.instructions.filter((item) => /cream cheese/i.test(item)).length, 1);
  assert.equal(parsed.updated.instructions.length, 3);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('executeCookbookUpdate can resolve an explicit cookbook title directly from a raw update request', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-cookbook-update-explicit-title-'));
  const dbPath = path.join(tempDir, 'cookbook-update-explicit-title.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const executor = await import(new URL('./cookbook-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Cookbook update explicit title');
    await db.saveCookbookEntry(created.householdId, {
      title: 'Live Poblano Chili v2',
      normalizedTitle: 'live poblano chili v2',
      summary: 'A creamy white chili with poblanos and chicken.',
      category: 'soups',
      recipeType: 'web_recipe',
      ingredients: ['2 poblano peppers', '1 1/2 lbs chicken', '2 cans white beans'],
      instructions: ['Roast the poblanos.', 'Simmer the chili.', 'Serve hot.'],
      tags: ['chili', 'poblano'],
      sourceTitle: 'Poblano White Chicken Chili',
      sourceUrl: 'https://www.gimmesomeoven.com/poblano-white-chicken-chili/',
      notes: [],
      sourceKind: 'web_fetch',
      sourceChatId: chatId,
      lastUsedAt: null,
    }, {
      sourceKind: 'web_fetch',
      sourceChatId: chatId,
    });

    const anthropic = {
      messages: {
        create: async () => ({
          model: 'claude-haiku-4-5',
          usage: { input_tokens: 10, output_tokens: 10 },
          content: [{
            type: 'text',
            text: JSON.stringify({
              title: 'Live Poblano Chili v2',
              summary: 'A creamy white chili with poblanos, chicken, beans, and cream cheese stirred in at the end.',
              ingredients: ['2 poblano peppers', '1 1/2 lbs chicken', '2 cans white beans', '8 oz cream cheese'],
              instructions: ['Roast the poblanos.', 'Simmer the chili.', 'Stir in 8 oz cream cheese at the end and serve.'],
              tags: ['chili', 'poblano'],
              notes: [],
            }),
          }],
        }),
      },
    };

    const outcome = await executor.executeCookbookUpdate(
      { capability: 'cookbook.update', input: { request: 'Update Live Poblano Chili v2 in our cookbook to add 8 ounces of cream cheese at the end, in both the ingredients and the instructions.' } },
      {
        req: { householdId: created.householdId },
        chatId,
        prompt: 'Update Live Poblano Chili v2 in our cookbook to add 8 ounces of cream cheese at the end, in both the ingredients and the instructions.',
        anthropic,
        memoryContext: {
          applicationText: '',
          appliedDefaultsText: '',
          capabilities: { webSearchEnabled: false },
        },
      }
    );

    const updated = await db.getCookbookEntryByNormalizedTitle(created.householdId, 'live poblano chili v2');
    process.stdout.write(JSON.stringify({ outcome, updated }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });

  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.outcome.capability, 'cookbook.update');
  assert.equal(parsed.outcome.status, 'updated');
  assert.equal(parsed.outcome.title, 'Live Poblano Chili v2');
  assert.equal(parsed.updated.instructions.filter((item) => /cream cheese/i.test(item)).length, 1);
  assert.equal(parsed.updated.ingredients.filter((item) => /cream cheese/i.test(item)).length, 1);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('executeCookbookSave manual recovery preserves preferred title and source title', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-cookbook-manual-recovery-'));
  const dbPath = path.join(tempDir, 'cookbook-manual-recovery.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const executor = await import(new URL('./cookbook-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Cookbook manual recovery');
    const outcome = await executor.executeCookbookSave(
      {
        capability: 'cookbook.save',
        input: {
          request: \`All-American Beef Stew

Ingredients
4 cups stock
3 pounds beef chuck roast
10 ounces mushrooms
4 medium carrots

Directions
Brown the beef.
Cook the mushrooms and carrots.
Add stock and simmer until tender.\`,
          preferredTitle: 'our favorite beef stew',
          sourceUrl: 'https://www.seriouseats.com/all-american-beef-stew-recipe?print',
          recoveryMode: 'manual_paste',
        },
      },
      {
        req: { householdId: created.householdId, kbCapabilities: { webSearchEnabled: true } },
        chatId,
        prompt: 'pasted recipe text',
        anthropic: null,
        memoryContext: { capabilities: { webSearchEnabled: true } },
        workingContext: {
          linkedRecipeTitle: 'our favorite beef stew',
          linkedRecipeUrl: 'https://www.seriouseats.com/all-american-beef-stew-recipe?print',
          linkedRecipeFetchStatus: 'no_results',
        },
      }
    );
    const entries = await db.listCookbookEntries(created.householdId);
    process.stdout.write(JSON.stringify({ outcome, count: entries.length, entry: entries[0] }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.outcome.status, 'saved');
  assert.equal(parsed.entry.title, 'our favorite beef stew');
  assert.equal(parsed.entry.sourceTitle, 'All-American Beef Stew');
  assert.equal(parsed.entry.sourceKind, 'manual');
  assert.deepEqual(parsed.entry.ingredients.slice(0, 3), ['4 cups stock', '3 pounds beef chuck roast', '10 ounces mushrooms']);
  assert.deepEqual(parsed.entry.instructions.slice(0, 2), ['Brown the beef.', 'Cook the mushrooms and carrots.']);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('higher-quality manual recipe overwrites degraded source-url placeholder content', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-cookbook-quality-merge-'));
  const dbPath = path.join(tempDir, 'cookbook-quality-merge.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const executor = await import(new URL('./cookbook-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    await db.saveCookbookEntry(created.householdId, {
      title: 'our favorite beef stew',
      normalizedTitle: 'our favorite beef stew',
      summary: 'Recipe unavailable - could not access Serious Eats domain',
      recipeType: 'meal_idea',
      ingredients: ['beef stew ingredients'],
      instructions: [],
      tags: ['beef', 'stew'],
      sourceTitle: 'All-American Beef Stew Recipe',
      sourceUrl: 'https://www.seriouseats.com/all-american-beef-stew-recipe?print',
      notes: 'Unable to fetch recipe content from this domain. User may need to manually add ingredients and instructions.',
      sourceKind: 'web_fetch',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Cookbook repair');
    await executor.executeCookbookSave(
      {
        capability: 'cookbook.save',
        input: {
          request: \`All-American Beef Stew

Ingredients
4 cups stock
3 pounds beef chuck roast
10 ounces mushrooms
4 medium carrots

Directions
Brown the beef.
Cook the mushrooms and carrots.
Add stock and simmer until tender.\`,
          preferredTitle: 'our favorite beef stew',
          sourceUrl: 'https://www.seriouseats.com/all-american-beef-stew-recipe?print',
          recoveryMode: 'manual_paste',
        },
      },
      {
        req: { householdId: created.householdId, kbCapabilities: { webSearchEnabled: true } },
        chatId,
        prompt: 'pasted recipe text',
        anthropic: null,
        memoryContext: { capabilities: { webSearchEnabled: true } },
        workingContext: null,
      }
    );
    const entries = await db.listCookbookEntries(created.householdId);
    process.stdout.write(JSON.stringify({ count: entries.length, entry: entries[0] }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.count, 1);
  assert.equal(parsed.entry.title, 'our favorite beef stew');
  assert.deepEqual(parsed.entry.ingredients.slice(0, 3), ['4 cups stock', '3 pounds beef chuck roast', '10 ounces mushrooms']);
  assert.deepEqual(parsed.entry.notes, []);
  assert.doesNotMatch(parsed.entry.summary, /recipe unavailable/i);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('executeCookbookSave strips save-command preamble before parsing pasted manual recipe text', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-cookbook-manual-command-'));
  const dbPath = path.join(tempDir, 'cookbook-manual-command.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const executor = await import(new URL('./cookbook-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Cookbook manual command');
    const outcome = await executor.executeCookbookSave(
      {
        capability: 'cookbook.save',
        input: {
          request: \`save the following as "Serious Eats Beef Stew" in our cookbook

All-American Beef Stew
Jump to recipe
Prep
5 mins
Cook
3 hrs 10 mins
Serves
6 servings
Ingredients
4 cups stock
3 pounds beef chuck roast
10 ounces mushrooms
4 medium carrots

Directions
Brown the beef.
Cook the mushrooms and carrots.
Add stock and simmer until tender.\`,
        },
      },
      {
        req: { householdId: created.householdId, kbCapabilities: { webSearchEnabled: true } },
        chatId,
        prompt: 'manual save',
        anthropic: null,
        memoryContext: { capabilities: { webSearchEnabled: true } },
        workingContext: null,
      }
    );
    const entries = await db.listCookbookEntries(created.householdId);
    process.stdout.write(JSON.stringify({ outcome, count: entries.length, entry: entries[0] }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.equal(parsed.outcome.status, 'saved');
  assert.equal(parsed.entry.title, 'Serious Eats Beef Stew');
  assert.equal(parsed.entry.sourceTitle, 'All-American Beef Stew');
  assert.deepEqual(parsed.entry.ingredients.slice(0, 3), ['4 cups stock', '3 pounds beef chuck roast', '10 ounces mushrooms']);
  assert.doesNotMatch(parsed.entry.summary, /save the following/i);
  assert.deepEqual(parsed.entry.tags.slice(0, 3), ['serious', 'eats', 'beef']);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('failed cookbook placeholders are detectable for UI filtering', async () => {
  const module = await import(new URL(`../cookbook-store.mjs?failed-placeholder=${Date.now()}`, import.meta.url).href);
  assert.equal(
    module.isFailedCookbookPlaceholder({
      title: 'All-American Beef Stew (Serious Eats)',
      summary: 'Recipe unavailable - could not access Serious Eats domain',
      recipeType: 'meal_idea',
      ingredients: ['Beef stew ingredients (pending full recipe fetch)'],
      instructions: [],
      notes: 'Unable to fetch recipe content from this domain. User may need to manually add ingredients and instructions.',
      sourceKind: 'web_fetch',
    }),
    true
  );
  assert.equal(
    module.isFailedCookbookPlaceholder({
      title: 'Serious Eats Beef Stew',
      summary: 'Serious Eats Beef Stew with stock, beef chuck roast, and mushrooms.',
      recipeType: 'saved_recipe',
      ingredients: ['4 cups stock', '3 pounds beef chuck roast', '10 ounces mushrooms'],
      instructions: ['Brown the beef.', 'Cook the mushrooms and carrots.', 'Add stock and simmer until tender.'],
      notes: '',
      sourceKind: 'manual',
    }),
    false
  );
  assert.equal(
    module.isFailedCookbookPlaceholder({
      title: 'Crispy Chicken Sandwich',
      summary: 'A crunchy fried chicken sandwich with spicy mayo and bacon.',
      recipeType: 'saved_recipe',
      ingredients: ['Ingredients', '4 buns', '4 chicken thighs'],
      instructions: ['Marinate the chicken.', 'Bread and fry it.', 'Build the sandwiches.'],
      notes: '',
      sourceKind: 'kb_action',
    }),
    false
  );
});

test('cookbook list filtering keeps historical valid recipes visible while hiding true failed placeholders', async () => {
  const module = await import(new URL(`../cookbook-store.mjs?cookbook-visibility=${Date.now()}`, import.meta.url).href);
  const entries = [
    {
      id: 1,
      title: 'Crispy Chicken Sandwich',
      summary: 'A crunchy fried chicken sandwich with spicy mayo and bacon.',
      recipeType: 'saved_recipe',
      ingredients: ['Ingredients', '4 buns', '4 chicken thighs'],
      instructions: ['Marinate the chicken.', 'Bread and fry it.', 'Build the sandwiches.'],
      notes: [],
      sourceKind: 'kb_action',
    },
    {
      id: 2,
      title: 'All-American Beef Stew (Serious Eats)',
      summary: 'Recipe unavailable - could not access Serious Eats domain',
      recipeType: 'meal_idea',
      ingredients: ['Beef stew ingredients (pending full recipe fetch)'],
      instructions: [],
      notes: ['Unable to fetch recipe content from this domain. User may need to manually add ingredients and instructions.'],
      sourceKind: 'web_fetch',
    },
  ];

  const visible = entries.filter((entry) => !module.isFailedCookbookPlaceholder(entry));
  assert.equal(visible.length, 1);
  assert.equal(visible[0].title, 'Crispy Chicken Sandwich');
});
