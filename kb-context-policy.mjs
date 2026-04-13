import {
  formatAppliedWorkingContextText,
  formatWorkingContextText,
  normalizeWorkingContext,
} from './kb-working-context.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

export function promptNeedsCookbookContext(prompt = '') {
  const text = safeTrim(prompt).toLowerCase();
  if (!text) return false;
  const talksAboutCookbook =
    /\b(cookbook|saved recipes?|saved meals?|favorites?|favourites?)\b/.test(text) ||
    (/\b(recipe|recipes)\b/.test(text) && /\b(save|saved|remember|bookmark|favorite|favourite|again|reuse|our)\b/.test(text));
  const asksAboutLinkedRecipeProvenance =
    /\b(url|link|linked recipe|linked page|website|web page)\b/.test(text) &&
    /\b(read|fetch|fetched|pulled|look(?:ed)?\s*(?:it)?\s*up|actually)\b/.test(text);
  return talksAboutCookbook || asksAboutLinkedRecipeProvenance;
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
    '- Kitchen contains: Grocery List, Pantry, Cookbook',
    '- Grocery List is where buy-now items live',
    '- Pantry is where on-hand pantry staples live',
    '- Cookbook is where reusable saved household recipes and meal ideas live',
  ].join('\n');
}

function promptLooksReferential(prompt) {
  const text = safeTrim(prompt).toLowerCase();
  if (!text) return false;
  return /\b(this|that|those|these|it|them)\b/.test(text) || /\bone of those\b/.test(text);
}

function promptLooksLikeRecipeBuild(prompt) {
  const text = safeTrim(prompt).toLowerCase();
  if (!text) return false;
  return (
    /\b(recipe|ingredients|instructions|directions)\b/.test(text) ||
    /\bhow (?:do i|to) make\b/.test(text) ||
    /\bshow me\b/.test(text)
  );
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

function formatCapabilitiesContext(capabilities) {
  const webSearchEnabled = !!capabilities?.webSearchEnabled;
  return [
    'Household capabilities:',
    `- Web search: ${webSearchEnabled ? 'enabled' : 'disabled'}`,
  ].join('\n');
}

export function buildPromptContextProfile({ prompt = '', runtimeProposedNextAction = null, workingContext = null } = {}) {
  const text = safeTrim(prompt).toLowerCase();
  const normalizedWorkingContext = normalizeWorkingContext(workingContext);
  const hasWorkingContext = !!normalizedWorkingContext;
  const hasMealContinuity =
    hasWorkingContext &&
    (
      (Array.isArray(normalizedWorkingContext.mealIdeas) && normalizedWorkingContext.mealIdeas.length > 0) ||
      (Array.isArray(normalizedWorkingContext.subjectItems) && normalizedWorkingContext.subjectItems.length > 0)
    );
  const includeWorkingContext =
    !!runtimeProposedNextAction ||
    (hasWorkingContext &&
      (
        promptLooksReferential(text) ||
        /\b(for this|for that|swap|replace|change|revise|redo|make one|show me|add it)\b/.test(text) ||
        (hasMealContinuity && promptLooksLikeRecipeBuild(text))
      ));

  const talksAboutGrocery = /\b(grocery|groceries|shopping|shopping list|grocery list|buy|need to buy)\b/.test(text);
  const asksAboutGroceryState =
    talksAboutGrocery &&
    /\b(what'?s on|what is on|any|anything|do we have|already|current|right now|on our)\b/.test(text);
  const requestsGroceryGeneration =
    /\b(grocery|groceries|grocery list|shopping list)\b/.test(text) &&
    /\b(for|from|give me|make|build|show|ingredients|meal|meals|plan|recipe|recipes)\b/.test(text);
  const requestsMealPlanning =
    /\b(meal plan|meal plans|plan meals|plan dinners|meals for|dinners for|weekly meals|weekly dinners|dinner ideas|meal ideas)\b/.test(text) ||
    (/\b(meal|meals|dinner|dinners)\b/.test(text) &&
      /\b(plan|planning|create|build|make|sketch|suggest|ideas|for this week|for the week|this week|tonight)\b/.test(text));
  const talksAboutPantry = /\b(pantry|on hand|already have|use what we have|what we have|staples?)\b/.test(text);
  const asksAboutPantryState = /\bwhat'?s in our pantry|what is in our pantry|what do we have in our pantry\b/.test(text);
  const asksAboutDefaults =
    /\b(default dinner portions?|default portions?|portions?|servings?|cooking style|weeknight|household defaults?|default settings|easy meals?|ambitious|normal meals?)\b/.test(text) ||
    /\bhow many people (do we|are we going to)? cook(?:ing)? for\b/.test(text);
  const talksAboutCookbook = promptNeedsCookbookContext(text);

  const includeGrocery = talksAboutGrocery;
  const includePantry =
    asksAboutPantryState ||
    (!asksAboutGroceryState && (talksAboutPantry || requestsGroceryGeneration)) ||
    (talksAboutGrocery && /\b(pantry|on hand|already have|staple|staples)\b/.test(text));
  const includeDefaults = requestsGroceryGeneration || requestsMealPlanning || asksAboutDefaults;
  const includeCookbook =
    talksAboutCookbook ||
    (requestsMealPlanning && /\b(cookbook|saved|favorite|favourite|recipe|recipes)\b/.test(text)) ||
    (requestsGroceryGeneration && /\b(cookbook|saved|favorite|favourite|recipe|recipes)\b/.test(text));

  return {
    includeDefaults,
    includePantry,
    includeGrocery,
    includeCookbook,
    includeWorkingContext,
  };
}

export function buildRuntimeKbContext({ baseContext, timeContext, workingContext, profile }) {
  const includeWorkingContext = !!profile?.includeWorkingContext;
  return {
    ...baseContext,
    capabilities: baseContext?.capabilities || {},
    capabilitiesText: formatCapabilitiesContext(baseContext?.capabilities || {}),
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
    (!!requiredProfile.includeCookbook && !currentProfile.includeCookbook) ||
    (!!requiredProfile.includeWorkingContext && !currentProfile.includeWorkingContext)
  );
}
