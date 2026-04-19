import { getChatMessages, getChatSummary, setChatTitleLock, updateChatTitle } from './db.mjs';
import {
  generateChatTitle,
  sanitizeExactChatTitle,
} from './chat-title.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

function parseExplicitChatRenameTitle(request = '') {
  const text = safeTrim(request).replace(/[.!?]+$/, '');
  if (!text) return '';
  const patterns = [
    /^(?:please\s+)?rename\s+(?:this|the)\s+chat\s+to\s+(.+)$/i,
    /^(?:please\s+)?retitle\s+(?:this|the)\s+chat\s+to\s+(.+)$/i,
    /^(?:please\s+)?call\s+(?:this|the)\s+chat\s+(.+)$/i,
    /^(?:please\s+)?name\s+(?:this|the)\s+chat\s+(.+)$/i,
    /^(?:please\s+)?title\s+(?:this|the)\s+chat\s+(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return sanitizeExactChatTitle(match[1]);
  }
  return '';
}

export function normalizeChatRenameActionInput(input, context = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const request = safeTrim(raw.request || raw.payload || raw.text || context.originalPrompt);
  if (!request) return null;
  const exactTitle = parseExplicitChatRenameTitle(request);
  if (exactTitle) return { mode: 'exact', title: exactTitle, request };
  return { mode: 'refresh', request };
}

function buildChatRenameReply(outcome) {
  if (!outcome || typeof outcome !== 'object') return 'I could not rename this chat.';
  if (outcome.status === 'invalid') return safeTrim(outcome.error) || 'I could not rename this chat.';
  if (outcome.status === 'unchanged') {
    return outcome.mode === 'exact'
      ? `This chat is already named ${outcome.title}.`
      : `This chat already had the freshest title I could come up with: ${outcome.title}.`;
  }
  if (outcome.status === 'renamed') {
    return outcome.mode === 'exact'
      ? `I renamed this chat to ${outcome.title}.`
      : `I renamed this chat to ${outcome.title}.`;
  }
  return 'I could not rename this chat.';
}

export async function executeChatRename(runtimeAction, context) {
  const { req, chatId, prompt, turnId, anthropic } = context;
  const input = runtimeAction?.input && typeof runtimeAction.input === 'object' && !Array.isArray(runtimeAction.input)
    ? runtimeAction.input
    : {};
  const mode = safeTrim(input.mode).toLowerCase() === 'exact' ? 'exact' : 'refresh';

  const currentChat = await getChatSummary(chatId, req.householdId);
  const currentTitle = safeTrim(currentChat?.title);

  let nextTitle = '';
  if (mode === 'exact') {
    nextTitle = sanitizeExactChatTitle(input.title);
  } else {
    const messages = await getChatMessages(chatId, req.householdId).catch(() => []);
    nextTitle = await generateChatTitle({
      anthropic,
      req,
      chatId,
      turnId,
      prompt,
      messages,
      includePromptInTitleContext: false,
    });
  }

  if (!nextTitle) {
    const outcome = {
      capability: 'chat.rename',
      status: 'invalid',
      mode,
      error: mode === 'exact' ? 'I need the new chat title.' : 'I could not find enough context to rename this chat cleanly.',
    };
    outcome.reply = buildChatRenameReply(outcome);
    return outcome;
  }

  if (currentTitle && currentTitle === nextTitle) {
    await setChatTitleLock(chatId, req.householdId, true);
    const outcome = {
      capability: 'chat.rename',
      status: 'unchanged',
      mode,
      title: nextTitle,
      previousTitle: currentTitle,
    };
    outcome.reply = buildChatRenameReply(outcome);
    return outcome;
  }

  await updateChatTitle(chatId, req.householdId, nextTitle);
  await setChatTitleLock(chatId, req.householdId, true);
  const outcome = {
    capability: 'chat.rename',
    status: 'renamed',
    mode,
    title: nextTitle,
    previousTitle: currentTitle,
  };
  outcome.reply = buildChatRenameReply(outcome);
  return outcome;
}
