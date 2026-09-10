import {
  buildAssistantPersonaSystemText,
  getAssistantPersonaSettings,
} from './kb-persona.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

function readContextText(memoryContext, key) {
  return safeTrim(memoryContext?.[key]) || '(none)';
}

export function formatKbRecentConversation(messages, deps, opts = {}) {
  const limit = Number.isFinite(opts.limit) ? Number(opts.limit) : 12;
  const assistantLabel =
    safeTrim(opts.assistantLabel) ||
    getAssistantPersonaSettings(opts.assistantPersona || opts.defaults).assistantName;
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-limit)
    .map((message) =>
      message.role === 'user'
        ? `${message.name}: ${safeTrim(message.content)}`
        : `${assistantLabel}: ${safeTrim(deps.stripStoredMessageContentForDisplay?.(message.content) ?? message.content)}`
    )
    .filter(Boolean)
    .join('\n\n');
}

export function getKbAssistantPersona(memoryContext = {}) {
  return getAssistantPersonaSettings(memoryContext?.assistantPersona || memoryContext?.householdDefaults);
}

export function buildKbAssistantPersonaSystemText(memoryContext = {}, opts = {}) {
  return buildAssistantPersonaSystemText(memoryContext?.assistantPersona || memoryContext?.householdDefaults, opts);
}

export function formatKbEntityContextText(entityContext = {}) {
  const parts = [];
  if (Array.isArray(entityContext.knownPeople) && entityContext.knownPeople.length > 0) {
    parts.push(`known household people: ${entityContext.knownPeople.join(', ')}`);
  }
  if (entityContext.activeSpeakerLabel || entityContext.activeSpeakerName) {
    parts.push(`active speaker: ${entityContext.activeSpeakerLabel || entityContext.activeSpeakerName}`);
  }
  if (Array.isArray(entityContext.mentionedPersonLabels) && entityContext.mentionedPersonLabels.length > 0) {
    parts.push(`mentioned people: ${entityContext.mentionedPersonLabels.join(', ')}`);
  }
  if (entityContext.householdRelevant) {
    parts.push('household context may be relevant');
  }
  return parts.length > 0 ? parts.join('\n') : '(none)';
}

export function getKbPromptContextSections(memoryContext = {}) {
  return {
    groundedTurn: readContextText(memoryContext, 'groundedTurnText'),
    relevantMemory: readContextText(memoryContext, 'promptText'),
    appliedMemory: readContextText(memoryContext, 'applicationText'),
    structuredHouseholdDefaults: readContextText(memoryContext, 'defaultsText'),
    appliedHouseholdDefaults: readContextText(memoryContext, 'appliedDefaultsText'),
    pantryItems: readContextText(memoryContext, 'pantryText'),
    appliedPantry: readContextText(memoryContext, 'appliedPantryText'),
    pantryContextStatus: safeTrim(memoryContext?.pantryContextStatus) || '(none)',
    groceryItems: readContextText(memoryContext, 'groceryText'),
    appliedGrocery: readContextText(memoryContext, 'appliedGroceryText'),
    cookbookEntries: readContextText(memoryContext, 'cookbookText'),
    appliedCookbook: readContextText(memoryContext, 'appliedCookbookText'),
    groceryPantryOverlap: readContextText(memoryContext, 'groceryPantryOverlapText'),
    capabilities: readContextText(memoryContext, 'capabilitiesText'),
    appMap: readContextText(memoryContext, 'appMapText'),
    localTimeContext: readContextText(memoryContext, 'timeContextText'),
    pendingAction: readContextText(memoryContext, 'pendingActionText'),
    workingContext: readContextText(memoryContext, 'workingContextText'),
    appliedWorkingContext: readContextText(memoryContext, 'appliedWorkingContextText'),
    resolvedEntities: formatKbEntityContextText(memoryContext?.entityContext),
  };
}

export function buildKbContextSystemText(memoryContext = {}) {
  const sections = getKbPromptContextSections(memoryContext);
  return `Grounded turn context:
${sections.groundedTurn}

Relevant saved memory for this turn:
${sections.relevantMemory}

Applied memory and household context:
${sections.appliedMemory}

Structured household defaults:
${sections.structuredHouseholdDefaults}

Applied household defaults:
${sections.appliedHouseholdDefaults}

Pantry items currently on hand:
${sections.pantryItems}

Applied pantry assumptions:
${sections.appliedPantry}

Pantry context status for this turn:
${sections.pantryContextStatus}

Current Grocery List tab:
${sections.groceryItems}

Applied Grocery List state:
${sections.appliedGrocery}

Relevant cookbook entries:
${sections.cookbookEntries}

Applied cookbook context:
${sections.appliedCookbook}

Grocery / Pantry overlap notes:
${sections.groceryPantryOverlap}

Household capabilities:
${sections.capabilities}

Current app structure:
${sections.appMap}

Local time context for this turn:
${sections.localTimeContext}

Pending action context for this turn:
${sections.pendingAction}

Current chat working context:
${sections.workingContext}

Applied working context:
${sections.appliedWorkingContext}

Resolved entities for this turn:
${sections.resolvedEntities}`;
}

// ── Local time ───────────────────────────────────────────────────────────────────────────────
// The client has always POSTed a timeContext with every turn; the server has always thrown it away,
// so the brain could not tell a Tuesday 6pm "what's for dinner" from a Sunday 10am one.
//
// SECURITY: this is browser-controlled JSON that ends up inside a model prompt, which makes it an
// injection surface. So it is WHITELISTED, not sanitised — anything not recognised is dropped, and
// if the two fields that matter cannot both be recovered we render nothing at all. Same defensive
// posture as parseChatAttachment in kitchenbot.mjs.
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function normalizeClientTimeContext(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const dayRaw = typeof raw.localDayName === 'string' ? raw.localDayName.trim().toLowerCase() : '';
  const dayIndex = DAY_NAMES.indexOf(dayRaw);
  if (dayIndex === -1) return null; // not one of the seven: drop the whole thing

  const hour = Number(raw.localHour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;

  const timeZone =
    typeof raw.timeZone === 'string' && /^[A-Za-z0-9_+\-/]{1,64}$/.test(raw.timeZone) ? raw.timeZone : '';
  const localDateTime =
    typeof raw.localDateTime === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2}|Z)?$/.test(raw.localDateTime)
      ? raw.localDateTime
      : '';

  // Rebuilt from the whitelist, never passed through: nothing the browser sent survives verbatim.
  return {
    localDayName: DAY_NAMES[dayIndex].replace(/^./, (c) => c.toUpperCase()),
    localHour: hour,
    timeZone,
    localDateTime,
  };
}

/**
 * One short line for the cached system block: day plus a ROUNDED hour.
 *
 * Rounded on purpose. A precise per-turn timestamp would have to live in the message rather than
 * the cached system prompt, which breaks cross-turn cache reuse and costs roughly $0.01 a turn —
 * about a fifth of this household's weekly budget, for a nicety. An hour-granular line changes at
 * most hourly, and with the 5-minute cache TTL it forks the cache essentially never.
 */
export function formatLocalTimeContextLine(tc) {
  if (!tc) return '';
  const hour = tc.localHour;
  const suffix = hour < 12 ? 'am' : 'pm';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `Local time for this household: ${tc.localDayName}, about ${twelve}${suffix}.`;
}
