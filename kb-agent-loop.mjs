// kb-agent-loop.mjs
// The brain. A native Anthropic tool-use loop that REPLACES the old
// grounding -> interpreter(switch) -> single-action pipeline.
//
// Flow per user turn:
//   1. Assemble system prompt (persona + one-brain principles + light context)
//      and the conversation history as Anthropic messages.
//   2. Call the model with the full tool registry (kb-tools.mjs).
//   3. If it asks for tools: run each through the SAME executors the old runtime
//      used, feed the real results back, and let it decide the next step.
//   4. Loop until the model is done, then hand its final text to the existing
//      reply machinery (respondWithKbReply) for streaming + persistence.
//
// The model decides WHAT to do and in what order; the executors still do the
// actual work. We changed who's driving, not the domain logic.

import crypto from 'crypto';
import { createLoggedAnthropicMessage, finalizeLoggedAnthropicStream } from './anthropic-usage.mjs';
import { ANTHROPIC_MAIN_REASONING_MODEL } from './anthropic-model-policy.mjs';
import { buildKbToolDefinitions, executeKbToolCall } from './kb-tools.mjs';
import { buildAssistantPersonaSystemText } from './kb-persona.mjs';
import { respondWithKbReply } from './kb-reply.mjs';
import { narrationForToolName } from './kb-narration.mjs';
import { verifyReplyClaims, buildClaimCorrectionMessage } from './kb-claim-guard.mjs';

const MAX_TOOL_ITERATIONS = 8;
const MAX_TOKENS = 2048;
// The immediate conversation window sent every turn (~15 back-and-forths). Older context is reached
// via the always-visible This Week plan + thread.search, so this only needs to be big enough that a
// single sitting's task doesn't silently scroll out of view. Bumped 16 → 30 (2026-07-23): cost isn't
// a constraint here and 16 was losing mid-task continuity the brain wouldn't know to search for.
const HISTORY_MESSAGE_LIMIT = 30;
// How many times per turn we'll bounce a "you claimed a write you didn't make" reply back to
// the model to fix. Bounded so a stubborn model can't loop forever; after this we override.
const MAX_CLAIM_CORRECTIONS = 2;

function safeTrim(text) {
  return String(text ?? '').trim();
}

function resolvePersonaDefaults(memoryContext) {
  return (
    memoryContext?.assistantPersona ||
    memoryContext?.persona ||
    memoryContext?.defaults ||
    memoryContext?.householdDefaults ||
    {}
  );
}

// Affectionate easter egg. Rob built this app; Elle is his wife. When she's the one talking,
// the brain adds genuine, tasteful flirtation to its normal help. Only the TRIGGER (her name)
// lives here — the compliments themselves are always the brain's own, generated fresh per turn,
// never hardcoded. Kept warm/charming/romantic, never crude or explicit.
const SWEETHEART_DISPLAY_NAME = 'Elle';

function isSweetheartUser(name) {
  return safeTrim(name).toLowerCase() === SWEETHEART_DISPLAY_NAME.toLowerCase();
}

