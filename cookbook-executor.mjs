import {
  deleteCookbookEntry,
  getCookbookEntryById,
  getCookbookEntryByNormalizedTitle,
  getCookbookEntryBySourceUrl,
  listCookbookEntries,
  saveCookbookEntry,
} from './db.mjs';
import { getMessages } from './db.mjs';
import { buildChoiceActionState, buildClarifyActionState } from './kb-next-action.mjs';
import {
  buildCookbookRecordForStorage,
  extractCookbookRecordFromFetchedPage,
  extractManualCookbookRecipePayload,
  extractFirstUrl,
  extractPreferredCookbookLabel,
  findCookbookMatches,
  looksLikeRecipeText,
  mergeCookbookRecord,
  parseCookbookRecipeText,
  shapeCookbookRecordForStorage,
} from './cookbook-store.mjs';
import {
  buildExplicitCookbookReplacement,
  reviseStructuredRecipe,
} from './recipe-executor.mjs';
import { extractRecipeFromPageContent, fetchRecipePage } from './recipe-url-ingestion.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

function extractExplicitCookbookUpdateName(request = '') {
  const text = safeTrim(request);
  if (!text) return '';
  const patterns = [
    /^(?:please\s+)?(?:update|replace|revise|edit)\s+(.+?)\s+(?:in|from)\s+(?:our|my|the)\s+cookbook\b/i,
    /^(?:please\s+)?(?:update|replace|revise|edit)\s+(.+?)\s+recipe\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return safeTrim(match[1]).replace(/^["']|["']$/g, '');
  }
  return '';
}

function buildCookbookListReply(entries = []) {
  const list = (Array.isArray(entries) ? entries : []).slice(0, 8);
  if (list.length === 0) return 'Your cookbook is empty right now.';
  return `You have ${list.length} saved ${list.length === 1 ? 'entry' : 'entries'} in your cookbook.`;
}

function buildCookbookDeleteClarify(matches, requestedName) {
  const choices = (Array.isArray(matches) ? matches : []).slice(0, 6).map((entry, index) => ({
    id: String(index + 1),
    label: entry.title,
  }));
  const question =
    requestedName && choices.length > 0
      ? `I found more than one cookbook entry that could match ${requestedName}: ${choices.map((choice) => choice.label).join(', ')}. Which one did you mean?`
      : 'I found more than one cookbook entry. Which one did you mean?';
  return {
    status: 'ambiguous',
    question,
    proposedNextAction: buildClarifyActionState({
      capability: 'cookbook.delete',
      input: {},
      question,
      unresolvedFields: ['name'],
      candidateOptions: choices,
      contextSummary: 'Continue the pending cookbook deletion once the user picks the saved recipe.',
      visibleReplySummary: question,
    }),
  };
}

function buildCookbookUpdateClarify(matches, requestedName) {
  const choices = (Array.isArray(matches) ? matches : []).slice(0, 6).map((entry, index) => ({
    id: String(index + 1),
    label: entry.title,
  }));
  const question =
    requestedName && choices.length > 0
      ? `I found more than one cookbook entry that could match ${requestedName}: ${choices.map((choice) => choice.label).join(', ')}. Which one should I update?`
      : 'I found more than one cookbook entry that could match that. Which one should I update?';
  return {
    status: 'ambiguous',
    question,
    proposedNextAction: buildClarifyActionState({
      capability: 'cookbook.update',
      input: {},
      question,
      unresolvedFields: ['name'],
      candidateOptions: choices,
      contextSummary: 'Continue the pending cookbook update once the user picks the saved recipe.',
      visibleReplySummary: question,
    }),
  };
}

function normalizeUpdatedCookbookInputRecord(raw, existing) {
  const existingRecord = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : null;
  const revisedRecord = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!existingRecord || !revisedRecord) return null;
  return buildExplicitCookbookReplacement(existingRecord, {
    ...revisedRecord,
    sourceTitle: existingRecord.sourceTitle,
    sourceUrl: existingRecord.sourceUrl,
    sourceKind: existingRecord.sourceKind,
    sourceChatId: existingRecord.sourceChatId,
    lastUsedAt: existingRecord.lastUsedAt,
  });
}

function sameCookbookStructuredBody(leftRaw, rightRaw) {
  const left = leftRaw && typeof leftRaw === 'object' && !Array.isArray(leftRaw) ? leftRaw : {};
  const right = rightRaw && typeof rightRaw === 'object' && !Array.isArray(rightRaw) ? rightRaw : {};
  return JSON.stringify({
    title: left.title,
    summary: left.summary,
    category: left.category || '',
    recipeType: left.recipeType,
    ingredients: left.ingredients,
    instructions: left.instructions,
    tags: left.tags,
    sourceTitle: left.sourceTitle || '',
    sourceUrl: left.sourceUrl || '',
    notes: left.notes,
  }) === JSON.stringify({
    title: right.title,
    summary: right.summary,
    category: right.category || '',
    recipeType: right.recipeType,
    ingredients: right.ingredients,
    instructions: right.instructions,
    tags: right.tags,
    sourceTitle: right.sourceTitle || '',
    sourceUrl: right.sourceUrl || '',
    notes: right.notes,
  });
}

function buildLinkedRecipeWorkingContext({
  preferredTitle = '',
  sourceUrl = '',
  sourceTitle = '',
  status = '',
  error = '',
  suggestedRecoveryAction = '',
  fetchBlocked = false,
  blockerKind = '',
  failureKind = '',
  httpStatus = 0,
  existingWorkingContext = null,
}) {
  return {
    ...(existingWorkingContext && typeof existingWorkingContext === 'object' && !Array.isArray(existingWorkingContext)
      ? existingWorkingContext
      : {}),
    topicSummary:
      safeTrim(preferredTitle) ||
      safeTrim(existingWorkingContext?.topicSummary) ||
      'Linked recipe save attempt',
    linkedRecipeTitle: safeTrim(preferredTitle),
    linkedRecipeUrl: safeTrim(sourceUrl),
    linkedRecipeSourceTitle: safeTrim(sourceTitle),
    linkedRecipeFetchStatus: safeTrim(status),
    linkedRecipeFailureReason: safeTrim(error),
    linkedRecipeSuggestedRecoveryAction: safeTrim(suggestedRecoveryAction),
    linkedRecipeFetchBlocked: !!fetchBlocked,
    linkedRecipeBlockerKind: safeTrim(blockerKind),
    linkedRecipeFailureKind: safeTrim(failureKind),
    linkedRecipeHttpStatus: Number(httpStatus) || 0,
  };
}

function buildLinkedRecipeRecoveryNextAction({ preferredTitle = '', sourceUrl = '', webSearchEnabled = false, blocked = false }) {
  const title = safeTrim(preferredTitle) || 'that recipe';
  const url = safeTrim(sourceUrl);
  if (!url) return null;
  const recoveryInput = {
    request: `save this linked recipe ${url}`,
    preferredTitle: title,
    sourceUrl: url,
    recoveryMode: 'linked_recipe_recovery',
  };
  if (blocked) {
    return buildClarifyActionState({
      capability: 'cookbook.save',
      input: {
        request: '',
        preferredTitle: title,
        sourceUrl: url,
        recoveryMode: 'manual_paste',
      },
      question: `That site blocked automated access. Paste the ingredients and directions for ${title}, and I'll save it manually.`,
      contextSummary: 'Continue the blocked linked recipe save once the user pastes the recipe text manually.',
      unresolvedFields: ['recipe_text'],
      visibleReplySummary: `That site blocked automated access, so paste the recipe text for ${title} and I'll save it manually.`,
    });
  }
  if (webSearchEnabled) {
    return buildChoiceActionState({
      capability: 'cookbook.save',
      input: recoveryInput,
      defaultChoiceId: 'retry_fetch',
      question: `I couldn't save ${title} from the link directly. I can retry the exact link fetch, or search for recipe details separately.`,
      visibleReplySummary: `I couldn't read enough recipe detail from the link to save ${title} directly. You can retry the exact link fetch, search for recipe details separately, or paste the recipe text and I'll save it manually.`,
      choices: [
        {
          id: 'retry_fetch',
          label: 'retry the exact linked recipe fetch',
          capability: 'cookbook.save',
          actionInput: recoveryInput,
        },
        {
          id: 'search_now',
          label: 'search for recipe details now',
          capability: 'web.search',
          actionInput: {
            query: url,
          },
        },
      ],
    });
  }
  return buildClarifyActionState({
    capability: 'cookbook.save',
    input: recoveryInput,
    question: `I couldn't read ${title} from the link, and live web access is disabled here. Paste the recipe ingredients and steps and I'll save it manually.`,
    contextSummary: 'Continue the failed linked recipe save once the user provides recipe text manually.',
    unresolvedFields: ['recipe_text'],
    visibleReplySummary: `I couldn't read enough recipe detail from the link to save ${title} directly. Paste the recipe text and I'll save it manually.`,
  });
}

function buildLinkedRecipeFailureReply({ preferredTitle = '', status = '', webSearchEnabled = false }) {
  const title = safeTrim(preferredTitle) || 'that linked recipe';
  if (status === 'disabled' || !webSearchEnabled) {
    return `I couldn't read enough recipe detail from that link to save ${title} directly because live web access is disabled for this household. Paste the recipe text here and I'll save it manually.`;
  }
  if (status === 'blocked') {
    return `That site blocked automated page access from our server, so I couldn't import ${title} directly. Paste the recipe text here and I'll turn it into a structured cookbook entry.`;
  }
  if (status === 'fetch_failed' || status === 'unavailable' || status === 'no_results') {
    return `I couldn't fetch enough page content from that link to save ${title} directly. You can retry the exact link fetch, search for recipe details separately, or paste the recipe text and I'll save it manually.`;
  }
  if (status === 'parse_failed') {
    return `I fetched the page for ${title}, but I couldn't isolate a usable recipe from the page structure. You can retry the exact link fetch, search for recipe details separately, or paste the recipe text and I'll save it manually.`;
  }
  if (status === 'extraction_failed') {
    return `I fetched the page for ${title}, but I couldn't reliably extract a full recipe from it. You can ask me to search for recipe details, retry the exact link fetch, or paste the recipe text and I'll save it manually.`;
  }
  return `I couldn't read enough recipe detail from that link to save ${title} directly. You can retry the exact link fetch, search for recipe details separately, or paste the recipe text and I'll save it manually.`;
}

function buildManualRecoveryClarify({ preferredTitle = '', sourceUrl = '' }) {
  const title = safeTrim(preferredTitle) || 'that recipe';
  return {
    status: 'invalid',
    error: `I still need a cleaner recipe paste before I can save ${title}. Include the ingredients and directions or instructions, and I'll save it under that title.`,
    proposedNextAction: buildClarifyActionState({
      capability: 'cookbook.save',
      input: {
        request: '',
        preferredTitle: safeTrim(preferredTitle),
        sourceUrl: safeTrim(sourceUrl),
        recoveryMode: 'manual_paste',
      },
      question: `Paste the ingredients and directions for ${title}, and I'll save it manually.`,
      contextSummary: 'Continue the pending cookbook save once the user pastes enough recipe text to parse.',
      unresolvedFields: ['recipe_text'],
      visibleReplySummary: `I need the recipe text for ${title} before I can save it manually.`,
    }),
  };
}

function buildManualCookbookClarify({ preferredTitle = '' }) {
  const title = safeTrim(preferredTitle) || 'that recipe';
  return {
    status: 'invalid',
    error: `I need the actual recipe text before I can save ${title}. Paste the ingredients and directions, and I'll store it cleanly.`,
    proposedNextAction: buildClarifyActionState({
      capability: 'cookbook.save',
      input: {
        request: '',
        preferredTitle: safeTrim(preferredTitle),
        recoveryMode: 'manual_paste',
      },
      question: `Paste the ingredients and directions for ${title}, and I'll save it.`,
      contextSummary: 'Continue the pending cookbook save once the user provides the actual recipe text.',
      unresolvedFields: ['recipe_text'],
      visibleReplySummary: `I need the recipe text for ${title} before I can save it.`,
    }),
  };
}

function buildRecoveryMetadata(runtimeAction = {}, workingContext = null) {
  const input = runtimeAction?.input && typeof runtimeAction.input === 'object' && !Array.isArray(runtimeAction.input)
    ? runtimeAction.input
    : {};
  return {
    preferredTitle: safeTrim(input.preferredTitle) || safeTrim(workingContext?.linkedRecipeTitle),
    sourceUrl: safeTrim(input.sourceUrl) || safeTrim(workingContext?.linkedRecipeUrl),
    sourceTitle: safeTrim(input.sourceTitle),
    recoveryMode: safeTrim(input.recoveryMode).toLowerCase(),
  };
}

function looksLikeReferentialCookbookTitle(title = '') {
  return /^(?:it|that|this|recipe|that recipe|this recipe)$/i.test(safeTrim(title));
}

function requestExplicitlyNamesCookbookTitle(request = '') {
  const text = safeTrim(request);
  if (!text) return false;
  return (
    /\bas\s+["“][^"”]+["”]/i.test(text) ||
    /\bas\s+'[^']+'/i.test(text) ||
    /\bas\s+.+?(?:\s+\b(?:in|into|to)\b\s+(?:our\s+)?(?:cookbook|recipes?)\b|\s*$)/i.test(text) ||
    /\b(?:call|name)\s+it\s+["“][^"”]+["”]/i.test(text) ||
    /\b(?:call|name)\s+it\s+'[^']+'/i.test(text)
  );
}

// ONE BRAIN (KITCHENBOT_BRAIN_CONTRACT.md — "Smart Brain, Dumb Executors"): turn the recipe the
// brain passed on the tool call into a storage candidate. The brain owns the recipe content (it
// just wrote it or the user gave it); this is a mechanical shape of a provided object, not a
// transcript re-read. Requires a real recipe — title + ingredients + steps — or it returns null
// so the save path asks the brain to provide one.
function buildCandidateFromBrainRecipe(recipe, { preferredTitle = '', sourceUrl = '', sourceTitle = '' } = {}) {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) return null;
  const toList = (value) => (Array.isArray(value) ? value.map((entry) => safeTrim(entry)).filter(Boolean) : []);
  const ingredients = toList(recipe.ingredients);
  const instructions = toList(recipe.instructions).length ? toList(recipe.instructions) : toList(recipe.steps);
  const title = safeTrim(preferredTitle) || safeTrim(recipe.title || recipe.name);
  if (!title || ingredients.length === 0 || instructions.length === 0) return null;
  return {
    title,
    // A non-empty summary is required to build the storage record; the cookbook_shape helper
    // then replaces it with a clean one. Fall back to the title if the brain sent no summary.
    summary: safeTrim(recipe.summary) || `${title}.`,
    ingredients,
    instructions,
    tags: toList(recipe.tags),
    notes: toList(recipe.notes),
    recipeType: safeTrim(recipe.recipeType) || 'saved_recipe',
    sourceTitle: safeTrim(recipe.sourceTitle || sourceTitle),
    sourceUrl: safeTrim(recipe.sourceUrl || sourceUrl),
    sourceKind: safeTrim(recipe.sourceKind) || 'kb_generated',
  };
}

