import { renderSmartHelpReply } from './capability-registry.mjs';

export async function executeChatRename(runtimeAction, context) {
  const { req, chatId, anthropic, deps = {} } = context;
  if (runtimeAction.input?.mode === 'manual' && runtimeAction.input?.args?.title) {
    const title = String(runtimeAction.input.args.title).trim().slice(0, 200);
    if (!title) {
      return { capability: 'chat.rename', status: 'invalid', error: 'Title cannot be empty.' };
    }
    await deps.updateChatTitle(chatId, req.householdId, title);
    return { capability: 'chat.rename', status: 'renamed', mode: 'manual', title };
  }

  const conv = await deps.getMessages(chatId, req.householdId);
  const forContext = conv.filter((m) => m.role !== 'user' || !String(m.content).trim().startsWith('!'));
  const recent = forContext.length > 20 ? forContext.slice(-20) : forContext;
  const titleMessages = recent.map((m) => ({
    role: m.role,
    content:
      m.role === 'user'
        ? `${m.name}: ${m.content}`
        : deps.stripStoredMessageContentForDisplay(m.content),
  }));
  let title = 'New chat';
  try {
    const titleRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 30,
      system: 'You generate very short chat titles (3–6 words). Respond with ONLY the title, no quotes or punctuation.',
      messages: [
        ...titleMessages,
        { role: 'user', content: 'Suggest a very short title for this chat (3–6 words only).' },
      ],
    });
    const blocks = titleRes.content.filter((b) => b.type === 'text');
    const raw = blocks.map((b) => b.text).join(' ').trim().split('\n')[0].trim();
    title = raw && raw.length > 0 ? raw.slice(0, 80) : 'New chat';
  } catch (e) {
    if (deps.isAnthropicSdkAuthOrKeyError?.(e)) throw e;
    console.error('Title suggestion failed:', e);
  }
  await deps.updateChatTitle(chatId, req.householdId, title);
  return { capability: 'chat.rename', status: 'renamed', mode: 'auto', title };
}

export async function executeHelpShow() {
  return {
    capability: 'help.show',
    status: 'shown',
    sections: ['memory', 'grocery', 'weekly_plan', 'rename'],
    reply: renderSmartHelpReply(),
  };
}
