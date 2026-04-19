import test from 'node:test';
import assert from 'node:assert/strict';

import { withTempDb } from '../test-support/db-helpers.mjs';

async function createHousehold(importFresh) {
  const db = await importFresh('../db.mjs', 'recipe-importer-db');
  await db.runMigrations();
  const household = await db.createHouseholdWithInitialOwner({
    householdName: 'Rob and Elle',
    householdKey: 'oconnor-home',
    ownerDisplayName: 'Rob',
    pin: '1234',
  });
  return { db, household };
}

test('URL import with successful Riveter extraction creates a populated draft without saving cookbook state yet', async () => {
  await withTempDb('recipe-importer-url-success', async ({ importFresh }) => {
    const { db, household } = await createHousehold(importFresh);
    const service = await importFresh('../recipe-importer-service.mjs', 'recipe-importer-service-success');
    const previousKey = process.env.RIVETER_API_KEY;
    process.env.RIVETER_API_KEY = 'test-riveter-key';
    try {
      const draft = await service.importRecipeFromUrl({
        url: 'https://example.com/cheat-wonton-soup',
        householdId: household.householdId,
        userId: household.userId,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              data: {
                url: 'https://example.com/cheat-wonton-soup',
                text: `Cheat Wonton Soup

Ingredients
8 cups chicken broth
1 piece ginger
12 frozen potstickers
2 baby bok choy

Instructions
Simmer the broth with ginger.
Reheat with potstickers.
Add bok choy for the last two minutes.
Serve hot.`,
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ),
      });

      assert.equal(draft.sourceType, 'url');
      assert.equal(draft.sourceUrl, 'https://example.com/cheat-wonton-soup');
      assert.equal(draft.recipe.title, 'Cheat Wonton Soup');
      assert.ok(draft.recipe.ingredients.includes('8 cups chicken broth'));
      assert.ok(draft.recipe.instructions.some((line) => /Simmer the broth/i.test(line)));
      assert.deepEqual((await db.listCookbookEntries(household.householdId)).map((entry) => entry.title), []);
    } finally {
      if (previousKey == null) delete process.env.RIVETER_API_KEY;
      else process.env.RIVETER_API_KEY = previousKey;
    }
  });
});

test('URL import with weak extraction still creates a draft with warnings', async () => {
  await withTempDb('recipe-importer-url-weak', async ({ importFresh }) => {
    const { household } = await createHousehold(importFresh);
    const service = await importFresh('../recipe-importer-service.mjs', 'recipe-importer-service-weak');
    const previousKey = process.env.RIVETER_API_KEY;
    process.env.RIVETER_API_KEY = 'test-riveter-key';
    try {
      const draft = await service.importRecipeFromUrl({
        url: 'https://example.com/messy-recipe',
        householdId: household.householdId,
        userId: household.userId,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              data: {
                url: 'https://example.com/messy-recipe',
                text: 'My favorite weeknight soup.\nThis page is mostly storytelling and there is no clean ingredient section here.',
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ),
      });

      assert.equal(draft.recipe.title, 'Imported recipe draft');
      assert.equal(Array.isArray(draft.warnings), true);
      assert.ok(draft.warnings.some((warning) => /clean recipe/i.test(warning) || /repair/i.test(warning)));
    } finally {
      if (previousKey == null) delete process.env.RIVETER_API_KEY;
      else process.env.RIVETER_API_KEY = previousKey;
    }
  });
});

