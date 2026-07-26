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

  for (const name of KITCHEN_VIEWS) {
    el(`grocery-subtab-${name}`)?.classList.toggle('settings-subtab-active', currentKitchenView === name);
    const panel = el(`grocery-subview-${name}`);
    if (panel) panel.style.display = currentKitchenView === name ? '' : 'none';
  }

  emit(EVENTS.KITCHEN_VIEW_CHANGED, { view: currentKitchenView });
}
