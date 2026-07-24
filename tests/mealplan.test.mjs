import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

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