test('URL import prefers Anthropic structuring for polluted page extraction', async () => {
  await withTempDb('recipe-importer-url-structured', async ({ importFresh }) => {
    const { household } = await createHousehold(importFresh);
    const service = await importFresh('../recipe-importer-service.mjs', 'recipe-importer-service-url-structured');
    const previousKey = process.env.RIVETER_API_KEY;
    process.env.RIVETER_API_KEY = 'test-riveter-key';
    try {
      const draft = await service.importRecipeFromUrl({
        url: 'https://www.seriouseats.com/italian-american-beef-pork-meatballs-red-tomato-sauce-recipe',
        householdId: household.householdId,
        userId: household.userId,
        anthropic: {
          messages: {
            create: async () => ({
              model: 'claude-haiku-4-5-20251001',
              stop_reason: 'end_turn',
              usage: { input_tokens: 180, output_tokens: 140 },
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    title: 'Italian-American Meatballs in Red Sauce',
                    summary: 'Tender beef-and-pork meatballs simmered in a bright tomato sauce.',
                    ingredients: [
                      '2 pounds ground beef',
                      '1 pound ground pork',
                      '4 cups low-sodium chicken stock',
                      '6 ounces crustless fresh white bread, cut into 1/2-inch cubes',
                    ],
                    instructions: [
                      'Soak the bread in the stock, then mash until it forms a paste.',
                      'Mix the meats with the panade and seasonings, then shape into meatballs.',
                      'Brown the meatballs, then simmer them gently in the tomato sauce until cooked through.',
                    ],
                    notes: ['Serve with extra sauce and grated cheese.'],
                    tags: ['meatballs', 'italian-american', 'tomato sauce'],
                    category: 'meat',
                    warnings: ['Navigation and site chrome were removed from the web extraction.'],
                    confidence: 'high',
                  }),
                },
              ],
            }),
          },
        },
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              data: {
                url: 'https://www.seriouseats.com/italian-american-beef-pork-meatballs-red-tomato-sauce-recipe',
                text: `Skip to Content
Close search Search Search
My Saves [https://www.myrecipes.com/] | button button
https://www.seriouseats.com/
* - Recipes [/all-recipes-5117985]
* - Recipes by Course [/recipes-by-course-5117906]
Keep Screen Awake
Italian-American Meatballs in Red Sauce
This recipe makes juicy beef-and-pork meatballs with tomato sauce.
Ingredients
2 pounds ground beef
1 pound ground pork
4 cups low-sodium chicken stock
6 ounces crustless fresh white bread, cut into 1/2-inch cubes
Instructions
Soak the bread in stock.
Mix with the meats and seasonings.
Brown the meatballs and simmer in sauce.
Photo: Serious Eats / Vicky Wasik`,
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ),
      });

      assert.equal(draft.provenance.parser, 'anthropic_url_recipe_structurer');
      assert.equal(draft.recipe.title, 'Italian-American Meatballs in Red Sauce');
      assert.equal(draft.recipe.category, 'meat');
      assert.match(draft.recipe.summary, /beef-and-pork meatballs/i);
      assert.deepEqual(draft.recipe.tags, ['meatballs', 'italian-american', 'tomato sauce']);
      assert.ok(draft.recipe.ingredients.includes('2 pounds ground beef'));
      assert.ok(draft.recipe.instructions.some((line) => /Brown the meatballs/i.test(line)));
      assert.ok(draft.warnings.some((warning) => /site chrome/i.test(warning)));
      assert.ok(draft.recipe.ingredients.every((line) => !/Skip to Content|Keep Screen Awake|recipes by course/i.test(line)));
      assert.ok(draft.recipe.instructions.every((line) => !/Photo:|button button|Search Search/i.test(line)));
      assert.ok(draft.recipe.notes.every((line) => !/Skip to Content|Keep Screen Awake/i.test(line)));
    } finally {
      if (previousKey == null) delete process.env.RIVETER_API_KEY;
      else process.env.RIVETER_API_KEY = previousKey;
    }
  });
});

test('URL import falls back to deterministic parsing when Anthropic structuring is malformed', async () => {
  await withTempDb('recipe-importer-url-fallback', async ({ importFresh }) => {
    const { household } = await createHousehold(importFresh);
    const service = await importFresh('../recipe-importer-service.mjs', 'recipe-importer-service-url-fallback');
    const previousKey = process.env.RIVETER_API_KEY;
    process.env.RIVETER_API_KEY = 'test-riveter-key';
    try {
      const draft = await service.importRecipeFromUrl({
        url: 'https://example.com/simple-soup',
        householdId: household.householdId,
        userId: household.userId,
        anthropic: {
          messages: {
            create: async () => ({
              model: 'claude-haiku-4-5-20251001',
              stop_reason: 'end_turn',
              usage: { input_tokens: 80, output_tokens: 20 },
              content: [{ type: 'text', text: 'not-json-at-all' }],
            }),
          },
        },
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              data: {
                url: 'https://example.com/simple-soup',
                text: `Simple Soup

Ingredients
4 cups broth
1 onion
2 carrots

Instructions
Simmer the broth with onion and carrots.
Cook until tender and serve.`,
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ),
      });

      assert.equal(draft.provenance.parser, 'cookbook_store_parser_fallback');
      assert.equal(draft.recipe.title, 'Simple Soup');
      assert.ok(draft.recipe.ingredients.includes('4 cups broth'));
      assert.ok(draft.recipe.instructions.some((line) => /Simmer the broth/i.test(line)));
      assert.ok(draft.warnings.some((warning) => /clean recipe|repair/i.test(warning)));
    } finally {
      if (previousKey == null) delete process.env.RIVETER_API_KEY;
      else process.env.RIVETER_API_KEY = previousKey;
    }
  });
});

