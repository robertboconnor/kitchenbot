import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeGroceryItemsFromAi,
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

test('mergeGroceryItemsFromAi updates matching rows and inserts new ones', async () => {
  const updates = [];
  const inserts = [];
  const stats = await mergeGroceryItemsFromAi({
    householdId: 1,
    parsedItems: [
      { name: 'Greek yogurt', section: 'dairy', amount: '2 tubs' },
      { name: 'spinach', section: 'produce', amount: '1 bag' },
    ],
    sourceChatId: 22,
    getGroceryItems: async () => [{ id: 7, name: 'Greek Yogurt', section: 'dairy', amount: '1 tub', checked: 0 }],
    updateGroceryItemAmount: async (householdId, id, amount) => {
      updates.push({ householdId, id, amount });
    },
    backfillGroceryItemSourceChatIfSafe: async () => 1,
    addGroceryItems: async (householdId, rows) => {
      inserts.push({ householdId, rows });
    },
  });

  assert.equal(stats.updatedCount, 1);
  assert.equal(stats.insertedCount, 1);
  assert.equal(stats.backfilledCount, 1);
  assert.deepEqual(updates, [{ householdId: 1, id: 7, amount: '2 tubs' }]);
  assert.deepEqual(inserts, [{ householdId: 1, rows: [{ name: 'spinach', section: 'produce', amount: '1 bag' }] }]);
});
