import test from 'node:test';
import assert from 'node:assert/strict';

import {
  inferProbablyPantryItem,
  mergeGroceryItemsFromAi,
  normalizeGroceryItemsForPost,
  normalizeInventoryNameKey,
} from '../inventory-service.mjs';
import { resolveInventoryItems } from '../inventory-classification.mjs';

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

test('shared grocery normalization can mark pantry-ish dry goods beyond the narrow fallback keyword list', async () => {
  const anthropic = {
    messages: {
      create: async () => ({
        model: 'claude-haiku-4-5-20251001',
        usage: { input_tokens: 12, output_tokens: 20 },
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              items: [{ index: 0, section: 'dry', probablyPantryItem: true }],
            }),
          },
        ],
      }),
    },
  };

  const [item] = await normalizeGroceryItemsForPost(
    [{ name: 'cardamom', section: '' }],
    {
      householdId: 1,
      getAnthropicClient: async () => ({ client: anthropic }),
      callSurface: 'kb_action',
      runtimeEnabled: true,
    }
  );

  assert.equal(item.section, 'dry');
  assert.equal(item.probablyPantryItem, true);
});

test('shared grocery normalization still vetoes usually refrigerated items', async () => {
  const anthropic = {
    messages: {
      create: async () => ({
        model: 'claude-haiku-4-5-20251001',
        usage: { input_tokens: 12, output_tokens: 20 },
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              items: [{ index: 0, section: 'dry', probablyPantryItem: true }],
            }),
          },
        ],
      }),
    },
  };

  const [item] = await normalizeGroceryItemsForPost(
    [{ name: 'Greek yogurt', section: '' }],
    {
      householdId: 1,
      getAnthropicClient: async () => ({ client: anthropic }),
      callSurface: 'kb_action',
      runtimeEnabled: true,
    }
  );

  assert.equal(item.section, 'dry');
  assert.equal(item.probablyPantryItem, false);
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
