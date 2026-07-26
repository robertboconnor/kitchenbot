import { COOKBOOK_CATEGORY_OPTIONS, KB_BOOT } from './modules/boot-data.js';
import { isMobile, useMobileEnterBehavior } from './modules/device.js';
import { initInventory, loadGroceries, loadPantry, setGroceryMoveToPantryReadyState } from './modules/inventory.js';
import { initPlan, loadThisWeek, renderThisWeekStrip } from './modules/plan.js';
import {
  clearHouseholdDefaultsUiMessage,
  clearSettingsUiMessage,
  clearStickySettingsMessages,
  initSettings,
  loadFamilyProfiles,
  loadHouseholdDefaultsEditor,
  loadMyHouseholdView,
  loadSettingsPanel,
  rebuildDisplayNameToColorFromSettingsUsers,
  setSettingsUiMessage,
  showSettingsSubView,
} from './modules/settings.js';
import {
  applyGodModeFromMe,
  initAdmin,
  initializeAdminUsageFilters,
  loadAdminAnthropicForSelected,
  refreshAdminHouseholdsList,
  refreshAdminUsageReport,
  updateAdminAnthropicFormVisibility,

  initializeOwnerUsageFilters,
  loadGlobalAdminView,
  refreshOwnerAnthropicUsageReport,
  refreshOwnerAnthropicUsageView,
  renderAnthropicUsageReportInto,
} from './modules/admin.js';
import {
  applyMe as applySession,
  clearSession,
  getRawMe,
  isReadOnly,
  mapServerReadOnlyErrorMessage,
  userMessageBubbleClass,
} from './modules/session.js';
import { initPalette } from './modules/palette.js';
import {
  getKitchenView,
  isCookbookHash,
  readKitchenSectionPreference,
  setActiveTab,
  setKitchenView,
} from './modules/navigation.js';
import { EVENTS, emit as emitAppEvent, on as onAppEvent } from './modules/events.js';
import {
  initCookbook,
  loadCookbook,
  openCookbookDetail,
  parseCookbookDetailHash,
  resetCookbook,
  populateCookbookCategoryControls,
  renderCookbook,
  syncCookbookWorkspaceLayout,
} from './modules/cookbook.js';
import {
  clearPendingAttachment,
  getPendingAttachment,
  initAttachments,
} from './modules/attachments.js';
import {
  buildCookbookSearchFields,
  cookbookDetailHash,
  formatCookbookBullets,
  formatCookbookCategoryLabel,
  getCookbookCardMetaText,
  getCookbookCardSummary,
  getCookbookDisplayProvenance,
  getCookbookDisplaySource,
  getCookbookDisplayTitle,
  getCookbookProvenanceLabel,
  getCookbookSourceDisplay,
  normalizeCookbookDisplayTitleKey,
  normalizeCookbookDisplayTitleText,
  normalizeCookbookDisplayUrl,
  normalizeCookbookSearchText,
  safeCookbookTrim,
  sanitizeCookbookDisplaySourceTitle,
  sanitizeCookbookDisplayTitle,
  scoreCookbookSearchMatch,
  splitCookbookEditorLines,
  stripCookbookDisplayMarkdown,
  tokenizeCookbookSearch,
} from './modules/cookbook-display.js';
const loginArea = document.getElementById('login-area');
const appArea = document.getElementById('app');
const loginHouseholdKeyInput = document.getElementById('login-household-key');
const loginFindHouseholdButton = document.getElementById('login-find-household');
const loginNameSelect = document.getElementById('login-name');
const loginPasswordInput = document.getElementById('login-password');
const loginButton = document.getElementById('login-button');
const loginAuthForm = document.getElementById('login-auth-form');
const loginStatus = document.getElementById('login-status');
const speakerName = document.getElementById('speaker-name');
const menuButton = document.getElementById('menu-button');
const sidebar = document.getElementById('sidebar');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');
const chatListEl = document.getElementById('chat-list');
const newChatButton = document.getElementById('new-chat');
const chat = document.getElementById('chat');
const groceryPanel = document.getElementById('grocery-panel');
const tabChat = document.getElementById('tab-chat');
const tabGroceries = document.getElementById('tab-groceries');
const tabSettings = document.getElementById('tab-settings');
const inputArea = document.getElementById('input-area');
const grocerySubtabList = document.getElementById('grocery-subtab-list');
const grocerySubtabPantry = document.getElementById('grocery-subtab-pantry');
const grocerySubtabCookbook = document.getElementById('grocery-subtab-cookbook');
const grocerySubviewList = document.getElementById('grocery-subview-list');
const grocerySubviewPantry = document.getElementById('grocery-subview-pantry');
const grocerySubviewCookbook = document.getElementById('grocery-subview-cookbook');
const grocerySubtabThisweek = document.getElementById('grocery-subtab-thisweek');
const grocerySubviewThisweek = document.getElementById('grocery-subview-thisweek');
const promptInput = document.getElementById('prompt');
const sendButton = document.getElementById('send');
const logoutButton = document.getElementById('logout');
const typingIndicator = document.getElementById('typing-indicator');
const chatNewMessageButton = document.getElementById('chat-new-message');


let currentChatId = null;

/**
 * Change the active chat and announce it. Features that care about which chat is open (the meal
 * plan, and later anything else) listen for CHAT_CHANGED rather than reading this variable.
 */
function setCurrentChatId(id) {
  if (currentChatId === id) return;
  currentChatId = id;
  emitAppEvent(EVENTS.CHAT_CHANGED, { chatId: id });
}
let currentUserName = null;
let currentHouseholdId = null;
let currentUserId = null;
let currentAssistantName = 'KitchenBot';
let isCurrentUserOwner = false;
let loadHistoryRequestSeq = 0;
let chatsCache = [];
/** Last persisted message count from /history per chat (DB rows only). */
const lastPersistedMessageCountByChatId = new Map();
/**
 * Sender-only ephemeral !command turns (session memory): merged after each loadHistory.
 * anchor = persisted row count when the exchange happened; seq = stable order for same anchor.
 */
const ephemeralExchangesByChatId = new Map();
const nextEphemeralSeqByChatId = new Map();


/** @returns {'God mode' | 'Demo mode' | 'Read-only mode'} */


/** Maps server 403 God Mode copy to Demo Mode when the session is read-only Demo impersonation. */


let typingWs = null;
const typingUsers = new Set();
let typingStopTimeout = null;
let weAreStreamingThisChat = false;
let remoteStreamBodyEl = null;
let remoteStreamTurnId = null;
let remoteStreamHasStarted = false;
let typingReconnectTimeout = null;
let hasUnreadIncomingChatContent = false;

