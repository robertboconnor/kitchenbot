import { createLoggedAnthropicMessage } from './anthropic-usage.mjs';
import { resolveAnthropicModelForCallPurpose } from './anthropic-model-policy.mjs';

function buildTitleMessages(conversation, stripStoredMessageContentForDisplay) {
  const forContext = (Array.isArray(conversation) ? conversation : []).filter(
    (m) => m.role !== 'user' || !String(m.content || '').trim().startsWith('!')
  );
  const recent = forContext.length > 20 ? forContext.slice(-20) : forContext;
  return recent.map((m) => ({
    role: m.role,
    content:
      m.role === 'user'
        ? `${m.name}: ${m.content}`
        : stripStoredMessageContentForDisplay(String(m.content || '')),
  }));
}

export async function generateAutoChatTitle({
  anthropic,
  householdId,
  chatId,
  smartModeEnabled = false,
  conversation,
  stripStoredMessageContentForDisplay,
  isAnthropicSdkAuthOrKeyError,
}) {
  const titleMessages = buildTitleMessages(conversation, stripStoredMessageContentForDisplay);
  let title = 'New chat';
  try {
    const callPurpose = 'chat_title_generation';
    const titleRes = await createLoggedAnthropicMessage(
      anthropic,
      {
        model: resolveAnthropicModelForCallPurpose(callPurpose),
        max_tokens: 30,
        system:
          'You generate very short chat titles (3-6 words) based on the conversation. Respond with ONLY the title text, no quotes or punctuation.',
        messages: [
          ...titleMessages.slice(-10),
          {
            role: 'user',
            content:
              'Based on this conversation, generate a very short, descriptive title for this chat (3-6 words only, no quotes).',
          },
        ],
      },
      {
        householdId,
        chatId,
        smartModeEnabled: !!smartModeEnabled,
        callSurface: 'background',
        callPurpose,
        webSearchEnabledAtCall: false,
        usedWebSearchTool: false,
      }
    );
    const blocks = titleRes.content.filter((b) => b.type === 'text');
    const raw = blocks
      .map((b) => b.text)
      .join(' ')
      .trim()
      .split('\n')[0]
      .trim();
    title = raw && raw.length > 0 ? raw.slice(0, 80) : 'New chat';
  } catch (e) {
    if (typeof isAnthropicSdkAuthOrKeyError === 'function' && isAnthropicSdkAuthOrKeyError(e)) throw e;
    console.error('Title generation failed:', e);
  }
  return title;
}

export async function maybeAutoNameChatOnTurn({
  anthropic,
  householdId,
  chatId,
  smartModeEnabled = false,
  getMessages,
  updateChatTitleAutoIfUnlocked,
  stripStoredMessageContentForDisplay,
  isAnthropicSdkAuthOrKeyError,
  broadcastToChat,
  broadcastUser = 'KitchenBot',
}) {
  if (!anthropic) return { attempted: false, renamed: false };
  const conversation = await getMessages(chatId, householdId);
  const userTurns = conversation.filter((m) => m.role === 'user' && !String(m.content || '').trim().startsWith('!'));
  if (userTurns.length !== 1 && userTurns.length !== 3) {
    return { attempted: false, renamed: false };
  }
  const title = await generateAutoChatTitle({
    anthropic,
    householdId,
    chatId,
    smartModeEnabled,
    conversation,
    stripStoredMessageContentForDisplay,
    isAnthropicSdkAuthOrKeyError,
  });
  const changes = await updateChatTitleAutoIfUnlocked(chatId, householdId, title);
  if (changes > 0 && typeof broadcastToChat === 'function') {
    broadcastToChat(chatId, { type: 'chat_updated', householdId, chatId, user: broadcastUser });
  }
  return { attempted: true, renamed: changes > 0, title };
}
