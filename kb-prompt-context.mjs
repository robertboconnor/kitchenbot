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
