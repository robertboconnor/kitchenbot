// ONE scenario, one repetition, in its own process against a throwaway database.
//
// Why a child process: db.mjs resolves DB_PATH at import time (db.mjs:17), so a fresh process is
// the only clean way to point the whole module graph at a temp file. This is the established idiom
// in this repo (tests/mealplan.test.mjs, test-support/server-helpers.mjs runAgainstDb).
//
// Why the REAL loop and REAL deps: an eval that drives a simplified harness measures the harness.
// This wires handleKbChatTurn exactly the way kitchenbot.mjs:2150-2170 does, so what it measures is
// what Rob actually gets. The only substitution is the Anthropic client, which is wrapped (not
// faked) so the tool trace can be observed.
//
// Usage: node evals/run-one.mjs <scenarioId> [rep]
//   requires DB_PATH (a temp file) and KB_TEST_GUARD=1 in the environment.
// Prints ONE JSON object on stdout. All diagnostics go to stderr.
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

import * as db from '../db.mjs';
import { buildKbRuntimeDeps } from '../kb-server-deps.mjs';
import { handleKbChatTurn } from '../kb-runtime.mjs';
import { createInventoryServices } from '../inventory-service.mjs';
import { buildKbContextPacket } from '../kb-memory-store.mjs';
import { createRecordingClient } from './recorder.mjs';
import { HOUSEHOLD, SCENARIOS } from './scenarios.mjs';

const [, , scenarioId, repArg] = process.argv;
const rep = Number(repArg) || 1;

function fail(message) {
  process.stdout.write(JSON.stringify({ scenarioId, rep, ok: false, error: message }));
  process.exit(0); // the PARENT decides what a failure means; a non-zero exit here reads as a crash
}

const scenario = SCENARIOS.find((s) => s.id === scenarioId);
if (!scenario) fail(`unknown scenario: ${scenarioId}`);

const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
if (!apiKey) fail('ANTHROPIC_API_KEY is not set (evals call the real API — see evals/README.md)');
if (process.env.KB_TEST_GUARD !== '1') fail('refusing to run without KB_TEST_GUARD=1');

async function main() {
  await db.runMigrations();

  const created = await db.createHouseholdWithInitialOwner({
    householdName: HOUSEHOLD.householdName,
    householdKey: HOUSEHOLD.householdKey,
    ownerDisplayName: HOUSEHOLD.ownerDisplayName,
    pin: HOUSEHOLD.pin,
  });
  const householdId = created.householdId;

  for (const member of HOUSEHOLD.members) {
    await db.createHouseholdUser(householdId, { displayName: member, role: 'member', pin: '0000' }).catch(() => {});
  }
  for (const profile of HOUSEHOLD.profiles) {
    await db.updatePersonProfile(householdId, profile.person, {
      allergies: profile.allergies || [],
      rejectedFoods: profile.rejectedFoods || [],
      acceptedFoods: profile.acceptedFoods || [],
    });
  }
  if (HOUSEHOLD.pantry?.length) {
    await db.addPantryItems(householdId, HOUSEHOLD.pantry.map((name) => ({ name })));
  }

  const chatId = await db.createChat(householdId, HOUSEHOLD.ownerDisplayName, 'Eval');
  // Suppress the auto-title Haiku call: it costs money and adds a second source of variance that
  // has nothing to do with what we are measuring.
  await db.setChatTitleLock?.(chatId, householdId, true).catch(() => {});

  if (scenario.seedPlan?.length) {
    await db.addMealPlanItems(householdId, chatId, scenario.seedPlan.map((name) => ({ name })));
  }
  for (const turn of scenario.history || []) {
    await db.addMessage(chatId, householdId, turn.role, turn.role === 'user' ? HOUSEHOLD.ownerDisplayName : 'KitchenBot', turn.content);
  }

  const { client, record } = createRecordingClient(new Anthropic({ apiKey }));

  const inventoryServices = createInventoryServices({
    getAnthropicClient: async () => ({ client, webSearchEnabled: false }),
    getGroceryItems: db.getGroceryItems,
    updateGroceryItemAmount: db.updateGroceryItemAmount,
    updateGroceryItemProbablyPantry: db.updateGroceryItemProbablyPantry,
    backfillGroceryItemSourceChatIfSafe: db.backfillGroceryItemSourceChatIfSafe,
    addGroceryItems: db.addGroceryItems,
  });

  const deps = buildKbRuntimeDeps({
    ANTHROPIC_KEY_USER_MESSAGE: 'Anthropic key missing.',
    addMessage: db.addMessage,
    broadcastToChat: () => {},
    emitKbProgress: async () => {},
    clearChatRuntimeState: () => {},
    // webSearchEnabled false: the eval measures the brain's own cooking judgment, and a live web
    // search would make runs non-reproducible and slow for no gain on these scenarios.
    getAnthropicClient: async () => ({ client, webSearchEnabled: false }),
    isGlobalAdminUser: async () => false, // developer mode off — it changes the reply's shape
    addChatAttachment: db.addChatAttachment,
    buildKbContextPacket,
    incrementUserMessageCountForSender: async () => {},
    isAnthropicSdkAuthOrKeyError: () => false,
    getAnthropicUserFacingErrorMessage: () => null,
    mergeGroceryItemsFromAi: inventoryServices.mergeGroceryItemsFromAi,
    normalizeGroceryItemsForPost: inventoryServices.normalizeGroceryItemsForPost,
    normalizeInventoryNameKey: inventoryServices.normalizeInventoryNameKey,
    stripStoredMessageContentForDisplay: (t) => t,
    clearGroceryItems: db.clearGroceryItems,
  });

  // streamReplyText broadcasts and calls res.end(finalReply) when res.write is absent
  // (kb-reply.mjs:52-65), so this captures the exact final reply.
  let captured = '';
  const res = { end(text) { if (typeof text === 'string') captured = text; } };
  const req = {
    householdId,
    userId: created.userId ?? 1,
    user: HOUSEHOLD.ownerDisplayName,
    body: {},
    kbTimeContext: scenario.timeContext || null,
  };

  await handleKbChatTurn({ req, res, name: HOUSEHOLD.ownerDisplayName, chatId, prompt: scenario.prompt, deps });

  // Cross-check the captured reply against what was persisted; prefer the persisted one, since
  // that is what the user would actually see in the thread.
  const messages = await db.getMessages(chatId, householdId).catch(() => []);
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const reply = lastAssistant?.content || captured || '';

  const ledger = await db.getAnthropicUsageLedgerAllRows({ householdId }).catch(() => []);
  const { buildAnthropicUsageReport } = await import('../anthropic-usage.mjs');
  const usage = ledger.length ? buildAnthropicUsageReport(ledger) : null;

  process.stdout.write(
    JSON.stringify({
      scenarioId,
      rep,
      ok: true,
      reply,
      replyMatchedStream: captured ? captured === reply : null,
      toolTrace: record.toolTrace,
      brainCallCount: record.brainCallCount,
      sideCallCount: record.sideCallCount,
      systemBlockCounts: record.systemBlockCounts,
      usage: usage ? { totals: usage.totals, byPurpose: usage.byPurpose } : null,
      finalState: {
        grocery: await db.getGroceryItems(householdId).catch(() => []),
        pantry: await db.getPantryItems(householdId).catch(() => []),
        plan: await db.getMealPlanItems(householdId).catch(() => []),
      },
    })
  );
}

main().catch((error) => fail(String(error?.stack || error?.message || error)));
