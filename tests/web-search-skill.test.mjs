import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withTempDb } from '../test-support/db-helpers.mjs';

const execFileAsync = promisify(execFile);

test('web.search is only exposed to the interpreter when household web search is enabled', async () => {
  await withTempDb('web-search-skill-shape', async ({ importFresh }) => {
    const {
      buildKbInterpreterActionExamples,
      buildKbInterpreterSkillList,
      normalizeKbSkillAction,
    } = await importFresh('../kb-skills.mjs', 'web-search-skill-shape');

    assert.equal(buildKbInterpreterSkillList({ webSearchEnabled: false }).includes('web.search:'), false);
    assert.equal(buildKbInterpreterActionExamples({ webSearchEnabled: false }).includes('"web.search"'), false);
    assert.equal(buildKbInterpreterSkillList({ webSearchEnabled: true }).includes('web.search:'), true);
    assert.equal(buildKbInterpreterActionExamples({ webSearchEnabled: true }).includes('"web.search"'), true);
    assert.equal(
      normalizeKbSkillAction(
        { capability: 'web.search', input: { query: 'Masters Champions Dinner traditions' } },
        { webSearchEnabled: false }
      ),
      null
    );
    assert.deepEqual(
      normalizeKbSkillAction(
        { capability: 'web.search', input: { query: 'Masters Champions Dinner traditions' } },
        { webSearchEnabled: true }
      ),
      { capability: 'web.search', input: { query: 'Masters Champions Dinner traditions' } }
    );
  });
});

test('detectAnthropicWebSearchUsage recognizes server-side web search blocks', async () => {
  await withTempDb('detect-web-search-usage', async ({ importFresh }) => {
    const { detectAnthropicWebSearchUsage } = await importFresh('../anthropic-usage.mjs', 'detect-web-search-usage');
    const response = {
      usage: {
        server_tool_use: {
          web_search_requests: 1,
        },
      },
      content: [
        { type: 'server_tool_use', name: 'web_search', input: { query: 'test query' } },
      ],
    };
    assert.equal(detectAnthropicWebSearchUsage(response), true);
  });
});

test('detectAnthropicWebFetchUsage recognizes server-side web fetch blocks', async () => {
  await withTempDb('detect-web-fetch-usage', async ({ importFresh }) => {
    const { detectAnthropicWebFetchUsage } = await importFresh('../anthropic-usage.mjs', 'detect-web-fetch-usage');
    const response = {
      content: [
        { type: 'server_tool_use', name: 'web_fetch', input: { url: 'https://example.com/recipe' } },
        { type: 'web_fetch_tool_result', tool_use_id: 'toolu_1', content: [{ type: 'web_fetch_result', url: 'https://example.com/recipe' }] },
      ],
    };
    assert.equal(detectAnthropicWebFetchUsage(response), true);
  });
});

