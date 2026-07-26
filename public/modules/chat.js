// The chat surface: messages, history, the chat list and sidebar, the composer, and the realtime
// WebSocket that keeps two devices in the same conversation in sync.
//
// Realtime is NOT a separate module on purpose. The typing indicator, the streaming assistant
// bubble, the "new messages" pill and the scroll-anchoring all read and write the same handful of
// variables (weAreStreamingThisChat, remoteStream*, hasUnreadIncomingChatContent). Splitting them
// would mean exporting that state across a boundary, which is the coupling this refactor exists to
// remove — the same reason grocery and pantry share inventory.js.
//
// Owns which chat is open, and announces changes with CHAT_CHANGED rather than exposing the
// variable. Identity (who is signed in, their colour, the assistant's name) lives in session.js.

import { EVENTS, emit, on } from './events.js';
import {
  getAssistantName,
  getHouseholdId,
  getUserId,
  getUserName,
  isOwner,
  isReadOnly,
  setAssistantName,
  userMessageBubbleClass,
} from './session.js';
import { useMobileEnterBehavior } from './device.js';
import { getKitchenView, setActiveTab } from './navigation.js';
import { loadThisWeek, renderThisWeekStrip } from './plan.js';
import { refreshAdminHouseholdsList } from './admin.js';
import { clearPendingAttachment, getPendingAttachment } from './attachments.js';

// DOM handles, bound by initChat() once the document exists. Declared here rather than resolved
// per call so the moved code below reads exactly as it did in app.js.
let speakerName = null;
let menuButton = null;
let sidebar = null;
let sidebarBackdrop = null;
let chatListEl = null;
let newChatButton = null;
let chat = null;
let promptInput = null;
let sendButton = null;
let typingIndicator = null;
let chatNewMessageButton = null;

let currentChatId = null;

/**
 * Change the active chat and announce it. Features that care about which chat is open (the meal
 * plan, and later anything else) listen for CHAT_CHANGED rather than reading this variable.
 */
function setCurrentChatId(id) {
  if (currentChatId === id) return;
  currentChatId = id;
  emit(EVENTS.CHAT_CHANGED, { chatId: id });
}
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

let typingWs = null;
const typingUsers = new Set();
let typingStopTimeout = null;
let weAreStreamingThisChat = false;
let remoteStreamBodyEl = null;
let remoteStreamTurnId = null;
let remoteStreamHasStarted = false;
let typingReconnectTimeout = null;
let hasUnreadIncomingChatContent = false;
let chatRequestInFlight = false;

function formatTypingText(users) {
  const arr = Array.from(users).filter(u => u && u !== getUserName());
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
  if (!getUserName() || getHouseholdId() == null || getUserId() == null) return;
  typingReconnectTimeout = setTimeout(async () => {
    typingReconnectTimeout = null;
    if (!typingWs && getUserName() && getHouseholdId() != null && getUserId() != null) {
      connectTypingWs();
    }
    if (document.visibilityState === 'visible' && currentChatId != null && !weAreStreamingThisChat) {
      try {
        await loadHistory({ preserveViewport: true });
      } catch (e) {}
    }
  }, delayMs);
}

export function teardownRealtimeUi() {
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
    author.textContent = getAssistantName();
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
  if (getHouseholdId() == null || !Number.isFinite(Number(getHouseholdId()))) return;
  typingWs.send(JSON.stringify({ type: 'viewing', householdId: getHouseholdId(), chatId: currentChatId }));
  typingUsers.clear();
  updateTypingIndicator();
}