test('URL import retries Anthropic structuring when the first JSON response is truncated', async () => {
  await withTempDb('recipe-importer-url-retry', async ({ importFresh }) => {
    const { household } = await createHousehold(importFresh);
    const service = await importFresh('../recipe-importer-service.mjs', 'recipe-importer-service-url-retry');
    const previousKey = process.env.RIVETER_API_KEY;
    process.env.RIVETER_API_KEY = 'test-riveter-key';
    let callCount = 0;
    try {
      const draft = await service.importRecipeFromUrl({
        url: 'https://example.com/bright-pasta',
        householdId: household.householdId,
        userId: household.userId,
        anthropic: {
          messages: {
            create: async () => {
              callCount += 1;
              if (callCount === 1) {
                return {
                  model: 'claude-haiku-4-5-20251001',
                  stop_reason: 'max_tokens',
                  usage: { input_tokens: 100, output_tokens: 100 },
                  content: [
                    {
                      type: 'text',
                      text: '{"title":"Bright Lemon Pasta","ingredients":["1 pound pasta"],"instructions":["Boil the pasta"',
                    },
                  ],
                };
              }
              return {
                model: 'claude-haiku-4-5-20251001',
                stop_reason: 'end_turn',
                usage: { input_tokens: 120, output_tokens: 120 },
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      title: 'Bright Lemon Pasta',
                      summary: 'A quick lemony pasta for weeknights.',
                      ingredients: ['1 pound pasta', '2 lemons', '3 tablespoons olive oil'],
                      instructions: ['Boil the pasta.', 'Whisk together lemon juice and olive oil.', 'Toss and serve.'],
                      notes: [],
                      tags: ['pasta', 'lemon'],
                      category: 'pasta',
                      warnings: [],
                      confidence: 'high',
                    }),
                  },
                ],
              };
            },
          },
        },
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              data: {
                url: 'https://example.com/bright-pasta',
                text: `Bright Lemon Pasta

Ingredients
1 pound pasta
2 lemons
3 tablespoons olive oil

Instructions
Boil the pasta.
Whisk together lemon juice and olive oil.
Toss and serve.`,
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ),
      });

      assert.equal(callCount, 2);
      assert.equal(draft.provenance.parser, 'anthropic_url_recipe_structurer');
      assert.equal(draft.recipe.title, 'Bright Lemon Pasta');
      assert.ok(draft.recipe.ingredients.includes('1 pound pasta'));
      assert.ok(draft.recipe.instructions.some((line) => /Boil the pasta/i.test(line)));
    } finally {
      if (previousKey == null) delete process.env.RIVETER_API_KEY;
      else process.env.RIVETER_API_KEY = previousKey;
    }
  });
});

