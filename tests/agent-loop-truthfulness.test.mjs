import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// End-to-end proof of the truthfulness-guard correction path INSIDE the real agent loop:
// a zero-tool draft that falsely claims "Saved it!" must be flagged, corrected via the
// grounded INTERNAL CHECK note (with the tool trace embedded), and the clean rewrite —
// not the false claim, not the canned fallback — must be what actually persists to chat.
// Uses the established child-process temp-DB idiom (cf. cookbook.test.mjs) because
// kb-reply.mjs binds db.mjs at import time; the fake res only needs end() (streamReplyText
// broadcasts instead of writing NDJSON when res.write is absent).
test('LOOP: a false "Saved it!" draft is invisibly corrected into a clean truthful reply', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-loop-truthfulness-'));
  const dbPath = path.join(tempDir, 'loop-truthfulness.db');
  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const loop = await import(new URL('./kb-agent-loop.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({ householdName: 'Home', householdKey: 'home', ownerDisplayName: 'Rob', pin: '1234' });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Guard test');

    // Scripted brain: draft falsely claims a save (no tools were called), then — after the
    // internal correction — produces a clean truthful rewrite.
    const streamCalls = [];
    const scriptedStreams = [
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Saved it! The recipe is in your cookbook.' }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: "I haven't saved anything yet — want me to add it to the cookbook?" }] },
    ];
    // Scripted verifier: flags the false claim, then passes the rewrite.
    const verifierCalls = [];
    const scriptedVerifier = [
      { content: [{ type: 'tool_use', name: 'report_unsupported_claims', input: { unsupportedClaims: ['Saved it!'] } }] },
      { content: [{ type: 'tool_use', name: 'report_unsupported_claims', input: { unsupportedClaims: [] } }] },
    ];
    const anthropic = {
      messages: {
        stream: (params) => { streamCalls.push(params); return { finalMessage: async () => scriptedStreams.shift() }; },
        create: async (params) => {
          if (params?.tool_choice?.name === 'report_unsupported_claims') { verifierCalls.push(params); return scriptedVerifier.shift(); }
          // Anything else (e.g. auto chat titling) may throw: those paths self-catch.
          throw new Error('unexpected non-verifier side-model call');
        },
      },
    };

    const req = { householdId: created.householdId, userId: 1 };
    const res = { end() {} };
    const deps = {
      buildKbContextPacket: async () => null,
      addMessage: db.addMessage,
      broadcastToChat: () => {},
    };
    await loop.runKbAgentLoop({ req, res, name: 'Rob', chatId, prompt: 'save that recipe for me', deps, anthropic, webSearchEnabled: false, recentMessages: [] });

    const messages = await db.getMessages(chatId, created.householdId);
    const assistant = messages.filter((m) => m.role === 'assistant').map((m) => m.content);
    // The correction turn is the LAST message of the second brain call (cache-breakpoint may
    // reshape string content into text blocks, so stringify for inspection).
    const secondCallLastMessage = streamCalls.length > 1
      ? JSON.stringify(streamCalls[1].messages[streamCalls[1].messages.length - 1])
      : '';
    process.stdout.write(JSON.stringify({
      streamCallCount: streamCalls.length,
      verifierCallCount: verifierCalls.length,
      secondCallLastMessage,
      assistant,
    }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  // One flagged draft → exactly one correction regeneration, each verified once.
  assert.equal(parsed.streamCallCount, 2, 'draft + one corrected regeneration');
  assert.equal(parsed.verifierCallCount, 2, 'both the draft and the rewrite were verified');

  // The correction reached the brain as a grounded INTERNAL note (not a bare accusation).
  assert.match(parsed.secondCallLastMessage, /INTERNAL CHECK/);
  assert.match(parsed.secondCallLastMessage, /NOT from the user/);
  assert.match(parsed.secondCallLastMessage, /no tools were called this turn/i);
  assert.match(parsed.secondCallLastMessage, /Saved it!/); // the flagged claim, quoted

  // What persisted is the clean truthful rewrite — not the false claim, not the canned fallback.
  assert.equal(parsed.assistant.length, 1, 'exactly one assistant reply persisted');
  assert.match(parsed.assistant[0], /haven't saved anything yet/);
  assert.doesNotMatch(parsed.assistant[0], /Saved it!/);
  assert.doesNotMatch(parsed.assistant[0], /got ahead of myself/); // the exhaustion fallback did not fire

  await fs.rm(tempDir, { recursive: true, force: true });
});

// The write-persisted skip at loop level is pinned by the unit test in claim-guard.test.mjs
// (throwing client proves no verifier call when a write persisted); a full loop variant with a
// real executor is intentionally omitted to keep this suite fast.