const headerEl = document.getElementById('header');

function formatTypingText(users) {
  const arr = Array.from(users).filter(u => u && u !== currentUserName);
  if (arr.length === 0) return '';
  if (arr.length === 1) return arr[0] + ' is typing…';
  if (arr.length === 2) return arr[0] + ' and ' + arr[1] + ' are typing…';
  return arr.slice(0, -1).join(', ') + ', and ' + arr[arr.length - 1] + ' are typing…';
}

function updateTypingIndicator() {
  if (chat.style.display === 'none') {
    typingIndicator.textContent = '';
    return;
  }
  typingIndicator.textContent = formatTypingText(typingUsers);
}

function getChatBottomOffset() {
  return Math.max(0, chat.scrollHeight - chat.scrollTop - chat.clientHeight);
}

function isChatNearBottom(threshold = 72) {
  return getChatBottomOffset() <= threshold;
}

function restoreChatScrollFromBottom(bottomOffset) {
  const nextTop = chat.scrollHeight - chat.clientHeight - Math.max(0, Number(bottomOffset) || 0);
  chat.scrollTop = Math.max(0, nextTop);
}

function hideNewMessageIndicator() {
  hasUnreadIncomingChatContent = false;
  if (chatNewMessageButton) chatNewMessageButton.style.display = 'none';
}

function showNewMessageIndicator() {
  hasUnreadIncomingChatContent = true;
  if (chatNewMessageButton && chat.style.display !== 'none') {
    chatNewMessageButton.style.display = 'inline-flex';
  }
}

function syncNewMessageIndicatorWithScroll() {
  if (isChatNearBottom()) {
    hideNewMessageIndicator();
  } else if (hasUnreadIncomingChatContent && chatNewMessageButton && chat.style.display !== 'none') {
    chatNewMessageButton.style.display = 'inline-flex';
  }
}

function scheduleRealtimeReconnect(delayMs = 1200) {
  if (typingReconnectTimeout) clearTimeout(typingReconnectTimeout);
  if (!currentUserName || currentHouseholdId == null || currentUserId == null) return;
  typingReconnectTimeout = setTimeout(async () => {
    typingReconnectTimeout = null;
    if (!typingWs && currentUserName && currentHouseholdId != null && currentUserId != null) {
      connectTypingWs();
    }
    if (document.visibilityState === 'visible' && currentChatId != null && !weAreStreamingThisChat) {
      try {
        await loadHistory({ preserveViewport: true });
      } catch (e) {}
    }
  }, delayMs);
}

function teardownRealtimeUi() {
  if (typingWs) {
    typingWs.close();
    typingWs = null;
  }
  typingUsers.clear();
  typingIndicator.textContent = '';
  if (typingStopTimeout) clearTimeout(typingStopTimeout);
  typingStopTimeout = null;
  if (typingReconnectTimeout) clearTimeout(typingReconnectTimeout);
  typingReconnectTimeout = null;
  remoteStreamBodyEl = null;
  remoteStreamTurnId = null;
  remoteStreamHasStarted = false;
  weAreStreamingThisChat = false;
  hideNewMessageIndicator();
}

function resetTransientAssistantBubble() {
  remoteStreamBodyEl = null;
  remoteStreamTurnId = null;
  remoteStreamHasStarted = false;
}

function ensureTransientAssistantBubble(turnId = null) {
  const shouldStickToBottom = isChatNearBottom();
  const normalizedTurnId = turnId != null ? String(turnId) : null;
  const turnMismatch =
    normalizedTurnId &&
    remoteStreamTurnId &&
    normalizedTurnId !== remoteStreamTurnId;
  if (!remoteStreamBodyEl || turnMismatch) {
    const wrap = document.createElement('div');
    wrap.className = 'message assistant';
    const author = document.createElement('span');
    author.className = 'message-author';
    author.textContent = currentAssistantName || 'KitchenBot';
    wrap.appendChild(author);
    const body = document.createElement('div');
    body.className = 'message-body kb-thinking kb-thinking-anim';
    wrap.appendChild(body);
    chat.appendChild(wrap);
    remoteStreamBodyEl = body;
    remoteStreamHasStarted = false;
  }
  if (normalizedTurnId && !remoteStreamTurnId) {
    remoteStreamTurnId = normalizedTurnId;
  } else if (turnMismatch) {
    remoteStreamTurnId = normalizedTurnId;
  }
  if (shouldStickToBottom) chat.scrollTop = chat.scrollHeight;
  return { shouldStickToBottom };
}

function setTransientAssistantProgress(text, turnId = null) {
  if (!text) return;
  const { shouldStickToBottom } = ensureTransientAssistantBubble(turnId);
  const normalizedTurnId = turnId != null ? String(turnId) : null;
  if (remoteStreamHasStarted && (!normalizedTurnId || normalizedTurnId === remoteStreamTurnId)) {
    return;
  }
  remoteStreamBodyEl.classList.add('kb-thinking', 'kb-thinking-anim');
  remoteStreamBodyEl.textContent = text;
  if (shouldStickToBottom) chat.scrollTop = chat.scrollHeight;
}

function appendTransientAssistantDelta(delta, turnId = null) {
  if (!delta) return;
  const { shouldStickToBottom } = ensureTransientAssistantBubble(turnId);
  if (!remoteStreamHasStarted) {
    remoteStreamBodyEl.classList.remove('kb-thinking', 'kb-thinking-anim');
    remoteStreamBodyEl.textContent = '';
    remoteStreamHasStarted = true;
  }
  remoteStreamBodyEl.appendChild(document.createTextNode(delta));
  if (shouldStickToBottom) chat.scrollTop = chat.scrollHeight;
}

// Discard reply text streamed so far this turn (server sent delta_reset because
// an earlier turn's pre-tool narration must be cleared before the final reply
// streams). Leaves the bubble in place, ready to receive the real reply.
function clearTransientAssistantDelta(turnId = null) {
  if (!remoteStreamBodyEl) return;
  const normalizedTurnId = turnId != null ? String(turnId) : null;
  if (normalizedTurnId && remoteStreamTurnId && normalizedTurnId !== remoteStreamTurnId) return;
  if (!remoteStreamHasStarted) return;
  remoteStreamBodyEl.textContent = '';
  remoteStreamHasStarted = false;
}

function sendTypingViewing() {
  if (!typingWs || typingWs.readyState !== 1) return;
  if (currentHouseholdId == null || !Number.isFinite(Number(currentHouseholdId))) return;
  typingWs.send(JSON.stringify({ type: 'viewing', householdId: currentHouseholdId, chatId: currentChatId }));
  typingUsers.clear();
  updateTypingIndicator();
}

