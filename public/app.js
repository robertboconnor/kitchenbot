import { COOKBOOK_CATEGORY_OPTIONS, KB_BOOT } from './modules/boot-data.js';
import { applyMe as applySession } from './modules/session.js';
import { initPalette } from './modules/palette.js';
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
const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const useMobileEnterBehavior =
  isMobile ||
  (!!window.matchMedia &&
    window.matchMedia('(pointer: coarse)').matches &&
    window.matchMedia('(hover: none)').matches);
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
const settingsPanel = document.getElementById('settings-panel');
const tabChat = document.getElementById('tab-chat');
const tabGroceries = document.getElementById('tab-groceries');
const tabSettings = document.getElementById('tab-settings');
const inputArea = document.getElementById('input-area');
const groceryRefreshButton = document.getElementById('grocery-refresh');
const groceryClearButton = document.getElementById('grocery-clear');
const grocerySubtabList = document.getElementById('grocery-subtab-list');
const grocerySubtabPantry = document.getElementById('grocery-subtab-pantry');
const grocerySubtabCookbook = document.getElementById('grocery-subtab-cookbook');
const grocerySubviewList = document.getElementById('grocery-subview-list');
const grocerySubviewPantry = document.getElementById('grocery-subview-pantry');
const grocerySubviewCookbook = document.getElementById('grocery-subview-cookbook');
const grocerySubtabThisweek = document.getElementById('grocery-subtab-thisweek');
const grocerySubviewThisweek = document.getElementById('grocery-subview-thisweek');
const thisweekList = document.getElementById('thisweek-list');
const thisweekEmpty = document.getElementById('thisweek-empty');
const thisweekStrip = document.getElementById('thisweek-strip');
const cookbookWorkspace = document.getElementById('cookbook-workspace');
const cookbookResultsArea = document.getElementById('cookbook-results-area');
const cookbookList = document.getElementById('cookbook-list');
const cookbookEmpty = document.getElementById('cookbook-empty');
const cookbookToolbar = document.getElementById('cookbook-toolbar');
const cookbookCategoryFilter = document.getElementById('cookbook-category-filter');
const cookbookTagFilter = document.getElementById('cookbook-tag-filter');
const cookbookSearchFilter = document.getElementById('cookbook-search-filter');
const cookbookDetailView = document.getElementById('cookbook-detail-view');
const cookbookDetailBack = document.getElementById('cookbook-detail-back');
const cookbookDetailMeta = document.getElementById('cookbook-detail-meta');
const cookbookDetailEdit = document.getElementById('cookbook-detail-edit');
const cookbookDetailCancel = document.getElementById('cookbook-detail-cancel');
const cookbookDetailSave = document.getElementById('cookbook-detail-save');
const cookbookDetailTitle = document.getElementById('cookbook-detail-title');
const cookbookDetailCategory = document.getElementById('cookbook-detail-category');
const cookbookDetailSummary = document.getElementById('cookbook-detail-summary');
const cookbookDetailIngredients = document.getElementById('cookbook-detail-ingredients');
const cookbookDetailInstructions = document.getElementById('cookbook-detail-instructions');
const cookbookDetailNotes = document.getElementById('cookbook-detail-notes');
const cookbookDetailTags = document.getElementById('cookbook-detail-tags');
const cookbookDetailSource = document.getElementById('cookbook-detail-source');
const cookbookDetailMessage = document.getElementById('cookbook-detail-message');
const cookbookDetailActions = document.getElementById('cookbook-detail-actions');
const groceryAddName = document.getElementById('grocery-add-name');
const groceryAddAmount = document.getElementById('grocery-add-amount');
const groceryAddSection = document.getElementById('grocery-add-section');
const groceryAddSubmit = document.getElementById('grocery-add-submit');
const pantryAddName = document.getElementById('pantry-add-name');
const pantryAddAmount = document.getElementById('pantry-add-amount');
const pantryAddSection = document.getElementById('pantry-add-section');
const pantryAddSubmit = document.getElementById('pantry-add-submit');
const promptInput = document.getElementById('prompt');
const sendButton = document.getElementById('send');
const logoutButton = document.getElementById('logout');
const typingIndicator = document.getElementById('typing-indicator');
const chatNewMessageButton = document.getElementById('chat-new-message');
let cachedAdminHouseholds = null;
let currentSettingsSubView = 'my';

const groceryLists = {
  produce: document.getElementById('g-list-produce'),
  meat: document.getElementById('g-list-meat'),
  dairy: document.getElementById('g-list-dairy'),
  frozen: document.getElementById('g-list-frozen'),
  dry: document.getElementById('g-list-dry'),
  other: document.getElementById('g-list-other'),
};
const pantryLists = {
  spices_herbs: document.getElementById('p-list-spices_herbs'),
  oils_vinegars: document.getElementById('p-list-oils_vinegars'),
  baking: document.getElementById('p-list-baking'),
  sweeteners: document.getElementById('p-list-sweeteners'),
  condiments_sauces: document.getElementById('p-list-condiments_sauces'),
  pasta_grains_dry_goods: document.getElementById('p-list-pasta_grains_dry_goods'),
  other_pantry: document.getElementById('p-list-other_pantry'),
};

let currentChatId = null;
let currentUserName = null;
let currentHouseholdId = null;
let currentUserId = null;
let currentAssistantName = 'KitchenBot';
let isCurrentUserOwner = false;
const KITCHEN_SECTION_STORAGE_KEY = 'kb_kitchen_active_section';
let currentGroceriesSubview = readKitchenSectionPreference();
let cookbookCache = [];
let currentCookbookCategoryFilter = '';
let currentCookbookTagFilter = '';
let currentCookbookSearchFilter = '';
let currentCookbookEntryId = null;
let cookbookDetailEntry = null;
let cookbookDetailDraft = null;
let cookbookDetailEditing = false;
let godModeReadOnly = false;
let loadHistoryRequestSeq = 0;
/** Normalized display name (trim + lower) -> chat color key */
let displayNameToColor = {};
const CHAT_COLOR_OPTIONS = [
  { key: 'pink', label: 'Pink' },
  { key: 'blue', label: 'Blue' },
  { key: 'mint', label: 'Mint' },
  { key: 'lavender', label: 'Lavender' },
  { key: 'peach', label: 'Peach' },
];

function readKitchenSectionPreference() {
  try {
    const saved = sessionStorage.getItem(KITCHEN_SECTION_STORAGE_KEY);
    return saved === 'list' || saved === 'pantry' || saved === 'cookbook' || saved === 'thisweek' ? saved : 'cookbook';
  } catch (error) {
    return 'cookbook';
  }
}

function persistKitchenSectionPreference(value) {
  const normalized = value === 'list' || value === 'pantry' || value === 'cookbook' ? value : 'cookbook';
  try {
    sessionStorage.setItem(KITCHEN_SECTION_STORAGE_KEY, normalized);
  } catch (error) {}
}
function normalizeDisplayNameKey(name) {
  return String(name ?? '').trim().toLowerCase();
}
function normalizeToneValue(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (key === 'sexy') return 'thirsty';
  if (key === 'sassy') return 'witty';
  if (key === 'friendly') return 'helpful';
  return ['helpful', 'concise', 'witty', 'thirsty'].includes(key) ? key : 'helpful';
}
function rebuildDisplayNameToColorFromMeChatColors(chatColors) {
  displayNameToColor = {};
  if (chatColors && typeof chatColors === 'object' && !Array.isArray(chatColors)) {
    for (const k of Object.keys(chatColors)) {
      const nk = normalizeDisplayNameKey(k);
      if (nk) displayNameToColor[nk] = chatColors[k];
    }
  }
}
function rebuildDisplayNameToColorFromSettingsUsers(users) {
  displayNameToColor = {};
  for (const u of users || []) {
    const nk = normalizeDisplayNameKey(u.displayName);
    if (nk) displayNameToColor[nk] = u.chatColor || 'blue';
  }
}
function userMessageBubbleClass(displayName) {
  const nk = normalizeDisplayNameKey(displayName);
  const raw = nk ? displayNameToColor[nk] : undefined;
  const k =
    typeof raw === 'string' && raw.trim()
      ? raw.trim().toLowerCase()
      : 'blue';
  const ok = CHAT_COLOR_OPTIONS.some((o) => o.key === k);
  return 'user-msg-chat-' + (ok ? k : 'blue');
}
let chatsCache = [];
let lastDeletedGrocery = null;
let lastDeletedTimeout = null;
let lastMePayload = null;
/** Last persisted message count from /history per chat (DB rows only). */
const lastPersistedMessageCountByChatId = new Map();
/**
 * Sender-only ephemeral !command turns (session memory): merged after each loadHistory.
 * anchor = persisted row count when the exchange happened; seq = stable order for same anchor.
 */
const ephemeralExchangesByChatId = new Map();
const nextEphemeralSeqByChatId = new Map();
const inventoryMoveInFlightKeys = new Set();

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

function setGroceryMoveToPantryReadyState(button, {
  checked = false,
  probablyPantryItem = false,
} = {}) {
  if (!button) return;
  button.classList.toggle('g-move-to-pantry-ready', !!checked && !!probablyPantryItem);
}

/** @returns {'God mode' | 'Demo mode' | 'Read-only mode'} */
function impersonationReadOnlyModeLabel() {
  if (!lastMePayload || !lastMePayload.isImpersonating) return 'Read-only mode';
  return lastMePayload.isGlobalAdmin === true ? 'God mode' : 'Demo mode';
}

function impersonationReadOnlyNoticeText() {
  const mode = impersonationReadOnlyModeLabel();
  if (mode === 'Read-only mode') {
    return 'Read-only mode. Exit to make changes.';
  }
  if (mode === 'God mode') {
    return 'God Mode is read-only. Exit God Mode to make changes.';
  }
  return 'Demo mode is read-only. Exit Demo Mode to make changes.';
}

/** Maps server 403 God Mode copy to Demo Mode when the session is read-only Demo impersonation. */
function mapServerReadOnlyErrorMessage(rawError) {
  const s = rawError == null ? '' : String(rawError);
  if (!godModeReadOnly || !lastMePayload || !lastMePayload.isImpersonating) {
    return s || 'Request failed.';
  }
  if (/God Mode is read-only|Exit God Mode to make changes/i.test(s)) {
    return impersonationReadOnlyNoticeText();
  }
  return s || 'Request failed.';
}

