import test from 'node:test';
import assert from 'node:assert/strict';
import { findUnbackedWriteClaims, buildClaimCorrectionMessage } from '../kb-claim-guard.mjs';

const write = (capability, status, ok = true) => ({ ok, capability, isWrite: true, outcome: { capability, status } });

test('the reported bug: "Saved it!" with no tool calls is flagged', () => {
  const unbacked = findUnbackedWriteClaims('Saved it! You can find it in your cookbook now.', []);
  assert.ok(unbacked.length > 0, 'should flag an unbacked save claim');
});

test('"Saved it!" is honest when a cookbook.save actually succeeded', () => {
  const unbacked = findUnbackedWriteClaims('Saved it!', [write('cookbook.save', 'saved')]);
  assert.equal(unbacked.length, 0);
});

test('claim of saving to cookbook with no cookbook tool call is flagged (cookbook family)', () => {
  const unbacked = findUnbackedWriteClaims('Done — I saved that to your cookbook.', [write('grocery.write', 'committed')]);
  assert.equal(unbacked.length, 1);
  assert.equal(unbacked[0].family, 'cookbook');
});

test('grocery add claim with no grocery write is flagged', () => {
  const unbacked = findUnbackedWriteClaims("I've added butter to your grocery list.", []);
  assert.equal(unbacked.length, 1);
  assert.equal(unbacked[0].family, 'grocery');
});

test('grocery add claim IS backed by a real grocery.write', () => {
  const unbacked = findUnbackedWriteClaims("I've added butter to your grocery list.", [write('grocery.write', 'committed')]);
  assert.equal(unbacked.length, 0);
});

test('a failed/invalid write does NOT back a completion claim', () => {
  const unbacked = findUnbackedWriteClaims('Saved it to your cookbook!', [write('cookbook.save', 'invalid')]);
  assert.equal(unbacked.length, 1);
  assert.equal(unbacked[0].family, 'cookbook');
});

test('"already there" statuses (unchanged/duplicate) DO back an "it\'s in your cookbook" claim', () => {
  for (const status of ['unchanged', 'duplicate', 'already_present']) {
    const unbacked = findUnbackedWriteClaims("It's already in your cookbook.", [write('cookbook.save', status)]);
    assert.equal(unbacked.length, 0, `status ${status} should count as backed`);
  }
});

test('an OFFER (present tense) is not a completion claim, so it is not flagged', () => {
  assert.equal(findUnbackedWriteClaims('Want me to save it to your cookbook? Just say the word.', []).length, 0);
  assert.equal(findUnbackedWriteClaims('I can add butter to your grocery list if you like.', []).length, 0);
});

test('marking a meal cooked with no plan.update is flagged (plan family)', () => {
  const unbacked = findUnbackedWriteClaims("Nice — I've marked the succotash as cooked.", []);
  assert.equal(unbacked.length, 1);
  assert.equal(unbacked[0].family, 'plan');
});

test('a purely conversational reply with no claims is clean', () => {
  const unbacked = findUnbackedWriteClaims(
    "Here's a quick lemon vinaigrette: whisk lemon juice, dijon, honey, then stream in olive oil. Want me to save it?",
    []
  );
  assert.equal(unbacked.length, 0);
});

test('pantry move backs a pantry claim (grocery.move_to_pantry maps to pantry, not grocery)', () => {
  const unbacked = findUnbackedWriteClaims("Moved that into your pantry.", [write('grocery.move_to_pantry', 'moved')]);
  assert.equal(unbacked.length, 0);
});

test('claiming a profile update with no person.profile.update is flagged (profile family)', () => {
  const reply = "I've updated her profile — roasted broccoli is now in her accepted foods and off the rejected list.";
  const unbacked = findUnbackedWriteClaims(reply, []);
  assert.equal(unbacked.length, 1);
  assert.equal(unbacked[0].family, 'profile');
});

test('a real person.profile.update backs the profile claim', () => {
  const reply = "Updated her profile — roasted broccoli is now accepted.";
  const unbacked = findUnbackedWriteClaims(reply, [write('person.profile.update', 'updated')]);
  assert.equal(unbacked.length, 0);
});

test('buildClaimCorrectionMessage names the right tool and forbids the false claim', () => {
  const msg = buildClaimCorrectionMessage([{ family: 'cookbook', phrase: 'saved it' }]);
  assert.match(msg, /cookbook\.save/);
  assert.match(msg, /did NOT successfully call/i);
});
