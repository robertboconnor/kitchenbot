const STATUS_TEXT_BY_KEY = {
  thinking: 'Thinking...',
  reading_memories: 'Reading memories...',
  planning: 'Coming up with a plan...',
  writing_reply: 'Writing reply...',
};

function normalizeStatusKey(raw) {
  const k = String(raw ?? '').trim().toLowerCase();
  if (!k) return 'thinking';
  if (Object.prototype.hasOwnProperty.call(STATUS_TEXT_BY_KEY, k)) return k;
  return 'thinking';
}

/**
 * Build a deduplicating chat status emitter for a single request.
 * Status events are UI telemetry only; they do not affect runtime behavior.
 */
export function createChatStatusEmitter({ broadcastToChat, householdId, chatId, user, requestId }) {
  const rid = String(requestId ?? '').trim() || null;
  let lastKey = null;
  let lastText = null;
  let phaseIndex = 0;
  let finished = false;

  function emit(statusKey, statusText = null) {
    if (finished || typeof broadcastToChat !== 'function') return;
    const key = normalizeStatusKey(statusKey);
    const text = String(statusText ?? STATUS_TEXT_BY_KEY[key] ?? STATUS_TEXT_BY_KEY.thinking).trim();
    if (key === lastKey && text === lastText) return;
    lastKey = key;
    lastText = text;
    phaseIndex += 1;
    broadcastToChat(chatId, {
      type: 'chat_status',
      householdId,
      chatId,
      user,
      requestId: rid,
      statusKey: key,
      statusText: text,
      phaseIndex,
      done: false,
    });
  }

  function done() {
    if (finished || typeof broadcastToChat !== 'function') return;
    finished = true;
    broadcastToChat(chatId, {
      type: 'chat_status',
      householdId,
      chatId,
      user,
      requestId: rid,
      statusKey: 'done',
      statusText: '',
      phaseIndex: phaseIndex + 1,
      done: true,
    });
  }

  return { emit, done };
}