function applyGodModeFromMe(data) {
  if (data && typeof data.name === 'string' && data.householdId != null) {
    lastMePayload = data;
  }
  const ro = !!(data && data.impersonationReadOnly && data.isImpersonating);
  godModeReadOnly = ro;
  const banner = document.getElementById('god-mode-banner');
  const textEl = document.getElementById('god-mode-banner-text');
  if (banner && textEl) {
    if (data && data.isImpersonating) {
      textEl.textContent = '';
      const strong = document.createElement('strong');
      strong.textContent =
        'Viewing as ' +
        String(data.name || 'user') +
        ' in ' +
        String(data.householdName || 'this household');
      textEl.appendChild(strong);
      textEl.appendChild(document.createElement('br'));
      const sub = document.createElement('span');
      sub.style.opacity = '0.92';
      sub.textContent =
        data.isGlobalAdmin === true ? 'Read-only God Mode' : 'Read-only Demo Mode';
      textEl.appendChild(sub);
      banner.style.display = 'flex';
      const exitBtn = document.getElementById('god-mode-exit-btn');
      if (exitBtn) {
        exitBtn.textContent =
          data.isGlobalAdmin === true ? 'Exit God Mode' : 'Exit Demo Mode';
      }
    } else {
      textEl.textContent = '';
      banner.style.display = 'none';
      const exitBtn = document.getElementById('god-mode-exit-btn');
      if (exitBtn) exitBtn.textContent = 'Exit God Mode';
    }
  }
  if (promptInput) {
    promptInput.readOnly = ro;
    promptInput.style.opacity = ro ? '0.65' : '';
  }
  if (sendButton) {
    sendButton.disabled = ro;
    sendButton.style.opacity = ro ? '0.5' : '';
  }
  if (newChatButton) {
    newChatButton.disabled = ro;
    newChatButton.style.opacity = ro ? '0.5' : '';
  }
  const gas = document.getElementById('settings-anthropic-owner-key-save');
  const sas = document.getElementById('settings-add-submit');
  const adminModeSave = document.getElementById('admin-anthropic-mode-save');
  const adminNewHh = document.getElementById('admin-new-hh-submit');
  if (gas) gas.disabled = ro;
  if (sas) sas.disabled = ro;
  if (adminModeSave) adminModeSave.disabled = ro;
  if (adminNewHh) adminNewHh.disabled = ro;
  if (groceryAddName) {
    groceryAddName.readOnly = ro;
    groceryAddName.style.opacity = ro ? '0.65' : '';
  }
  if (groceryAddAmount) {
    groceryAddAmount.readOnly = ro;
    groceryAddAmount.style.opacity = ro ? '0.65' : '';
  }
  if (groceryAddSection) groceryAddSection.disabled = ro;
  if (groceryAddSubmit) groceryAddSubmit.disabled = ro;
  if (groceryClearButton) groceryClearButton.disabled = ro;
  if (pantryAddName) {
    pantryAddName.readOnly = ro;
    pantryAddName.style.opacity = ro ? '0.65' : '';
  }
  if (pantryAddAmount) {
    pantryAddAmount.readOnly = ro;
    pantryAddAmount.style.opacity = ro ? '0.65' : '';
  }
  if (pantryAddSection) pantryAddSection.disabled = ro;
  if (pantryAddSubmit) pantryAddSubmit.disabled = ro;
  if (cookbookDetailEdit) cookbookDetailEdit.disabled = ro;
  if (cookbookDetailSave) cookbookDetailSave.disabled = ro;
  if (cookbookDetailTitle) cookbookDetailTitle.disabled = ro || !cookbookDetailEditing;
  if (cookbookDetailCategory) cookbookDetailCategory.disabled = ro || !cookbookDetailEditing;
  if (cookbookDetailSummary) cookbookDetailSummary.disabled = ro || !cookbookDetailEditing;
  if (cookbookDetailIngredients) cookbookDetailIngredients.disabled = ro || !cookbookDetailEditing;
  if (cookbookDetailInstructions) cookbookDetailInstructions.disabled = ro || !cookbookDetailEditing;
  if (cookbookDetailNotes) cookbookDetailNotes.disabled = ro || !cookbookDetailEditing;
  if (cookbookDetailTags) cookbookDetailTags.disabled = ro || !cookbookDetailEditing;
}

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
          if (currentGroceriesSubview === 'thisweek') {
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

function setActiveTab(tab) {
  tabChat.classList.toggle('tab-active', tab === 'chat');
  tabGroceries.classList.toggle('tab-active', tab === 'groceries');
  if (tabSettings) tabSettings.classList.toggle('tab-active', tab === 'settings');
  chat.style.display = tab === 'chat' ? 'flex' : 'none';
  groceryPanel.style.display = tab === 'groceries' ? 'flex' : 'none';
  if (settingsPanel) settingsPanel.style.display = tab === 'settings' ? 'flex' : 'none';
  if (inputArea) inputArea.style.display = tab === 'chat' ? 'flex' : 'none';
  if (tab === 'groceries') setGroceriesSubview(currentGroceriesSubview);
  if (tab === 'settings') loadSettingsPanel();
  if (tab === 'chat') renderThisWeekStrip();
  else if (thisweekStrip) thisweekStrip.style.display = 'none';
}

function reapplyVisibleAppTab() {
  if (!appArea || appArea.style.display === 'none') return;
  if (isCookbookHash()) {
    setActiveTab('groceries');
    setGroceriesSubview('cookbook');
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


function clearHouseholdDefaultsUiMessage() {
  const el = document.getElementById('my-settings-defaults-msg');
  clearSettingsUiMessage(el);
}

function setSettingsUiMessage(el, text, { sticky = false } = {}) {
  if (!el) return;
  el.textContent = text || '';
  el.dataset.sticky = sticky && text ? 'true' : 'false';
}

function clearSettingsUiMessage(el, { force = false } = {}) {
  if (!el) return;
  if (!force && el.dataset.sticky === 'true') return;
  el.textContent = '';
  el.dataset.sticky = 'false';
}

function clearStickySettingsMessages() {
  clearSettingsUiMessage(document.getElementById('my-settings-defaults-msg'), { force: true });
  clearSettingsUiMessage(document.getElementById('my-settings-msg'), { force: true });
  clearSettingsUiMessage(document.getElementById('settings-anthropic-owner-key-msg'), { force: true });
}


async function loadHouseholdDefaultsEditor() {
  const portionsEl = document.getElementById('my-settings-defaults-portions');
  const styleEl = document.getElementById('my-settings-defaults-style');
  const assistantNameEl = document.getElementById('my-settings-defaults-assistant-name');
  const assistantToneEl = document.getElementById('my-settings-defaults-assistant-tone');
  const msgEl = document.getElementById('my-settings-defaults-msg');
  if (!portionsEl || !styleEl || !assistantNameEl || !assistantToneEl || !isCurrentUserOwner) return;
  try {
    const r = await fetch('/settings/household/defaults');
    if (!r.ok) {
      if (msgEl) msgEl.textContent = 'Could not load KitchenBot settings.';
      return;
    }
    const data = await r.json();
    const defaults = data.defaults || {};
    portionsEl.value =
      defaults.defaultDinnerPortions == null || !Number.isFinite(Number(defaults.defaultDinnerPortions))
        ? ''
        : String(Number(defaults.defaultDinnerPortions));
    styleEl.value = defaults.weeknightCookingStyle || 'normal';
    assistantNameEl.value = defaults.assistantName || 'KitchenBot';
    assistantToneEl.value = normalizeToneValue(defaults.assistantTone);
    currentAssistantName = defaults.assistantName || 'KitchenBot';
    clearSettingsUiMessage(msgEl);
  } catch (e) {
    setSettingsUiMessage(msgEl, 'Load failed.');
  }
}

async function loadMyHouseholdView() {
  const msgEl = document.getElementById('my-settings-msg');
  const idEl = document.getElementById('my-settings-hh-id');
  const nameEl = document.getElementById('my-settings-hh-name');
  const keyEl = document.getElementById('my-settings-hh-key');
  const listEl = document.getElementById('my-settings-users-list');
  if (!listEl || !idEl || !nameEl || !keyEl) return;
  try {
    const r = await fetch('/settings/household');
    if (!r.ok) {
      if (msgEl) msgEl.textContent = 'Could not load settings.';
      return;
    }
    const data = await r.json();
    isCurrentUserOwner = true; // owner/member distinction removed — every member can manage household settings
    currentAssistantName =
      (data.defaults && typeof data.defaults.assistantName === 'string' && data.defaults.assistantName.trim()) ||
      currentAssistantName ||
      'KitchenBot';
    idEl.textContent = String(data.household.id ?? '');
    nameEl.textContent = data.household.name;
    keyEl.textContent = data.household.key;
    rebuildDisplayNameToColorFromSettingsUsers(data.users);
    if (currentChatId) {
      try {
        await loadHistory();
      } catch (e) {}
    }
    listEl.innerHTML = '';
    for (const u of data.users) {
      const row = document.createElement('div');
      row.className = 'settings-user-row';
      const label = document.createElement('span');
      label.className = 'settings-user-name';
      label.textContent = u.displayName;
      const pinCol = document.createElement('div');
      pinCol.className = 'settings-user-row-role-col';
      const pinRow = document.createElement('div');
      pinRow.className = 'settings-user-inline-controls';
      const pinLbl = document.createElement('span');
      pinLbl.textContent = 'PIN';
      const pinIn = document.createElement('input');
      pinIn.type = 'password';
      pinIn.placeholder = 'new PIN';
      pinIn.autocomplete = 'new-password';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Update PIN';
      const pinFeedback = document.createElement('div');
      pinFeedback.className = 'settings-user-row-role-feedback';
      pinFeedback.setAttribute('aria-live', 'polite');
      let pinSaving = false;
      function syncPinButton() {
        if (pinSaving) return;
        btn.disabled = pinIn.value.trim() === '';
      }
      syncPinButton();
      pinIn.addEventListener('input', () => {
        pinFeedback.textContent = '';
        syncPinButton();
      });
      btn.addEventListener('click', async () => {
        if (pinSaving) return;
        const pin = pinIn.value.trim();
        if (!pin) {
          pinFeedback.textContent = 'Enter a PIN.';
          pinFeedback.style.color = 'var(--text-soft)';
          return;
        }
        pinSaving = true;
        btn.disabled = true;
        pinIn.disabled = true;
        btn.textContent = 'Saving...';
        pinFeedback.textContent = '';
        try {
          const rr = await fetch('/settings/household/users/' + u.id + '/pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin }),
          });
          const errBody = await rr.json().catch(() => ({}));
          if (rr.ok) {
            pinIn.value = '';
            pinFeedback.textContent = 'PIN updated';
            pinFeedback.style.color = 'var(--accent-strong)';
            row.classList.add('settings-user-row-role-flash');
            setTimeout(() => row.classList.remove('settings-user-row-role-flash'), 2000);
          } else {
            pinFeedback.textContent =
              mapServerReadOnlyErrorMessage(errBody.error) || 'Failed to update PIN';
            pinFeedback.style.color = '#b91c1c';
          }
        } catch (e) {
          pinFeedback.textContent = 'Request failed';
          pinFeedback.style.color = '#b91c1c';
        } finally {
          pinSaving = false;
          pinIn.disabled = false;
          btn.textContent = 'Update PIN';
          syncPinButton();
        }
      });
      pinRow.appendChild(pinLbl);
      pinRow.appendChild(pinIn);
      pinRow.appendChild(btn);
      pinCol.appendChild(pinRow);
      pinCol.appendChild(pinFeedback);
      row.appendChild(label);
      // owner/member distinction removed — no per-user Role selector
      row.appendChild(pinCol);
      const prefGrid = document.createElement('div');
      prefGrid.className = 'settings-user-pref-grid';
      const colorCol = document.createElement('div');
      colorCol.className = 'settings-user-row-role-col';
      const colorWrap = document.createElement('div');
      colorWrap.className = 'settings-user-inline-controls';
      const colorLbl = document.createElement('span');
      colorLbl.textContent = 'Chat color';
      const colorSel = document.createElement('select');
      colorSel.setAttribute('aria-label', 'Chat color for ' + u.displayName);
      CHAT_COLOR_OPTIONS.forEach((opt) => {
        const o = document.createElement('option');
        o.value = opt.key;
        o.textContent = opt.label;
        colorSel.appendChild(o);
      });
      colorSel.value = u.chatColor || 'blue';
      let prevChatColor = colorSel.value;
      const colorFeedback = document.createElement('div');
      colorFeedback.className = 'settings-user-row-role-feedback';
      colorFeedback.setAttribute('aria-live', 'polite');
      let chatColorSaving = false;
      colorSel.addEventListener('change', async () => {
        if (chatColorSaving) return;
        const attempted = colorSel.value;
        chatColorSaving = true;
        colorSel.disabled = true;
        colorFeedback.textContent = 'Saving...';
        colorFeedback.style.color = 'var(--text-soft)';
        try {
          const rr = await fetch('/settings/household/users/' + u.id + '/chat-color', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatColor: attempted }),
          });
          const errBody = await rr.json().catch(() => ({}));
          if (rr.ok) {
            displayNameToColor[normalizeDisplayNameKey(u.displayName)] = attempted;
            prevChatColor = attempted;
            colorSel.value = attempted;
            colorFeedback.textContent = 'Chat color updated';
            colorFeedback.style.color = 'var(--accent-strong)';
            row.classList.add('settings-user-row-role-flash');
            setTimeout(() => row.classList.remove('settings-user-row-role-flash'), 2000);
            if (currentChatId) await loadHistory();
          } else {
            colorSel.value = prevChatColor;
            colorFeedback.textContent =
              mapServerReadOnlyErrorMessage(errBody.error) || 'Failed to update chat color';
            colorFeedback.style.color = '#b91c1c';
          }
        } catch (e) {
          colorSel.value = prevChatColor;
          colorFeedback.textContent = 'Request failed';
          colorFeedback.style.color = '#b91c1c';
        } finally {
          chatColorSaving = false;
          colorSel.disabled = false;
        }
      });
      colorWrap.appendChild(colorLbl);
      colorWrap.appendChild(colorSel);
      colorCol.appendChild(colorWrap);
      colorCol.appendChild(colorFeedback);
      prefGrid.appendChild(colorCol);
      row.appendChild(prefGrid);
      listEl.appendChild(row);
    }
    if (msgEl) msgEl.textContent = '';
    await loadHouseholdDefaultsEditor();
  } catch (e) {
    if (msgEl) msgEl.textContent = 'Load failed.';
  }
}

async function loadSettingsPanel() {
  await loadMyHouseholdView(); // sets isCurrentUserOwner from /settings/household
  await refreshOwnerAnthropicUsageView();
  const isGa = await loadAnthropicSection();
  // Owner/member distinction removed (2026-07-23): My preferences, Food profiles,
  // Household, and Usage are for EVERY household member. Only God Mode is gated (to the
  // first bootstrapped user / global admin).
  const householdBtn = document.getElementById('settings-subtab-household-btn');
  if (householdBtn) householdBtn.style.display = 'inline-block';
  const usageBtn = document.getElementById('settings-subtab-usage-btn');
  if (usageBtn) usageBtn.style.display = 'inline-block';
  const subAdminBtn = document.getElementById('settings-subtab-admin-btn');
  if (subAdminBtn) subAdminBtn.style.display = isGa ? 'inline-block' : 'none';
  if (currentSettingsSubView === 'admin' && !isGa) {
    currentSettingsSubView = 'my';
  }
  if (isGa) {
    await loadGlobalAdminView();
  }
  showSettingsSubView(currentSettingsSubView);
  if (lastMePayload) applyGodModeFromMe(lastMePayload);
}

function loadGlobalAdminView() {
  return refreshAdminHouseholdsList();
}

const SETTINGS_SUBVIEWS = {
  my: { view: 'settings-view-my', btn: 'settings-subtab-my-btn', gated: false },
  family: { view: 'settings-view-family', btn: 'settings-subtab-family-btn', gated: false },
  household: { view: 'settings-view-household', btn: 'settings-subtab-household-btn', gated: false },
  usage: { view: 'settings-view-usage', btn: 'settings-subtab-usage-btn', gated: false },
  admin: { view: 'settings-view-admin', btn: 'settings-subtab-admin-btn', gated: true },
};

