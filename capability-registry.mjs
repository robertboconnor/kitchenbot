const CAPABILITY_ALIASES = new Map([
  ['grocery.preview', 'grocery.preview'],
  ['grocery.list.preview', 'grocery.preview'],
  ['grocerylist.preview', 'grocery.preview'],
  ['grocery.generate', 'grocery.generate_and_commit'],
  ['grocery.build', 'grocery.generate_and_commit'],
  ['grocery.create', 'grocery.generate_and_commit'],
  ['grocery.update', 'grocery.generate_and_commit'],
  ['grocery.commit', 'grocery.generate_and_commit'],
  ['grocery.list.generate', 'grocery.generate_and_commit'],
  ['grocery_list.generate_and_commit', 'grocery.generate_and_commit'],
  ['grocerylist.generate_and_commit', 'grocery.generate_and_commit'],
]);

function canonicalizeCapability(raw) {
  const capability = String(raw ?? '').trim();
  if (!capability) return '';
  return CAPABILITY_ALIASES.get(capability) || capability;
}

function sanitizeRuntimeActionInput(capability, input) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (capability === 'grocery.preview') {
    return {};
  }
  if (capability === 'memory.save') {
    const key = String(src.key ?? '').trim();
    const value = String(src.value ?? '').trim();
    if (!key || !value) return null;
    return { key, value };
  }
  if (capability === 'grocery.generate_and_commit') {
    const out = {};
    if (src.mode != null && src.mode !== '') {
      const mode = String(src.mode).trim().toLowerCase();
      if (!['append', 'replace', 'prune'].includes(mode)) return null;
      out.mode = mode;
    }
    if (src.source != null && src.source !== '') {
      const source = String(src.source).trim();
      if (!source) return null;
      out.source = source;
    }
    return out;
  }
  if (capability === 'weekly_plan.patch') {
    const patch = src.patch && typeof src.patch === 'object' && !Array.isArray(src.patch) ? src.patch : null;
    return patch ? { patch } : null;
  }
  if (capability === 'chat.rename') {
    const mode = String(src.mode ?? 'auto').trim().toLowerCase();
    if (!['auto', 'manual', 'set'].includes(mode)) return null;
    const out = { mode };
    const title = String(src.args?.title ?? '').trim();
    if (title) out.args = { title };
    return out;
  }
  if (capability === 'help.show') {
    return {};
  }
  return null;
}

export const CAPABILITY_REGISTRY = Object.freeze({
  'grocery.preview': {
    capability: 'grocery.preview',
    confirmationPolicy: 'execute',
    interpreterDescription: 'Generate a grocery list preview in chat from the current meal-planning context without updating the Grocery List tab.',
    humanLabel: 'grocery preview',
  },
  'memory.save': {
    capability: 'memory.save',
    confirmationPolicy: 'execute',
    interpreterDescription: 'Save or update a durable household memory key/value pair.',
    humanLabel: 'memory save',
  },
  'grocery.generate_and_commit': {
    capability: 'grocery.generate_and_commit',
    confirmationPolicy: 'execute',
    interpreterDescription: 'Generate or commit grocery list changes for this chat.',
    humanLabel: 'grocery list update',
  },
  'weekly_plan.patch': {
    capability: 'weekly_plan.patch',
    confirmationPolicy: 'execute',
    interpreterDescription: 'Update the chat-scoped weekly dinner plan. Preserve other meals unless the user clearly replaces the whole plan.',
    humanLabel: 'weekly plan update',
  },
  'chat.rename': {
    capability: 'chat.rename',
    confirmationPolicy: 'execute',
    interpreterDescription: 'Rename the current chat automatically or to a supplied title.',
    humanLabel: 'chat rename',
  },
  'help.show': {
    capability: 'help.show',
    confirmationPolicy: 'execute',
    interpreterDescription: 'Show the help menu.',
    humanLabel: 'help',
  },
});

export function listCapabilitiesForInterpreter(opts = {}) {
  const includeWeeklyPlanPatch = opts.includeWeeklyPlanPatch !== false;
  return Object.values(CAPABILITY_REGISTRY)
    .filter((entry) => includeWeeklyPlanPatch || entry.capability !== 'weekly_plan.patch')
    .map((entry) => ({
    capability: entry.capability,
    confirmationPolicy: entry.confirmationPolicy,
    description: entry.interpreterDescription,
  }));
}

