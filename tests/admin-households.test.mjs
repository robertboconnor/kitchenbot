import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAdminHouseholdSummary,
  normalizeAdminUsage,
  normalizeAdminUsers,
} from '../admin-households.mjs';

test('normalizeAdminHouseholdSummary adds message totals and anthropic status label', () => {
  const summary = normalizeAdminHouseholdSummary(
    {
      id: 1,
      name: 'Rob and Elle',
      householdKey: 'oconnor-home',
      anthropicKeyMode: 'shared',
      webSearchEnabled: true,
    },
    {
      total_messages: 42,
      latest_message_at: '2026-04-10 11:00:00',
    }
  );

  assert.equal(summary.totalMessages, 42);
  assert.equal(summary.latestMessageAt, '2026-04-10 11:00:00');
  assert.equal(summary.anthropicStatusLabel, 'Using shared key');
});

test('normalizeAdminUsage and users map legacy row shapes for the admin UI', () => {
  const usage = normalizeAdminUsage(
    { total_messages: 7, latest_message_at: '2026-04-10 12:00:00' },
    [{ name: 'Rob', message_count: 5 }, { display_name: 'Elle', message_count: 2 }]
  );
  assert.deepEqual(usage, {
    totalMessages: 7,
    latestMessageAt: '2026-04-10 12:00:00',
    messagesByUser: [
      { displayName: 'Rob', count: 5 },
      { displayName: 'Elle', count: 2 },
    ],
  });

  const users = normalizeAdminUsers([
    { id: 1, display_name: 'Rob', role: 'owner' },
    { id: 2, displayName: 'Elle', role: 'member' },
  ]);
  assert.equal(users[0].displayName, 'Rob');
  assert.equal(users[1].displayName, 'Elle');
});
