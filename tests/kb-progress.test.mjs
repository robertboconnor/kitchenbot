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

test('reply generation guidance keeps narrowed dish continuity and standalone component zoom', async () => {
  const source = await fs.readFile(
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '../kb-reply.mjs'),
    'utf8'
  );
  assert.match(source, /If the latest user turn narrows an open meal slot to one concrete dish/);
  assert.match(source, /follow-ups like "show me the recipe", "save it", or "make it spicier" should default to that chosen dish/);
  assert.match(source, /If the latest prompt is a generic recipe follow-up and a dominant dish is already resolved below, answer for that dish directly/);
  assert.match(source, /If the user names a specific target inside the active dish, infer from the conversation whether they mean a self-contained sub-recipe or prep versus the whole dish/);
  assert.match(source, /If the user uses a loose reference like "the fish one", "the handheld one", "the sauce recipe", or "that one"/);
  assert.match(source, /Do not pivot to cookbook availability, web search, or recipe-saving workflows just because that sub-recipe is not already saved/);
  assert.match(source, /If the named target is too vague or reads more like a loose ingredient\/reference than a recipe-worthy component, clarify briefly instead of guessing/);
  assert.match(source, /When the user asks to plan a set of meals by slot or vibe, your default job is to give a concrete first draft/);
  assert.match(source, /Do not turn each slot into a mini multiple-choice menu or an interview/);
  assert.match(source, /Treat a planning request as a drafting job, not a brainstorming menu/);
  assert.match(source, /Avoid slot-level hedging like "maybe", "or", "could be", or lists of competing dishes/);
  assert.match(source, /Dominant working-context dish:/);
  assert.match(source, /Resolved generic recipe target:/);
  assert.match(source, /Continuity rule:/);
  assert.match(source, /Planning contract:/);
  assert.match(source, /Choose one concrete first-pass meal plan from the draft/);
  assert.match(source, /Return ONLY JSON with this shape/);
  assert.match(source, /If a meal\.refine outcome is present with revised meals, treat that revised meal set as already chosen/);
  assert.doesNotMatch(source, /aioli\|slaw\|dressing\|marinara/);
});
