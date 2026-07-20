import { createLoggedAnthropicMessage } from './anthropic-usage.mjs';
import { resolveAnthropicModelForCallPurpose } from './anthropic-model-policy.mjs';
import { buildCookbookRecordForStorage } from './cookbook-store.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

function parseJsonObject(raw) {
  let text = safeTrim(raw);
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)```$/im);
  if (fenced) text = safeTrim(fenced[1]);
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeTitleKey(text) {
  return safeTrim(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactRecentConversation(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.role === 'user' || message?.role === 'assistant')
    .slice(-12)
    .map((message) => `${message.role === 'user' ? message.name || 'User' : message.name || 'KitchenBot'}: ${safeTrim(message.content)}`)
    .filter(Boolean)
    .join('\n\n');
}

function looksLikeRecipeSectionHeader(line = '') {
  const text = safeTrim(line);
  if (!text || !text.endsWith(':')) return false;
  return text.split(/\s+/).filter(Boolean).length <= 5;
}

function looksLikeConversationalRecipeLine(line = '') {
  const lowered = safeTrim(line).toLowerCase();
  if (!lowered) return false;
  return (
    /\b(want me to|would you like me to|do you want me to|if you want, i can|i can replace|i can save|grocery list|cookbook)\b/.test(
      lowered
    ) ||
    /\b(if she'?ll be eating this too|if he'?ll be eating this too|for rob|for elle|you love)\b/.test(lowered)
  );
}

function sanitizeRecipeReplyLine(line = '') {
  return safeTrim(line)
    .replace(/\*\*/g, '')
    .replace(/::+/g, ':')
    .replace(/\s+/g, ' ')
    .replace(/\s+:\s*$/, ':')
    .trim();
}

function normalizeSectionKey(text = '') {
  return normalizeTitleKey(text).replace(/\bfor\b/g, '').replace(/\s+/g, ' ').trim();
}

function cleanRecipeLineArray(lines = [], { allowSectionHeaders = false } = {}) {
  return (Array.isArray(lines) ? lines : [])
    .map(sanitizeRecipeReplyLine)
    .filter(Boolean)
    .filter((line) => !looksLikeConversationalRecipeLine(line))
    .filter((line) => allowSectionHeaders || !looksLikeRecipeSectionHeader(line) || /:\s+\S/.test(line));
}

function sanitizeRecipeReplyRecord(record) {
  const recipe = buildCookbookRecordForStorage(record);
  if (!recipe) return null;
  return {
    ...recipe,
    ingredients: cleanRecipeLineArray(recipe.ingredients, { allowSectionHeaders: true }),
    instructions: cleanRecipeLineArray(recipe.instructions),
    notes: appendMissingRecipeLines([], cleanRecipeLineArray(recipe.notes)),
  };
}

function formatRecipeForReply(record) {
  const recipe = sanitizeRecipeReplyRecord(record);
  if (!recipe) return '';
  const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
  const instructions = Array.isArray(recipe.instructions) ? recipe.instructions : [];
  const notes = Array.isArray(recipe.notes) ? recipe.notes : [];
  const parts = [recipe.title];
  if (ingredients.length > 0) {
    parts.push(
      '',
      'Ingredients',
      ...ingredients.map((item) => (looksLikeRecipeSectionHeader(item) ? item : `- ${item}`))
    );
  }
  if (instructions.length > 0) {
    parts.push('', 'Instructions', ...instructions.map((step, index) => `${index + 1}. ${step}`));
  }
  if (notes.length > 0) {
    parts.push('', 'Notes', ...notes.map((note) => `- ${note}`));
  }
  return parts.join('\n');
}

function sameRecipeBody(a, b) {
  const left = buildCookbookRecordForStorage(a);
  const right = buildCookbookRecordForStorage(b);
  if (!left || !right) return false;
  return JSON.stringify({
    title: left.title,
    summary: left.summary,
    category: left.category || '',
    ingredients: left.ingredients,
    instructions: left.instructions,
    tags: left.tags,
    notes: left.notes,
  }) === JSON.stringify({
    title: right.title,
    summary: right.summary,
    category: right.category || '',
    ingredients: right.ingredients,
    instructions: right.instructions,
    tags: right.tags,
    notes: right.notes,
  });
}

function normalizeLooseLineKey(text) {
  return safeTrim(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function significantLineTokens(text = '') {
  const stopwords = new Set([
    'and', 'for', 'with', 'from', 'into', 'plus', 'taste', 'optional', 'fresh', 'finely', 'thinly',
    'cup', 'cups', 'tbsp', 'tsp', 'teaspoon', 'teaspoons', 'tablespoon', 'tablespoons',
    'ounce', 'ounces', 'pound', 'pounds', 'lb', 'lbs',
  ]);
  return normalizeLooseLineKey(text)
    .split(' ')
    .filter((token) => token.length >= 4 && !stopwords.has(token) && !/^\d/.test(token));
}

function linesLooselyMatch(left = '', right = '') {
  const leftKey = normalizeLooseLineKey(left);
  const rightKey = normalizeLooseLineKey(right);
  if (!leftKey || !rightKey) return false;
  if (leftKey === rightKey) return true;
  const leftTokens = significantLineTokens(left);
  const rightTokens = significantLineTokens(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) return false;
  const shorter = leftTokens.length <= rightTokens.length ? leftTokens : rightTokens;
  const longer = shorter === leftTokens ? rightTokens : leftTokens;
  return shorter.every((token) => longer.includes(token));
}

function lineSatisfiesRequiredAddition(existing = '', required = '') {
  const existingTokens = significantLineTokens(existing);
  const requiredTokens = significantLineTokens(required);
  if (requiredTokens.length === 0) return normalizeLooseLineKey(existing) === normalizeLooseLineKey(required);
  return requiredTokens.every((token) => existingTokens.includes(token));
}

function appendMissingRecipeLines(existing = [], additions = []) {
  const current = Array.isArray(existing) ? existing.slice() : [];
  const seen = new Set(current.map((line) => normalizeLooseLineKey(line)).filter(Boolean));
  for (const line of Array.isArray(additions) ? additions : []) {
    const text = safeTrim(line);
    const key = normalizeLooseLineKey(text);
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    current.push(text);
  }
  return current;
}

function looksLikeExplicitAdditiveRequest(request = '') {
  const text = safeTrim(request).toLowerCase();
  if (!text) return false;
  if (/\b(swap|replace|remove|take out|without|instead of)\b/.test(text)) return false;
  return /\b(add|include|work|mix|stir|fold|sprinkle|finish|top|whisk|toss)\b/.test(text);
}

function isEndCue(text = '') {
  return /\b(at the end|end|before serving|before you serve|serve|serving|finish)\b/i.test(safeTrim(text));
}

function findSectionInsertionIndex(lines = [], sectionName = '') {
  const sectionKey = normalizeSectionKey(sectionName);
  if (!sectionKey) return null;
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = safeTrim(lines[index]);
    if (!looksLikeRecipeSectionHeader(line)) continue;
    const headerKey = normalizeSectionKey(line.replace(/:$/, ''));
    if (!headerKey) continue;
    if (headerKey === sectionKey || headerKey.includes(sectionKey) || sectionKey.includes(headerKey)) {
      matches.push(index);
    }
  }
  if (matches.length !== 1) return null;
  const headerIndex = matches[0];
  let insertIndex = lines.length;
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (looksLikeRecipeSectionHeader(lines[index])) {
      insertIndex = index;
      break;
    }
  }
  return insertIndex;
}

function findInstructionInsertionIndex(lines = [], cue = '') {
  const cueKey = normalizeSectionKey(cue);
  if (!cueKey) return null;
  if (isEndCue(cueKey)) return Array.isArray(lines) ? lines.length : 0;
  const matches = [];
  const cueTerms = cueKey.split(' ').filter((term) => term.length >= 4);
  for (let index = 0; index < lines.length; index += 1) {
    const lineKey = normalizeSectionKey(lines[index]);
    if (!lineKey) continue;
    let score = 0;
    if (lineKey === cueKey) score += 10;
    else if (lineKey.includes(cueKey)) score += 7;
    else if (cueKey.includes(lineKey)) score += 5;
    if (cueTerms.length > 0 && cueTerms.every((term) => lineKey.includes(term))) score += 3;
    if (/^(make|mix|whisk|stir|combine|finish)\b/.test(lineKey)) score += 2;
    if (score > 0) matches.push({ index, score });
  }
  if (matches.length === 0) return null;
  matches.sort((left, right) => right.score - left.score || left.index - right.index);
  if (matches.length > 1 && matches[0].score === matches[1].score) return null;
  return matches[0].index + 1;
}

function insertUniqueRecipeLinesAt(lines = [], additions = [], index = null) {
  const current = Array.isArray(lines) ? lines.slice() : [];
  const uniqueAdds = appendMissingRecipeLines([], additions);
  if (uniqueAdds.length === 0) return current;
  const seen = new Set(current.map((line) => normalizeLooseLineKey(line)).filter(Boolean));
  const filteredAdds = uniqueAdds.filter((line) => {
    const key = normalizeLooseLineKey(line);
    if (!key || seen.has(key) || current.some((existingLine) => linesLooselyMatch(existingLine, line))) return false;
    seen.add(key);
    return true;
  });
  if (filteredAdds.length === 0) return current;
  if (!Number.isInteger(index) || index < 0 || index > current.length) {
    current.push(...filteredAdds);
    return current;
  }
  current.splice(index, 0, ...filteredAdds);
  return current;
}

function applyNarrowAdditiveFallback(baseRecord, additiveFallback) {
  const base = buildCookbookRecordForStorage(baseRecord);
  const fallback = additiveFallback && typeof additiveFallback === 'object' && !Array.isArray(additiveFallback)
    ? additiveFallback
    : null;
  if (!base || !fallback) return null;

  const ingredientAdds = appendMissingRecipeLines([], fallback.ingredientAdds || []);
  const instructionAdds = appendMissingRecipeLines([], fallback.instructionAdds || []);
  if (ingredientAdds.length === 0 && instructionAdds.length === 0) return null;

  let nextIngredients = Array.isArray(base.ingredients) ? base.ingredients.slice() : [];
  let nextInstructions = Array.isArray(base.instructions) ? base.instructions.slice() : [];

  if (ingredientAdds.length > 0) {
    const hasSections = nextIngredients.some((line) => looksLikeRecipeSectionHeader(line));
    if (safeTrim(fallback.ingredientSection)) {
      const insertIndex = findSectionInsertionIndex(nextIngredients, fallback.ingredientSection);
      if (insertIndex == null) return null;
      nextIngredients = insertUniqueRecipeLinesAt(nextIngredients, ingredientAdds, insertIndex);
    } else if (!hasSections) {
      nextIngredients = insertUniqueRecipeLinesAt(nextIngredients, ingredientAdds, nextIngredients.length);
    } else {
      return null;
    }
  }

  if (instructionAdds.length > 0) {
    const cue = safeTrim(fallback.instructionCue);
    const insertIndex = cue ? findInstructionInsertionIndex(nextInstructions, cue) : null;
    if (insertIndex == null) return null;
    nextInstructions = insertUniqueRecipeLinesAt(nextInstructions, instructionAdds, insertIndex);
  }

  const revised = sanitizeRecipeReplyRecord({
    ...base,
    ingredients: nextIngredients,
    instructions: nextInstructions,
  });
  if (!revised || sameRecipeBody(base, revised)) return null;
  return revised;
}

function recipeReflectsAdditiveFallback(recipeRecord, additiveFallback) {
  const recipe = buildCookbookRecordForStorage(recipeRecord);
  const fallback = additiveFallback && typeof additiveFallback === 'object' && !Array.isArray(additiveFallback)
    ? additiveFallback
    : null;
  if (!recipe || !fallback) return true;
  const ingredientAdds = appendMissingRecipeLines([], fallback.ingredientAdds || []);
  const instructionAdds = appendMissingRecipeLines([], fallback.instructionAdds || []);
  const ingredientLines = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
  const instructionLines = Array.isArray(recipe.instructions) ? recipe.instructions : [];
  const ingredientsOkay = ingredientAdds.every((line) => ingredientLines.some((existingLine) => lineSatisfiesRequiredAddition(existingLine, line)));
  const instructionsOkay = instructionAdds.every((line) => instructionLines.some((existingLine) => lineSatisfiesRequiredAddition(existingLine, line)));
  return ingredientsOkay && instructionsOkay;
}

async function deriveRecipeAdditiveFallback({
  anthropic,
  householdId,
  chatId,
  revisionRequest,
  baseRecord,
  memoryContext = null,
}) {
  if (!anthropic || !revisionRequest || !baseRecord) return null;
  try {
    const response = await createLoggedAnthropicMessage(
      anthropic,
      {
        model: resolveAnthropicModelForCallPurpose('cookbook_shape'),
        max_tokens: 220,
        system: `You extract explicit additive recipe edits for KitchenBot when a full recipe rewrite failed to visibly apply a request.

        Return ONLY JSON:
{"ingredientAdds":["..."],"instructionAdds":["..."],"ingredientSection":"...","instructionCue":"..."}

