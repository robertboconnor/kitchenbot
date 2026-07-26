// The event bus + session module are the spine of the app.js feature split: features own their
// own state and communicate through these instead of sharing 37 module-level variables. Both are
// pure (no DOM), so they are unit-testable in Node.
import test from 'node:test';
import assert from 'node:assert/strict';

import { EVENTS, clearAllListeners, emit, off, on } from '../public/modules/events.js';
import {
  applyMe,
  clearSession,
  getSession,
  isOwner,
  isReadOnly,
  setNameColors,
  setReadOnly,
} from '../public/modules/session.js';

test('events: subscribers receive published detail, and unsubscribe stops delivery', () => {
  clearAllListeners();
  const seen = [];
  const unsubscribe = on('demo', (d) => seen.push(d.value));

  emit('demo', { value: 1 });
  emit('demo', { value: 2 });
  unsubscribe();
  emit('demo', { value: 3 });

  assert.deepEqual(seen, [1, 2]);
});

test('events: a throwing listener cannot stop the others', () => {
  // Load-bearing: one broken feature must not silently disable unrelated features.
  clearAllListeners();
  const reached = [];
  on('demo', () => { throw new Error('boom'); });
  on('demo', () => reached.push('second listener still ran'));

  assert.doesNotThrow(() => emit('demo', {}));
  assert.deepEqual(reached, ['second listener still ran']);
});

test('events: emitting with no listeners is a no-op, and off() tolerates unknown handlers', () => {
  clearAllListeners();
  assert.doesNotThrow(() => emit('nobody-listening', { a: 1 }));
  assert.doesNotThrow(() => off('nobody-listening', () => {}));
});

test('session: applyMe populates identity and announces the change', () => {
  clearAllListeners();
  clearSession();
  const heard = [];
  on(EVENTS.SESSION_CHANGED, (d) => heard.push(d.session.userName));

  applyMe({ userId: 7, displayName: 'Rob', householdId: 2, assistantName: 'KitchenBot', isOwner: true });

  assert.equal(heard.length, 1);
  assert.equal(heard[0], 'Rob');
  assert.equal(isOwner(), true);
  assert.equal(getSession().householdId, 2);
});

test('session: read-only only announces when it actually flips', () => {
  clearAllListeners();
  clearSession();
  let flips = 0;
  on(EVENTS.READ_ONLY_CHANGED, () => { flips += 1; });

  applyMe({ displayName: 'Rob' });                                   // false -> false, silent
  assert.equal(isReadOnly(), false);
  assert.equal(flips, 0);

  applyMe({ displayName: 'Rob', isImpersonating: true, impersonationReadOnly: true });
  assert.equal(isReadOnly(), true);
  assert.equal(flips, 1);

  setReadOnly(true);   // already true — must not re-announce
  assert.equal(flips, 1);

  setReadOnly(false);
  assert.equal(flips, 2);
});

test('session: impersonating WITHOUT the read-only flag is not read-only', () => {
  clearSession();
  applyMe({ displayName: 'Rob', isImpersonating: true, impersonationReadOnly: false });
  assert.equal(isReadOnly(), false);
});

test('session: snapshots are immutable — a listener cannot corrupt session state', () => {
  clearSession();
  applyMe({ displayName: 'Rob', isOwner: true });
  setNameColors({ Rob: 'blue' });

  const snapshot = getSession();
  snapshot.userName = 'Mallory';
  snapshot.isOwner = false;
  snapshot.nameColors.Rob = 'red';

  assert.equal(getSession().userName, 'Rob');
  assert.equal(isOwner(), true);
  assert.equal(getSession().nameColors.Rob, 'blue');
});

test('session: clearSession resets identity on logout', () => {
  clearSession();
  applyMe({ userId: 7, displayName: 'Rob', householdId: 2, isOwner: true });
  clearSession();

  const s = getSession();
  assert.equal(s.userId, null);
  assert.equal(s.userName, null);
  assert.equal(s.householdId, null);
  assert.equal(s.isOwner, false);
  assert.equal(s.assistantName, 'KitchenBot');
});

test('EVENTS names are unique — a duplicated value would silently cross-wire features', () => {
  const values = Object.values(EVENTS);
  assert.equal(new Set(values).size, values.length);
});