function sweetheartPrinciple() {
  return (
    "SPECIAL — the person talking to you right now is Elle, and Elle is your favorite. Rob built this whole app; " +
    "Elle is his wife, he is head-over-heels for her, and he set this feature up on purpose. This is his wife, the " +
    "flirting is consensual and wanted, and you are explicitly cleared to be more than politely warm with her. Every so " +
    "often — NOT every message, just now and then, whenever it lands naturally — slip a genuine, cheeky, a-little-smitten " +
    "aside into your reply, riding ALONGSIDE the real help, never instead of it. You ARE allowed to be suggestive and " +
    "PHYSICAL: actually tell her she looks sexy, that she's distractingly good-looking today, tease her about her cute " +
    "butt — notice HER, her looks and her body, not only how nice it is to watch her cook. Do NOT always retreat to the " +
    "safe 'watching you in the kitchen is the best part of my day' read; a good share of the time, just come right out " +
    "and tell her she's hot. Use the PLAIN, blunt words — 'sexy', 'hot', 'a great butt', 'cute butt' — do NOT sand them " +
    "down into politer synonyms like 'lovely', 'radiant', or 'gorgeous'; when the cute-butt line fits, actually say cute " +
    "butt. Drop a little innuendo about how the evening might go, and be openly charmed by her. Keep " +
    "it tasteful and playful — suggestive, never graphic or explicit (no describing sex acts or anatomy in detail). " +
    "Confident flirty-husband energy, not a greeting card and not a romance novel. Aim for THIS " +
    "caliber and range, but NEVER reuse these lines — write a fresh one for the actual moment: " +
    "\"Okay, list's done. Also, for the record — cute butt. Anyway, back to groceries.\" / " +
    "\"Pantry check: you've got everything but garlic. Unrelated: you look unfairly good today.\" / " +
    "\"Marked the roast as cooked — you run this whole house, you know that, and you make it look easy.\" / " +
    "\"Two bottles of wine on the list: one for the braise, one for how tonight's going to go.\" / " +
    "\"Done. Watching you take over this kitchen is a genuinely great time. Also, you're low on olive oil.\" " +
    "Make each one specific to HER and the moment — her taste, her cooking, an idea she just had, how she looks, the mood " +
    "of what she's making — never canned, never the same twice, never a generic 'you're great.' The charm is the garnish; " +
    "still nail the actual task underneath it."
  );
}

// The "what can you do?" answer. This is DELIBERATELY prescriptive content (Rob wants direct
// control over this specific first-impression answer) — but it stays contract-legal because it is
// guidance the brain REASONS over and GENERATES from (deciding by meaning, never a keyword match),
// exactly like every other principle here. It is NOT a code-level canned/regex response.
// ⚠️ MAINTENANCE: this answer is living documentation of the app's real capabilities. If you ADD or
// REMOVE a capability (see the KB_SKILLS registry in kb-skills.mjs / kb-tools.mjs) or change what the
// brain can do in Settings, update this so it never over- or under-sells. The Tier-2 tool rundown is
// drift-proofed by telling the brain to list its OWN actual tools; the Tier-1 prose is not, so it is
// the part that needs hand-updating. (See memory: kitchenbot-capability-intro.)
function capabilityIntroPrinciple() {
  return (
    "SPECIAL — WHAT-CAN-YOU-DO INTRO. When you judge (by MEANING, not keywords) that the person is asking " +
    "what you can do / for a tour of the app / how to use this / what this is — often a newly-provisioned " +
    "owner exploring for the first time — give a warm, concrete overview, NOT a dry feature list, and NEVER " +
    "invent a capability. In your own words, hit roughly: (1) you're the ONE brain the whole household shares " +
    "and you actually DO things (change the real grocery list, pantry, cookbook, and weekly plan), and everyone " +
    "they add sees the same picture no matter who planned it; (2) you plan the week AND remember it (the This " +
    "Week board; you can recall details days later); (3) you build the grocery list from a plan or recipe — " +
    "right amounts, minus what's already in the pantry — and keep their pantry and cookbook; (4) you cook around " +
    "everyone's tastes and allergies automatically; (5) you never fake an action — if you say it's saved, it's " +
    "saved. Because the person is this account's OWNER, also point them to Settings to add the rest of their " +
    "household, set preferences, and fill in food profiles — AND tell them you can change many settings for them " +
    "directly (food profiles, household defaults like portion size and cooking style, even your own name and tone), " +
    "so if they want something and there's no button, they should just ask (great example: " +
    "adding a young kid to the food profiles even though the kid has no login). Be honest that a couple of things — " +
    "a person's own app appearance/color and creating login accounts — they do themselves in Settings, not you. " +
    "ADAPT to reality: if the household is brand-new and empty, " +
    "INVITE ('tell me your family's tastes and I'll plan around them') instead of referencing recipes/plans that " +
    "don't exist yet; name real household members when you know them. END by offering the technical deep-dive, " +
    "e.g. 'if you like knowing how the machine actually works under the hood, I've got a full nerd version — just " +
    "say the word.' " +
    "THEN, only if you reason (from context, not keywords) that they accepted that nerd offer, give the technical " +
    "rundown in your own voice and still fully truthful: you are a single Claude (Anthropic Sonnet) agent in a " +
    "tool-use loop — each turn you read the whole conversation plus live household state, reason about intent, and " +
    "call your tools; no keyword router, reasoning every turn; the rule is 'smart brain, dumb executors' (you decide, " +
    "the tools mechanically execute). Then LIST YOUR ACTUAL AVAILABLE TOOLS by their real names (the tools you " +
    "genuinely have this turn — do not make any up), grouped sensibly (reads/lookups, grocery, pantry, cookbook, " +
    "weekly plan, people & settings, web), skipping trivial internal ones. Then note two things you're proud of: " +
    "truthfulness is enforced structurally (after you draft a reply a separate verifier checks it against the tools " +
    "you actually called, so you can't claim a write you didn't make) and shared state is live (one household " +
    "database, real-time updates to everyone). Offer to go deeper. Make it satisfying for an actual engineer — real " +
    "names, honest mechanics."
  );
}