function connectTypingWs() {
  if (!currentUserName || currentHouseholdId == null || currentUserId == null) return;
  if (!Number.isFinite(Number(currentHouseholdId)) || !Number.isFinite(Number(currentUserId))) return;
  if (typingReconnectTimeout) {
    clearTimeout(typingReconnectTimeout);
    typingReconnectTimeout = null;
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = proto + '//' + location.host;
  try {
    const ws = new WebSocket(url);
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: 'identify',
          householdId: currentHouseholdId,
          userId: currentUserId,
          user: currentUserName,
        })
      );
      sendTypingViewing();
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const msgChatId = msg.chatId != null ? Number(msg.chatId) : null;
        const msgHid = msg.householdId != null ? Number(msg.householdId) : null;
        if (msg.type === 'chat_updated' && msgChatId === currentChatId) {
          if (msgHid != null && currentHouseholdId != null && msgHid !== Number(currentHouseholdId)) {
            return;
          }
          // "Did THIS tab send the message?" is a per-device fact, so key it on
          // weAreStreamingThisChat (true only on the tab that fired /chat and is rendering
          // its own reply inline) — never on the username. Keying it on the username made a
          // SECOND device logged in as the same user treat every broadcast as its own and
          // skip the reconcile, leaving its raw streamed preview (textContent, no markdown)
          // frozen on screen until a hard refresh. The early return also protects the
          // sending tab from the mid-stream reset below: chat_updated fires once the moment
          // the user message persists, while that tab is still streaming its reply.
          if (weAreStreamingThisChat) {
            return;
          }
          resetTransientAssistantBubble();
          const shouldStickToBottom = isChatNearBottom();
          void loadHistory({ preserveViewport: true }).catch(() => {});
          if (!shouldStickToBottom) showNewMessageIndicator();
          if (getKitchenView() === 'thisweek') {
            loadThisWeek();
          }
          return;
        }
        if (msg.type === 'kb_progress' && msgChatId === currentChatId) {
          if (msgHid != null && currentHouseholdId != null && msgHid !== Number(currentHouseholdId)) {
            return;
          }
          if (weAreStreamingThisChat) {
            return;
          }
          const shouldStickToBottom = isChatNearBottom();
          setTransientAssistantProgress(msg.text || 'Thinking…', msg.turnId || null);
          if (!shouldStickToBottom) showNewMessageIndicator();
          return;
        }
        if (msg.type === 'stream_delta' && msgChatId === currentChatId) {
          if (msgHid != null && currentHouseholdId != null && msgHid !== Number(currentHouseholdId)) {
            return;
          }
          // Prevent the sending client from applying the same assistant stream chunk twice.
          if (weAreStreamingThisChat) {
            return;
          }
          const shouldStickToBottom = isChatNearBottom();
          appendTransientAssistantDelta(msg.delta, msg.turnId || null);
          if (!shouldStickToBottom) showNewMessageIndicator();
          return;
        }
        if (msg.type === 'stream_delta_reset' && msgChatId === currentChatId) {
          if (msgHid != null && currentHouseholdId != null && msgHid !== Number(currentHouseholdId)) {
            return;
          }
          if (weAreStreamingThisChat) {
            return;
          }
          clearTransientAssistantDelta(msg.turnId || null);
          return;
        }
        if (msg.type === 'user_typing' || msg.type === 'user_stopped_typing') {
          if (currentHouseholdId == null || !Number.isFinite(Number(currentHouseholdId))) return;
          if (msgHid == null || msgHid !== Number(currentHouseholdId)) return;
          if (msgChatId != null && msgChatId !== currentChatId) return;
          if (msg.userId != null && currentUserId != null && Number(msg.userId) === Number(currentUserId)) return;
          if (msg.user === currentUserName) return;
          if (msg.type === 'user_typing') {
            typingUsers.add(msg.user);
            updateTypingIndicator();
          } else {
            typingUsers.delete(msg.user);
            updateTypingIndicator();
          }
        }
      } catch (e) {}
    };
    ws.onclose = () => {
      typingWs = null;
      scheduleRealtimeReconnect();
    };
    typingWs = ws;
  } catch (e) {}
}

async function refreshRealtimeChatView() {
  if (currentUserId == null || currentChatId == null) return;
  if (!typingWs || typingWs.readyState > 1) {
    connectTypingWs();
    return;
  }
  sendTypingViewing();
  if (!weAreStreamingThisChat) {
    try {
      await loadHistory({ preserveViewport: true });
    } catch (e) {}
  }
}

function showApp(name) {
  loginArea.style.display = 'none';
  appArea.style.display = 'flex';
  appArea.style.flexDirection = 'column';
  headerEl.classList.remove('hide-tabs');
  if (name) {
    speakerName.textContent = name;
  }
}

function showBootstrapForm() {
  const bf = document.getElementById('bootstrap-form');
  const lf = document.getElementById('login-form');
  const blk = document.getElementById('bootstrap-blocked');
  if (blk) blk.style.display = 'none';
  if (bf) bf.classList.add('bootstrap-form-visible');
  if (lf) lf.classList.remove('login-form-visible');
}

function showBootstrapBlocked() {
  const bf = document.getElementById('bootstrap-form');
  const lf = document.getElementById('login-form');
  const blk = document.getElementById('bootstrap-blocked');
  if (bf) bf.classList.remove('bootstrap-form-visible');
  if (lf) lf.classList.remove('login-form-visible');
  if (blk) blk.style.display = 'block';
}

function showLoginFormOnly() {
  const bf = document.getElementById('bootstrap-form');
  const lf = document.getElementById('login-form');
  const blk = document.getElementById('bootstrap-blocked');
  if (blk) blk.style.display = 'none';
  if (bf) bf.classList.remove('bootstrap-form-visible');
  if (lf) lf.classList.add('login-form-visible');
}

function showLogin() {
  loginArea.style.display = 'block';
  appArea.style.display = 'none';
  headerEl.classList.add('hide-tabs');
  showLoginFormOnly();
  setActiveTab('chat');
}

function reapplyVisibleAppTab() {
  if (!appArea || appArea.style.display === 'none') return;
  if (isCookbookHash()) {
    setActiveTab('groceries');
    setKitchenView('cookbook');
    return;
  }
  if (settingsPanel && settingsPanel.style.display === 'flex') {
    setActiveTab('settings');
    return;
  }
  if ((groceryPanel && groceryPanel.style.display === 'flex') || tabGroceries.classList.contains('tab-active')) {
    setActiveTab('groceries');
    return;
  }
  setActiveTab('chat');
}