Rules:
- Only return additions that are directly justified by the user's request.
- Use this only for additive edits like adding an ingredient, garnish, sauce component, or finishing step.
- If the request is not primarily additive, return empty arrays.
- ingredientAdds should be grocery-friendly ingredient lines.
- instructionAdds should be concrete step lines that can be appended to the recipe.
- ingredientSection should only be set when the recipe already has a matching section header.
- instructionCue should only be set when the recipe already has a matching step cue, or when the request explicitly says to add the change at the end / before serving.
- If the recipe does not already expose a clear insertion point, return empty arrays.
- If the user says the ingredient should appear in both ingredients and instructions, do both.`,
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              revisionRequest,
              existingRecipe: baseRecord,
              appliedMemory: safeTrim(memoryContext?.applicationText || ''),
              appliedDefaults: safeTrim(memoryContext?.appliedDefaultsText || ''),
            }),
          },
        ],
      },
      {
        householdId,
        chatId,
        runtimeEnabled: true,
        callSurface: 'kb_action',
        callPurpose: 'cookbook_shape',
        webSearchEnabledAtCall: !!memoryContext?.capabilities?.webSearchEnabled,
        usedWebSearchTool: false,
      }
    );
    const text = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
    const parsed = parseJsonObject(text);
    return {
      ingredientAdds: Array.isArray(parsed?.ingredientAdds) ? parsed.ingredientAdds.map((item) => safeTrim(item)).filter(Boolean) : [],
      instructionAdds: Array.isArray(parsed?.instructionAdds) ? parsed.instructionAdds.map((item) => safeTrim(item)).filter(Boolean) : [],
      ingredientSection: safeTrim(parsed?.ingredientSection),
      instructionCue: safeTrim(parsed?.instructionCue),
    };
  } catch (error) {
    console.error('Recipe additive fallback failed:', error?.message || error);
    return null;
  }
}

export function buildExplicitCookbookReplacement(existingEntry, revisedRecipe) {
  const existing = buildCookbookRecordForStorage(existingEntry);
  const revised = buildCookbookRecordForStorage(revisedRecipe);
  if (!existing || !revised) return null;
  return buildCookbookRecordForStorage({
    title: revised.title || existing.title,
    summary: revised.summary || existing.summary,
    category: safeTrim(revised.category) || existing.category || '',
    recipeType: revised.recipeType || existing.recipeType || 'saved_recipe',
    ingredients: Array.isArray(revised.ingredients) && revised.ingredients.length > 0 ? revised.ingredients : existing.ingredients,
    instructions: Array.isArray(revised.instructions) && revised.instructions.length > 0 ? revised.instructions : existing.instructions,
    tags: Array.isArray(revised.tags) && revised.tags.length > 0 ? revised.tags : existing.tags,
    notes: Array.isArray(revised.notes) && revised.notes.length > 0 ? revised.notes : existing.notes,
    sourceTitle: existing.sourceTitle,
    sourceUrl: existing.sourceUrl,
    sourceKind: existing.sourceKind,
    sourceChatId: existing.sourceChatId,
    lastUsedAt: existing.lastUsedAt,
  });
}

export async function reviseStructuredRecipe({
  anthropic,
  householdId,
  chatId,
  request = '',
  recipeRecord,
  recentConversation = [],
  latestAssistantText = '',
  memoryContext = null,
}) {
  const baseRecord = buildCookbookRecordForStorage(recipeRecord);
  const revisionRequest = safeTrim(request);
  if (!anthropic || !baseRecord || !revisionRequest) return null;
  const requestRevision = async ({ retryReason = '', priorCandidate = null, requiredAdditions = null } = {}) => {
    const response = await createLoggedAnthropicMessage(
      anthropic,
      {
        model: resolveAnthropicModelForCallPurpose('cookbook_shape'),
        max_tokens: 1400,
        system: `You revise structured recipes for KitchenBot.

