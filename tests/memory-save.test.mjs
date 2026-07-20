import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

test('respondWithKbReply does not persist meal-only working context when there is no bounded next action', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-working-context-persist-'));
  const dbPath = path.join(tempDir, 'working-context-persist.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { respondWithKbReply } = await import(new URL('./kb-reply.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Working context persistence');
    const res = {
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      write() {},
      end() {},
    };

    await respondWithKbReply({
      anthropic: null,
      req: {
        householdId: created.householdId,
        user: 'Rob',
        kbTurnId: 'turn-working-context-persist',
        kbCapabilities: {},
      },
      res,
      name: 'Rob',
      chatId,
      routePrompt: 'We already finished the soup a few nights ago. Remind me what the chicken recipe was.',
      replyText: 'The chicken recipe was the lemon-herb roast chicken.',
      replyPlan: null,
      memoryContext: {
        assistantPersona: { assistantName: 'KitchenBot', assistantTone: 'helpful' },
      },
      workingContext: {
        topicSummary: 'Old dinner plan',
        mealIdeas: ['Smoky bean soup', 'Lemon-herb roast chicken'],
        subjectItems: ['Smoky bean soup', 'Lemon-herb roast chicken'],
        groceryFocus: ['Smoky bean soup', 'Lemon-herb roast chicken'],
      },
      outcomes: [],
      userMessageAlreadyPersisted: false,
      proposedNextAction: null,
      deps: {
        incrementUserMessageCountForSender: async () => {},
        buildKbContextPacket: async () => ({
          assistantPersona: { assistantName: 'KitchenBot', assistantTone: 'helpful' },
        }),
        broadcastToChat: () => {},
        emitKbProgress: async () => {},
        stripStoredMessageContentForDisplay: (text) => text,
      },
    });

    const state = await db.getChatRuntimeState(chatId, created.householdId);
    process.stdout.write(JSON.stringify({ state }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });

  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.state?.proposedNextAction ?? null, null);
  assert.equal(parsed.state?.workingContext ?? null, null);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('executeMemorySave reconciles updated person preferences instead of keeping contradictory old notes', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-memory-reconcile-'));
  const dbPath = path.join(tempDir, 'memory-reconcile.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { executeMemorySave } = await import(new URL('./memory-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Memory reconcile');
    await db.saveKbMemory(created.householdId, {
      memoryType: 'person',
      label: 'Elle',
      normalizedLabel: 'elle',
      summary: "hates cilantro; doesn't like eggs",
      attributes: {
        originalKey: 'elle_preferences',
        notes: [
          { text: 'hates cilantro' },
          { text: "doesn't like eggs" },
        ],
      },
    }, { sourceKind: 'manual' });

    const anthropic = {
      messages: {
        create: async () => ({
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 10, output_tokens: 20 },
          content: [{ type: 'text', text: JSON.stringify({
            label: 'Elle',
            notes: [
              { text: 'hates cilantro' },
              { text: "doesn't like eggs as a standalone or star ingredient; okay in supporting roles like carbonara" },
            ],
          }) }],
        }),
      },
    };

    const outcome = await executeMemorySave(
      { capability: 'memory.save', input: {
        key: 'elle_preferences',
        value: "doesn't like eggs as a standalone or star ingredient; okay in supporting roles like carbonara",
      } },
      {
        req: { householdId: created.householdId },
        name: 'Rob',
        chatId,
        prompt: 'save that nuance for Elle',
        memories: await db.listKbMemories(created.householdId),
        anthropic,
        skipIncrement: true,
        userMessageAlreadyPersisted: true,
        runtimeManagedResponse: true,
        kbModeEnabled: true,
        deps: {},
      }
    );

    const rows = await db.listKbMemories(created.householdId);
    process.stdout.write(JSON.stringify({ outcome, rows }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });

  const parsed = JSON.parse(stdout.trim());
  const elle = parsed.rows.find((row) => row.label === 'Elle');
  assert.equal(parsed.outcome.status, 'updated');
  assert.match(elle.summary, /supporting roles like carbonara/);
  assert.doesNotMatch(elle.summary, /doesn't like eggs; /);
  assert.deepEqual(
    (elle.attributes?.notes || []).map((note) => note.text),
    ['hates cilantro', "doesn't like eggs as a standalone or star ingredient; okay in supporting roles like carbonara"]
  );

  await fs.rm(tempDir, { recursive: true, force: true });
});
