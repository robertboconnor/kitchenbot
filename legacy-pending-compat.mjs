import { sanitizePendingAction } from './pending-state.mjs';
import { normalizeRuntimeAction } from './capability-registry.mjs';

const COMMAND_TO_CAPABILITY = new Map([
  ['!remember', 'memory.save'],
  ['!grocerylist', 'grocery.generate_and_commit'],
  ['weekly_plan_draft_patch', 'weekly_plan.patch'],
  ['!rename', 'chat.rename'],
  ['!help', 'help.show'],
]);

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

export function runtimeActionToPendingAction(action) {
  const normalized = normalizeRuntimeAction(action);
  if (!normalized) return null;
  if (normalized.capability === 'grocery.preview') return null;
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

export function renderSmartPendingReply(action, memoriesByKey = null) {
  const normalized = normalizeRuntimeAction(action);
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
        return `I can update the saved memory for ${key.replace(/_/g, ' ')} to include “${truncateHumanSnippet(value, 120)}.” Want me to go ahead?`;
      }
    }
    if (key && value) {
      return `I can save that for later as ${key.replace(/_/g, ' ')}: “${truncateHumanSnippet(value, 120)}.” Want me to go ahead?`;
    }
    return 'I can save that for later. Want me to go ahead?';
  }

  if (normalized.capability === 'chat.rename') {
    if (normalized.input?.mode === 'manual' && normalized.input?.args?.title) {
      return `If you want, I can rename this chat to "${truncateHumanSnippet(normalized.input.args.title, 120)}."`;
    }
    return 'If you want, I can rename this chat for you.';
  }

  if (normalized.capability === 'help.show') {
    return 'If you want, I can show the help menu.';
  }

  if (normalized.capability === 'weekly_plan.patch') {
    return pickStableVariant(JSON.stringify(normalized.input?.patch ?? {}), [
      'If you want, I can update the weekly plan with that change.',
      'I can make that weekly-plan change if you want me to.',
    ]) || 'If you want, I can update the weekly plan.';
  }

  return 'I can do that. Want me to go ahead?';
}
