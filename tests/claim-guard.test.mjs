import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeToolTrace,
  parseVerifierResponse,
  buildClaimCorrectionMessage,
  verifyReplyClaims,
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

test('buildClaimCorrectionMessage quotes the claims and forbids repeating them', () => {
  const m = buildClaimCorrectionMessage(['I added milk to your list']);
  assert.match(m, /I added milk to your list/);
  assert.match(m, /did NOT actually make/i);
  assert.match(m, /not repeat the false claim/i);
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
  const r = await verifyReplyClaims({
    anthropic: client,
    replyText: 'Saved it!',
    collectedOutcomes: [gWrite('written', { addedItems: ['milk'] })],
    ids: {},
  });
  assert.deepEqual(r.unsupportedClaims, ['Saved it!']);
  assert.equal(r.checked, true);
  assert.equal(captured.params.tool_choice.name, 'report_unsupported_claims');
  assert.match(captured.params.messages[0].content, /DRAFT REPLY:\nSaved it!/);
  assert.match(captured.params.messages[0].content, /grocery\.write/); // trace was included
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