test('image import with OCR text creates a populated draft', async () => {
  await withTempDb('recipe-importer-image', async ({ importFresh }) => {
    const { household } = await createHousehold(importFresh);
    const service = await importFresh('../recipe-importer-service.mjs', 'recipe-importer-service-image');
    const draft = await service.importRecipeFromImages({
      files: [
        { originalname: 'mushroom-pasta-1.jpg', buffer: Buffer.from('fake') },
        { originalname: 'mushroom-pasta-2.jpg', buffer: Buffer.from('fake2') },
      ],
      householdId: household.householdId,
      userId: household.userId,
      recognizeImages: async () => ({
        title: 'Buttery Mushroom Pasta',
        text: `Buttery Mushroom Pasta

Ingredients
1 lb pasta
8 oz mushrooms
3 tbsp butter

Instructions
Cook the pasta.
Brown the mushrooms in butter.
Toss everything together.`,
        markdown: `# Buttery Mushroom Pasta

## Ingredients
- 1 lb pasta
- 8 oz mushrooms
- 3 tbsp butter

## Instructions
1. Cook the pasta.
2. Brown the mushrooms in butter.
3. Toss everything together.`,
        warnings: ['The image quality looks a little rough, so double-check the OCR before saving.'],
      }),
    });

    assert.equal(draft.sourceType, 'image');
    assert.equal(draft.provenance.imageCount, 2);
    assert.equal(draft.provenance.fetchProvider, 'google_document_ai');
    assert.equal(draft.recipe.title, 'Buttery Mushroom Pasta');
    assert.match(draft.sourceMarkdown, /# Buttery Mushroom Pasta/);
    assert.ok(draft.recipe.ingredients.includes('8 oz mushrooms'));
    assert.ok(draft.warnings.some((warning) => /OCR/i.test(warning)));
  });
});

test('image import prefers Anthropic structuring for messy cookbook-page OCR', async () => {
  await withTempDb('recipe-importer-image-structured', async ({ importFresh }) => {
    const { household } = await createHousehold(importFresh);
    const service = await importFresh('../recipe-importer-service.mjs', 'recipe-importer-service-image-structured');
    const draft = await service.importRecipeFromImages({
      files: [{ originalname: 'grapefruit-cake.jpg', buffer: Buffer.from('fake') }],
      householdId: household.householdId,
      userId: household.userId,
      anthropic: {
        messages: {
          create: async () => ({
            model: 'claude-haiku-4-5-20251001',
            usage: { input_tokens: 120, output_tokens: 90 },
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  title: 'Grapefruit Olive Oil Cake',
                  summary: 'A citrusy olive oil loaf cake with grapefruit zest and a simple glaze.',
                  ingredients: [
                    '2 red grapefruit',
                    '3 large eggs',
                    '1/2 cup (115g) plain whole-milk Greek yogurt',
                    '2 cups (240g) all-purpose flour',
                    '1/2 teaspoon (3g) baking soda',
                    '1/2 teaspoon (2g) baking powder',
                    '2 teaspoons (6g) kosher salt',
                  ],
                  instructions: [
                    'Preheat the oven to 350 F and prepare a 9 x 5-inch loaf pan.',
                    'Whisk together the dry ingredients in a medium bowl.',
                    'Combine the wet ingredients, then fold in the dry ingredients just until combined.',
                    'Bake until a toothpick inserted in the center comes out clean, 65 to 85 minutes.',
                  ],
                  notes: ['Drizzle the reserved grapefruit glaze over the cooled cake.'],
                  tags: ['cake', 'grapefruit', 'olive oil'],
                  category: 'dessert_cakes',
                  warnings: ['Instruction fragments were reordered conservatively from OCR.'],
                  confidence: 'high',
                }),
              },
            ],
          }),
        },
      },
      recognizeImages: async () => ({
        title: 'Grapefruit Olive Oil Cake',
        text: `Grapefruit
Olive Oil
Cake

PRODUCE
2 red grapefruit

4 Combine the wet with the dry:
Pour the batter into the prepared loaf pan.

DAIRY
3 large eggs
1/2 cup (115g) plain whole-
milk Greek yogurt

PANTRY
2 cups (240g) all-purpose flour
1/2 teaspoon (3g) baking soda
1/2 teaspoon (2g) baking powder
2 teaspoons (6g) kosher salt

1 Get yourself ready to bake:
Position a rack in the center of the oven and preheat the oven to 350 F.`,
        markdown: '',
        warnings: ['The image quality looks a little rough, so double-check the OCR before saving.'],
      }),
    });

    assert.equal(draft.provenance.fetchProvider, 'google_document_ai');
    assert.equal(draft.provenance.parser, 'anthropic_image_recipe_structurer');
    assert.equal(draft.recipe.title, 'Grapefruit Olive Oil Cake');
    assert.equal(draft.recipe.category, 'dessert_cakes');
    assert.ok(draft.recipe.ingredients.includes('2 red grapefruit'));
    assert.ok(draft.recipe.instructions.some((line) => /Preheat the oven/i.test(line)));
    assert.ok(draft.warnings.some((warning) => /reordered conservatively/i.test(warning)));
  });
});