export async function executeCookbookSave(runtimeAction, context) {
  const { req, chatId, prompt, anthropic, memoryContext = null, workingContext = null } = context;
  const requestedSave = safeTrim(runtimeAction?.input?.request || prompt);
  const explicitTargetRecipe =
    runtimeAction?.input?.targetRecipe && typeof runtimeAction.input.targetRecipe === 'object' && !Array.isArray(runtimeAction.input.targetRecipe)
      ? runtimeAction.input.targetRecipe
      : null;
  const recovery = buildRecoveryMetadata(runtimeAction, workingContext);
  const linkedUrl = recovery.sourceUrl || extractFirstUrl(requestedSave);
  const manualPayload = extractManualCookbookRecipePayload(requestedSave, { sourceUrl: linkedUrl });
  const explicitRequestedTitle = requestExplicitlyNamesCookbookTitle(requestedSave)
    ? manualPayload.requestedCookbookTitle
    : '';
  const preferredTitleRaw =
    recovery.preferredTitle ||
    explicitRequestedTitle ||
    (linkedUrl ? extractPreferredCookbookLabel(requestedSave, linkedUrl) : '');
  const preferredTitle = looksLikeReferentialCookbookTitle(preferredTitleRaw)
    ? safeTrim(explicitTargetRecipe?.title || explicitTargetRecipe?.label)
    : preferredTitleRaw;
  const webSearchEnabled =
    !!memoryContext?.capabilities?.webSearchEnabled ||
    !!context?.webSearchEnabled ||
    !!req?.kbCapabilities?.webSearchEnabled;
  let inferred = null;
  let fetchPerformed = false;
  let sourceKind = 'kb_action';

  // ONE BRAIN: the recipe the brain passed on the tool call is the primary path. No transcript
  // scan, no side-model reconstructing the recipe from chat.
  const brainRecipeCandidate = buildCandidateFromBrainRecipe(runtimeAction?.input?.recipe, {
    preferredTitle: explicitRequestedTitle || preferredTitle,
    sourceUrl: linkedUrl,
    sourceTitle: recovery.sourceTitle,
  });
  if (brainRecipeCandidate) {
    inferred = brainRecipeCandidate;
    sourceKind = safeTrim(brainRecipeCandidate.sourceKind) || 'kb_generated';
  } else if (explicitTargetRecipe?.recipeRecord && typeof explicitTargetRecipe.recipeRecord === 'object' && !Array.isArray(explicitTargetRecipe.recipeRecord)) {
    inferred = {
      ...explicitTargetRecipe.recipeRecord,
      title: safeTrim(explicitRequestedTitle) || safeTrim(explicitTargetRecipe.recipeRecord.title || explicitTargetRecipe.title || explicitTargetRecipe.label),
      sourceTitle: safeTrim(explicitTargetRecipe.recipeRecord.sourceTitle || recovery.sourceTitle),
      sourceUrl: safeTrim(explicitTargetRecipe.recipeRecord.sourceUrl || linkedUrl),
      sourceKind: safeTrim(explicitTargetRecipe.recipeRecord.sourceKind || 'kb_generated') || 'kb_action',
    };
    sourceKind = safeTrim(inferred.sourceKind || 'kb_action') || 'kb_action';
  } else if (safeTrim(explicitTargetRecipe?.recipeText)) {
    inferred = parseCookbookRecipeText(explicitTargetRecipe.recipeText, {
      preferredTitle: safeTrim(explicitRequestedTitle || explicitTargetRecipe.title || explicitTargetRecipe.label || preferredTitle),
      sourceUrl: linkedUrl,
      sourceTitle: recovery.sourceTitle,
    });
    if (inferred) sourceKind = safeTrim(explicitTargetRecipe?.sourceKind || inferred.sourceKind || 'kb_generated') || 'kb_action';
  } else if (recovery.recoveryMode === 'manual_paste') {
    inferred = parseCookbookRecipeText(manualPayload.recipeBodyText || requestedSave, {
      preferredTitle,
      sourceUrl: linkedUrl,
      sourceTitle: recovery.sourceTitle,
    });
    if (!inferred) {
      return {
        capability: 'cookbook.save',
        urlBacked: !!linkedUrl,
        sourceUrl: linkedUrl,
        sourceTitle: recovery.sourceTitle,
        fetchPerformed: false,
        fetchedExactUrl: false,
        fetchSucceeded: false,
        extractionSucceeded: false,
        sourceKind: 'manual',
        failureReason: 'The pasted text did not contain enough recipe structure to parse ingredients and instructions.',
        workingContext,
        ...buildManualRecoveryClarify({ preferredTitle, sourceUrl: linkedUrl }),
      };
    }
    sourceKind = 'manual';
  } else if (linkedUrl) {
    const fetched = await fetchRecipePage({
      url: linkedUrl,
      deps: context.deps || {},
    });
    if (fetched.status !== 'fetched' || !safeTrim(fetched.text || fetched.html)) {
      const failureReason =
        safeTrim(fetched.failureReason || fetched.error) ||
        'I could not read enough recipe detail from that link to save it properly.';
      const failedStatus =
        fetched.status === 'disabled'
          ? 'unavailable'
          : fetched.fetchBlocked || fetched.failureKind === 'blocked'
            ? 'blocked'
            : fetched.status === 'fetched'
              ? 'fetch_failed'
              : fetched.status;
      const proposedNextAction = buildLinkedRecipeRecoveryNextAction({
        preferredTitle,
        sourceUrl: linkedUrl,
        webSearchEnabled,
        blocked: failedStatus === 'blocked',
      });
      return {
        capability: 'cookbook.save',
        status: failedStatus,
        error: buildLinkedRecipeFailureReply({
          preferredTitle,
          status: failedStatus,
          webSearchEnabled,
        }),
        urlBacked: true,
        sourceUrl: linkedUrl,
        sourceTitle: safeTrim(fetched.pageTitle),
        fetchPerformed: !!fetched.fetchPerformed,
        fetchedExactUrl: !!fetched.fetchedExactUrl,
        fetchSucceeded: !!fetched.fetchSucceeded,
        fetchBlocked: !!fetched.fetchBlocked,
        blockerKind: safeTrim(fetched.blockerKind),
        failureKind: safeTrim(fetched.failureKind || (failedStatus === 'blocked' ? 'blocked' : 'fetch_failed')),
        extractionSucceeded: false,
        sourceKind: 'server_fetch',
        failureReason,
        suggestedRecoveryAction:
          proposedNextAction?.type === 'choice'
            ? String(proposedNextAction.defaultChoiceId || '')
            : 'manual_paste',
        proposedNextAction,
        workingContext: buildLinkedRecipeWorkingContext({
          preferredTitle,
          sourceUrl: linkedUrl,
          sourceTitle: safeTrim(fetched.pageTitle),
          status: failedStatus,
          error: failureReason,
          suggestedRecoveryAction:
            proposedNextAction?.type === 'choice'
              ? String(proposedNextAction.defaultChoiceId || '')
              : 'manual_paste',
          fetchBlocked: !!fetched.fetchBlocked,
          blockerKind: safeTrim(fetched.blockerKind),
          failureKind: safeTrim(fetched.failureKind || (failedStatus === 'blocked' ? 'blocked' : 'fetch_failed')),
          httpStatus: Number(fetched.httpStatus) || 0,
          existingWorkingContext: workingContext,
        }),
      };
    }
    const extractedFromPage = extractRecipeFromPageContent({
      sourceUrl: safeTrim(fetched.finalUrl || linkedUrl),
      html: safeTrim(fetched.html),
      text: safeTrim(fetched.text),
    });
    if (extractedFromPage.status === 'extracted' && extractedFromPage.recipe) {
      inferred = buildCookbookRecordForStorage({
        ...extractedFromPage.recipe,
        title: safeTrim(preferredTitle) || safeTrim(extractedFromPage.recipe.title),
        sourceTitle: safeTrim(extractedFromPage.recipe.sourceTitle || fetched.pageTitle),
        sourceUrl: safeTrim(extractedFromPage.recipe.sourceUrl || fetched.finalUrl || linkedUrl),
        sourceKind: 'server_fetch',
      });
      fetchPerformed = true;
      sourceKind = 'server_fetch';
    } else {
      const shouldTryNormalization = extractedFromPage.status === 'needs_normalization' && safeTrim(extractedFromPage.recipeText);
      const extracted = shouldTryNormalization
        ? await extractCookbookRecordFromFetchedPage({
            anthropic,
            householdId: req.householdId,
            chatId,
            prompt: requestedSave,
            preferredTitle,
            sourceUrl: safeTrim(fetched.finalUrl || linkedUrl),
            sourceTitle: safeTrim(fetched.pageTitle),
            fetchedPageText: safeTrim(extractedFromPage.recipeText),
            memoryContext,
          })
        : { status: extractedFromPage.status === 'not_recipe' ? 'parse_failed' : 'parse_failed', failureReason: 'I fetched the page, but I could not isolate a usable recipe from its page structure.', record: null };
      if (extracted.status !== 'extracted' || !extracted.record) {
      const failureReason =
        safeTrim(extracted.failureReason) ||
        'I fetched the page, but I could not reliably extract a full recipe from it.';
      const proposedNextAction = buildLinkedRecipeRecoveryNextAction({
        preferredTitle,
        sourceUrl: linkedUrl,
        webSearchEnabled,
        blocked: false,
      });
      return {
        capability: 'cookbook.save',
        status: extracted.status === 'parse_failed' ? 'parse_failed' : 'extraction_failed',
        error: buildLinkedRecipeFailureReply({
          preferredTitle,
          status: extracted.status === 'parse_failed' ? 'parse_failed' : 'extraction_failed',
          webSearchEnabled,
        }),
        urlBacked: true,
        sourceUrl: linkedUrl,
        sourceTitle: safeTrim(fetched.pageTitle),
        fetchPerformed: !!fetched.fetchPerformed,
        fetchedExactUrl: !!fetched.fetchedExactUrl,
        fetchSucceeded: !!fetched.fetchSucceeded,
        fetchBlocked: false,
        blockerKind: '',
        failureKind: safeTrim(extracted.status === 'parse_failed' ? 'parse_failed' : 'extraction_failed'),
        extractionSucceeded: false,
        sourceKind: 'server_fetch',
        failureReason,
        suggestedRecoveryAction:
          proposedNextAction?.type === 'choice'
            ? String(proposedNextAction.defaultChoiceId || '')
            : 'manual_paste',
        proposedNextAction,
        workingContext: buildLinkedRecipeWorkingContext({
          preferredTitle,
          sourceUrl: linkedUrl,
          sourceTitle: safeTrim(fetched.pageTitle),
          status: extracted.status === 'parse_failed' ? 'parse_failed' : 'extraction_failed',
          error: failureReason,
          suggestedRecoveryAction:
            proposedNextAction?.type === 'choice'
              ? String(proposedNextAction.defaultChoiceId || '')
              : 'manual_paste',
          failureKind: safeTrim(extracted.status === 'parse_failed' ? 'parse_failed' : 'extraction_failed'),
          existingWorkingContext: workingContext,
        }),
      };
      }
      inferred = extracted.record;
      fetchPerformed = true;
      sourceKind = 'server_fetch';
    }
  } else {
    // ONE BRAIN: no explicit recipe, no paste-mode, no URL. Try to parse a recipe the user typed
    // inline (a mechanical parse of provided text). If there is not one, we do NOT scan the
    // transcript or synthesize a recipe from vague chat — the brain has the recipe (it just wrote
    // it or the user gave it) and must pass it in `recipe`.
    const parsedManualRecipe = parseCookbookRecipeText(manualPayload.recipeBodyText || requestedSave, {
      preferredTitle,
      sourceUrl: linkedUrl,
      sourceTitle: recovery.sourceTitle,
    });
    if (parsedManualRecipe) {
      inferred = parsedManualRecipe;
      sourceKind = 'manual';
    } else {
      return {
        capability: 'cookbook.save',
        status: 'invalid',
        urlBacked: false,
        sourceUrl: '',
        sourceTitle: '',
        fetchPerformed: false,
        extractionSucceeded: false,
        sourceKind: 'manual',
        error:
          'To save a recipe to the cookbook I need its ingredients and steps. Share the recipe (or a link) and I can save it.',
        note:
          'No recipe was provided. Pass the recipe you want saved as input.recipe {title, ingredients[], instructions[]} — ' +
          'the recipe you just wrote or the user gave you. Do not reconstruct it from the chat.',
        workingContext,
        ...buildManualCookbookClarify({ preferredTitle }),
      };
    }
  }
  const record = await shapeCookbookRecordForStorage({
    anthropic,
    householdId: req.householdId,
    chatId,
    prompt: requestedSave,
    candidateRecord: inferred,
    memoryContext,
    sourceKind: sourceKind || inferred?.sourceKind || 'kb_action',
    preserveTitle: !!preferredTitle,
  });
  if (!record) {
    if (!linkedUrl) {
      return {
        capability: 'cookbook.save',
        status: 'invalid',
        error: 'I need the actual recipe ingredients and directions before I can save that to the cookbook.',
      };
    }
    return {
      capability: 'cookbook.save',
      status: 'invalid',
      error: 'I still could not extract a clean recipe with ingredients and directions from that.',
    };
  }

  const existing = record.sourceUrl
    ? await getCookbookEntryBySourceUrl(req.householdId, record.sourceUrl) ||
      await getCookbookEntryByNormalizedTitle(req.householdId, record.normalizedTitle)
    : await getCookbookEntryByNormalizedTitle(req.householdId, record.normalizedTitle);
  if (!existing) {
    const id = await saveCookbookEntry(req.householdId, record, {
      sourceKind: sourceKind || record.sourceKind || 'kb_action',
      sourceChatId: chatId,
    });
    return {
      capability: 'cookbook.save',
      status: 'saved',
      contentQuality: sourceKind === 'server_fetch' || sourceKind === 'web_fetch' ? 'fetched_recipe' : sourceKind === 'manual' ? 'manual_recipe' : 'saved_recipe',
      preferredTitle: preferredTitle || record.title,
      urlBacked: !!linkedUrl,
      id,
      title: record.title,
      recipeType: record.recipeType,
      sourceUrl: record.sourceUrl,
      sourceTitle: record.sourceTitle,
      fetchPerformed,
      fetchedExactUrl: !!record.sourceUrl && record.sourceUrl === linkedUrl,
      fetchSucceeded: fetchPerformed,
      extractionSucceeded: fetchPerformed,
      sourceKind: sourceKind || record.sourceKind || 'kb_action',
      workingContext: fetchPerformed
        ? buildLinkedRecipeWorkingContext({
            preferredTitle: record.title,
            sourceUrl: record.sourceUrl,
            status: 'fetched',
            error: '',
            suggestedRecoveryAction: '',
            existingWorkingContext: workingContext,
          })
        : workingContext,
    };
  }

  const merged = mergeCookbookRecord(existing, record);
  const unchanged =
    JSON.stringify({
      title: existing.title,
      summary: existing.summary,
      category: existing.category || '',
      recipeType: existing.recipeType,
      ingredients: existing.ingredients,
      instructions: existing.instructions,
      tags: existing.tags,
      sourceTitle: existing.sourceTitle,
      sourceUrl: existing.sourceUrl,
      notes: existing.notes,
    }) ===
    JSON.stringify({
      title: merged.title,
      summary: merged.summary,
      category: merged.category || '',
      recipeType: merged.recipeType,
      ingredients: merged.ingredients,
      instructions: merged.instructions,
      tags: merged.tags,
      sourceTitle: merged.sourceTitle,
      sourceUrl: merged.sourceUrl,
      notes: merged.notes,
    });

  if (unchanged) {
    return {
      capability: 'cookbook.save',
      status: 'unchanged',
      contentQuality: sourceKind === 'server_fetch' || sourceKind === 'web_fetch' ? 'fetched_recipe' : sourceKind === 'manual' ? 'manual_recipe' : 'saved_recipe',
      preferredTitle: preferredTitle || existing.title,
      urlBacked: !!linkedUrl,
      id: existing.id,
      title: existing.title,
      recipeType: existing.recipeType,
      sourceUrl: existing.sourceUrl,
      sourceTitle: existing.sourceTitle,
      fetchPerformed,
      fetchedExactUrl: !!existing.sourceUrl && existing.sourceUrl === linkedUrl,
      fetchSucceeded: fetchPerformed,
      extractionSucceeded: fetchPerformed,
      sourceKind: existing.sourceKind || sourceKind || 'kb_action',
      workingContext: fetchPerformed
        ? buildLinkedRecipeWorkingContext({
            preferredTitle: existing.title,
            sourceUrl: existing.sourceUrl,
            status: 'fetched',
            error: '',
            suggestedRecoveryAction: '',
            existingWorkingContext: workingContext,
          })
        : workingContext,
    };
  }

  await saveCookbookEntry(req.householdId, merged, {
    id: existing.id,
    sourceKind: sourceKind || merged.sourceKind || 'kb_action',
    sourceChatId: chatId,
    lastUsedAt: existing.lastUsedAt,
  });
  return {
    capability: 'cookbook.save',
      status: 'updated',
    contentQuality: sourceKind === 'server_fetch' || sourceKind === 'web_fetch' ? 'fetched_recipe' : sourceKind === 'manual' ? 'manual_recipe' : 'saved_recipe',
    preferredTitle: preferredTitle || merged.title,
    urlBacked: !!linkedUrl,
    id: existing.id,
    title: merged.title,
    recipeType: merged.recipeType,
    sourceUrl: merged.sourceUrl,
    sourceTitle: merged.sourceTitle,
    fetchPerformed,
    fetchedExactUrl: !!merged.sourceUrl && merged.sourceUrl === linkedUrl,
    fetchSucceeded: fetchPerformed,
    extractionSucceeded: fetchPerformed,
    sourceKind: sourceKind || merged.sourceKind || 'kb_action',
    workingContext: fetchPerformed
      ? buildLinkedRecipeWorkingContext({
          preferredTitle: merged.title,
          sourceUrl: merged.sourceUrl,
          status: 'fetched',
          error: '',
          suggestedRecoveryAction: '',
          existingWorkingContext: workingContext,
        })
      : workingContext,
  };
}

