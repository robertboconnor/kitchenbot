// The shopping list and the pantry — two views over the same "inventory" idea, which is why they
// share the move-between-them helpers and live in one module.
//
// Owns its own state: the undo buffer for a just-deleted grocery item, and the set of in-flight
// move operations that stops a double-click moving the same item twice.

import { EVENTS, on } from './events.js';
import { isReadOnly } from './session.js';
import { loadCookbook } from './cookbook.js';

let lastDeletedGrocery = null;
let lastDeletedTimeout = null;
const inventoryMoveInFlightKeys = new Set();

// DOM handles, bound by initInventory() once the document exists, so the moved code below reads
// exactly as it did in app.js.
let groceryRefreshButton = null;
let groceryClearButton = null;
let groceryAddName = null;
let groceryAddAmount = null;
let groceryAddSection = null;
let groceryAddSubmit = null;
let pantryAddName = null;
let pantryAddAmount = null;
let pantryAddSection = null;
let pantryAddSubmit = null;
let groceryLists = {};
let pantryLists = {};

/** Read-only (God Mode impersonation) — local alias so moved code is untouched. */
function readOnlyNow() {
  return isReadOnly();
}

function inventoryMoveKey(kind, id) {
  return String(kind || '') + ':' + String(id ?? '');
}

function isInventoryMoveInFlight(kind, id) {
  return inventoryMoveInFlightKeys.has(inventoryMoveKey(kind, id));
}

function setInventoryMoveButtonState(button, {
  disabled = false,
  inFlight = false,
  idleText = '',
  workingText = 'Moving…',
  title = '',
} = {}) {
  if (!button) return;
  button.disabled = disabled || inFlight;
  button.textContent = inFlight ? workingText : idleText;
  button.title = inFlight ? workingText : title || idleText;
  button.classList.toggle('g-action-working', inFlight);
  button.setAttribute('aria-busy', inFlight ? 'true' : 'false');
}

export function setGroceryMoveToPantryReadyState(button, {
  checked = false,
  probablyPantryItem = false,
} = {}) {
  if (!button) return;
  button.classList.toggle('g-move-to-pantry-ready', !!checked && !!probablyPantryItem);
}

