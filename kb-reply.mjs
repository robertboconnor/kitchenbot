import {
  addMessage,
  clearChatRuntimeState,
  getMessages,
  setChatRuntimeState,
  updateChatTitle,
} from './db.mjs';
import { createLoggedAnthropicMessage } from './anthropic-usage.mjs';
import { resolveAnthropicModelForCallPurpose } from './anthropic-model-policy.mjs';
import {
  buildKbAssistantPersonaSystemText,
  buildKbContextSystemText,
  formatKbRecentConversation,
  getKbAssistantPersona,
} from './kb-prompt-context.mjs';
import {
  formatAppliedWorkingContextText,
  formatWorkingContextText,
  normalizeWorkingContext,
  refreshKbWorkingContext,
} from './kb-working-context.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
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

async function resolveAssistantName({ req, routePrompt = '', memoryContext = null, deps }) {
  if (memoryContext) return getAssistantNameFromContext(memoryContext);
  if (!deps?.buildKbContextPacket) return getAssistantNameFromContext(null);
  const resolvedMemoryContext = await deps.buildKbContextPacket(req.householdId, routePrompt, {
    limit: 6,
    activeSpeakerName: req.user,
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
  if (outcome.status === 'needs_mode_choice') {
    return safeTrim(outcome.question) || 'Do you want me to append, replace, or prune the current list?';
  }
  if (outcome.status === 'committed') {
    if (outcome.changed) return 'I updated the Grocery List tab.';
    if (Number(outcome.parsedItemCount || 0) > 0) {
      return "The Grocery List tab already had those items, so there wasn't anything new to update.";
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

function fallbackSkillOutcomeReply(outcomes) {
  const list = Array.isArray(outcomes) ? outcomes.filter(Boolean) : [];
  if (list.length === 0) return 'Okay.';
  if (list.length === 1) {
    const outcome = list[0];
    if ((outcome?.capability || outcome?.narrationType) === 'grocery.preview') {
      const base = fallbackGroceryPreviewReply(outcome?.items || []);
      if (Array.isArray(outcome?.optionModes) && outcome.optionModes.includes('replace')) {
        return `${base}\n\nI can add these items to the Grocery List tab or replace the current Grocery List tab with them.`;
      }
      if (Array.isArray(outcome?.optionModes) && outcome.optionModes.includes('append')) {
        return `${base}\n\nIf you want, I can add these items to the Grocery List tab.`;
      }
      return base;
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
        if (Array.isArray(outcome?.optionModes) && outcome.optionModes.includes('replace')) {
          return `${base}\n\nI can add these items to the Grocery List tab or replace the current Grocery List tab with them.`;
        }
        if (Array.isArray(outcome?.optionModes) && outcome.optionModes.includes('append')) {
          return `${base}\n\nIf you want, I can add these items to the Grocery List tab.`;
        }
        return base;
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
  deps.broadcastToChat?.(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return res.end(reply);
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
  if (!finalReply && replyPlan?.kind === 'generate_reply') {
    finalReply = await generateKbReply({ anthropic, req, chatId, routePrompt, memoryContext, deps });
  }
  if (!finalReply && replyPlan?.kind === 'skill_outcomes') {
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
    proposedNextAction,
    workingContext: refreshedWorkingContext,
  });

  await maybeAutoTitleChat({ anthropic, req, chatId, routePrompt, deps }).catch(() => {});
  deps.broadcastToChat?.(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return res.end(finalReply);
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

async function generateKbReply({ anthropic, req, chatId, routePrompt, memoryContext, deps }) {
  if (!anthropic) return 'I can help think this through, save a memory, or update the grocery list.';

  const conversation = await getMessages(chatId, req.householdId);
  const recentConversation = conversation.slice(-20);
  const resolvedMemoryContext =
    memoryContext ||
    (await deps.buildKbContextPacket(req.householdId, routePrompt, {
      limit: 6,
      activeSpeakerName: req.user,
      capabilities: req.kbCapabilities,
    }));
  const persona = getKbAssistantPersona(resolvedMemoryContext);
  const recentConversationText =
    formatKbRecentConversation(recentConversation, deps, {
      limit: 20,
      assistantLabel: persona.assistantName,
      assistantPersona: resolvedMemoryContext?.assistantPersona,
    }) || '(none)';

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
          content: `Recent conversation:\n${recentConversationText}\n\nLatest user prompt:\n${routePrompt}`,
        },
      ],
    },
    {
      householdId: req.householdId,
      chatId,
      runtimeEnabled: true,
      callSurface: 'chat',
      callPurpose: 'chat_reply',
      webSearchEnabledAtCall: false,
      usedWebSearchTool: false,
    }
  );

  return response.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
}

async function generateSkillOutcomeReply({ anthropic, req, chatId, routePrompt, outcomes, memoryContext, deps }) {
  const outcomeFacts = buildSkillOutcomeFacts(outcomes);
  if (!outcomeFacts) return fallbackSkillOutcomeReply(outcomes);
  if (!anthropic) return fallbackSkillOutcomeReply(outcomes);

  const conversation = await getMessages(chatId, req.householdId);
  const recentConversation = conversation.slice(-16);
  const resolvedMemoryContext =
    memoryContext ||
    (await deps.buildKbContextPacket(req.householdId, routePrompt, {
      limit: 6,
      activeSpeakerName: req.user,
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
- If a grocery preview includes commit options, offer those exact options using Grocery List tab wording only.
- Never talk about an ongoing list, draft list, or internal list state.
- If a grocery write needs a mode choice, ask that question naturally.
- If memory was saved or updated, confirm it naturally without exposing internal keys.
- If a web search outcome is present, use its findings naturally and never expose raw tool-call syntax.
- It is okay to lightly group or summarize grocery preview items, but keep the contents faithful.
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