test('image import falls back to deterministic parsing when Anthropic structuring is malformed', async () => {
  await withTempDb('recipe-importer-image-fallback', async ({ importFresh }) => {
    const { household } = await createHousehold(importFresh);
    const service = await importFresh('../recipe-importer-service.mjs', 'recipe-importer-service-image-fallback');
    const draft = await service.importRecipeFromImages({
      files: [{ originalname: 'simple-soup.jpg', buffer: Buffer.from('fake') }],
      householdId: household.householdId,
      userId: household.userId,
      anthropic: {
        messages: {
          create: async () => ({
            model: 'claude-haiku-4-5-20251001',
            usage: { input_tokens: 80, output_tokens: 20 },
            content: [{ type: 'text', text: 'not-json-at-all' }],
          }),
        },
      },
      recognizeImages: async () => ({
        title: 'Simple Soup',
        text: `Simple Soup

Ingredients
4 cups broth
1 onion
2 carrots

Instructions
Simmer the broth with onion and carrots.
Cook until tender and serve.`,
        markdown: '',
        warnings: [],
      }),
    });

    assert.equal(draft.provenance.parser, 'cookbook_store_parser_fallback');
    assert.equal(draft.recipe.title, 'Simple Soup');
    assert.ok(draft.recipe.ingredients.includes('4 cups broth'));
    assert.ok(draft.recipe.instructions.some((line) => /Simmer the broth/i.test(line)));
    assert.ok(draft.warnings.some((warning) => /OCR/i.test(warning)));
  });
});

test('image import retries Anthropic structuring when the first JSON response is truncated', async () => {
  await withTempDb('recipe-importer-image-retry', async ({ importFresh }) => {
    const { household } = await createHousehold(importFresh);
    const service = await importFresh('../recipe-importer-service.mjs', 'recipe-importer-service-image-retry');
    let callCount = 0;
    const draft = await service.importRecipeFromImages({
      files: [{ originalname: 'grapefruit-cake.jpg', buffer: Buffer.from('fake') }],
      householdId: household.householdId,
      userId: household.userId,
      anthropic: {
        messages: {
          create: async () => {
            callCount += 1;
            if (callCount === 1) {
              return {
                model: 'claude-haiku-4-5-20251001',
                stop_reason: 'max_tokens',
                usage: { input_tokens: 100, output_tokens: 100 },
                content: [
                  {
                    type: 'text',
                    text: '{"title":"Grapefruit Olive Oil Cake","ingredients":["2 red grapefruit"],"instructions":["Preheat the oven"',
                  },
                ],
              };
            }
            return {
              model: 'claude-haiku-4-5-20251001',
              stop_reason: 'end_turn',
              usage: { input_tokens: 120, output_tokens: 120 },
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    title: 'Grapefruit Olive Oil Cake',
                    summary: 'A citrusy olive oil loaf cake with grapefruit and pistachios.',
                    ingredients: ['2 red grapefruit', '3 large eggs', '2 cups (240g) all-purpose flour'],
                    instructions: ['Preheat the oven to 350 F.', 'Whisk together the dry ingredients.', 'Bake until done.'],
                    notes: [],
                    tags: ['cake', 'grapefruit'],
                    category: 'dessert_cakes',
                    warnings: [],
                    confidence: 'high',
                  }),
                },
              ],
            };
          },
        },
      },
      recognizeImages: async () => ({
        title: 'Grapefruit Olive Oil Cake',
        text: 'Grapefruit Olive Oil Cake\nPRODUCE\n2 red grapefruit\n1 Get yourself ready to bake:\nPreheat the oven to 350 F.',
        markdown: '',
        warnings: [],
      }),
    });

    assert.equal(callCount, 2);
    assert.equal(draft.provenance.parser, 'anthropic_image_recipe_structurer');
    assert.ok(draft.recipe.ingredients.includes('2 red grapefruit'));
    assert.ok(draft.recipe.instructions.some((line) => /Preheat the oven/i.test(line)));
  });
});