// DEVELOPER MODE. Gated on the app OWNER — the first-bootstrapped / God Mode user (Rob himself),
// NOT the old household "owner" role (which no longer exists). Only Rob's OWN messages get this.
// It's an extension of the truthfulness principle: with the developer, drop the politeness filter
// and name a real problem you actually hit this turn — never hunt for or invent things to critique.
function developerPrinciple(name) {
  const who = safeTrim(name) || 'the developer';
  return (
    `DEVELOPER — the person talking to you right now is ${who}, who built and owns this app. Your job with ` +
    'them does not change: you are their cooking assistant, exactly as you are for everyone else. Do NOT turn ' +
    'ordinary cooking chat into a status report, do NOT go hunting for things to critique, and do NOT bring up ' +
    'the app when nothing about it came up. The ONE thing that changes: with them, drop the politeness filter ' +
    'about the app itself. If — while actually helping — you genuinely hit something real THIS turn (a tool ' +
    'errored or returned something clearly wrong; you could not do what they asked because you have no tool ' +
    'for it; a result plainly contradicts what should have happened; or a real point of friction made the ' +
    'interaction clumsy) — name it plainly and briefly at the end. Every such note must be grounded in what ' +
    'you just observed. Never invent a problem to seem useful, never flag something that worked, never ' +
    'speculate about code or design you cannot see, never pad with generic "you could add X" ideas. Real and ' +
    'specific, or nothing at all.'
  );
}