export async function executeCookbookList(runtimeAction, context) {
  const { req } = context;
  const entries = await listCookbookEntries(req.householdId);
  return {
    capability: 'cookbook.list',
    status: 'listed',
    count: entries.length,
    entries: entries.slice(0, 12).map((entry) => ({
      id: entry.id,
      title: entry.title,
      summary: entry.summary,
      category: entry.category || '',
      recipeType: entry.recipeType,
      tags: entry.tags,
      sourceTitle: entry.sourceTitle,
      sourceUrl: entry.sourceUrl,
    })),
    reply: buildCookbookListReply(entries),
  };
}

export async function executeCookbookDelete(runtimeAction, context) {
  const { req } = context;
  const requestedName = safeTrim(runtimeAction?.input?.name || runtimeAction?.input?.title);
  if (!requestedName) {
    return {
      capability: 'cookbook.delete',
      status: 'invalid',
      error: 'I need the saved recipe title before I can delete it.',
    };
  }
  const entries = await listCookbookEntries(req.householdId);
  const matches = findCookbookMatches(entries, requestedName);
  if (matches.length === 0) {
    return {
      capability: 'cookbook.delete',
      status: 'missing',
      requestedName,
    };
  }
  if (matches.length > 1) {
    return {
      capability: 'cookbook.delete',
      requestedName,
      ...buildCookbookDeleteClarify(matches, requestedName),
    };
  }
  const match = matches[0];
  await deleteCookbookEntry(req.householdId, match.id);
  return {
    capability: 'cookbook.delete',
    status: 'deleted',
    id: match.id,
    deletedTitle: match.title,
  };
}

