// KitchenBot's composition root.
//
// This file used to be the whole client — 4,993 lines in one global scope, ~254 getElementById
// lookups and no boundaries. It is now the only place allowed to know about every feature at once,
// and its whole job is: build the pieces, wire the handful of things that genuinely span them, and
// start.
//
// Everything else lives in ./modules/*. Features own their own state and talk through the event bus
// (./modules/events.js) rather than reaching into each other. Two exceptions are deliberate and
// live here, because they are genuinely cross-feature sequences rather than one feature's business:
// re-hydrating after an identity change, and signing out.

import { EVENTS, on as onAppEvent } from './modules/events.js';
import { applyMe as applySession, clearSession } from './modules/session.js';
import { checkAuth, initAuth, showApp, showLogin } from './modules/auth.js';
import {
  initNavigation,
  isCookbookHash,
  reapplyVisibleAppTab,
  setActiveTab,
  setKitchenView,
} from './modules/navigation.js';
import { initPalette } from './modules/palette.js';
import {
  initChat,
  refreshRealtimeChatView,
  resetChatSession,
  startChatSession,
  teardownRealtimeUi,
} from './modules/chat.js';
import { clearStickySettingsMessages, initSettings } from './modules/settings.js';
import { applyGodModeFromMe, initAdmin } from './modules/admin.js';
import { initPlan } from './modules/plan.js';
import { initInventory } from './modules/inventory.js';
import { initCookbook, loadCookbook, resetCookbook } from './modules/cookbook.js';
import { initAttachments } from './modules/attachments.js';

/**
 * Bring the app up as a signed-in household. Runs on first load, after a successful login, and
 * after God Mode enters or leaves impersonation — every path that changes who the app thinks
 * you are announces REHYDRATE_APP and lands here.
 */
async function rehydrateAuthenticatedApp(meData, opts = {}) {
  const forceChatTab = opts.forceChatTab !== false;
  const resetSessionView = opts.resetSessionView !== false;
  teardownRealtimeUi();
  if (resetSessionView) resetChatSession();
  applyGodModeFromMe(meData);
  // Publish identity for the feature modules; palette, chat et al. react to SESSION_CHANGED.
  // owner/member distinction removed — everyone in a household is an owner.
  applySession({ ...meData, displayName: meData.name, isOwner: true });
  showApp();

  // A #cookbook deep link wins over the default tab, and is re-asserted after the chat loads
  // because opening a conversation switches to the chat tab on its way through.
  const shouldOpenCookbookFromHash = isCookbookHash();
  if (shouldOpenCookbookFromHash) {
    setActiveTab('groceries');
    setKitchenView('cookbook');
  } else if (forceChatTab) {
    setActiveTab('chat');
  }
  await startChatSession();
  if (shouldOpenCookbookFromHash) {
    setActiveTab('groceries');
    setKitchenView('cookbook');
    await loadCookbook();
  }
}

/** Signing out spans every feature, so the shell coordinates it rather than any one module. */
async function signOut() {
  try {
    await fetch('/logout', { method: 'POST' });
  } catch (e) {
    // ignore errors, just force login state
  }
  teardownRealtimeUi();
  resetChatSession();
  // Session owns identity + the read-only flag; clearing it announces the change, which is what
  // makes chat blank its speaker label and every feature drop back to signed-out state.
  clearSession();
  applyGodModeFromMe({ isImpersonating: false, impersonationReadOnly: false });
  resetCookbook();
  showLogin();
}

// --- build the features -------------------------------------------------------------------
// Order matters only in that every module must have bound its DOM handles before anything can
// trigger work in it, which is why checkAuth() is the last line of this file rather than an
// earlier one that happened to win the race.
initPalette();
initNavigation();
initAuth();
initChat();
initSettings();
initAdmin();
initPlan();
initInventory();
initCookbook();
initAttachments();

// --- wire the things that genuinely span features ------------------------------------------

onAppEvent(EVENTS.SESSION_EXPIRED, () => showLogin());
onAppEvent(EVENTS.REHYDRATE_APP, ({ me, options }) => {
  rehydrateAuthenticatedApp(me, options || {}).catch((e) =>
    console.error('Re-hydration after identity change failed:', e)
  );
});

const logoutButton = document.getElementById('logout');
if (logoutButton) {
  logoutButton.addEventListener('click', () => {
    signOut().catch((e) => console.error('Sign-out failed:', e));
  });
}

// Any click on an interactive control anywhere clears settings' sticky "Saved."-style messages, so
// they never linger into an unrelated part of the app. Capture phase, so it runs before handlers
// that might set a fresh message.
document.addEventListener(
  'click',
  (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const actionable = target.closest(
      'button, a, select, summary, [role="button"], input[type="checkbox"], input[type="radio"]'
    );
    if (!actionable) return;
    clearStickySettingsMessages();
  },
  true
);

// iOS restores a bfcache page with the DOM intact but our in-memory state reset, so re-assert the
// visible tab and re-establish the realtime connection whenever the page is shown again.
window.addEventListener('pageshow', () => {
  reapplyVisibleAppTab();
  void refreshRealtimeChatView();
});

// --- go ------------------------------------------------------------------------------------
checkAuth();
