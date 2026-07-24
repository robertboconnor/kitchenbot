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

function compactRecentConversation(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.role === 'user' || message?.role === 'assistant')
    .slice(-12)
    .map((message) => `${message.role === 'user' ? message.name || 'User' : message.name || 'KitchenBot'}: ${safeTrim(message.content)}`)
    .filter(Boolean)
    .join('\n\n');
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