export function connectTypingWs() {
  if (!getUserName() || getHouseholdId() == null || getUserId() == null) return;
  if (!Number.isFinite(Number(getHouseholdId())) || !Number.isFinite(Number(getUserId()))) return;
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
          householdId: getHouseholdId(),
          userId: getUserId(),
          user: getUserName(),
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
          if (msgHid != null && getHouseholdId() != null && msgHid !== Number(getHouseholdId())) {
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
          if (msgHid != null && getHouseholdId() != null && msgHid !== Number(getHouseholdId())) {
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
          if (msgHid != null && getHouseholdId() != null && msgHid !== Number(getHouseholdId())) {
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
          if (msgHid != null && getHouseholdId() != null && msgHid !== Number(getHouseholdId())) {
            return;
          }
          if (weAreStreamingThisChat) {
            return;
          }
          clearTransientAssistantDelta(msg.turnId || null);
          return;
        }
        if (msg.type === 'user_typing' || msg.type === 'user_stopped_typing') {
          if (getHouseholdId() == null || !Number.isFinite(Number(getHouseholdId()))) return;
          if (msgHid == null || msgHid !== Number(getHouseholdId())) return;
          if (msgChatId != null && msgChatId !== currentChatId) return;
          if (msg.userId != null && getUserId() != null && Number(msg.userId) === Number(getUserId())) return;
          if (msg.user === getUserName()) return;
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

export async function refreshRealtimeChatView() {
  if (getUserId() == null || currentChatId == null) return;
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

function sendTyping(isTyping) {
  if (isReadOnly()) return;
  if (!typingWs || typingWs.readyState !== 1 || !currentChatId) return;
  if (getHouseholdId() == null || !Number.isFinite(Number(getHouseholdId()))) return;
  typingWs.send(
    JSON.stringify({
      type: isTyping ? 'typing' : 'stopped_typing',
      householdId: getHouseholdId(),
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

export function renderMarkdown(text) {
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
    name = role === 'user' ? (speakerName && speakerName.textContent) || 'User' : getAssistantName();
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

export async function loadHistory(options = {}) {
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
      emit(EVENTS.SESSION_EXPIRED, {});
    }
    return;
  }
  const data = await response.json();
  if (requestSeq !== loadHistoryRequestSeq) return;
  if (Number(currentChatId) !== requestedChatId) return;
  if (data.assistantName) setAssistantName(data.assistantName);
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
    addMessage('assistant', getAssistantName(), ep.assistant, { autoScroll: false });
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

export function renderChats() {
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

    if (isOwner() && !isReadOnly()) {
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

export async function loadChatsAndEnsureOne() {
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

export function closeSidebar() {
  sidebar.classList.remove('open');
  sidebarBackdrop.classList.remove('open');
}

function closeSidebarAndGoToChatTab() {
  setActiveTab('chat');
  closeSidebar();
}

export function buildClientTimeContext() {
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

// Chat's own controls follow the read-only flag. Admin used to reach in and disable these; now it
// only flips the flag and chat responds.
export function syncChatReadOnly() {
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

/** The composer's speaker label follows whoever is signed in — chat renders it, nobody sets it. */
function syncSpeakerName() {
  if (speakerName) speakerName.textContent = getUserName() || '';
}

/** Wipe the open conversation — used on logout and when re-hydrating as a different identity. */
export function resetChatSession() {
  setCurrentChatId(null);
  chatsCache = [];
  chat.innerHTML = '';
  closeSidebar();
  lastPersistedMessageCountByChatId.clear();
  ephemeralExchangesByChatId.clear();
  nextEphemeralSeqByChatId.clear();
}

/** Open the household's chats after sign-in and go live. */
export async function startChatSession() {
  await loadChatsAndEnsureOne();
  await loadHistory();
  connectTypingWs();
}

/** The id of the open conversation, for the few callers that genuinely need it. */
export function getCurrentChatId() {
  return currentChatId;
}

/** Bind DOM handles and wire this feature's own listeners. Called once at startup. */
export function initChat() {
  speakerName = document.getElementById('speaker-name');
  menuButton = document.getElementById('menu-button');
  sidebar = document.getElementById('sidebar');
  sidebarBackdrop = document.getElementById('sidebar-backdrop');
  chatListEl = document.getElementById('chat-list');
  newChatButton = document.getElementById('new-chat');
  chat = document.getElementById('chat');
  promptInput = document.getElementById('prompt');
  sendButton = document.getElementById('send');
  typingIndicator = document.getElementById('typing-indicator');
  chatNewMessageButton = document.getElementById('chat-new-message');

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
    thinkingAuthor.textContent = getAssistantName();
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
          emit(EVENTS.SESSION_EXPIRED, {});
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

  // The cookbook (and anything else) can ask for the composer to be seeded without touching it.
  on(EVENTS.COMPOSE_PROMPT, ({ text }) => {
    if (!promptInput) return;
    promptInput.value = String(text || '');
    resizePromptInput();
    promptInput.focus();
  });

  on(EVENTS.READ_ONLY_CHANGED, syncChatReadOnly);
  on(EVENTS.SESSION_CHANGED, syncChatReadOnly);
  on(EVENTS.SESSION_CHANGED, syncSpeakerName);
  syncSpeakerName();

  // Settings (and anything else) can ask chat to redraw its history without calling into it.
  on(EVENTS.CHAT_RELOAD, () => {
    if (currentChatId) loadHistory().catch((e) => console.error('History reload failed:', e));
  });
}
