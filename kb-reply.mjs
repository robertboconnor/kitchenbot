import {
  addMessage,
  clearChatRuntimeState,
  getMessages,
  setChatRuntimeState,
  updateChatTitle,
} from './db.mjs';
import { createLoggedAnthropicMessage } from './anthropic-usage.mjs';
import { resolveAnthropicModelForCallPurpose } from './anthropic-model-policy.mjs';
import { promptNeedsCookbookContext } from './kb-context-policy.mjs';
import {
  buildKbAssistantPersonaSystemText,
  buildKbContextSystemText,
  formatKbRecentConversation,
  getKbAssistantPersona,
} from './kb-prompt-context.mjs';
import { getCookbookDisplayTitle } from './cookbook-store.mjs';
import {
  formatAppliedWorkingContextText,
  formatWorkingContextText,
  normalizeWorkingContext,
  refreshKbWorkingContext,
} from './kb-working-context.mjs';
import { buildChoiceActionState, buildClarifyActionState } from './kb-next-action.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

function normalizeLooseEntityKey(raw) {
  return safeTrim(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseJsonObject(raw) {
  let s = safeTrim(raw);
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)```$/im);
  if (fence) s = safeTrim(fence[1]);
  try {
    return JSON.parse(s);
  } catch {
    const match = s.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function getDominantWorkingContextDish(workingContext) {
  const context = normalizeWorkingContext(workingContext);
  if (!context) return '';
  if (Array.isArray(context.subjectItems) && context.subjectItems.length > 0) {
    return safeTrim(context.subjectItems[0]);
  }
  if (Array.isArray(context.mealIdeas) && context.mealIdeas.length > 0) {
    return safeTrim(context.mealIdeas[0]);
  }
  return '';
}

function promptLooksLikeMealPlanningDraft(prompt = '') {
  const text = safeTrim(prompt).toLowerCase();
  if (!text) return false;
  const asksToPlan = /\b(plan|map out|figure out|come up with|draft)\b/.test(text);
  const mentionsMeals = /\b(meal|meals|dinner|dinners|lunch|lunches|breakfast|breakfasts|week)\b/.test(text);
  const mentionsSlots =
    /\bone\b.*\bone\b/.test(text) ||
    /\bsomething\b.*\bsomething\b/.test(text) ||
    /\bslot\b/.test(text) ||
    /\bvibe\b/.test(text) ||
    /\bfor this week\b/.test(text);
  return asksToPlan && mentionsMeals && mentionsSlots;
}

function promptLooksLikeGenericRecipeFollowUp(prompt = '') {
  const text = safeTrim(prompt).toLowerCase().replace(/[.!?]+$/g, '');
  if (!text) return false;
  return [
    'show me the recipe',
    'give me the recipe',
    'show me the full recipe',
    'give me the full recipe',
    'the recipe',
    'full recipe',
  ].includes(text);
}

function replyLooksLikePlanningMenu(replyText = '') {
  const text = safeTrim(replyText);
  if (!text) return false;
  const lower = text.toLowerCase();
  const asksToChoose =
    /\b(do any of these|which sounds better|which direction|would you rather|does this direction feel right|do these directions feel right)\b/.test(lower);
  const alternativeCount = (lower.match(/\bor\b/g) || []).length;
  const hedges = (lower.match(/\b(maybe|could be|options include|i'm thinking|how about)\b/g) || []).length;
  return asksToChoose || alternativeCount >= 4 || hedges >= 3;
}

function formatStructuredMealPlanRewrite(structured) {
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return '';
  const intro = safeTrim(structured.intro);
  const closing = safeTrim(structured.closing);
  const slots = Array.isArray(structured.slots) ? structured.slots : [];
  const normalizedSlots = slots
    .map((slot) => ({
      label: safeTrim(slot?.label),
      dish: safeTrim(slot?.dish),
      why: safeTrim(slot?.why),
    }))
    .filter((slot) => slot.label && slot.dish);
  if (normalizedSlots.length === 0) return '';
  const lines = [];
  if (intro) lines.push(intro);
  for (const slot of normalizedSlots) {
    lines.push(`**${slot.label}:** ${slot.dish}${slot.why ? ` — ${slot.why}` : ''}`);
  }
  if (closing) lines.push(closing);
  return lines.join('\n\n').trim();
}

async function maybeRewriteMealPlanningDraft({
  anthropic,
  req,
  chatId,
  turnId,
  routePrompt,
  replyText,
  resolvedMemoryContext,
  recentConversationText,
}) {
  if (!anthropic) return replyText;
  if (!promptLooksLikeMealPlanningDraft(routePrompt)) return replyText;
  if (!replyLooksLikePlanningMenu(replyText)) return replyText;

  let candidate = replyText;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const failureNote =
      attempt > 0
        ? '\n\nThe previous rewrite still returned options or asked the user to choose. Fix that by choosing one leading dish per slot now.'
        : '';
    const response = await createLoggedAnthropicMessage(
      anthropic,
      {
        model: resolveAnthropicModelForCallPurpose('chat_reply'),
        max_tokens: 500,
        system: `${buildKbAssistantPersonaSystemText(resolvedMemoryContext)}

Choose one concrete first-pass meal plan from the draft.

Rules:
- Keep the same overall user intent, household constraints, and cooking vibe.
- Fill each requested slot with one chosen dish.
- Choose a leading dish when several would work.
- Returning a menu of options, "or" comparisons, or a request for the user to choose is a failure unless the original prompt truly made a concrete draft impossible.
- Return ONLY JSON with this shape:
{"intro":"...","slots":[{"label":"...","dish":"...","why":"..."}],"closing":"..."}
- "intro" and "closing" are optional strings.
- Each slot must have exactly one chosen dish.
- "why" should be short and natural, not a whole recipe.
- No markdown fences.`,
        messages: [
          {
            role: 'user',
            content: `Latest user prompt:\n${routePrompt}\n\nRecent conversation:\n${recentConversationText}\n\nDraft reply to rewrite:\n${candidate}${failureNote}`,
          },
        ],
      },
      {
        householdId: req.householdId,
        chatId,
        turnId: turnId || null,
        prompt: routePrompt,
        runtimeEnabled: true,
        callSurface: 'chat',
        callPurpose: 'chat_reply',
        webSearchEnabledAtCall: false,
        usedWebSearchTool: false,
      }
    );

    const rewritten = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
    const parsed = parseJsonObject(rewritten);
    const formatted = formatStructuredMealPlanRewrite(parsed);
    if (safeTrim(formatted)) {
      candidate = formatted;
    } else if (safeTrim(rewritten)) {
      candidate = rewritten;
    } else {
      break;
    }
    if (!replyLooksLikePlanningMenu(candidate)) break;
  }

  return candidate;
}

function chunkReplyForStreaming(text, maxChunkLength = 160) {
  const source = String(text ?? '');
  if (!source) return [];
  const chunks = [];
  let remaining = source;
  while (remaining.length > maxChunkLength) {
    let boundary = remaining.lastIndexOf('\n', maxChunkLength);
    if (boundary < Math.floor(maxChunkLength * 0.5)) {
      boundary = remaining.lastIndexOf(' ', maxChunkLength);
    }
    if (boundary < Math.floor(maxChunkLength * 0.5)) {
      boundary = maxChunkLength;
    }
    chunks.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary);
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter((chunk) => chunk.length > 0);
}

function writeChatStreamEvent(res, event) {
  if (typeof res?.write !== 'function') return;
  if (!res.headersSent) {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-KitchenBot-Stream-Format', 'ndjson');
  }
  res.write(`${JSON.stringify(event)}\n`);
}

async function streamReplyText({ res, deps, chatId, householdId, turnId, text }) {
  const chunks = chunkReplyForStreaming(text);
  if (typeof res.write !== 'function') {
    if (Array.isArray(chunks) && chunks.length > 0) {
      for (const chunk of chunks) {
        deps.broadcastToChat?.(chatId, {
          type: 'stream_delta',
          householdId,
          chatId,
          turnId,
          delta: chunk,
        });
      }
    }
    res.end(text);
    return;
  }
  for (const chunk of chunks) {
    deps.broadcastToChat?.(chatId, {
      type: 'stream_delta',
      householdId,
      chatId,
      turnId,
      delta: chunk,
    });
    writeChatStreamEvent(res, {
      type: 'delta',
      turnId: turnId ? String(turnId) : null,
      delta: chunk,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  writeChatStreamEvent(res, {
    type: 'done',
    turnId: turnId ? String(turnId) : null,
  });
  res.end();
}

function sanitizeChatTitle(raw) {
  let text = safeTrim(raw)
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/g, '');
  if (!text) return '';
  if (text.length > 48) {
    text = text.slice(0, 48).trim();
  }
  return text || '';
}

function getAssistantNameFromContext(memoryContext = null) {
  return getKbAssistantPersona(memoryContext).assistantName;
}

function routePromptAsksAboutLinkedRecipeFetch(prompt = '') {
  const text = safeTrim(prompt).toLowerCase();
  if (!text) return false;
  const asksAboutReading = /\b(read|fetch|fetched|pull|pulled|browse|browsed)\b/.test(text) && /\b(url|link|website|web page)\b/.test(text);
  const asksAboutFailure = /\b(why not|what was the issue|what was wrong|what happened|did it fail|why did it fail)\b/.test(text);
  const mentionsQueryParam = /\?[a-z0-9_=&%-]+/.test(text) || /\bparameter\b/.test(text);
  return asksAboutReading || asksAboutFailure || mentionsQueryParam;
}

function buildLinkedRecipeFetchFollowUpReply(workingContext, routePrompt) {
  const context = normalizeWorkingContext(workingContext);
  if (!context?.linkedRecipeUrl || !routePromptAsksAboutLinkedRecipeFetch(routePrompt)) return '';

  const title = safeTrim(context.linkedRecipeTitle) || 'that linked recipe';
  const status = safeTrim(context.linkedRecipeFetchStatus).toLowerCase();
  const failureReason = safeTrim(context.linkedRecipeFailureReason) || 'I could not read enough recipe detail from that link to save it properly.';
  const blocked = !!context.linkedRecipeFetchBlocked || status === 'blocked' || safeTrim(context.linkedRecipeFailureKind).toLowerCase() === 'blocked';
  const blockerKind = safeTrim(context.linkedRecipeBlockerKind).toLowerCase();
  const httpStatus = Number(context.linkedRecipeHttpStatus) || 0;
  const asksAboutRead = /\b(read|fetch|fetched|pull|pulled|browse|browsed)\b/i.test(routePrompt) && /\b(url|link|website|web page)\b/i.test(routePrompt);
  const asksAboutWhy = /\b(why not|what was the issue|what was wrong|what happened|did it fail|why did it fail)\b/i.test(routePrompt);
  const asksAboutParam = /\?[a-z0-9_=&%-]+/i.test(routePrompt) || /\bparameter\b/i.test(routePrompt);

  if (status === 'fetched') {
    if (asksAboutParam) {
      return `I did read ${title} from the linked URL. I do not have evidence that the URL parameter caused a problem on that save attempt.`;
    }
    return `Yes. I read ${title} from the linked URL before saving it.`;
  }

  const lines = [];
  if (asksAboutRead || asksAboutWhy || asksAboutParam) {
    lines.push(`No. I did not read enough of the linked page to save ${title} from the URL.`);
    if (blocked) {
      lines.push(`That site blocked automated page access from our server${httpStatus ? ` with HTTP ${httpStatus}` : ''}${blockerKind === 'cloudflare' ? ' behind Cloudflare' : ''}.`);
    } else {
      lines.push(failureReason);
    }
    if (asksAboutParam) {
      lines.push(blocked
        ? "I do not have evidence that the URL parameter itself was the problem. I only know the site blocked the automated fetch attempt."
        : "I do not have evidence that the URL parameter itself was the problem. I only know that I couldn't extract enough recipe detail from that linked page on that attempt.");
    }
    lines.push(blocked
      ? 'If you want, paste the recipe text here and I can save it manually.'
      : 'If you want, paste the recipe text here or ask me to retry the web lookup and I can try again from there.');
    return lines.join(' ');
  }
  return '';
}

async function resolveAssistantName({ req, routePrompt = '', memoryContext = null, deps }) {
  if (memoryContext) return getAssistantNameFromContext(memoryContext);
  if (!deps?.buildKbContextPacket) return getAssistantNameFromContext(null);
  const resolvedMemoryContext = await deps.buildKbContextPacket(req.householdId, routePrompt, {
    limit: 6,
    activeSpeakerName: req.user,
    includeCookbook: false,
    capabilities: req.kbCapabilities,
  }).catch(() => null);
  return getAssistantNameFromContext(resolvedMemoryContext);
}

function fallbackChatTitle(messages, routePrompt) {
  const userMessages = (Array.isArray(messages) ? messages : [])
    .filter((message) => message.role === 'user')
    .map((message) => safeTrim(message.content))
    .filter(Boolean);
  const preferred =
    userMessages.find((text) => text.length >= 8 && !/^(hi|hello|hey|yo|sup|ok|okay)$/i.test(text)) ||
    safeTrim(routePrompt) ||
    userMessages[0] ||
    'Kitchen Chat';
  const cleaned = preferred
    .replace(/^(can you|could you|please|hey|hi|hello)\s+/i, '')
    .replace(/\bi need\b/i, '')
    .replace(/\bhelp me\b/i, '')
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 6);
  const title = words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
  return sanitizeChatTitle(title || 'Kitchen Chat') || 'Kitchen Chat';
}

async function maybeAutoTitleChat({ anthropic, req, chatId, routePrompt, deps }) {
  const messages = await getMessages(chatId, req.householdId);
  const userMessages = messages.filter((message) => message.role === 'user');
  const userMessageCount = userMessages.length;
  if (userMessageCount !== 1 && userMessageCount !== 3) return;

  let nextTitle = '';
  if (anthropic) {
    try {
      const transcript = userMessages
        .slice(0, Math.min(userMessages.length, 3))
        .map((message) => `${message.name || 'User'}: ${safeTrim(message.content)}`)
        .join('\n');
      const response = await createLoggedAnthropicMessage(
        anthropic,
        {
          model: resolveAnthropicModelForCallPurpose('chat_title'),
          max_tokens: 24,
          system: `Write a very short chat title for KitchenBot.

Rules:
- 2 to 5 words when possible.
- Plain text only.
- No quotes.
- No trailing punctuation.
- Title case.
- Reflect the main topic of the conversation so far.
- If the first user message is vague, make the best lightweight title now; it may be refined later.`,
          messages: [
            {
              role: 'user',
              content: `User message count: ${userMessageCount}\nLatest prompt: ${routePrompt}\nConversation so far:\n${transcript || '(none)'}`,
            },
          ],
        },
        {
          householdId: req.householdId,
          chatId,
          turnId: req.kbTurnId || null,
          prompt: routePrompt,
          runtimeEnabled: true,
          callSurface: 'background',
          callPurpose: 'chat_title',
          webSearchEnabledAtCall: false,
          usedWebSearchTool: false,
        }
      );
      nextTitle = sanitizeChatTitle(
        response.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
      );
    } catch (error) {
      nextTitle = '';
    }
  }

  if (!nextTitle) {
    nextTitle = fallbackChatTitle(messages, routePrompt);
  }
  if (!nextTitle) return;
  await updateChatTitle(chatId, req.householdId, nextTitle).catch(() => {});
}

function formatGroceryItemsCompact(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const name = safeTrim(item?.name);
      if (!name) return null;
      const amount = safeTrim(item?.amount);
      const section = safeTrim(item?.section).toLowerCase();
      return amount ? `${section || 'other'} | ${name} | ${amount}` : `${section || 'other'} | ${name}`;
    })
    .filter(Boolean)
    .join('\n');
}

function fallbackGroceryPreviewReply(items) {
  const list = (Array.isArray(items) ? items : []).filter((item) => safeTrim(item?.name));
  if (list.length === 0) {
    return 'I could not build a grocery list from this yet.';
  }

  const grouped = new Map();
  for (const item of list) {
    const section = safeTrim(item?.section).toLowerCase() || 'other';
    const label = safeTrim(item?.amount)
      ? `${safeTrim(item.name)} (${safeTrim(item.amount)})`
      : safeTrim(item.name);
    if (!grouped.has(section)) grouped.set(section, []);
    grouped.get(section).push(label);
  }

  const sectionLines = [...grouped.entries()].map(([section, names]) => {
    const prettySection = section.charAt(0).toUpperCase() + section.slice(1);
    return `${prettySection}: ${names.join(', ')}`;
  });

  return [
    'Here’s the grocery list I’d start with for that:',
    ...sectionLines,
  ].join('\n');
}

function fallbackMemoryOutcomeReply(outcome) {
  if (!outcome || typeof outcome !== 'object') return 'I could not save that to memory.';
  if (outcome.status === 'invalid') return safeTrim(outcome.error) || 'I could not save that to memory.';
  const label = safeTrim(outcome.label);
  const isPerson = outcome.memoryType === 'person' && label;
  const isHousehold = outcome.memoryType === 'household_note';
  if (outcome.status === 'saved') {
    if (isPerson) return `I saved that for ${label}.`;
    if (isHousehold) return 'I saved that to household memory.';
    return 'I saved that to memory.';
  }
  if (outcome.status === 'updated') {
    if (isPerson) return `I updated what I know about ${label}.`;
    if (isHousehold) return 'I updated the household memory for that.';
    return 'I updated that memory.';
  }
  if (outcome.status === 'unchanged') {
    if (isPerson) return `I already had that saved for ${label}.`;
    if (isHousehold) return 'I already had that in household memory.';
    return 'I already had that saved.';
  }
  if (outcome.status === 'skipped') return 'I did not save that to memory.';
  return 'I could not save that to memory.';
}

function fallbackGroceryWriteReply(outcome) {
  if (!outcome || typeof outcome !== 'object') return 'I could not update the grocery list.';
  if (outcome.status === 'already_present') {
    const matchedItems = Array.isArray(outcome.matchedItems) ? outcome.matchedItems : [];
    const first = matchedItems[0] || null;
    const name = safeTrim(first?.name);
    const section = safeTrim(first?.section).toLowerCase();
    if (name && section) {
      return `I checked the Grocery List tab and ${name} is already there under ${section}. I did not add a duplicate.`;
    }
    if (name) {
      return `I checked the Grocery List tab and ${name} is already there, so I did not add a duplicate.`;
    }
    return 'I checked the Grocery List tab and those items were already there, so I did not add duplicates.';
  }
  if (outcome.status === 'committed') {
    const pantryWasUsed = !!outcome.usedPantryContext;
    const pantryStatus = safeTrim(outcome.pantryContextStatus).toLowerCase();
    if (outcome.changed) {
      if (pantryWasUsed && pantryStatus === 'available') {
        return 'I checked your Pantry and updated the Grocery List tab with what was still missing.';
      }
      if (pantryWasUsed && pantryStatus === 'empty') {
        return 'I checked your Pantry, did not find those items on hand, and updated the Grocery List tab.';
      }
      return 'I updated the Grocery List tab.';
    }
    if (Number(outcome.parsedItemCount || 0) > 0) {
      if (pantryWasUsed && pantryStatus === 'available') {
        return "I checked your Pantry and Grocery List tab, and there wasn't anything new to add.";
      }
      return "The Grocery List tab already had those items, so there wasn't anything new to update.";
    }
    if (outcome.pantryClarificationNeeded) {
      return 'I could not check your Pantry state for that turn, so I could not finish the Grocery List update yet.';
    }
    return 'I could not build a grocery list from this yet.';
  }
  return 'I could not update the grocery list.';
}

function formatInventoryMatchLabels(matches) {
  return (Array.isArray(matches) ? matches : [])
    .map((match) => safeTrim(match?.name))
    .filter(Boolean)
    .slice(0, 4)
    .join(', ');
}

function fallbackGroceryActionReply(outcome) {
  if (!outcome || typeof outcome !== 'object') return 'I could not update the Grocery List tab.';
  if (outcome.status === 'invalid') return safeTrim(outcome.error) || 'I could not update the Grocery List tab.';
  if (outcome.status === 'missing') {
    const name = safeTrim(outcome.missingName);
    return name ? `I could not find ${name} on the Grocery List tab.` : 'I could not find that Grocery List tab item.';
  }
  if (outcome.status === 'ambiguous') {
    const name = safeTrim(outcome.requestedName);
    const choices = formatInventoryMatchLabels(outcome.matches);
    if (choices) {
      return name
        ? `I found more than one Grocery List tab item that could match ${name}: ${choices}. Which one did you mean?`
        : `I found more than one possible Grocery List tab item: ${choices}. Which one did you mean?`;
    }
    return 'I found more than one possible Grocery List tab item. Which one did you mean?';
  }
  if (outcome.status === 'unchanged') {
    const name = safeTrim(outcome.itemName);
    if (outcome.capability === 'grocery.check') {
      return name ? `${name} was already checked off on the Grocery List tab.` : 'That Grocery List tab item was already checked off.';
    }
    if (outcome.capability === 'grocery.uncheck') {
      return name ? `${name} was already active on the Grocery List tab.` : 'That Grocery List tab item was already active.';
    }
    if (outcome.capability === 'grocery.clear') {
      return 'The Grocery List tab was already empty.';
    }
  }
  if (outcome.status === 'removed') {
    const name = safeTrim(outcome.removedName);
    return name ? `I removed ${name} from the Grocery List tab.` : 'I removed that from the Grocery List tab.';
  }
  if (outcome.status === 'checked') {
    const name = safeTrim(outcome.itemName);
    return name ? `I checked off ${name} on the Grocery List tab.` : 'I checked that off on the Grocery List tab.';
  }
  if (outcome.status === 'unchecked') {
    const name = safeTrim(outcome.itemName);
    return name ? `I put ${name} back on the Grocery List tab.` : 'I put that back on the Grocery List tab.';
  }
  if (outcome.status === 'cleared') {
    const count = Number(outcome.clearedCount || 0);
    return count > 0 ? `I cleared the Grocery List tab.` : 'The Grocery List tab was already empty.';
  }
  return 'I updated the Grocery List tab.';
}

function fallbackHouseholdDefaultsUpdateReply(outcome) {
  if (!outcome || typeof outcome !== 'object') return 'I could not update the household defaults.';
  if (outcome.status === 'invalid') return safeTrim(outcome.error) || 'I could not update the household defaults.';
  const changedFields = Array.isArray(outcome.changedFields) ? outcome.changedFields : [];
  if (outcome.status === 'unchanged') {
    return 'Those household defaults were already set that way.';
  }
  if (changedFields.length > 0) {
    return `I updated the household defaults for ${changedFields.join(', ')}.`;
  }
  return 'I updated the household defaults.';
}

function fallbackPantryReply(outcome) {
  if (!outcome || typeof outcome !== 'object') return 'I could not update the Pantry.';
  if (outcome.status === 'invalid') return safeTrim(outcome.error) || 'I could not update the Pantry.';
  if (outcome.status === 'ambiguous') {
    const name = safeTrim(outcome.requestedName);
    const choices = formatInventoryMatchLabels(outcome.matches);
    if (choices) {
      return name
        ? `I found more than one Pantry item that could match ${name}: ${choices}. Which one did you mean?`
        : `I found more than one possible Pantry item: ${choices}. Which one did you mean?`;
    }
    return 'I found more than one possible Pantry item. Which one did you mean?';
  }
  if (outcome.status === 'missing') {
    const name = safeTrim(outcome.missingName);
    if (outcome.capability === 'pantry.remove') {
      return name ? `I could not find ${name} in the Pantry.` : 'I could not find that Pantry item.';
    }
    return name ? `I could not find ${name} to move.` : 'I could not find that item to move.';
  }
  if (outcome.status === 'unchanged') {
    if (outcome.capability === 'pantry.add') return 'Those items were already in the Pantry.';
    if (outcome.capability === 'pantry.remove') return 'There was nothing to remove from the Pantry.';
    return 'There was nothing to move.';
  }
  if (outcome.status === 'added') {
    const count = Number(outcome.addedCount || 0);
    return count === 1 ? 'I added that to the Pantry.' : `I added ${count} items to the Pantry.`;
  }
  if (outcome.status === 'removed') {
    const name = safeTrim(outcome.removedName);
    return name ? `I removed ${name} from the Pantry.` : 'I removed that from the Pantry.';
  }
  if (outcome.status === 'moved') {
    const name = safeTrim(outcome.movedName);
    if (outcome.capability === 'pantry.move_to_grocery') {
      return name ? `I moved ${name} to the Grocery List tab.` : 'I moved that to the Grocery List tab.';
    }
    return name ? `I moved ${name} to the Pantry.` : 'I moved that to the Pantry.';
  }
  return 'I updated the Pantry.';
}

function fallbackWebSearchReply(outcome) {
  if (!outcome || typeof outcome !== 'object') return 'I could not complete a live web search.';
  if (outcome.status === 'disabled') {
    return safeTrim(outcome.error) || 'Live web search is not enabled for this household.';
  }
  if (outcome.status === 'invalid') {
    return safeTrim(outcome.error) || 'I need a clearer search topic before I can look something up.';
  }
  if (outcome.status === 'unavailable') {
    return safeTrim(outcome.error) || 'I could not complete a live web search right now.';
  }
  if (outcome.status === 'no_results') {
    const query = safeTrim(outcome.query);
    return query
      ? `I looked up ${query}, but I did not get useful results back.`
      : 'I completed a web search, but I did not get useful results back.';
  }
  if (outcome.status === 'searched') {
    const summary = safeTrim(outcome.summary);
    if (summary) return summary;
    const query = safeTrim(outcome.query);
    return query ? `I looked up ${query}.` : 'I looked that up.';
  }
  return 'I could not complete a live web search.';
}

function fallbackCookbookReply(outcome) {
  if (!outcome || typeof outcome !== 'object') return 'I could not update the cookbook.';
  if (outcome.status === 'invalid') return safeTrim(outcome.error) || 'I could not update the cookbook.';
  if (
    outcome.status === 'unavailable' ||
    outcome.status === 'blocked' ||
    outcome.status === 'disabled' ||
    outcome.status === 'no_results' ||
    outcome.status === 'parse_failed' ||
    outcome.status === 'extraction_failed'
  ) {
    return safeTrim(outcome.error) || 'I could not read that linked recipe well enough to save it.';
  }
  if (outcome.status === 'saved') {
    const title = getCookbookDisplayTitle({ title: outcome.title });
    if (outcome.fetchPerformed) {
      return title ? `I read the linked recipe and saved ${title} to your cookbook.` : 'I read the linked recipe and saved it to your cookbook.';
    }
    return title ? `I saved ${title} to your cookbook.` : 'I saved that to your cookbook.';
  }
  if (outcome.status === 'updated') {
    const title = getCookbookDisplayTitle({ title: outcome.title });
    if (outcome.fetchPerformed) {
      return title ? `I read the linked recipe and updated ${title} in your cookbook.` : 'I read the linked recipe and updated that cookbook entry.';
    }
    return title ? `I updated ${title} in your cookbook.` : 'I updated that cookbook entry.';
  }
  if (outcome.status === 'unchanged') {
    const title = getCookbookDisplayTitle({ title: outcome.title });
    if (outcome.fetchPerformed) {
      return title ? `I read the linked recipe, and ${title} was already in your cookbook.` : 'I read the linked recipe, and it was already in your cookbook.';
    }
    return title ? `${title} was already in your cookbook.` : 'I already had that in your cookbook.';
  }
  if (outcome.status === 'listed') {
    const entries = Array.isArray(outcome.entries) ? outcome.entries : [];
    if (entries.length === 0) return 'Your cookbook is empty right now.';
    return [
      `You have ${Number(outcome.count || entries.length)} saved ${Number(outcome.count || entries.length) === 1 ? 'entry' : 'entries'} in your cookbook:`,
      ...entries.map((entry) => `- ${safeTrim(entry.title)}${safeTrim(entry.summary) ? ` — ${safeTrim(entry.summary)}` : ''}`),
    ].join('\n');
  }
  if (outcome.status === 'missing') {
    const name = safeTrim(outcome.requestedName);
    return name ? `I could not find ${name} in your cookbook.` : 'I could not find that cookbook entry.';
  }
  if (outcome.status === 'ambiguous') {
    return safeTrim(outcome.question) || 'I found more than one cookbook entry that could match that. Which one did you mean?';
  }
  if (outcome.status === 'deleted') {
    const title = safeTrim(outcome.deletedTitle);
    return title ? `I deleted ${title} from your cookbook.` : 'I deleted that cookbook entry.';
  }
  return 'I updated the cookbook.';
}

export function shouldForceDeterministicOutcomeReply(outcomes) {
  const list = Array.isArray(outcomes) ? outcomes.filter(Boolean) : [];
  return list.some((outcome) => {
    const capability = safeTrim(outcome?.capability || outcome?.narrationType);
    const status = safeTrim(outcome?.status).toLowerCase();
    if (capability === 'web.search' && ['disabled', 'invalid', 'unavailable', 'no_results'].includes(status)) return true;
    if (capability === 'grocery.write' && status === 'already_present') return true;
    return false;
  });
}

function buildImplicitSearchNextAction(workingContext) {
  const context = normalizeWorkingContext(workingContext);
  const query = safeTrim(context?.offeredSearchTopic);
  if (!query) return null;
  return buildClarifyActionState({
    capability: 'web.search',
    input: { query },
    question: `If you want, I can search for ${query}.`,
    contextSummary: `Continue the pending web search for ${query}.`,
    unresolvedFields: [],
    visibleReplySummary: `If you want, I can search for ${query}.`,
  });
}

function buildImplicitGroceryNextAction(workingContext) {
  const context = normalizeWorkingContext(workingContext);
  const items = (Array.isArray(context?.offeredIngredients) ? context.offeredIngredients : [])
    .map((name) => ({ name: safeTrim(name), amount: '', section: '' }))
    .filter((item) => item.name);
  if (items.length === 0) return null;
  return buildClarifyActionState({
    capability: 'grocery.write',
    input: { source: 'offered_items', items },
    question: 'If you want, I can add those ingredients to the Grocery List tab.',
    contextSummary: 'Continue the pending grocery add for the offered ingredient set.',
    unresolvedFields: [],
    visibleReplySummary: 'If you want, I can add those ingredients to the Grocery List tab.',
  });
}

async function deriveImplicitMemoryNextAction({
  anthropic,
  req,
  chatId,
  turnId,
  routePrompt,
  replyText,
  memoryContext,
}) {
  if (!anthropic) return null;
  const combined = `${safeTrim(routePrompt)}\n${safeTrim(replyText)}`.toLowerCase();
  if (!/\b(save|remember|memory|preference|preferences|store)\b/.test(combined)) return null;
  const knownPeople = [
    ...(memoryContext?.selectedMemoryItems || [])
      .filter((item) => String(item?.memoryType || item?.type || '').trim().toLowerCase() === 'person')
      .map((item) => safeTrim(item?.label)),
    ...(memoryContext?.rows || [])
      .map((row) => safeTrim(row?.key))
      .filter((key) => /_preferences$/i.test(key))
      .map((key) => key.replace(/_preferences$/i, '')),
  ].filter(Boolean);
  const knownPersonKeys = new Set(knownPeople.map((label) => normalizeLooseEntityKey(label)).filter(Boolean));
  const response = await createLoggedAnthropicMessage(
    anthropic,
    {
      model: resolveAnthropicModelForCallPurpose('chat_reply'),
      max_tokens: 260,
      system: `You decide whether KitchenBot's reply is offering a bounded memory save that the user can accept on the next turn.

Return ONLY JSON.

If no bounded memory save is being offered, return:
{"kind":"none"}

If a bounded memory save is being offered, return:
{"kind":"choice","question":"...","defaultChoiceId":"1","choices":[{"id":"1","label":"...","key":"...","value":"..."}]}

Rules:
- Only propose memory.save next actions.
- Only do this when the reply clearly offers to save a specific memory now.
- Use the exact new fact KitchenBot should save next. Do not merge it with older stored memory.
- If the reply offered multiple explicit wording options, return one choice per option.
- If the reply offered one recommended wording, return one choice.
- Choice labels should be short and user-facing.
- Do not invent facts beyond the prompt and reply.`,
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            prompt: routePrompt,
            reply: replyText,
            knownPeople,
          }),
        },
      ],
    },
    {
      householdId: req.householdId,
      chatId,
      turnId: turnId || null,
      prompt: routePrompt,
      runtimeEnabled: true,
      callSurface: 'background',
      callPurpose: 'chat_reply',
      webSearchEnabledAtCall: false,
      usedWebSearchTool: false,
    }
  );

  const raw = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
  const parsed = parseJsonObject(raw);
  if (!parsed || safeTrim(parsed.kind).toLowerCase() !== 'choice') return null;
  const choices = (Array.isArray(parsed.choices) ? parsed.choices : [])
    .map((choice, index) => {
      const rawKey = safeTrim(choice?.key);
      const normalizedKey = normalizeLooseEntityKey(rawKey);
      const normalizedKeyBase = normalizedKey.replace(/_preferences$/i, '');
      const matchedKnownPerson = [...knownPersonKeys].find(
        (personKey) =>
          normalizedKey === personKey ||
          normalizedKey.startsWith(`${personKey}_`) ||
          normalizedKeyBase === personKey
      );
      const key =
        normalizedKey && /_preferences$/i.test(normalizedKey)
          ? normalizedKey
          : matchedKnownPerson
            ? `${matchedKnownPerson}_preferences`
            : rawKey;
      const value = safeTrim(choice?.value);
      const label = safeTrim(choice?.label || choice?.value || `Option ${index + 1}`);
      const id = safeTrim(choice?.id || String(index + 1));
      if (!key || !value || !label || !id) return null;
      return {
        id,
        label,
        capability: 'memory.save',
        actionInput: { key, value },
      };
    })
    .filter(Boolean);
  if (choices.length === 0) return null;
  const defaultChoiceId = safeTrim(parsed.defaultChoiceId || choices[0]?.id);
  return buildChoiceActionState({
    capability: 'memory.save',
    choices,
    question: safeTrim(parsed.question || 'Do you want me to save that?'),
    visibleReplySummary: safeTrim(parsed.question || 'Do you want me to save that?'),
    defaultChoiceId: choices.some((choice) => choice.id === defaultChoiceId) ? defaultChoiceId : choices[0].id,
  });
}

async function deriveImplicitOfferNextAction({
  anthropic,
  req,
  chatId,
  turnId,
  routePrompt,
  replyText,
  workingContext,
  memoryContext,
}) {
  const reply = safeTrim(replyText);
  if (!reply) return null;
  if (/\b(search the web|search for|look (?:that|it) up|look up)\b/i.test(reply)) {
    return buildImplicitSearchNextAction(workingContext);
  }
  if (/\b(add\b.*\b(grocery list|grocery list tab)|grocery list\b.*\badd|want me to add)\b/i.test(reply)) {
    return buildImplicitGroceryNextAction(workingContext);
  }
  return deriveImplicitMemoryNextAction({
    anthropic,
    req,
    chatId,
    turnId,
    routePrompt,
    replyText,
    memoryContext,
  }).catch(() => null);
}

export function rewriteUngroundedActionOfferReply(replyText, proposedNextAction = null) {
  const reply = safeTrim(replyText);
  if (!reply || proposedNextAction) return reply;
  let next = reply;
  next = next.replace(
    /\b(?:Would you like|Do you want|Want)\s+me\s+to\s+search(?: the web)?\s+for\s+(.+?)\?/i,
    'If you want me to search for $1, ask me to search for it.'
  );
  next = next.replace(
    /\bShould I search(?: the web)?\s+for\s+(.+?)\?/i,
    'If you want me to search for $1, ask me to search for it.'
  );
  next = next.replace(
    /\b(?:Would you like|Do you want|Want)\s+me\s+to\s+add\s+(.+?)\s+to\s+your\s+Grocery List(?: tab)?\?/i,
    'If you want me to add $1 to the Grocery List tab, ask me to add it.'
  );
  next = next.replace(/\bSay yes and I(?:'|’)ll\s+/gi, 'If you want that, ask me to ');
  next = next.replace(/\bGot it[—-]I(?:'|’)ll\s+/gi, 'If you want that, ask me to ');
  return next;
}

function buildSkillOutcomeFacts(outcomes) {
  return (Array.isArray(outcomes) ? outcomes : [])
    .map((outcome) => {
      const capability = safeTrim(outcome?.capability || outcome?.narrationType || 'unknown');
      const status = safeTrim(outcome?.status || 'unknown');
      const label = safeTrim(outcome?.label);
      const parts = [`capability=${capability}`, `status=${status}`];
      if (label) parts.push(`label=${label}`);
      if (outcome?.memoryType) parts.push(`memoryType=${safeTrim(outcome.memoryType)}`);
      if (outcome?.changed != null) parts.push(`changed=${outcome.changed ? 'true' : 'false'}`);
      if (Number.isFinite(Number(outcome?.parsedItemCount))) parts.push(`parsedItemCount=${Number(outcome.parsedItemCount)}`);
      if (safeTrim(outcome?.mode)) parts.push(`mode=${safeTrim(outcome.mode)}`);
      if (safeTrim(outcome?.question)) parts.push(`question=${safeTrim(outcome.question)}`);
      if (Array.isArray(outcome?.changedFields) && outcome.changedFields.length > 0) {
        parts.push(`changedFields=${outcome.changedFields.join(', ')}`);
      }
      if (capability === 'meal.refine') {
        if (safeTrim(outcome?.replySummary)) parts.push(`replySummary=${safeTrim(outcome.replySummary)}`);
        if (Array.isArray(outcome?.revisedMeals) && outcome.revisedMeals.length > 0) {
          parts.push(`revisedMeals=${outcome.revisedMeals.join('; ')}`);
        }
        if (Array.isArray(outcome?.activeConstraints) && outcome.activeConstraints.length > 0) {
          parts.push(`activeConstraints=${outcome.activeConstraints.join('; ')}`);
        }
      }
      if (capability === 'web.search') {
        if (safeTrim(outcome?.query)) parts.push(`query=${safeTrim(outcome.query)}`);
        if (safeTrim(outcome?.summary)) parts.push(`summary=${safeTrim(outcome.summary)}`);
        if (safeTrim(outcome?.howToUse)) parts.push(`howToUse=${safeTrim(outcome.howToUse)}`);
        if (outcome?.usedWebSearchTool != null) parts.push(`usedWebSearchTool=${outcome.usedWebSearchTool ? 'true' : 'false'}`);
        if (Array.isArray(outcome?.sources) && outcome.sources.length > 0) {
          parts.push(
            `sources=${outcome.sources
              .map((source) => [safeTrim(source?.title), safeTrim(source?.url)].filter(Boolean).join(' — '))
              .filter(Boolean)
              .join(' ; ')}`
          );
        }
      }
      if (capability.startsWith('cookbook.')) {
        if (safeTrim(outcome?.title)) parts.push(`title=${safeTrim(outcome.title)}`);
        if (safeTrim(outcome?.deletedTitle)) parts.push(`deletedTitle=${safeTrim(outcome.deletedTitle)}`);
        if (safeTrim(outcome?.requestedName)) parts.push(`requestedName=${safeTrim(outcome.requestedName)}`);
      if (safeTrim(outcome?.sourceTitle)) parts.push(`sourceTitle=${safeTrim(outcome.sourceTitle)}`);
      if (safeTrim(outcome?.sourceUrl)) parts.push(`sourceUrl=${safeTrim(outcome.sourceUrl)}`);
      if (outcome?.urlBacked != null) parts.push(`urlBacked=${outcome.urlBacked ? 'true' : 'false'}`);
      if (outcome?.fetchPerformed != null) parts.push(`fetchPerformed=${outcome.fetchPerformed ? 'true' : 'false'}`);
      if (outcome?.fetchedExactUrl != null) parts.push(`fetchedExactUrl=${outcome.fetchedExactUrl ? 'true' : 'false'}`);
      if (outcome?.extractionSucceeded != null) parts.push(`extractionSucceeded=${outcome.extractionSucceeded ? 'true' : 'false'}`);
      if (safeTrim(outcome?.sourceKind)) parts.push(`sourceKind=${safeTrim(outcome.sourceKind)}`);
      if (safeTrim(outcome?.failureReason)) parts.push(`failureReason=${safeTrim(outcome.failureReason)}`);
      if (safeTrim(outcome?.suggestedRecoveryAction)) parts.push(`suggestedRecoveryAction=${safeTrim(outcome.suggestedRecoveryAction)}`);
      if (Array.isArray(outcome?.entries) && outcome.entries.length > 0) {
          parts.push(
            `entries=${outcome.entries
              .map((entry) => [safeTrim(entry?.title), safeTrim(entry?.summary)].filter(Boolean).join(' — '))
              .filter(Boolean)
              .join(' ; ')}`
          );
        }
      }
      if (outcome?.defaults && typeof outcome.defaults === 'object') {
        if (Number.isFinite(Number(outcome.defaults.defaultDinnerPortions))) {
          parts.push(`defaultDinnerPortions=${Number(outcome.defaults.defaultDinnerPortions)}`);
        }
        if (safeTrim(outcome.defaults.weeknightCookingStyle)) {
          parts.push(`weeknightCookingStyle=${safeTrim(outcome.defaults.weeknightCookingStyle)}`);
        }
      }
      if (capability === 'grocery.preview') {
        const compactItems = formatGroceryItemsCompact(outcome?.items || []);
        if (compactItems) parts.push(`items=\n${compactItems}`);
        if (Array.isArray(outcome?.optionModes) && outcome.optionModes.length > 0) {
          parts.push(`optionModes=${outcome.optionModes.join(', ')}`);
        }
        if (safeTrim(outcome?.question)) parts.push(`previewQuestion=${safeTrim(outcome.question)}`);
        if (outcome?.hasExistingList != null) parts.push(`hasExistingList=${outcome.hasExistingList ? 'true' : 'false'}`);
      }
      if (capability === 'pantry.add') {
        if (Number.isFinite(Number(outcome?.addedCount))) parts.push(`addedCount=${Number(outcome.addedCount)}`);
        const compactItems = formatGroceryItemsCompact(outcome?.items || []);
        if (compactItems) parts.push(`items=\n${compactItems}`);
      }
      if (capability === 'pantry.remove') {
        if (safeTrim(outcome?.removedName)) parts.push(`removedName=${safeTrim(outcome.removedName)}`);
        if (safeTrim(outcome?.missingName)) parts.push(`missingName=${safeTrim(outcome.missingName)}`);
      }
      if (['pantry.remove', 'pantry.move_to_grocery', 'grocery.move_to_pantry'].includes(capability) && safeTrim(outcome?.requestedName)) {
        parts.push(`requestedName=${safeTrim(outcome.requestedName)}`);
      }
      if (safeTrim(outcome?.sourceName)) parts.push(`sourceName=${safeTrim(outcome.sourceName)}`);
      if (safeTrim(outcome?.destinationName)) parts.push(`destinationName=${safeTrim(outcome.destinationName)}`);
      if (['grocery.remove', 'grocery.check', 'grocery.uncheck'].includes(capability)) {
        if (safeTrim(outcome?.removedName)) parts.push(`removedName=${safeTrim(outcome.removedName)}`);
        if (safeTrim(outcome?.itemName)) parts.push(`itemName=${safeTrim(outcome.itemName)}`);
        if (safeTrim(outcome?.missingName)) parts.push(`missingName=${safeTrim(outcome.missingName)}`);
      }
      if (capability === 'grocery.clear' && Number.isFinite(Number(outcome?.clearedCount))) {
        parts.push(`clearedCount=${Number(outcome.clearedCount)}`);
      }
      if (outcome?.status === 'ambiguous' && Array.isArray(outcome?.matches) && outcome.matches.length > 0) {
        parts.push(`matches=${outcome.matches.map((match) => safeTrim(match?.name)).filter(Boolean).join('; ')}`);
      }
      if (safeTrim(outcome?.requestedName)) parts.push(`requestedName=${safeTrim(outcome.requestedName)}`);
      if (capability === 'pantry.move_to_grocery' || capability === 'grocery.move_to_pantry') {
        if (safeTrim(outcome?.movedName)) parts.push(`movedName=${safeTrim(outcome.movedName)}`);
        if (safeTrim(outcome?.missingName)) parts.push(`missingName=${safeTrim(outcome.missingName)}`);
      }
      return parts.join('\n');
    })
    .join('\n\n');
}

export function fallbackSkillOutcomeReply(outcomes) {
  const list = Array.isArray(outcomes) ? outcomes.filter(Boolean) : [];
  if (list.length === 0) return 'Okay.';
  if (list.length === 1) {
    const outcome = list[0];
    if ((outcome?.capability || outcome?.narrationType) === 'grocery.preview') {
      const base = fallbackGroceryPreviewReply(outcome?.items || []);
      const question = safeTrim(outcome?.question);
      return question ? `${base}\n\n${question}` : `${base}\n\nIf you want, I can add these items to the Grocery List tab.`;
    }
    if ((outcome?.capability || outcome?.narrationType) === 'grocery.write') {
      return fallbackGroceryWriteReply(outcome);
    }
    if (['grocery.remove', 'grocery.check', 'grocery.uncheck', 'grocery.clear'].includes(outcome?.capability || outcome?.narrationType)) {
      return fallbackGroceryActionReply(outcome);
    }
    if ((outcome?.capability || outcome?.narrationType) === 'memory.save') {
      return fallbackMemoryOutcomeReply(outcome);
    }
    if ((outcome?.capability || outcome?.narrationType) === 'household.defaults.update') {
      return fallbackHouseholdDefaultsUpdateReply(outcome);
    }
    if (['pantry.add', 'pantry.remove', 'pantry.move_to_grocery', 'grocery.move_to_pantry'].includes(outcome?.capability || outcome?.narrationType)) {
      return fallbackPantryReply(outcome);
    }
    if ((outcome?.capability || outcome?.narrationType) === 'meal.refine') {
      if (outcome?.status === 'needs_context') return safeTrim(outcome?.question) || 'What part of the current meal ideas do you want me to change?';
      if (Array.isArray(outcome?.revisedMeals) && outcome.revisedMeals.length > 0) {
        const lead = safeTrim(outcome?.replySummary) || 'Here is a revised version of the current meal set.';
        return `${lead}\n\n${outcome.revisedMeals.map((meal) => `- ${meal}`).join('\n')}`;
      }
      return safeTrim(outcome?.replySummary) || 'I revised the current meal ideas.';
    }
    if ((outcome?.capability || outcome?.narrationType) === 'web.search') {
      return fallbackWebSearchReply(outcome);
    }
    if (String(outcome?.capability || outcome?.narrationType).startsWith('cookbook.')) {
      return fallbackCookbookReply(outcome);
    }
  }
  return list
    .map((outcome) => {
      if ((outcome?.capability || outcome?.narrationType) === 'memory.save') return fallbackMemoryOutcomeReply(outcome);
      if ((outcome?.capability || outcome?.narrationType) === 'grocery.write') return fallbackGroceryWriteReply(outcome);
      if (['grocery.remove', 'grocery.check', 'grocery.uncheck', 'grocery.clear'].includes(outcome?.capability || outcome?.narrationType)) {
        return fallbackGroceryActionReply(outcome);
      }
      if ((outcome?.capability || outcome?.narrationType) === 'household.defaults.update') {
        return fallbackHouseholdDefaultsUpdateReply(outcome);
      }
      if (['pantry.add', 'pantry.remove', 'pantry.move_to_grocery', 'grocery.move_to_pantry'].includes(outcome?.capability || outcome?.narrationType)) {
        return fallbackPantryReply(outcome);
      }
      if ((outcome?.capability || outcome?.narrationType) === 'grocery.preview') {
        const base = fallbackGroceryPreviewReply(outcome?.items || []);
        const question = safeTrim(outcome?.question);
        return question ? `${base}\n\n${question}` : `${base}\n\nIf you want, I can add these items to the Grocery List tab.`;
      }
      if ((outcome?.capability || outcome?.narrationType) === 'meal.refine') {
        if (outcome?.status === 'needs_context') return safeTrim(outcome?.question) || 'What part of the current meal ideas do you want me to change?';
        if (Array.isArray(outcome?.revisedMeals) && outcome.revisedMeals.length > 0) {
          const lead = safeTrim(outcome?.replySummary) || 'Here is a revised version of the current meal set.';
          return `${lead}\n\n${outcome.revisedMeals.map((meal) => `- ${meal}`).join('\n')}`;
        }
        return safeTrim(outcome?.replySummary) || 'I revised the current meal ideas.';
      }
      if ((outcome?.capability || outcome?.narrationType) === 'web.search') {
        return fallbackWebSearchReply(outcome);
      }
      if (String(outcome?.capability || outcome?.narrationType).startsWith('cookbook.')) {
        return fallbackCookbookReply(outcome);
      }
      return 'Okay.';
    })
    .filter(Boolean)
    .join('\n\n');
}

export async function respondWithKbClarify({
  anthropic,
  req,
  res,
  name,
  chatId,
  routePrompt,
  question,
  proposedNextAction = null,
  memoryContext = null,
  workingContext = null,
  deps,
}) {
  const reply = safeTrim(question) || 'Can you clarify what you want me to do?';
  const assistantName = await resolveAssistantName({ req, routePrompt, memoryContext, deps });
  await addMessage(chatId, req.householdId, 'user', name, routePrompt);
  await deps.incrementUserMessageCountForSender?.(req);
  await addMessage(chatId, req.householdId, 'assistant', assistantName, reply);
  const refreshedWorkingContext = await maybeRefreshWorkingContext({
    anthropic,
    req,
    chatId,
    routePrompt,
    memoryContext,
    workingContext,
    outcomes: [],
    deps,
  }).catch(() => normalizeWorkingContext(workingContext) || normalizeWorkingContext(memoryContext?.workingContext));
  await persistKbRuntimeState({
    chatId,
    householdId: req.householdId,
    proposedNextAction,
    workingContext: refreshedWorkingContext,
  });
  await maybeAutoTitleChat({ anthropic, req, chatId, routePrompt, deps }).catch(() => {});
  await streamReplyText({
    res,
    deps,
    chatId,
    householdId: req.householdId,
    turnId: req.kbTurnId || null,
    text: reply,
  });
  deps.broadcastToChat?.(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });
  return;
}

export async function respondWithKbReply({
  anthropic,
  req,
  res,
  name,
  chatId,
  routePrompt,
  replyText,
  replyPlan = null,
  memoryContext = null,
  workingContext = null,
  outcomes = [],
  userMessageAlreadyPersisted = false,
  proposedNextAction = null,
  deps,
}) {
  if (!userMessageAlreadyPersisted) {
    await addMessage(chatId, req.householdId, 'user', name, routePrompt);
    await deps.incrementUserMessageCountForSender?.(req);
  }
  const assistantName = await resolveAssistantName({ req, routePrompt, memoryContext, deps });

  let finalReply = safeTrim(replyText);
  if (!finalReply) {
    finalReply = buildLinkedRecipeFetchFollowUpReply(workingContext || memoryContext?.workingContext, routePrompt);
  }
  if (!finalReply && replyPlan?.kind === 'generate_reply') {
    await deps.emitKbProgress?.({
      chatId,
      householdId: req.householdId,
      turnId: req.kbTurnId || null,
      text: 'Writing reply…',
      phase: 'reply.write',
      senderRes: res,
    });
    finalReply = await generateKbReply({ anthropic, req, res, chatId, routePrompt, memoryContext, deps });
  }
  if (!finalReply && replyPlan?.kind === 'skill_outcomes') {
    await deps.emitKbProgress?.({
      chatId,
      householdId: req.householdId,
      turnId: req.kbTurnId || null,
      text: 'Writing reply…',
      phase: 'reply.write',
      senderRes: res,
    });
    finalReply = await generateSkillOutcomeReply({
      anthropic,
      req,
      chatId,
      routePrompt,
      outcomes: replyPlan?.outcomes || [],
      memoryContext,
      deps,
    });
  }
  finalReply = finalReply || 'Okay.';
  let finalProposedNextAction = proposedNextAction || await deriveImplicitOfferNextAction({
    anthropic,
    req,
    chatId,
    turnId: req.kbTurnId || null,
    routePrompt,
    replyText: finalReply,
    workingContext: workingContext || memoryContext?.workingContext,
    memoryContext,
  });
  finalReply = rewriteUngroundedActionOfferReply(finalReply, finalProposedNextAction);

  await addMessage(chatId, req.householdId, 'assistant', assistantName, finalReply);
  const refreshedWorkingContext = await maybeRefreshWorkingContext({
    anthropic,
    req,
    chatId,
    routePrompt,
    memoryContext,
    workingContext,
    outcomes,
    deps,
  }).catch(() => normalizeWorkingContext(workingContext) || normalizeWorkingContext(memoryContext?.workingContext));
  await persistKbRuntimeState({
    chatId,
    householdId: req.householdId,
    proposedNextAction: finalProposedNextAction,
    workingContext: refreshedWorkingContext,
  });

  await maybeAutoTitleChat({ anthropic, req, chatId, routePrompt, deps }).catch(() => {});
  await streamReplyText({
    res,
    deps,
    chatId,
    householdId: req.householdId,
    turnId: req.kbTurnId || null,
    text: finalReply,
  });
  deps.broadcastToChat?.(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });
  return;
}

async function maybeRefreshWorkingContext({
  anthropic,
  req,
  chatId,
  routePrompt,
  memoryContext,
  workingContext,
  outcomes = [],
  deps,
}) {
  const resolvedWorkingContext =
    normalizeWorkingContext(workingContext) ||
    normalizeWorkingContext(memoryContext?.workingContext);
  return await refreshKbWorkingContext({
    anthropic,
    req,
    chatId,
    routePrompt,
    currentWorkingContext: resolvedWorkingContext,
    memoryContext: {
      ...memoryContext,
      workingContext: resolvedWorkingContext,
      workingContextText: formatWorkingContextText(resolvedWorkingContext),
      appliedWorkingContextText: formatAppliedWorkingContextText(resolvedWorkingContext),
    },
    outcomes,
    deps,
  });
}

async function persistKbRuntimeState({ chatId, householdId, proposedNextAction, workingContext }) {
  const normalizedWorkingContext = normalizeWorkingContext(workingContext);
  const hasProposedNextAction =
    proposedNextAction && typeof proposedNextAction === 'object' && !Array.isArray(proposedNextAction);
  if (!hasProposedNextAction && !normalizedWorkingContext) {
    await clearChatRuntimeState(chatId, householdId).catch(() => {});
    return;
  }
  await setChatRuntimeState(chatId, householdId, {
    mode: 'kb',
    proposedNextAction: hasProposedNextAction ? proposedNextAction : null,
    workingContext: normalizedWorkingContext,
  }).catch(() => {});
}

async function generateKbReply({ anthropic, req, res, chatId, routePrompt, memoryContext, deps }) {
  if (!anthropic) return 'I can help think this through, save a memory, or update the grocery list.';

  const promptText = safeTrim(routePrompt).toLowerCase();
  const requestsRecipeBuild =
    /\b(full recipe|recipe|ingredients|instructions|directions|how (?:do i|to) make|show me)\b/.test(promptText);
  const conversation = await getMessages(chatId, req.householdId);
  const recentConversation = conversation.slice(-20);
  const resolvedMemoryContext =
    memoryContext ||
    (await deps.buildKbContextPacket(req.householdId, routePrompt, {
      limit: 6,
      activeSpeakerName: req.user,
      includeCookbook: promptNeedsCookbookContext(routePrompt),
      capabilities: req.kbCapabilities,
    }));
  if (resolvedMemoryContext?.selectedCookbookEntries?.length > 0 || resolvedMemoryContext?.cookbookText) {
    await deps.emitKbProgress?.({
      chatId,
      householdId: req.householdId,
      turnId: req.kbTurnId || null,
      text: 'Looking through cookbook…',
      phase: 'reply.cookbook_context',
      senderRes: res,
    });
  }
  if (requestsRecipeBuild) {
    await deps.emitKbProgress?.({
      chatId,
      householdId: req.householdId,
      turnId: req.kbTurnId || null,
      text: 'Building the recipe…',
      phase: 'reply.recipe_build',
      senderRes: res,
    });
  }
  const persona = getKbAssistantPersona(resolvedMemoryContext);
  const recentConversationText =
    formatKbRecentConversation(recentConversation, deps, {
      limit: 20,
      assistantLabel: persona.assistantName,
      assistantPersona: resolvedMemoryContext?.assistantPersona,
    }) || '(none)';
  const dominantDish = getDominantWorkingContextDish(resolvedMemoryContext?.workingContext);
  const resolvedRecipeTarget =
    requestsRecipeBuild && dominantDish && promptLooksLikeGenericRecipeFollowUp(routePrompt)
      ? dominantDish
      : '';

  const response = await createLoggedAnthropicMessage(
    anthropic,
    {
      model: resolveAnthropicModelForCallPurpose('chat_reply'),
      max_tokens: 800,
      system: `${buildKbAssistantPersonaSystemText(resolvedMemoryContext)}

Operating rules:
- Reply naturally unless a real server action already happened.
- Never claim you changed memory or the grocery list unless that action actually happened.
- Use relevant household and person memory when it clearly helps.
- Treat the applied memory below as live household context. If it materially changes the answer, adapt the answer to fit it without fanfare.
- Treat the applied working context below as the current chat thread you have been following. Use it for referential follow-ups like "this", "that", or "one of those".
- If the latest user turn narrows an open meal slot to one concrete dish, treat that dish as the dominant target for the next reply. Do not reopen the whole option set unless the user explicitly asks to compare options again.
- After the user narrows to one dish, follow-ups like "show me the recipe", "save it", or "make it spicier" should default to that chosen dish.
- If the latest prompt is a generic recipe follow-up and a dominant dish is already resolved below, answer for that dish directly instead of asking which recipe they mean.
- If the user names a specific target inside the active dish, infer from the conversation whether they mean a self-contained sub-recipe or prep versus the whole dish.
- If the user uses a loose reference like "the fish one", "the handheld one", "the sauce recipe", or "that one", resolve it from the actual recent conversation and working context instead of acting like the thread reset.
- Answer direct sub-recipe asks from the active dish context when that reading is well supported. Do not pivot to cookbook availability, web search, or recipe-saving workflows just because that sub-recipe is not already saved if the active dish context gives you enough to answer helpfully.
- If the named target is too vague or reads more like a loose ingredient/reference than a recipe-worthy component, clarify briefly instead of guessing.
- If the user selects one concrete dish from a previously open slot, accept that as enough to proceed. Do not ask a second round of optional customization questions unless the user explicitly asks to customize or the missing detail is truly required.
- When the user asks to plan a set of meals by slot or vibe, your default job is to give a concrete first draft. Propose one clear leading dish per slot.
- Do not turn each slot into a mini multiple-choice menu or an interview unless the user explicitly asks for options or the request is genuinely impossible to satisfy without another question.
- Treat a planning request as a drafting job, not a brainstorming menu. By the end of the reply, every requested slot should be filled with one concrete dish unless the user explicitly asked for options.
- Avoid slot-level hedging like "maybe", "or", "could be", or lists of competing dishes. If you mention alternatives, keep them secondary and brief. The main answer should still be one concrete dish per requested slot.
- For slot-based meal planning, present the plan like KitchenBot is already drafting the week: one concrete dish headline per slot plus a short explanation of why it fits.
- Treat the app map below as the live structure of the app when the user asks where to find something.
- Treat the Grocery List below as live household app state, just like Pantry.
- If the user asks what is on the grocery list or whether something is already there, answer from that state instead of implying you cannot see it.
- Use the user's local time context when timing, deadlines, or relative-time phrasing matters.
- Do not mention the time unless it materially helps.
- Do not invite a bare yes/no follow-up unless the reply corresponds to a real stored next action or a concrete multiple-choice question.
- If you are offering future help without a stored next action, ask the user to say the action explicitly instead of replying with only "yes".
- If the user asks who you are, what your name is, or what your tone is supposed to be, answer from the configured assistant persona above.
- If the user asks whether you can search the web or why you did not look something up, answer from the household capabilities below.
- Do not mention internal tools, modes, or hidden workflows.

${buildKbContextSystemText(resolvedMemoryContext)}`,
      messages: [
        {
          role: 'user',
          content: `Recent conversation:\n${recentConversationText}\n\nLatest user prompt:\n${routePrompt}\n\nDominant working-context dish:\n${dominantDish || '(none)'}\n\nResolved generic recipe target:\n${resolvedRecipeTarget || '(none)'}\n\nContinuity rule:\n${dominantDish ? `Use "${dominantDish}" as the default target for generic follow-ups unless the latest user turn clearly reopens comparison or ambiguity.` : 'No dominant dish is locked yet; resolve from the recent conversation normally.'}\n\nPlanning contract:\nIf the latest prompt is asking KitchenBot to plan meals by slot, vibe, or course, draft one concrete dish per requested slot now unless the user explicitly asked for options.`,
        },
      ],
    },
    {
      householdId: req.householdId,
      chatId,
      turnId: req.kbTurnId || null,
      prompt: routePrompt,
      runtimeEnabled: true,
      callSurface: 'chat',
      callPurpose: 'chat_reply',
      webSearchEnabledAtCall: false,
      usedWebSearchTool: false,
    }
  );

  const replyText = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
  return maybeRewriteMealPlanningDraft({
    anthropic,
    req,
    chatId,
    turnId: req.kbTurnId || null,
    routePrompt,
    replyText,
    resolvedMemoryContext,
    recentConversationText,
  });
}

async function generateSkillOutcomeReply({ anthropic, req, chatId, routePrompt, outcomes, memoryContext, deps }) {
  const outcomeFacts = buildSkillOutcomeFacts(outcomes);
  if (!outcomeFacts) return fallbackSkillOutcomeReply(outcomes);
  if (shouldForceDeterministicOutcomeReply(outcomes)) return fallbackSkillOutcomeReply(outcomes);
  const outcomeList = Array.isArray(outcomes) ? outcomes : [];
  if (
    outcomeList.length > 0 &&
    outcomeList.every((outcome) => String(outcome?.capability || outcome?.narrationType || '').startsWith('cookbook.'))
  ) {
    return fallbackSkillOutcomeReply(outcomes);
  }
  if (!anthropic) return fallbackSkillOutcomeReply(outcomes);

  const conversation = await getMessages(chatId, req.householdId);
  const recentConversation = conversation.slice(-16);
  const resolvedMemoryContext =
    memoryContext ||
    (await deps.buildKbContextPacket(req.householdId, routePrompt, {
      limit: 6,
      activeSpeakerName: req.user,
      includeCookbook: promptNeedsCookbookContext(routePrompt),
      capabilities: req.kbCapabilities,
    }));
  const persona = getKbAssistantPersona(resolvedMemoryContext);
  const recentConversationText =
    formatKbRecentConversation(recentConversation, deps, {
      limit: 16,
      assistantLabel: persona.assistantName,
      assistantPersona: resolvedMemoryContext?.assistantPersona,
    }) || '(none)';

  try {
    const response = await createLoggedAnthropicMessage(
      anthropic,
      {
        model: resolveAnthropicModelForCallPurpose('chat_reply'),
        max_tokens: 550,
        system: `${buildKbAssistantPersonaSystemText(resolvedMemoryContext)}

You are narrating the real outcomes of one or more already-executed KitchenBot skills.

Rules:
- Sound natural and helpful, not like a database dump.
- Stay faithful to the actual executed outcomes.
- Never claim a mutation happened unless the outcome says it did.
- If the user asked for multiple changes, only mention the ones that are explicitly present in the structured outcomes below.
- Never infer that an unlisted requested action also happened.
- Never say an item was renamed unless the outcomes explicitly show a rename, such as a different sourceName and destinationName or an explicit renamedName field.
- Treat the applied memory below as live household context, not as trivia.
- Treat the applied working context below as the current chat thread you have been following.
- Treat the app map below as the live structure of the app when the user asks where to find something.
- Treat the Grocery List below as live household app state, just like Pantry.
- If the user asks what is on the grocery list or whether something is already there, answer from that state instead of implying you cannot see it.
- Use the user's local time context when timing, deadlines, or relative-time phrasing matters.
- Do not invite a bare yes/no follow-up unless the reply corresponds to a real stored next action or a concrete multiple-choice question.
- If you are offering future help without a stored next action, ask the user to say the action explicitly instead of replying with only "yes".
- If a grocery preview was generated, present it naturally and clearly say it is only a preview unless a real write occurred.
- If a grocery preview includes a proposed next step, offer that additive or explicit replace continuation using Grocery List tab wording only.
- Never talk about an ongoing list, draft list, or internal list state.
- If a grocery write outcome says something was already on the Grocery List tab, say that only because the executor actually checked the live list.
- If memory was saved or updated, confirm it naturally without exposing internal keys.
- If a web search outcome is present, use its findings naturally and never expose raw tool-call syntax.
- It is okay to lightly group or summarize grocery preview items, but keep the contents faithful.
- If a meal.refine outcome is present with revised meals, treat that revised meal set as already chosen. Do not reopen optional planning questions or ask the user to reconfirm the meals unless the outcome explicitly says it still needs context.
- Do not mention internal tools, modes, or hidden workflows.

${buildKbContextSystemText(resolvedMemoryContext)}`,
        messages: [
          {
            role: 'user',
            content: `Recent conversation:\n${recentConversationText}\n\nUser request: ${routePrompt}\n\nStructured skill outcomes:\n${outcomeFacts}`,
          },
        ],
      },
      {
        householdId: req.householdId,
        chatId,
        turnId: req.kbTurnId || null,
        prompt: routePrompt,
        runtimeEnabled: true,
        callSurface: 'chat',
        callPurpose: 'chat_reply',
        webSearchEnabledAtCall: false,
        usedWebSearchTool: false,
      }
    );

    const text = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
    return text || fallbackSkillOutcomeReply(outcomes);
  } catch {
    return fallbackSkillOutcomeReply(outcomes);
  }
}
