import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('chat.rename uses an exact requested title verbatim', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-chat-rename-exact-'));
  const dbPath = path.join(tempDir, 'chat-rename-exact.db');

  const script = `
    const db = await import(new URL('./db.mjs?chatrename=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { executeChatRename, normalizeChatRenameActionInput } = await import(new URL('./chat-executor.mjs?chatrename=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Rename Test Chat');
    await db.addMessage(chatId, created.householdId, 'user', 'Rob', 'Help me plan cod and asparagus for dinner tonight.');
    await db.addMessage(chatId, created.householdId, 'assistant', 'KitchenBot', 'Here is a cod and asparagus dinner idea.');
    await db.addMessage(chatId, created.householdId, 'user', 'Rob', 'Rename this chat to cod plan');

    const input = normalizeChatRenameActionInput({ request: 'Rename this chat to cod plan' }, { originalPrompt: 'Rename this chat to cod plan' });
    const outcome = await executeChatRename({ input }, {
      req: { householdId: created.householdId },
      chatId,
      prompt: 'Rename this chat to cod plan',
      turnId: 'turn-chat-rename-exact',
      anthropic: null,
    });
    const chat = await db.getChatSummary(chatId, created.householdId);
    process.stdout.write(JSON.stringify({ outcome, title: chat.title }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });

  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.outcome.status, 'renamed');
  assert.equal(parsed.outcome.mode, 'exact');
  assert.equal(parsed.title, 'cod plan');

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('chat.rename regenerates a fresh title from current conversation context', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-chat-rename-refresh-'));
  const dbPath = path.join(tempDir, 'chat-rename-refresh.db');

  const script = `
    const db = await import(new URL('./db.mjs?chatrename=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { executeChatRename, normalizeChatRenameActionInput } = await import(new URL('./chat-executor.mjs?chatrename=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Rename Test Chat');
    await db.addMessage(chatId, created.householdId, 'user', 'Rob', 'Help me plan cod and asparagus for dinner tonight.');
    await db.addMessage(chatId, created.householdId, 'assistant', 'KitchenBot', 'Start with cod, asparagus, lemon, and butter.');
    await db.addMessage(chatId, created.householdId, 'user', 'Rob', 'Rename this chat');

    const anthropic = {
      messages: {
        create: async () => ({
          model: 'claude-haiku-4-5',
          usage: { input_tokens: 10, output_tokens: 10 },
          content: [{ type: 'text', text: 'Cod And Asparagus Plan' }],
        }),
      },
    };

    const input = normalizeChatRenameActionInput({ request: 'Rename this chat' }, { originalPrompt: 'Rename this chat' });
    const outcome = await executeChatRename({ input }, {
      req: { householdId: created.householdId },
      chatId,
      prompt: 'Rename this chat',
      turnId: 'turn-chat-rename-refresh',
      anthropic,
    });
    const chat = await db.getChatSummary(chatId, created.householdId);
    process.stdout.write(JSON.stringify({ outcome, title: chat.title }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });

  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.outcome.status, 'renamed');
  assert.equal(parsed.outcome.mode, 'refresh');
  assert.equal(parsed.title, 'Cod And Asparagus Plan');

  await fs.rm(tempDir, { recursive: true, force: true });
});
