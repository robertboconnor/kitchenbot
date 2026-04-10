import { renderSmartHelpReply } from './capability-registry.mjs';
import { generateAutoChatTitle } from './chat-title-runtime.mjs';

export async function executeChatRename(runtimeAction, context) {
  const { req, chatId, anthropic, deps = {} } = context;
  if (runtimeAction.input?.mode === 'manual' && runtimeAction.input?.args?.title) {
    const title = String(runtimeAction.input.args.title).trim().slice(0, 200);
    if (!title) {
      return { capability: 'chat.rename', status: 'invalid', error: 'Title cannot be empty.' };
    }
    await deps.updateChatTitleAndLock(chatId, req.householdId, title);
    return { capability: 'chat.rename', status: 'renamed', mode: 'manual', title };
  }

  const conv = await deps.getMessages(chatId, req.householdId);
  const title = await generateAutoChatTitle({
    anthropic,
    householdId: req.householdId,
    chatId,
    smartModeEnabled: true,
    conversation: conv,
    stripStoredMessageContentForDisplay: deps.stripStoredMessageContentForDisplay,
    isAnthropicSdkAuthOrKeyError: deps.isAnthropicSdkAuthOrKeyError,
  });
  await deps.updateChatTitleAndLock(chatId, req.householdId, title);
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