function showSettingsSubView(view) {
  if (!SETTINGS_SUBVIEWS[view]) view = 'my';
  // A gated view whose tab is hidden (not owner/admin) falls back to My preferences.
  const reqBtn = document.getElementById(SETTINGS_SUBVIEWS[view].btn);
  if (SETTINGS_SUBVIEWS[view].gated && reqBtn && reqBtn.style.display === 'none') view = 'my';
  currentSettingsSubView = view;
  for (const key of Object.keys(SETTINGS_SUBVIEWS)) {
    const conf = SETTINGS_SUBVIEWS[key];
    const v = document.getElementById(conf.view);
    const b = document.getElementById(conf.btn);
    if (v) v.style.display = key === view ? 'block' : 'none';
    if (b) b.classList.toggle('settings-subtab-active', key === view);
  }
  if (view === 'family') loadFamilyProfiles();
}

async function loadFamilyProfiles() {
  const listEl = document.getElementById('family-profiles-list');
  const emptyEl = document.getElementById('family-profiles-empty');
  if (!listEl) return;
  let profiles = [];
  try {
    const r = await fetch('/family/profiles', { credentials: 'same-origin' });
    if (r.ok) profiles = (await r.json()).profiles || [];
  } catch (e) {
    /* leave empty */
  }
  listEl.innerHTML = '';
  const anyData = profiles.some(
    (p) => p.acceptedFoods.length || p.rejectedFoods.length || p.allergies.length || p.notes.length
  );
  if (emptyEl) {
    emptyEl.style.display = profiles.length === 0 || !anyData ? 'block' : 'none';
    emptyEl.textContent =
      profiles.length === 0
        ? 'No household members yet.'
        : 'No food notes yet — add likes, dislikes, or allergies below, or just tell KitchenBot in chat.';
  }
  const readOnly = !!godModeReadOnly;
  const postJson = (url, body) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
  for (const p of profiles) {
    const card = document.createElement('section');
    card.className = 'settings-card';
    const h = document.createElement('h3');
    h.textContent = p.person;
    h.style.marginTop = '0';
    card.appendChild(h);
    const group = (label, field, values, tone) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'margin:8px 0;';
      const lab = document.createElement('div');
      lab.textContent = label;
      lab.style.cssText =
        'font-size:12px;font-weight:700;color:var(--text-soft);text-transform:uppercase;letter-spacing:.03em;margin-bottom:4px;';
      wrap.appendChild(lab);
      const chips = document.createElement('div');
      chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
      if (!values.length) {
        const none = document.createElement('span');
        none.textContent = '—';
        none.style.color = 'var(--text-soft)';
        chips.appendChild(none);
      }
      for (const v of values) {
        const chip = document.createElement('span');
        chip.style.cssText =
          // Fixed rounded-RECTANGLE radius, not a 999px pill: a pill radius makes a value
          // that wraps to multiple lines (a long "won't eat", or a Notes line) bleed past
          // the over-curved corners. Also top-align the × so it sits at the first line.
          'display:inline-flex;align-items:flex-start;gap:5px;padding:4px 9px;border-radius:10px;font-size:13px;border:1px solid var(--border-subtle);' +
          (tone === 'allergy' ? 'background:#fef2f2;color:#b91c1c;border-color:#fecaca;' : 'background:var(--card-bg-2);color:var(--text);');
        chip.appendChild(document.createTextNode(v));
        if (!readOnly) {
          const x = document.createElement('button');
          x.type = 'button';
          x.textContent = '×';
          x.title = 'Remove';
          x.style.cssText = 'border:none;background:none;cursor:pointer;font-size:15px;line-height:1;color:inherit;padding:0;';
          x.addEventListener('click', async () => {
            await postJson('/family/profiles/remove', { person: p.person, field, value: v });
            loadFamilyProfiles();
          });
          chip.appendChild(x);
        }
        chips.appendChild(chip);
      }
      wrap.appendChild(chips);
      return wrap;
    };
    card.appendChild(group('Allergies', 'allergies', p.allergies, 'allergy'));
    card.appendChild(group('Likes', 'acceptedFoods', p.acceptedFoods));
    card.appendChild(group("Won't eat", 'rejectedFoods', p.rejectedFoods));
    if (p.notes && p.notes.length) card.appendChild(group('Notes', 'notes', p.notes));
    if (!readOnly) {
      const addRow = document.createElement('div');
      addRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:10px;';
      const sel = document.createElement('select');
      sel.style.cssText = 'padding:6px 8px;border-radius:8px;border:1px solid var(--border-subtle);font-size:13px;';
      [
        ['acceptedFoods', 'Likes'],
        ['rejectedFoods', "Won't eat"],
        ['allergies', 'Allergy'],
        ['notes', 'Note'],
      ].forEach(([val, txt]) => {
        const o = document.createElement('option');
        o.value = val;
        o.textContent = txt;
        sel.appendChild(o);
      });
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = 'Add a food or note…';
      inp.style.cssText = 'flex:1;min-width:140px;padding:6px 10px;border-radius:8px;border:1px solid var(--border-subtle);font-size:13px;';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Add';
      const submit = async () => {
        const value = inp.value.trim();
        if (!value) return;
        await postJson('/family/profiles/add', { person: p.person, field: sel.value, value });
        inp.value = '';
        loadFamilyProfiles();
      };
      btn.addEventListener('click', submit);
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submit();
        }
      });
      addRow.appendChild(sel);
      addRow.appendChild(inp);
      addRow.appendChild(btn);
      card.appendChild(addRow);
    }
    listEl.appendChild(card);
  }
}

function updateAdminAnthropicFormVisibility() {
  const sharedRadio = document.getElementById('admin-anthropic-mode-shared');
  const help = document.getElementById('admin-anthropic-shared-help');
  const isShared = sharedRadio && sharedRadio.checked;
  if (help) help.style.display = isShared ? 'block' : 'none';
}

function escapeAdminHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatAdminUsageUsd(value, available = true) {
  if (!available) return 'Unavailable';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'Unavailable';
  return '$' + n.toFixed(4);
}

function collapseUsagePreviewText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function truncateUsagePreviewText(value, limit = 80) {
  const text = collapseUsagePreviewText(value);
  if (!text) return '';
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - 1)).trimEnd() + '…';
}

function renderAdminUsageSection(title, rows, labelKey, description) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return (
      '<section class="admin-report-section"><h5>' +
      escapeAdminHtml(title) +
      '</h5>' +
      (description
        ? '<div class="admin-report-note">' + escapeAdminHtml(description) + '</div>'
        : '') +
      '<div class="admin-report-empty">No rows.</div></section>'
    );
  }
  let html =
    '<section class="admin-report-section"><h5>' +
    escapeAdminHtml(title) +
    '</h5>' +
    (description
      ? '<div class="admin-report-note">' + escapeAdminHtml(description) + '</div>'
      : '') +
    '<div class="admin-report-table-wrap"><table class="admin-report-table">' +
    '<thead><tr><th>' +
    escapeAdminHtml(labelKey) +
    '</th><th class="num">Calls</th><th class="num">In</th><th class="num">Out</th><th class="num">Est. cost</th></tr></thead><tbody>';
  for (const row of rows) {
    const label = row.householdName || row.key || '—';
    html +=
      '<tr><td>' +
      escapeAdminHtml(label) +
      '</td><td class="num">' +
      escapeAdminHtml(row.callCount != null ? row.callCount : 0) +
      '</td><td class="num">' +
      escapeAdminHtml(row.inputTokens != null ? row.inputTokens : 0) +
      '</td><td class="num">' +
      escapeAdminHtml(row.outputTokens != null ? row.outputTokens : 0) +
      '</td><td class="num">' +
      escapeAdminHtml(
        formatAdminUsageUsd(
          row.estimatedCostUsd,
          row.estimatedCostAvailable !== false
        )
      ) +
      '</td></tr>';
  }
  html += '</tbody></table></div></section>';
  return html;
}

function renderAnthropicUsageReportInto(root, reportData, options = {}) {
  if (!root) return;
  if (!reportData || !reportData.totals) {
    root.innerHTML = '<span class="admin-report-empty">No usage data yet.</span>';
    return;
  }
  const includeByHousehold = options.includeByHousehold !== false;
  const includeHouseholdColumn = options.includeHouseholdColumn !== false;
  const includeDebugColumns = options.includeDebugColumns !== false;
  const title = options.title || 'Anthropic call ledger';
  const totals = reportData.totals || {};
  let html = '<div class="admin-report-title">' + escapeAdminHtml(title) + '</div>';
  if (reportData.household && options.statusNote !== false) {
    html +=
      '<div class="admin-report-note" style="margin-bottom:10px;">' +
      escapeAdminHtml(reportData.household.statusText || '') +
      '</div>';
  }
  html += '<div class="admin-report-stats">';
  html += '<div class="admin-report-stat"><span class="label">Calls</span><span class="value">' + escapeAdminHtml(totals.callCount != null ? totals.callCount : 0) + '</span></div>';
  html += '<div class="admin-report-stat"><span class="label">Input tokens</span><span class="value">' + escapeAdminHtml(totals.inputTokens != null ? totals.inputTokens : 0) + '</span></div>';
  html += '<div class="admin-report-stat"><span class="label">Output tokens</span><span class="value">' + escapeAdminHtml(totals.outputTokens != null ? totals.outputTokens : 0) + '</span></div>';
  html += '<div class="admin-report-stat"><span class="label">Estimated cost</span><span class="value">' +
    escapeAdminHtml(
      formatAdminUsageUsd(
        totals.estimatedCostUsd,
        totals.estimatedCostAvailable !== false
      )
    ) +
    '</span></div>';
  const cacheReadTokens = Number(totals.cacheReadInputTokens || 0);
  const cacheCreateTokens = Number(totals.cacheCreationInputTokens || 0);
  const freshInputTokens = Number(totals.inputTokens || 0);
  const inputSideTokens = freshInputTokens + cacheReadTokens + cacheCreateTokens;
  const cachedPct = inputSideTokens > 0 ? Math.round((cacheReadTokens / inputSideTokens) * 100) : 0;
  const cachingSavingsUsd =
    totals.estimatedCostWithoutCacheUsd != null && totals.estimatedCostUsd != null
      ? Number(totals.estimatedCostWithoutCacheUsd) - Number(totals.estimatedCostUsd)
      : null;
  if (cacheReadTokens > 0 || cacheCreateTokens > 0) {
    html += '<div class="admin-report-stat"><span class="label">Cached reads</span><span class="value">' + escapeAdminHtml(cacheReadTokens) + '</span></div>';
    if (cachingSavingsUsd != null && cachingSavingsUsd > 0) {
      html += '<div class="admin-report-stat"><span class="label">Saved by caching</span><span class="value">' + escapeAdminHtml(formatAdminUsageUsd(cachingSavingsUsd, true)) + '</span></div>';
    }
  }
  html += '</div>';
  if (cacheReadTokens > 0) {
    html += '<div class="admin-report-note" style="margin-top:6px;">' + escapeAdminHtml(cachedPct + '% of input tokens were served from cache (billed at ~1/10th the price of fresh input).') + '</div>';
  }
  html += '<div class="admin-report-grid">';
  html += renderAdminUsageSection(
    'Where usage went',
    reportData.byFunction || [],
    'Function',
    'A single visible KitchenBot turn usually spans several Anthropic calls — the brain loop that reasons and writes the reply, plus a truthfulness check, context loading, and titling.'
  );
  if (includeByHousehold) {
    html += renderAdminUsageSection('By household', reportData.byHousehold || [], 'Household');
  }
  html += '</div>';
  const recentRows = Array.isArray(reportData.recentRows) ? reportData.recentRows : [];
  html += '<section class="admin-report-section" style="margin-top:12px;"><h5>Recent calls</h5>';
  html += '<div class="admin-report-note">This table shows Anthropic calls made during KB turns, not every visible KitchenBot message. Some replies come from deterministic outcome text and do not create a separate ledger row.</div>';
  if (recentRows.length === 0) {
    html += '<div class="admin-report-empty">No rows.</div>';
  } else {
    html +=
      '<div class="admin-report-table-wrap"><table class="admin-report-table">' +
      '<thead><tr><th>Time</th>' +
      (includeHouseholdColumn ? '<th>Household</th>' : '') +
      '<th>Purpose</th><th>Query / Prompt</th>' +
      '<th>Model</th><th class="num">In</th><th class="num">Out</th><th class="num">Cost</th></tr></thead><tbody>';
    for (const row of recentRows) {
      const fullQueryOrPrompt = collapseUsagePreviewText(row.actionQuery || row.promptExcerpt || '');
      const queryOrPrompt = truncateUsagePreviewText(fullQueryOrPrompt, 80) || '—';
      html +=
        '<tr><td>' +
        escapeAdminHtml(row.createdAt || '—') +
        '</td>' +
        (includeHouseholdColumn
          ? '<td>' + escapeAdminHtml(row.householdName || row.householdId || '—') + '</td>'
          : '') +
        '<td>' +
        escapeAdminHtml(row.callPurpose || '—') +
        '</td>' +
        '<td title="' + escapeAdminHtml(fullQueryOrPrompt || '—') + '">' + escapeAdminHtml(queryOrPrompt) + '</td>' +
        '<td>' +
        escapeAdminHtml(row.model || '—') +
        '</td><td class="num">' +
        escapeAdminHtml(row.inputTokens != null ? row.inputTokens : 0) +
        '</td><td class="num">' +
        escapeAdminHtml(row.outputTokens != null ? row.outputTokens : 0) +
        '</td><td class="num">' +
        escapeAdminHtml(formatAdminUsageUsd(row.estimatedCostUsd, row.estimatedCostUsd != null)) +
        '</td></tr>';
    }
    html += '</tbody></table></div>';
  }
  html += '</section>';
  html += renderAdminUsageSection(
    'Raw internal purposes',
    reportData.byPurpose || [],
    'Purpose',
    'This is the low-level engineering breakdown of the raw call_purpose values written to the ledger.'
  );
  root.innerHTML = html;
}

