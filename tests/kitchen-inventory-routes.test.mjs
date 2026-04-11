import test from 'node:test';
import assert from 'node:assert/strict';

import { registerKitchenInventoryRoutes } from '../kitchen-inventory-routes.mjs';

function makeFakeApp() {
  const routes = { get: new Map(), post: new Map(), patch: new Map(), delete: new Map() };
  return {
    routes,
    get(path, ...handlers) { routes.get.set(path, handlers); },
    post(path, ...handlers) { routes.post.set(path, handlers); },
    patch(path, ...handlers) { routes.patch.set(path, handlers); },
    delete(path, ...handlers) { routes.delete.set(path, handlers); },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('inventory routes normalize manual grocery adds through the shared inventory service', async () => {
  const app = makeFakeApp();
  const calls = [];
  registerKitchenInventoryRoutes(app, {
    middleware: {
      requireHousehold() {},
      requireAuth() {},
      requireNotImpersonatingReadOnly() {},
      requireOwner() {},
    },
    db: {
      getGroceryItems: async () => [],
      getPantryItems: async () => [],
      addGroceryItems: async (householdId, items) => calls.push({ kind: 'addGroceryItems', householdId, items }),
      addPantryItems: async () => {},
      updateGroceryItem: async () => {},
      deleteGroceryItem: async () => {},
      deletePantryItem: async () => {},
      clearGroceryItems: async () => {},
      findPantryItemById: async () => null,
    },
    inventory: {
      normalizeGroceryItemsForPost: async (items, opts) => {
        calls.push({ kind: 'normalizeGrocery', items, opts });
        return [{ name: 'spinach', section: 'produce', amount: '1 bag' }];
      },
      normalizePantryItemsForPost: async () => [],
    },
  });

  const req = { householdId: 9, body: { items: [{ name: 'Spinach', section: '' }] }, params: {} };
  const res = makeRes();
  const handler = app.routes.post.get('/groceries').at(-1);
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls[0], {
    kind: 'normalizeGrocery',
    items: [{ name: 'Spinach', section: '' }],
    opts: { householdId: 9, callSurface: 'chat' },
  });
  assert.deepEqual(calls[1], {
    kind: 'addGroceryItems',
    householdId: 9,
    items: [{ name: 'spinach', section: 'produce', amount: '1 bag' }],
  });
});

test('grocery-to-pantry move reclassifies for the pantry target before insert', async () => {
  const app = makeFakeApp();
  const calls = [];
  registerKitchenInventoryRoutes(app, {
    middleware: {
      requireHousehold() {},
      requireAuth() {},
      requireNotImpersonatingReadOnly() {},
      requireOwner() {},
    },
    db: {
      getGroceryItems: async () => [{ id: 4, name: 'Rotini', amount: '1 box', section: 'dry' }],
      getPantryItems: async () => [],
      addGroceryItems: async () => {},
      addPantryItems: async (householdId, items) => calls.push({ kind: 'addPantryItems', householdId, items }),
      updateGroceryItem: async () => {},
      deleteGroceryItem: async (householdId, id) => calls.push({ kind: 'deleteGroceryItem', householdId, id }),
      deletePantryItem: async () => {},
      clearGroceryItems: async () => {},
      findPantryItemById: async () => null,
    },
    inventory: {
      normalizeGroceryItemsForPost: async () => [],
      normalizePantryItemsForPost: async (items, opts) => {
        calls.push({ kind: 'normalizePantry', items, opts });
        return [{ name: 'Rotini', section: 'pasta_grains_dry_goods', amount: '1 box' }];
      },
    },
  });

  const req = { householdId: 9, body: {}, params: { id: '4' } };
  const res = makeRes();
  const handler = app.routes.post.get('/groceries/:id/move-to-pantry').at(-1);
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls[0], {
    kind: 'normalizePantry',
    items: [{
      name: 'Rotini',
      section: '',
      amount: '1 box',
      sourceSection: 'dry',
      sourceListType: 'grocery',
    }],
    opts: { householdId: 9, callSurface: 'chat' },
  });
  assert.deepEqual(calls[1], {
    kind: 'addPantryItems',
    householdId: 9,
    items: [{ name: 'Rotini', section: 'pasta_grains_dry_goods', amount: '1 box' }],
  });
  assert.deepEqual(calls[2], { kind: 'deleteGroceryItem', householdId: 9, id: 4 });
});
