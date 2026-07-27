// Tab and Kitchen sub-view navigation.
//
// The keystone of the split. Navigation used to CALL directly into settings (loadSettingsPanel),
// the meal plan (renderThisWeekStrip, loadThisWeek) and the cookbook (syncCookbookWorkspaceLayout),
// which made it impossible to extract any of them without dragging the others along.
//
// Now it only announces where the user went. Features subscribe to TAB_CHANGED /
// KITCHEN_VIEW_CHANGED and do their own work, so navigation depends on nothing and each feature
// can be extracted independently.

import { EVENTS, emit } from './events.js';

const KITCHEN_SECTION_STORAGE_KEY = 'kb_kitchen_active_section';
const KITCHEN_VIEWS = ['list', 'pantry', 'cookbook', 'thisweek'];
const DEFAULT_KITCHEN_VIEW = 'cookbook';

let currentKitchenView = readKitchenSectionPreference();

const el = (id) => document.getElementById(id);

export function readKitchenSectionPreference() {
  try {
    const saved = sessionStorage.getItem(KITCHEN_SECTION_STORAGE_KEY);
    return KITCHEN_VIEWS.includes(saved) ? saved : DEFAULT_KITCHEN_VIEW;
  } catch (error) {
    return DEFAULT_KITCHEN_VIEW;
  }
}

function persistKitchenSectionPreference(value) {
  try {
    sessionStorage.setItem(KITCHEN_SECTION_STORAGE_KEY, value);
  } catch (error) {
    /* storage unavailable — the choice still applies for this page */
  }
}

export function getKitchenView() {
  return currentKitchenView;
}

/** True when the URL points at the cookbook (deep links like #cookbook/12). */
export function isCookbookHash() {
  return /^#cookbook(?:\/\d+)?$/i.test(String(window.location.hash || ''));
}

/**
 * Drop a #cookbook deep link once the user has navigated somewhere else.
 *
 * The hash is an instruction for where to OPEN, not a permanent statement of where you are — but
 * reapplyVisibleAppTab() reads it as the latter, and runs on every pageshow. Android fires a
 * pageshow each time you return to the app, so a stale #cookbook would silently drag you off chat
 * (and take the composer with it) minutes after you left the cookbook. The importer's
 * "Back to KitchenBot" link points at /#cookbook, which is how you end up with a sticky one.
 *
 * replaceState, so this leaves no history entry and fires no hashchange — the cookbook's own
 * deep-link handling is untouched.
 */
function clearCookbookHash() {
  if (!isCookbookHash()) return;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}

export function setActiveTab(tab) {
  el('tab-chat')?.classList.toggle('tab-active', tab === 'chat');
  el('tab-groceries')?.classList.toggle('tab-active', tab === 'groceries');
  el('tab-settings')?.classList.toggle('tab-active', tab === 'settings');

  const chat = el('chat');
  const groceryPanel = el('grocery-panel');
  const settingsPanel = el('settings-panel');
  const inputArea = el('input-area');
  if (chat) chat.style.display = tab === 'chat' ? 'flex' : 'none';
  if (groceryPanel) groceryPanel.style.display = tab === 'groceries' ? 'flex' : 'none';
  if (settingsPanel) settingsPanel.style.display = tab === 'settings' ? 'flex' : 'none';
  if (inputArea) inputArea.style.display = tab === 'chat' ? 'flex' : 'none';

  // Re-assert the sub-view so the Kitchen panel is never shown in a stale state.
  if (tab === 'groceries') setKitchenView(currentKitchenView);
  else clearCookbookHash();
  // The This Week strip belongs to chat; hide it everywhere else. The plan feature decides
  // whether to render it when it hears TAB_CHANGED.
  if (tab !== 'chat') {
    const strip = el('thisweek-strip');
    if (strip) strip.style.display = 'none';
  }

  emit(EVENTS.TAB_CHANGED, { tab });
}

export function setKitchenView(view) {
  currentKitchenView = KITCHEN_VIEWS.includes(view) ? view : 'list';
  persistKitchenSectionPreference(currentKitchenView);
  if (currentKitchenView !== 'cookbook') clearCookbookHash();

  for (const name of KITCHEN_VIEWS) {
    el(`grocery-subtab-${name}`)?.classList.toggle('settings-subtab-active', currentKitchenView === name);
    const panel = el(`grocery-subview-${name}`);
    if (panel) panel.style.display = currentKitchenView === name ? '' : 'none';
  }

  emit(EVENTS.KITCHEN_VIEW_CHANGED, { view: currentKitchenView });
}

/**
 * Restore whichever tab was on screen. Called on pageshow, because iOS restores a bfcache page
 * with the DOM intact but our in-memory notion of "current tab" reset. Reads the panels' own
 * visibility rather than borrowing a handle from settings or the kitchen.
 */
export function reapplyVisibleAppTab() {
  const appArea = document.getElementById('app');
  if (!appArea || appArea.style.display === 'none') return;
  if (isCookbookHash()) {
    setActiveTab('groceries');
    setKitchenView('cookbook');
    return;
  }
  const settingsPanel = document.getElementById('settings-panel');
  if (settingsPanel && settingsPanel.style.display === 'flex') {
    setActiveTab('settings');
    return;
  }
  const groceryPanel = document.getElementById('grocery-panel');
  const tabGroceries = document.getElementById('tab-groceries');
  if (
    (groceryPanel && groceryPanel.style.display === 'flex') ||
    (tabGroceries && tabGroceries.classList.contains('tab-active'))
  ) {
    setActiveTab('groceries');
    return;
  }
  setActiveTab('chat');
}

/**
 * Wire the tab bar and the Kitchen sub-tabs. These buttons only ever change where you are, so they
 * live with the thing that owns "where you are" — features react to TAB_CHANGED / KITCHEN_VIEW_CHANGED.
 * The data loads that used to sit inline here now hang off those events in the feature modules.
 */
export function initNavigation() {
  const tabChat = document.getElementById('tab-chat');
  const tabGroceries = document.getElementById('tab-groceries');
  const tabSettings = document.getElementById('tab-settings');
  const grocerySubtabList = document.getElementById('grocery-subtab-list');
  const grocerySubtabPantry = document.getElementById('grocery-subtab-pantry');
  const grocerySubtabCookbook = document.getElementById('grocery-subtab-cookbook');
  const grocerySubtabThisweek = document.getElementById('grocery-subtab-thisweek');

  if (tabChat) tabChat.addEventListener('click', () => setActiveTab('chat'));
  if (tabGroceries) tabGroceries.addEventListener('click', () => setActiveTab('groceries'));
  if (tabSettings) tabSettings.addEventListener('click', () => setActiveTab('settings'));
  if (grocerySubtabList) grocerySubtabList.addEventListener('click', () => setKitchenView('list'));
  if (grocerySubtabPantry) grocerySubtabPantry.addEventListener('click', () => setKitchenView('pantry'));
  if (grocerySubtabCookbook) grocerySubtabCookbook.addEventListener('click', () => setKitchenView('cookbook'));
  if (grocerySubtabThisweek) grocerySubtabThisweek.addEventListener('click', () => setKitchenView('thisweek'));
}
