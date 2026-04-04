function safeTrim(text) {
  return String(text ?? '').trim();
}

function isGenericWeeklyPlanLabel(label) {
  const t = safeTrim(label).toLowerCase().replace(/[’']/g, "'");
  if (!t) return true;
  return (
    t === 'weekly plan' ||
    t === 'week plan' ||
    t === "week's dinners" ||
    t === 'weeks dinners' ||
    t === 'weekly dinners' ||
    t === 'week dinners' ||
    t === 'dinners for the week' ||
    t === 'meals for the week' ||
    t === 'initial weekly plan' ||
    t === 'this week' ||
    t === 'dinners'
  );
}

function isGenericWeeklyPlanNote(notes) {
  const t = safeTrim(notes).toLowerCase().replace(/[’']/g, "'");
  if (!t) return true;
  if (/^(one|two|three|four|five|\d+)\s+dinners?\s+(set|planned)$/.test(t)) return true;
  if (/^swapped\b.*\bfor\b.*$/.test(t)) return true;
  if (/^updated\b.*$/.test(t)) return true;
  if (/^changed\b.*$/.test(t)) return true;
  if (/^initial\b.*$/.test(t)) return true;
  return false;
}

function titleForSection(section) {
  const key = safeTrim(section).toLowerCase();
  if (key === 'produce') return 'Produce';
  if (key === 'meat') return 'Protein';
  if (key === 'dairy') return 'Dairy';
  if (key === 'dry') return 'Pantry';
  if (key === 'frozen') return 'Frozen';
  return 'Other';
}

export function formatSmartWeeklyPlanArtifact(draft) {
  if (!draft || typeof draft !== 'object') return '';
  const label = safeTrim(draft.label);
  const meals = Array.isArray(draft.meals) ? draft.meals.map((m) => safeTrim(m)).filter(Boolean) : [];
  const notes = safeTrim(draft.notes);
  if (meals.length === 0 && !label && !notes) return '';

  const lines = ["This week's plan"];
  if (label && !isGenericWeeklyPlanLabel(label)) {
    lines.push(label);
  }
  lines.push('');
  for (let i = 0; i < meals.length; i += 1) {
    lines.push(`${i + 1}. ${meals[i]}`);
  }
  if (notes && !isGenericWeeklyPlanNote(notes)) {
    if (meals.length > 0) lines.push('');
    lines.push(`Note: ${notes}`);
  }
  return lines.join('\n').trim();
}

export function withSmartPlannerWeeklyPlanArtifact(plannerWeeklyPatchAck, draft, replyText) {
  if (!plannerWeeklyPatchAck) return replyText;
  const artifact = formatSmartWeeklyPlanArtifact(draft);
  if (!artifact) return replyText;
  const base = safeTrim(replyText);
  return base ? `${base}\n\n${artifact}` : artifact;
}

export function formatSmartGroceryPreviewArtifact(items) {
  const normalizedItems = Array.isArray(items)
    ? items
        .map((item) => ({
          section: titleForSection(item?.section),
          name: safeTrim(item?.name),
          amount: safeTrim(item?.amount),
        }))
        .filter((item) => item.name)
    : [];
  if (normalizedItems.length === 0) return '';

  const grouped = new Map();
  for (const item of normalizedItems) {
    if (!grouped.has(item.section)) grouped.set(item.section, []);
    grouped.get(item.section).push(item);
  }

  const lines = ['Shopping list preview'];
  for (const [section, sectionItems] of grouped.entries()) {
    lines.push('');
    lines.push(section);
    for (const item of sectionItems) {
      lines.push(item.amount ? `- ${item.name} (${item.amount})` : `- ${item.name}`);
    }
  }
  return lines.join('\n').trim();
}

async function generateTextWithFallback({ anthropic, system, payload, fallback }) {
  if (!anthropic) return fallback;
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 140,
      system,
      messages: [
        {
          role: 'user',
          content: `Context JSON:\n${JSON.stringify(payload)}`,
        },
      ],
    });
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    return text || fallback;
  } catch (e) {
    console.error('Smart artifact text generation failed:', e?.message || e);
    return fallback;
  }
}

export async function generateSmartGroceryPreviewLead({ anthropic, prompt, weeklyPlanDraftCompact, itemCount }) {
  const fallback =
    "I pulled together a shopping list from the dinners we planned. Here's a preview before I change your Grocery List tab.";
  return generateTextWithFallback({
    anthropic,
    fallback,
    system: `You are KitchenBot writing one short lead-in before a shopping-list preview.

Use first person.
Be warm, natural, and concise.
Do not mention commands, JSON, hidden state, or internal workflow.
Do mention that this is a preview and that the Grocery List tab has not been changed yet.
Do not ask for confirmation in this line.`,
    payload: {
      userMessage: safeTrim(prompt),
      weeklyPlanDraftCompact: safeTrim(weeklyPlanDraftCompact),
      itemCount: Number(itemCount) || 0,
    },
  });
}

export async function generateSmartGroceryPreviewCommitReply({
  anthropic,
  prompt,
  weeklyPlanDraftCompact,
  itemCount,
}) {
  const fallback =
    "If you'd like, I can put this into your Grocery List tab next.";
  return generateTextWithFallback({
    anthropic,
    fallback,
    system: `You are KitchenBot writing one short line after showing a shopping-list preview.

Use first person.
Be warm, natural, and concise.
Do not mention commands, JSON, hidden state, or internal workflow.
Do not sound like a software prompt.
Make it clear that the preview is ready and you can put it into the Grocery List tab next if the user wants.
Do not mention replace/append choices yet.`,
    payload: {
      userMessage: safeTrim(prompt),
      weeklyPlanDraftCompact: safeTrim(weeklyPlanDraftCompact),
      itemCount: Number(itemCount) || 0,
    },
  });
}

export async function generateSmartGroceryModeChoiceReply({
  anthropic,
  prompt,
  weeklyPlanDraftCompact,
  choiceMode,
}) {
  const fallback =
    choiceMode === 'append_or_prune'
      ? "I found ingredients from an earlier version of this plan already on your Grocery List tab. I can keep those older items too, or clean out the ones that no longer fit this version. Which sounds better?"
      : "I found items already on your Grocery List tab. I can start fresh with just this week's ingredients, or keep what's there and add these on top. Which do you want?";
  return generateTextWithFallback({
    anthropic,
    fallback,
    system: `You are KitchenBot writing one short follow-up when the app needs a deterministic choice before updating the Grocery List tab.

Use first person.
Be conversational, concise, and clear.
Do not mention commands, JSON, hidden state, or internal workflow.
Explain the two choices in natural language.
End with a direct question.`,
    payload: {
      userMessage: safeTrim(prompt),
      weeklyPlanDraftCompact: safeTrim(weeklyPlanDraftCompact),
      choiceMode: safeTrim(choiceMode),
    },
  });
}
