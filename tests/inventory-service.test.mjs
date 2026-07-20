import test from 'node:test';
import assert from 'node:assert/strict';

import {
  inferProbablyPantryItem,
  mergeGroceryItemsFromAi,
  normalizeGroceryItemsForPost,
  normalizeInventoryNameKey,
} from '../inventory-service.mjs';
import { normalizeInventoryItemName, resolveInventoryItems } from '../inventory-classification.mjs';

test('inventory auto-classification fallback is consistent for pantry and grocery', async () => {
  const [groceryItem] = await resolveInventoryItems({
    target: 'grocery',
    items: [{ name: 'Greek yogurt', section: '' }],
    anthropic: null,
  });
  const [pantryItem] = await resolveInventoryItems({
    target: 'pantry',
    items: [{ name: 'rotini', section: '' }],
    anthropic: null,
  });

  assert.equal(groceryItem.section, 'dairy');
  assert.equal(pantryItem.section, 'pasta_grains_dry_goods');
});

test('inventory name key normalization is shared and stable', () => {
  assert.equal(normalizeInventoryNameKey('  Greek   Yogurt '), 'greek yogurt');
});

test('inventory item name normalization strips prep phrases but keeps shopping-useful identity', () => {
  assert.equal(normalizeInventoryItemName('1 small white onion, diced'.replace(/^\d+\s+/, '')), 'white onion');
  assert.equal(normalizeInventoryItemName('garlic cloves, minced'), 'garlic');
  assert.equal(normalizeInventoryItemName('celery stalk, diced'), 'celery');
  assert.equal(normalizeInventoryItemName('freshly-squeezed lemon juice'), 'lemons');
  assert.equal(normalizeInventoryItemName('artichoke hearts, drained'), 'artichoke hearts');
});

test('probably pantry item inference stays tightly scoped for grocery rows', () => {
  assert.equal(inferProbablyPantryItem({ name: 'all purpose flour', section: 'dry' }), true);
  assert.equal(inferProbablyPantryItem({ name: 'olive oil', section: 'dry' }), true);
  assert.equal(inferProbablyPantryItem({ name: 'Greek yogurt', section: 'dry' }), false);
  assert.equal(
    inferProbablyPantryItem({
      name: 'mustard',
      section: 'dry',
    }),
    false
  );
  assert.equal(
    inferProbablyPantryItem({
      name: 'oregano',
      section: 'other',
      sourceSection: 'spices_herbs',
      sourceListType: 'pantry',
    }),
    true
  );
});

test('ONE BRAIN: grocery normalization honors an explicit section and consults NO side-model', async () => {
  let modelCalled = false;
  const anthropic = {
    messages: { create: async () => { modelCalled = true; return { content: [] }; } },
  };

  // A brain-provided section is honored verbatim...
  const [explicit] = await normalizeGroceryItemsForPost(
    [{ name: 'cardamom', section: 'dry' }],
    { householdId: 1, getAnthropicClient: async () => ({ client: anthropic }), callSurface: 'kb_action', runtimeEnabled: true }
  );
  assert.equal(explicit.section, 'dry');

  // ...and an unsectioned item falls to the DETERMINISTIC bucket, never a model guess.
  const [fallback] = await normalizeGroceryItemsForPost(
    [{ name: 'cardamom', section: '' }],
    { householdId: 1, getAnthropicClient: async () => ({ client: anthropic }), callSurface: 'kb_action', runtimeEnabled: true }
  );
  assert.equal(fallback.section, 'other');
  assert.equal(modelCalled, false, 'section classification must not consult a side-model anymore');
});

test('grocery normalization deterministically files a refrigerated item (no model)', async () => {
  let modelCalled = false;
  const anthropic = {
    messages: { create: async () => { modelCalled = true; return { content: [] }; } },
  };

  const [item] = await normalizeGroceryItemsForPost(
    [{ name: 'Greek yogurt', section: '' }],
    { householdId: 1, getAnthropicClient: async () => ({ client: anthropic }), callSurface: 'kb_action', runtimeEnabled: true }
  );

  assert.equal(item.section, 'dairy');
  assert.equal(item.probablyPantryItem, false);
  assert.equal(modelCalled, false);
});

test('shared grocery normalization cleans recipe-derived names and classifies obvious shelf-stable ingredients sanely', async () => {
  const items = await normalizeGroceryItemsForPost(
    [
      { name: 'small white onion, diced', amount: '1', section: '' },
      { name: 'celery stalk, diced', amount: '1', section: '' },
      { name: 'garlic cloves, minced', amount: '3', section: '' },
      { name: 'chicken or vegetable stock', amount: '6 cups', section: '' },
      { name: 'artichoke hearts, drained', amount: '3 14-ounce jars', section: '' },
      { name: 'freshly-squeezed lemon juice', amount: '1/4 cup', section: '' },
      { name: 'dried thyme', amount: '1 tsp', section: '' },
    ],
    {
      householdId: 1,
      getAnthropicClient: async () => {
        throw new Error('no anthropic');
      },
      callSurface: 'kb_action',
      runtimeEnabled: true,
    }
  );

  const byName = new Map(items.map((item) => [item.name, item]));
  assert.equal(byName.get('white onion')?.section, 'produce');
  assert.equal(byName.get('celery')?.section, 'produce');
  assert.equal(byName.get('garlic')?.section, 'produce');
  assert.equal(byName.get('chicken or vegetable stock')?.section, 'dry');
  assert.equal(byName.get('artichoke hearts')?.section, 'dry');
  assert.equal(byName.get('lemons')?.section, 'produce');
  assert.equal(byName.get('dried thyme')?.section, 'dry');
});

test('mergeGroceryItemsFromAi updates matching rows and inserts new ones', async () => {
  const updates = [];
  const pantryFlagUpdates = [];
  const inserts = [];
  const stats = await mergeGroceryItemsFromAi({
    householdId: 1,
    parsedItems: [
      { name: 'Greek yogurt', section: 'dairy', amount: '2 tubs', probablyPantryItem: false },
      { name: 'spinach', section: 'produce', amount: '1 bag', probablyPantryItem: false },
      { name: 'bread flour', section: 'dry', amount: '1 bag', probablyPantryItem: true },
    ],
    sourceChatId: 22,
    getGroceryItems: async () => [
      { id: 7, name: 'Greek Yogurt', section: 'dairy', amount: '1 tub', checked: 0, probablyPantryItem: false },
      { id: 9, name: 'Bread Flour', section: 'dry', amount: '1 bag', checked: 0, probablyPantryItem: false },
    ],
    updateGroceryItemAmount: async (householdId, id, amount) => {
      updates.push({ householdId, id, amount });
    },
    updateGroceryItemProbablyPantry: async (householdId, id, probablyPantryItem) => {
      pantryFlagUpdates.push({ householdId, id, probablyPantryItem });
    },
    backfillGroceryItemSourceChatIfSafe: async () => 1,
    addGroceryItems: async (householdId, rows) => {
      inserts.push({ householdId, rows });
    },
  });

  assert.equal(stats.updatedCount, 1);
  assert.equal(stats.insertedCount, 1);
  assert.equal(stats.backfilledCount, 2);
  assert.deepEqual(updates, [{ householdId: 1, id: 7, amount: '2 tubs' }]);
  assert.deepEqual(pantryFlagUpdates, [{ householdId: 1, id: 9, probablyPantryItem: true }]);
  assert.deepEqual(inserts, [{ householdId: 1, rows: [{ name: 'spinach', section: 'produce', amount: '1 bag', probablyPantryItem: false }] }]);
});
