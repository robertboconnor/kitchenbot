import {
  getChatThreadContext,
  getGroceryItems,
  getMessages,
  setChatRuntimeState,
  upsertChatThreadContext,
  updateChatThreadScene,
} from './db.mjs';

async function safeUpdateThreadScene(chatId, householdId, patch) {
  return updateChatThreadScene(chatId, householdId, patch).catch((e) => {
    console.error('safeUpdateThreadScene failed:', e?.message || e);
  });
}

function buildLegacyGroceryReply(outcome) {
  if (!outcome || typeof outcome !== 'object') return 'I was not able to build a grocery list from our conversation.';
  if (outcome.status === 'needs_mode_choice') return outcome.question;
  if (outcome.status === 'committed') {
    if (outcome.changed) return 'I updated the grocery list. Head over to the Grocery List tab to check it.';
    if (Number(outcome.parsedItemCount || 0) > 0) {
      return "The grocery list already had those items, so there wasn't anything new to update.";
    }
    return 'I was not able to build a grocery list from our conversation.';
  }
  return 'I was not able to build a grocery list from our conversation.';
}

export async function runWeeklyPlanGroceryDraftOfferResponse(params) {
  const {
    req,
    res,
    name,
    chatId,
    prompt,
    memories,
    anthropic,
    deps,
  } = params;

  await deps.incrementUserMessageCountForSender(req);
  await deps.addMessage(chatId, req.householdId, 'user', name, prompt);

  const memoryText = memories.map((m) => `${m.key}: ${m.value}`).join('\n');
  const threadCtx = await getChatThreadContext(chatId, req.householdId);
  const weeklyPlanDraftCompact = deps.formatWeeklyPlanDraftForPrompt(threadCtx.weeklyPlanDraft ?? {});

  let listSection = '';
  try {
    const groceryResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 400,
      system: `You suggest ingredients to buy for a weekly dinner plan. Output ONLY lines in this format (no other text):
section | product | amount
section is one of: produce, meat, dairy, frozen, dry, other

Household memory:
${memoryText || '(none)'}

Weekly dinner plan draft:
${weeklyPlanDraftCompact}`,
      messages: [
        {
          role: 'user',
          content: `User said: ${String(prompt).trim()}\n\nBuild a shopping list for this weekly plan.`,
        },
      ],
    });
    const textBlocks = groceryResponse.content.filter((block) => block.type === 'text');
    const fullText = textBlocks.map((b) => b.text).join('\n');
    const rawLines = fullText.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    const items = [];
    for (const line of rawLines) {
      const parts = line.split('|').map((p) => p.trim());
      if (parts.length < 2) continue;
      const [sectionRaw, nameRaw, amountRaw] = parts;
      const nameTrim = String(nameRaw).trim();
      if (!sectionRaw || !nameTrim) continue;
      items.push({
        section: sectionRaw,
        name: nameTrim,
        amount: amountRaw != null ? String(amountRaw).trim() : '',
      });
    }
    const normalizedItems = deps.normalizeGroceryItemsForPost(items);
    if (normalizedItems.length > 0) {
      const lead = await deps.generateSmartGroceryPreviewLead?.({
        anthropic,
        prompt,
        weeklyPlanDraftCompact,
        itemCount: normalizedItems.length,
      });
      const artifact = deps.formatSmartGroceryPreviewArtifact?.(normalizedItems);
      const followUp =
        (await deps.generateSmartGroceryPreviewCommitReply?.({
          anthropic,
          prompt,
          weeklyPlanDraftCompact,
          itemCount: normalizedItems.length,
        })) || "If you'd like, I can put this into your Grocery List tab next.";
      listSection = [lead, artifact, followUp].filter(Boolean).join('\n\n');
    } else {
      listSection =
        "I wasn’t able to turn your weekly plan into specific ingredient lines in chat this time. The Grocery List tab is still unchanged. If you want, I can still try building the list into the tab from your plan.";
    }
  } catch (e) {
    console.error('Weekly plan grocery draft generation failed:', e?.message || e);
    listSection =
      'I couldn’t generate a draft list in chat right now. The Grocery List tab is unchanged, but I can still try updating it from your weekly plan.';
  }

  const reply = listSection;
  const checkpoint = {
    active: true,
    kind: 'grocery_preview_commit',
    createdAt: Date.now(),
    remainingActions: [{ capability: 'grocery.generate_and_commit', input: {} }],
    priorOutcomes: [],
  };

  await deps.addMessage(
    chatId,
    req.householdId,
    'assistant',
    'KitchenBot',
    reply
  );
  await setChatRuntimeState(chatId, req.householdId, {
    mode: 'smart',
    pending: {},
    checkpoint,
  }).catch(() => {});
  deps.broadcastToChat?.(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return res.end(reply);
}