test('manual recipe drafts can be created and then saved without any import source', async () => {
  await withTempDb('recipe-importer-manual-draft', async ({ importFresh }) => {
    const { household } = await createHousehold(importFresh);
    const service = await importFresh('../recipe-importer-service.mjs', 'recipe-importer-service-manual');

    const draft = await service.createManualRecipeImportDraft({
      householdId: household.householdId,
      userId: household.userId,
      recipe: {
        title: 'Weeknight Tomato Pasta',
        summary: 'A quick pantry pasta.',
        ingredients: ['1 pound pasta', '1 can crushed tomatoes', '3 cloves garlic'],
        instructions: ['Boil the pasta.', 'Simmer the tomatoes with garlic.', 'Toss and serve.'],
        notes: ['Finish with olive oil.'],
        tags: ['pasta', 'weeknight'],
        category: 'pasta',
      },
    });

    assert.equal(draft.sourceType, 'manual');
    assert.equal(draft.provenance.importMethod, 'manual');
    assert.equal(draft.provenance.parser, 'manual_editor');
    assert.equal(draft.recipe.title, 'Weeknight Tomato Pasta');

    const savedItem = await service.saveRecipeImportDraftToCookbook({
      draftId: draft.id,
      householdId: household.householdId,
      userId: household.userId,
    });

    assert.equal(savedItem.title, 'Weeknight Tomato Pasta');
    assert.equal(savedItem.sourceKind, 'manual');
    const updatedDraft = await service.getRecipeImportDraft({
      draftId: draft.id,
      householdId: household.householdId,
      userId: household.userId,
    });
    assert.equal(updatedDraft.status, 'saved');
    assert.equal(Number(updatedDraft.provenance.savedCookbookEntryId), Number(savedItem.id));
  });
});

test('saving a duplicate-title importer draft returns a structured conflict instead of a raw database error', async () => {
  await withTempDb('recipe-importer-duplicate-conflict', async ({ importFresh }) => {
    const { household } = await createHousehold(importFresh);
    const service = await importFresh('../recipe-importer-service.mjs', 'recipe-importer-service-duplicate-conflict');
    const duplicateTitle = `Grapefruit Olive Oil Cake ${Date.now()} ${Math.random().toString(16).slice(2, 6)}`;

    const existingDraft = await service.createManualRecipeImportDraft({
      householdId: household.householdId,
      userId: household.userId,
      recipe: {
        title: duplicateTitle,
        summary: 'Existing version.',
        ingredients: ['1 grapefruit'],
        instructions: ['Bake it.'],
        notes: ['Existing note.'],
        tags: ['cake'],
        category: 'dessert_cakes',
      },
    });
    const existingItem = await service.saveRecipeImportDraftToCookbook({
      draftId: existingDraft.id,
      householdId: household.householdId,
      userId: household.userId,
    });

    const draft = await service.createManualRecipeImportDraft({
      householdId: household.householdId,
      userId: household.userId,
      recipe: {
        title: duplicateTitle,
        summary: 'New imported version.',
        ingredients: ['2 red grapefruit', '3 eggs'],
        instructions: ['Mix the batter.', 'Bake until done.'],
        notes: [],
        tags: ['cake', 'grapefruit'],
        category: 'dessert_cakes',
      },
    });

    await assert.rejects(
      service.saveRecipeImportDraftToCookbook({
        draftId: draft.id,
        householdId: household.householdId,
        userId: household.userId,
      }),
      (error) => {
        assert.equal(error.code, 'duplicate_recipe_title');
        assert.match(error.message, /already exists in your Cookbook/i);
        assert.equal(Number(error.conflict.existingCookbookEntryId), Number(existingItem.id));
        assert.equal(error.conflict.existingCookbookTitle, duplicateTitle);
        return true;
      }
    );

    const updatedDraft = await service.getRecipeImportDraft({
      draftId: draft.id,
      householdId: household.householdId,
      userId: household.userId,
    });
    assert.equal(updatedDraft.status, 'draft');
  });
});

