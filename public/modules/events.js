// A tiny event bus — the seam that lets features stop reaching into each other.
//
// Before this, public/app.js was one global scope where any function could read or write any of
// 37 module-level variables. Splitting it into feature modules only helps if the features stop
// depending on each other's internals; otherwise the imports just make the tangle explicit.
//
// The rule: a feature module owns its own state and never imports another feature. When something
// happens that others care about, it publishes an event. Listeners react. No feature knows who
// else is listening, so features can be extracted, reordered, or removed independently.

/** @type {Map<string, Set<Function>>} */
const listeners = new Map();

/** Every event name in the app, declared in one place so a typo is findable. */
export const EVENTS = {
  /** The active chat changed (or was cleared). detail: { chatId } */
  CHAT_CHANGED: 'chat:changed',
  /** The signed-in user's session/identity was loaded or refreshed. detail: { session } */
  SESSION_CHANGED: 'session:changed',
  /** The main tab changed. detail: { tab } */
  TAB_CHANGED: 'tab:changed',
  /** The Kitchen sub-view changed. detail: { view } */
  KITCHEN_VIEW_CHANGED: 'kitchen:view-changed',
  /** Read-only (God Mode impersonation) was toggled. detail: { readOnly } */
  READ_ONLY_CHANGED: 'readonly:changed',
  /** The meal plan was mutated and any view of it should refresh. */
  PLAN_CHANGED: 'plan:changed',
  /** Something wants the chat composer pre-filled and focused. detail: { text } */
  COMPOSE_PROMPT: 'compose:prompt',
};

export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => off(event, handler);
}

export function off(event, handler) {
  listeners.get(event)?.delete(handler);
}

/**
 * Publish an event. A throwing listener must not prevent the others from running, or one broken
 * feature would silently take down unrelated ones — the exact failure mode this split is meant
 * to end. Errors are reported and swallowed.
 */
export function emit(event, detail = {}) {
  const handlers = listeners.get(event);
  if (!handlers) return;
  for (const handler of [...handlers]) {
    try {
      handler(detail);
    } catch (error) {
      console.error(`[events] listener for "${event}" threw:`, error);
    }
  }
}

/** Test/teardown helper — not used by app code. */
export function clearAllListeners() {
  listeners.clear();
}