function closeSidebar() {
  sidebar.classList.remove('open');
  sidebarBackdrop.classList.remove('open');
}

function closeSidebarAndGoToChatTab() {
  setActiveTab('chat');
  closeSidebar();
}











const SETTINGS_SUBVIEWS = {
  my: { view: 'settings-view-my', btn: 'settings-subtab-my-btn', gated: false },
  family: { view: 'settings-view-family', btn: 'settings-subtab-family-btn', gated: false },
  household: { view: 'settings-view-household', btn: 'settings-subtab-household-btn', gated: false },
  usage: { view: 'settings-view-usage', btn: 'settings-subtab-usage-btn', gated: false },
  admin: { view: 'settings-view-admin', btn: 'settings-subtab-admin-btn', gated: true },
};



















function sendTyping(isTyping) {
  if (isReadOnly()) return;
  if (!typingWs || typingWs.readyState !== 1 || !currentChatId) return;
  if (currentHouseholdId == null || !Number.isFinite(Number(currentHouseholdId))) return;
  typingWs.send(
    JSON.stringify({
      type: isTyping ? 'typing' : 'stopped_typing',
      householdId: currentHouseholdId,
      chatId: currentChatId,
    })
  );
}

function resizePromptInput() {
  if (!promptInput) return;
  const cs = getComputedStyle(promptInput);
  const lh = parseFloat(cs.lineHeight);
  const lineHeight = Number.isFinite(lh) ? lh : 14 * 1.4;
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const maxLines = 5;
  const maxHeight = Math.ceil(lineHeight * maxLines + padY);
  promptInput.style.height = 'auto';
  const sh = promptInput.scrollHeight;
  const h = Math.min(sh, maxHeight);
  promptInput.style.height = h + 'px';
  promptInput.style.maxHeight = maxHeight + 'px';
  promptInput.style.overflowY = sh > maxHeight ? 'auto' : 'hidden';
}

promptInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  if (event.isComposing) return;
  if (useMobileEnterBehavior) return;
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
  event.preventDefault();
  sendButton.click();
});

promptInput.addEventListener('input', () => {
  resizePromptInput();
  if (isReadOnly()) return;
  if (!currentChatId) return;
  sendTyping(true);
  if (typingStopTimeout) clearTimeout(typingStopTimeout);
  typingStopTimeout = setTimeout(() => {
    typingStopTimeout = null;
    sendTyping(false);
  }, 2000);
});
resizePromptInput();

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

function renderMarkdown(text) {
  // Assistant replies, imported-recipe text, and web-search results all flow here.
  // We ALWAYS sanitize marked's HTML with DOMPurify before innerHTML; if either lib
  // is missing we degrade to plain text rather than ever inject unsanitized HTML.
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
    return document.createTextNode(String(text));
  }
  try {
    const html = marked.parse(String(text), { gfm: true, breaks: true });
    const clean = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    const wrap = document.createElement('span');
    wrap.className = 'md-wrap';
    wrap.innerHTML = clean;
    return wrap;
  } catch (e) {
    return document.createTextNode(String(text));
  }
}

function addMessage(role, name, content, options = {}) {
  const autoScroll = options.autoScroll !== false;
  if (content === undefined && typeof name === 'string' && name.includes(': ')) {
    const idx = name.indexOf(': ');
    content = name.slice(idx + 2);
    name = name.slice(0, idx);
  } else if (content === undefined) {
    content = name;
    name = role === 'user' ? (speakerName && speakerName.textContent) || 'User' : currentAssistantName || 'KitchenBot';
  }
  const div = document.createElement('div');
  div.className = 'message ' + role;
  if (role === 'user') {
    div.classList.add(userMessageBubbleClass(name));
  }
  const author = document.createElement('span');
  author.className = 'message-author';
  author.textContent = name;
  div.appendChild(author);
  const body = document.createElement('div');
  body.className = 'message-body';
  if (role === 'assistant') {
    body.appendChild(renderMarkdown(content));
  } else {
    body.textContent = content;
  }
  div.appendChild(body);
  const atts = Array.isArray(options.attachments) ? options.attachments : [];
  if (atts.length) {
    const attWrap = document.createElement('div');
    attWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;';
    for (const a of atts) {
      if (a.kind === 'image') {
        const img = document.createElement('img');
        img.src = a.id ? '/attachment/' + a.id : 'data:' + (a.mediaType || 'image/jpeg') + ';base64,' + (a.data || '');
        img.alt = a.name || 'photo';
        img.style.cssText =
          'max-width:180px;max-height:180px;border-radius:10px;border:1px solid var(--border-subtle);cursor:pointer;';
        if (a.id) img.addEventListener('click', () => window.open('/attachment/' + a.id, '_blank'));
        attWrap.appendChild(img);
      } else {
        const fileChip = document.createElement(a.id ? 'a' : 'span');
        if (a.id) {
          fileChip.href = '/attachment/' + a.id;
          fileChip.target = '_blank';
          fileChip.rel = 'noopener';
        }
        fileChip.textContent = '📄 ' + (a.name || 'file');
        fileChip.style.cssText =
          'display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border-radius:10px;border:1px solid var(--border-subtle);background:var(--card-bg-2);font-size:13px;text-decoration:none;color:var(--text);';
        attWrap.appendChild(fileChip);
      }
    }
    div.appendChild(attWrap);
  }
  chat.appendChild(div);
  if (autoScroll) chat.scrollTop = chat.scrollHeight;
}