export async function loadGroceries() {
  try {
    const response = await fetch('/groceries');
    if (!response.ok) {
      return;
    }
    const data = await response.json();

    Object.values(groceryLists).forEach(list => {
      list.innerHTML = '';
    });

    for (const item of data.items || []) {
      const li = document.createElement('li');
      li.className = 'g-item' + (item.checked ? ' g-item-checked' : '');
      li.dataset.id = item.id;
      li.dataset.section = item.section;

      const left = document.createElement('div');
      left.className = 'g-left';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = !!item.checked;
      checkbox.disabled = readOnlyNow();
      const probablyPantryItem = item.probablyPantryItem === true || Number(item.probably_pantry_item) === 1;
      checkbox.addEventListener('change', async () => {
        li.classList.toggle('g-item-checked', checkbox.checked);
        setGroceryMoveToPantryReadyState(moveBtn, {
          checked: checkbox.checked,
          probablyPantryItem,
        });
        try {
          await fetch('/groceries/' + item.id, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ checked: checkbox.checked })
          });
        } catch (e) {}
      });
      left.appendChild(checkbox);

      const textContainer = document.createElement('div');
      textContainer.className = 'g-text-wrap';
      const main = document.createElement('div');
      main.className = 'g-text-main';
      main.textContent = item.name;
      const amount = document.createElement('div');
      amount.className = 'g-text-amount';
      amount.textContent = item.amount || '';
      textContainer.appendChild(main);
      if (item.amount) {
        textContainer.appendChild(amount);
      }

      left.appendChild(textContainer);

      li.appendChild(left);

      const actions = document.createElement('div');
      actions.className = 'g-actions';

      const moveBtn = document.createElement('button');
      moveBtn.className = 'g-delete g-move';
      setGroceryMoveToPantryReadyState(moveBtn, {
        checked: !!item.checked,
        probablyPantryItem,
      });
      setInventoryMoveButtonState(moveBtn, {
        disabled: readOnlyNow(),
        inFlight: isInventoryMoveInFlight('grocery', item.id),
        idleText: 'Move to pantry',
        workingText: 'Moving…',
        title: 'Move to Pantry',
      });
      moveBtn.addEventListener('click', async () => {
        const moveKey = inventoryMoveKey('grocery', item.id);
        if (readOnlyNow() || inventoryMoveInFlightKeys.has(moveKey)) return;
        inventoryMoveInFlightKeys.add(moveKey);
        setInventoryMoveButtonState(moveBtn, {
          disabled: readOnlyNow(),
          inFlight: true,
          idleText: 'Move to pantry',
          workingText: 'Moving…',
          title: 'Move to Pantry',
        });
        try {
          await fetch('/groceries/' + item.id + '/move-to-pantry', { method: 'POST' });
          await Promise.all([loadGroceries(), loadPantry()]);
        } catch (e) {
          setInventoryMoveButtonState(moveBtn, {
            disabled: readOnlyNow(),
            inFlight: false,
            idleText: 'Move to pantry',
            workingText: 'Moving…',
            title: 'Move to Pantry',
          });
        } finally {
          inventoryMoveInFlightKeys.delete(moveKey);
        }
      });
      actions.appendChild(moveBtn);

      const del = document.createElement('button');
      del.className = 'g-delete';
      del.textContent = '×';
      del.disabled = readOnlyNow();
      del.addEventListener('click', async () => {
        const removedItem = { ...item };
        li.remove();
        try {
          await fetch('/groceries/' + item.id, { method: 'DELETE' });
        } catch (e) {}

        if (lastDeletedTimeout) {
          clearTimeout(lastDeletedTimeout);
          lastDeletedTimeout = null;
        }
        lastDeletedGrocery = removedItem;

        let undoBar = document.getElementById('grocery-undo');
        if (!undoBar) {
          undoBar = document.createElement('div');
          undoBar.id = 'grocery-undo';
          undoBar.style.position = 'fixed';
          undoBar.style.bottom = '16px';
          undoBar.style.left = '50%';
          undoBar.style.transform = 'translateX(-50%)';
          undoBar.style.background = '#111827';
          undoBar.style.color = '#f9fafb';
          undoBar.style.padding = '6px 10px';
          undoBar.style.borderRadius = '999px';
          undoBar.style.fontSize = '12px';
          undoBar.style.display = 'flex';
          undoBar.style.alignItems = 'center';
          undoBar.style.gap = '6px';
          const textSpan = document.createElement('span');
          textSpan.textContent = 'Item deleted';
          const undoBtn = document.createElement('button');
          undoBtn.textContent = 'Undo';
          undoBtn.style.background = '#f9fafb';
          undoBtn.style.color = '#111827';
          undoBtn.style.borderRadius = '999px';
          undoBtn.style.border = 'none';
          undoBtn.style.fontSize = '12px';
          undoBtn.style.padding = '3px 8px';
          undoBtn.addEventListener('click', async () => {
            if (!lastDeletedGrocery) return;
            const toRestore = lastDeletedGrocery;
            lastDeletedGrocery = null;
            undoBar.remove();
            try {
              await fetch('/groceries', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items: [toRestore] }),
              });
              await loadGroceries();
            } catch (e) {}
          });
          undoBar.appendChild(textSpan);
          undoBar.appendChild(undoBtn);
          document.body.appendChild(undoBar);
        }

        lastDeletedTimeout = setTimeout(() => {
          const bar = document.getElementById('grocery-undo');
          if (bar) bar.remove();
          lastDeletedGrocery = null;
          lastDeletedTimeout = null;
        }, 3000);
      });
      actions.appendChild(del);
      li.appendChild(actions);

      const targetList = groceryLists[item.section] || groceryLists.other;
      targetList.appendChild(li);
    }

    groceryClearButton.style.display = isCurrentUserOwner ? '' : 'none';
  } catch (e) {
    // ignore for now
  }
}

export async function loadPantry() {
  try {
    const response = await fetch('/pantry');
    if (!response.ok) return;
    const data = await response.json();

    Object.values(pantryLists).forEach((list) => {
      list.innerHTML = '';
    });

    for (const item of data.items || []) {
      const li = document.createElement('li');
      li.className = 'g-item';
      li.dataset.id = item.id;
      li.dataset.section = item.section;

      const left = document.createElement('div');
      left.className = 'g-left';

      const textContainer = document.createElement('div');
      textContainer.className = 'g-text-wrap';
      const main = document.createElement('div');
      main.className = 'g-text-main';
      main.textContent = item.name;
      textContainer.appendChild(main);
      left.appendChild(textContainer);
      li.appendChild(left);

      const actions = document.createElement('div');
      actions.className = 'g-actions';

      const moveBtn = document.createElement('button');
      moveBtn.className = 'g-delete g-move';
      setInventoryMoveButtonState(moveBtn, {
        disabled: readOnlyNow(),
        inFlight: isInventoryMoveInFlight('pantry', item.id),
        idleText: 'Move to grocery',
        workingText: 'Moving…',
        title: 'Move to Grocery List',
      });
      moveBtn.addEventListener('click', async () => {
        const moveKey = inventoryMoveKey('pantry', item.id);
        if (readOnlyNow() || inventoryMoveInFlightKeys.has(moveKey)) return;
        inventoryMoveInFlightKeys.add(moveKey);
        setInventoryMoveButtonState(moveBtn, {
          disabled: readOnlyNow(),
          inFlight: true,
          idleText: 'Move to grocery',
          workingText: 'Moving…',
          title: 'Move to Grocery List',
        });
        try {
          await fetch('/pantry/' + item.id + '/move-to-groceries', { method: 'POST' });
          await Promise.all([loadPantry(), loadGroceries()]);
        } catch (e) {
          setInventoryMoveButtonState(moveBtn, {
            disabled: readOnlyNow(),
            inFlight: false,
            idleText: 'Move to grocery',
            workingText: 'Moving…',
            title: 'Move to Grocery List',
          });
        } finally {
          inventoryMoveInFlightKeys.delete(moveKey);
        }
      });
      actions.appendChild(moveBtn);

      const del = document.createElement('button');
      del.className = 'g-delete';
      del.textContent = '×';
      del.disabled = readOnlyNow();
      del.addEventListener('click', async () => {
        try {
          await fetch('/pantry/' + item.id, { method: 'DELETE' });
          await loadPantry();
        } catch (e) {}
      });
      actions.appendChild(del);
      li.appendChild(actions);

      const targetList = pantryLists[item.section] || pantryLists.other_pantry;
      targetList.appendChild(li);
    }
  } catch (e) {
    // ignore for now
  }
}

