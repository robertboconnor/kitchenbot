import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import { runAgainstDb, signInAsFixtureOwner, withKitchenbotServer } from '../test-support/server-helpers.mjs';

const execFileAsync = promisify(execFileCb);

async function runScript(body) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-mealplan-'));
  const dbPath = path.join(tempDir, 'mealplan.db');
  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const plan = await import(new URL('./mealplan-executor.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const reads = await import(new URL('./kb-read-executors.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({ householdName: 'Home', householdKey: 'home', ownerDisplayName: 'Rob', pin: '1234' });
    const chatId = await db.createChat(created.householdId, 'Rob', 'Week');
    const householdId = created.householdId;
    const ctx = { req: { householdId }, chatId };
    ${body}
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
  });
  await fs.rm(tempDir, { recursive: true, force: true });
  return JSON.parse(stdout.trim());
}

test('ONE BRAIN: plan.add records the brain-provided meals, dedupes, and is truthful; no side-model', async () => {
  const anthropicGuard = "const anthropic = { messages: { create: async () => { throw new Error('plan must not call a side-model'); } } };";
  const parsed = await runScript(`
    ${anthropicGuard}
    const first = await plan.executePlanAdd(
      { capability: 'plan.add', input: { meals: [{ name: 'Cod with corn & lima bean succotash' }, { name: 'Chicken piccata' }] } },
      { ...ctx, anthropic }
    );
    const second = await plan.executePlanAdd(
      { capability: 'plan.add', input: { meals: [{ name: 'Chicken piccata' }, { name: 'Tofu stir-fry' }] } },
      { ...ctx, anthropic }
    );
    const listed = await reads.executePlanList({}, ctx);
    process.stdout.write(JSON.stringify({ first, second, listed }));
  `);
  assert.equal(parsed.first.status, 'added');
  assert.deepEqual(parsed.first.addedMeals.sort(), ['Chicken piccata', 'Cod with corn & lima bean succotash']);
  // second add: piccata already there, tofu new
  assert.equal(parsed.second.status, 'added');
  assert.deepEqual(parsed.second.addedMeals, ['Tofu stir-fry']);
  assert.deepEqual(parsed.second.alreadyOnPlan, ['Chicken piccata']);
  assert.equal(parsed.listed.count, 3);
  assert.equal(parsed.listed.plannedCount, 3);
});

test('plan.update marks a meal cooked (fuzzy match), plan.list reflects it', async () => {
  const parsed = await runScript(`
    await plan.executePlanAdd({ capability: 'plan.add', input: { meals: [{ name: 'Cod with corn & lima bean succotash' }, { name: 'Chicken piccata' }] } }, ctx);
    const upd = await plan.executePlanUpdate({ capability: 'plan.update', input: { meal: 'cod succotash', status: 'cooked' } }, ctx);
    const listed = await reads.executePlanList({}, ctx);
    process.stdout.write(JSON.stringify({ upd, listed }));
  `);
  assert.equal(parsed.upd.status, 'updated');
  assert.match(parsed.upd.mealName, /Cod with corn/);
  assert.equal(parsed.listed.cookedCount, 1);
  assert.equal(parsed.listed.plannedCount, 1);
  assert.ok(parsed.listed.meals.some((m) => /Cod with corn/.test(m.name) && m.status === 'cooked'));
});

test('plan.remove drops a meal; missing/ambiguous are truthful', async () => {
  const parsed = await runScript(`
    await plan.executePlanAdd({ capability: 'plan.add', input: { meals: [{ name: 'Chicken piccata' }, { name: 'Tofu stir-fry' }] } }, ctx);
    const removed = await plan.executePlanRemove({ capability: 'plan.remove', input: { meal: 'piccata' } }, ctx);
    const missing = await plan.executePlanRemove({ capability: 'plan.remove', input: { meal: 'lasagna' } }, ctx);
    const listed = await reads.executePlanList({}, ctx);
    process.stdout.write(JSON.stringify({ removed, missing, listed }));
  `);
  assert.equal(parsed.removed.status, 'removed');
  assert.match(parsed.removed.mealName, /piccata/i);
  assert.equal(parsed.missing.status, 'missing');
  assert.equal(parsed.listed.count, 1);
});