async function loadHistory(options = {}) {
  if (!currentChatId) return;
  const requestSeq = ++loadHistoryRequestSeq;
  const requestedChatId = Number(currentChatId);
  const preserveViewport = options.preserveViewport !== false;
  const shouldStickToBottom = preserveViewport ? isChatNearBottom() : true;
  const previousBottomOffset = preserveViewport ? getChatBottomOffset() : 0;
  resetTransientAssistantBubble();
  const response = await fetch('/history?chatId=' + encodeURIComponent(currentChatId));
  if (!response.ok) {
    if (response.status === 401) {
      showLogin();
    }
    return;
  }
  const data = await response.json();
  if (requestSeq !== loadHistoryRequestSeq) return;
  if (Number(currentChatId) !== requestedChatId) return;
  currentAssistantName = data.assistantName || currentAssistantName || 'KitchenBot';
  const persisted = data.conversation || [];
  const cid = Number(currentChatId);
  lastPersistedMessageCountByChatId.set(cid, persisted.length);

  chat.innerHTML = '';

  const epList = ephemeralExchangesByChatId.get(cid) || [];
  const sortedEp = [...epList].sort((a, b) => a.anchor - b.anchor || a.seq - b.seq);
  let pIdx = 0;
  let dbEmitted = 0;
  for (const ep of sortedEp) {
    while (dbEmitted < ep.anchor && pIdx < persisted.length) {
      const m = persisted[pIdx++];
      addMessage(m.role, m.name, m.content, { autoScroll: false, attachments: m.attachments });
      dbEmitted++;
    }
    addMessage('user', ep.userName, ep.user, { autoScroll: false });
    addMessage('assistant', currentAssistantName || 'KitchenBot', ep.assistant, { autoScroll: false });
  }
  while (pIdx < persisted.length) {
    const m = persisted[pIdx++];
    addMessage(m.role, m.name, m.content, { autoScroll: false });
  }
  if (shouldStickToBottom) {
    chat.scrollTop = chat.scrollHeight;
    hideNewMessageIndicator();
  } else {
    restoreChatScrollFromBottom(previousBottomOffset);
    syncNewMessageIndicatorWithScroll();
  }
  sendTypingViewing();
  renderThisWeekStrip();
}






// Compact, glanceable "This Week" strip pinned above the chat messages — the plan
// right where you're cooking. Reads the same /plan data; refreshed by loadHistory
// (chat open/switch, after a turn, co-viewer updates) and by setActiveTab('chat').

function renderChats() {
  chatListEl.innerHTML = '';
  for (const chatInfo of chatsCache) {
    const li = document.createElement('li');
    li.className = 'chat-list-item' + (chatInfo.id === currentChatId ? ' active' : '');
    const titleSpan = document.createElement('span');
    titleSpan.className = 'title';
    titleSpan.textContent = chatInfo.title || 'Untitled chat';
    const metaSpan = document.createElement('span');
    metaSpan.className = 'meta';
    metaSpan.textContent = chatInfo.created_at ? new Date(chatInfo.created_at).toLocaleDateString() : '';

    const contentDiv = document.createElement('div');
    contentDiv.style.flex = '1';
    contentDiv.style.minWidth = '0';
    contentDiv.appendChild(titleSpan);
    contentDiv.appendChild(metaSpan);

    li.appendChild(contentDiv);

    if (isCurrentUserOwner && !isReadOnly()) {
      const delBtn = document.createElement('button');
      delBtn.textContent = '×';
      delBtn.className = 'g-delete';
      delBtn.style.marginLeft = '4px';
      if (chatInfo.id === currentChatId) {
        delBtn.disabled = true;
        delBtn.style.opacity = '0.4';
      }
      delBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (chatInfo.id === currentChatId) return;
        if (!confirm('Delete this chat?')) return;
        try {
          const resp = await fetch('/chats/' + chatInfo.id, { method: 'DELETE' });
          if (!resp.ok) return;
          chatsCache = chatsCache.filter(c => c.id !== chatInfo.id);
          if (currentChatId === chatInfo.id) {
            setCurrentChatId(chatsCache.length ? chatsCache[0].id : null);
            chat.innerHTML = '';
            if (currentChatId) {
              await loadHistory();
            }
          }
          renderChats();
          try {
            await refreshAdminHouseholdsList();
          } catch (e) {}
        } catch (e) {}
      });
      li.appendChild(delBtn);
    }

    li.addEventListener('click', async () => {
      setCurrentChatId(chatInfo.id);
      closeSidebarAndGoToChatTab();
      renderChats();
      await loadHistory();
    });
    chatListEl.appendChild(li);
  }
}

async function loadChatsAndEnsureOne() {
  const response = await fetch('/chats');
  if (!response.ok) {
    throw new Error('Failed to load chats');
  }
  const data = await response.json();
  chatsCache = data.chats || [];
  if (chatsCache.length === 0) {
    if (isReadOnly()) {
      setCurrentChatId(null);
      chat.innerHTML = '';
      renderChats();
      return;
    }
    const createResp = await fetch('/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New chat' }),
    });
    if (!createResp.ok) throw new Error('Failed to create chat');
    const created = await createResp.json();
    setCurrentChatId(created.id);
    chatsCache.unshift({ id: created.id, owner: created.owner, title: created.title, created_at: new Date().toISOString() });
  } else {
    setCurrentChatId(chatsCache[0].id);
  }
  renderChats();
}

async function checkAuth() {
  try {
    const bs = await fetch('/bootstrap/status');
    if (!bs.ok) {
      loginArea.style.display = 'block';
      appArea.style.display = 'none';
      headerEl.classList.add('hide-tabs');
      showLoginFormOnly();
      return;
    }
    const bsData = await bs.json();
    if (bsData.needsBootstrap) {
      loginArea.style.display = 'block';
      appArea.style.display = 'none';
      headerEl.classList.add('hide-tabs');
      if (bsData.allowPublicBootstrap === false) {
        showBootstrapBlocked();
      } else {
        showBootstrapForm();
      }
      return;
    }

    showLoginFormOnly();
    const response = await fetch('/me');
    if (!response.ok) {
      showLogin();
      return;
    }
    const data = await response.json();
    await rehydrateAuthenticatedApp(data, { forceChatTab: true, resetSessionView: true });
  } catch (error) {
    showLogin();
  }
}

async function rehydrateAuthenticatedApp(meData, opts = {}) {
  const forceChatTab = opts.forceChatTab !== false;
  const resetSessionView = opts.resetSessionView !== false;
  teardownRealtimeUi();
  if (resetSessionView) {
    setCurrentChatId(null);
    chatsCache = [];
    chat.innerHTML = '';
    sidebar.classList.remove('open');
    sidebarBackdrop.classList.remove('open');
    lastPersistedMessageCountByChatId.clear();
    ephemeralExchangesByChatId.clear();
    nextEphemeralSeqByChatId.clear();
  }
  currentUserName = meData.name;
  currentHouseholdId = meData.householdId != null ? Number(meData.householdId) : null;
  currentUserId = meData.userId != null ? Number(meData.userId) : null;
  isCurrentUserOwner = true; // owner/member distinction removed
  applyGodModeFromMe(meData);
  // Publish identity for the feature modules; palette et al. react to SESSION_CHANGED.
  applySession({ ...meData, displayName: meData.name, isOwner: true });
  showApp(meData.name);
  const shouldOpenCookbookFromHash = isCookbookHash();
  if (shouldOpenCookbookFromHash) {
    setActiveTab('groceries');
    setKitchenView('cookbook');
  } else if (forceChatTab) {
    setActiveTab('chat');
  }
  await loadChatsAndEnsureOne();
  await loadHistory();
  if (shouldOpenCookbookFromHash) {
    setActiveTab('groceries');
    setKitchenView('cookbook');
    await loadCookbook();
  }
  connectTypingWs();
}