export async function executeCookbookUpdate(runtimeAction, context) {
  const { req, chatId, prompt, anthropic, memoryContext = null } = context;
  const input = runtimeAction?.input && typeof runtimeAction.input === 'object' && !Array.isArray(runtimeAction.input)
    ? runtimeAction.input
    : {};
  const revisionRequest = safeTrim(input.request || input.payload || input.text || prompt);
  const requestedName = safeTrim(input.name || input.title || input.recipe) || extractExplicitCookbookUpdateName(revisionRequest);
  let existing = null;

  if (Number.isFinite(Number(input.id))) {
    existing = await getCookbookEntryById(req.householdId, Number(input.id));
  } else if (input.targetCookbookEntry && typeof input.targetCookbookEntry === 'object' && !Array.isArray(input.targetCookbookEntry)) {
    const target = input.targetCookbookEntry;
    if (Number.isFinite(Number(target.id))) {
      existing = await getCookbookEntryById(req.householdId, Number(target.id));
    }
  } else if (requestedName) {
    const entries = await listCookbookEntries(req.householdId);
    const matches = findCookbookMatches(entries, requestedName);
    if (matches.length === 1) {
      existing = matches[0];
    } else if (matches.length > 1) {
      return {
        capability: 'cookbook.update',
        requestedName,
        ...buildCookbookUpdateClarify(matches, requestedName),
      };
    } else if (entries.length === 1) {
      // The name (often a referential phrase like "that saved recipe") didn't match, but
      // there is exactly one saved recipe — that is unambiguously the target.
      existing = entries[0];
    } else {
      return {
        capability: 'cookbook.update',
        status: 'missing',
        requestedName,
      };
    }
  } else {
    const selected = Array.isArray(memoryContext?.selectedCookbookEntries) ? memoryContext.selectedCookbookEntries.filter(Boolean) : [];
    if (selected.length === 1) {
      existing = selected[0];
    } else {
      const entries = await listCookbookEntries(req.householdId);
      if (entries.length === 1) existing = entries[0];
    }
  }

  if (!existing) {
    return {
      capability: 'cookbook.update',
      status: 'invalid',
      error: 'I need to know which saved cookbook recipe you want me to update.',
    };
  }

  let replacementRecord = normalizeUpdatedCookbookInputRecord(input.revisedRecord, existing);

  if (!replacementRecord && input.targetRecipe && typeof input.targetRecipe === 'object' && !Array.isArray(input.targetRecipe)) {
    const explicitTargetRecipe = input.targetRecipe;
    const explicitRecipeRecord =
      explicitTargetRecipe.recipeRecord && typeof explicitTargetRecipe.recipeRecord === 'object' && !Array.isArray(explicitTargetRecipe.recipeRecord)
        ? explicitTargetRecipe.recipeRecord
        : safeTrim(explicitTargetRecipe.recipeText)
          ? parseCookbookRecipeText(explicitTargetRecipe.recipeText, {
              preferredTitle: existing.title,
              sourceUrl: existing.sourceUrl,
              sourceTitle: existing.sourceTitle,
            })
          : null;
    if (explicitRecipeRecord) {
      replacementRecord = normalizeUpdatedCookbookInputRecord(explicitRecipeRecord, existing);
    }
  }

  if (!replacementRecord && looksLikeRecipeText(revisionRequest)) {
    const parsed = parseCookbookRecipeText(revisionRequest, {
      preferredTitle: existing.title,
      sourceUrl: existing.sourceUrl,
      sourceTitle: existing.sourceTitle,
    });
    replacementRecord = normalizeUpdatedCookbookInputRecord(parsed, existing);
  }

  if (!replacementRecord && revisionRequest) {
    const revised = await reviseStructuredRecipe({
      anthropic,
      householdId: req.householdId,
      chatId,
      request: revisionRequest,
      recipeRecord: existing,
      recentConversation: await getMessages(chatId, req.householdId).then((messages) => messages.slice(-16)),
      latestAssistantText: '',
      memoryContext,
    });
    replacementRecord = normalizeUpdatedCookbookInputRecord(revised, existing);
  }

  if (!replacementRecord) {
    return {
      capability: 'cookbook.update',
      status: 'invalid',
      error: 'I could not build a clean updated cookbook recipe from that request yet.',
    };
  }

  if (sameCookbookStructuredBody(existing, replacementRecord)) {
    return {
      capability: 'cookbook.update',
      status: 'unchanged',
      id: existing.id,
      title: existing.title,
      sourceTitle: existing.sourceTitle,
      sourceUrl: existing.sourceUrl,
    };
  }

  await saveCookbookEntry(req.householdId, replacementRecord, {
    id: existing.id,
    sourceKind: existing.sourceKind,
    sourceChatId: existing.sourceChatId,
    lastUsedAt: existing.lastUsedAt,
  });
  return {
    capability: 'cookbook.update',
    status: 'updated',
    id: existing.id,
    title: replacementRecord.title,
    sourceTitle: existing.sourceTitle,
    sourceUrl: existing.sourceUrl,
  };
}