export async function executeGroceryGenerateAndCommit(runtimeAction, context) {
  const {
    req,
    name,
    chatId,
    prompt,
    memories = [],
    anthropic,
    plannerMode = false,
    skipIncrement = false,
    plannerUserLineAlreadyAdded = false,
    smartModeEnabled = false,
    plannerRememberAck = null,
    plannerWeeklyPatchAck = null,
    runtimeManagedResponse = false,
    deps = {},
  } = context;

  if (!skipIncrement) {
    await deps.incrementUserMessageCountForSender?.(req);
  }

  const requestedGroceryMode = runtimeAction?.input?.mode || null;
  const requestedSource = runtimeAction?.input?.source || null;
  const conversation = await getMessages(chatId, req.householdId);
  const conversationForContext = conversation.filter(
    (m) => m.role !== 'user' || !String(m.content || '').trim().startsWith('!')
  );
  const recentConversation = conversationForContext.length > 40 ? conversationForContext.slice(-40) : conversationForContext;

  const priorCtx = await getChatThreadContext(chatId, req.householdId);
  const priorMealPlanSummary = priorCtx.mealPlanSummary;
  const priorThreadGrocerySummary = priorCtx.threadGrocerySummary;
  const threadHasGroceryContext = priorThreadGrocerySummary.trim().length > 0;
  const existingGroceryItems = await getGroceryItems(req.householdId);

  const memoryText = memories.map((memory) => `${memory.key}: ${memory.value}`).join('\n');
  const weeklyPlanDraftCompact = deps.formatWeeklyPlanDraftForPrompt(priorCtx.weeklyPlanDraft ?? {});
  const disambigPrefix =
    [plannerWeeklyPatchAck, plannerRememberAck]
      .map((x) => (x && String(x).trim()) || '')
      .filter(Boolean)
      .join(' ') || null;

  if (requestedGroceryMode == null && !threadHasGroceryContext && existingGroceryItems.length > 0) {
    const question =
      (await deps.generateSmartGroceryModeChoiceReply?.({
        anthropic,
        prompt,
        weeklyPlanDraftCompact,
        choiceMode: 'replace_or_append',
      })) ||
      "I found items already on your Grocery List tab. I can either replace that list with this week's ingredients or add these on top. Which do you want?";
    let replyForStore = deps.combinePlannerDisambiguationWithRememberAck(disambigPrefix, question);
    replyForStore =
      typeof deps.withSmartPlannerWeeklyPlanArtifact === 'function'
        ? deps.withSmartPlannerWeeklyPlanArtifact(plannerWeeklyPatchAck, priorCtx.weeklyPlanDraft, replyForStore)
        : deps.withPlannerWeeklyPlanVisibleBlock(plannerWeeklyPatchAck, priorCtx.weeklyPlanDraft, replyForStore);
    if (!runtimeManagedResponse && !plannerUserLineAlreadyAdded) {
      await deps.addMessage?.(chatId, req.householdId, 'user', name, prompt);
    }
    if (!runtimeManagedResponse) {
      await deps.addMessage?.(chatId, req.householdId, 'assistant', 'KitchenBot', replyForStore);
      deps.broadcastToChat?.(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });
    }
    const pendingHeader = encodeURIComponent(
      JSON.stringify({
        type: 'grocery_mode_choice',
        options: [
          { command: '!grocerylist', mode: 'replace' },
          { command: '!grocerylist', mode: 'append' },
        ],
      })
    );
    return {
      capability: 'grocery.generate_and_commit',
      status: 'needs_mode_choice',
      question,
      reply: replyForStore,
      pendingHeader,
      options: ['replace', 'append'],
    };
  }

  const claudeMessages = recentConversation.map((message) => ({
    role: message.role,
    content:
      message.role === 'user'
        ? `${message.name}: ${message.content}`
        : deps.stripStoredMessageContentForDisplay(message.content),
  }));

  const groceryResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 400,
    system: `You are a household assistant that generates grocery lists.

Household memory:
${memoryText}

Weekly dinner plan draft for this chat (structured state; use listed meals when choosing ingredients):
${weeklyPlanDraftCompact}

When the user asks for a grocery list, respond ONLY with plain text lines in the format:
section | product | amount

Where:
- section is one of: produce, meat, dairy, frozen, dry, other
- product is a short item name
- amount is a human-readable quantity (like "2 lbs", "3", "1 carton")`,
    messages: [
      ...claudeMessages,
      {
        role: 'user',
        content:
          'Based on the meal planning we have discussed—including the weekly dinner plan draft below when it lists meals—build a complete grocery list using the format "section | product | amount", one item per line. Do not include any commentary, headers, or bullet points—only raw lines in that format.\n\nWeekly dinner plan draft:\n' +
          weeklyPlanDraftCompact,
      },
    ],
  });

  const textBlocks = groceryResponse.content.filter((block) => block.type === 'text');
  const fullText = textBlocks.map((b) => b.text).join('\n');
  const lines = fullText.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  const items = [];
  for (const line of lines) {
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length < 2) continue;
    const [sectionRaw, nameRaw, amountRaw] = parts;
    const nameTrim = String(nameRaw).trim();
    if (!sectionRaw || !nameTrim) continue;
    items.push({
      section: sectionRaw,
      name: nameTrim,
      amount: amountRaw != null ? String(amountRaw).trim() : '',
    });
  }

  const normalizedItems = deps.normalizeGroceryItemsForPost(items);
  const priorKeys = deps.parseThreadGrocerySummaryKeys(priorThreadGrocerySummary);
  const runKeys = new Set(normalizedItems.map((i) => deps.normalizeGroceryNameKey(i.name)).filter(Boolean));
  const likelyRemovedKeys = new Set([...priorKeys].filter((k) => !runKeys.has(k)));
  const likelyAddedKeys = new Set([...runKeys].filter((k) => !priorKeys.has(k)));
  const planChangedLikely =
    priorKeys.size > 0 && runKeys.size > 0 && (likelyRemovedKeys.size > 0 || likelyAddedKeys.size > 0);

  const draftChatOfferCommit = requestedSource === 'draft_chat_offer';
  if (requestedGroceryMode == null && threadHasGroceryContext && planChangedLikely && !draftChatOfferCommit) {
    const question =
      (await deps.generateSmartGroceryModeChoiceReply?.({
        anthropic,
        prompt,
        weeklyPlanDraftCompact,
        choiceMode: 'append_or_prune',
      })) ||
      'I can keep the older Grocery List tab items too, or I can remove the ones that no longer fit this version of the plan. Which do you want?';
    let replyForStore = deps.combinePlannerDisambiguationWithRememberAck(disambigPrefix, question);
    replyForStore =
      typeof deps.withSmartPlannerWeeklyPlanArtifact === 'function'
        ? deps.withSmartPlannerWeeklyPlanArtifact(plannerWeeklyPatchAck, priorCtx.weeklyPlanDraft, replyForStore)
        : deps.withPlannerWeeklyPlanVisibleBlock(plannerWeeklyPatchAck, priorCtx.weeklyPlanDraft, replyForStore);
    if (!runtimeManagedResponse && !plannerUserLineAlreadyAdded) {
      await deps.addMessage?.(chatId, req.householdId, 'user', name, prompt);
    }
    if (!runtimeManagedResponse) {
      await deps.addMessage?.(chatId, req.householdId, 'assistant', 'KitchenBot', replyForStore);
      deps.broadcastToChat?.(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });
    }
    const pendingHeader = encodeURIComponent(
      JSON.stringify({
        type: 'grocery_mode_choice',
        options: [
          { command: '!grocerylist', mode: 'append' },
          { command: '!grocerylist', mode: 'prune' },
        ],
      })
    );
    return {
      capability: 'grocery.generate_and_commit',
      status: 'needs_mode_choice',
      question,
      reply: replyForStore,
      pendingHeader,
      options: ['append', 'prune'],
    };
  }

  const effectiveGroceryMode = requestedGroceryMode || 'append';
  const beforeGroceryCount = existingGroceryItems.length;
  let replaceClearedCount = 0;
  let prunedCount = 0;
  if (effectiveGroceryMode === 'replace') {
    replaceClearedCount = await deps.clearGroceryItems(req.householdId);
  } else if (effectiveGroceryMode === 'prune') {
    try {
      prunedCount = await deps.pruneStaleGroceryItemsForChat(req.householdId, runKeys, chatId, likelyRemovedKeys);
    } catch (e) {
      console.error('Grocery prune failed:', e?.message || e);
    }
  }

  let mergeStats = { insertedCount: 0, updatedCount: 0, backfilledCount: 0, changedCount: 0 };
  if (normalizedItems.length > 0) {
    mergeStats = await deps.mergeGroceryItemsFromAi(req.householdId, normalizedItems, chatId);
  }

  const afterGroceryItems = await getGroceryItems(req.householdId);
  const afterGroceryCount = afterGroceryItems.length;
  const totalDbContentChanges = replaceClearedCount + prunedCount + mergeStats.changedCount;
  const groceryListWasUpdated = totalDbContentChanges > 0;

  const conversationSnippet = recentConversation
    .map((m) =>
      m.role === 'user'
        ? `${m.name}: ${m.content}`
        : deps.stripStoredMessageContentForDisplay(String(m.content ?? ''))
    )
    .join('\n\n');
  const commandOutcomeBlock = groceryListWasUpdated
    ? `Command outcome (this request only — server facts; treat as true):\n- User refreshed the Grocery List tab from this chat.\n- The household grocery list in the app changed this request: ${totalDbContentChanges} total (inserts: ${mergeStats.insertedCount}, amount updates: ${mergeStats.updatedCount}, prune removals: ${prunedCount}, replace-mode rows cleared: ${replaceClearedCount}). Provenance-only backfills (not list content): ${mergeStats.backfilledCount}.\n- Sanity check: grocery row count before ${beforeGroceryCount}, after ${afterGroceryCount}.`
    : `Command outcome (this request only — server facts; treat as true):\n- User refreshed the Grocery List tab from this chat.\n- The household grocery list in the app was not changed by this request (inserts: ${mergeStats.insertedCount}, amount updates: ${mergeStats.updatedCount}, prune removals: ${prunedCount}, replace-mode rows cleared: ${replaceClearedCount}; provenance backfills: ${mergeStats.backfilledCount}). Parsed item lines: ${normalizedItems.length}.\n- Sanity check: grocery row count before ${beforeGroceryCount}, after ${afterGroceryCount}.`;
  const itemsThisRunText =
    normalizedItems.length > 0
      ? normalizedItems.map((i) => `${i.section} | ${i.name} | ${i.amount || ''}`).join('\n')
      : '(none parsed this run)';

  let mealPlanToStore = priorMealPlanSummary;
  let threadGroceryToStore = priorThreadGrocerySummary;
  try {
    const summaryResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 700,
      system: `You maintain one concise, factual meal-plan summary for a single chat thread. Output plain text only (no markdown). At most a few short paragraphs total.

Rules:
- Produce a full replacement summary for the thread (not an open-ended append).
- Cover: planned meals or themes; ingredient choices; substitutions or additions; ingredients the user explicitly rejected or wanted to avoid when clear; unresolved questions if any.
- Ground statements in the prior summary, household memory, recent conversation, and the "Command outcome" block below; do not invent specifics beyond them.`,
      messages: [
        {
          role: 'user',
          content: `${commandOutcomeBlock}\n\nPrevious meal-plan summary for this thread (may be empty):\n${priorMealPlanSummary.trim() || '(none)'}\n\nHousehold memory:\n${memoryText || '(none)'}\n\nRecent conversation:\n${conversationSnippet}\n\nWrite the updated replacement summary for this thread.`,
        },
      ],
    });
    const summaryBlocks = summaryResponse.content.filter((b) => b.type === 'text');
    const newMealPlanSummary = summaryBlocks.map((b) => b.text).join('\n').trim();
    if (newMealPlanSummary) mealPlanToStore = newMealPlanSummary;
  } catch (e) {
    console.error('Meal plan summary update failed:', e?.message || e);
  }

  try {
    const groceryCumulativeResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 900,
      system: `You maintain one cumulative plain-text summary of what this chat thread has decided to buy across Grocery List refreshes. Output plain text only (no markdown). Be concise.`,
      messages: [
        {
          role: 'user',
          content: `${commandOutcomeBlock}\n\nPrevious cumulative thread grocery summary (may be empty):\n${priorThreadGrocerySummary.trim() || '(none)'}\n\nMeal plan context for this thread (may be empty):\n${mealPlanToStore.trim() || '(none)'}\n\nItems from this run (section | product | amount):\n${itemsThisRunText}\n\nHousehold memory (context only):\n${memoryText || '(none)'}\n\nRecent conversation:\n${conversationSnippet}\n\nWrite the full replacement cumulative thread grocery summary for what this thread intends to buy so far.`,
        },
      ],
    });
    const gBlocks = groceryCumulativeResponse.content.filter((b) => b.type === 'text');
    const newThreadGrocery = gBlocks.map((b) => b.text).join('\n').trim();
    if (newThreadGrocery) threadGroceryToStore = newThreadGrocery;
  } catch (e) {
    console.error('Thread grocery summary update failed:', e?.message || e);
  }

  try {
    await upsertChatThreadContext(chatId, req.householdId, {
      mealPlanSummary: mealPlanToStore,
      threadGrocerySummary: threadGroceryToStore,
    });
    if (smartModeEnabled) {
      await safeUpdateThreadScene(chatId, req.householdId, {
        lastAction: 'grocerylist',
        lastGroceryMode: effectiveGroceryMode,
        lastGroceryChanged: groceryListWasUpdated,
        lastGrocerySourceChatId: chatId,
        lastActionAt: Date.now(),
        lastGroceryInsertedCount: mergeStats.insertedCount,
        lastGroceryUpdatedCount: mergeStats.updatedCount,
        lastGroceryPrunedCount: prunedCount,
      });
    }
  } catch (e) {
    console.error('chat thread context upsert failed:', e?.message || e);
  }

  const outcome = {
    capability: 'grocery.generate_and_commit',
    status: 'committed',
    changed: groceryListWasUpdated,
    mode: effectiveGroceryMode,
    parsedItemCount: normalizedItems.length,
    counts: {
      inserted: mergeStats.insertedCount,
      updated: mergeStats.updatedCount,
      pruned: prunedCount,
      replacedCleared: replaceClearedCount,
      backfilled: mergeStats.backfilledCount,
      changedTotal: totalDbContentChanges,
      beforeCount: beforeGroceryCount,
      afterCount: afterGroceryCount,
    },
    plannerGroceryStreamCombineOk: groceryListWasUpdated || normalizedItems.length > 0,
  };

  if (!plannerMode) {
    await deps.addMessage?.(chatId, req.householdId, 'user', name, prompt);
    await deps.addMessage?.(chatId, req.householdId, 'assistant', 'KitchenBot', buildLegacyGroceryReply(outcome));
  }

  try {
    const ctxScene = await getChatThreadContext(chatId, req.householdId);
    const conv = await getMessages(chatId, req.householdId);
    const conversationForContext = conv.filter(
      (m) => m.role !== 'user' || !String(m.content || '').trim().startsWith('!')
    );
    const recentForUpdater = conversationForContext.length > 40 ? conversationForContext.slice(-40) : conversationForContext;
    const trustedSummary = `grocerylist completed mode ${effectiveGroceryMode} inserted ${mergeStats.insertedCount} updated ${mergeStats.updatedCount} pruned ${prunedCount}`;
    if (smartModeEnabled) {
      void deps.runThreadSceneAutoUpdaterAfterNormalChat?.(anthropic, {
        smartModeEnabled: true,
        chatId,
        householdId: req.householdId,
        priorThreadScene: ctxScene.threadScene,
        routePrompt: prompt,
        finalAssistantReply: buildLegacyGroceryReply(outcome),
        threadMealPlanSummary: ctxScene.mealPlanSummary,
        threadGrocerySummary: ctxScene.threadGrocerySummary,
        householdMemoriesCompact: memoryText,
        recentConversationForContext: recentForUpdater,
        trustedActionSummary: trustedSummary,
      });
    }
  } catch (e) {
    console.error('thread scene auto-update (grocery) setup failed:', e?.message || e);
  }

  if (!plannerMode) {
    deps.broadcastToChat?.(chatId, {
      type: 'chat_updated',
      householdId: req.householdId,
      chatId,
      user: name,
    });
  }

  return outcome;
}