test('recordAnthropicUsageFromResponse marks usedWebSearchTool when Anthropic response used search', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-web-search-ledger-'));
  const dbPath = path.join(tempDir, 'usage.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const usage = await import(new URL('./anthropic-usage.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Search chat');
    const response = {
      model: 'claude-sonnet-4-5',
      usage: {
        input_tokens: 11,
        output_tokens: 22,
        server_tool_use: { web_search_requests: 1 },
      },
      content: [
        { type: 'server_tool_use', name: 'web_search', input: { query: 'Masters Champions Dinner traditions' } },
        {
          type: 'web_search_tool_result',
          tool_use_id: 'toolu_1',
          content: [{ type: 'web_search_result', title: 'Masters Champions Dinner history', url: 'https://example.com/masters-dinner', encrypted_content: 'abc' }],
        },
      ],
    };
    await usage.recordAnthropicUsageFromResponse(response, {
      householdId: created.householdId,
      chatId,
      runtimeEnabled: true,
      callSurface: 'kb_action',
      callPurpose: 'web_search',
      webSearchEnabledAtCall: true,
    });
    const rows = await db.getAnthropicUsageLedgerAllRows({ householdId: created.householdId });
    process.stdout.write(JSON.stringify(rows[0]));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const row = JSON.parse(stdout.trim());
  assert.equal(Number(row.web_search_enabled_at_call ?? row.webSearchEnabledAtCall), 1);
  assert.equal(Number(row.used_web_search_tool ?? row.usedWebSearchTool), 1);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('recordAnthropicUsageFromResponse stores turn and prompt attribution fields', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-web-search-attribution-'));
  const dbPath = path.join(tempDir, 'usage.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const usage = await import(new URL('./anthropic-usage.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Search chat');
    const response = {
      model: 'claude-sonnet-4-5',
      usage: {
        input_tokens: 10,
        output_tokens: 30,
        server_tool_use: { web_search_requests: 1 },
      },
      content: [
        { type: 'server_tool_use', name: 'web_search', input: { query: 'masters dinner history' } },
        { type: 'web_search_tool_result', tool_use_id: 'toolu_1', content: [] },
      ],
    };
    await usage.recordAnthropicUsageFromResponse(response, {
      householdId: created.householdId,
      chatId,
      turnId: 'turn-123',
      prompt: 'search the web for masters dinner history',
      actionCapability: 'web.search',
      actionQuery: 'masters dinner history',
      runtimeEnabled: true,
      callSurface: 'kb_action',
      callPurpose: 'web_search',
      webSearchEnabledAtCall: true,
    });
    const rows = await db.getAnthropicUsageLedgerAllRows({ householdId: created.householdId });
    process.stdout.write(JSON.stringify(rows[0]));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const row = JSON.parse(stdout.trim());
  assert.equal(row.turn_id, 'turn-123');
  assert.equal(row.action_capability, 'web.search');
  assert.equal(row.action_query, 'masters dinner history');
  assert.match(String(row.prompt_hash || ''), /^[a-f0-9]{64}$/);
  assert.equal(row.prompt_excerpt, 'search the web for masters dinner history');

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('recordAnthropicUsageFromResponse normalizes placeholder models and zero chat ids', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-usage-ledger-normalization-'));
  const dbPath = path.join(tempDir, 'usage.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const usage = await import(new URL('./anthropic-usage.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const response = {
      model: 'x',
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
      content: [],
    };
    await usage.recordAnthropicUsageFromResponse(response, {
      householdId: created.householdId,
      chatId: 0,
      runtimeEnabled: true,
      callSurface: 'chat',
      callPurpose: 'kb_turn_grounding_final',
      webSearchEnabledAtCall: false,
    });
    const rows = await db.getAnthropicUsageLedgerAllRows({ householdId: created.householdId });
    process.stdout.write(JSON.stringify(rows[0]));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const row = JSON.parse(stdout.trim());
  assert.equal(row.chat_id == null && row.chatId == null, true);
  assert.equal(row.model, 'claude-haiku-4-5-20251001');

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('executeWebSearch returns structured searched results with query and sources', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-web-search-exec-'));
  const dbPath = path.join(tempDir, 'exec.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { executeWebSearch } = await import(new URL('./web-search-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Search chat');
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
            { type: 'server_tool_use', name: 'web_search', input: { query: 'Masters Champions Dinner traditions' } },
            {
              type: 'web_search_tool_result',
              tool_use_id: 'toolu_1',
              content: [{ type: 'web_search_result', title: 'Masters Champions Dinner history', url: 'https://example.com/masters-dinner', encrypted_content: 'abc' }],
            },
            {
              type: 'text',
              text: '{"status":"searched","summary":"The Masters Champions Dinner is an annual tradition with menus chosen by the defending champion.","howToUse":"Use a Southern or champion-picked dinner as the themed meal."}',
            },
          ],
        }),
      },
    };
    const outcome = await executeWebSearch(
      { capability: 'web.search', input: { query: 'Masters Champions Dinner traditions' } },
      {
        req: { householdId: created.householdId, kbCapabilities: { webSearchEnabled: true } },
        chatId,
        prompt: 'Help me plan a Masters-themed dinner',
        anthropic,
        memoryContext: { capabilities: { webSearchEnabled: true }, assistantPersona: { assistantName: 'KitchenBot', assistantTone: 'helpful' } },
        deps: { stripStoredMessageContentForDisplay: (text) => text },
      }
    );
    process.stdout.write(JSON.stringify(outcome));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });
  const outcome = JSON.parse(stdout.trim());
  assert.equal(outcome.capability, 'web.search');
  assert.equal(outcome.status, 'searched');
  assert.equal(outcome.query, 'Masters Champions Dinner traditions');
  assert.match(outcome.summary, /annual tradition/i);
  assert.equal(outcome.sources.length, 1);
  assert.equal(outcome.sources[0].title, 'Masters Champions Dinner history');

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('executeWebSearch does not force invalid tool_choice for web_search', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-web-search-request-'));
  const dbPath = path.join(tempDir, 'request.db');

  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const { executeWebSearch } = await import(new URL('./web-search-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Search request');
    let capturedBody = null;
    const anthropic = {
      messages: {
        create: async (body) => {
          capturedBody = body;
          return {
            model: 'claude-sonnet-4-5',
            usage: {
              input_tokens: 10,
              output_tokens: 30,
              server_tool_use: { web_search_requests: 1 },
            },
            content: [
              { type: 'server_tool_use', name: 'web_search', input: { query: 'Masters Champions Dinner traditions' } },
              {
                type: 'web_search_tool_result',
                tool_use_id: 'toolu_1',
                content: [{ type: 'web_search_result', title: 'Masters Champions Dinner history', url: 'https://example.com/masters-dinner', encrypted_content: 'abc' }],
              },
              { type: 'text', text: '{"status":"searched","summary":"The Masters Champions Dinner is an annual tradition.","howToUse":"Use a Southern or champion-picked dinner as the themed meal."}' },
            ],
          };
        },
      },
    };
    const outcome = await executeWebSearch(
      { capability: 'web.search', input: { query: 'Masters Champions Dinner traditions' } },
      {
        req: { householdId: created.householdId, kbCapabilities: { webSearchEnabled: true } },
        chatId,
        prompt: 'Help me plan a Masters-themed dinner',
        anthropic,
        memoryContext: { capabilities: { webSearchEnabled: true }, assistantPersona: { assistantName: 'KitchenBot', assistantTone: 'helpful' } },
        deps: { stripStoredMessageContentForDisplay: (text) => text },
      }
    );
    process.stdout.write(JSON.stringify({
      outcome,
      capturedToolChoice: capturedBody?.tool_choice ?? null,
    }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.outcome.status, 'searched');
  assert.equal(parsed.capturedToolChoice, null);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('executeKbActions dedupes identical web.search actions within one turn', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-web-search-dedupe-'));
  const dbPath = path.join(tempDir, 'dedupe.db');

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
    const chatId = await db.createChat(created.householdId, 'Rob', 'Search dedupe');
    let createCalls = 0;
    const anthropic = {
      messages: {
        create: async () => {
          createCalls += 1;
          return {
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
          };
        },
      },
    };
    const result = await executeKbActions(
      [
        { capability: 'web.search', input: { query: 'masters dinner history' } },
        { capability: 'web.search', input: { query: 'masters dinner history' } },
      ],
      {
        req: { householdId: created.householdId, kbCapabilities: { webSearchEnabled: true } },
        res: {},
        name: 'Rob',
        chatId,
        turnId: 'turn-1',
        prompt: 'search the web for masters dinner history',
        anthropic,
        memoryContext: { capabilities: { webSearchEnabled: true }, assistantPersona: { assistantName: 'KitchenBot', assistantTone: 'helpful' } },
        workingContext: {},
        deps: {
          addMessage: async () => {},
          incrementUserMessageCountForSender: async () => {},
          broadcastToChat: () => {},
          stripStoredMessageContentForDisplay: (text) => text,
        },
        webSearchEnabled: true,
      }
    );
    const usageRows = await db.getAnthropicUsageLedgerAllRows({ householdId: created.householdId });
    process.stdout.write(JSON.stringify({ createCalls, result, usageRows }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.createCalls, 1);
  assert.equal(Array.isArray(parsed.result.outcomes), true);
  assert.equal(parsed.result.outcomes.length, 1);
  assert.equal(parsed.result.outcomes[0].capability, 'web.search');
  assert.equal(parsed.usageRows.length, 1);
  assert.equal(parsed.usageRows[0].action_query, 'masters dinner history');

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('DB-backed tests expose a non-default resolved DB path', async () => {
  await withTempDb('db-path-guard', async ({ dbPath, importFresh }) => {
    const db = await importFresh('../db.mjs', 'db-path-guard-db');
    assert.equal(db.RESOLVED_DB_PATH, dbPath);
    assert.notEqual(db.RESOLVED_DB_PATH, './kitchenbot.db');
  });
});

test('DB guard rejects importing db.mjs against the default local path in guarded mode', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ['--input-type=module', '-e', "await import(new URL('./db.mjs', 'file://' + process.cwd() + '/').href)"], {
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
      env: { ...process.env, KB_TEST_GUARD: '1' },
    }),
    /DB-backed tests must set DB_PATH explicitly/
  );
});