function renderAdminUsageReport(reportData) {
  const root = document.getElementById('admin-usage-report');
  renderAnthropicUsageReportInto(root, reportData, {
    includeByHousehold: true,
    includeHouseholdColumn: true,
    title: 'Anthropic call ledger',
    statusNote: false,
  });
}

function renderOwnerAnthropicUsageReport(reportData) {
  const root = document.getElementById('owner-usage-report');
  renderAnthropicUsageReportInto(root, reportData, {
    includeByHousehold: false,
    includeHouseholdColumn: false,
    title: 'Household Anthropic usage',
    statusNote: false,
  });
  const noteEl = document.getElementById('owner-usage-status-note');
  if (noteEl) {
    const household = reportData && reportData.household;
    noteEl.textContent = household ? household.statusText : '';
  }
}

async function refreshAdminUsageReport() {
  const msgEl = document.getElementById('admin-usage-msg');
  const reportEl = document.getElementById('admin-usage-report');
  const startEl = document.getElementById('admin-usage-start-date');
  const endEl = document.getElementById('admin-usage-end-date');
  const hhEl = document.getElementById('admin-usage-household-select');
  if (!reportEl || !startEl || !endEl || !hhEl) return;
  if (msgEl) msgEl.textContent = 'Loading usage…';
  try {
    const qs = new URLSearchParams();
    if (startEl.value) qs.set('startDate', startEl.value);
    if (endEl.value) qs.set('endDate', endEl.value);
    if (hhEl.value && hhEl.value !== 'all') qs.set('householdId', hhEl.value);
    const r = await fetch('/admin/usage-report?' + qs.toString());
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (msgEl) msgEl.textContent = data.error || 'Failed to load usage.';
      return;
    }
    renderAdminUsageReport(data);
    if (msgEl) msgEl.textContent = '';
  } catch (e) {
    if (msgEl) msgEl.textContent = 'Failed to load usage.';
  }
}

async function refreshOwnerAnthropicUsageReport() {
  const msgEl = document.getElementById('owner-usage-msg');
  const reportEl = document.getElementById('owner-usage-report');
  const startEl = document.getElementById('owner-usage-start-date');
  const endEl = document.getElementById('owner-usage-end-date');
  if (!reportEl || !startEl || !endEl) return;
  if (msgEl) msgEl.textContent = 'Loading usage…';
  try {
    const qs = new URLSearchParams();
    if (startEl.value) qs.set('startDate', startEl.value);
    if (endEl.value) qs.set('endDate', endEl.value);
    const r = await fetch('/settings/household/anthropic-usage?' + qs.toString());
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (msgEl) msgEl.textContent = data.error || 'Failed to load usage.';
      return;
    }
    renderOwnerAnthropicUsageReport(data);
    if (msgEl) msgEl.textContent = '';
  } catch (e) {
    if (msgEl) msgEl.textContent = 'Failed to load usage.';
  }
}

function renderAdminHouseholdDetail(detailData) {
  const hh = detailData && detailData.household;
  if (!hh) return;
  const usage = detailData.usage;
  const nameEl = document.getElementById('admin-detail-name');
  const keyEl = document.getElementById('admin-detail-key');
  const tbody = document.getElementById('admin-detail-users-body');
  const banner = document.getElementById('admin-editing-banner');
  const usageEl = document.getElementById('admin-detail-usage');
  const pinGlobalMsg = document.getElementById('admin-pin-global-msg');
  if (pinGlobalMsg) pinGlobalMsg.textContent = '';
  if (nameEl) nameEl.textContent = hh.name;
  if (keyEl) keyEl.textContent = hh.householdKey;
  if (banner) {
    banner.textContent =
      'Editing: #' + hh.id + ' — ' + hh.name + ' (household key: ' + hh.householdKey + ')';
  }
  if (usageEl) {
    if (usage) {
      let html =
        '<div class="settings-admin-usage-summary"><h5>Message usage (stored messages)</h5>' +
        '<div>Total messages (this household): <strong>' +
        (usage.totalMessages != null ? usage.totalMessages : 0) +
        '</strong></div>';
      html +=
        '<div style="margin-top:6px;">Latest message: <strong>' +
        (usage.latestMessageAt ? String(usage.latestMessageAt) : '—') +
        '</strong></div>';
      html += '<div style="margin-top:10px; font-size:12px; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-soft);">User messages by name</div>';
      const rows = usage.messagesByUser || [];
      if (rows.length === 0) {
        html += '<div class="admin-report-empty" style="margin-top:6px;">No user messages yet.</div>';
      } else {
        html += '<ul>';
        for (const row of rows) {
          html +=
            '<li>' +
            escapeAdminHtml(row.displayName || '—') +
            ': ' +
            (row.count != null ? row.count : 0) +
            '</li>';
        }
        html += '</ul>';
      }
      html += '</div>';
      usageEl.innerHTML = html;
    } else {
      usageEl.innerHTML = '';
    }
  }
  if (tbody) {
    tbody.innerHTML = '';
    for (const u of hh.users || []) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      td1.textContent = u.displayName;
      const td3 = document.createElement('td');
      const pinIn = document.createElement('input');
      pinIn.type = 'password';
      pinIn.placeholder = 'new PIN';
      pinIn.autocomplete = 'new-password';
      pinIn.style.maxWidth = '120px';
      pinIn.disabled = godModeReadOnly;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Set PIN';
      btn.style.marginLeft = '8px';
      btn.disabled = godModeReadOnly;
      btn.addEventListener('click', async () => {
        const pin = pinIn.value.trim();
        if (!pin) {
          if (pinGlobalMsg) pinGlobalMsg.textContent = 'Enter a PIN for ' + u.displayName + '.';
          return;
        }
        const rr = await fetch(
          '/admin/households/' + encodeURIComponent(hh.id) + '/users/' + encodeURIComponent(u.id) + '/pin',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin }),
          }
        );
        const errBody = await rr.json().catch(() => ({}));
        if (pinGlobalMsg) {
          pinGlobalMsg.textContent = rr.ok
            ? 'PIN updated for #' + hh.id + ' — ' + hh.name + ' / user "' + u.displayName + '" (id ' + u.id + ').'
            : mapServerReadOnlyErrorMessage(errBody.error) || 'Failed to update PIN.';
        }
        if (rr.ok) pinIn.value = '';
      });
      td3.appendChild(pinIn);
      td3.appendChild(btn);
      const td4 = document.createElement('td');
      if (!godModeReadOnly) {
        const viewAsBtn = document.createElement('button');
        viewAsBtn.type = 'button';
        viewAsBtn.textContent = 'View as';
        viewAsBtn.addEventListener('click', async () => {
          try {
            const rr = await fetch('/admin/impersonate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ householdId: hh.id, userId: u.id }),
            });
            const errBody = await rr.json().catch(() => ({}));
            if (!rr.ok) {
              if (pinGlobalMsg) {
                pinGlobalMsg.textContent = errBody.error || 'Could not start God Mode.';
              }
              return;
            }
            const meR = await fetch('/me');
            if (!meR.ok) {
              showLogin();
              return;
            }
            const meData = await meR.json();
            await rehydrateAuthenticatedApp(meData, { forceChatTab: true, resetSessionView: true });
          } catch (e) {
            if (pinGlobalMsg) pinGlobalMsg.textContent = 'Request failed.';
          }
        });
        td4.appendChild(viewAsBtn);
      } else {
        td4.textContent = '—';
      }
      tr.appendChild(td1);
      tr.appendChild(td3);
      tr.appendChild(td4);
      tbody.appendChild(tr);
    }
  }
}

async function loadAdminAnthropicForSelected() {
  const sel = document.getElementById('admin-anthropic-household-select');
  const hid = sel && sel.value ? Number(sel.value) : NaN;
  const sharedRadio = document.getElementById('admin-anthropic-mode-shared');
  const hhRadio = document.getElementById('admin-anthropic-mode-household');
  const statEl = document.getElementById('admin-anthropic-selected-status');
  const msgEl = document.getElementById('admin-anthropic-msg');
  if (!sharedRadio || !hhRadio || !Number.isFinite(hid)) return;
  try {
    const rDetail = await fetch('/admin/households/' + encodeURIComponent(hid));
    if (rDetail.ok) {
      const detailData = await rDetail.json();
      if (detailData.household) {
        renderAdminHouseholdDetail(detailData);
        if (cachedAdminHouseholds) {
          const ix = cachedAdminHouseholds.findIndex((h) => h.id === hid);
          if (ix >= 0) cachedAdminHouseholds[ix] = detailData.household;
        }
      }
    }
    const r = await fetch('/settings/anthropic?householdId=' + encodeURIComponent(hid));
    if (!r.ok) return;
    const d = await r.json();
    if (d.household.anthropicKeyMode === 'household') {
      hhRadio.checked = true;
    } else {
      sharedRadio.checked = true;
    }
    if (statEl) {
      statEl.textContent =
        'Anthropic: ' +
        (d.statusBrief || d.statusText || '') +
        ' · Runtime: Smart only';
    }
    updateAdminAnthropicFormVisibility();
    if (msgEl) msgEl.textContent = '';
  } catch (e) {}
}

async function refreshAdminHouseholdsList() {
  const listEl = document.getElementById('settings-admin-households-list');
  const sel = document.getElementById('admin-anthropic-household-select');
  const usageSel = document.getElementById('admin-usage-household-select');
  if (!listEl && !sel && !usageSel) return;
  try {
    const r = await fetch('/admin/households');
    if (!r.ok) return;
    const data = await r.json();
    const households = data.households || [];
    cachedAdminHouseholds = households;
    const prevSel = sel && sel.value;
    const prevUsageSel = usageSel && usageSel.value;
    if (listEl) {
      listEl.innerHTML = '';
      listEl.className = 'settings-admin-household-list';
      for (const hh of households) {
        const row = document.createElement('div');
        row.className = 'settings-admin-household-row';
        const main = document.createElement('div');
        main.className = 'settings-admin-household-row-main';
        const n =
          hh.totalMessages != null && Number.isFinite(Number(hh.totalMessages))
            ? Number(hh.totalMessages)
            : 0;
        const msgLabel = n === 1 ? 'msg' : 'msgs';
        const name = document.createElement('strong');
        name.className = 'settings-admin-household-name';
        name.textContent = '#' + hh.id + ' — ' + hh.name;
        const meta = document.createElement('div');
        meta.className = 'settings-admin-household-meta';
        meta.textContent =
          'Key ' +
          hh.householdKey +
          ' • ' +
          n +
          ' ' +
          msgLabel +
          ' • ' +
          hh.anthropicStatusLabel;
        main.appendChild(name);
        main.appendChild(meta);
        const tags = document.createElement('div');
        tags.className = 'settings-admin-household-tags';
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'settings-admin-household-delete';
        delBtn.textContent = 'Delete';
        delBtn.style.marginLeft = 'auto';
        delBtn.addEventListener('click', async () => {
          const typed = window.prompt(
            'Permanently delete household "' + hh.name + '" and ALL of its data (users, chats, lists, cookbook — everything). This cannot be undone.\\n\\nType the household name to confirm:'
          );
          if (typed == null) return;
          if (typed.trim() !== String(hh.name).trim()) {
            window.alert('Name did not match — nothing was deleted.');
            return;
          }
          try {
            const dr = await fetch('/admin/households/' + encodeURIComponent(hh.id), {
              method: 'DELETE',
              credentials: 'same-origin',
            });
            const data = await dr.json().catch(() => ({}));
            if (!dr.ok) {
              window.alert(data.error || 'Delete failed.');
              return;
            }
            await refreshAdminHouseholdsList();
          } catch (e) {
            window.alert('Delete failed.');
          }
        });
        tags.appendChild(delBtn);
        row.appendChild(main);
        row.appendChild(tags);
        listEl.appendChild(row);
      }
    }
    if (sel) {
      sel.innerHTML = '';
      for (const hh of households) {
        const opt = document.createElement('option');
        opt.value = String(hh.id);
        opt.textContent = '#' + hh.id + ' — ' + hh.name;
        sel.appendChild(opt);
      }
      if (prevSel && households.some((h) => String(h.id) === prevSel)) {
        sel.value = prevSel;
      } else if (households.length) {
        sel.selectedIndex = 0;
      }
      await loadAdminAnthropicForSelected();
    }
    if (usageSel) {
      usageSel.innerHTML = '';
      const allOpt = document.createElement('option');
      allOpt.value = 'all';
      allOpt.textContent = 'All households';
      usageSel.appendChild(allOpt);
      for (const hh of households) {
        const opt = document.createElement('option');
        opt.value = String(hh.id);
        opt.textContent = '#' + hh.id + ' — ' + hh.name;
        usageSel.appendChild(opt);
      }
      if (prevUsageSel && (prevUsageSel === 'all' || households.some((h) => String(h.id) === prevUsageSel))) {
        usageSel.value = prevUsageSel;
      } else {
        usageSel.value = 'all';
      }
    }
    await refreshAdminUsageReport();
  } catch (e) {}
}

