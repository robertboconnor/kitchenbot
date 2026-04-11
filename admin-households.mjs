function getAnthropicStatusLabel(household) {
  const mode = household?.anthropicKeyMode || household?.anthropic_key_mode || 'shared';
  const apiKey = household?.anthropicApiKey ?? household?.anthropic_api_key;
  const hasKey = !!(apiKey && String(apiKey).trim());
  if (mode === 'shared') return 'Using shared key';
  return hasKey ? 'Household key configured' : 'Household key missing';
}

export function normalizeAdminHouseholdSummary(household, stats = null) {
  if (!household) return null;
  const totalMessages =
    stats?.totalMessages ??
    stats?.total_messages ??
    0;
  const latestMessageAt =
    stats?.latestMessageAt ??
    stats?.latest_message_at ??
    null;
  return {
    ...household,
    totalMessages: Number(totalMessages) || 0,
    latestMessageAt: latestMessageAt || null,
    anthropicStatusLabel: getAnthropicStatusLabel(household),
  };
}

export function normalizeAdminUsage(stats = null, messagesByUser = []) {
  return {
    totalMessages: Number(stats?.totalMessages ?? stats?.total_messages ?? 0) || 0,
    latestMessageAt: stats?.latestMessageAt ?? stats?.latest_message_at ?? null,
    messagesByUser: (Array.isArray(messagesByUser) ? messagesByUser : []).map((row) => ({
      displayName: row?.displayName ?? row?.display_name ?? row?.name ?? '—',
      count: Number(row?.count ?? row?.message_count ?? 0) || 0,
    })),
  };
}

export function normalizeAdminUsers(users = []) {
  return (Array.isArray(users) ? users : []).map((user) => ({
    ...user,
    displayName: user?.displayName ?? user?.display_name ?? '',
  }));
}