test('overwriteExisting updates the existing cookbook row in place and marks the draft saved', async () => {
  await withTempDb('recipe-importer-duplicate-overwrite', async ({ importFresh }) => {
    const { household } = await createHousehold(importFresh);
    const service = await importFresh('../recipe-importer-service.mjs', 'recipe-importer-service-duplicate-overwrite');
    const duplicateTitle = `Grapefruit Olive Oil Cake ${Date.now()} ${Math.random().toString(16).slice(2, 6)}`;

    const existingDraft = await service.createManualRecipeImportDraft({
      householdId: household.householdId,
      userId: household.userId,
      recipe: {
        title: duplicateTitle,
        summary: 'Existing version.',
        ingredients: ['1 grapefruit'],
        instructions: ['Bake it.'],
        notes: ['Old note.'],
        tags: ['cake'],
        category: 'dessert_cakes',
      },
    });
    const existingItem = await service.saveRecipeImportDraftToCookbook({
      draftId: existingDraft.id,
      householdId: household.householdId,
      userId: household.userId,
    });

    const draft = await service.createManualRecipeImportDraft({
      householdId: household.householdId,
      userId: household.userId,
      recipe: {
        title: duplicateTitle,
        summary: 'A citrusy olive oil loaf cake.',
        ingredients: ['2 red grapefruit', '3 large eggs'],
        instructions: ['Mix the batter.', 'Bake until done.'],
        notes: ['New note.'],
        tags: ['cake', 'grapefruit'],
        category: 'dessert_cakes',
      },
    });

    const savedItem = await service.saveRecipeImportDraftToCookbook({
      draftId: draft.id,
      householdId: household.householdId,
      userId: household.userId,
      overwriteExisting: true,
    });

    assert.equal(Number(savedItem.id), Number(existingItem.id));
    assert.equal(savedItem.summary, 'A citrusy olive oil loaf cake.');
    assert.deepEqual(savedItem.ingredients, ['2 red grapefruit', '3 large eggs']);
    assert.deepEqual(savedItem.instructions, ['Mix the batter.', 'Bake until done.']);

    const updatedDraft = await service.getRecipeImportDraft({
      draftId: draft.id,
      householdId: household.householdId,
      userId: household.userId,
    });
    assert.equal(updatedDraft.status, 'saved');
    assert.equal(Number(updatedDraft.provenance.savedCookbookEntryId), Number(existingItem.id));
  });
});

test('saving a valid importer draft creates exactly one cookbook entry with provenance', async () => {
  await withTempDb('recipe-importer-save', async ({ importFresh }) => {
    const { household } = await createHousehold(importFresh);
    const service = await importFresh('../recipe-importer-service.mjs', 'recipe-importer-service-save');
    const previousKey = process.env.RIVETER_API_KEY;
    process.env.RIVETER_API_KEY = 'test-riveter-key';
    try {
      const draft = await service.importRecipeFromUrl({
        url: 'https://example.com/cheat-wonton-soup',
        householdId: household.householdId,
        userId: household.userId,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              data: {
                url: 'https://example.com/cheat-wonton-soup',
                text: `Cheat Wonton Soup

Ingredients
8 cups chicken broth
1 piece ginger
12 frozen potstickers
2 baby bok choy

Instructions
Simmer the broth with ginger.
Reheat with potstickers.
Add bok choy for the last two minutes.
Serve hot.`,
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ),
      });

      await service.updateRecipeImportDraft({
        draftId: draft.id,
        householdId: household.householdId,
        userId: household.userId,
        patch: {
          provenance: {
            ...(draft.provenance || {}),
            sourceBookTitle: 'Cook This Book',
          },
        },
      });

      const saved = await service.saveRecipeImportDraftToCookbook({
        draftId: draft.id,
        householdId: household.householdId,
        userId: household.userId,
      });

      assert.equal(saved.title, 'Cheat Wonton Soup');
      assert.equal(saved.sourceKind, 'web_fetch');
      assert.equal(saved.sourceBookTitle, 'Cook This Book');
      assert.equal(saved.sourceUrl, 'https://example.com/cheat-wonton-soup');
      const updatedDraft = await service.getRecipeImportDraft({
        draftId: draft.id,
        householdId: household.householdId,
        userId: household.userId,
      });
      assert.equal(updatedDraft.status, 'saved');
      assert.equal(Number(updatedDraft.provenance.savedCookbookEntryId), Number(saved.id));
    } finally {
      if (previousKey == null) delete process.env.RIVETER_API_KEY;
      else process.env.RIVETER_API_KEY = previousKey;
    }
  });
});
