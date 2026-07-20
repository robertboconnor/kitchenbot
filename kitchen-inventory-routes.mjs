import { enrichMealsWithRecipeLinks } from './mealplan-executor.mjs';

export function registerKitchenInventoryRoutes(app, deps) {
  const {
    middleware,
    db,
    inventory,
  } = deps;
  const { requireHousehold, requireAuth, requireNotImpersonatingReadOnly, requireOwner } = middleware;
  const {
    getGroceryItems,
    getPantryItems,
    addGroceryItems,
    addPantryItems,
    updateGroceryItem,
    deleteGroceryItem,
    deletePantryItem,
    clearGroceryItems,
    findPantryItemById,
    getMealPlanItems,
    updateMealPlanItem,
    deleteMealPlanItem,
  } = db;
  const { normalizeGroceryItemsForPost, normalizePantryItemsForPost } = inventory;

  app.get('/groceries', requireHousehold, requireAuth, async (req, res) => {
    try {
      const items = await getGroceryItems(req.householdId);
      res.json({ items });
    } catch (error) {
      console.error(error);
      res.status(500).json({ items: [] });
    }
  });

  app.get('/pantry', requireHousehold, requireAuth, async (req, res) => {
    try {
      const items = await getPantryItems(req.householdId);
      res.json({ items });
    } catch (error) {
      console.error(error);
      res.status(500).json({ items: [] });
    }
  });

  // This Week's Plan — scoped to a chat (= a week). chatId comes from the client's current chat.
  app.get('/plan', requireHousehold, requireAuth, async (req, res) => {
    try {
      const chatId = Number(req.query.chatId);
      if (!Number.isFinite(chatId)) {
        return res.json({ items: [] });
      }
      const rawItems = await getMealPlanItems(req.householdId, chatId);
      const items = await enrichMealsWithRecipeLinks(req.householdId, rawItems);
      res.json({ items });
    } catch (error) {
      console.error(error);
      res.status(500).json({ items: [] });
    }
  });

  app.patch('/plan/:id', requireHousehold, requireAuth, requireNotImpersonatingReadOnly, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const chatId = Number(req.body.chatId);
      if (!Number.isFinite(id) || !Number.isFinite(chatId)) {
        return res.status(400).json({ error: 'Invalid id or chatId.' });
      }
      const fields = {};
      if (req.body.status === 'cooked' || req.body.status === 'planned') fields.status = req.body.status;
      if (typeof req.body.cooked === 'boolean') fields.status = req.body.cooked ? 'cooked' : 'planned';
      if (Object.keys(fields).length === 0) {
        return res.status(400).json({ error: 'Nothing to update.' });
      }
      await updateMealPlanItem(req.householdId, chatId, id, fields);
      res.json({ ok: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false });
    }
  });

  app.delete('/plan/:id', requireHousehold, requireAuth, requireNotImpersonatingReadOnly, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const chatId = Number(req.query.chatId);
      if (!Number.isFinite(id) || !Number.isFinite(chatId)) {
        return res.status(400).json({ error: 'Invalid id or chatId.' });
      }
      await deleteMealPlanItem(req.householdId, chatId, id);
      res.json({ ok: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false });
    }
  });

  app.post('/pantry', requireHousehold, requireAuth, requireNotImpersonatingReadOnly, async (req, res) => {
    try {
      const normalized = await normalizePantryItemsForPost(req.body.items, {
        householdId: req.householdId,
        callSurface: 'chat',
      });
      if (normalized.length === 0) {
        return res.status(400).json({ error: 'No valid items. Each item needs a non-empty name.' });
      }
      await addPantryItems(req.householdId, normalized);
      res.json({ ok: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false });
    }
  });

  app.post('/groceries', requireHousehold, requireAuth, requireNotImpersonatingReadOnly, async (req, res) => {
    try {
      const normalized = await normalizeGroceryItemsForPost(req.body.items, {
        householdId: req.householdId,
        callSurface: 'chat',
      });
      if (normalized.length === 0) {
        return res.status(400).json({ error: 'No valid items. Each item needs a non-empty name.' });
      }
      await addGroceryItems(req.householdId, normalized);
      res.json({ ok: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false });
    }
  });

  app.patch('/groceries/:id', requireHousehold, requireAuth, requireNotImpersonatingReadOnly, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { checked } = req.body;
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: 'Invalid id.' });
      }
      await updateGroceryItem(req.householdId, id, { checked: !!checked });
      res.json({ ok: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false });
    }
  });

  app.delete('/groceries/:id', requireHousehold, requireAuth, requireNotImpersonatingReadOnly, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: 'Invalid id.' });
      }
      await deleteGroceryItem(req.householdId, id);
      res.json({ ok: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false });
    }
  });

  app.post('/pantry/:id/move-to-groceries', requireHousehold, requireAuth, requireNotImpersonatingReadOnly, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: 'Invalid id.' });
      }
      const pantryItem = await findPantryItemById(req.householdId, id);
      if (!pantryItem) {
        return res.status(404).json({ error: 'Pantry item not found.' });
      }
      const [resolvedItem] = await normalizeGroceryItemsForPost([{
        name: pantryItem.name,
        section: '',
        amount: pantryItem.amount,
        sourceSection: pantryItem.section,
        sourceListType: 'pantry',
        probablyPantryItem: true,
      }], {
        householdId: req.householdId,
        callSurface: 'chat',
      });
      await addGroceryItems(req.householdId, [resolvedItem]);
      await deletePantryItem(req.householdId, id);
      res.json({ ok: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false });
    }
  });

  app.post('/groceries/:id/move-to-pantry', requireHousehold, requireAuth, requireNotImpersonatingReadOnly, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: 'Invalid id.' });
      }
      const groceryItem = (await getGroceryItems(req.householdId)).find((item) => Number(item.id) === id);
      if (!groceryItem) {
        return res.status(404).json({ error: 'Grocery item not found.' });
      }
      const [resolvedItem] = await normalizePantryItemsForPost([{
        name: groceryItem.name,
        section: '',
        amount: groceryItem.amount,
        sourceSection: groceryItem.section,
        sourceListType: 'grocery',
      }], {
        householdId: req.householdId,
        callSurface: 'chat',
      });
      await addPantryItems(req.householdId, [resolvedItem]);
      await deleteGroceryItem(req.householdId, id);
      res.json({ ok: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false });
    }
  });

  app.delete('/pantry/:id', requireHousehold, requireAuth, requireNotImpersonatingReadOnly, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: 'Invalid id.' });
      }
      await deletePantryItem(req.householdId, id);
      res.json({ ok: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false });
    }
  });

  app.post('/groceries/clear', requireHousehold, requireAuth, requireNotImpersonatingReadOnly, requireOwner, async (req, res) => {
    try {
      await clearGroceryItems(req.householdId);
      res.json({ ok: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false });
    }
  });
}