function initializeAdminUsageFilters() {
  const startEl = document.getElementById('admin-usage-start-date');
  const endEl = document.getElementById('admin-usage-end-date');
  if (!startEl || !endEl) return;
  if (!endEl.value) {
    const end = new Date();
    endEl.value = end.toISOString().slice(0, 10);
  }
  if (!startEl.value) {
    const start = new Date();
    start.setDate(start.getDate() - 7);
    startEl.value = start.toISOString().slice(0, 10);
  }
}

function initializeOwnerUsageFilters() {
  const startEl = document.getElementById('owner-usage-start-date');
  const endEl = document.getElementById('owner-usage-end-date');
  if (!startEl || !endEl) return;
  if (!endEl.value) {
    const end = new Date();
    endEl.value = end.toISOString().slice(0, 10);
  }
  if (!startEl.value) {
    const start = new Date();
    start.setDate(start.getDate() - 7);
    startEl.value = start.toISOString().slice(0, 10);
  }
}

async function loadAnthropicSection() {
  const statusEl = document.getElementById('settings-anthropic-status');
  const ownerSection = document.getElementById('settings-anthropic-owner-key-section');
  const ownerKeyInput = document.getElementById('settings-anthropic-owner-key');
  const ownerMsg = document.getElementById('settings-anthropic-owner-key-msg');
  try {
    const r = await fetch('/settings/anthropic');
    if (!r.ok) return false;
    const d = await r.json();
    if (statusEl) {
      statusEl.textContent = d.statusText || '';
    }
    if (ownerSection && ownerKeyInput) {
      if (d.canEditKey) {
        ownerSection.style.display = 'block';
        ownerKeyInput.value = '';
      } else {
        ownerSection.style.display = 'none';
        ownerKeyInput.value = '';
      }
      if (ownerMsg) ownerMsg.textContent = '';
    }
    return !!d.isGlobalAdmin;
  } catch (e) {
    return false;
  }
}

async function refreshOwnerAnthropicUsageView() {
  initializeOwnerUsageFilters();
  await refreshOwnerAnthropicUsageReport();
}

