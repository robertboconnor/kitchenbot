// attachments.clear — the brain purges chat photos/files on request ("clear the photos, we don't
// need them"), so image storage doesn't pile up on cheap Render disk. A write (deletes rows).
import { deleteChatAttachments } from './db.mjs';

export async function executeAttachmentsClear(runtimeAction, context) {
  const { req, chatId } = context;
  const input =
    runtimeAction?.input && typeof runtimeAction.input === 'object' && !Array.isArray(runtimeAction.input)
      ? runtimeAction.input
      : {};
  const scope = String(input.scope ?? 'chat').trim().toLowerCase() === 'household' ? 'household' : 'chat';
  const rawKind = String(input.kind ?? 'image').trim().toLowerCase();
  // Default to photos (the storage concern); 'all' clears attached text files too.
  const kind = rawKind === 'text' ? 'text' : rawKind === 'all' ? null : 'image';
  const deleted = await deleteChatAttachments(req.householdId, {
    chatId: scope === 'chat' ? chatId : null,
    kind,
  });
  return {
    capability: 'attachments.clear',
    status: deleted > 0 ? 'cleared' : 'nothing_to_clear',
    scope,
    kind: kind || 'all',
    count: deleted,
  };
}