Return ONLY JSON:
{"title":"...","summary":"...","category":"soups|sauces|pasta|lunch_dishes|fish|poultry|meat|vegetables|dessert_cakes|","ingredients":["..."],"instructions":["..."],"tags":["..."],"notes":["..."]}

Rules:
- Work from the existing structured recipe plus the user's revision request.
- Return the FULL revised recipe, not a patch or explanation.
- Apply the user's request directly to the recipe.
- If the request changes an ingredient or component, update both ingredients and instructions when the change belongs in both places.
- The revised recipe must visibly reflect the requested change.
- If the user asks to add an ingredient to a specific component like the dressing, marinade, sauce, glaze, topping, or filling, add that ingredient inside that component's ingredients and inside the relevant instruction step.
- If the ingredient already appears elsewhere and the user says "too", keep the existing mention and also add it to the newly requested component.
- Keep unaffected parts of the recipe intact.
- Do not duplicate ingredients, steps, tags, or notes.
- Keep titles clean and natural, not assistant framing.
- Do not invent source metadata or talk about saving anything.
- If requiredAdditions are provided, you must incorporate every listed ingredientAdd and instructionAdd into the final recipe exactly once in a natural way.
- Preserve recipe readability after repeated revisions. Keep section headers clean, ingredient lines compact, and instruction steps natural.`,
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              revisionRequest,
              existingRecipe: baseRecord,
              recentConversation: compactRecentConversation(recentConversation),
              latestAssistantRecipeText: safeTrim(latestAssistantText),
              appliedMemory: safeTrim(memoryContext?.applicationText || ''),
              appliedDefaults: safeTrim(memoryContext?.appliedDefaultsText || ''),
              retryReason: safeTrim(retryReason),
              priorCandidate,
              requiredAdditions,
            }),
          },
        ],
      },
      {
        householdId,
        chatId,
        runtimeEnabled: true,
        callSurface: 'kb_action',
        callPurpose: 'cookbook_shape',
        webSearchEnabledAtCall: !!memoryContext?.capabilities?.webSearchEnabled,
        usedWebSearchTool: false,
      }
    );
    const text = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
    const parsed = parseJsonObject(text);
    return sanitizeRecipeReplyRecord({
      ...baseRecord,
      title: safeTrim(parsed?.title) || baseRecord.title,
      summary: safeTrim(parsed?.summary) || baseRecord.summary,
      category: safeTrim(parsed?.category) || baseRecord.category,
      ingredients: Array.isArray(parsed?.ingredients) && parsed.ingredients.length > 0 ? parsed.ingredients : baseRecord.ingredients,
      instructions: Array.isArray(parsed?.instructions) && parsed.instructions.length > 0 ? parsed.instructions : baseRecord.instructions,
      tags: Array.isArray(parsed?.tags) && parsed.tags.length > 0 ? parsed.tags : baseRecord.tags,
      notes: Array.isArray(parsed?.notes) ? parsed.notes : baseRecord.notes,
      sourceTitle: baseRecord.sourceTitle,
      sourceUrl: baseRecord.sourceUrl,
      sourceKind: baseRecord.sourceKind,
      sourceChatId: baseRecord.sourceChatId,
      lastUsedAt: baseRecord.lastUsedAt,
    });
  };
  try {
    const firstPass = await requestRevision();
    if (!firstPass) return null;
    const explicitAdditive = looksLikeExplicitAdditiveRequest(revisionRequest);
    let additiveFallback = null;
    if (!sameRecipeBody(baseRecord, firstPass) && !explicitAdditive) return firstPass;
    const secondPass = await requestRevision({
      retryReason:
        'The first revision came back materially unchanged. Fix that now. The revised recipe must visibly incorporate the user request into the relevant ingredients and instructions.',
      priorCandidate: firstPass,
    });
    let candidate = secondPass || firstPass;
    if (explicitAdditive) {
      additiveFallback = await deriveRecipeAdditiveFallback({
        anthropic,
        householdId,
        chatId,
        revisionRequest,
        baseRecord,
        memoryContext,
      });
      if (
        additiveFallback &&
        (additiveFallback.ingredientAdds.length > 0 || additiveFallback.instructionAdds.length > 0) &&
        !recipeReflectsAdditiveFallback(candidate, additiveFallback)
      ) {
        const guidedCandidate = await requestRevision({
          retryReason:
            'Your earlier revision still did not visibly apply the requested additive change. Rebuild the full recipe now and make sure the required additions appear in both the ingredients and instructions where appropriate.',
          priorCandidate: candidate,
          requiredAdditions: additiveFallback,
        });
        if (guidedCandidate) {
          candidate = guidedCandidate;
        }
      }
      if (
        candidate &&
        !sameRecipeBody(baseRecord, candidate) &&
        recipeReflectsAdditiveFallback(candidate, additiveFallback)
      ) {
        return candidate;
      }
      const structuralBase = candidate && !sameRecipeBody(baseRecord, candidate) ? candidate : baseRecord;
      const structurallyRevised = applyNarrowAdditiveFallback(structuralBase, additiveFallback);
      if (structurallyRevised) return structurallyRevised;
      return null;
    }
    return candidate && !sameRecipeBody(baseRecord, candidate) ? candidate : null;
  } catch (error) {
    console.error('Recipe revision failed:', error?.message || error);
    return null;
  }
}