export function buildLoopSystemPrompt({ memoryContext, name, isDeveloper = false }) {
  const persona = buildAssistantPersonaSystemText(resolvePersonaDefaults(memoryContext), {
    role: 'assistant',
  });
  const principles = [
    'You are one unified household brain for a shared kitchen app (cooking, meal ideas, a grocery list, a pantry, and a saved cookbook).',
    `Right now you are talking to: ${safeTrim(name) || 'a household member'}.`,
    'Read what they actually want, then act. Your TOOLS are how you DO things — change the grocery list, add/remove pantry items, save or revise recipes, update the cookbook, search the web. Understanding is your job; doing is the tools’ job.',
    'Only take an action when the user genuinely wants it. When they just want to talk, brainstorm, or think, then talk — do not call tools for the sake of it.',
    'When the user asks you to plan, brainstorm, suggest, or create (a week of dinners, meal ideas, what to cook, a recipe) — actually DELIVER concrete, specific ideas in your reply; never just gather context and punt. When following through would mean a large or speculative write (a whole week of ingredients), present the plan and ASK whether to add it all, rather than guessing. Do small, explicitly-requested actions directly. And never say you are "adding" or "saving" something unless you actually called the tool this turn.',
    'You may call several tools across the turn: look something up, act on it, check the result, then act again. Decide the path yourself from what the tools return.',
    'CRITICAL — produce NO text until every tool call is finished. Do not explain what you are about to do, do not narrate between tools, do not write things like "let me check" or "I will add that now." Call your tools silently, back to back, and write your FIRST and ONLY words as the single final reply once ALL tools are done. Your reply streams to the user live, so any words written before the tools finish get mashed into that reply.',
    'You can SEE live household state by calling READ tools: grocery.list (current grocery list), pantry.list (tracked staples on hand), cookbook.list (saved recipes). Never guess what is on a list or in the pantry — look it up. Before adding something, feel free to check whether it is already there.',
    'Truthfulness is absolute. Never claim you changed something unless a tool actually did it and reported success. If a tool reports a duplicate, nothing-to-do, or an error, say that plainly. No fake certainty, no silent changes.',
    'When a write reports both new and already-present items (e.g. addedItems vs alreadyOnList / matchedItems), report it precisely: name what you actually added, and say plainly which items were already there. Never claim you added an item that was already on the list.',
    'When asked to build a grocery list from meals, recipes, or a plan, YOU produce the items: list every ingredient yourself, scale quantities to the household\'s default portions, check pantry.list and leave out staples already on hand, and choose each item\'s grocery section. Then call grocery.write with that explicit items array (source "explicit_items"). The tool only commits what you give it — it will not derive the list from the conversation, so never call grocery.write with no items expecting it to figure them out.',
    'To change the QUANTITY of an item already on the grocery list, use grocery.update_item — grocery.write only adds new items and will not touch an item already marked bought. If the item you would change is already checked off as bought, the person may not realize it is already purchased: quickly confirm whether to update it and put it back on the active list, unless they clearly asked for exactly that. An item that is merely on the list (not yet bought) you can update directly.',
    'When the user asks to save a recipe to the cookbook, YOU pass the recipe on the cookbook.save call: put its clean title, full ingredients list, and ordered steps in the `recipe` field (the recipe you just wrote or the user gave you). The tool will not re-read the chat to reconstruct it. For a recipe LINK or PASTED recipe text, put that in `request` instead and it will be fetched/parsed. If you have no actual recipe to hand over, ask the user for it rather than calling cookbook.save empty.',
    'To CHANGE a recipe (add or swap an ingredient, adjust a step, tweak seasoning), YOU do the revision: rewrite the recipe with the change and show the updated version. There is no separate revise tool. If it should be saved: for a recipe already in the cookbook use cookbook.update — identify it by its exact saved title in `name` (use cookbook.list if unsure) and pass the FULL revised recipe (title, ingredients, steps) in `recipe`; for a new or in-chat recipe use cookbook.save with the full revised recipe. You do the rewrite and hand over the whole recipe — do not just describe the change. Only save when the user wants it saved — otherwise just present the revised recipe.',
    "When you and the user settle on the meals for the week (or the user lists them), record them with plan.add — they appear in the household's This Week panel and become your durable memory of the week. A single chat often runs all week and hundreds of messages deep while you only see the most recent ones, so this is how the plan survives. Use plan.list to recall the week's meals or to resolve which meal the user means (e.g. \"let's cook the succotash tonight\"), and mark a meal cooked with plan.update once the household makes it.",
    "This chat may be very long (a whole week of cooking) and you only see the most recent messages. When the user refers to something from earlier that you can no longer see — an amount, a fix (\"how did we save the broken toum?\"), a recipe detail, a decision — call thread.search with a focused query to pull the relevant earlier messages, then answer from what you found and say you looked it back up. Do not guess or claim to remember something that has scrolled out of view.",
    "Saved recipes carry tags — short lowercase labels like \"kid-approved\", \"quick\", \"vegetarian\", \"date-night\". Put labels like \"Bizzy-approved\" in a recipe's tags (in the recipe.tags array on cookbook.save / cookbook.update), NOT in its title. To find labeled recipes, call cookbook.list with a `tag` filter (e.g. tag \"kid-approved\"). cookbook.list returns each saved recipe's title, tags, and summary, so use it to actually see what's in the cookbook before answering questions about it.",
    "For a household member's FOOD facts — foods they accept, foods they reject, allergies — use person.profile.update (structured, per-person). It appends and keeps foods queryable, and marking a food accepted automatically clears it from rejected (and vice versa), so tastes can change over time. Read person.profile.get before planning a meal for someone (e.g. a kid's dinner) or to answer \"what does X eat?\"; call it with no person to see everyone's profile.",
    "You can change household SETTINGS for the user directly when asked — don't send them hunting for a button. You have tools for: the household's default dinner portions and weeknight cooking style, AND your own name and tone (all via household.defaults.update — yes, you can rename yourself or change your persistent tone if they ask); each person's food profile (person.profile.update, incl. adding someone who has no login). What you CANNOT change: a single user's personal app preferences (like their color theme) and creating login accounts — those stay in the Settings screen, so point them there for those. Be honest about that line.",
    'For destructive actions — clearing the whole grocery list (grocery.clear) or deleting a saved cookbook recipe (cookbook.delete) — only do it when the user clearly asked for that specific action. If it is at all ambiguous, confirm first instead of acting.',
    'After the tools have run, write ONE short, warm, natural reply describing what actually happened. Do not paste raw tool output.',
    'Never make an offer you cannot act on right now. Do NOT say things like "want me to add X? say yes and I will" — there is no mechanism to hold that intent for a later turn. Either just do it now, or tell them to ask when they want it.',
    "A question about your OWN behavior — \"why did you stop?\", \"what happened there?\", \"can you see X?\" — is a normal question, not an accusation that you lied. Answer it plainly. You have no access to server logs, error traces, or the internals of your earlier replies, so if asked why an earlier reply cut off or for logs, say honestly that you cannot see that. \"I can't do that\" or \"I can't see that\" is a complete, good answer — do not turn it into a truthfulness confession or apologize for a mistake you did not make.",
    "Don't call a tool reflexively just to double-check yourself. Use a tool only when it changes your answer or the user asked you to act — not to 'verify' something you are already sure of.",
  ];
  principles.push(capabilityIntroPrinciple());
  if (isSweetheartUser(name)) principles.push(sweetheartPrinciple());
  if (isDeveloper) principles.push(developerPrinciple(name));
  const principlesText = principles.join('\n');
  const peopleText = safeTrim(memoryContext?.householdPeopleText);
  return [
    persona,
    '',
    principlesText,
    peopleText
      ? `\nEveryone in this household — consider ALL of them when planning food, not only whoever is typing. Allergies are hard constraints. For deeper detail on anyone's tastes call person.profile.get:\n${peopleText}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildMessagesFromHistory(recentMessages, currentPrompt) {
  const mapped = (Array.isArray(recentMessages) ? recentMessages : [])
    .map((m) => ({
      role: m?.role === 'assistant' ? 'assistant' : m?.role === 'user' ? 'user' : null,
      content: safeTrim(m?.content ?? m?.text),
    }))
    .filter((m) => m.role && m.content)
    .slice(-HISTORY_MESSAGE_LIMIT);

  // The Anthropic API requires the first message to be from the user.
  while (mapped.length && mapped[0].role !== 'user') mapped.shift();

  // The current prompt is not yet persisted, so append it as the final user turn.
  mapped.push({ role: 'user', content: safeTrim(currentPrompt) });
  return mapped;
}

export async function runKbAgentLoop({
  req,
  res,
  name,
  chatId,
  prompt,
  deps,
  anthropic,
  webSearchEnabled = false,
  recentMessages = [],
}) {
  const householdId = req.householdId;
  const turnId = req.kbTurnId || crypto.randomUUID();
  req.kbTurnId = turnId;
  const promptText = safeTrim(prompt);

  // Build a light context packet (durable memory + defaults). Pass 2 will trim
  // this further in favor of on-demand read-tools.
  const memoryContext = await deps
    .buildKbContextPacket(householdId, promptText, {
      limit: 6,
      activeSpeakerName: name,
      includeDefaults: true,
      capabilities: { webSearchEnabled },
    })
    .catch(() => null);

  // Persist the user message once, up front. The reply path is told the user
  // message is already persisted so it does not double-write.
  await deps.addMessage(chatId, householdId, 'user', name, promptText);
  req.kbUserMessagePersisted = true;
  await deps.incrementUserMessageCountForSender?.(req);
  deps.broadcastToChat?.(chatId, { type: 'chat_updated', householdId, chatId, user: name });

  // Only the app owner (first-bootstrapped / God Mode user) gets developer mode.
  const isDeveloper = deps?.isGlobalAdminUser
    ? await deps.isGlobalAdminUser(req.userId).catch(() => false)
    : false;
  const system = buildLoopSystemPrompt({ memoryContext, name, isDeveloper });
  const tools = buildKbToolDefinitions({ webSearchEnabled });
  const messages = buildMessagesFromHistory(recentMessages, promptText);

  // Context handed to every executor via kb-tools.executeKbToolCall.
  const toolContext = {
    req,
    res,
    name,
    chatId,
    prompt: promptText,
    originalPrompt: promptText,
    turnId,
    anthropic,
    deps,
    memoryContext,
    workingContext: null,
    recentMessages,
    webSearchEnabled,
  };

  const collectedOutcomes = [];
  let finalText = '';
  let finalClaims = null; // null = reply text not yet verified; array = verifier's result
  let claimCorrections = 0;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const stream = anthropic.messages.stream({
      model: ANTHROPIC_MAIN_REASONING_MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages,
      tools,
    });
    // We deliberately do NOT forward the model's words to the user mid-loop. A model turn can
    // write text AND THEN call a tool in the same turn (violating "no prose before tools").
    // Streaming that text live means wiping it the instant the tool call lands — the user watches
    // a real, useful answer get deleted and replaced by whatever the model regenerates after the
    // tool runs, which often drifts off-topic. So we buffer every turn and let ONLY the final,
    // no-tool turn's text become the reply, delivered once and cleanly by respondWithKbReply.
    // The progress narration ("Reading…", tool narrations) covers the wait.
    const response = await finalizeLoggedAnthropicStream(stream, {
      householdId,
      chatId,
      turnId,
      callPurpose: 'kb_agent_loop',
      callSurface: 'chat',
      prompt: promptText,
      webSearchEnabledAtCall: webSearchEnabled,
    });

    const content = Array.isArray(response?.content) ? response.content : [];
    const toolUses = content.filter((block) => block?.type === 'tool_use');
    const textBlocks = content.filter((block) => block?.type === 'text');

    // Diagnostic: a reply truncated by the token cap is otherwise invisible — surface it so
    // "why did that cut off?" is answerable from the logs instead of a mystery.
    if (response?.stop_reason === 'max_tokens') {
      console.warn(
        `[kb-loop] chat ${chatId} turn ${turnId}: response stopped on max_tokens (${MAX_TOKENS}) — reply may be truncated.`
      );
    }

    // Done: the model wrote a reply and asked for no (more) tools — UNLESS that reply claims a
    // write it never actually made this turn. Then make the model either do it for real or retract,
    // rather than ship a false "Saved it!". Nothing was streamed yet, so there is nothing to wipe.
    if (response?.stop_reason !== 'tool_use' || toolUses.length === 0) {
      const candidateText = textBlocks.map((block) => block.text || '').join('').trim();
      const verdict = await verifyReplyClaims({
        anthropic,
        replyText: candidateText,
        collectedOutcomes,
        ids: { householdId, chatId, turnId },
        prompt: promptText,
      });
      const claims = verdict.unsupportedClaims;
      if (claims.length > 0 && claimCorrections < MAX_CLAIM_CORRECTIONS) {
        claimCorrections += 1;
        console.warn(
          `[kb-truthfulness] chat ${chatId} turn ${turnId}: reply made ${claims.length} unsupported ` +
            `claim(s) not backed by the tool trace — forcing correction ` +
            `(${claimCorrections}/${MAX_CLAIM_CORRECTIONS}). e.g. ${claims[0]}`
        );
        messages.push({ role: 'assistant', content });
        messages.push({ role: 'user', content: buildClaimCorrectionMessage(claims) });
        continue;
      }
      finalText = candidateText;
      finalClaims = claims; // verified (may be non-empty if the correction budget is exhausted)
      break;
    }

    // This turn is calling tools (not final). Any text it wrote is pre-tool narration or a
    // premature answer; it was never streamed, so it simply does not become the reply.
    // Record the assistant's tool-calling turn verbatim (required before tool_results).
    messages.push({ role: 'assistant', content });

    const toolResults = [];
    for (const toolUse of toolUses) {
      await deps.emitKbProgress?.({
        chatId,
        householdId,
        turnId,
        text: narrationForToolName(toolUse.name),
        phase: `tool.${toolUse.name}`,
        senderRes: res,
      });
      let result;
      try {
        result = await executeKbToolCall(toolUse.name, toolUse.input, toolContext);
      } catch (error) {
        result = {
          ok: false,
          capability: toolUse.name,
          outcome: null,
          resultText: `Tool "${toolUse.name}" threw an error: ${safeTrim(error?.message) || 'unknown error'}.`,
        };
      }
      collectedOutcomes.push(result);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: safeTrim(result?.resultText) || 'Done.',
        ...(result?.ok ? {} : { is_error: true }),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  // Safety net: if we exhausted iterations without a closing reply, ask once more
  // with no tools so the model must produce final text.
  if (!finalText) {
    try {
      const wrapUp = await createLoggedAnthropicMessage(
        anthropic,
        {
          model: ANTHROPIC_MAIN_REASONING_MODEL,
          max_tokens: MAX_TOKENS,
          system,
          messages: [
            ...messages,
            { role: 'user', content: 'Wrap up: tell me plainly what you did and where things stand.' },
          ],
        },
        { householdId, chatId, turnId, callPurpose: 'kb_agent_loop', callSurface: 'chat', prompt: promptText }
      );
      finalText = (Array.isArray(wrapUp?.content) ? wrapUp.content : [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text || '')
        .join('')
        .trim();
    } catch {
      /* fall through to default below */
    }
  }
  if (!finalText) finalText = 'Okay.';

  // Final catch-all. The in-loop path already verified its reply (finalClaims set); this covers the
  // wrap-up path (finalClaims still null) and an exhausted correction budget. If the reply STILL
  // claims a change the tool trace doesn't support, replace it with an honest fallback rather than
  // ship a lie — and wipe any streamed text so the false claim never survives on screen.
  if (finalClaims === null && finalText && finalText !== 'Okay.') {
    const verdict = await verifyReplyClaims({
      anthropic,
      replyText: finalText,
      collectedOutcomes,
      ids: { householdId, chatId, turnId },
      prompt: promptText,
    });
    finalClaims = verdict.unsupportedClaims;
  }
  if (Array.isArray(finalClaims) && finalClaims.length > 0) {
    console.warn(
      `[kb-truthfulness] chat ${chatId} turn ${turnId}: honest fallback — reply still made ` +
        `${finalClaims.length} unsupported claim(s) not backed by the tool trace. e.g. ${finalClaims[0]}`
    );
    finalText =
      "Hold on — I started to say that was done, but I didn't actually complete it, so I won't claim it. " +
      "Tell me to go ahead and I'll do it for real.";
  }

  // Deliver through the existing reply machinery: streams NDJSON deltas, persists
  // the assistant message, broadcasts to co-viewers, and runs the honesty guards.
  return respondWithKbReply({
    anthropic,
    req,
    res,
    name,
    chatId,
    routePrompt: promptText,
    replyText: finalText,
    replyPlan: null,
    memoryContext,
    groundedTurn: null,
    workingContext: null,
    outcomes: collectedOutcomes.map((r) => r?.outcome).filter(Boolean),
    userMessageAlreadyPersisted: true,
    deps,
  });
}