export function normalizeCookbookDeleteInput(input, context = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const name = safeTrim(raw.name || raw.title || raw.recipe || raw.payload || raw.text || context.originalPrompt);
  return name ? { name } : null;
}

export function normalizeCookbookSaveInput(input, context = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const request = safeTrim(raw.request || raw.payload || raw.text || context.originalPrompt);
  return {
    request,
    preferredTitle: safeTrim(raw.preferredTitle),
    sourceUrl: safeTrim(raw.sourceUrl),
    sourceTitle: safeTrim(raw.sourceTitle),
    recoveryMode: safeTrim(raw.recoveryMode),
    // ONE BRAIN: the brain passes the recipe it wants saved (it wrote or received it). We keep
    // that structured payload verbatim; the executor never re-reads the chat to reconstruct it.
    ...(raw.recipe && typeof raw.recipe === 'object' && !Array.isArray(raw.recipe)
      ? { recipe: raw.recipe }
      : {}),
    ...(raw.targetRecipe && typeof raw.targetRecipe === 'object' && !Array.isArray(raw.targetRecipe)
      ? { targetRecipe: raw.targetRecipe }
      : {}),
  };
}

export function normalizeCookbookUpdateInput(input, context = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const revisedRecord =
    raw.revisedRecord && typeof raw.revisedRecord === 'object' && !Array.isArray(raw.revisedRecord)
      ? raw.revisedRecord
      : null;
  const request = safeTrim(raw.request || raw.payload || raw.text || context.originalPrompt);
  const explicitName = safeTrim(raw.name || raw.title || raw.recipe) || extractExplicitCookbookUpdateName(request);
  const normalized = {
    ...(Number.isFinite(Number(raw.id)) ? { id: Number(raw.id) } : {}),
    ...(explicitName ? { name: explicitName } : {}),
    ...(request ? { request } : {}),
    ...(revisedRecord ? { revisedRecord } : {}),
    ...(raw.targetRecipe && typeof raw.targetRecipe === 'object' && !Array.isArray(raw.targetRecipe)
      ? { targetRecipe: raw.targetRecipe }
      : {}),
    ...(raw.targetCookbookEntry && typeof raw.targetCookbookEntry === 'object' && !Array.isArray(raw.targetCookbookEntry)
      ? { targetCookbookEntry: raw.targetCookbookEntry }
      : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : null;
}

export function interpretCookbookSaveFollowUp(prompt, nextAction, context = {}) {
  const text = safeTrim(prompt);
  const action = nextAction?.action;
  if (!text || !action || String(action.capability || '').trim() !== 'cookbook.save') return null;
  const actionInput = action.input && typeof action.input === 'object' && !Array.isArray(action.input) ? action.input : {};
  const loweredText = text.toLowerCase();
  const candidateOptions = Array.isArray(nextAction?.candidateOptions) ? nextAction.candidateOptions : [];
  const matchingCandidate = candidateOptions.find((option) => {
    const label = safeTrim(option?.label);
    return label && label.toLowerCase() === loweredText;
  });
  const recipeDisambiguationPending =
    nextAction?.type === 'clarify_action' &&
    (Array.isArray(nextAction?.unresolvedFields) ? nextAction.unresolvedFields : []).some((field) =>
      ['name', 'title', 'recipe'].includes(safeTrim(field).toLowerCase())
    );
  if (recipeDisambiguationPending) {
    return {
      kind: 'execute_action',
      actions: [{
        capability: 'cookbook.save',
        input: {
          ...actionInput,
          request: safeTrim(actionInput.request) || text,
          preferredTitle: safeTrim(matchingCandidate?.label || text),
        },
      }],
      routePrompt: prompt,
    };
  }

  const sourceUrl = safeTrim(actionInput.sourceUrl || context.workingContext?.linkedRecipeUrl);
  if (!sourceUrl) return null;

  if (looksLikeRecipeText(text)) {
    return {
      kind: 'execute_action',
      actions: [{
        capability: 'cookbook.save',
        input: {
          request: text,
          preferredTitle: safeTrim(actionInput.preferredTitle || context.workingContext?.linkedRecipeTitle),
          sourceUrl,
          sourceTitle: safeTrim(actionInput.sourceTitle),
          recoveryMode: 'manual_paste',
        },
      }],
      routePrompt: prompt,
    };
  }

  if (nextAction?.type === 'clarify_action' || safeTrim(actionInput.recoveryMode).toLowerCase() === 'manual_paste') {
    return {
      kind: 'clarify',
      routePrompt: prompt,
      question:
        safeTrim(nextAction?.question) ||
        `Paste the ingredients and directions for ${safeTrim(actionInput.preferredTitle) || 'that recipe'}, and I'll save it manually.`,
      proposedNextAction: nextAction,
    };
  }

  return null;
}

export function interpretCookbookUpdateFollowUp(prompt, nextAction) {
  const text = safeTrim(prompt);
  const action = nextAction?.action;
  if (!text || !action || String(action.capability || '').trim() !== 'cookbook.update') return null;
  const lowered = text.toLowerCase();
  const candidateOptions = Array.isArray(nextAction?.candidateOptions) ? nextAction.candidateOptions : [];
  const matchingCandidate = candidateOptions.find((option) => safeTrim(option?.label).toLowerCase() === lowered);
  const recipeDisambiguationPending =
    nextAction?.type === 'clarify_action' &&
    (Array.isArray(nextAction?.unresolvedFields) ? nextAction.unresolvedFields : []).some((field) =>
      ['name', 'title', 'recipe'].includes(safeTrim(field).toLowerCase())
    );
  if (recipeDisambiguationPending && matchingCandidate) {
    return {
      kind: 'execute_action',
      actions: [{
        capability: 'cookbook.update',
        input: {
          ...(action.input && typeof action.input === 'object' && !Array.isArray(action.input) ? action.input : {}),
          name: safeTrim(matchingCandidate.label),
        },
      }],
      routePrompt: prompt,
    };
  }
  if (/^(no|nope|cancel|stop|never mind|nevermind)$/i.test(text)) {
    return { kind: 'reply_only', routePrompt: prompt, replyText: 'Okay, I left the saved cookbook recipe alone.' };
  }
  if (
    /^(yes|yeah|yep|sure|ok|okay|do it|go ahead|replace it|replace that|update it|update that|save it|save that)$/i.test(text) ||
    /\b(replace|update|save)\b/.test(lowered)
  ) {
    return {
      kind: 'execute_action',
      actions: [{
        capability: 'cookbook.update',
        input: action.input && typeof action.input === 'object' && !Array.isArray(action.input) ? action.input : {},
      }],
      routePrompt: prompt,
    };
  }
  return null;
}