test('ONE BRAIN: plan.add with no meals returns invalid and records nothing', async () => {
  const parsed = await runScript(`
    const res = await plan.executePlanAdd({ capability: 'plan.add', input: {} }, ctx);
    const listed = await reads.executePlanList({}, ctx);
    process.stdout.write(JSON.stringify({ res, count: listed.count }));
  `);
  assert.equal(parsed.res.status, 'invalid');
  assert.equal(parsed.count, 0);
});

test('auto-link: a planned meal links to a saved cookbook recipe by title (confident single match only)', async () => {
  const parsed = await runScript(`
    const cb = await import(new URL('./cookbook-store.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const rec = cb.buildCookbookRecordForStorage({ title: 'Simple Chicken Piccata', summary: 'A lemony, briny chicken piccata.', ingredients: ['chicken', 'lemon', 'capers'], instructions: ['dredge', 'sear', 'sauce'] });
    await db.saveCookbookEntry(householdId, rec, { sourceKind: 'manual', sourceChatId: chatId });
    await plan.executePlanAdd({ capability: 'plan.add', input: { meals: [{ name: 'Chicken piccata' }, { name: 'Tofu stir-fry' }] } }, ctx);
    const listed = await reads.executePlanList({}, ctx);
    process.stdout.write(JSON.stringify({ meals: listed.meals }));
  `);
  const piccata = parsed.meals.find((m) => /piccata/i.test(m.name));
  const tofu = parsed.meals.find((m) => /tofu/i.test(m.name));
  assert.equal(piccata.hasRecipe, true, 'piccata auto-links to the saved recipe by title');
  assert.match(piccata.recipeTitle, /Simple Chicken Piccata/);
  assert.equal(!!tofu.hasRecipe, false, 'tofu has no matching saved recipe, so it stays unlinked');
});

test('auto-link: a richer meal name still links to a leaner recipe title via content overlap (the cod case)', async () => {
  // Regression: the strict all-tokens match required EVERY meal-name word to appear in the recipe
  // title, so "Grilled cod, corn & bacon succotash" never linked to a saved "Cod & Corn Succotash …"
  // (missing "grilled"/"bacon"). The overlap fallback links it; a decoy sharing only one word must not.
  const parsed = await runScript(`
    const cb = await import(new URL('./cookbook-store.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const rec = cb.buildCookbookRecordForStorage({ title: 'Cod & Corn Succotash with Littlenecks', summary: 'A one-pan seafood supper.', ingredients: ['cod', 'corn'], instructions: ['steam the clams', 'fold in the succotash'] });
    await db.saveCookbookEntry(householdId, rec, { sourceKind: 'manual', sourceChatId: chatId });
    const decoy = cb.buildCookbookRecordForStorage({ title: 'Grilled Chicken Thighs with Fennel', summary: 'x', ingredients: ['chicken'], instructions: ['grill it'] });
    await db.saveCookbookEntry(householdId, decoy, { sourceKind: 'manual', sourceChatId: chatId });
    await plan.executePlanAdd({ capability: 'plan.add', input: { meals: [{ name: 'Grilled cod, corn & bacon succotash' }] } }, ctx);
    const listed = await reads.executePlanList({}, ctx);
    process.stdout.write(JSON.stringify({ meals: listed.meals }));
  `);
  const cod = parsed.meals.find((m) => /cod/i.test(m.name));
  assert.equal(cod.hasRecipe, true, 'the richer meal name links to the leaner cod recipe via overlap');
  assert.match(cod.recipeTitle, /Cod & Corn Succotash/);
});

test('auto-link: stays unlinked when two recipes are equally plausible (never guesses)', async () => {
  const parsed = await runScript(`
    const cb = await import(new URL('./cookbook-store.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    const a = cb.buildCookbookRecordForStorage({ title: 'Cod Succotash Verde', summary: 'x', ingredients: ['cod'], instructions: ['cook'] });
    const b = cb.buildCookbookRecordForStorage({ title: 'Cod Succotash Rojo', summary: 'x', ingredients: ['cod'], instructions: ['cook'] });
    await db.saveCookbookEntry(householdId, a, { sourceKind: 'manual', sourceChatId: chatId });
    await db.saveCookbookEntry(householdId, b, { sourceKind: 'manual', sourceChatId: chatId });
    await plan.executePlanAdd({ capability: 'plan.add', input: { meals: [{ name: 'Cod succotash' }] } }, ctx);
    const listed = await reads.executePlanList({}, ctx);
    process.stdout.write(JSON.stringify({ meals: listed.meals }));
  `);
  const cod = parsed.meals.find((m) => /cod/i.test(m.name));
  assert.equal(!!cod.hasRecipe, false, 'two equally-good matches → no link, rather than guessing wrong');
});

