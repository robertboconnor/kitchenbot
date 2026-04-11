import {
  formatAppliedWorkingContextText,
  formatWorkingContextText,
  normalizeWorkingContext,
} from './kb-working-context.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

export function normalizeClientTimeContext(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const localDateTime = safeTrim(raw.localDateTime).slice(0, 80);
  const timeZone = safeTrim(raw.timeZone).slice(0, 80);
  const localDayName = safeTrim(raw.localDayName).slice(0, 24);
  const localHour = Number.isFinite(Number(raw.localHour)) ? Math.max(0, Math.min(23, Number(raw.localHour))) : null;
  if (!localDateTime && !timeZone && !localDayName && localHour == null) return null;
  return {
    localDateTime: localDateTime || null,
    timeZone: timeZone || null,
    localDayName: localDayName || null,
    localHour,
  };
}

export function formatClientTimeContext(timeContext) {
  const ctx = normalizeClientTimeContext(timeContext);
  if (!ctx) return '(none)';
  const lines = ['User local time context for this turn:'];
  if (ctx.localDateTime) lines.push(`- Local date/time: ${ctx.localDateTime}`);
  if (ctx.timeZone) lines.push(`- Time zone: ${ctx.timeZone}`);
  if (ctx.localDayName) lines.push(`- Local day: ${ctx.localDayName}`);
  if (ctx.localHour != null) lines.push(`- Local hour: ${ctx.localHour}`);
  lines.push('Use this only when timing, deadlines, or relative-time phrasing materially affects the answer.');
  return lines.join('\n');
}

export function formatAppMapContext() {
  return [
    'Current app structure:',
    '- Top-level areas: Chat, Kitchen, Settings',
    '- Kitchen contains: Grocery List, Pantry',
    '- Grocery List is where buy-now items live',
    '- Pantry is where on-hand pantry staples live',
  ].join('\n');
}

function promptLooksReferential(prompt) {
  const text = safeTrim(prompt).toLowerCase();
  if (!text) return false;
  return /\b(this|that|those|these|it|them)\b/.test(text) || /\bone of those\b/.test(text);
}

function formatPendingActionContext(pendingAction) {
  if (!pendingAction || typeof pendingAction !== 'object' || Array.isArray(pendingAction)) return '(none)';
  const type = safeTrim(pendingAction.type) || 'unknown';
  const capability = safeTrim(pendingAction.action?.capability) || '(none)';
  const parts = [
    `Pending action type: ${type}`,
    `Pending action capability: ${capability}`,
  ];
  if (safeTrim(pendingAction.question)) parts.push(`Open question: ${safeTrim(pendingAction.question)}`);
  if (safeTrim(pendingAction.contextSummary)) parts.push(`Context: ${safeTrim(pendingAction.contextSummary)}`);
  const unresolvedFields = (Array.isArray(pendingAction.unresolvedFields) ? pendingAction.unresolvedFields : [])
    .map((field) => safeTrim(field))
    .filter(Boolean);
  if (unresolvedFields.length > 0) parts.push(`Still unresolved: ${unresolvedFields.join(', ')}`);
  const candidateOptions = (Array.isArray(pendingAction.candidateOptions) ? pendingAction.candidateOptions : [])
    .map((option) => safeTrim(option?.label || option))
    .filter(Boolean);
  if (candidateOptions.length > 0) parts.push(`Candidate options: ${candidateOptions.join(', ')}`);
  const input = pendingAction.action?.input && typeof pendingAction.action.input === 'object' && !Array.isArray(pendingAction.action.input)
    ? pendingAction.action.input
    : null;
  if (input && Object.keys(input).length > 0) {
    parts.push(`Known action input: ${JSON.stringify(input)}`);
  }
  parts.push('Use this only to continue an already-selected action. Do not treat it as a new deterministic intent parser.');
  return parts.join('\n');
}

export function buildPromptContextProfile({ prompt = '', runtimeProposedNextAction = null, workingContext = null } = {}) {
  const text = safeTrim(prompt).toLowerCase();
  const hasWorkingContext = !!normalizeWorkingContext(workingContext);
  const includeWorkingContext =
    !!runtimeProposedNextAction ||
    (hasWorkingContext &&
      (promptLooksReferential(text) || /\b(for this|for that|swap|replace|change|revise|redo|make one|show me|add it)\b/.test(text)));

  const talksAboutGrocery = /\b(grocery|groceries|shopping|shopping list|grocery list|buy|need to buy)\b/.test(text);
  const asksAboutGroceryState =
    talksAboutGrocery &&
    /\b(what'?s on|what is on|any|anything|do we have|already|current|right now|on our)\b/.test(text);
  const requestsGroceryGeneration =
    /\b(grocery|groceries|grocery list|shopping list)\b/.test(text) &&
    /\b(for|from|give me|make|build|show|ingredients|meal|meals|plan|recipe|recipes)\b/.test(text);
  const talksAboutPantry = /\b(pantry|on hand|already have|use what we have|what we have|staples?)\b/.test(text);
  const asksAboutPantryState = /\bwhat'?s in our pantry|what is in our pantry|what do we have in our pantry\b/.test(text);
  const asksAboutDefaults = /\b(portions?|servings?|weeknight|easy meals?|ambitious|normal meals?)\b/.test(text);

  const includeGrocery = talksAboutGrocery;
  const includePantry =
    asksAboutPantryState ||
    (!asksAboutGroceryState && (talksAboutPantry || requestsGroceryGeneration)) ||
    (talksAboutGrocery && /\b(pantry|on hand|already have|staple|staples)\b/.test(text));
  const includeDefaults = requestsGroceryGeneration || asksAboutDefaults;

  return {
    includeDefaults,
    includePantry,
    includeGrocery,
    includeWorkingContext,
  };
}

export function buildRuntimeKbContext({ baseContext, timeContext, workingContext, profile }) {
  const includeWorkingContext = !!profile?.includeWorkingContext;
  return {
    ...baseContext,
    appMapText: formatAppMapContext(),
    timeContext,
    timeContextText: formatClientTimeContext(timeContext),
    pendingActionText: formatPendingActionContext(profile?.pendingAction || null),
    workingContext: includeWorkingContext ? workingContext : null,
    workingContextText: includeWorkingContext ? formatWorkingContextText(workingContext) : '(none)',
    appliedWorkingContextText: includeWorkingContext ? formatAppliedWorkingContextText(workingContext) : '(none)',
  };
}

export function profileNeedsRefresh(currentProfile = {}, requiredProfile = {}) {
  return (
    (!!requiredProfile.includeDefaults && !currentProfile.includeDefaults) ||
    (!!requiredProfile.includePantry && !currentProfile.includePantry) ||
    (!!requiredProfile.includeGrocery && !currentProfile.includeGrocery) ||
    (!!requiredProfile.includeWorkingContext && !currentProfile.includeWorkingContext)
  );
}
