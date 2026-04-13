import test from 'node:test';
import assert from 'node:assert/strict';
import sqlite3 from 'sqlite3';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

function openDb(filename) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename, (err) => {
      if (err) reject(err);
      else resolve(db);
    });
  });
}

function exec(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function all(db, sql) {
  return new Promise((resolve, reject) => {
    db.all(sql, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function get(db, sql) {
  return new Promise((resolve, reject) => {
    db.get(sql, (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

function close(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

test('runMigrations patches old Render-era runtime and usage columns compatibly', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-db-compat-'));
  const dbPath = path.join(tempDir, 'compat.db');

  const seedDb = await openDb(dbPath);
  await exec(
    seedDb,
    `
      PRAGMA foreign_keys = OFF;
      CREATE TABLE households (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        household_key TEXT NOT NULL UNIQUE,
        anthropic_key_mode TEXT NOT NULL DEFAULT 'shared',
        anthropic_api_key TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        web_search_enabled INTEGER NOT NULL DEFAULT 0,
        smart_mode_enabled INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
        owner TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE chat_runtime_state (
        chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
        household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
        mode TEXT NOT NULL DEFAULT 'smart',
        pending_json TEXT NOT NULL DEFAULT '{}',
        checkpoint_json TEXT NOT NULL DEFAULT '{}',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE anthropic_usage_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
        chat_id INTEGER NULL REFERENCES chats(id) ON DELETE SET NULL,
        smart_mode_enabled INTEGER NOT NULL DEFAULT 0,
        call_surface TEXT NOT NULL,
        call_purpose TEXT NOT NULL,
        model TEXT NOT NULL,
        request_kind TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_input_tokens INTEGER,
        cache_read_input_tokens INTEGER,
        web_search_enabled_at_call INTEGER NOT NULL DEFAULT 0,
        used_web_search_tool INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE household_defaults (
        household_id INTEGER PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
        assumed_pantry_items_json TEXT NOT NULL DEFAULT '[]',
        default_dinner_portions INTEGER NULL,
        weeknight_cooking_style TEXT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO households (id, name, household_key, web_search_enabled, smart_mode_enabled)
      VALUES (1, 'Home', 'home', 0, 1);
      INSERT INTO chats (id, household_id, owner, title)
      VALUES (10, 1, 'Rob', 'Kitchen Chat');
      INSERT INTO chat_runtime_state (chat_id, household_id, mode, pending_json, checkpoint_json)
      VALUES (10, 1, 'smart', '{"active":true}', '{"step":"old"}');
      INSERT INTO anthropic_usage_ledger (
        household_id, chat_id, smart_mode_enabled, call_surface, call_purpose, model, request_kind,
        input_tokens, output_tokens, web_search_enabled_at_call, used_web_search_tool
      ) VALUES (1, 10, 0, 'chat', 'reply', 'claude', 'create', 12, 34, 0, 0);
      INSERT INTO anthropic_usage_ledger (
        household_id, chat_id, smart_mode_enabled, call_surface, call_purpose, model, request_kind,
        input_tokens, output_tokens, web_search_enabled_at_call, used_web_search_tool
      ) VALUES (1, 0, 1, 'kb_action', 'meal_refine', 'x', 'create', 1, 1, 0, 0);
    `
  );
  await close(seedDb);

  process.env.DB_PATH = dbPath;
  const moduleUrl = new URL(`../db.mjs?compat=${Date.now()}`, import.meta.url);
  const migratedDb = await import(moduleUrl.href);
  await migratedDb.runMigrations();

  const checkDb = await openDb(dbPath);
  const runtimeColumns = await all(checkDb, `PRAGMA table_info(chat_runtime_state)`);
  const runtimeNames = new Set(runtimeColumns.map((row) => row.name));
  assert.equal(runtimeNames.has('proposed_next_action_json'), true);
  assert.equal(runtimeNames.has('working_context_json'), true);

  const usageColumns = await all(checkDb, `PRAGMA table_info(anthropic_usage_ledger)`);
  const usageNames = new Set(usageColumns.map((row) => row.name));
  assert.equal(usageNames.has('runtime_enabled'), true);
  assert.equal(usageNames.has('turn_id'), true);
  assert.equal(usageNames.has('action_capability'), true);
  assert.equal(usageNames.has('action_query'), true);
  assert.equal(usageNames.has('prompt_hash'), true);
  assert.equal(usageNames.has('prompt_excerpt'), true);

  const usageRow = await get(
    checkDb,
    `SELECT smart_mode_enabled, runtime_enabled FROM anthropic_usage_ledger ORDER BY id ASC LIMIT 1`
  );
  assert.equal(Number(usageRow.smart_mode_enabled), 0);
  assert.equal(Number(usageRow.runtime_enabled), 0);

  const migratedLegacyUsageRow = await get(
    checkDb,
    `SELECT chat_id, model
     FROM anthropic_usage_ledger
     WHERE call_purpose = 'meal_refine'
     ORDER BY id DESC
     LIMIT 1`
  );
  assert.equal(migratedLegacyUsageRow.chat_id, null);
  assert.equal(migratedLegacyUsageRow.model, 'claude-sonnet-4-5');

  const defaultsColumns = await all(checkDb, `PRAGMA table_info(household_defaults)`);
  const defaultsNames = new Set(defaultsColumns.map((row) => row.name));
  assert.equal(defaultsNames.has('assistant_name'), true);
  assert.equal(defaultsNames.has('assistant_tone'), true);

  const groceryColumns = await all(checkDb, `PRAGMA table_info(grocery_items)`);
  const groceryNames = new Set(groceryColumns.map((row) => row.name));
  assert.equal(groceryNames.has('probably_pantry_item'), true);

  await close(checkDb);
  await fs.rm(tempDir, { recursive: true, force: true });
});
