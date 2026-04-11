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

function close(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

test('household queries expose camelCase fields without dropping legacy snake_case fields', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-household-shape-'));
  const dbPath = path.join(tempDir, 'households.db');

  const seedDb = await openDb(dbPath);
  await exec(
    seedDb,
    `
      CREATE TABLE households (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        household_key TEXT NOT NULL UNIQUE,
        anthropic_key_mode TEXT NOT NULL DEFAULT 'shared',
        anthropic_api_key TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        web_search_enabled INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO households (
        id, name, household_key, anthropic_key_mode, anthropic_api_key, web_search_enabled, created_at
      ) VALUES (
        1, 'Rob and Elle', 'rob-and-elle', 'household', 'secret', 1, '2026-04-10 12:00:00'
      );
    `
  );
  await close(seedDb);

  process.env.DB_PATH = dbPath;
  const moduleUrl = new URL(`../db.mjs?household-shape=${Date.now()}`, import.meta.url);
  const db = await import(moduleUrl.href);

  const byId = await db.getHouseholdById(1);
  assert.equal(byId.household_key, 'rob-and-elle');
  assert.equal(byId.householdKey, 'rob-and-elle');
  assert.equal(byId.anthropic_key_mode, 'household');
  assert.equal(byId.anthropicKeyMode, 'household');
  assert.equal(byId.web_search_enabled, 1);
  assert.equal(byId.webSearchEnabled, true);
  assert.equal(byId.created_at, '2026-04-10 12:00:00');
  assert.equal(byId.createdAt, '2026-04-10 12:00:00');

  const rows = await db.listAllHouseholdsSummary();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].householdKey, 'rob-and-elle');
  assert.equal(rows[0].household_key, 'rob-and-elle');

  await fs.rm(tempDir, { recursive: true, force: true });
});
