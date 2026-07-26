// Who is signed in, and what they are allowed to do.
//
// These are the only values that are genuinely cross-cutting: written once when /me resolves, then
// READ by nearly every feature (chat, grocery, pantry, cookbook, settings, admin). Everything else
// in the old 37-variable pile turned out to be feature-local and moves into its own module.
//
// Exposed as functions rather than exported bindings on purpose: an imported `let` is a live
// read-only view for the importer, so every consumer would need to know which module does the
// writing. A getter keeps the ownership one-way — session.js writes, everyone else asks.

import { EVENTS, emit } from './events.js';

/** Ids arrive from /me as numbers or numeric strings; normalize so consumers can compare freely. */
function toIdOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const state = {
  userId: null,
  userName: null,
  householdId: null,
  assistantName: 'KitchenBot',
  isOwner: false,
  /** God Mode impersonation: the viewer may look but not touch. */
  readOnly: false,
  /** Display name -> chat bubble colour, used by chat rendering and settings. */
  nameColors: {},
  /** The raw /me payload, kept for surfaces that need fields not promoted above. */
  raw: null,
};

export const getUserId = () => state.userId;
export const getUserName = () => state.userName;
export const getHouseholdId = () => state.householdId;
export const getAssistantName = () => state.assistantName;
export const isOwner = () => state.isOwner;
export const isReadOnly = () => state.readOnly;
export const getNameColors = () => state.nameColors;

/**
 * The chat bubble colours a household can choose from. Lives here because both ends need it:
 * settings renders the picker, chat renders the bubble.
 */
export const CHAT_COLOR_OPTIONS = [
  { key: 'pink', label: 'Pink' },
  { key: 'blue', label: 'Blue' },
  { key: 'mint', label: 'Mint' },
  { key: 'lavender', label: 'Lavender' },
  { key: 'peach', label: 'Peach' },
];

/** Normalized key for a display name, so colour lookups survive case and stray whitespace. */
export function normalizeDisplayNameKey(name) {
  return String(name == null ? '' : name).trim().toLowerCase();
}

/** The CSS class for a user's chat bubble, from their configured colour (default blue). */
export function userMessageBubbleClass(displayName) {
  const nk = normalizeDisplayNameKey(displayName);
  const raw = nk ? state.nameColors[nk] : undefined;
  const k = typeof raw === 'string' && raw.trim() ? raw.trim().toLowerCase() : 'blue';
  return 'user-msg-chat-' + (CHAT_COLOR_OPTIONS.some((o) => o.key === k) ? k : 'blue');
}
export const getRawMe = () => state.raw;

/**
 * Apply a /me payload. Emits SESSION_CHANGED, and additionally READ_ONLY_CHANGED when the
 * read-only flag flips so features can enable/disable their controls without polling.
 */
export function applyMe(me = {}) {
  const previousReadOnly = state.readOnly;

  state.raw = me;
  state.userId = toIdOrNull(me.userId ?? me.id);
  state.userName = me.displayName ?? me.name ?? null;
  state.householdId = toIdOrNull(me.householdId);
  state.assistantName = me.assistantName || 'KitchenBot';
  state.isOwner = !!me.isOwner;
  state.readOnly = !!(me.isImpersonating && me.impersonationReadOnly);
  state.nameColors = {};
  if (me.chatColors && typeof me.chatColors === 'object' && !Array.isArray(me.chatColors)) {
    for (const k of Object.keys(me.chatColors)) {
      const nk = normalizeDisplayNameKey(k);
      if (nk) state.nameColors[nk] = me.chatColors[k];
    }
  }

  emit(EVENTS.SESSION_CHANGED, { session: getSession() });
  if (state.readOnly !== previousReadOnly) {
    emit(EVENTS.READ_ONLY_CHANGED, { readOnly: state.readOnly });
  }
  return getSession();
}

/** Set the per-user chat colours (settings can change these without a full /me refresh). */
export function setNameColors(map) {
  state.nameColors = map && typeof map === 'object' ? map : {};
  emit(EVENTS.SESSION_CHANGED, { session: getSession() });
}

/**
 * The assistant's name is a household default, so settings can change it without a /me round-trip.
 */
export function setAssistantName(name) {
  const next = String(name || '').trim() || 'KitchenBot';
  if (next === state.assistantName) return;
  state.assistantName = next;
  emit(EVENTS.SESSION_CHANGED, { session: getSession() });
}

/** Explicitly toggle read-only (God Mode enters/leaves impersonation mid-session). */
export function setReadOnly(readOnly) {
  const next = !!readOnly;
  if (next === state.readOnly) return;
  state.readOnly = next;
  emit(EVENTS.READ_ONLY_CHANGED, { readOnly: next });
}

/** Immutable snapshot — handed to event listeners so they cannot mutate session state. */
export function getSession() {
  return { ...state, nameColors: { ...state.nameColors } };
}

/** Clear on logout. */
export function clearSession() {
  state.userId = null;
  state.userName = null;
  state.householdId = null;
  state.assistantName = 'KitchenBot';
  state.isOwner = false;
  state.readOnly = false;
  state.nameColors = {};
  state.raw = null;
  emit(EVENTS.SESSION_CHANGED, { session: getSession() });
}

/**
 * Server errors about read-only mode are unhelpful out of context ("God Mode is read-only"), so
 * swap them for the friendlier impersonation notice when we ARE impersonating. Lives here because
 * it depends only on session state.
 */
export function mapServerReadOnlyErrorMessage(rawError) {
  const text = rawError == null ? '' : String(rawError);
  if (!isReadOnly() || !state.raw || !state.raw.isImpersonating) {
    return text || 'Request failed.';
  }
  if (/God Mode is read-only|Exit God Mode to make changes/i.test(text)) {
    return 'This session is read-only. Exit to make changes.';
  }
  return text || 'Request failed.';
}