/** The list/pantry controls: add, refresh, and clear. */
function initInventoryUi() {
  groceryRefreshButton.addEventListener('click', async () => {
    await Promise.all([loadGroceries(), loadPantry(), loadCookbook()]);
  });

  if (groceryAddSubmit) {
    groceryAddSubmit.addEventListener('click', async () => {
      const name = groceryAddName && groceryAddName.value.trim();
      if (!name) return;
      const amount = groceryAddAmount && groceryAddAmount.value.trim();
      const section =
        groceryAddSection ? groceryAddSection.value : '';
      try {
        const r = await fetch('/groceries', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: [{ name, section, amount: amount || '' }],
          }),
        });
        if (!r.ok) return;
        if (groceryAddAmount) groceryAddAmount.value = '';
        if (groceryAddName) groceryAddName.value = '';
        if (groceryAddSection) groceryAddSection.value = '';
        await loadGroceries();
        if (groceryAddName) groceryAddName.focus();
      } catch (e) {}
    });
  }

  if (pantryAddSubmit) {
    pantryAddSubmit.addEventListener('click', async () => {
      const name = pantryAddName && pantryAddName.value.trim();
      if (!name) return;
      const amount = pantryAddAmount && pantryAddAmount.value.trim();
      const section =
        pantryAddSection && pantryAddSection.value ? pantryAddSection.value : 'other';
      try {
        const r = await fetch('/pantry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: [{ name, section, amount: amount || '' }],
          }),
        });
        if (!r.ok) return;
        if (pantryAddAmount) pantryAddAmount.value = '';
        if (pantryAddName) pantryAddName.value = '';
        if (pantryAddSection) pantryAddSection.value = '';
        await loadPantry();
        if (pantryAddName) pantryAddName.focus();
      } catch (e) {}
    });
  }

  groceryClearButton.addEventListener('click', async () => {
    if (!confirm('Clear entire grocery list?')) return;
    try {
      await fetch('/groceries/clear', { method: 'POST' });
      Object.values(groceryLists).forEach(list => {
        list.innerHTML = '';
      });
    } catch (e) {}
  });
}

/** Bind DOM handles and wire the inventory controls. Called once at startup. */
export function initInventory() {
  groceryRefreshButton = document.getElementById('grocery-refresh');
  groceryClearButton = document.getElementById('grocery-clear');
  groceryAddName = document.getElementById('grocery-add-name');
  groceryAddAmount = document.getElementById('grocery-add-amount');
  groceryAddSection = document.getElementById('grocery-add-section');
  groceryAddSubmit = document.getElementById('grocery-add-submit');
  pantryAddName = document.getElementById('pantry-add-name');
  pantryAddAmount = document.getElementById('pantry-add-amount');
  pantryAddSection = document.getElementById('pantry-add-section');
  pantryAddSubmit = document.getElementById('pantry-add-submit');
  groceryLists = {
    produce: document.getElementById('g-list-produce'),
    meat: document.getElementById('g-list-meat'),
    dairy: document.getElementById('g-list-dairy'),
    frozen: document.getElementById('g-list-frozen'),
    dry: document.getElementById('g-list-dry'),
    other: document.getElementById('g-list-other'),
  };
  pantryLists = {
    spices_herbs: document.getElementById('p-list-spices_herbs'),
    oils_vinegars: document.getElementById('p-list-oils_vinegars'),
    baking: document.getElementById('p-list-baking'),
    sweeteners: document.getElementById('p-list-sweeteners'),
    condiments_sauces: document.getElementById('p-list-condiments_sauces'),
    pasta_grains_dry_goods: document.getElementById('p-list-pasta_grains_dry_goods'),
    other_pantry: document.getElementById('p-list-other_pantry'),
  };
  initInventoryUi();
  // Re-render when the Kitchen shows one of these views, instead of navigation calling in.
  on(EVENTS.KITCHEN_VIEW_CHANGED, ({ view }) => {
    if (view === 'list') loadGroceries();
    if (view === 'pantry') loadPantry();
  });
}