tabChat.addEventListener('click', () => {
  setActiveTab('chat');
});

tabGroceries.addEventListener('click', async () => {
  setActiveTab('groceries');
  await Promise.all([loadGroceries(), loadPantry(), loadCookbook()]);
});

if (tabSettings) {
  tabSettings.addEventListener('click', () => {
    setActiveTab('settings');
  });
}

if (grocerySubtabList) {
  grocerySubtabList.addEventListener('click', () => {
    setKitchenView('list');
  });
}
if (grocerySubtabPantry) {
  grocerySubtabPantry.addEventListener('click', () => {
    setKitchenView('pantry');
  });
}
if (grocerySubtabCookbook) {
  grocerySubtabCookbook.addEventListener('click', async () => {
    setKitchenView('cookbook');
    await loadCookbook();
  });
}
if (grocerySubtabThisweek) {
  grocerySubtabThisweek.addEventListener('click', () => {
    setKitchenView('thisweek');
  });
}















menuButton.addEventListener('click', async () => {
  try {
    const resp = await fetch('/chats');
    if (resp.ok) {
      const data = await resp.json();
      chatsCache = data.chats || [];
      renderChats();
    }
  } catch (e) {}
  sidebar.classList.add('open');
  sidebarBackdrop.classList.add('open');
});

sidebarBackdrop.addEventListener('click', () => {
  sidebar.classList.remove('open');
  sidebarBackdrop.classList.remove('open');
});

newChatButton.addEventListener('click', async () => {
  try {
    const resp = await fetch('/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New chat' }),
    });
    if (!resp.ok) return;
    const created = await resp.json();
    setCurrentChatId(created.id);
    sendTypingViewing();
    chatsCache.unshift({
      id: created.id,
      owner: created.owner,
      title: created.title,
      created_at: new Date().toISOString(),
    });
    renderChats();
    chat.innerHTML = '';
    closeSidebarAndGoToChatTab();
  } catch (e) {
    // ignore
  }
});

let lastResolvedKey = null;
let blurFindTimeout = null;
let chatRequestInFlight = false;

function clearHouseholdLookup() {
  lastResolvedKey = null;
  const resolvedEl = document.getElementById('login-household-resolved');
  if (resolvedEl) resolvedEl.style.display = 'none';
  loginNameSelect.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = '— Select user —';
  ph.disabled = true;
  ph.selected = true;
  loginNameSelect.appendChild(ph);
  loginNameSelect.disabled = true;
  loginPasswordInput.value = '';
  loginButton.disabled = true;
  loginStatus.textContent = '';
}

function updateLoginEnabled() {
  const canTry =
    lastResolvedKey != null &&
    loginNameSelect.value &&
    loginPasswordInput.value.trim().length > 0;
  loginButton.disabled = !canTry;
}

function buildClientTimeContext() {
  const now = new Date();
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absMinutes = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absMinutes / 60)).padStart(2, '0');
  const offsetRemainder = String(absMinutes % 60).padStart(2, '0');
  const isoLocal =
    now.getFullYear() +
    '-' +
    String(now.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(now.getDate()).padStart(2, '0') +
    'T' +
    String(now.getHours()).padStart(2, '0') +
    ':' +
    String(now.getMinutes()).padStart(2, '0') +
    ':' +
    String(now.getSeconds()).padStart(2, '0') +
    sign +
    offsetHours +
    ':' +
    offsetRemainder;
  return {
    localDateTime: isoLocal,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    localDayName: now.toLocaleDateString(undefined, { weekday: 'long' }),
    localHour: now.getHours(),
  };
}

async function findHousehold() {
  const key = loginHouseholdKeyInput.value.trim();
  if (!key) {
    loginStatus.textContent = 'Enter a household key.';
    clearHouseholdLookup();
    return;
  }
  loginStatus.textContent = 'Looking up…';
  try {
    const r = await fetch('/login/household?' + new URLSearchParams({ key }));
    if (r.status === 404) {
      clearHouseholdLookup();
      loginStatus.textContent = 'No household found for that key.';
      return;
    }
    if (!r.ok) {
      clearHouseholdLookup();
      loginStatus.textContent = 'Could not look up household.';
      return;
    }
    const data = await r.json();
    lastResolvedKey = data.household.key;
    const nameEl = document.getElementById('login-household-name');
    if (nameEl) nameEl.textContent = data.household.name;
    const resolvedEl = document.getElementById('login-household-resolved');
    if (resolvedEl) resolvedEl.style.display = 'block';
    loginNameSelect.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '— Select user —';
    placeholder.disabled = true;
    placeholder.selected = true;
    loginNameSelect.appendChild(placeholder);
    for (const u of data.users) {
      const opt = document.createElement('option');
      opt.value = u.displayName;
      opt.textContent = u.displayName;
      loginNameSelect.appendChild(opt);
    }
    loginNameSelect.disabled = false;
    loginStatus.textContent = '';
    updateLoginEnabled();
  } catch (e) {
    clearHouseholdLookup();
    loginStatus.textContent = 'Lookup failed.';
  }
}

loginHouseholdKeyInput.addEventListener('input', () => {
  const v = loginHouseholdKeyInput.value.trim().toLowerCase();
  if (lastResolvedKey != null && v !== lastResolvedKey) {
    clearHouseholdLookup();
  }
});

loginHouseholdKeyInput.addEventListener('blur', () => {
  blurFindTimeout = setTimeout(() => {
    blurFindTimeout = null;
    if (loginHouseholdKeyInput.value.trim()) {
      findHousehold();
    }
  }, 250);
});

loginFindHouseholdButton.addEventListener('mousedown', (e) => {
  if (blurFindTimeout) {
    clearTimeout(blurFindTimeout);
    blurFindTimeout = null;
  }
});

loginFindHouseholdButton.addEventListener('click', () => {
  findHousehold();
});

loginNameSelect.addEventListener('change', updateLoginEnabled);
loginPasswordInput.addEventListener('input', updateLoginEnabled);

