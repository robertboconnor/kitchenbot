import { getHouseholdById, getMemories } from './db.mjs';
import { decideChatTurn } from './interaction-engine.mjs';

export async function handleLegacyChatTurn(params) {
  const {
    req,
    res,
    name,
    chatId,
    prompt,
    deps,
  } = params;

  const householdChatSettings = await getHouseholdById(req.householdId);
  if (!householdChatSettings) {
    return res.status(404).json({ reply: 'Household not found.' });
  }

  let anthropic;
  let householdWebSearchEnabled = false;
  try {
    const ac = await deps.getAnthropicClient(req.householdId);
    anthropic = ac.client;
    householdWebSearchEnabled = ac.webSearchEnabled;
  } catch (keyErr) {
    const m = keyErr && String(keyErr.message);
    if (m && m.includes('Household not found')) {
      return res.status(503).json({ reply: 'Household not found.' });
    }
    return res.status(503).json({ reply: deps.ANTHROPIC_KEY_USER_MESSAGE });
  }

  const memories = await getMemories(req.householdId);
  const memoriesByKey = new Map(memories.map((m) => [m.key, m.value]));
  const turn = await decideChatTurn({
    prompt,
    chatId,
    householdId: req.householdId,
    bodyExecutePending: req.body.executePendingAction,
    memoriesByKey,
    smartModeEnabled: false,
    deps: {
      stripStoredMessageContentForDisplay: deps.stripStoredMessageContentForDisplay,
      threadHasConcreteGroceryDraftForFollowUp: deps.threadHasConcreteGroceryDraftForFollowUp,
      detectCommandIntentFromNaturalLanguage: deps.detectCommandIntentFromNaturalLanguage,
      isPrivateChatCommand: deps.isPrivateChatCommand,
      runSmartModeInterpreter: undefined,
    },
  });

  return deps.handleCompatChatTurn({
    req,
    res,
    name,
    chatId,
    prompt,
    turn,
    memories,
    memoriesByKey,
    anthropic,
    householdWebSearchEnabled,
  });
}
