import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveInventoryItemMatch } from '../inventory-item-resolver.mjs';

test('inventory item resolver handles a unique near-match safely', () => {
  const result = resolveInventoryItemMatch(
    [{ id: 1, name: 'Rotini pasta', amount: '1 box', section: 'dry' }],
    'rotini'
  );

  assert.equal(result.status, 'found');
  assert.equal(result.item.id, 1);
});

test('inventory item resolver returns ambiguous instead of guessing', () => {
  const result = resolveInventoryItemMatch(
    [
      { id: 1, name: 'Greek yogurt', amount: '1 tub', section: 'dairy' },
      { id: 2, name: 'Labneh or Greek yogurt', amount: '1 container', section: 'dairy' },
    ],
    'yogurt'
  );

  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(
    result.matches.map((item) => item.id),
    [1, 2]
  );
});

test('inventory item resolver matches parmesan to parmesan cheese safely', () => {
  const result = resolveInventoryItemMatch(
    [{ id: 1, name: 'Parmesan cheese', amount: '1 wedge', section: 'dairy' }],
    'parmesan'
  );

  assert.equal(result.status, 'found');
  assert.equal(result.item.id, 1);
});

test('inventory item resolver keeps parmesan variants ambiguous instead of guessing', () => {
  const result = resolveInventoryItemMatch(
    [
      { id: 1, name: 'Parmesan cheese', amount: '1 wedge', section: 'dairy' },
      { id: 2, name: 'Grated parmesan cheese', amount: '1 tub', section: 'dairy' },
    ],
    'parmesan'
  );

  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(
    result.matches.map((item) => item.id),
    [1, 2]
  );
});
