import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('household defaults persist assistant name and tone with safe defaults', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-defaults-persona-'));
  const dbPath = path.join(tempDir, 'defaults.db');

  process.env.DB_PATH = dbPath;
  const moduleUrl = new URL(`../db.mjs?defaults-persona=${Date.now()}`, import.meta.url);
  const db = await import(moduleUrl.href);
  await db.runMigrations();

  const created = await db.createHouseholdWithInitialOwner({
    householdName: 'Home',
    householdKey: 'home',
    ownerDisplayName: 'Rob',
    pin: '1234',
  });

  const initial = await db.getHouseholdDefaults(created.householdId);
  assert.equal(initial.assistantName, 'KitchenBot');
  assert.equal(initial.assistantTone, 'helpful');

  await db.saveHouseholdDefaults(created.householdId, {
    assistantName: 'Sous-Chef',
    assistantTone: 'witty',
    defaultDinnerPortions: 3,
    weeknightCookingStyle: 'easy',
  });

  const updated = await db.getHouseholdDefaults(created.householdId);
  assert.equal(updated.assistantName, 'Sous-Chef');
  assert.equal(updated.assistantTone, 'witty');
  assert.equal(updated.defaultDinnerPortions, 3);
  assert.equal(updated.weeknightCookingStyle, 'easy');

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('assistant persona remains available even when structured defaults are gated off', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-defaults-persona-context-'));
  const dbPath = path.join(tempDir, 'defaults-context.db');
  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://${process.cwd()}/').href);
    const store = await import(new URL('./kb-memory-store.mjs?child=' + Date.now(), 'file://${process.cwd()}/').href);
    await db.runMigrations();
    const created = await db.createHouseholdWithInitialOwner({
      householdName: 'Home',
      householdKey: 'home',
      ownerDisplayName: 'Rob',
      pin: '1234',
    });
    await db.saveHouseholdDefaults(created.householdId, {
      assistantName: 'Kitchenbro',
      assistantTone: 'thirsty',
      defaultDinnerPortions: 4,
      weeknightCookingStyle: 'ambitious',
    });
    const context = await store.buildKbContextPacket(created.householdId, 'who are you?', {
      includeDefaults: false,
      includePantry: false,
      includeGrocery: false,
      activeSpeakerName: 'Rob',
    });
    process.stdout.write(JSON.stringify({
      householdDefaults: context.householdDefaults,
      assistantPersona: context.assistantPersona,
    }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, DB_PATH: dbPath },
  });
  const parsed = JSON.parse(stdout.trim());

  assert.deepEqual(parsed.householdDefaults, {
    defaultDinnerPortions: null,
    weeknightCookingStyle: null,
  });
  assert.deepEqual(parsed.assistantPersona, {
    assistantName: 'Kitchenbro',
    assistantTone: 'thirsty',
  });

  await fs.rm(tempDir, { recursive: true, force: true });
});
