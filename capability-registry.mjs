import { sanitizePendingAction } from './pending-state.mjs';

const CAPABILITY_ALIASES = new Map([
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
  if (capability === 'memory.save') {
    const pending = sanitizePendingAction({
      command: '!remember',
      args: { key: src.key, value: src.value },
    });
    return pending ? { key: pending.args.key, value: pending.args.value } : null;
  }
  if (capability === 'grocery.generate_and_commit') {
    const pendingPayload = { command: '!grocerylist' };
    if (src.mode != null && src.mode !== '') pendingPayload.mode = src.mode;
    if (src.source != null && src.source !== '') pendingPayload.source = src.source;
    const pending = sanitizePendingAction(pendingPayload);
    if (!pending) return null;
    const out = {};
    if (pending.mode) out.mode = pending.mode;
    if (pending.source) out.source = pending.source;
    return out;
  }
  if (capability === 'weekly_plan.patch') {
    const pending = sanitizePendingAction({
      command: 'weekly_plan_draft_patch',
      patch: src.patch,
    });
    return pending ? { patch: pending.patch } : null;
  }
  if (capability === 'chat.rename') {
    const pending = sanitizePendingAction({
      command: '!rename',
      mode: src.mode,
      args: src.args,
    });
    if (!pending) return null;
    const out = { mode: pending.mode || 'auto' };
    if (pending.args?.title) out.args = { title: pending.args.title };
    return out;
  }
  if (capability === 'help.show') {
    return {};
  }
  return null;
}

export const CAPABILITY_REGISTRY = Object.freeze({
  'memory.save': {
    capability: 'memory.save',
    confirmationPolicy: 'confirm_or_execute',
    interpreterDescription: 'Save or update a durable household memory key/value pair.',
    humanLabel: 'memory save',
  },
  'grocery.generate_and_commit': {
    capability: 'grocery.generate_and_commit',
    confirmationPolicy: 'confirm_or_execute',
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

const COMMAND_TO_CAPABILITY = new Map([
  ['!remember', 'memory.save'],
  ['!grocerylist', 'grocery.generate_and_commit'],
  ['weekly_plan_draft_patch', 'weekly_plan.patch'],
  ['!rename', 'chat.rename'],
  ['!help', 'help.show'],
]);

export function listCapabilitiesForInterpreter() {
  return Object.values(CAPABILITY_REGISTRY).map((entry) => ({
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

export function runtimeActionToPendingAction(action) {
  const normalized = normalizeRuntimeAction(action);
  if (!normalized) return null;
  if (normalized.capability === 'memory.save') {
    return sanitizePendingAction({
      command: '!remember',
      args: { key: normalized.input.key, value: normalized.input.value },
    });
  }
  if (normalized.capability === 'grocery.generate_and_commit') {
    return sanitizePendingAction({
      command: '!grocerylist',
      mode: normalized.input.mode,
      source: normalized.input.source,
    });
  }
  if (normalized.capability === 'weekly_plan.patch') {
    return sanitizePendingAction({
      command: 'weekly_plan_draft_patch',
      patch: normalized.input.patch,
    });
  }
  if (normalized.capability === 'chat.rename') {
    return sanitizePendingAction({
      command: '!rename',
      mode: normalized.input.mode,
      args: normalized.input.args,
    });
  }
  if (normalized.capability === 'help.show') {
    return sanitizePendingAction({ command: '!help' });
  }
  return null;
}

export function pendingActionToRuntimeAction(action) {
  const pending = sanitizePendingAction(action);
  if (!pending) return null;
  const capability = COMMAND_TO_CAPABILITY.get(String(pending.command ?? ''));
  if (!capability) return null;
  if (capability === 'memory.save') {
    return normalizeRuntimeAction({
      capability,
      input: { key: pending.args.key, value: pending.args.value },
    });
  }
  if (capability === 'grocery.generate_and_commit') {
    return normalizeRuntimeAction({
      capability,
      input: { mode: pending.mode, source: pending.source },
    });
  }
  if (capability === 'weekly_plan.patch') {
    return normalizeRuntimeAction({
      capability,
      input: { patch: pending.patch },
    });
  }
  if (capability === 'chat.rename') {
    return normalizeRuntimeAction({
      capability,
      input: { mode: pending.mode, args: pending.args },
    });
  }
  if (capability === 'help.show') {
    return normalizeRuntimeAction({ capability, input: {} });
  }
  return null;
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

export function renderSmartPendingReply(action, memoriesByKey = null) {
  const normalized = normalizeRuntimeAction(action) || pendingActionToRuntimeAction(action);
  if (!normalized) return 'I can do that. Want me to go ahead?';

  if (normalized.capability === 'grocery.generate_and_commit') {
    if (normalized.input?.mode === 'replace') {
      return "If you'd like, I can replace what's currently on your Grocery List tab with this list.";
    }
    if (normalized.input?.mode === 'prune') {
      return 'If you want, I can update the Grocery List tab and remove the items that no longer fit this plan.';
    }
    return 'If you want, I can add these to your Grocery List tab.';
  }

  if (normalized.capability === 'memory.save') {
    const key = String(normalized.input?.key ?? '').trim();
    const value = String(normalized.input?.value ?? '').trim();
    const memMap = memoriesByKey instanceof Map ? memoriesByKey : null;
    if (memMap && key && memMap.has(key)) {
      const existing = String(memMap.get(key) ?? '').trim();
      if (existing && existing !== value) {
        return `I can update the saved ${key.replace(/_/g, ' ')} note to include “${truncateHumanSnippet(value, 120)}.” Want me to go ahead?`;
      }
    }
    if (key && value) {
      return `I can save that in household memory as ${key.replace(/_/g, ' ')}: “${truncateHumanSnippet(value, 120)}.” Want me to go ahead?`;
    }
    return 'I can save that in household memory. Want me to go ahead?';
  }

  if (normalized.capability === 'chat.rename') {
    if (normalized.input?.mode === 'manual' && normalized.input?.args?.title) {
      return `I can rename this chat to “${truncateHumanSnippet(normalized.input.args.title, 120)}.” Want me to go ahead?`;
    }
    return 'I can rename this chat based on the conversation. Want me to go ahead?';
  }

  if (normalized.capability === 'help.show') {
    return 'I can show a quick overview of what I can help with. Want me to open that?';
  }

  if (normalized.capability === 'weekly_plan.patch') {
    return 'I can update your weekly dinner plan for this chat. Want me to go ahead?';
  }

  return 'I can do that. Want me to go ahead?';
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
        `I saved that in household memory as ${String(outcome.key).replace(/_/g, ' ')}: “${truncateHumanSnippet(outcome.storedValue, 120)}.”`,
        `I added that to household memory under ${String(outcome.key).replace(/_/g, ' ')}: “${truncateHumanSnippet(outcome.storedValue, 120)}.”`,
      ]);
    }
    if (outcome.status === 'updated' && outcome.key) {
      return pickStableVariant(seed, [
        `I updated the saved ${String(outcome.key).replace(/_/g, ' ')} note.`,
        `I updated that household memory entry for ${String(outcome.key).replace(/_/g, ' ')}.`,
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
      return outcome.error || 'I could not save that to household memory.';
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
