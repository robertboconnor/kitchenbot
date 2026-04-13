import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

test('respondWithKbReply persists a bounded memory-save next action for yes-style follow-ups', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-memory-next-action-'));
  const dbPath = path.join(tempDir, 'memory-next-action.db');

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
    const chatId = await db.createChat(created.householdId, 'Rob', 'Memory next action');
    const res = {
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      write() {},
      end() {},
    };
    let callCount = 0;
    const anthropic = {
      messages: {
        create: async () => {
          callCount += 1;
          if (callCount === 1) {
            return {
              model: 'claude-sonnet-4-5',
              usage: { input_tokens: 10, output_tokens: 40 },
              content: [{ type: 'text', text: "The cleanest way to store it is: Elle is okay with roasted peppers in supporting roles, but not when they're the main ingredient. Do you want me to save that for her now?" }],
            };
          }
          return {
            model: 'claude-sonnet-4-5',
            usage: { input_tokens: 10, output_tokens: 30 },
            content: [{ type: 'text', text: JSON.stringify({
              kind: 'choice',
              question: 'Do you want me to save that for Elle now?',
              defaultChoiceId: '1',
              choices: [
                {
                  id: '1',
                  label: 'Save that preference for Elle',
                  key: 'Elle.preferences.artichokes',
                  value: "okay with roasted peppers in supporting roles, but not when they're the main ingredient",
                },
              ],
            }) }],
          };
        },
      },
    };
    await respondWithKbReply({
      anthropic,
      req: {
        householdId: created.householdId,
        user: 'Rob',
        kbTurnId: 'turn-memory-next-action',
        kbCapabilities: {},
      },
      res,
      name: 'Rob',
      chatId,
      routePrompt: 'what is the cleanest way to remember that Elle is fine with roasted peppers in sandwiches but hates them when they are the main thing?',
      replyText: '',
      replyPlan: { kind: 'generate_reply' },
      memoryContext: {
        assistantPersona: { assistantName: 'KitchenBot', assistantTone: 'helpful' },
        selectedMemoryItems: [{ memoryType: 'person', label: 'Elle' }],
      },
      workingContext: null,
      outcomes: [],
      userMessageAlreadyPersisted: false,
      proposedNextAction: null,
      deps: {
        incrementUserMessageCountForSender: async () => {},
        buildKbContextPacket: async () => ({
          assistantPersona: { assistantName: 'KitchenBot', assistantTone: 'helpful' },
          selectedMemoryItems: [{ memoryType: 'person', label: 'Elle' }],
        }),
        broadcastToChat: () => {},
        emitKbProgress: async () => {},
        stripStoredMessageContentForDisplay: (text) => text,
      },
    });
    const state = await db.getChatRuntimeState(chatId, created.householdId);
    process.stdout.write(JSON.stringify({ state, callCount }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });

  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.callCount >= 2, true);
  assert.equal(parsed.state.proposedNextAction?.type, 'choice');
  assert.equal(parsed.state.proposedNextAction?.action?.capability, 'memory.save');
  assert.equal(parsed.state.proposedNextAction?.defaultChoiceId, '1');
  assert.equal(parsed.state.proposedNextAction?.choices?.[0]?.actionInput?.key, 'elle_preferences');

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
