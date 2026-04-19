import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

test('executeKbActions emits truthful progress for live web search', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-progress-actions-'));
  const dbPath = path.join(tempDir, 'progress-actions.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { executeKbActions } = await import(new URL('./kb-skills.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Progress');
    const progress = [];
    const anthropic = {
      messages: {
        create: async () => ({
          model: 'claude-sonnet-4-5',
          usage: {
            input_tokens: 10,
            output_tokens: 30,
            server_tool_use: { web_search_requests: 1 },
          },
          content: [
            { type: 'server_tool_use', name: 'web_search', input: { query: 'masters dinner history' } },
            { type: 'web_search_tool_result', tool_use_id: 'toolu_1', content: [] },
            { type: 'text', text: '{"status":"searched","summary":"Found it.","howToUse":"Use it."}' },
          ],
        }),
      },
    };
    await executeKbActions(
      [{ capability: 'web.search', input: { query: 'masters dinner history' } }],
      {
        req: { householdId: created.householdId, kbCapabilities: { webSearchEnabled: true } },
        res: {},
        name: 'Rob',
        chatId,
        turnId: 'turn-progress',
        prompt: 'search the web for masters dinner history',
        anthropic,
        memoryContext: {
          capabilities: { webSearchEnabled: true },
          assistantPersona: { assistantName: 'KitchenBot', assistantTone: 'helpful' },
        },
        workingContext: {},
        deps: {
          addMessage: async () => {},
          incrementUserMessageCountForSender: async () => {},
          broadcastToChat: () => {},
          emitKbProgress: async (payload) => { progress.push(payload); },
          stripStoredMessageContentForDisplay: (text) => text,
        },
        webSearchEnabled: true,
      }
    );
    process.stdout.write(JSON.stringify(progress));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });

  const progress = JSON.parse(stdout.trim());
  assert.equal(Array.isArray(progress), true);
  assert.equal(progress.length > 0, true);
  assert.equal(progress[0].text, 'Searching the web…');
  assert.equal(progress[0].phase, 'web.search');

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('respondWithKbClarify streams reply deltas before chat_updated broadcast', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-progress-reply-'));
  const dbPath = path.join(tempDir, 'progress-reply.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { respondWithKbClarify } = await import(new URL('./kb-reply.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Clarify');
    const broadcasts = [];
    const writes = [];
    const res = {
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      write(chunk) { writes.push(String(chunk)); },
      end(chunk) { if (chunk) writes.push(String(chunk)); },
    };
    await respondWithKbClarify({
      anthropic: null,
      req: { householdId: created.householdId, user: 'Rob', kbTurnId: 'turn-clarify', kbCapabilities: {} },
      res,
      name: 'Rob',
      chatId,
      routePrompt: 'save this',
      question: 'Which recipe did you mean?',
      proposedNextAction: null,
      memoryContext: { assistantPersona: { assistantName: 'KitchenBot', assistantTone: 'helpful' } },
      workingContext: null,
      deps: {
        incrementUserMessageCountForSender: async () => {},
        buildKbContextPacket: async () => ({ assistantPersona: { assistantName: 'KitchenBot', assistantTone: 'helpful' } }),
        broadcastToChat: (chatId, payload) => { broadcasts.push(payload); },
      },
    });
    process.stdout.write(JSON.stringify({ writes, broadcasts }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });

  const parsed = JSON.parse(stdout.trim());
  const streamed = parsed.writes.join('');
  assert.match(streamed, /"type":"delta"/);
  assert.match(streamed, /Which recipe did you mean\?/);
  assert.equal(parsed.broadcasts.length >= 2, true);
  assert.equal(parsed.broadcasts[0].type, 'stream_delta');
  assert.equal(parsed.broadcasts.at(-1).type, 'chat_updated');

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('respondWithKbReply streams progress milestones for slow recipe-generation turns to the sender', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-progress-generate-reply-'));
  const dbPath = path.join(tempDir, 'progress-generate-reply.db');

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
    const chatId = await db.createChat(created.householdId, 'Rob', 'Recipe progress');
    await db.addMessage(created.householdId, chatId, 'user', 'Rob', 'Help me plan a sandwich dinner.');
    await db.addMessage(created.householdId, chatId, 'assistant', 'KitchenBot', 'You could do The Loaded Italian Sub Reimagined.');
    const broadcasts = [];
    const writes = [];
    const res = {
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      write(chunk) { writes.push(String(chunk)); },
      end(chunk) { if (chunk) writes.push(String(chunk)); },
    };
    const anthropic = {
      messages: {
        create: async (payload) => ({
          model: payload.model || 'claude-sonnet-4-5',
          usage: { input_tokens: 20, output_tokens: 80 },
          content: [{ type: 'text', text: 'The Loaded Italian Sub Reimagined\\n\\nIngredients\\nsub roll\\nprovolone\\n\\nInstructions\\nBuild it.' }],
        }),
      },
    };
    await respondWithKbReply({
      anthropic,
      req: {
        householdId: created.householdId,
        user: 'Rob',
        kbTurnId: 'turn-generate-reply',
        kbCapabilities: {},
      },
      res,
      name: 'Rob',
      chatId,
      routePrompt: 'show me the full recipe for loaded italian sub',
      replyText: '',
      replyPlan: { kind: 'generate_reply' },
      memoryContext: {
        assistantPersona: { assistantName: 'KitchenBot', assistantTone: 'helpful' },
        cookbookText: 'Saved cookbook entries: The Loaded Italian Sub Reimagined',
        selectedCookbookEntries: [{ title: 'The Loaded Italian Sub Reimagined' }],
      },
      workingContext: null,
      outcomes: [],
      userMessageAlreadyPersisted: false,
      proposedNextAction: null,
      deps: {
        incrementUserMessageCountForSender: async () => {},
        buildKbContextPacket: async () => ({
          assistantPersona: { assistantName: 'KitchenBot', assistantTone: 'helpful' },
          cookbookText: 'Saved cookbook entries: The Loaded Italian Sub Reimagined',
          selectedCookbookEntries: [{ title: 'The Loaded Italian Sub Reimagined' }],
        }),
        broadcastToChat: (chatId, payload) => { broadcasts.push(payload); },
        emitKbProgress: async (payload) => { writes.push(JSON.stringify({ localProgress: payload.text, phase: payload.phase })); },
      },
    });
    process.stdout.write(JSON.stringify({ writes, broadcasts, headers: res.headers }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });

  const parsed = JSON.parse(stdout.trim());
  const streamed = parsed.writes.join('\n');
  assert.match(streamed, /Looking through cookbook…/);
  assert.match(streamed, /Building the recipe…/);
  assert.match(streamed, /Writing reply…/);
  assert.match(streamed, /"type":"delta"/);
  assert.equal(String(parsed.headers['X-KitchenBot-Stream-Format'] || ''), 'ndjson');

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('respondWithKbReply does not emit cookbook progress for generic meal planning just because cookbook context is present', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-progress-meal-plan-no-cookbook-'));
  const dbPath = path.join(tempDir, 'progress-meal-plan-no-cookbook.db');

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
    const chatId = await db.createChat(created.householdId, 'Rob', 'Meal planning progress');
    const writes = [];
    const res = {
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      write(chunk) { writes.push(String(chunk)); },
      end(chunk) { if (chunk) writes.push(String(chunk)); },
    };
    const anthropic = {
      messages: {
        create: async () => ({
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 20, output_tokens: 80 },
          content: [{ type: 'text', text: 'Here is a concrete three-dinner plan.' }],
        }),
      },
    };
    await respondWithKbReply({
      anthropic,
      req: {
        householdId: created.householdId,
        user: 'Rob',
        kbTurnId: 'turn-meal-plan-reply',
        kbCapabilities: {},
      },
      res,
      name: 'Rob',
      chatId,
      routePrompt: 'Plan three easy meals for Elle this week.',
      replyText: '',
      replyPlan: { kind: 'generate_reply' },
      memoryContext: {
        assistantPersona: { assistantName: 'KitchenBot', assistantTone: 'helpful' },
        cookbookText: 'Saved cookbook entries: White Chicken Chili',
        selectedCookbookEntries: [{ title: 'White Chicken Chili' }],
      },
      groundedTurn: {
        turnMode: 'reply_only',
        surface: 'meal_plan',
        intent: 'revise_meal_plan',
      },
      workingContext: null,
      outcomes: [],
      userMessageAlreadyPersisted: false,
      proposedNextAction: null,
      deps: {
        incrementUserMessageCountForSender: async () => {},
        buildKbContextPacket: async () => ({
          assistantPersona: { assistantName: 'KitchenBot', assistantTone: 'helpful' },
        }),
        broadcastToChat: () => {},
        emitKbProgress: async (payload) => { writes.push(JSON.stringify({ localProgress: payload.text, phase: payload.phase })); },
      },
    });
    process.stdout.write(JSON.stringify({ writes }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });

  const parsed = JSON.parse(stdout.trim());
  const streamed = parsed.writes.join('\n');
  assert.doesNotMatch(streamed, /Looking through cookbook…/);
  assert.match(streamed, /Writing reply…/);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('respondWithKbErrorReply persists Anthropic-style failure text as a real assistant reply', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-anthropic-runtime-error-'));
  const dbPath = path.join(tempDir, 'anthropic-runtime-error.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { respondWithKbErrorReply } = await import(new URL('./kb-reply.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Anthropic failure');
    const writes = [];
    const broadcasts = [];
    const res = {
      headers: {},
      headersSent: false,
      statusCode: 200,
      setHeader(name, value) { this.headers[name] = value; this.headersSent = true; },
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.jsonPayload = payload; this.headersSent = true; return payload; },
      write(chunk) { this.headersSent = true; writes.push(String(chunk)); },
      end(chunk) { if (chunk) writes.push(String(chunk)); this.headersSent = true; },
    };
    const req = {
      householdId: created.householdId,
      user: 'Rob',
      body: {},
    };
    await respondWithKbErrorReply({
      req,
      res,
      name: 'Rob',
      chatId,
      turnId: 'turn-anthropic-error',
      routePrompt: 'Help me plan dinner tonight.',
      replyText: 'There’s a problem with Anthropic right now. Please try again in a bit.',
      memoryContext: {
        assistantPersona: { assistantName: 'KitchenBot', assistantTone: 'helpful' },
      },
      workingContext: null,
      userMessageAlreadyPersisted: false,
      deps: {
        buildKbContextPacket: async () => ({
          assistantPersona: { assistantName: 'KitchenBot', assistantTone: 'helpful' },
        }),
        incrementUserMessageCountForSender: async () => {},
        emitKbProgress: async () => {},
        broadcastToChat: (chatId, payload) => { broadcasts.push(payload); },
      },
    });
    const messages = await db.getMessages(chatId, created.householdId);
    process.stdout.write(JSON.stringify({
      writes,
      broadcasts,
      jsonPayload: res.jsonPayload || null,
      statusCode: res.statusCode,
      messages: messages.map((message) => ({ role: message.role, name: message.name, content: message.content })),
    }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });

  const parsed = JSON.parse(stdout.trim());
  const streamed = parsed.writes.join('');
  assert.equal(parsed.statusCode, 200);
  assert.equal(parsed.jsonPayload, null);
  assert.match(streamed, /"type":"delta"/);
  assert.match(streamed, /There’s a problem with Anthropic right now/);
  assert.equal(parsed.messages.length >= 2, true);
  assert.equal(parsed.messages.at(-1).role, 'assistant');
  assert.match(parsed.messages.at(-1).content, /There’s a problem with Anthropic right now/);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('respondWithKbReply rewrites meal-plan option menus into a concrete first draft', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-progress-plan-rewrite-'));
  const dbPath = path.join(tempDir, 'progress-plan-rewrite.db');

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
    const chatId = await db.createChat(created.householdId, 'Rob', 'Plan rewrite');
    const writes = [];
    const res = {
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      write(chunk) { writes.push(String(chunk)); },
      end(chunk) { if (chunk) writes.push(String(chunk)); },
    };
    let callCount = 0;
    const anthropic = {
      messages: {
        create: async (payload) => {
          callCount += 1;
          if (callCount === 1) {
            return {
              model: payload.model || 'claude-sonnet-4-5',
              usage: { input_tokens: 20, output_tokens: 80 },
              content: [{ type: 'text', text: 'Brothy: maybe noodle soup or bean stew.\\nMessy in bread: meatball subs or pulled chicken.\\nRoasted: roast chicken or salmon.\\nDo any of these directions feel right?' }],
            };
          }
          return {
            model: payload.model || 'claude-sonnet-4-5',
            usage: { input_tokens: 20, output_tokens: 80 },
            content: [{ type: 'text', text: '{"intro":"Here is a strong first pass for the week:","slots":[{"label":"Brothy","dish":"Lemony white bean and sausage soup","why":"warming and bright without getting heavy"},{"label":"Messy in bread","dish":"Meatball subs with mozzarella and roasted peppers","why":"saucy, handheld, and worth the napkins"},{"label":"Roasted","dish":"Herb-roasted chicken with carrots and potatoes","why":"classic and deeply satisfying"}],"closing":"If you want, I can turn this into a grocery list next."}' }],
          };
        },
      },
    };
    await respondWithKbReply({
      anthropic,
      req: {
        householdId: created.householdId,
        user: 'Rob',
        kbTurnId: 'turn-plan-rewrite',
        kbCapabilities: {},
      },
      res,
      name: 'Rob',
      chatId,
      routePrompt: 'help me map out three dinners this week: something brothy, something messy in bread, and something roasted',
      replyText: '',
      replyPlan: { kind: 'generate_reply' },
      memoryContext: {
        assistantPersona: { assistantName: 'KitchenBot', assistantTone: 'helpful' },
      },
      workingContext: null,
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
      },
    });
    process.stdout.write(JSON.stringify({ writes, callCount }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });

  const parsed = JSON.parse(stdout.trim());
  const streamed = parsed.writes.join('');
  assert.equal(parsed.callCount >= 2, true);
  assert.match(streamed, /Lemony white bean and sausage soup/);
  assert.doesNotMatch(streamed, /Do any of these directions feel right/);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('respondWithKbReply rewrites planning follow-up menus that ask the user what sounds good', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-progress-plan-followup-rewrite-'));
  const dbPath = path.join(tempDir, 'progress-plan-followup-rewrite.db');

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
    const chatId = await db.createChat(created.householdId, 'Rob', 'Plan followup rewrite');
    const writes = [];
    const res = {
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      write(chunk) { writes.push(String(chunk)); },
      end(chunk) { if (chunk) writes.push(String(chunk)); },
    };
    let callCount = 0;
    const anthropic = {
      messages: {
        create: async (payload) => {
          callCount += 1;
          if (callCount === 1) {
            return {
              model: payload.model || 'claude-sonnet-4-5',
              usage: { input_tokens: 20, output_tokens: 80 },
              content: [{ type: 'text', text: "Great idea! Here's what I'm thinking:\\n\\n**Soup:** a hearty mushroom & barley soup or maybe creamy tomato soup.\\n\\n**Mushroom Pasta:** mushroom rag\\u00f9 or creamy tagliatelle.\\n\\n**Fish Dish:** pan-seared halibut or baked cod.\\n\\nDo you want me to:\\n- **Narrow down each one**\\n- **Draft the full grocery list**\\n- **Save any of these to your cookbook**\\n\\nWhat sounds good to you?" }],
            };
          }
          return {
            model: payload.model || 'claude-sonnet-4-5',
            usage: { input_tokens: 20, output_tokens: 80 },
            content: [{ type: 'text', text: '{"intro":"Here is a strong first pass for the week:","slots":[{"label":"Soup","dish":"Hearty mushroom and barley soup","why":"deeply savory and cozy without feeling heavy"},{"label":"Mushroom Pasta","dish":"Creamy mushroom tagliatelle with parmesan","why":"rich, cheese-forward, and weeknight-worthy"},{"label":"Fish Dish","dish":"Baked cod with lemon and herbed breadcrumbs","why":"bright and elegant with minimal fuss"}],"closing":"I can build the grocery list whenever you want."}' }],
          };
        },
      },
    };
    await respondWithKbReply({
      anthropic,
      req: {
        householdId: created.householdId,
        user: 'Rob',
        kbTurnId: 'turn-plan-followup-rewrite',
        kbCapabilities: {},
      },
      res,
      name: 'Rob',
      chatId,
      routePrompt: 'help me map out three dinners this week: one soup, one mushroom pasta, and one fish dish',
      replyText: '',
      replyPlan: { kind: 'generate_reply' },
      memoryContext: {
        assistantPersona: { assistantName: 'KitchenBot', assistantTone: 'helpful' },
      },
      workingContext: null,
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
      },
    });
    process.stdout.write(JSON.stringify({ writes, callCount }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });

  const parsed = JSON.parse(stdout.trim());
  const streamed = parsed.writes.join('');
  assert.equal(parsed.callCount >= 2, true);
  assert.match(streamed, /Hearty mushroom and barley soup/);
  assert.doesNotMatch(streamed, /What sounds good to you/);
  assert.doesNotMatch(streamed, /Draft the full grocery list/);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('respondWithKbReply rewrites slot-by-slot planning interviews into a concrete draft', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-progress-plan-interview-rewrite-'));
  const dbPath = path.join(tempDir, 'progress-plan-interview-rewrite.db');

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
    const chatId = await db.createChat(created.householdId, 'Rob', 'Plan interview rewrite');
    const writes = [];
    const res = {
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      write(chunk) { writes.push(String(chunk)); },
      end(chunk) { if (chunk) writes.push(String(chunk)); },
    };
    let callCount = 0;
    const anthropic = {
      messages: {
        create: async (payload) => {
          callCount += 1;
          if (callCount === 1) {
            return {
              model: payload.model || 'claude-sonnet-4-5',
              usage: { input_tokens: 20, output_tokens: 80 },
              content: [{ type: 'text', text: "Great idea!\\n\\n**Soup:** What kind of soup are you leaning toward?\\n\\n**Mushroom Pasta:** Are you thinking creamy, tomatoey, or oil-based?\\n\\n**Fish Dish:** Any particular fish in mind, or do you want to see what's available?\\n\\nOnce you give me a bit more direction, I can build the full plan." }],
            };
          }
          return {
            model: payload.model || 'claude-sonnet-4-5',
            usage: { input_tokens: 20, output_tokens: 80 },
            content: [{ type: 'text', text: '{"intro":"Here is a strong first pass for the week:","slots":[{"label":"Soup","dish":"Tuscan white bean soup with sausage","why":"brothy, filling, and deeply savory"},{"label":"Mushroom Pasta","dish":"Creamy mushroom tagliatelle with thyme and parmesan","why":"rich and elegant without being fussy"},{"label":"Fish Dish","dish":"Pan-seared cod with lemon-herb butter","why":"bright, fast, and weeknight-friendly"}],"closing":"I can turn this into a grocery list whenever you want."}' }],
          };
        },
      },
    };
    await respondWithKbReply({
      anthropic,
      req: {
        householdId: created.householdId,
        user: 'Rob',
        kbTurnId: 'turn-plan-interview-rewrite',
        kbCapabilities: {},
      },
      res,
      name: 'Rob',
      chatId,
      routePrompt: 'help me map out three dinners this week: one soup, one mushroom pasta, and one fish dish',
      replyText: '',
      replyPlan: { kind: 'generate_reply' },
      memoryContext: {
        assistantPersona: { assistantName: 'KitchenBot', assistantTone: 'helpful' },
      },
      workingContext: null,
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
      },
    });
    process.stdout.write(JSON.stringify({ writes, callCount }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });

  const parsed = JSON.parse(stdout.trim());
  const streamed = parsed.writes.join('');
  assert.equal(parsed.callCount >= 2, true);
  assert.match(streamed, /Tuscan white bean soup with sausage/);
  assert.doesNotMatch(streamed, /What kind of soup are you leaning toward/);
  assert.doesNotMatch(streamed, /Once you give me a bit more direction/);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('reply generation guidance prioritizes fresh turns, weak working context, and bounded continuity', async () => {
  const source = await fs.readFile(
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '../kb-reply.mjs'),
    'utf8'
  );
  assert.match(source, /Treat the applied working context below as a weak compression of immediately recent continuity, not as authoritative hidden state/);
  assert.match(source, /Recent visible conversation matters more than background working context when they conflict/);
  assert.match(source, /If the user clearly frames the latest turn as a fresh cooking-help moment, a different night, or a different dish, follow that fresh framing instead of dragging old meal continuity forward/);
  assert.match(source, /If the user says they already made something, finished it earlier, or that this is a new night, treat old meal-planning context as background unless they explicitly refer back to it/);
  assert.match(source, /If the user names a specific target inside the active dish, infer from the conversation whether they mean a self-contained sub-recipe or prep versus the whole dish/);
  assert.match(source, /If the user uses a loose reference like "the fish one", "the handheld one", "the sauce recipe", or "that one"/);
  assert.match(source, /Do not pivot to cookbook availability, web search, or recipe-saving workflows just because that sub-recipe is not already saved/);
  assert.match(source, /If the named target is too vague or reads more like a loose ingredient\/reference than a recipe-worthy component, clarify briefly instead of guessing/);
  assert.match(source, /If the user selects one concrete dish from a previously open slot, accept that as enough to proceed/);
  assert.match(source, /When the user asks to plan a set of meals by slot or vibe, your default job is to give a concrete first draft/);
  assert.match(source, /Do not turn each slot into a mini multiple-choice menu or an interview/);
  assert.match(source, /Treat a planning request as a drafting job, not a brainstorming menu/);
  assert.match(source, /Avoid slot-level hedging like "maybe", "or", "could be", or lists of competing dishes/);
  assert.match(source, /Respect local, turn-scoped overrides of durable preferences when the user clearly states them for one recipe, one night, or one person/);
  assert.match(source, /Fresh-turn rule:/);
  assert.match(source, /Planning contract:/);
  assert.match(source, /Choose one concrete first-pass meal plan from the draft/);
  assert.match(source, /Return ONLY JSON with this shape/);
  assert.doesNotMatch(source, /Dominant working-context dish:/);
  assert.doesNotMatch(source, /Resolved generic recipe target:/);
  assert.doesNotMatch(source, /Continuity rule:/);
  assert.doesNotMatch(source, /aioli\|slaw\|dressing\|marinara/);
});
