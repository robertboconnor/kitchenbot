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
    'Source recipe'
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
    sourceTitle: "Here's the full recipe for **Miso Butter Pasta with Roasted Mushrooms & Soft Scrambled Eggs**:",
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

test('fallback cookbook reply uses the cleaned saved title', async () => {
  const module = await import(new URL(`../kb-reply.mjs?cookbook-reply-clean-title=${Date.now()}`, import.meta.url).href);

  const reply = module.fallbackSkillOutcomeReply([
    {
      capability: 'cookbook.save',
      status: 'saved',
      title: '## Lobster Roll Meets Italian Beef',
    },
  ]);

  assert.equal(reply, 'I saved Lobster Roll Meets Italian Beef to your cookbook.');
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

test('linked recipe fetch follow-up replies from working-context facts instead of generic web-browsing claims', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-cookbook-follow-up-'));
  const dbPath = path.join(tempDir, 'cookbook-follow-up.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const reply = await import(new URL('./kb-reply.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Cookbook follow-up');
    let body = '';
    const res = {
      setHeader() {},
      end(text) { body = text; },
    };
    await reply.respondWithKbReply({
      anthropic: null,
      req: { householdId: created.householdId, user: 'Rob', kbCapabilities: { webSearchEnabled: true } },
      res,
      name: 'Rob',
      chatId,
      routePrompt: 'did you actually read the URL? was there something about the ?print parameter that caused an issue?',
      replyText: '',
      replyPlan: null,
      memoryContext: {
        assistantPersona: { assistantName: 'KitchenBot', assistantTone: 'helpful' },
        workingContext: {
          linkedRecipeTitle: 'our favorite beef stew',
          linkedRecipeUrl: 'https://www.seriouseats.com/all-american-beef-stew-recipe?print',
          linkedRecipeFetchStatus: 'no_results',
          linkedRecipeFailureReason: 'I could not read enough recipe detail from that link to save it properly.',
        },
      },
      workingContext: {
        linkedRecipeTitle: 'our favorite beef stew',
        linkedRecipeUrl: 'https://www.seriouseats.com/all-american-beef-stew-recipe?print',
        linkedRecipeFetchStatus: 'no_results',
        linkedRecipeFailureReason: 'I could not read enough recipe detail from that link to save it properly.',
      },
      outcomes: [],
      userMessageAlreadyPersisted: false,
      proposedNextAction: null,
      deps: {
        incrementUserMessageCountForSender: async () => {},
        broadcastToChat: () => {},
        stripStoredMessageContentForDisplay: (text) => text,
      },
    });
    process.stdout.write(JSON.stringify({ body }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.match(parsed.body, /did not read enough of the linked page/i);
  assert.match(parsed.body, /do not have evidence that the URL parameter itself was the problem/i);
  assert.doesNotMatch(parsed.body, /can't browse the web in real time/i);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('linked recipe fetch follow-up explains bot blocking from working-context facts', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-cookbook-blocked-followup-'));
  const dbPath = path.join(tempDir, 'cookbook-blocked-followup.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const reply = await import(new URL('./kb-reply.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Cookbook blocked follow-up');
    let body = '';
    const res = { setHeader() {}, end(text) { body = text; } };
    await reply.respondWithKbReply({
      anthropic: null,
      req: { householdId: created.householdId, user: 'Rob', kbCapabilities: { webSearchEnabled: true } },
      res,
      name: 'Rob',
      chatId,
      routePrompt: 'did you actually read the link? why not? was the print parameter the issue?',
      replyText: '',
      replyPlan: null,
      memoryContext: {
        assistantPersona: { assistantName: 'KitchenBot', assistantTone: 'helpful' },
        workingContext: {
          linkedRecipeTitle: 'our favorite beef stew',
          linkedRecipeUrl: 'https://www.seriouseats.com/all-american-beef-stew-recipe?print',
          linkedRecipeFetchStatus: 'blocked',
          linkedRecipeFailureReason: 'The site blocked automated page access from our server with HTTP 403.',
          linkedRecipeFetchBlocked: true,
          linkedRecipeBlockerKind: 'cloudflare',
          linkedRecipeFailureKind: 'blocked',
          linkedRecipeHttpStatus: 403,
        },
      },
      workingContext: {
        linkedRecipeTitle: 'our favorite beef stew',
        linkedRecipeUrl: 'https://www.seriouseats.com/all-american-beef-stew-recipe?print',
        linkedRecipeFetchStatus: 'blocked',
        linkedRecipeFailureReason: 'The site blocked automated page access from our server with HTTP 403.',
        linkedRecipeFetchBlocked: true,
        linkedRecipeBlockerKind: 'cloudflare',
        linkedRecipeFailureKind: 'blocked',
        linkedRecipeHttpStatus: 403,
      },
      outcomes: [],
      userMessageAlreadyPersisted: false,
      proposedNextAction: null,
      deps: {
        incrementUserMessageCountForSender: async () => {},
        broadcastToChat: () => {},
        stripStoredMessageContentForDisplay: (text) => text,
      },
    });
    process.stdout.write(JSON.stringify({ body }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.match(parsed.body, /blocked automated page access from our server/i);
  assert.match(parsed.body, /http 403/i);
  assert.match(parsed.body, /do not have evidence that the URL parameter itself was the problem/i);
  assert.match(parsed.body, /paste the recipe text here and i can save it manually/i);

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
