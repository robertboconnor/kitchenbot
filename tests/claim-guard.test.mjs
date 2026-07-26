import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeToolTrace,
  parseVerifierResponse,
  buildClaimCorrectionMessage,
  verifyReplyClaims,
  turnPersistedAWrite,
} from '../kb-claim-guard.mjs';

// --- summarizeToolTrace: structural fact summary (deterministic) ---

const gWrite = (status, extra = {}) => ({
  ok: true,
  capability: 'grocery.write',
  isWrite: true,
  outcome: { capability: 'grocery.write', status, ...extra },
});

test('summarizeToolTrace marks a real persisted write', () => {
  const t = summarizeToolTrace([gWrite('written', { addedItems: ['milk'] })]);
  assert.match(t, /grocery\.write/);
  assert.match(t, /kind: write/);
  assert.match(t, /persisted_a_change: true/);
  assert.match(t, /"addedItems":\["milk"\]/);
});

test('summarizeToolTrace: a non-committal status did not persist', () => {
  assert.match(summarizeToolTrace([gWrite('ambiguous')]), /persisted_a_change: false/);
});

test('summarizeToolTrace: a failed write did not persist', () => {
  const t = summarizeToolTrace([{ ok: false, capability: 'cookbook.save', isWrite: true, outcome: { status: 'error' } }]);
  assert.match(t, /ok: false/);
  assert.match(t, /persisted_a_change: false/);
});

test('summarizeToolTrace: reads are labeled read, with no persisted flag', () => {
  const t = summarizeToolTrace([{ ok: true, capability: 'grocery.list', isWrite: false, outcome: { items: [] } }]);
  assert.match(t, /kind: read/);
  assert.doesNotMatch(t, /persisted_a_change/);
});

// --- parseVerifierResponse: extract the forced tool call (deterministic) ---

test('parseVerifierResponse extracts claims from the forced tool call', () => {
  const r = parseVerifierResponse({
    content: [{ type: 'tool_use', name: 'report_unsupported_claims', input: { unsupportedClaims: ['saved it', ' added milk '] } }],
  });
  assert.deepEqual(r, ['saved it', 'added milk']);
});

test('parseVerifierResponse returns [] for no/other tool call or bad shape', () => {
  assert.deepEqual(parseVerifierResponse({ content: [{ type: 'text', text: 'x' }] }), []);
  assert.deepEqual(parseVerifierResponse({}), []);
  assert.deepEqual(parseVerifierResponse({ content: [{ type: 'tool_use', name: 'report_unsupported_claims', input: {} }] }), []);
});

// --- buildClaimCorrectionMessage (deterministic) ---

test('buildClaimCorrectionMessage: internal framing, evidence embedded, fresh-reply contract', () => {
  const m = buildClaimCorrectionMessage(
    ['I added milk to your list'],
    [gWrite('ambiguous', { addedItems: [] })],
  );
  // (1) Declares itself internal — it is injected as a user-role message, and without this the
  // brain replies to the corrector instead of the user (the prod meta-reply bug).
  assert.match(m, /INTERNAL CHECK/);
  assert.match(m, /NOT from the user/);
  assert.match(m, /Never mention, quote, or respond/i);
  // (2) Quotes the claims AND shows the evidence (the old message told the brain it lied with
  // no trace attached — the rewrites came out defensive).
  assert.match(m, /I added milk to your list/);
  assert.match(m, /grocery\.write/); // the embedded tool trace
  // (3) Demands a fresh user-facing reply with no meta-narration.
  assert.match(m, /fresh reply TO THE USER/i);
  assert.match(m, /answering their last message/i);
  assert.match(m, /No timelines/i);
  assert.match(m, /Do not repeat the unsupported claim/i);
});

test('buildClaimCorrectionMessage: empty trace is stated plainly', () => {
  const m = buildClaimCorrectionMessage(['Saved it!'], []);
  assert.match(m, /no tools were called this turn/i);
  assert.match(m, /Saved it!/);
});

// --- verifyReplyClaims with a MOCK client (hermetic: no householdId → no usage-ledger write) ---

function mockClient(captured, response) {
  return { messages: { create: async (params) => { captured.params = params; return response; } } };
}