async function performLogin() {
  const householdKey = lastResolvedKey;
  const displayName = loginNameSelect.value;
  const pin = loginPasswordInput.value;

  if (!householdKey) {
    loginStatus.textContent = 'Find your household first.';
    return;
  }
  if (!displayName) {
    loginStatus.textContent = 'Select a user.';
    return;
  }
  if (!pin) {
    loginStatus.textContent = 'PIN is required.';
    return;
  }

  loginStatus.textContent = 'Logging in...';

  try {
    const response = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ householdKey, displayName, pin })
    });

    if (!response.ok) {
      loginStatus.textContent = 'Invalid user or PIN.';
      return;
    }

    let data = {};
    try {
      data = await response.json();
    } catch (e) {}

    loginPasswordInput.value = '';
    loginStatus.textContent = '';
    try {
      const meR = await fetch('/me');
      if (meR.ok) {
        const meData = await meR.json();
        await rehydrateAuthenticatedApp(meData, { forceChatTab: true, resetSessionView: true });
        return;
      }
    } catch (e) {}
    const resolvedName = data.displayName ?? data.name ?? displayName;
    await rehydrateAuthenticatedApp(
      {
        name: resolvedName,
        householdId: data.householdId,
        userId: data.userId,
        chatColors: {},
        isImpersonating: false,
        impersonationReadOnly: false,
      },
      { forceChatTab: true, resetSessionView: true }
    );
  } catch (error) {
    loginStatus.textContent = 'Login failed.';
  }
}

if (loginAuthForm) {
  loginAuthForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (loginButton.disabled) return;
    void performLogin();
  });
}

document.getElementById('bootstrap-submit').addEventListener('click', async () => {
  const householdName = document.getElementById('bootstrap-household-name').value.trim();
  const householdKey = document.getElementById('bootstrap-household-key').value.trim();
  const ownerDisplayName = document.getElementById('bootstrap-owner-display-name').value.trim();
  const pin = document.getElementById('bootstrap-pin').value;
  const bootstrapStatusEl = document.getElementById('bootstrap-status');
  if (!householdName || !householdKey || !ownerDisplayName || !pin) {
    bootstrapStatusEl.textContent = 'All fields are required.';
    return;
  }
  bootstrapStatusEl.textContent = 'Creating…';
  try {
    const r = await fetch('/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ householdName, householdKey, ownerDisplayName, pin }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      bootstrapStatusEl.textContent = data.error || 'Bootstrap failed.';
      return;
    }
    document.getElementById('bootstrap-pin').value = '';
    bootstrapStatusEl.textContent = '';
    showLoginFormOnly();
    loginHouseholdKeyInput.value = data.householdKey || householdKey;
    await findHousehold();
  } catch (e) {
    bootstrapStatusEl.textContent = 'Something went wrong.';
  }
});

try {
  showLoginFormOnly();
} catch (e) {
  console.error('Startup login shell render failed:', e);
}
if (chatNewMessageButton) {
  chatNewMessageButton.addEventListener('click', () => {
    chat.scrollTop = chat.scrollHeight;
    hideNewMessageIndicator();
  });
}
chat.addEventListener('scroll', () => {
  syncNewMessageIndicatorWithScroll();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  void refreshRealtimeChatView();
});
window.addEventListener('focus', () => {
  void refreshRealtimeChatView();
});
window.addEventListener('pageshow', () => {
  reapplyVisibleAppTab();
  void refreshRealtimeChatView();
});
checkAuth();