test('thread.search retrieves an older message past the recent window, deterministically (no side-model)', async () => {
  const parsed = await runScript(`
    await db.addMessage(householdId, chatId, 'user', 'Rob', 'the toum broke and split into oil');
    await db.addMessage(householdId, chatId, 'assistant', 'KitchenBot', 'To rescue a broken toum, start a fresh egg white in a clean bowl and slowly drizzle the broken mix back in while blending.');
    for (let i = 0; i < 30; i++) { await db.addMessage(householdId, chatId, 'user', 'Rob', 'filler ' + i); await db.addMessage(householdId, chatId, 'assistant', 'KitchenBot', 'ok ' + i); }
    const r = await reads.executeThreadSearch({ input: { query: 'toum broke rescue fix' } }, ctx);
    process.stdout.write(JSON.stringify({ ok: r.ok, count: r.count, total: r.totalMessages, topHasFix: /rescue a broken toum|egg white/i.test(r.results[0] ? r.results[0].snippet : '') }));
  `);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.total > 32, 'thread is well past the recent-message window (30)');
  assert.ok(parsed.count > 0, 'found matching older messages');
  assert.equal(parsed.topHasFix, true, 'the toum-rescue message is the top hit');
});

// ── The plan is household-wide, and the HTTP surface must say so ─────────────────
// These routes used to demand a chatId and then throw it away. GET quietly returned an EMPTY plan
// without one — so the app looked like nothing was planned rather than reporting an error — and
// PATCH/DELETE 400'd. Nothing caught it because no test exercised /plan over HTTP at all; the
// tests above go straight to the executors. These close that gap.

/** Boot a server, sign in, and seed the plan with meals planned in `chatId`. */
async function withPlannedMeals(label, mealNames, run) {
  await withKitchenbotServer(label, async ({ baseUrl, dbPath }) => {
    const { headers, householdId } = await signInAsFixtureOwner(baseUrl);
    const { chatId } = await runAgainstDb(
      dbPath,
      `const chatId = await db.createChat(${householdId}, 'Tester', 'Week');
       await db.addMealPlanItems(${householdId}, chatId, ${JSON.stringify(mealNames.map((name) => ({ name })))});
       console.log(JSON.stringify({ chatId }));`
    );
    const planNow = () =>
      runAgainstDb(dbPath, `console.log(JSON.stringify(await db.getMealPlanItems(${householdId})));`);
    await run({ baseUrl, dbPath, headers, householdId, chatId, planNow });
  });
}

test('/plan returns the household plan without being told which chat you are in', async () => {
  await withPlannedMeals('plan-get', ['Seared cod', 'Toum'], async ({ baseUrl, headers }) => {
    const res = await fetch(`${baseUrl}/plan`, { headers });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      body.items.map((i) => i.name).sort(),
      ['Seared cod', 'Toum'],
      'the plan is household-wide, so it must come back with no chatId at all'
    );
  });
});

test('/plan items can be marked cooked and removed without a chatId', async () => {
  await withPlannedMeals('plan-write', ['Weeknight pasta'], async ({ baseUrl, headers, planNow }) => {
    const [item] = await planNow();

    const patch = await fetch(`${baseUrl}/plan/${item.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'cooked' }),
    });
    assert.equal(patch.status, 200, 'PATCH must not require a chatId it ignores');
    assert.equal((await planNow())[0].status, 'cooked');

    const del = await fetch(`${baseUrl}/plan/${item.id}`, { method: 'DELETE', headers });
    assert.equal(del.status, 200, 'DELETE must not require a chatId it ignores');
    assert.equal((await planNow()).length, 0);
  });
});

test('a meal planned in one chat is visible from another chat', async () => {
  // The whole point of the plan being household-wide: plan on Sunday, cook on Wednesday in a
  // different conversation. The old routes only made this work by accident of ignoring chatId.
  await withPlannedMeals('plan-cross-chat', ['Corn succotash'], async ({ baseUrl, headers, dbPath, householdId }) => {
    // A second, later conversation — the one you'd actually be cooking from on Wednesday.
    await runAgainstDb(dbPath, `await db.createChat(${householdId}, 'Tester', 'A different week');`);
    const res = await fetch(`${baseUrl}/plan`, { headers });
    const body = await res.json();
    assert.deepEqual(body.items.map((i) => i.name), ['Corn succotash']);
  });
});