test('verifyReplyClaims returns the verifier claims and sends the reply + trace', async () => {
  const captured = {};
  const client = mockClient(captured, {
    content: [{ type: 'tool_use', name: 'report_unsupported_claims', input: { unsupportedClaims: ['Saved it!'] } }],
  });
  // 'ambiguous' is non-committal → nothing persisted → the verifier actually runs (a
  // persisted write would short-circuit via the write-persisted skip, tested below).
  const r = await verifyReplyClaims({
    anthropic: client,
    replyText: 'Saved it!',
    collectedOutcomes: [gWrite('ambiguous', { addedItems: ['milk'] })],
    ids: {},
  });
  assert.deepEqual(r.unsupportedClaims, ['Saved it!']);
  assert.equal(r.checked, true);
  assert.equal(captured.params.tool_choice.name, 'report_unsupported_claims');
  assert.match(captured.params.messages[0].content, /DRAFT REPLY:\nSaved it!/);
  assert.match(captured.params.messages[0].content, /grocery\.write/); // trace was included
});

// --- turnPersistedAWrite + the write-persisted verifier skip ---

test('turnPersistedAWrite: only a successful committal write counts', () => {
  assert.equal(turnPersistedAWrite([gWrite('written')]), true);
  assert.equal(turnPersistedAWrite([gWrite('ambiguous')]), false); // non-committal status
  assert.equal(turnPersistedAWrite([{ ok: false, capability: 'cookbook.save', isWrite: true, outcome: { status: 'error' } }]), false);
  assert.equal(turnPersistedAWrite([{ ok: true, capability: 'grocery.list', isWrite: false, outcome: {} }]), false); // read
  assert.equal(turnPersistedAWrite([{ ok: false, capability: 'nope', outcome: null, resultText: 'threw' }]), false); // error shape w/o isWrite fails closed
  assert.equal(turnPersistedAWrite([]), false);
  assert.equal(turnPersistedAWrite(undefined), false);
  // Mixed turn: one persisted write among reads → the turn persisted a write.
  assert.equal(turnPersistedAWrite([{ ok: true, capability: 'grocery.list', isWrite: false, outcome: {} }, gWrite('written')]), true);
});

test('the verifier rubric is turn-scoped: allows read-backed state reports and prior-turn references', async () => {
  // The rubric lives in the system prompt; assert its load-bearing rules via the captured params
  // (keeps the module's export surface unchanged). These rules are what stop truthful replies
  // like "yes — that's fixed" (after a cookbook.get) from being flagged as lies.
  const captured = {};
  const client = mockClient(captured, {
    content: [{ type: 'tool_use', name: 'report_unsupported_claims', input: { unsupportedClaims: [] } }],
  });
  await verifyReplyClaims({ anthropic: client, replyText: 'Yes — that is fixed.', ids: {} });
  const system = String(captured.params.system);
  assert.match(system, /NEWLY performed a change THIS turn/i); // turn-scoping
  assert.match(system, /STATE REPORTS BACKED BY A READ/); // state-report allowance
  assert.match(system, /cookbook\.get/); // the worked example survived
  assert.match(system, /EARLIER turns/); // prior-turn reference allowance
  assert.match(system, /Do not re-litigate history/i);
  assert.match(system, /When in doubt.*do NOT flag/i); // fail-open closer intact
});

test('verifyReplyClaims SKIPS the model call entirely when the turn persisted a write', async () => {
  // A throwing client proves the verifier is never invoked (the established prove-no-call idiom).
  const client = { messages: { create: async () => { throw new Error('verifier must not be called when a write persisted'); } } };
  const r = await verifyReplyClaims({
    anthropic: client,
    replyText: 'Saved it! The recipe is in your cookbook.',
    collectedOutcomes: [gWrite('written', { addedItems: ['milk'] })],
    ids: {},
  });
  assert.deepEqual(r.unsupportedClaims, []);
  assert.equal(r.checked, false);
  assert.equal(r.skipped, 'write_persisted');
});

test('verifyReplyClaims returns [] on a clean verdict', async () => {
  const client = mockClient({}, {
    content: [{ type: 'tool_use', name: 'report_unsupported_claims', input: { unsupportedClaims: [] } }],
  });
  const r = await verifyReplyClaims({ anthropic: client, replyText: 'Here are some dinner ideas.', ids: {} });
  assert.deepEqual(r.unsupportedClaims, []);
});

test('verifyReplyClaims FAILS OPEN when the verifier errors', async () => {
  const client = { messages: { create: async () => { throw new Error('api down'); } } };
  const r = await verifyReplyClaims({ anthropic: client, replyText: 'Saved it!', ids: {} });
  assert.deepEqual(r.unsupportedClaims, []);
  assert.equal(r.error, true);
});

test('verifyReplyClaims skips the call for an empty reply or a missing client', async () => {
  assert.deepEqual((await verifyReplyClaims({ replyText: '' })).unsupportedClaims, []);
  assert.deepEqual((await verifyReplyClaims({ replyText: 'hi' })).unsupportedClaims, []); // no client → fail-open
});
