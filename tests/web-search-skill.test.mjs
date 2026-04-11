import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { buildKbInterpreterActionExamples, buildKbInterpreterSkillList, normalizeKbSkillAction } from '../kb-skills.mjs';
import { detectAnthropicWebSearchUsage } from '../anthropic-usage.mjs';

const execFileAsync = promisify(execFile);

test('web.search is only exposed to the interpreter when household web search is enabled', () => {
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

test('detectAnthropicWebSearchUsage recognizes server-side web search blocks', () => {
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
    console.log(JSON.stringify(rows[0]));
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

test('executeWebSearch returns structured searched results with query and sources', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-web-search-exec-'));
  const dbPath = path.join(tempDir, 'exec.db');

  process.env.DB_PATH = dbPath;
  const dbModuleUrl = new URL(`../db.mjs?web-search-exec=${Date.now()}`, import.meta.url);
  const executorModuleUrl = new URL(`../web-search-executor.mjs?web-search-exec=${Date.now()}`, import.meta.url);
  const db = await import(dbModuleUrl.href);
  const { executeWebSearch } = await import(executorModuleUrl.href);
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
          server_tool_use: {
            web_search_requests: 1,
          },
        },
        content: [
          {
            type: 'server_tool_use',
            name: 'web_search',
            input: { query: 'Masters Champions Dinner traditions' },
          },
          {
            type: 'web_search_tool_result',
            tool_use_id: 'toolu_1',
            content: [
              {
                type: 'web_search_result',
                title: 'Masters Champions Dinner history',
                url: 'https://example.com/masters-dinner',
                encrypted_content: 'abc',
              },
            ],
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
      deps: {
        stripStoredMessageContentForDisplay: (text) => text,
      },
    }
  );

  assert.equal(outcome.capability, 'web.search');
  assert.equal(outcome.status, 'searched');
  assert.equal(outcome.query, 'Masters Champions Dinner traditions');
  assert.match(outcome.summary, /annual tradition/i);
  assert.equal(outcome.sources.length, 1);
  assert.equal(outcome.sources[0].title, 'Masters Champions Dinner history');

  await fs.rm(tempDir, { recursive: true, force: true });
});