export function normalizeRuntimeAction(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const capability = canonicalizeCapability(raw.capability);
  if (!capability || !CAPABILITY_REGISTRY[capability]) return null;
  const input = sanitizeRuntimeActionInput(capability, raw.input);
  if (input == null) return null;
  return { capability, input };
}

export function normalizeRuntimeActionList(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return [];
  const out = [];
  for (const action of actions) {
    const normalized = normalizeRuntimeAction(action);
    if (!normalized) return [];
    out.push(normalized);
  }
  return out;
}

export function classifyRuntimeAction(action) {
  const normalized = normalizeRuntimeAction(action);
  if (!normalized) return null;
  const meta = CAPABILITY_REGISTRY[normalized.capability];
  return {
    action: normalized,
    capability: normalized.capability,
    confirmationPolicy: meta.confirmationPolicy,
  };
}

function truncateHumanSnippet(text, max = 80) {
  const s = String(text ?? '').trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function stableVariantIndex(seed, count) {
  const text = String(seed ?? '');
  if (!text || !Number.isFinite(count) || count <= 1) return 0;
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash % count;
}

function pickStableVariant(seed, options) {
  const variants = Array.isArray(options) ? options.filter((option) => String(option ?? '').trim()) : [];
  if (variants.length === 0) return null;
  return variants[stableVariantIndex(seed, variants.length)];
}

export function renderSmartHelpReply() {
  return [
    'Here’s what I can help with in Smart Mode:',
    '',
    'I can save household preferences or notes for later.',
    'I can build or update the Grocery List tab from this conversation.',
    'I can help shape a weekly dinner plan for this chat.',
    'I can rename this chat when you want a cleaner title.',
  ].join('\n');
}

export function renderSmartExecutionOutcome(outcome, opts = {}) {
  if (!outcome || typeof outcome !== 'object') return null;
  const seed = JSON.stringify([
    outcome.capability,
    outcome.status,
    outcome.mode,
    outcome.key,
    outcome.title,
    outcome.storedValue,
    outcome.parsedItemCount,
    outcome.counts?.changedTotal,
  ]);

  if (outcome.capability === 'memory.save') {
    if (outcome.status === 'saved' && outcome.key && outcome.storedValue) {
      return pickStableVariant(seed, [
        `I saved that for later as ${String(outcome.key).replace(/_/g, ' ')}: “${truncateHumanSnippet(outcome.storedValue, 120)}.”`,
        `I added that to saved memory under ${String(outcome.key).replace(/_/g, ' ')}: “${truncateHumanSnippet(outcome.storedValue, 120)}.”`,
      ]);
    }
    if (outcome.status === 'updated' && outcome.key) {
      return pickStableVariant(seed, [
        `I updated the saved ${String(outcome.key).replace(/_/g, ' ')} memory.`,
        `I updated that saved memory entry for ${String(outcome.key).replace(/_/g, ' ')}.`,
      ]);
    }
    if (outcome.status === 'unchanged') {
      return pickStableVariant(seed, [
        'That was already saved, so there was nothing new to update.',
        'I already had that saved, so nothing needed to change.',
      ]);
    }
    if (outcome.status === 'skipped') {
      return null;
    }
    if (outcome.status === 'invalid') {
      return outcome.error || 'I could not save that to memory.';
    }
  }

  if (outcome.capability === 'grocery.generate_and_commit') {
    if (outcome.status === 'committed') {
      if (outcome.changed === true && outcome.mode === 'replace') {
        return pickStableVariant(seed, [
          'I replaced the Grocery List tab with the new list.',
          'I refreshed the Grocery List tab with the new list.',
        ]);
      }
      if (outcome.changed === true && outcome.mode === 'prune') {
        return pickStableVariant(seed, [
          'I updated the Grocery List tab and removed the items we swapped out.',
          'I refreshed the Grocery List tab and cleared the items that no longer fit this plan.',
        ]);
      }
      if (outcome.changed === true) {
        return pickStableVariant(seed, [
          'I updated the Grocery List tab.',
          'I added that to the Grocery List tab.',
        ]);
      }
      if (Number(outcome.parsedItemCount || 0) > 0) {
        return pickStableVariant(seed, [
          'The Grocery List tab already had those items, so there was nothing new to change.',
          'Those items were already on the Grocery List tab, so I did not need to change anything.',
        ]);
      }
      return pickStableVariant(seed, [
        'I could not turn this conversation into Grocery List items yet.',
        'I was not able to build Grocery List items from this yet.',
      ]);
    }
    if (outcome.status === 'needs_mode_choice') {
      return outcome.question || 'I need one quick choice before I update the Grocery List tab.';
    }
  }

  if (outcome.capability === 'weekly_plan.patch' && outcome.status === 'patched') {
    const patch = outcome.resolvedPatch && typeof outcome.resolvedPatch === 'object'
      ? outcome.resolvedPatch
      : outcome.patch && typeof outcome.patch === 'object'
        ? outcome.patch
        : {};
    const parts = [];
    if (typeof patch.label === 'string' && patch.label.trim()) parts.push(`title “${truncateHumanSnippet(patch.label, 48)}”`);
    if (Array.isArray(patch.meals) && patch.meals.length) parts.push(`${patch.meals.length} dinner idea${patch.meals.length === 1 ? '' : 's'}`);
    if (Array.isArray(patch.mealEdits) && patch.mealEdits.length) parts.push(`${patch.mealEdits.length} targeted update${patch.mealEdits.length === 1 ? '' : 's'}`);
    if (typeof patch.notes === 'string' && patch.notes.trim()) parts.push('notes');
    if (typeof patch.status === 'string' && patch.status.trim()) parts.push(`status ${patch.status}`);
    if (Number.isFinite(Number(outcome.changedSlots)) && Number(outcome.changedSlots) > 0 && !Array.isArray(patch.meals)) {
      parts.push(`${Number(outcome.changedSlots)} slot${Number(outcome.changedSlots) === 1 ? '' : 's'} changed`);
    }
    if (Number.isFinite(Number(outcome.preservedSlots)) && Number(outcome.preservedSlots) > 0) {
      parts.push(`${Number(outcome.preservedSlots)} preserved`);
    }
    if (parts.length === 0) {
      return pickStableVariant(seed, [
        'I updated your weekly dinner plan.',
        'I updated the weekly dinner plan for this chat.',
      ]);
    }
    return pickStableVariant(seed, [
      `I updated your weekly dinner plan (${parts.join(', ')}).`,
      `I updated the weekly dinner plan for this chat (${parts.join(', ')}).`,
    ]);
  }

  if (outcome.capability === 'chat.rename' && outcome.status === 'renamed') {
    return pickStableVariant(seed, [
      `I renamed this chat to “${truncateHumanSnippet(outcome.title || 'New chat', 120)}.”`,
      `This chat is now called “${truncateHumanSnippet(outcome.title || 'New chat', 120)}.”`,
    ]);
  }

  if (outcome.capability === 'help.show' && outcome.status === 'shown') {
    return renderSmartHelpReply();
  }

  if (typeof outcome.reply === 'string' && outcome.reply.trim()) {
    return outcome.reply.trim();
  }

  if (typeof outcome.error === 'string' && outcome.error.trim()) {
    return outcome.error.trim();
  }

  return null;
}

export function renderSmartExecutionOutcomes(outcomes, opts = {}) {
  if (!Array.isArray(outcomes) || outcomes.length === 0) return null;
  const lines = outcomes.map((outcome) => renderSmartExecutionOutcome(outcome, opts)).filter(Boolean);
  if (lines.length === 0) return null;
  return lines.join(' ');
}

export function parseExplicitBangCommand(prompt, deps) {
  const routePrompt = String(prompt ?? '').trim();
  if (!routePrompt.startsWith('!')) return null;

  const memoryParsed = deps.parseMemoryCommand(routePrompt);
  if (memoryParsed && !memoryParsed.error) {
    return normalizeRuntimeAction({
      capability: 'memory.save',
      input: { key: memoryParsed.key, value: memoryParsed.value },
    });
  }

  if (deps.isGroceryListCommand(routePrompt)) {
    return normalizeRuntimeAction({
      capability: 'grocery.generate_and_commit',
      input: {},
    });
  }

  if (routePrompt === '!help' && deps.isPrivateChatCommand(routePrompt)) {
    return normalizeRuntimeAction({
      capability: 'help.show',
      input: {},
    });
  }

  const renameMatch = routePrompt.match(/^!rename\s*(.*)$/);
  if (renameMatch) {
    const arg = typeof renameMatch[1] === 'string' ? renameMatch[1].trim() : '';
    if (arg) {
      return normalizeRuntimeAction({
        capability: 'chat.rename',
        input: { mode: 'manual', args: { title: arg } },
      });
    }
    return normalizeRuntimeAction({
      capability: 'chat.rename',
      input: { mode: 'auto' },
    });
  }

  return null;
}