function sendTyping(isTyping) {
  if (godModeReadOnly) return;
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
  if (godModeReadOnly) return;
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

async function loadGroceries() {
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
      checkbox.disabled = godModeReadOnly;
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
        disabled: godModeReadOnly,
        inFlight: isInventoryMoveInFlight('grocery', item.id),
        idleText: 'Move to pantry',
        workingText: 'Moving…',
        title: 'Move to Pantry',
      });
      moveBtn.addEventListener('click', async () => {
        const moveKey = inventoryMoveKey('grocery', item.id);
        if (godModeReadOnly || inventoryMoveInFlightKeys.has(moveKey)) return;
        inventoryMoveInFlightKeys.add(moveKey);
        setInventoryMoveButtonState(moveBtn, {
          disabled: godModeReadOnly,
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
            disabled: godModeReadOnly,
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
      del.disabled = godModeReadOnly;
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

async function loadPantry() {
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
        disabled: godModeReadOnly,
        inFlight: isInventoryMoveInFlight('pantry', item.id),
        idleText: 'Move to grocery',
        workingText: 'Moving…',
        title: 'Move to Grocery List',
      });
      moveBtn.addEventListener('click', async () => {
        const moveKey = inventoryMoveKey('pantry', item.id);
        if (godModeReadOnly || inventoryMoveInFlightKeys.has(moveKey)) return;
        inventoryMoveInFlightKeys.add(moveKey);
        setInventoryMoveButtonState(moveBtn, {
          disabled: godModeReadOnly,
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
            disabled: godModeReadOnly,
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
      del.disabled = godModeReadOnly;
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



function populateCookbookCategoryControls() {
  if (cookbookCategoryFilter && cookbookCategoryFilter.options.length <= 2) {
    for (const option of COOKBOOK_CATEGORY_OPTIONS) {
      const el = document.createElement('option');
      el.value = option.value;
      el.textContent = option.label;
      cookbookCategoryFilter.appendChild(el);
    }
  }
  if (cookbookDetailCategory && cookbookDetailCategory.options.length <= 1) {
    for (const option of COOKBOOK_CATEGORY_OPTIONS) {
      const el = document.createElement('option');
      el.value = option.value;
      el.textContent = option.label;
      cookbookDetailCategory.appendChild(el);
    }
  }
}

function buildCookbookTagOptions(entries) {
  const values = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!Array.isArray(entry.tags)) continue;
    for (const rawTag of entry.tags) {
      const tag = String(rawTag || '').trim();
      if (tag) values.add(tag);
    }
  }
  return Array.from(values).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function populateCookbookTagFilter(entries) {
  if (!cookbookTagFilter) return;
  const previousValue = currentCookbookTagFilter || cookbookTagFilter.value || '';
  cookbookTagFilter.innerHTML = '';
  const allOption = document.createElement('option');
  allOption.value = '';
  allOption.textContent = 'All tags';
  cookbookTagFilter.appendChild(allOption);
  const tags = buildCookbookTagOptions(entries);
  for (const tag of tags) {
    const option = document.createElement('option');
    option.value = tag;
    option.textContent = tag;
    cookbookTagFilter.appendChild(option);
  }
  const nextValue = tags.includes(previousValue) ? previousValue : '';
  currentCookbookTagFilter = nextValue;
  cookbookTagFilter.value = nextValue;
}







function appendCookbookSourceRow(container, entry) {
  if (!container) return;
  const source = getCookbookSourceDisplay(entry);
  if (!source) return;
  const row = document.createElement('div');
  row.className = 'cookbook-detail-source-row';

  const label = document.createElement('span');
  label.className = 'cookbook-detail-source-label';
  label.textContent = 'Source:';
  row.appendChild(label);

  if (source.url) {
    const link = document.createElement('a');
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'cookbook-detail-source-link';
    link.textContent = source.label;
    row.appendChild(link);
  } else {
    const text = document.createElement('span');
    text.textContent = source.label;
    row.appendChild(text);
  }

  container.appendChild(row);
}

function shouldShowCookbookSourceInCard(entry) {
  const source = getCookbookSourceDisplay(entry);
  if (!source || !source.label) return false;
  if (source.url) return true;
  const normalizedLabel = normalizeCookbookDisplayTitleKey(source.label);
  if (!normalizedLabel || normalizedLabel === 'kitchenbot original') return false;
  return normalizedLabel !== normalizeCookbookDisplayTitleKey(getCookbookDisplayTitle(entry));
}

function buildCookbookCardSource(entry) {
  const source = getCookbookSourceDisplay(entry);
  if (!source || !shouldShowCookbookSourceInCard(entry)) return null;
  const row = document.createElement('div');
  row.className = 'cookbook-card-source';
  if (source.url) {
    const link = document.createElement('a');
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = source.label;
    row.appendChild(link);
  } else {
    row.textContent = source.label;
  }
  return row;
}

let cookbookTagMeasureEl = null;

function ensureCookbookTagMeasureEl() {
  if (cookbookTagMeasureEl) return cookbookTagMeasureEl;
  const el = document.createElement('span');
  el.style.position = 'absolute';
  el.style.visibility = 'hidden';
  el.style.pointerEvents = 'none';
  el.style.whiteSpace = 'nowrap';
  el.style.left = '-9999px';
  el.style.top = '-9999px';
  document.body.appendChild(el);
  cookbookTagMeasureEl = el;
  return el;
}

function measureCookbookTagChipWidth(text, { overflow = false } = {}) {
  const el = ensureCookbookTagMeasureEl();
  el.className = overflow ? 'cookbook-tag-chip cookbook-tag-chip--overflow' : 'cookbook-tag-chip';
  el.textContent = text;
  return Math.ceil(el.getBoundingClientRect().width);
}

function fitCookbookCardTags(tags, maxWidth) {
  const cleaned = Array.isArray(tags) ? tags.filter(Boolean) : [];
  if (!cleaned.length) return { visibleTags: [], overflowCount: 0 };
  const gap = 6;
  const available = Math.max(120, Math.floor(Number(maxWidth) || 0));
  let used = 0;
  const visibleTags = [];

  for (let index = 0; index < cleaned.length; index += 1) {
    const tag = cleaned[index];
    const chipWidth = measureCookbookTagChipWidth(tag);
    const nextUsed = used + (visibleTags.length ? gap : 0) + chipWidth;
    const remainingAfter = cleaned.length - (index + 1);
    if (remainingAfter > 0) {
      const overflowWidth = measureCookbookTagChipWidth('+' + String(remainingAfter), { overflow: true });
      if (nextUsed + gap + overflowWidth <= available) {
        visibleTags.push(tag);
        used = nextUsed;
        continue;
      }
      break;
    }
    if (nextUsed <= available || visibleTags.length === 0) {
      visibleTags.push(tag);
    }
    break;
  }

  return {
    visibleTags,
    overflowCount: Math.max(0, cleaned.length - visibleTags.length),
  };
}

function buildCookbookCardTags(entry, { maxWidth = 240 } = {}) {
  const tags = Array.isArray(entry.tags) ? entry.tags.filter(Boolean) : [];
  if (!tags.length) return null;
  const { visibleTags, overflowCount } = fitCookbookCardTags(tags, maxWidth);
  const wrap = document.createElement('div');
  wrap.className = 'cookbook-card-tags';
  for (const tag of visibleTags) {
    const chip = document.createElement('span');
    chip.className = 'cookbook-tag-chip';
    chip.textContent = tag;
    wrap.appendChild(chip);
  }
  if (overflowCount > 0) {
    const overflow = document.createElement('span');
    overflow.className = 'cookbook-tag-chip cookbook-tag-chip--overflow';
    overflow.textContent = '+' + String(overflowCount);
    wrap.appendChild(overflow);
  }
  return wrap;
}



async function deleteCookbookEntry(entry, { closeDetailOnSuccess = false } = {}) {
  if (!entry || !Number.isFinite(Number(entry.id))) return false;
  if (!confirm('Delete "' + entry.title + '" from the cookbook?')) return false;
  try {
    const response = await fetch('/cookbook/' + encodeURIComponent(entry.id), {
      method: 'DELETE',
    });
    if (!response.ok) return false;
    if (closeDetailOnSuccess && Number(currentCookbookEntryId) === Number(entry.id)) {
      closeCookbookDetail({ pushHash: true, force: true });
    }
    await loadCookbook();
    return true;
  } catch (e) {
    return false;
  }
}

function buildCookbookOverflowMenu(entry, { includeEditInline = false } = {}) {
  const moreWrap = document.createElement('details');
  moreWrap.className = 'cookbook-card-more';

  const summary = document.createElement('summary');
  summary.textContent = 'More';
  summary.className = 'cookbook-card-more-toggle';
  moreWrap.appendChild(summary);

  const menu = document.createElement('div');
  menu.className = 'cookbook-card-more-menu';

  if (!includeEditInline) {
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'cookbook-card-menu-btn';
    editBtn.textContent = 'Edit';
    editBtn.disabled = godModeReadOnly;
    editBtn.addEventListener('click', () => {
      moreWrap.open = false;
      openCookbookDetail(entry.id, { edit: true, pushHash: true });
    });
    menu.appendChild(editBtn);
  }

  const planBtn = document.createElement('button');
  planBtn.type = 'button';
  planBtn.className = 'cookbook-card-menu-btn';
  planBtn.textContent = 'Use for planning';
  planBtn.addEventListener('click', () => {
    moreWrap.open = false;
    seedCookbookPrompt('Plan dinners from our cookbook, and make sure to include "' + entry.title + '".');
  });
  menu.appendChild(planBtn);

  const groceryBtn = document.createElement('button');
  groceryBtn.type = 'button';
  groceryBtn.className = 'cookbook-card-menu-btn';
  groceryBtn.textContent = 'Generate grocery list';
  groceryBtn.addEventListener('click', () => {
    moreWrap.open = false;
    seedCookbookPrompt('Make me a grocery list from our cookbook recipe "' + entry.title + '".');
  });
  menu.appendChild(groceryBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'cookbook-card-menu-btn cookbook-card-menu-btn--danger';
  deleteBtn.textContent = 'Delete';
  deleteBtn.disabled = godModeReadOnly;
  deleteBtn.addEventListener('click', async () => {
    moreWrap.open = false;
    await deleteCookbookEntry(entry);
  });
  menu.appendChild(deleteBtn);

  moreWrap.appendChild(menu);
  return moreWrap;
}

function buildCookbookCardHeading(entry, { compact = false } = {}) {
  const headingWrap = document.createElement('div');
  headingWrap.className = 'cookbook-card-heading';

  const title = document.createElement('div');
  title.className = 'cookbook-card-title';
  title.textContent = getCookbookDisplayTitle(entry) || 'Untitled recipe';
  headingWrap.appendChild(title);

  const metaText = getCookbookCardMetaText(entry);
  if (metaText) {
    const metaEl = document.createElement('div');
    metaEl.className = 'cookbook-card-meta';
    metaEl.textContent = metaText;
    headingWrap.appendChild(metaEl);
  }

  const sourceRow = compact ? null : buildCookbookCardSource(entry);
  if (sourceRow) headingWrap.appendChild(sourceRow);
  return headingWrap;
}

function renderCookbookDetailActions(entry) {
  if (!cookbookDetailActions) return;
  cookbookDetailActions.innerHTML = '';
  if (!entry) return;

  const disablePromptActions = cookbookDetailEditing;

  const planBtn = document.createElement('button');
  planBtn.type = 'button';
  planBtn.className = 'cookbook-detail-button cookbook-card-action-secondary';
  planBtn.textContent = 'Use for planning';
  planBtn.disabled = disablePromptActions;
  planBtn.addEventListener('click', () => {
    seedCookbookPrompt('Plan dinners from our cookbook, and make sure to include "' + entry.title + '".');
  });
  cookbookDetailActions.appendChild(planBtn);

  const groceryBtn = document.createElement('button');
  groceryBtn.type = 'button';
  groceryBtn.className = 'cookbook-detail-button cookbook-card-action-secondary';
  groceryBtn.textContent = 'Generate grocery list';
  groceryBtn.disabled = disablePromptActions;
  groceryBtn.addEventListener('click', () => {
    seedCookbookPrompt('Make me a grocery list from our cookbook recipe "' + entry.title + '".');
  });
  cookbookDetailActions.appendChild(groceryBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'cookbook-detail-button cookbook-card-menu-btn cookbook-card-menu-btn--danger cookbook-detail-button--danger';
  deleteBtn.textContent = 'Delete';
  deleteBtn.disabled = godModeReadOnly || cookbookDetailEditing;
  deleteBtn.addEventListener('click', async () => {
    await deleteCookbookEntry(entry, { closeDetailOnSuccess: true });
  });
  cookbookDetailActions.appendChild(deleteBtn);
}


function useCookbookSplitLayout() {
  return !!window.matchMedia && window.matchMedia('(min-width: 980px)').matches;
}

function syncCookbookWorkspaceLayout() {
  if (!cookbookWorkspace) return;
  const showSplit = useCookbookSplitLayout() && !!currentCookbookEntryId && !!cookbookDetailView && cookbookDetailView.style.display !== 'none';
  cookbookWorkspace.classList.toggle('cookbook-layout-split', showSplit);
  if (cookbookResultsArea) {
    cookbookResultsArea.classList.toggle('cookbook-results-area--detail-open', showSplit);
  }
}

function isCookbookHash() {
  return /^#cookbook(?:\/\d+)?$/i.test(String(window.location.hash || ''));
}

function parseCookbookDetailHash() {
  const match = String(window.location.hash || '').match(/^#cookbook\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function setCookbookDetailMessage(text, isError = false) {
  if (!cookbookDetailMessage) return;
  cookbookDetailMessage.textContent = text || '';
  cookbookDetailMessage.style.color = isError ? '#a33a2b' : 'var(--text-soft)';
}


function buildCookbookDetailDraft() {
  return {
    title: cookbookDetailTitle ? cookbookDetailTitle.value.trim() : '',
    category: cookbookDetailCategory ? cookbookDetailCategory.value : '',
    summary: cookbookDetailSummary ? cookbookDetailSummary.value.trim() : '',
    ingredients: splitCookbookEditorLines(cookbookDetailIngredients ? cookbookDetailIngredients.value : ''),
    instructions: splitCookbookEditorLines(cookbookDetailInstructions ? cookbookDetailInstructions.value : ''),
    notes: splitCookbookEditorLines(cookbookDetailNotes ? cookbookDetailNotes.value : ''),
    tags: String(cookbookDetailTags ? cookbookDetailTags.value : '')
      .split(',')
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean),
  };
}

function cookbookDetailIsDirty() {
  return cookbookDetailEditing && JSON.stringify(cookbookDetailDraft || {}) !== JSON.stringify(buildCookbookDetailDraft());
}

function seedCookbookPrompt(text) {
  if (!promptInput) return;
  setActiveTab('chat');
  promptInput.value = String(text || '').trim();
  resizePromptInput();
  promptInput.focus();
}

function setCookbookDetailEditing(editing) {
  cookbookDetailEditing = !!editing;
  const disabled = !cookbookDetailEditing || godModeReadOnly;
  if (cookbookDetailTitle) cookbookDetailTitle.disabled = disabled;
  if (cookbookDetailCategory) cookbookDetailCategory.disabled = disabled;
  if (cookbookDetailSummary) cookbookDetailSummary.disabled = disabled;
  if (cookbookDetailIngredients) cookbookDetailIngredients.disabled = disabled;
  if (cookbookDetailInstructions) cookbookDetailInstructions.disabled = disabled;
  if (cookbookDetailNotes) cookbookDetailNotes.disabled = disabled;
  if (cookbookDetailTags) cookbookDetailTags.disabled = disabled;
  if (cookbookDetailEdit) cookbookDetailEdit.style.display = cookbookDetailEditing ? 'none' : '';
  if (cookbookDetailCancel) cookbookDetailCancel.style.display = cookbookDetailEditing ? '' : 'none';
  if (cookbookDetailSave) cookbookDetailSave.style.display = cookbookDetailEditing ? '' : 'none';
  renderCookbookDetailActions(cookbookDetailEntry);
}

function renderCookbookDetail(entry, { edit = false } = {}) {
  if (!entry || !cookbookDetailView) return;
  cookbookDetailEntry = entry;
  currentCookbookEntryId = Number(entry.id);
  if (cookbookDetailTitle) cookbookDetailTitle.value = getCookbookDisplayTitle(entry);
  if (cookbookDetailCategory) cookbookDetailCategory.value = entry.category || '';
  if (cookbookDetailSummary) cookbookDetailSummary.value = entry.summary || '';
  if (cookbookDetailIngredients) cookbookDetailIngredients.value = formatCookbookBullets(entry.ingredients).join('\n');
  if (cookbookDetailInstructions) cookbookDetailInstructions.value = formatCookbookBullets(entry.instructions).join('\n');
  if (cookbookDetailNotes) cookbookDetailNotes.value = formatCookbookBullets(Array.isArray(entry.notes) ? entry.notes : entry.notes ? [entry.notes] : []).join('\n');
  if (cookbookDetailTags) cookbookDetailTags.value = Array.isArray(entry.tags) ? entry.tags.join(', ') : '';
  if (cookbookDetailMeta) cookbookDetailMeta.textContent = getCookbookCardMetaText(entry);
  if (cookbookDetailSource) {
    cookbookDetailSource.innerHTML = '';
    appendCookbookSourceRow(cookbookDetailSource, entry);
  }
  cookbookDetailDraft = buildCookbookDetailDraft();
  setCookbookDetailMessage('');
  setCookbookDetailEditing(edit && !godModeReadOnly);
  renderCookbookDetailActions(entry);
  if (cookbookDetailView) cookbookDetailView.style.display = 'flex';
  if (useCookbookSplitLayout()) {
    if (cookbookList) cookbookList.style.display = 'grid';
    if (cookbookToolbar) cookbookToolbar.style.display = '';
  } else {
    if (cookbookList) cookbookList.style.display = 'none';
    if (cookbookEmpty) cookbookEmpty.style.display = 'none';
    if (cookbookToolbar) cookbookToolbar.style.display = 'none';
  }
  syncCookbookWorkspaceLayout();
  renderCookbook();
}

async function openCookbookDetail(id, { edit = false, pushHash = true } = {}) {
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) return;
  try {
    const response = await fetch('/cookbook/' + encodeURIComponent(numericId));
    if (!response.ok) throw new Error('Failed to load recipe');
    const data = await response.json();
    if (!data || !data.item) throw new Error('Missing recipe');
    setActiveTab('groceries');
    setGroceriesSubview('cookbook');
    renderCookbookDetail(data.item, { edit });
    if (pushHash && window.location.hash !== cookbookDetailHash(numericId)) {
      window.location.hash = cookbookDetailHash(numericId);
    }
  } catch (e) {
    setCookbookDetailMessage('Could not open that recipe right now.', true);
  }
}

function closeCookbookDetail({ pushHash = true, force = false } = {}) {
  if (!force && cookbookDetailIsDirty() && !confirm('Discard your cookbook edits?')) return false;
  currentCookbookEntryId = null;
  cookbookDetailEntry = null;
  cookbookDetailDraft = null;
  cookbookDetailEditing = false;
  renderCookbookDetailActions(null);
  if (cookbookDetailView) cookbookDetailView.style.display = 'none';
  if (cookbookList) cookbookList.style.display = 'grid';
  if (cookbookToolbar) cookbookToolbar.style.display = '';
  syncCookbookWorkspaceLayout();
  renderCookbook();
  if (pushHash && window.location.hash) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  return true;
}

async function saveCookbookDetail() {
  if (!currentCookbookEntryId || godModeReadOnly) return;
  const payload = buildCookbookDetailDraft();
  setCookbookDetailMessage('Saving…');
  try {
    const response = await fetch('/cookbook/' + encodeURIComponent(currentCookbookEntryId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.item) {
      setCookbookDetailMessage(data.error || 'Could not save that recipe right now.', true);
      return;
    }
    cookbookCache = (Array.isArray(cookbookCache) ? cookbookCache : []).map((entry) =>
      Number(entry.id) === Number(data.item.id) ? data.item : entry
    );
    populateCookbookTagFilter(cookbookCache);
    renderCookbookDetail(data.item, { edit: false });
    renderCookbook();
    setCookbookDetailMessage('Saved.');
  } catch (e) {
    setCookbookDetailMessage('Could not save that recipe right now.', true);
  }
}

function renderCookbook() {
  if (!cookbookList || !cookbookEmpty) return;
  cookbookList.innerHTML = '';
  cookbookList.style.gap = isMobile ? '0' : '12px';
  const detailOpen = !!cookbookDetailView && cookbookDetailView.style.display !== 'none';
  const splitLayout = useCookbookSplitLayout();
  const hasSearchQuery = tokenizeCookbookSearch(currentCookbookSearchFilter).length > 0;
  const entries = (Array.isArray(cookbookCache) ? cookbookCache : [])
    .map((entry, index) => ({
      entry,
      index,
      searchScore: hasSearchQuery ? scoreCookbookSearchMatch(entry, currentCookbookSearchFilter) : 0,
    }))
    .filter(({ entry, searchScore }) => {
      const categoryMatches =
        !currentCookbookCategoryFilter ||
        (currentCookbookCategoryFilter === 'uncategorized'
          ? !entry.category
          : String(entry.category || '') === currentCookbookCategoryFilter);
      if (!categoryMatches) return false;
      const tagMatches =
        !currentCookbookTagFilter ||
        (Array.isArray(entry.tags)
          ? entry.tags.some((tag) => String(tag || '').trim() === currentCookbookTagFilter)
          : false);
      if (!tagMatches) return false;
      if (!hasSearchQuery) return true;
      return searchScore >= 0;
    })
    .sort((a, b) => {
      if (hasSearchQuery && b.searchScore !== a.searchScore) return b.searchScore - a.searchScore;
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
  cookbookEmpty.style.display = !detailOpen || splitLayout ? (entries.length === 0 ? '' : 'none') : 'none';
  cookbookList.style.display = detailOpen && !splitLayout ? 'none' : 'grid';
  if (cookbookToolbar) cookbookToolbar.style.display = detailOpen && !splitLayout ? 'none' : '';
  for (const entry of entries) {
    const card = document.createElement('div');
    card.className = 'cookbook-card' + (isMobile ? ' cookbook-card--mobile' : '');
    if (currentCookbookEntryId && Number(entry.id) === Number(currentCookbookEntryId)) {
      card.classList.add('cookbook-card--active');
    }
    const summaryText = getCookbookCardSummary(entry);
    const actions = document.createElement('div');
    actions.className = 'cookbook-card-actions';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.textContent = 'Open';
    openBtn.className = 'cookbook-card-action-primary';
    openBtn.addEventListener('click', () => {
      openCookbookDetail(entry.id, { edit: false, pushHash: true });
    });
    actions.appendChild(openBtn);

    if (!isMobile) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = 'Edit';
      editBtn.className = 'cookbook-card-action-secondary';
      editBtn.disabled = godModeReadOnly;
      editBtn.addEventListener('click', () => {
        openCookbookDetail(entry.id, { edit: true, pushHash: true });
      });
      actions.appendChild(editBtn);
    }

    const overflow = buildCookbookOverflowMenu(entry, { includeEditInline: !isMobile });
    actions.appendChild(overflow);

    if (isMobile) {
      const rowBtn = document.createElement('button');
      rowBtn.type = 'button';
      rowBtn.className = 'cookbook-card-mobile-row';
      rowBtn.appendChild(buildCookbookCardHeading(entry, { compact: true }));

      const chevron = document.createElement('span');
      chevron.className = 'cookbook-card-mobile-chevron';
      chevron.setAttribute('aria-hidden', 'true');
      chevron.textContent = '›';
      rowBtn.appendChild(chevron);

      rowBtn.addEventListener('click', () => {
        openCookbookDetail(entry.id, { edit: false, pushHash: true });
      });
      card.appendChild(rowBtn);
    } else {
      const topRow = document.createElement('div');
      topRow.className = 'cookbook-card-header';
      topRow.appendChild(buildCookbookCardHeading(entry));
      card.appendChild(topRow);

      const tagsWrap = buildCookbookCardTags(entry, {
        maxWidth: Math.max(180, Math.floor((cookbookList?.clientWidth || window.innerWidth) - 120)),
      });
      if (tagsWrap) {
        card.appendChild(tagsWrap);
      }

      if (summaryText) {
        const summary = document.createElement('div');
        summary.className = 'cookbook-card-summary';
        summary.textContent = summaryText;
        card.appendChild(summary);
      }

      card.appendChild(actions);
    }

    cookbookList.appendChild(card);
  }
}

async function loadCookbook() {
  try {
    const response = await fetch('/cookbook');
    if (!response.ok) return;
    const data = await response.json();
    cookbookCache = Array.isArray(data.items) ? data.items : [];
    populateCookbookTagFilter(cookbookCache);
    renderCookbook();
    if (currentCookbookEntryId && cookbookDetailView && cookbookDetailView.style.display !== 'none') {
      const refreshedEntry = cookbookCache.find((entry) => Number(entry.id) === Number(currentCookbookEntryId));
      if (refreshedEntry && !cookbookDetailEditing) {
        renderCookbookDetail(refreshedEntry, { edit: false });
      }
    }
    const hashId = parseCookbookDetailHash();
    if (hashId && hashId !== currentCookbookEntryId) {
      await openCookbookDetail(hashId, { pushHash: false });
    }
  } catch (e) {
    console.error('Cookbook load failed:', e);
    cookbookCache = [];
    populateCookbookTagFilter([]);
    renderCookbook();
  }
}

function setGroceriesSubview(view) {
  currentGroceriesSubview =
    view === 'pantry' || view === 'cookbook' || view === 'thisweek' ? view : 'list';
  persistKitchenSectionPreference(currentGroceriesSubview);
  if (grocerySubtabList) grocerySubtabList.classList.toggle('settings-subtab-active', currentGroceriesSubview === 'list');
  if (grocerySubtabPantry) grocerySubtabPantry.classList.toggle('settings-subtab-active', currentGroceriesSubview === 'pantry');
  if (grocerySubtabCookbook) grocerySubtabCookbook.classList.toggle('settings-subtab-active', currentGroceriesSubview === 'cookbook');
  if (grocerySubtabThisweek) grocerySubtabThisweek.classList.toggle('settings-subtab-active', currentGroceriesSubview === 'thisweek');
  if (grocerySubviewList) grocerySubviewList.style.display = currentGroceriesSubview === 'list' ? '' : 'none';
  if (grocerySubviewPantry) grocerySubviewPantry.style.display = currentGroceriesSubview === 'pantry' ? '' : 'none';
  if (grocerySubviewCookbook) grocerySubviewCookbook.style.display = currentGroceriesSubview === 'cookbook' ? '' : 'none';
  if (grocerySubviewThisweek) grocerySubviewThisweek.style.display = currentGroceriesSubview === 'thisweek' ? '' : 'none';
  if (currentGroceriesSubview === 'thisweek') loadThisWeek();
  syncCookbookWorkspaceLayout();
}

async function loadThisWeek() {
  if (!thisweekList) return;
  if (currentChatId == null) {
    thisweekList.innerHTML = '';
    if (thisweekEmpty) {
      thisweekEmpty.textContent = 'Open or start a chat to see this week’s plan.';
      thisweekEmpty.style.display = '';
    }
    return;
  }
  let items = [];
  try {
    const res = await fetch('/plan?chatId=' + encodeURIComponent(currentChatId), { credentials: 'same-origin' });
    if (res.ok) items = (await res.json()).items || [];
  } catch (err) {
    /* leave empty on failure */
  }
  thisweekList.innerHTML = '';
  if (thisweekEmpty) {
    thisweekEmpty.textContent = 'No meals planned this week yet. Ask KitchenBot to plan the week and they’ll show up here (across every chat).';
    thisweekEmpty.style.display = items.length === 0 ? '' : 'none';
  }
  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'g-item' + (item.status === 'cooked' ? ' g-item-checked' : '');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = item.status === 'cooked';
    checkbox.style.accentColor = 'var(--accent-strong)';
    checkbox.title = item.status === 'cooked' ? 'Mark as still to cook' : 'Mark as cooked';
    checkbox.addEventListener('change', async () => {
      const nowCooked = checkbox.checked;
      await fetch('/plan/' + item.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ chatId: currentChatId, status: nowCooked ? 'cooked' : 'planned' }),
      }).catch(() => {});
      if (nowCooked) {
        // one small celebratory beat, then refresh
        li.classList.add('kb-joy');
        setTimeout(() => loadThisWeek(), 480);
      } else {
        loadThisWeek();
      }
    });
    li.appendChild(checkbox);

    const nameWrap = document.createElement('span');
    nameWrap.className = 'g-item-name';
    const nameText = document.createElement('span');
    nameText.textContent = item.name;
    if (item.status === 'cooked') nameText.style.textDecoration = 'line-through';
    nameWrap.appendChild(nameText);
    if (item.cookbookEntryId) {
      const tag = document.createElement('button');
      tag.type = 'button';
      tag.textContent = '🍳 recipe';
      tag.title = 'Open ' + (item.cookbookTitle || 'the saved recipe');
      tag.style.cssText =
        'margin-left:8px;background:none;border:none;color:var(--accent-strong);font-size:12px;cursor:pointer;padding:0;text-decoration:underline;';
      tag.addEventListener('click', (e) => {
        e.stopPropagation();
        setGroceriesSubview('cookbook');
        if (typeof openCookbookDetail === 'function') openCookbookDetail(item.cookbookEntryId);
      });
      nameWrap.appendChild(tag);
    }
    if (item.note) {
      const note = document.createElement('div');
      note.textContent = item.note;
      note.style.color = 'var(--text-soft)';
      note.style.fontSize = '12px';
      nameWrap.appendChild(note);
    }
    li.appendChild(nameWrap);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'g-item-remove';
    remove.textContent = '✕';
    remove.title = 'Remove from this week';
    remove.addEventListener('click', async () => {
      await fetch('/plan/' + item.id + '?chatId=' + encodeURIComponent(currentChatId), {
        method: 'DELETE',
        credentials: 'same-origin',
      }).catch(() => {});
      loadThisWeek();
    });
    li.appendChild(remove);

    thisweekList.appendChild(li);
  }
}

// Compact, glanceable "This Week" strip pinned above the chat messages — the plan
// right where you're cooking. Reads the same /plan data; refreshed by loadHistory
// (chat open/switch, after a turn, co-viewer updates) and by setActiveTab('chat').
async function renderThisWeekStrip() {
  if (!thisweekStrip) return;
  const onChatTab = chat && chat.style.display !== 'none';
  if (!onChatTab || currentChatId == null) {
    thisweekStrip.style.display = 'none';
    return;
  }
  let items = [];
  try {
    const res = await fetch('/plan?chatId=' + encodeURIComponent(currentChatId), { credentials: 'same-origin' });
    if (res.ok) items = (await res.json()).items || [];
  } catch (err) {
    /* leave empty */
  }
  if (items.length === 0) {
    thisweekStrip.innerHTML = '';
    thisweekStrip.style.display = 'none';
    return;
  }
  thisweekStrip.innerHTML = '';
  // Collapsed by DEFAULT — the meal chips ate ~1/5 of a phone screen. One line + a chevron
  // when collapsed; expands to the chips. State persists across chats/sessions.
  const collapsed = localStorage.getItem('kb_thisweek_collapsed') !== '0';
  thisweekStrip.style.cssText =
    'display:block;margin:0 0 6px;background:var(--accent-soft);border-radius:12px;overflow:hidden;';

  const header = document.createElement('button');
  header.type = 'button';
  header.setAttribute('aria-expanded', String(!collapsed));
  header.style.cssText =
    'display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:8px 12px;background:none;border:none;cursor:pointer;text-align:left;';
  const label = document.createElement('span');
  label.style.cssText =
    'font-size:12px;font-weight:700;color:var(--accent-strong);text-transform:uppercase;letter-spacing:.04em;';
  const cookedCount = items.filter((i) => i.status === 'cooked').length;
  label.textContent = 'This week · ' + items.length + (cookedCount ? ' · ' + cookedCount + ' cooked' : '');
  const chevron = document.createElement('span');
  chevron.textContent = collapsed ? '▾' : '▴';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.style.cssText = 'font-size:13px;color:var(--accent-strong);flex:none;';
  header.appendChild(label);
  header.appendChild(chevron);
  header.addEventListener('click', () => {
    localStorage.setItem('kb_thisweek_collapsed', collapsed ? '0' : '1');
    renderThisWeekStrip();
  });
  thisweekStrip.appendChild(header);

  if (!collapsed) {
    const body = document.createElement('div');
    body.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0 12px 10px;';
    for (const item of items) {
      const cooked = item.status === 'cooked';
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.style.cssText =
        'display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:999px;border:1px solid var(--border-subtle);background:#fff;font-size:13px;cursor:pointer;' +
        (cooked ? 'opacity:.6;text-decoration:line-through;' : '');
      chip.textContent = (cooked ? '✓ ' : '') + item.name + (item.cookbookEntryId ? ' 🍳' : '');
      chip.title =
        item.name + (cooked ? ' — cooked' : ' — planned') + (item.cookbookEntryId ? ' · has a saved recipe' : '');
      chip.addEventListener('click', () => {
        setActiveTab('groceries');
        if (item.cookbookEntryId) {
          setGroceriesSubview('cookbook');
          if (typeof openCookbookDetail === 'function') openCookbookDetail(item.cookbookEntryId);
        } else {
          setGroceriesSubview('thisweek');
        }
      });
      body.appendChild(chip);
    }
    thisweekStrip.appendChild(body);
  }
  thisweekStrip.style.display = 'block';
}

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

    if (isCurrentUserOwner && !godModeReadOnly) {
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
            currentChatId = chatsCache.length ? chatsCache[0].id : null;
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
      currentChatId = chatInfo.id;
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
    if (godModeReadOnly) {
      currentChatId = null;
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
    currentChatId = created.id;
    chatsCache.unshift({ id: created.id, owner: created.owner, title: created.title, created_at: new Date().toISOString() });
  } else {
    currentChatId = chatsCache[0].id;
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
    currentChatId = null;
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
  rebuildDisplayNameToColorFromMeChatColors(meData.chatColors);
  showApp(meData.name);
  const shouldOpenCookbookFromHash = isCookbookHash();
  if (shouldOpenCookbookFromHash) {
    setActiveTab('groceries');
    setGroceriesSubview('cookbook');
  } else if (forceChatTab) {
    setActiveTab('chat');
  }
  await loadChatsAndEnsureOne();
  await loadHistory();
  if (shouldOpenCookbookFromHash) {
    setActiveTab('groceries');
    setGroceriesSubview('cookbook');
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
    setGroceriesSubview('list');
  });
}
if (grocerySubtabPantry) {
  grocerySubtabPantry.addEventListener('click', () => {
    setGroceriesSubview('pantry');
  });
}
if (grocerySubtabCookbook) {
  grocerySubtabCookbook.addEventListener('click', async () => {
    setGroceriesSubview('cookbook');
    await loadCookbook();
  });
}
if (grocerySubtabThisweek) {
  grocerySubtabThisweek.addEventListener('click', () => {
    setGroceriesSubview('thisweek');
  });
}
function initializeCookbookUi() {
  populateCookbookCategoryControls();
  populateCookbookTagFilter(cookbookCache);
  syncCookbookWorkspaceLayout();
  if (cookbookSearchFilter) cookbookSearchFilter.value = currentCookbookSearchFilter;
  if (cookbookCategoryFilter) {
    cookbookCategoryFilter.addEventListener('change', () => {
      currentCookbookCategoryFilter = cookbookCategoryFilter.value;
      renderCookbook();
    });
  }
  if (cookbookTagFilter) {
    cookbookTagFilter.addEventListener('change', () => {
      currentCookbookTagFilter = cookbookTagFilter.value;
      renderCookbook();
    });
  }
  if (cookbookSearchFilter) {
    cookbookSearchFilter.addEventListener('input', () => {
      currentCookbookSearchFilter = cookbookSearchFilter.value || '';
      renderCookbook();
    });
  }
  if (cookbookDetailBack) {
    cookbookDetailBack.addEventListener('click', () => {
      closeCookbookDetail({ pushHash: true });
    });
  }
  if (cookbookDetailEdit) {
    cookbookDetailEdit.addEventListener('click', () => {
      setCookbookDetailEditing(true);
      setCookbookDetailMessage('');
    });
  }
  if (cookbookDetailCancel) {
    cookbookDetailCancel.addEventListener('click', () => {
      if (!cookbookDetailEntry) return;
      if (cookbookDetailIsDirty() && !confirm('Discard your cookbook edits?')) return;
      renderCookbookDetail(cookbookDetailEntry, { edit: false });
    });
  }
  if (cookbookDetailSave) {
    cookbookDetailSave.addEventListener('click', async () => {
      await saveCookbookDetail();
    });
  }
  window.addEventListener('hashchange', async () => {
    if (isCookbookHash()) {
      setActiveTab('groceries');
      setGroceriesSubview('cookbook');
      await loadCookbook();
      return;
    }
    const hashId = parseCookbookDetailHash();
    if (!hashId) {
      const closed = closeCookbookDetail({ pushHash: false, force: false });
      if (!closed && currentCookbookEntryId) {
        window.location.hash = cookbookDetailHash(currentCookbookEntryId);
      }
      return;
    }
    if (currentUserId == null) return;
    if (Number(hashId) === Number(currentCookbookEntryId)) return;
    if (currentCookbookEntryId && Number(hashId) !== Number(currentCookbookEntryId) && cookbookDetailIsDirty()) {
      if (!confirm('Discard your cookbook edits?')) {
        window.location.hash = cookbookDetailHash(currentCookbookEntryId);
        return;
      }
    }
    await openCookbookDetail(hashId, { pushHash: false });
  });
  window.addEventListener('beforeunload', (event) => {
    if (!cookbookDetailIsDirty()) return;
    event.preventDefault();
    event.returnValue = '';
  });
  window.addEventListener('resize', () => {
    syncCookbookWorkspaceLayout();
    if (!cookbookList) return;
    renderCookbook();
  });
}

const settingsAddSubmit = document.getElementById('settings-add-submit');
const adminAnthropicShared = document.getElementById('admin-anthropic-mode-shared');
const adminAnthropicHousehold = document.getElementById('admin-anthropic-mode-household');
const adminAnthropicHouseholdSelect = document.getElementById('admin-anthropic-household-select');
if (adminAnthropicShared) adminAnthropicShared.addEventListener('change', updateAdminAnthropicFormVisibility);
if (adminAnthropicHousehold) adminAnthropicHousehold.addEventListener('change', updateAdminAnthropicFormVisibility);
if (adminAnthropicHouseholdSelect) {
  adminAnthropicHouseholdSelect.addEventListener('change', () => {
    loadAdminAnthropicForSelected();
  });
}
initializeAdminUsageFilters();
initializeOwnerUsageFilters();
const adminUsageRefresh = document.getElementById('admin-usage-refresh');
if (adminUsageRefresh) {
  adminUsageRefresh.addEventListener('click', async () => {
    await refreshAdminUsageReport();
  });
}
const adminUsageHouseholdSelect = document.getElementById('admin-usage-household-select');
if (adminUsageHouseholdSelect) {
  adminUsageHouseholdSelect.addEventListener('change', () => {
    refreshAdminUsageReport();
  });
}
const adminUsageStartDate = document.getElementById('admin-usage-start-date');
if (adminUsageStartDate) {
  adminUsageStartDate.addEventListener('change', () => {
    refreshAdminUsageReport();
  });
}
const adminUsageEndDate = document.getElementById('admin-usage-end-date');
if (adminUsageEndDate) {
  adminUsageEndDate.addEventListener('change', () => {
    refreshAdminUsageReport();
  });
}
const ownerUsageRefresh = document.getElementById('owner-usage-refresh');
if (ownerUsageRefresh) {
  ownerUsageRefresh.addEventListener('click', async () => {
    await refreshOwnerAnthropicUsageReport();
  });
}
const ownerUsageStartDate = document.getElementById('owner-usage-start-date');
if (ownerUsageStartDate) {
  ownerUsageStartDate.addEventListener('change', () => {
    refreshOwnerAnthropicUsageReport();
  });
}
const ownerUsageEndDate = document.getElementById('owner-usage-end-date');
if (ownerUsageEndDate) {
  ownerUsageEndDate.addEventListener('change', () => {
    refreshOwnerAnthropicUsageReport();
  });
}

const adminAnthropicModeSave = document.getElementById('admin-anthropic-mode-save');
if (adminAnthropicModeSave) {
  adminAnthropicModeSave.addEventListener('click', async () => {
    const sel = document.getElementById('admin-anthropic-household-select');
    const hid = sel && sel.value ? Number(sel.value) : NaN;
    const msgEl = document.getElementById('admin-anthropic-msg');
    if (!Number.isFinite(hid)) {
      if (msgEl) msgEl.textContent = 'Select a household.';
      return;
    }
    const shared = document.getElementById('admin-anthropic-mode-shared');
    const mode = shared && shared.checked ? 'shared' : 'household';
    try {
      const r = await fetch('/settings/anthropic/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ householdId: hid, anthropicKeyMode: mode }),
      });
      const errBody = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (msgEl) msgEl.textContent = mapServerReadOnlyErrorMessage(errBody.error) || 'Save failed';
        return;
      }
      if (msgEl) msgEl.textContent = 'Mode saved.';
      await loadGlobalAdminView();
    } catch (e) {
      if (msgEl) msgEl.textContent = 'Request failed.';
    }
  });
}


const settingsAnthropicOwnerKeySave = document.getElementById('settings-anthropic-owner-key-save');
if (settingsAnthropicOwnerKeySave) {
  settingsAnthropicOwnerKeySave.addEventListener('click', async () => {
    const keyInput = document.getElementById('settings-anthropic-owner-key');
    const msgEl = document.getElementById('settings-anthropic-owner-key-msg');
    const key = keyInput && keyInput.value.trim();
    if (!key) {
      if (msgEl) msgEl.textContent = 'Enter an API key.';
      return;
    }
    try {
      const r = await fetch('/settings/anthropic/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ anthropicApiKey: key }),
      });
      const errBody = await r.json().catch(() => ({}));
      if (!r.ok) {
        setSettingsUiMessage(msgEl, mapServerReadOnlyErrorMessage(errBody.error) || 'Save failed');
        return;
      }
      setSettingsUiMessage(msgEl, 'Key saved.', { sticky: true });
      if (keyInput) keyInput.value = '';
      await loadMyHouseholdView();
      await loadAnthropicSection();
    } catch (e) {
      setSettingsUiMessage(msgEl, 'Request failed.');
    }
  });
}

const adminNewHhSubmit = document.getElementById('admin-new-hh-submit');
if (adminNewHhSubmit) {
  adminNewHhSubmit.addEventListener('click', async () => {
    const householdName = document.getElementById('admin-new-hh-name').value.trim();
    const householdKey = document.getElementById('admin-new-hh-key').value.trim();
    const ownerDisplayName = document.getElementById('admin-new-owner-name').value.trim();
    const ownerPin = document.getElementById('admin-new-owner-pin').value;
    const msgEl = document.getElementById('admin-new-hh-msg');
    if (!householdName || !householdKey || !ownerDisplayName || !ownerPin) {
      if (msgEl) msgEl.textContent = 'All fields are required.';
      return;
    }
    if (msgEl) msgEl.textContent = 'Creating…';
    try {
      const r = await fetch('/admin/households', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ householdName, householdKey, ownerDisplayName, ownerPin }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (msgEl) msgEl.textContent = mapServerReadOnlyErrorMessage(data.error) || 'Failed';
        return;
      }
      if (msgEl) {
        msgEl.textContent =
          'Created household #' + data.household.id + ' — owner user id ' + data.owner.id + '.';
      }
      document.getElementById('admin-new-hh-name').value = '';
      document.getElementById('admin-new-hh-key').value = '';
      document.getElementById('admin-new-owner-name').value = '';
      document.getElementById('admin-new-owner-pin').value = '';
      await loadGlobalAdminView();
    } catch (e) {
      if (msgEl) msgEl.textContent = 'Request failed.';
    }
  });
}

const settingsSubtabMyBtn = document.getElementById('settings-subtab-my-btn');
const settingsSubtabUsageBtn = document.getElementById('settings-subtab-usage-btn');
const settingsSubtabAdminBtn = document.getElementById('settings-subtab-admin-btn');
if (settingsSubtabMyBtn) {
  settingsSubtabMyBtn.addEventListener('click', () => {
    showSettingsSubView('my');
  });
}
if (settingsSubtabUsageBtn) {
  settingsSubtabUsageBtn.addEventListener('click', async () => {
    await refreshOwnerAnthropicUsageReport();
    showSettingsSubView('usage');
  });
}
if (settingsSubtabAdminBtn) {
  settingsSubtabAdminBtn.addEventListener('click', async () => {
    await loadGlobalAdminView();
    showSettingsSubView('admin');
  });
}
const settingsSubtabHouseholdBtn = document.getElementById('settings-subtab-household-btn');
if (settingsSubtabHouseholdBtn) {
  settingsSubtabHouseholdBtn.addEventListener('click', () => {
    showSettingsSubView('household');
  });
}
const settingsSubtabFamilyBtn = document.getElementById('settings-subtab-family-btn');
if (settingsSubtabFamilyBtn) {
  settingsSubtabFamilyBtn.addEventListener('click', () => {
    showSettingsSubView('family');
  });
}

if (settingsAddSubmit) {
  settingsAddSubmit.addEventListener('click', async () => {
    const displayName = document.getElementById('settings-new-display').value.trim();
    const role = document.getElementById('settings-new-role').value;
    const pin = document.getElementById('settings-new-pin').value.trim();
    const msgEl = document.getElementById('my-settings-msg');
    if (!displayName || !pin) {
      setSettingsUiMessage(msgEl, 'Display name and PIN required.');
      return;
    }
    try {
      const r = await fetch('/settings/household/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName, role, pin }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setSettingsUiMessage(msgEl, mapServerReadOnlyErrorMessage(data.error) || 'Failed');
        return;
      }
      document.getElementById('settings-new-display').value = '';
      document.getElementById('settings-new-pin').value = '';
      setSettingsUiMessage(msgEl, 'User added.', { sticky: true });
      displayNameToColor[normalizeDisplayNameKey(displayName)] = data.chatColor || 'blue';
      await loadMyHouseholdView();
      await loadAnthropicSection();
      const subBtn = document.getElementById('settings-subtab-admin-btn');
      if (subBtn && subBtn.style.display !== 'none') {
        await loadGlobalAdminView();
      }
    } catch (e) {
      setSettingsUiMessage(msgEl, 'Request failed.');
    }
  });
}


const defaultsSaveButton = document.getElementById('my-settings-defaults-save');
if (defaultsSaveButton) {
  defaultsSaveButton.addEventListener('click', async () => {
    clearHouseholdDefaultsUiMessage();
    const portionsEl = document.getElementById('my-settings-defaults-portions');
    const styleEl = document.getElementById('my-settings-defaults-style');
    const assistantNameEl = document.getElementById('my-settings-defaults-assistant-name');
    const assistantToneEl = document.getElementById('my-settings-defaults-assistant-tone');
    const msgEl = document.getElementById('my-settings-defaults-msg');
    const defaultDinnerPortions = portionsEl && String(portionsEl.value).trim() ? Number(portionsEl.value) : null;
    const weeknightCookingStyle = styleEl && String(styleEl.value).trim() ? String(styleEl.value).trim() : 'normal';
    const assistantName =
      assistantNameEl && String(assistantNameEl.value).trim()
        ? String(assistantNameEl.value).trim()
        : 'KitchenBot';
    const assistantTone =
      assistantToneEl && String(assistantToneEl.value).trim()
        ? normalizeToneValue(assistantToneEl.value)
        : 'helpful';
    try {
      const r = await fetch('/settings/household/defaults', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          defaultDinnerPortions,
          weeknightCookingStyle,
          assistantName,
          assistantTone,
        }),
      });
      const errBody = await r.json().catch(() => ({}));
      if (msgEl) {
        setSettingsUiMessage(
          msgEl,
          r.ok ? 'Saved.' : mapServerReadOnlyErrorMessage(errBody.error) || 'Save failed',
          { sticky: r.ok }
        );
      }
      if (r.ok) {
        currentAssistantName = assistantName;
        await loadHouseholdDefaultsEditor();
      }
    } catch (e) {
      setSettingsUiMessage(msgEl, 'Request failed.');
    }
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
    currentChatId = created.id;
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
try {
  initializeCookbookUi();
} catch (e) {
  console.error('Cookbook UI initialization failed:', e);
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

const godModeExitBtn = document.getElementById('god-mode-exit-btn');
if (godModeExitBtn) {
  godModeExitBtn.addEventListener('click', async () => {
    try {
      const r = await fetch('/admin/impersonate/exit', { method: 'POST' });
      if (!r.ok) return;
      const meR = await fetch('/me');
      if (!meR.ok) {
        showLogin();
        return;
      }
      const meData = await meR.json();
      await rehydrateAuthenticatedApp(meData, { forceChatTab: true, resetSessionView: true });
    } catch (e) {}
  });
}

sendButton.addEventListener('click', async () => {
  if (godModeReadOnly) return;
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
    if (sendButton && !godModeReadOnly) {
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
  lastMePayload = null;
  applyGodModeFromMe({ isImpersonating: false, impersonationReadOnly: false });
  displayNameToColor = {};
  cookbookCache = [];
  showLogin();
  chat.innerHTML = '';
  lastPersistedMessageCountByChatId.clear();
  ephemeralExchangesByChatId.clear();
  nextEphemeralSeqByChatId.clear();
});

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

// --- feature modules ---
initPalette();
initAttachments();
