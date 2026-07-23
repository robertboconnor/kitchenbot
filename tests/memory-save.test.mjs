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
  assert.equal(parsed.state?.workingContext ?? null, null);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('ONE BRAIN: executeMemorySave appends a person note deterministically, no side-model, brain sets scope', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-memory-append-'));
  const dbPath = path.join(tempDir, 'memory-append.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { executeMemorySave } = await import(new URL('./memory-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({ householdName: 'Home', householdKey: 'home', ownerDisplayName: 'Rob', pin: '1234' });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Memory append');
    await db.saveKbMemory(created.householdId, {
      memoryType: 'person', label: 'Elle', normalizedLabel: 'elle',
      summary: "hates cilantro; doesn't like eggs",
      attributes: { originalKey: 'elle_preferences', notes: [ { text: 'hates cilantro' }, { text: "doesn't like eggs" } ] },
    }, { sourceKind: 'manual' });

    const anthropic = { messages: { create: async () => { anthropic.callCount = (anthropic.callCount||0)+1; return { content: [] }; } } };

    // The brain passes scope + person explicitly (the {value, person} shape that used to silently drop).
    const outcome = await executeMemorySave(
      { capability: 'memory.save', input: { scope: 'person', person: 'Elle', value: 'okay with eggs in carbonara' } },
      { req: { householdId: created.householdId }, name: 'Rob', chatId, prompt: 'note that for Elle',
        anthropic, skipIncrement: true, userMessageAlreadyPersisted: true, runtimeManagedResponse: true, kbModeEnabled: true, deps: {} }
    );

    const rows = await db.listKbMemories(created.householdId);
    process.stdout.write(JSON.stringify({ outcome, rows, callCount: anthropic.callCount||0 }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });

  const parsed = JSON.parse(stdout.trim());
  const elle = parsed.rows.find((row) => row.label === 'Elle');
  assert.equal(parsed.outcome.status, 'updated');
  assert.equal(parsed.outcome.memoryType, 'person');
  // Deterministic append: the new note is added, and prior notes are KEPT (truthful, no reconciliation).
  assert.match(elle.summary, /carbonara/);
  assert.match(elle.summary, /hates cilantro/);
  assert.equal((elle.attributes?.notes || []).length, 3);
  assert.equal(parsed.callCount, 0, 'saving a memory must not consult a side-model');

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('ONE BRAIN: executeMemorySave saves {value, person} without a key (the old silent-drop bug)', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-memory-noKey-'));
  const dbPath = path.join(tempDir, 'memory-noKey.db');
  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { executeMemorySave } = await import(new URL('./memory-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const skills = await import(new URL('./kb-skills.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({ householdName: 'Home', householdKey: 'home', ownerDisplayName: 'Rob', pin: '1234' });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Memory noKey');
    // Route through the real normalizer, as the loop does — {value, person}, NO key.
    const action = skills.normalizeKbSkillAction({ capability: 'memory.save', input: { value: 'has the cilantro-soap gene', person: 'Elle' } }, {});
    const outcome = await executeMemorySave(action, { req: { householdId: created.householdId }, name: 'Rob', chatId, prompt: 'remember', skipIncrement: true, userMessageAlreadyPersisted: true, runtimeManagedResponse: true, kbModeEnabled: true, deps: {} });
    const rows = await db.listKbMemories(created.householdId);
    process.stdout.write(JSON.stringify({ actionInput: action && action.input, status: outcome.status, rows }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.status, 'saved');
  const elle = parsed.rows.find((row) => row.label === 'Elle');
  assert.ok(elle, 'Elle person memory was created from {value, person} with no key');
  assert.match(elle.summary, /cilantro-soap/);

  await fs.rm(tempDir, { recursive: true, force: true });
});
