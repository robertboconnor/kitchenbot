import test from 'node:test';
import assert from 'node:assert/strict';

import { streamReplyDelta, resetReplyStream, finishReplyStream } from '../kb-reply.mjs';

// Minimal Express-ish response that records NDJSON writes and flips headersSent
// after the first write (so writeChatStreamEvent only sets headers once).
function makeFakeRes() {
  const chunks = [];
  const res = {
    headersSent: false,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    write(s) {
      chunks.push(String(s));
      this.headersSent = true;
      return true;
    },
    end(s) {
      if (s) chunks.push(String(s));
      this.ended = true;
    },
    ended: false,
    events() {
      return chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
  return res;
}

test('streaming helpers emit the delta → reset → delta → done contract to sender + co-viewers', () => {
  const res = makeFakeRes();
  const broadcasts = [];
  const deps = { broadcastToChat: (chatId, msg) => broadcasts.push({ chatId, msg }) };
  const base = { res, deps, chatId: 7, householdId: 3, turnId: 'T1' };

  // An earlier turn narrates before a tool, then the final turn writes the real reply.
  streamReplyDelta({ ...base, delta: 'let me check that ' });
  resetReplyStream(base); // clears the pre-tool narration
  streamReplyDelta({ ...base, delta: 'Done — 18 eggs on the list.' });
  finishReplyStream(base);

  // Sender NDJSON stream: reset sits between the stale delta and the final delta.
  const senderTypes = res.events().map((e) => e.type);
  assert.deepEqual(senderTypes, ['delta', 'delta_reset', 'delta', 'done']);
  const sender = res.events();
  assert.equal(sender[0].delta, 'let me check that ');
  assert.equal(sender[2].delta, 'Done — 18 eggs on the list.');
  assert.equal(sender[1].turnId, 'T1');
  assert.equal(res.ended, true);

  // Co-viewers over WS get the same ordering via broadcastToChat.
  const coViewerTypes = broadcasts.map((b) => b.msg.type);
  assert.deepEqual(coViewerTypes, ['stream_delta', 'stream_delta_reset', 'stream_delta', 'stream_done']);
  assert.equal(broadcasts[1].msg.householdId, 3);
  assert.equal(broadcasts[1].chatId, 7);
});

test('streamReplyDelta ignores empty deltas (no stray events)', () => {
  const res = makeFakeRes();
  const broadcasts = [];
  const deps = { broadcastToChat: (chatId, msg) => broadcasts.push(msg) };
  streamReplyDelta({ res, deps, chatId: 1, householdId: 1, turnId: 'T', delta: '' });
  assert.equal(res.events().length, 0);
  assert.equal(broadcasts.length, 0);
});

test('resetReplyStream is safe when there is no sender res (co-viewer-only broadcast still fires)', () => {
  const broadcasts = [];
  const deps = { broadcastToChat: (chatId, msg) => broadcasts.push(msg) };
  // No res.write available — should not throw, still broadcasts the reset.
  resetReplyStream({ res: {}, deps, chatId: 2, householdId: 4, turnId: 'T2' });
  assert.deepEqual(broadcasts.map((m) => m.type), ['stream_delta_reset']);
});