export async function runGrocerySharedCommandEffects(params) {
  const {
    req,
    name,
    chatId,
    commandUserTextForPersistence,
    routePrompt,
    executePendingAction,
    memories,
    anthropic,
    plannerMode = false,
    skipIncrement = false,
    plannerUserLineAlreadyAdded = false,
    smartModeEnabled = false,
    plannerRememberAck = null,
    plannerWeeklyPatchAck = null,
    runtimeManagedResponse = false,
    deps = {},
  } = params;

  const runtimeAction = {
    capability: 'grocery.generate_and_commit',
    input: {
      mode: executePendingAction?.command === '!grocerylist' ? executePendingAction.mode : undefined,
      source: executePendingAction?.command === '!grocerylist' ? executePendingAction.source : undefined,
    },
  };
  const outcome = await executeGroceryGenerateAndCommit(runtimeAction, {
    req,
    name,
    chatId,
    prompt: commandUserTextForPersistence,
    routePrompt,
    executePendingAction,
    memories,
    anthropic,
    plannerMode,
    skipIncrement,
    plannerUserLineAlreadyAdded,
    smartModeEnabled,
    plannerRememberAck,
    plannerWeeklyPatchAck,
    runtimeManagedResponse,
    deps,
  });

  if (outcome.status === 'needs_mode_choice') {
    return {
      type: 'disambiguation',
      reply: outcome.reply,
      pendingHeader: outcome.pendingHeader,
      outcome,
    };
  }

  return {
    type: 'done',
    reply: buildLegacyGroceryReply(outcome),
    plannerGroceryStreamCombineOk: outcome.plannerGroceryStreamCombineOk === true,
    outcome,
  };
}