sendButton.addEventListener('click', async () => {
  if (isReadOnly()) return;
  if (chatRequestInFlight) return;
  const prompt = promptInput.value.trim();

  if (!prompt && !getPendingAttachment()) return;

  sendTyping(false);
  if (typingStopTimeout) {
    clearTimeout(typingStopTimeout);
    typingStopTimeout = null;
  }

  const speaker = speakerName.textContent || 'Rob';
  hideNewMessageIndicator();
  const sentAttachment = getPendingAttachment();
  clearPendingAttachment();
  addMessage('user', speaker, prompt, { attachments: sentAttachment ? [sentAttachment] : [] });
  promptInput.value = '';
  // clearPendingAttachment() above already reset the inputs and the preview chip.
  resizePromptInput();
  weAreStreamingThisChat = true;
  chatRequestInFlight = true;
  sendButton.disabled = true;

  const thinkingDiv = document.createElement('div');
  thinkingDiv.className = 'message assistant';
  const thinkingAuthor = document.createElement('span');
  thinkingAuthor.className = 'message-author';
  thinkingAuthor.textContent = currentAssistantName || 'KitchenBot';
  thinkingDiv.appendChild(thinkingAuthor);
  const thinkingBody = document.createElement('div');
  thinkingBody.className = 'message-body kb-thinking kb-thinking-anim';
  thinkingBody.textContent = 'Thinking…';
  thinkingDiv.appendChild(thinkingBody);
  chat.appendChild(thinkingDiv);
  chat.scrollTop = chat.scrollHeight;
  remoteStreamBodyEl = thinkingBody;
  remoteStreamTurnId = null;
  remoteStreamHasStarted = false;

  const ephemeralAnchorPersistedCount =
    lastPersistedMessageCountByChatId.get(Number(currentChatId)) ?? 0;

  try {
    const response = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        name: speaker,
        chatId: currentChatId,
        timeContext: buildClientTimeContext(),
        attachment: sentAttachment,
      })
    });

    if (!response.ok) {
      resetTransientAssistantBubble();
      weAreStreamingThisChat = false;
      thinkingBody.classList.remove('kb-thinking', 'kb-thinking-anim');
      if (response.status === 401) {
        thinkingBody.textContent = 'Please log in.';
        showLogin();
        return;
      }
      if (response.status === 429) {
        const data = await response.json().catch(() => ({}));
        thinkingBody.textContent = data.reply || 'Too many requests. Please slow down.';
        return;
      }
      const errData = await response.json().catch(() => ({}));
      let replyText =
        errData.reply ||
        errData.error ||
        (response.status === 503 ? 'Service unavailable.' : 'Something went wrong.');
      if (
        typeof replyText === 'string' &&
        /^\s*\{/.test(replyText.trim()) &&
        replyText.includes('"type"')
      ) {
        replyText = 'Invalid or missing Anthropic key.';
      }
      thinkingBody.textContent = replyText;
      return;
    }

    const serverActionManaged = response.headers.get('X-KitchenBot-Server-Action-Managed') === '1';

    const chatResponseEphemeral = response.headers.get('X-KitchenBot-Ephemeral') === '1';
    const streamFormat = response.headers.get('X-KitchenBot-Stream-Format') || '';
    const isStructuredKbStream =
      streamFormat === 'ndjson' ||
      String(response.headers.get('Content-Type') || '').includes('application/x-ndjson');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let fullReply = '';
    let firstStreamChunk = true;
    let streamBuffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      if (!chunk) continue;
      if (!isStructuredKbStream) {
        fullReply += chunk;
        if (firstStreamChunk) firstStreamChunk = false;
        appendTransientAssistantDelta(chunk, remoteStreamTurnId);
        continue;
      }
      streamBuffer += chunk;
      let lineBreakIndex = streamBuffer.indexOf('\n');
      while (lineBreakIndex !== -1) {
        const line = streamBuffer.slice(0, lineBreakIndex).trim();
        streamBuffer = streamBuffer.slice(lineBreakIndex + 1);
        if (line) {
          try {
            const event = JSON.parse(line);
            if (event && event.type === 'progress') {
              setTransientAssistantProgress(event.text || 'Thinking…', event.turnId || null);
            } else if (event && event.type === 'delta_reset') {
              // An earlier turn's pre-tool narration must be discarded before the
              // final reply streams. Drop it from both the live bubble and the
              // accumulator so the persisted render matches the final turn only.
              fullReply = '';
              firstStreamChunk = true;
              clearTransientAssistantDelta(event.turnId || null);
            } else if (event && event.type === 'delta' && event.delta) {
              fullReply += String(event.delta);
              if (firstStreamChunk) firstStreamChunk = false;
              appendTransientAssistantDelta(String(event.delta), event.turnId || null);
            }
          } catch (e) {
            fullReply += line;
            if (firstStreamChunk) firstStreamChunk = false;
            appendTransientAssistantDelta(line, remoteStreamTurnId);
          }
        }
        lineBreakIndex = streamBuffer.indexOf('\n');
      }
    }

    if (isStructuredKbStream && streamBuffer.trim()) {
      try {
        const event = JSON.parse(streamBuffer.trim());
        if (event && event.type === 'delta' && event.delta) {
          fullReply += String(event.delta);
          appendTransientAssistantDelta(String(event.delta), event.turnId || null);
        }
      } catch (e) {}
    }

    thinkingBody.classList.remove('kb-thinking', 'kb-thinking-anim');
    thinkingBody.textContent = '';
    thinkingBody.appendChild(renderMarkdown(fullReply));
    chat.scrollTop = chat.scrollHeight;
    resetTransientAssistantBubble();
    weAreStreamingThisChat = false;

    if (chatResponseEphemeral && currentChatId != null) {
      const cid = Number(currentChatId);
      const seq = (nextEphemeralSeqByChatId.get(cid) || 0) + 1;
      nextEphemeralSeqByChatId.set(cid, seq);
      const list = ephemeralExchangesByChatId.get(cid) || [];
      list.push({
        anchor: ephemeralAnchorPersistedCount,
        seq,
        userName: speaker,
        user: prompt,
        assistant: fullReply,
      });
      ephemeralExchangesByChatId.set(cid, list);
    }

    try {
      await loadHistory();
    } catch (e) {}
    try {
      const r = await fetch('/chats');
      if (r.ok) {
        const data = await r.json();
        chatsCache = data.chats || [];
        renderChats();
      }
    } catch (e) {}
  }

  catch (error) {
    thinkingBody.textContent = 'Something went wrong.';
    resetTransientAssistantBubble();
    weAreStreamingThisChat = false;
  } finally {
    chatRequestInFlight = false;
    if (sendButton && !isReadOnly()) {
      sendButton.disabled = false;
      sendButton.style.opacity = '';
    }
  }
});

logoutButton.addEventListener('click', async () => {
  try {
    await fetch('/logout', { method: 'POST' });
  } catch (e) {
    // ignore errors, just force login state
  }
  sidebar.classList.remove('open');
  sidebarBackdrop.classList.remove('open');
  teardownRealtimeUi();
  speakerName.textContent = '';
  currentUserName = null;
  currentHouseholdId = null;
  currentUserId = null;
  isCurrentUserOwner = false;
  // Session owns identity + the read-only flag; clearing it announces the change.
  clearSession();
  applyGodModeFromMe({ isImpersonating: false, impersonationReadOnly: false });
  resetCookbook();
  showLogin();
  chat.innerHTML = '';
  lastPersistedMessageCountByChatId.clear();
  ephemeralExchangesByChatId.clear();
  nextEphemeralSeqByChatId.clear();
});


// --- feature modules ---
initPalette();
initSettings();
initAdmin();
initPlan();
initInventory();
initCookbook();
initAttachments();

// Navigation announces where the user went; each feature decides what that means for it.
// These subscriptions replace the direct calls navigation used to make into settings, the meal
// plan, and the cookbook — the coupling that previously made those inextricable.
onAppEvent(EVENTS.TAB_CHANGED, ({ tab }) => {
  if (tab === 'settings') loadSettingsPanel();
  if (tab === 'chat') renderThisWeekStrip();
});
onAppEvent(EVENTS.KITCHEN_VIEW_CHANGED, ({ view }) => {
  if (view === 'thisweek') loadThisWeek();
  syncCookbookWorkspaceLayout();
});

// The cookbook (and anything else) can ask for the composer to be seeded without touching it.
onAppEvent(EVENTS.COMPOSE_PROMPT, ({ text }) => {
  if (!promptInput) return;
  promptInput.value = String(text || '');
  resizePromptInput();
  promptInput.focus();
});

// Chat's own controls follow the read-only flag. Admin used to reach in and disable these; now it
// only flips the flag and chat responds.
function syncChatReadOnly() {
  const ro = isReadOnly();
  if (promptInput) {
    promptInput.readOnly = ro;
    promptInput.style.opacity = ro ? '0.65' : '';
  }
  for (const control of [sendButton, newChatButton]) {
    if (!control) continue;
    control.disabled = ro;
    control.style.opacity = ro ? '0.5' : '';
  }
}
onAppEvent(EVENTS.READ_ONLY_CHANGED, syncChatReadOnly);
onAppEvent(EVENTS.SESSION_CHANGED, syncChatReadOnly);

// The shell owns showing the login form and re-hydrating after an identity change.
onAppEvent(EVENTS.SESSION_EXPIRED, () => showLogin());
onAppEvent(EVENTS.REHYDRATE_APP, ({ me, options }) => {
  rehydrateAuthenticatedApp(me, options || {}).catch((e) =>
    console.error('Re-hydration after identity change failed:', e)
  );
});

// Settings (and anything else) can ask chat to redraw its history without calling into it.
onAppEvent(EVENTS.CHAT_RELOAD, () => {
  if (currentChatId) loadHistory().catch((e) => console.error('History reload failed:', e));
});
