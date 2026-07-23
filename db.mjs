import sqlite3 from 'sqlite3';
import crypto from 'crypto';
import {
  GROCERY_SECTION_KEYS,
  PANTRY_SECTION_KEYS,
  normalizePantrySection,
} from './inventory-classification.mjs';
import { normalizeInventoryNameKey } from './inventory-service.mjs';
import {
  DEFAULT_ASSISTANT_NAME,
  DEFAULT_ASSISTANT_TONE,
  normalizeAssistantName,
  normalizeAssistantTone,
} from './kb-persona.mjs';
import { resolveAnthropicModelForCallPurpose } from './anthropic-model-policy.mjs';

const dbPath = process.env.DB_PATH || './kitchenbot.db';
if (process.env.KB_TEST_GUARD === '1' && dbPath === './kitchenbot.db') {
  throw new Error('DB-backed tests must set DB_PATH explicitly before importing db.mjs.');
}
const db = new sqlite3.Database(dbPath);

const SCRYPT_KEY_LEN = 64;
const HOUSEHOLD_KEY_PATTERN = /^[a-z0-9-]+$/;

export const CHAT_COLOR_KEYS = new Set(['pink', 'blue', 'mint', 'lavender', 'peach']);
export const DEFAULT_CHAT_COLOR = 'blue';
// Per-user UI palette (mirrors chat_color). Keys must match the CSS [data-palette] blocks.
export const PALETTE_KEYS = new Set(['cotton-candy', 'sweetwater', 'sous-chef']);
export const DEFAULT_PALETTE = 'sweetwater';
export const RESOLVED_DB_PATH = dbPath;

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function exec(sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(pin, salt, SCRYPT_KEY_LEN);
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

export function normalizeChatColor(raw) {
  const k = String(raw ?? '').trim().toLowerCase();
  return CHAT_COLOR_KEYS.has(k) ? k : DEFAULT_CHAT_COLOR;
}

export function normalizePalette(raw) {
  const k = String(raw ?? '').trim().toLowerCase();
  return PALETTE_KEYS.has(k) ? k : DEFAULT_PALETTE;
}

export function normalizeHouseholdKey(key) {
  return String(key ?? '').trim().toLowerCase();
}

export function isValidHouseholdKeyFormat(key) {
  const n = normalizeHouseholdKey(key);
  return n.length > 0 && n.length <= 128 && HOUSEHOLD_KEY_PATTERN.test(n);
}

export function verifyPin(pin, stored) {
  if (!stored || typeof pin !== 'string') return false;
  const parts = String(stored).split(':');
  if (parts[0] !== 'scrypt' || parts.length !== 3) return false;
  const [, saltHex, hashHex] = parts;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const derived = crypto.scryptSync(pin, salt, SCRYPT_KEY_LEN);
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function parseJsonObject(raw, fallback = {}) {
  try {
    const parsed = JSON.parse(String(raw ?? '').trim() || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    return parsed;
  } catch {
    return fallback;
  }
}

function parseJsonArray(raw, fallback = []) {
  try {
    const parsed = JSON.parse(String(raw ?? '').trim() || '[]');
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizeOptionalForeignKey(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric;
}

function normalizeUsageLedgerModel(rawModel, callPurpose) {
  const model = String(rawModel ?? '').trim();
  if (model && model !== 'x' && model.toLowerCase() !== 'unknown') return model;
  return resolveAnthropicModelForCallPurpose(callPurpose);
}

function globalAdminIds() {
  return new Set(
    String(process.env.GLOBAL_ADMIN_USER_IDS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
  );
}

async function initializeSchema() {
  const shouldResetOnStart = String(process.env.RESET_DB_ON_START ?? '').trim() === '1';

  if (shouldResetOnStart) {
    await exec(`PRAGMA foreign_keys = OFF;`);
    const existingTables = await all(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC`
    );
    for (const row of existingTables) {
      const tableName = String(row?.name ?? '').trim();
      if (!tableName) continue;
      await run(`DROP TABLE IF EXISTS "${tableName}"`);
    }
  }

  await exec(`
    CREATE TABLE IF NOT EXISTS households (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      household_key TEXT NOT NULL UNIQUE,
      anthropic_key_mode TEXT NOT NULL DEFAULT 'shared',
      anthropic_api_key TEXT,
      web_search_enabled INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS household_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      pin_hash TEXT,
      chat_color TEXT NOT NULL DEFAULT 'blue',
      palette TEXT NOT NULL DEFAULT 'sweetwater',
      session_version INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(household_id, display_name)
    );

    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      owner TEXT NOT NULL,
      title TEXT NOT NULL,
      title_locked INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      name TEXT,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS kb_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      memory_type TEXT NOT NULL,
      label TEXT NOT NULL,
      normalized_label TEXT NOT NULL,
      summary TEXT NOT NULL,
      attributes_json TEXT NOT NULL DEFAULT '{}',
      source_kind TEXT NOT NULL DEFAULT 'manual',
      source_chat_id INTEGER NULL REFERENCES chats(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(household_id, memory_type, normalized_label)
    );

    CREATE TABLE IF NOT EXISTS household_defaults (
      household_id INTEGER PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
      assumed_pantry_items_json TEXT NOT NULL DEFAULT '[]',
      default_dinner_portions INTEGER NULL,
      weeknight_cooking_style TEXT NULL,
      assistant_name TEXT NOT NULL DEFAULT 'KitchenBot',
      assistant_tone TEXT NOT NULL DEFAULT 'helpful',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pantry_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      section TEXT NOT NULL DEFAULT 'other',
      amount TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(household_id, normalized_name)
    );

    CREATE TABLE IF NOT EXISTS grocery_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      section TEXT NOT NULL,
      amount TEXT,
      checked INTEGER NOT NULL DEFAULT 0,
      probably_pantry_item INTEGER NOT NULL DEFAULT 0,
      source_chat_id INTEGER NULL REFERENCES chats(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cookbook_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      normalized_title TEXT NOT NULL,
      summary TEXT NOT NULL,
      category TEXT,
      recipe_type TEXT NOT NULL DEFAULT 'meal_idea',
      ingredients_json TEXT NOT NULL DEFAULT '[]',
      instructions_json TEXT NOT NULL DEFAULT '[]',
      tags_json TEXT NOT NULL DEFAULT '[]',
      source_book_title TEXT,
      source_title TEXT,
      source_url TEXT,
      notes TEXT,
      notes_json TEXT NOT NULL DEFAULT '[]',
      source_kind TEXT NOT NULL DEFAULT 'manual',
      source_chat_id INTEGER NULL REFERENCES chats(id) ON DELETE SET NULL,
      last_used_at DATETIME NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(household_id, normalized_title)
    );

    CREATE TABLE IF NOT EXISTS chat_runtime_state (
      chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      mode TEXT NOT NULL DEFAULT 'kb',
      proposed_next_action_json TEXT NOT NULL DEFAULT '{}',
      working_context_json TEXT NOT NULL DEFAULT '{}',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS anthropic_usage_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      chat_id INTEGER NULL REFERENCES chats(id) ON DELETE SET NULL,
      runtime_enabled INTEGER NOT NULL DEFAULT 1,
      turn_id TEXT,
      action_capability TEXT,
      action_query TEXT,
      prompt_hash TEXT,
      prompt_excerpt TEXT,
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

    CREATE INDEX IF NOT EXISTS idx_usage_created_at ON anthropic_usage_ledger(created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_household_created_at ON anthropic_usage_ledger(household_id, created_at);

    CREATE TABLE IF NOT EXISTS recipe_import_drafts (
      id TEXT PRIMARY KEY,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES household_users(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL,
      source_url TEXT,
      source_title TEXT,
      source_markdown TEXT NOT NULL DEFAULT '',
      source_text TEXT NOT NULL DEFAULT '',
      extraction_status TEXT NOT NULL DEFAULT 'draft',
      warnings_json TEXT NOT NULL DEFAULT '[]',
      recipe_json TEXT NOT NULL DEFAULT '{}',
      provenance_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'draft',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_recipe_import_drafts_household_user_created
      ON recipe_import_drafts(household_id, user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS meal_plan_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      cookbook_entry_id INTEGER NULL REFERENCES cookbook_entries(id) ON DELETE SET NULL,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'planned',
      position INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(household_id, chat_id, normalized_name)
    );

    CREATE INDEX IF NOT EXISTS idx_meal_plan_items_household_chat
      ON meal_plan_items(household_id, chat_id, position ASC, id ASC);

    CREATE TABLE IF NOT EXISTS person_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      person TEXT NOT NULL,
      normalized_person TEXT NOT NULL,
      accepted_foods_json TEXT NOT NULL DEFAULT '[]',
      rejected_foods_json TEXT NOT NULL DEFAULT '[]',
      allergies_json TEXT NOT NULL DEFAULT '[]',
      notes_json TEXT NOT NULL DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(household_id, normalized_person)
    );
  `);

  const chatColumns = await all(`PRAGMA table_info(chats)`);
  const chatColumnNames = new Set(chatColumns.map((row) => String(row?.name || '').trim()));
  if (!chatColumnNames.has('title_locked')) {
    await run(`ALTER TABLE chats ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0`);
  }

  const chatRuntimeStateColumns = await all(`PRAGMA table_info(chat_runtime_state)`);
  const chatRuntimeStateColumnNames = new Set(chatRuntimeStateColumns.map((row) => String(row?.name || '').trim()));
  if (!chatRuntimeStateColumnNames.has('proposed_next_action_json')) {
    await run(`ALTER TABLE chat_runtime_state ADD COLUMN proposed_next_action_json TEXT NOT NULL DEFAULT '{}'`);
  }
  if (!chatRuntimeStateColumnNames.has('working_context_json')) {
    await run(`ALTER TABLE chat_runtime_state ADD COLUMN working_context_json TEXT NOT NULL DEFAULT '{}'`);
  }

  const anthropicUsageColumns = await all(`PRAGMA table_info(anthropic_usage_ledger)`);
  const anthropicUsageColumnNames = new Set(anthropicUsageColumns.map((row) => String(row?.name || '').trim()));
  if (!anthropicUsageColumnNames.has('runtime_enabled')) {
    await run(`ALTER TABLE anthropic_usage_ledger ADD COLUMN runtime_enabled INTEGER NOT NULL DEFAULT 1`);
    if (anthropicUsageColumnNames.has('smart_mode_enabled')) {
      await run(
        `UPDATE anthropic_usage_ledger
         SET runtime_enabled = smart_mode_enabled
         WHERE smart_mode_enabled IS NOT NULL`
      );
    }
  }
  if (!anthropicUsageColumnNames.has('turn_id')) {
    await run(`ALTER TABLE anthropic_usage_ledger ADD COLUMN turn_id TEXT`);
  }
  if (!anthropicUsageColumnNames.has('action_capability')) {
    await run(`ALTER TABLE anthropic_usage_ledger ADD COLUMN action_capability TEXT`);
  }
  if (!anthropicUsageColumnNames.has('action_query')) {
    await run(`ALTER TABLE anthropic_usage_ledger ADD COLUMN action_query TEXT`);
  }
  if (!anthropicUsageColumnNames.has('prompt_hash')) {
    await run(`ALTER TABLE anthropic_usage_ledger ADD COLUMN prompt_hash TEXT`);
  }
  if (!anthropicUsageColumnNames.has('prompt_excerpt')) {
    await run(`ALTER TABLE anthropic_usage_ledger ADD COLUMN prompt_excerpt TEXT`);
  }

  const groceryItemColumns = await all(`PRAGMA table_info(grocery_items)`);
  const groceryItemColumnNames = new Set(groceryItemColumns.map((row) => String(row?.name || '').trim()));
  if (!groceryItemColumnNames.has('probably_pantry_item')) {
    await run(`ALTER TABLE grocery_items ADD COLUMN probably_pantry_item INTEGER NOT NULL DEFAULT 0`);
  }

  const householdDefaultsColumns = await all(`PRAGMA table_info(household_defaults)`);
  const householdDefaultsColumnNames = new Set(householdDefaultsColumns.map((row) => String(row?.name || '').trim()));
  if (!householdDefaultsColumnNames.has('assistant_name')) {
    await run(`ALTER TABLE household_defaults ADD COLUMN assistant_name TEXT NOT NULL DEFAULT '${DEFAULT_ASSISTANT_NAME}'`);
  }
  if (!householdDefaultsColumnNames.has('assistant_tone')) {
    await run(`ALTER TABLE household_defaults ADD COLUMN assistant_tone TEXT NOT NULL DEFAULT '${DEFAULT_ASSISTANT_TONE}'`);
  }

  // Per-user UI palette preference (mirrors chat_color; shipped after the initial schema,
  // so existing populated DBs need this ALTER).
  const householdUserColumns = await all(`PRAGMA table_info(household_users)`);
  const householdUserColumnNames = new Set(householdUserColumns.map((row) => String(row?.name || '').trim()));
  if (!householdUserColumnNames.has('palette')) {
    await run(`ALTER TABLE household_users ADD COLUMN palette TEXT NOT NULL DEFAULT 'sweetwater'`);
  }

  const cookbookColumns = await all(`PRAGMA table_info(cookbook_entries)`);
  const cookbookColumnNames = new Set(cookbookColumns.map((row) => String(row?.name || '').trim()));
  if (!cookbookColumnNames.has('category')) {
    await run(`ALTER TABLE cookbook_entries ADD COLUMN category TEXT`);
  }
  if (!cookbookColumnNames.has('source_book_title')) {
    await run(`ALTER TABLE cookbook_entries ADD COLUMN source_book_title TEXT`);
  }
  if (!cookbookColumnNames.has('notes_json')) {
    await run(`ALTER TABLE cookbook_entries ADD COLUMN notes_json TEXT NOT NULL DEFAULT '[]'`);
    const cookbookRows = await all(`SELECT id, notes FROM cookbook_entries ORDER BY id ASC`);
    for (const row of cookbookRows) {
      const noteText = String(row?.notes ?? '').trim();
      const noteList = noteText
        ? noteText.split(/\s+\|\s+/).map((item) => String(item ?? '').trim()).filter(Boolean)
        : [];
      await run(`UPDATE cookbook_entries SET notes_json = ? WHERE id = ?`, [
        JSON.stringify(noteList),
        Number(row.id),
      ]);
    }
  }

  const pantryDefaultsRows = await all(
    `SELECT household_id, assumed_pantry_items_json
     FROM household_defaults
     WHERE assumed_pantry_items_json IS NOT NULL AND trim(assumed_pantry_items_json) != ''`
  );
  for (const row of pantryDefaultsRows) {
    const householdId = Number(row?.household_id);
    if (!Number.isFinite(householdId)) continue;
    const pantryItems = normalizePantryItems(parseJsonArray(row?.assumed_pantry_items_json, []));
    for (const item of pantryItems) {
      const normalizedName = normalizeInventoryNameKey(item);
      if (!normalizedName) continue;
      await run(
        `INSERT OR IGNORE INTO pantry_items (household_id, name, normalized_name, section, amount)
         VALUES (?, ?, ?, ?, '')`,
        [householdId, item, normalizedName, normalizePantrySection('', item)]
      );
    }
  }

  const pantryRows = await all(`SELECT id, name, section FROM pantry_items ORDER BY id ASC`);
  for (const row of pantryRows) {
    const nextSection = normalizePantrySection(row?.section, row?.name);
    if (nextSection === String(row?.section ?? '').trim().toLowerCase()) continue;
    await run(`UPDATE pantry_items SET section = ? WHERE id = ?`, [nextSection, Number(row.id)]);
  }

  await run(`UPDATE anthropic_usage_ledger SET chat_id = NULL WHERE chat_id IS NOT NULL AND chat_id <= 0`);
  const badUsageModelRows = await all(
    `SELECT id, call_purpose
     FROM anthropic_usage_ledger
     WHERE trim(COALESCE(model, '')) IN ('', 'x', 'unknown')`
  );
  for (const row of badUsageModelRows) {
    const nextModel = normalizeUsageLedgerModel(row?.model, row?.call_purpose);
    await run(`UPDATE anthropic_usage_ledger SET model = ? WHERE id = ?`, [
      nextModel,
      Number(row.id),
    ]);
  }

  await exec(`PRAGMA foreign_keys = ON;`);
}

export async function runMigrations() {
  await initializeSchema();
}

export async function needsBootstrap() {
  const row = await get(`SELECT COUNT(*) AS count FROM households`);
  return Number(row?.count ?? 0) === 0;
}

export async function getFirstHouseholdId() {
  const row = await get(`SELECT id FROM households ORDER BY id ASC LIMIT 1`);
  return row ? Number(row.id) : null;
}

export async function isGlobalAdminUser(userId) {
  const numericUserId = Number(userId);
  if (!Number.isFinite(numericUserId)) return false;

  const explicitAdminIds = globalAdminIds();
  if (explicitAdminIds.size > 0) {
    return explicitAdminIds.has(numericUserId);
  }

  const row = await get(
    `SELECT u.id
     FROM household_users u
     WHERE u.role = 'owner'
     ORDER BY u.household_id ASC, u.id ASC
     LIMIT 1`
  );
  return Number(row?.id ?? 0) === numericUserId;
}

export async function getHouseholdById(householdId) {
  const row = await get(
    `SELECT id, name, household_key, anthropic_key_mode, anthropic_api_key, web_search_enabled, created_at
     FROM households
     WHERE id = ?`,
    [householdId]
  );
  return mapHouseholdRow(row);
}

export async function getHouseholdByKey(householdKey) {
  const row = await get(
    `SELECT id, name, household_key, anthropic_key_mode, anthropic_api_key, web_search_enabled, created_at
     FROM households
     WHERE household_key = ?`,
    [normalizeHouseholdKey(householdKey)]
  );
  return mapHouseholdRow(row);
}

export async function updateHouseholdAnthropicSettings(householdId, { anthropicKeyMode, anthropicApiKey }) {
  await run(
    `UPDATE households SET anthropic_key_mode = ?, anthropic_api_key = ? WHERE id = ?`,
    [String(anthropicKeyMode || 'shared'), anthropicApiKey ? String(anthropicApiKey) : null, householdId]
  );
  return true;
}

export async function setHouseholdAnthropicMode(householdId, mode) {
  await run(`UPDATE households SET anthropic_key_mode = ? WHERE id = ?`, [String(mode || 'shared'), householdId]);
  return true;
}

export async function setHouseholdAnthropicApiKey(householdId, anthropicApiKey) {
  await run(`UPDATE households SET anthropic_api_key = ? WHERE id = ?`, [anthropicApiKey ? String(anthropicApiKey) : null, householdId]);
  return true;
}

export async function setHouseholdWebSearchEnabled(householdId, enabled) {
  await run(`UPDATE households SET web_search_enabled = ? WHERE id = ?`, [enabled ? 1 : 0, householdId]);
  return true;
}

export async function listHouseholdUsers(householdId) {
  return await all(
    `SELECT id, household_id, display_name, role, pin_hash, chat_color, palette, session_version, created_at
     FROM household_users
     WHERE household_id = ?
     ORDER BY created_at ASC, id ASC`,
    [householdId]
  );
}

export async function createHouseholdWithInitialOwner({ householdName, householdKey, ownerDisplayName, pin }) {
  const normalizedKey = normalizeHouseholdKey(householdKey);
  if (!isValidHouseholdKeyFormat(normalizedKey)) throw new Error('invalid_household_key');
  const result = await run(
    `INSERT INTO households (name, household_key) VALUES (?, ?)`,
    [String(householdName).trim(), normalizedKey]
  );
  const householdId = Number(result.lastID);
  const userResult = await run(
    `INSERT INTO household_users (household_id, display_name, role, pin_hash, chat_color)
     VALUES (?, ?, 'owner', ?, 'blue')`,
    [householdId, String(ownerDisplayName).trim(), hashPin(String(pin ?? ''))]
  );
  return {
    householdId,
    userId: Number(userResult.lastID),
  };
}

export async function bootstrapFirstHousehold(args) {
  return await createHouseholdWithInitialOwner(args);
}

export async function listAllHouseholdsSummary() {
  const rows = await all(
    `SELECT id, name, household_key, anthropic_key_mode, anthropic_api_key, web_search_enabled, created_at
     FROM households
     ORDER BY id ASC`
  );
  return rows.map(mapHouseholdRow);
}

export async function listHouseholdDebugSummary() {
  const rows = await all(
    `SELECT
       h.id,
       h.name,
       h.household_key,
       COUNT(DISTINCT c.id) AS chat_count,
       COUNT(DISTINCT ce.id) AS cookbook_count
     FROM households h
     LEFT JOIN chats c ON c.household_id = h.id
     LEFT JOIN cookbook_entries ce ON ce.household_id = h.id
     GROUP BY h.id, h.name, h.household_key
     ORDER BY h.id ASC`
  );
  return rows.map((row) => ({
    id: Number(row.id),
    name: String(row.name ?? ''),
    householdKey: String(row.household_key ?? ''),
    chatCount: Number(row.chat_count ?? 0),
    cookbookCount: Number(row.cookbook_count ?? 0),
  }));
}

function mapHouseholdRow(row) {
  if (!row) return null;
  const webSearchEnabled = Number(row.web_search_enabled ?? 0) === 1;
  return {
    ...row,
    id: Number(row.id),
    householdKey: row.household_key,
    anthropicKeyMode: row.anthropic_key_mode,
    anthropicApiKey: row.anthropic_api_key,
    webSearchEnabled,
    createdAt: row.created_at,
  };
}

export async function getUserByHouseholdAndDisplayName(householdId, displayName) {
  return await get(
    `SELECT id, household_id, display_name, role, pin_hash, chat_color, palette, session_version, created_at
     FROM household_users
     WHERE household_id = ? AND lower(display_name) = lower(?)
     LIMIT 1`,
    [householdId, String(displayName ?? '').trim()]
  );
}

export async function getHouseholdUserById(householdId, userId) {
  return await get(
    `SELECT id, household_id, display_name, role, pin_hash, chat_color, palette, session_version, created_at
     FROM household_users
     WHERE household_id = ? AND id = ?
     LIMIT 1`,
    [householdId, userId]
  );
}

export async function createHouseholdUser(householdId, { displayName, role, pin }) {
  const normalizedRole = String(role ?? '').trim().toLowerCase();
  if (!['owner', 'member'].includes(normalizedRole)) throw new Error('invalid_role');
  const result = await run(
    `INSERT INTO household_users (household_id, display_name, role, pin_hash, chat_color)
     VALUES (?, ?, ?, ?, 'blue')`,
    [householdId, String(displayName).trim(), normalizedRole, pin ? hashPin(String(pin)) : null]
  );
  return Number(result.lastID);
}

export async function updateHouseholdUserRole(householdId, userId, role) {
  const normalizedRole = String(role ?? '').trim().toLowerCase();
  if (!['owner', 'member'].includes(normalizedRole)) throw new Error('invalid_role');
  const result = await run(
    `UPDATE household_users SET role = ? WHERE household_id = ? AND id = ?`,
    [normalizedRole, householdId, userId]
  );
  if (!Number(result.changes)) throw new Error('User not found');
  return true;
}

export async function updateHouseholdUserChatColor(householdId, userId, chatColor) {
  const result = await run(
    `UPDATE household_users SET chat_color = ? WHERE household_id = ? AND id = ?`,
    [normalizeChatColor(chatColor), householdId, userId]
  );
  if (!Number(result.changes)) throw new Error('User not found');
  return true;
}

export async function updateHouseholdUserPalette(householdId, userId, palette) {
  const result = await run(
    `UPDATE household_users SET palette = ? WHERE household_id = ? AND id = ?`,
    [normalizePalette(palette), householdId, userId]
  );
  if (!Number(result.changes)) throw new Error('User not found');
  return true;
}

export async function updateHouseholdUserPin(householdId, userId, pin) {
  const result = await run(
    `UPDATE household_users SET pin_hash = ?, session_version = session_version + 1 WHERE household_id = ? AND id = ?`,
    [pin ? hashPin(String(pin)) : null, householdId, userId]
  );
  if (!Number(result.changes)) throw new Error('User not found');
  return true;
}

export async function createChat(householdId, owner, title) {
  const result = await run(
    `INSERT INTO chats (household_id, owner, title) VALUES (?, ?, ?)`,
    [householdId, String(owner ?? '').trim(), String(title ?? 'New chat').trim() || 'New chat']
  );
  return Number(result.lastID);
}

export async function listChats(householdId, owner) {
  return await all(
    `SELECT id, household_id, owner, title, title_locked, created_at, updated_at
     FROM chats
     WHERE household_id = ? AND owner = ?
     ORDER BY updated_at DESC, id DESC`,
    [householdId, String(owner ?? '').trim()]
  );
}

export async function listAllChats(householdId) {
  return await all(
    `SELECT id, household_id, owner, title, title_locked, created_at, updated_at
     FROM chats
     WHERE household_id = ?
     ORDER BY updated_at DESC, id DESC`,
    [householdId]
  );
}

export async function touchChat(chatId, householdId) {
  await run(`UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ? AND household_id = ?`, [chatId, householdId]);
  return true;
}

export async function updateChatTitle(chatId, householdId, title) {
  await run(`UPDATE chats SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND household_id = ?`, [
    String(title ?? '').trim() || 'Chat',
    chatId,
    householdId,
  ]);
  return true;
}

export async function getChatSummary(chatId, householdId) {
  return await get(
    `SELECT id, household_id, owner, title, title_locked, created_at, updated_at
     FROM chats
     WHERE id = ? AND household_id = ?`,
    [chatId, householdId]
  );
}

export async function setChatTitleLock(chatId, householdId, locked) {
  await run(`UPDATE chats SET title_locked = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND household_id = ?`, [
    locked ? 1 : 0,
    chatId,
    householdId,
  ]);
  return true;
}

export async function deleteChatById(chatId, householdId) {
  await run(`DELETE FROM chats WHERE id = ? AND household_id = ?`, [chatId, householdId]);
  return true;
}

export async function addMessage(chatId, householdId, role, name, content) {
  const result = await run(
    `INSERT INTO messages (household_id, chat_id, role, name, content) VALUES (?, ?, ?, ?, ?)`,
    [householdId, chatId, String(role ?? '').trim(), name == null ? null : String(name), String(content ?? '')]
  );
  await touchChat(chatId, householdId).catch(() => {});
  return Number(result.lastID);
}

export async function getMessages(chatId, householdId) {
  return await all(
    `SELECT id, household_id, chat_id, role, name, content, created_at
     FROM messages
     WHERE chat_id = ? AND household_id = ?
     ORDER BY id ASC`,
    [chatId, householdId]
  );
}

export const getChatMessages = getMessages;

export async function clearMessages(chatId, householdId) {
  const result = await run(`DELETE FROM messages WHERE chat_id = ? AND household_id = ?`, [chatId, householdId]);
  return Number(result.changes) || 0;
}

export async function getHouseholdMessageStats(householdId) {
  const row = await get(
    `SELECT COUNT(*) AS total_messages, COUNT(DISTINCT chat_id) AS total_chats, MAX(created_at) AS latest_message_at
     FROM messages
     WHERE household_id = ?`,
    [householdId]
  );
  return row || { total_messages: 0, total_chats: 0 };
}

export async function getUserMessageCountsInHousehold(householdId) {
  return await all(
    `SELECT name, COUNT(*) AS message_count
     FROM messages
     WHERE household_id = ? AND role = 'user'
     GROUP BY name
     ORDER BY message_count DESC, name ASC`,
    [householdId]
  );
}

export async function addGroceryItems(householdId, items, opts = {}) {
  const rows = Array.isArray(items) ? items : [];
  let inserted = 0;
  for (const item of rows) {
    const name = String(item?.name ?? '').trim();
    if (!name) continue;
    const sectionRaw = String(item?.section ?? 'other').trim().toLowerCase() || 'other';
    const section = GROCERY_SECTION_KEYS.has(sectionRaw) ? sectionRaw : 'other';
    const amount = item?.amount == null ? '' : String(item.amount).trim();
    const probablyPantryItem = item?.probablyPantryItem === true ? 1 : 0;
    await run(
      `INSERT INTO grocery_items (household_id, name, section, amount, checked, probably_pantry_item, source_chat_id)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
      [householdId, name, section, amount, probablyPantryItem, Number.isFinite(Number(opts.sourceChatId)) ? Number(opts.sourceChatId) : null]
    );
    inserted += 1;
  }
  return inserted;
}

export async function getGroceryItems(householdId) {
  return await all(
    `SELECT id, household_id, name, section, amount, checked, probably_pantry_item, source_chat_id, created_at
     FROM grocery_items
     WHERE household_id = ?
     ORDER BY checked ASC, section ASC, lower(name) ASC, id ASC`,
    [householdId]
  );
}

export async function updateGroceryItem(householdId, id, { checked }) {
  await run(`UPDATE grocery_items SET checked = ? WHERE household_id = ? AND id = ?`, [checked ? 1 : 0, householdId, id]);
  return true;
}

export async function updateGroceryItemAmount(householdId, id, amount) {
  const result = await run(
    `UPDATE grocery_items SET amount = ? WHERE household_id = ? AND id = ? AND checked = 0`,
    [String(amount ?? '').trim(), householdId, id]
  );
  return Number(result.changes) || 0;
}

// Like updateGroceryItemAmount but WITHOUT the `checked = 0` guard. The guard on
// updateGroceryItemAmount protects the fuzzy AI-merge path from clobbering the
// amount of already-bought items during a bulk add. This variant is for an
// EXPLICIT, user-directed update (grocery.update_item) where the user is
// intentionally targeting one item, so a bought item's amount may be changed too.
export async function setGroceryItemAmount(householdId, id, amount) {
  const result = await run(
    `UPDATE grocery_items SET amount = ? WHERE household_id = ? AND id = ?`,
    [String(amount ?? '').trim(), householdId, id]
  );
  return Number(result.changes) || 0;
}

// Re-file a grocery item into a different section (explicit, brain-directed).
// Caller validates the section against GROCERY_SECTION_KEYS before calling.
export async function updateGroceryItemSection(householdId, id, section) {
  const result = await run(
    `UPDATE grocery_items SET section = ? WHERE household_id = ? AND id = ?`,
    [String(section ?? '').trim().toLowerCase(), householdId, id]
  );
  return Number(result.changes) || 0;
}

export async function updateGroceryItemProbablyPantry(householdId, id, probablyPantryItem) {
  const result = await run(
    `UPDATE grocery_items SET probably_pantry_item = ? WHERE household_id = ? AND id = ? AND checked = 0`,
    [probablyPantryItem ? 1 : 0, householdId, id]
  );
  return Number(result.changes) || 0;
}

export async function backfillGroceryItemSourceChatIfSafe(householdId, id, sourceChatId) {
  const result = await run(
    `UPDATE grocery_items SET source_chat_id = ? WHERE household_id = ? AND id = ? AND source_chat_id IS NULL`,
    [sourceChatId, householdId, id]
  );
  return Number(result.changes) || 0;
}

export async function deleteGroceryItem(householdId, id) {
  const result = await run(`DELETE FROM grocery_items WHERE household_id = ? AND id = ?`, [householdId, id]);
  return Number(result.changes) || 0;
}

export async function clearGroceryItems(householdId) {
  const result = await run(`DELETE FROM grocery_items WHERE household_id = ?`, [householdId]);
  return Number(result.changes) || 0;
}

export async function listKbMemories(householdId) {
  const rows = await all(
    `SELECT id, household_id, memory_type, label, normalized_label, summary, attributes_json, source_kind, source_chat_id, created_at, updated_at
     FROM kb_memories
     WHERE household_id = ?
     ORDER BY updated_at DESC, id DESC`,
    [householdId]
  );
  return rows.map((row) => ({
    id: Number(row.id),
    householdId: Number(row.household_id),
    memoryType: row.memory_type,
    label: row.label,
    normalizedLabel: row.normalized_label,
    summary: row.summary,
    attributes: parseJsonObject(row.attributes_json, {}),
    sourceKind: row.source_kind,
    sourceChatId: row.source_chat_id != null ? Number(row.source_chat_id) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function getKbMemoryByTypeAndLabel(householdId, memoryType, normalizedLabel) {
  const row = await get(
    `SELECT id, household_id, memory_type, label, normalized_label, summary, attributes_json, source_kind, source_chat_id, created_at, updated_at
     FROM kb_memories
     WHERE household_id = ? AND memory_type = ? AND normalized_label = ?
     LIMIT 1`,
    [householdId, String(memoryType), String(normalizedLabel)]
  );
  if (!row) return null;
  return {
    id: Number(row.id),
    householdId: Number(row.household_id),
    memoryType: row.memory_type,
    label: row.label,
    normalizedLabel: row.normalized_label,
    summary: row.summary,
    attributes: parseJsonObject(row.attributes_json, {}),
    sourceKind: row.source_kind,
    sourceChatId: row.source_chat_id != null ? Number(row.source_chat_id) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function saveKbMemory(householdId, record, opts = {}) {
  const attributesJson = JSON.stringify(record?.attributes && typeof record.attributes === 'object' ? record.attributes : {});
  const sourceKind = String(opts.sourceKind || record?.sourceKind || 'manual');
  const sourceChatId = normalizeOptionalForeignKey(opts.sourceChatId ?? record?.sourceChatId);
  if (Number.isFinite(Number(opts.id))) {
    await run(
      `UPDATE kb_memories
       SET memory_type = ?, label = ?, normalized_label = ?, summary = ?, attributes_json = ?, source_kind = ?, source_chat_id = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND household_id = ?`,
      [
        record.memoryType,
        record.label,
        record.normalizedLabel,
        record.summary,
        attributesJson,
        sourceKind,
        sourceChatId,
        Number(opts.id),
        householdId,
      ]
    );
    return Number(opts.id);
  }
  const result = await run(
    `INSERT INTO kb_memories (household_id, memory_type, label, normalized_label, summary, attributes_json, source_kind, source_chat_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [householdId, record.memoryType, record.label, record.normalizedLabel, record.summary, attributesJson, sourceKind, sourceChatId]
  );
  return Number(result.lastID);
}

export async function deleteKbMemory(householdId, id) {
  const result = await run(`DELETE FROM kb_memories WHERE household_id = ? AND id = ?`, [householdId, id]);
  return Number(result.changes) || 0;
}

export async function listCookbookEntries(householdId) {
  const rows = await all(
    `SELECT id, household_id, title, normalized_title, summary, category, recipe_type, ingredients_json,
            instructions_json, tags_json, source_book_title, source_title, source_url, notes, notes_json, source_kind,
            source_chat_id, last_used_at, created_at, updated_at
     FROM cookbook_entries
     WHERE household_id = ?
     ORDER BY COALESCE(last_used_at, updated_at) DESC, id DESC`,
    [householdId]
  );
  return rows.map((row) => ({
    id: Number(row.id),
    householdId: Number(row.household_id),
    title: row.title,
    normalizedTitle: row.normalized_title,
    summary: row.summary,
    category: row.category || '',
    recipeType: row.recipe_type,
    ingredients: parseJsonArray(row.ingredients_json, []),
    instructions: parseJsonArray(row.instructions_json, []),
    tags: parseJsonArray(row.tags_json, []),
    sourceBookTitle: row.source_book_title || '',
    sourceTitle: row.source_title || '',
    sourceUrl: row.source_url || '',
    notes: parseJsonArray(row.notes_json, row.notes ? [row.notes] : []),
    sourceKind: row.source_kind || 'manual',
    sourceChatId: row.source_chat_id != null ? Number(row.source_chat_id) : null,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function getCookbookEntryById(householdId, id) {
  const row = await get(
    `SELECT id, household_id, title, normalized_title, summary, category, recipe_type, ingredients_json,
            instructions_json, tags_json, source_book_title, source_title, source_url, notes, notes_json, source_kind,
            source_chat_id, last_used_at, created_at, updated_at
     FROM cookbook_entries
     WHERE household_id = ? AND id = ?
     LIMIT 1`,
    [householdId, id]
  );
  if (!row) return null;
  return {
    id: Number(row.id),
    householdId: Number(row.household_id),
    title: row.title,
    normalizedTitle: row.normalized_title,
    summary: row.summary,
    category: row.category || '',
    recipeType: row.recipe_type,
    ingredients: parseJsonArray(row.ingredients_json, []),
    instructions: parseJsonArray(row.instructions_json, []),
    tags: parseJsonArray(row.tags_json, []),
    sourceBookTitle: row.source_book_title || '',
    sourceTitle: row.source_title || '',
    sourceUrl: row.source_url || '',
    notes: parseJsonArray(row.notes_json, row.notes ? [row.notes] : []),
    sourceKind: row.source_kind || 'manual',
    sourceChatId: row.source_chat_id != null ? Number(row.source_chat_id) : null,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRecipeImportDraftRow(row) {
  if (!row) return null;
  return {
    id: String(row.id ?? ''),
    householdId: Number(row.household_id),
    userId: Number(row.user_id),
    sourceType: String(row.source_type ?? ''),
    sourceUrl: String(row.source_url ?? ''),
    sourceTitle: String(row.source_title ?? ''),
    sourceMarkdown: String(row.source_markdown ?? ''),
    sourceText: String(row.source_text ?? ''),
    extractionStatus: String(row.extraction_status ?? 'draft'),
    warnings: parseJsonArray(row.warnings_json, []),
    recipe: parseJsonObject(row.recipe_json, {}),
    provenance: parseJsonObject(row.provenance_json, {}),
    status: String(row.status ?? 'draft'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createRecipeImportDraft(householdId, userId, draft) {
  const id = String(draft?.id ?? crypto.randomUUID()).trim();
  const sourceType = String(draft?.sourceType ?? '').trim().toLowerCase();
  const sourceUrl = String(draft?.sourceUrl ?? '').trim();
  const sourceTitle = String(draft?.sourceTitle ?? '').trim();
  const sourceMarkdown = String(draft?.sourceMarkdown ?? '');
  const sourceText = String(draft?.sourceText ?? '');
  const extractionStatus = String(draft?.extractionStatus ?? 'draft').trim() || 'draft';
  const warningsJson = JSON.stringify(Array.isArray(draft?.warnings) ? draft.warnings : []);
  const recipeJson = JSON.stringify(draft?.recipe && typeof draft.recipe === 'object' && !Array.isArray(draft.recipe) ? draft.recipe : {});
  const provenanceJson = JSON.stringify(draft?.provenance && typeof draft.provenance === 'object' && !Array.isArray(draft.provenance) ? draft.provenance : {});
  const status = String(draft?.status ?? 'draft').trim() || 'draft';

  await run(
    `INSERT INTO recipe_import_drafts (
       id, household_id, user_id, source_type, source_url, source_title, source_markdown, source_text,
       extraction_status, warnings_json, recipe_json, provenance_json, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      householdId,
      userId,
      sourceType,
      sourceUrl,
      sourceTitle,
      sourceMarkdown,
      sourceText,
      extractionStatus,
      warningsJson,
      recipeJson,
      provenanceJson,
      status,
    ]
  );
  return await getRecipeImportDraftById(householdId, userId, id);
}

export async function getRecipeImportDraftById(householdId, userId, id) {
  const row = await get(
    `SELECT id, household_id, user_id, source_type, source_url, source_title, source_markdown, source_text,
            extraction_status, warnings_json, recipe_json, provenance_json, status, created_at, updated_at
     FROM recipe_import_drafts
     WHERE household_id = ? AND user_id = ? AND id = ?
     LIMIT 1`,
    [householdId, userId, String(id ?? '').trim()]
  );
  return mapRecipeImportDraftRow(row);
}

export async function updateRecipeImportDraft(householdId, userId, id, patch = {}) {
  const existing = await getRecipeImportDraftById(householdId, userId, id);
  if (!existing) return null;
  const next = {
    ...existing,
    ...patch,
    recipe:
      patch?.recipe && typeof patch.recipe === 'object' && !Array.isArray(patch.recipe)
        ? patch.recipe
        : existing.recipe,
    provenance:
      patch?.provenance && typeof patch.provenance === 'object' && !Array.isArray(patch.provenance)
        ? patch.provenance
        : existing.provenance,
    warnings: Array.isArray(patch?.warnings) ? patch.warnings : existing.warnings,
  };
  await run(
    `UPDATE recipe_import_drafts
     SET source_type = ?,
         source_url = ?,
         source_title = ?,
         source_markdown = ?,
         source_text = ?,
         extraction_status = ?,
         warnings_json = ?,
         recipe_json = ?,
         provenance_json = ?,
         status = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE household_id = ? AND user_id = ? AND id = ?`,
    [
      String(next.sourceType ?? '').trim().toLowerCase(),
      String(next.sourceUrl ?? '').trim(),
      String(next.sourceTitle ?? '').trim(),
      String(next.sourceMarkdown ?? ''),
      String(next.sourceText ?? ''),
      String(next.extractionStatus ?? 'draft').trim() || 'draft',
      JSON.stringify(Array.isArray(next.warnings) ? next.warnings : []),
      JSON.stringify(next.recipe && typeof next.recipe === 'object' && !Array.isArray(next.recipe) ? next.recipe : {}),
      JSON.stringify(next.provenance && typeof next.provenance === 'object' && !Array.isArray(next.provenance) ? next.provenance : {}),
      String(next.status ?? 'draft').trim() || 'draft',
      householdId,
      userId,
      String(id ?? '').trim(),
    ]
  );
  return await getRecipeImportDraftById(householdId, userId, id);
}

export async function deleteRecipeImportDraft(householdId, userId, id) {
  const result = await run(
    `DELETE FROM recipe_import_drafts WHERE household_id = ? AND user_id = ? AND id = ?`,
    [householdId, userId, String(id ?? '').trim()]
  );
  return Number(result.changes) || 0;
}

export async function getCookbookEntryByNormalizedTitle(householdId, normalizedTitle) {
  const row = await get(
    `SELECT id, household_id, title, normalized_title, summary, category, recipe_type, ingredients_json,
            instructions_json, tags_json, source_book_title, source_title, source_url, notes, notes_json, source_kind,
            source_chat_id, last_used_at, created_at, updated_at
     FROM cookbook_entries
     WHERE household_id = ? AND normalized_title = ?
     LIMIT 1`,
    [householdId, normalizedTitle]
  );
  if (!row) return null;
  return {
    id: Number(row.id),
    householdId: Number(row.household_id),
    title: row.title,
    normalizedTitle: row.normalized_title,
    summary: row.summary,
    category: row.category || '',
    recipeType: row.recipe_type,
    ingredients: parseJsonArray(row.ingredients_json, []),
    instructions: parseJsonArray(row.instructions_json, []),
    tags: parseJsonArray(row.tags_json, []),
    sourceBookTitle: row.source_book_title || '',
    sourceTitle: row.source_title || '',
    sourceUrl: row.source_url || '',
    notes: parseJsonArray(row.notes_json, row.notes ? [row.notes] : []),
    sourceKind: row.source_kind || 'manual',
    sourceChatId: row.source_chat_id != null ? Number(row.source_chat_id) : null,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getCookbookEntryBySourceUrl(householdId, sourceUrl) {
  const normalizedUrl = String(sourceUrl ?? '').trim();
  if (!normalizedUrl) return null;
  const row = await get(
    `SELECT id, household_id, title, normalized_title, summary, category, recipe_type, ingredients_json,
            instructions_json, tags_json, source_book_title, source_title, source_url, notes, notes_json, source_kind,
            source_chat_id, last_used_at, created_at, updated_at
     FROM cookbook_entries
     WHERE household_id = ? AND source_url = ?
     LIMIT 1`,
    [householdId, normalizedUrl]
  );
  if (!row) return null;
  return {
    id: Number(row.id),
    householdId: Number(row.household_id),
    title: row.title,
    normalizedTitle: row.normalized_title,
    summary: row.summary,
    category: row.category || '',
    recipeType: row.recipe_type,
    ingredients: parseJsonArray(row.ingredients_json, []),
    instructions: parseJsonArray(row.instructions_json, []),
    tags: parseJsonArray(row.tags_json, []),
    sourceBookTitle: row.source_book_title || '',
    sourceTitle: row.source_title || '',
    sourceUrl: row.source_url || '',
    notes: parseJsonArray(row.notes_json, row.notes ? [row.notes] : []),
    sourceKind: row.source_kind || 'manual',
    sourceChatId: row.source_chat_id != null ? Number(row.source_chat_id) : null,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listCookbookSourceBookTitles(householdId) {
  const rows = await all(
    `SELECT DISTINCT source_book_title
     FROM cookbook_entries
     WHERE household_id = ? AND COALESCE(TRIM(source_book_title), '') != ''
     ORDER BY LOWER(TRIM(source_book_title)) ASC`,
    [householdId]
  );
  return rows
    .map((row) => String(row?.source_book_title ?? '').trim())
    .filter(Boolean);
}

export async function saveCookbookEntry(householdId, record, opts = {}) {
  const ingredientsJson = JSON.stringify(Array.isArray(record?.ingredients) ? record.ingredients : []);
  const instructionsJson = JSON.stringify(Array.isArray(record?.instructions) ? record.instructions : []);
  const tagsJson = JSON.stringify(Array.isArray(record?.tags) ? record.tags : []);
  const notesList = Array.isArray(record?.notes) ? record.notes : record?.notes ? [String(record.notes)] : [];
  const notesJson = JSON.stringify(notesList);
  const notesText = notesList.join(' | ');
  const sourceKind = String(opts.sourceKind || record?.sourceKind || 'manual');
  const sourceChatId = normalizeOptionalForeignKey(opts.sourceChatId ?? record?.sourceChatId);
  const lastUsedAt =
    opts.lastUsedAt === undefined
      ? record?.lastUsedAt ?? null
      : opts.lastUsedAt == null
        ? null
        : String(opts.lastUsedAt);
  if (Number.isFinite(Number(opts.id))) {
    await run(
      `UPDATE cookbook_entries
       SET title = ?, normalized_title = ?, summary = ?, category = ?, recipe_type = ?, ingredients_json = ?,
           instructions_json = ?, tags_json = ?, source_book_title = ?, source_title = ?, source_url = ?, notes = ?, notes_json = ?,
           source_kind = ?, source_chat_id = ?, last_used_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND household_id = ?`,
      [
        record.title,
        record.normalizedTitle,
        record.summary,
        record.category || null,
        record.recipeType,
        ingredientsJson,
        instructionsJson,
        tagsJson,
        record.sourceBookTitle || null,
        record.sourceTitle || null,
        record.sourceUrl || null,
        notesText || null,
        notesJson,
        sourceKind,
        sourceChatId,
        lastUsedAt,
        Number(opts.id),
        householdId,
      ]
    );
    return Number(opts.id);
  }
  const result = await run(
    `INSERT INTO cookbook_entries (
       household_id, title, normalized_title, summary, category, recipe_type, ingredients_json,
       instructions_json, tags_json, source_book_title, source_title, source_url, notes, notes_json, source_kind,
       source_chat_id, last_used_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      householdId,
      record.title,
      record.normalizedTitle,
      record.summary,
      record.category || null,
      record.recipeType,
      ingredientsJson,
      instructionsJson,
      tagsJson,
      record.sourceBookTitle || null,
      record.sourceTitle || null,
      record.sourceUrl || null,
      notesText || null,
      notesJson,
      sourceKind,
      sourceChatId,
      lastUsedAt,
    ]
  );
  return Number(result.lastID);
}

export async function deleteCookbookEntry(householdId, id) {
  const result = await run(`DELETE FROM cookbook_entries WHERE household_id = ? AND id = ?`, [
    householdId,
    id,
  ]);
  return Number(result.changes) || 0;
}

export async function touchCookbookEntryUsed(householdId, id) {
  await run(
    `UPDATE cookbook_entries
     SET last_used_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE household_id = ? AND id = ?`,
    [householdId, id]
  );
}

function normalizePantryItems(items) {
  const seen = new Set();
  const normalized = [];
  for (const item of Array.isArray(items) ? items : []) {
    const text = String(item ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .slice(0, 80);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    normalized.push(text);
  }
  return normalized.slice(0, 80);
}

function normalizeWeeknightCookingStyle(style) {
  const value = String(style ?? '').trim().toLowerCase();
  return ['easy', 'normal', 'ambitious'].includes(value) ? value : null;
}

function mapHouseholdDefaultsRow(row) {
  if (!row) {
    return {
      defaultDinnerPortions: null,
      weeknightCookingStyle: 'normal',
      assistantName: DEFAULT_ASSISTANT_NAME,
      assistantTone: DEFAULT_ASSISTANT_TONE,
    };
  }
  return {
    defaultDinnerPortions:
      row.default_dinner_portions == null || !Number.isFinite(Number(row.default_dinner_portions))
        ? null
        : Number(row.default_dinner_portions),
    weeknightCookingStyle: normalizeWeeknightCookingStyle(row.weeknight_cooking_style) || 'normal',
    assistantName: normalizeAssistantName(row.assistant_name),
    assistantTone: normalizeAssistantTone(row.assistant_tone),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getHouseholdDefaults(householdId) {
  const row = await get(
    `SELECT household_id, assumed_pantry_items_json, default_dinner_portions, weeknight_cooking_style,
            assistant_name, assistant_tone, created_at, updated_at
     FROM household_defaults
     WHERE household_id = ?
     LIMIT 1`,
    [householdId]
  );
  return mapHouseholdDefaultsRow(row);
}

export async function saveHouseholdDefaults(householdId, defaults = {}) {
  const current = await getHouseholdDefaults(householdId);
  const defaultDinnerPortions =
    defaults.defaultDinnerPortions === undefined
      ? current.defaultDinnerPortions
      : defaults.defaultDinnerPortions == null || defaults.defaultDinnerPortions === ''
        ? null
        : Math.max(1, Math.min(24, Number(defaults.defaultDinnerPortions) || 0)) || null;
  const weeknightCookingStyle =
    defaults.weeknightCookingStyle === undefined
      ? current.weeknightCookingStyle
      : normalizeWeeknightCookingStyle(defaults.weeknightCookingStyle);
  const assistantName =
    defaults.assistantName === undefined
      ? current.assistantName
      : normalizeAssistantName(defaults.assistantName);
  const assistantTone =
    defaults.assistantTone === undefined
      ? current.assistantTone
      : normalizeAssistantTone(defaults.assistantTone);

  await run(
    `INSERT INTO household_defaults (
       household_id, assumed_pantry_items_json, default_dinner_portions, weeknight_cooking_style,
       assistant_name, assistant_tone, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(household_id) DO UPDATE SET
       assumed_pantry_items_json = excluded.assumed_pantry_items_json,
       default_dinner_portions = excluded.default_dinner_portions,
       weeknight_cooking_style = excluded.weeknight_cooking_style,
       assistant_name = excluded.assistant_name,
       assistant_tone = excluded.assistant_tone,
       updated_at = CURRENT_TIMESTAMP`,
    [
      householdId,
      '[]',
      defaultDinnerPortions,
      weeknightCookingStyle,
      assistantName,
      assistantTone,
    ]
  );
  return getHouseholdDefaults(householdId);
}

function mapPantryItemRow(row) {
  return {
    id: Number(row.id),
    householdId: Number(row.household_id),
    name: row.name,
    normalizedName: row.normalized_name,
    section: row.section,
    amount: row.amount || '',
    createdAt: row.created_at,
  };
}

export async function getPantryItems(householdId) {
  const rows = await all(
    `SELECT id, household_id, name, normalized_name, section, amount, created_at
     FROM pantry_items
     WHERE household_id = ?
     ORDER BY section ASC, lower(name) ASC, id ASC`,
    [householdId]
  );
  return rows.map(mapPantryItemRow);
}

export async function addPantryItems(householdId, items) {
  const rows = Array.isArray(items) ? items : [];
  let inserted = 0;
  for (const item of rows) {
    const name = String(item?.name ?? '').trim();
    if (!name) continue;
    const normalizedName = normalizeInventoryNameKey(name);
    if (!normalizedName) continue;
    const sectionRaw = String(item?.section ?? 'other_pantry').trim().toLowerCase();
    const section = PANTRY_SECTION_KEYS.has(sectionRaw) ? sectionRaw : 'other_pantry';
    const amount = item?.amount == null ? '' : String(item.amount).trim();
    const result = await run(
      `INSERT OR IGNORE INTO pantry_items (household_id, name, normalized_name, section, amount)
       VALUES (?, ?, ?, ?, ?)`,
      [householdId, name, normalizedName, section, amount]
    );
    inserted += Number(result.changes) || 0;
  }
  return inserted;
}

export async function deletePantryItem(householdId, id) {
  const result = await run(`DELETE FROM pantry_items WHERE household_id = ? AND id = ?`, [householdId, id]);
  return Number(result.changes) || 0;
}

// Re-file a pantry item into a different section (explicit, user/brain-directed —
// no auto-classifier involved). normalizePantrySection keeps it to a valid section.
export async function updatePantryItemSection(householdId, id, section, name = '') {
  const result = await run(
    `UPDATE pantry_items SET section = ? WHERE household_id = ? AND id = ?`,
    [normalizePantrySection(section, name), householdId, id]
  );
  return Number(result.changes) || 0;
}

export async function findPantryItemById(householdId, id) {
  const row = await get(
    `SELECT id, household_id, name, normalized_name, section, amount, created_at
     FROM pantry_items
     WHERE household_id = ? AND id = ?
     LIMIT 1`,
    [householdId, id]
  );
  return row ? mapPantryItemRow(row) : null;
}

// ── This Week's meal plan (per-chat = per-week thread) ──────────────────────────
// A first-class, user-visible object the brain writes and reads via tools — the
// durable spine of a long week-long thread so day-1 meals stay reference-able.
function mapMealPlanItemRow(row) {
  return {
    id: row.id,
    householdId: row.household_id,
    chatId: row.chat_id,
    name: row.name,
    normalizedName: row.normalized_name,
    cookbookEntryId: row.cookbook_entry_id == null ? null : Number(row.cookbook_entry_id),
    cookbookTitle: row.cookbook_title == null ? '' : String(row.cookbook_title),
    note: row.note == null ? '' : String(row.note),
    status: row.status || 'planned',
    position: Number(row.position) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getMealPlanItems(householdId, chatId) {
  const rows = await all(
    `SELECT m.id, m.household_id, m.chat_id, m.name, m.normalized_name, m.cookbook_entry_id,
            c.title AS cookbook_title, m.note, m.status, m.position, m.created_at, m.updated_at
     FROM meal_plan_items m
     LEFT JOIN cookbook_entries c ON c.id = m.cookbook_entry_id AND c.household_id = m.household_id
     WHERE m.household_id = ? AND m.chat_id = ?
     ORDER BY m.position ASC, m.id ASC`,
    [householdId, chatId]
  );
  return rows.map(mapMealPlanItemRow);
}

export async function addMealPlanItems(householdId, chatId, items) {
  const rows = Array.isArray(items) ? items : [];
  const maxRow = await get(
    `SELECT COALESCE(MAX(position), -1) AS maxPos FROM meal_plan_items WHERE household_id = ? AND chat_id = ?`,
    [householdId, chatId]
  );
  let position = (Number(maxRow?.maxPos) || -1) + 1;
  let inserted = 0;
  for (const item of rows) {
    const name = String(item?.name ?? '').trim();
    if (!name) continue;
    const normalizedName = normalizeInventoryNameKey(name);
    if (!normalizedName) continue;
    const note = item?.note == null ? '' : String(item.note).trim();
    const cookbookEntryId =
      Number.isFinite(Number(item?.cookbookEntryId)) && Number(item.cookbookEntryId) > 0 ? Number(item.cookbookEntryId) : null;
    const status = String(item?.status ?? 'planned').trim().toLowerCase() === 'cooked' ? 'cooked' : 'planned';
    const result = await run(
      `INSERT OR IGNORE INTO meal_plan_items (household_id, chat_id, name, normalized_name, cookbook_entry_id, note, status, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [householdId, chatId, name, normalizedName, cookbookEntryId, note, status, position]
    );
    if ((Number(result.changes) || 0) > 0) {
      inserted += 1;
      position += 1;
    }
  }
  return inserted;
}

export async function findMealPlanItemByName(householdId, chatId, name) {
  const normalizedName = normalizeInventoryNameKey(String(name ?? ''));
  if (!normalizedName) return null;
  const rows = await getMealPlanItems(householdId, chatId);
  return rows.find((item) => item.normalizedName === normalizedName) || null;
}

export async function updateMealPlanItem(householdId, chatId, id, fields = {}) {
  const sets = [];
  const params = [];
  if (typeof fields.name === 'string' && fields.name.trim()) {
    sets.push('name = ?', 'normalized_name = ?');
    params.push(fields.name.trim(), normalizeInventoryNameKey(fields.name));
  }
  if (typeof fields.status === 'string' && fields.status.trim()) {
    sets.push('status = ?');
    params.push(fields.status.trim().toLowerCase() === 'cooked' ? 'cooked' : 'planned');
  }
  if (fields.note != null) {
    sets.push('note = ?');
    params.push(String(fields.note).trim());
  }
  if (fields.cookbookEntryId !== undefined) {
    sets.push('cookbook_entry_id = ?');
    params.push(
      Number.isFinite(Number(fields.cookbookEntryId)) && Number(fields.cookbookEntryId) > 0 ? Number(fields.cookbookEntryId) : null
    );
  }
  if (sets.length === 0) return 0;
  sets.push('updated_at = CURRENT_TIMESTAMP');
  const result = await run(
    `UPDATE meal_plan_items SET ${sets.join(', ')} WHERE household_id = ? AND chat_id = ? AND id = ?`,
    [...params, householdId, chatId, id]
  );
  return Number(result.changes) || 0;
}

export async function deleteMealPlanItem(householdId, chatId, id) {
  const result = await run(`DELETE FROM meal_plan_items WHERE household_id = ? AND chat_id = ? AND id = ?`, [
    householdId,
    chatId,
    id,
  ]);
  return Number(result.changes) || 0;
}

export async function clearMealPlan(householdId, chatId) {
  const result = await run(`DELETE FROM meal_plan_items WHERE household_id = ? AND chat_id = ?`, [householdId, chatId]);
  return Number(result.changes) || 0;
}

// ── Structured per-person profiles ──────────────────────────────────────────────
// First-class, queryable food/allergy data for a household member (distinct from the
// freeform memory bucket). The brain appends via person.profile.update and reads via
// person.profile.get. Foods accumulate + dedupe; accepting a food removes it from
// rejected (and vice versa) so a kid's flipping tastes stay consistent over time.
function normalizePersonKey(raw) {
  return String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function toStringList(raw) {
  const source = Array.isArray(raw) ? raw : raw == null || raw === '' ? [] : [raw];
  return source.map((v) => String(v ?? '').trim()).filter(Boolean);
}

function dedupeStrings(values, limit = 60) {
  const seen = new Set();
  const out = [];
  for (const v of Array.isArray(values) ? values : []) {
    const t = String(v ?? '').trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

function mapPersonProfileRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    householdId: row.household_id,
    person: row.person,
    normalizedPerson: row.normalized_person,
    acceptedFoods: parseJsonArray(row.accepted_foods_json, []),
    rejectedFoods: parseJsonArray(row.rejected_foods_json, []),
    allergies: parseJsonArray(row.allergies_json, []),
    notes: parseJsonArray(row.notes_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getPersonProfile(householdId, person) {
  const norm = normalizePersonKey(person);
  if (!norm) return null;
  const row = await get(
    `SELECT id, household_id, person, normalized_person, accepted_foods_json, rejected_foods_json,
            allergies_json, notes_json, created_at, updated_at
     FROM person_profiles WHERE household_id = ? AND normalized_person = ? LIMIT 1`,
    [householdId, norm]
  );
  return mapPersonProfileRow(row);
}

export async function listPersonProfiles(householdId) {
  const rows = await all(
    `SELECT id, household_id, person, normalized_person, accepted_foods_json, rejected_foods_json,
            allergies_json, notes_json, created_at, updated_at
     FROM person_profiles WHERE household_id = ? ORDER BY lower(person) ASC`,
    [householdId]
  );
  return rows.map(mapPersonProfileRow);
}

const PERSON_PROFILE_FIELD_COLUMNS = {
  acceptedFoods: 'accepted_foods_json',
  rejectedFoods: 'rejected_foods_json',
  allergies: 'allergies_json',
  notes: 'notes_json',
};

// Remove one value from one list on a person's profile (UI edit). Returns the updated profile.
export async function removePersonProfileValue(householdId, person, field, value) {
  const column = PERSON_PROFILE_FIELD_COLUMNS[field];
  if (!column) return null;
  const norm = normalizePersonKey(person);
  const existing = await getPersonProfile(householdId, person);
  if (!norm || !existing) return existing || null;
  const target = String(value ?? '').trim().toLowerCase();
  const next = (existing[field] || []).filter((v) => String(v).trim().toLowerCase() !== target);
  await run(
    `UPDATE person_profiles SET ${column} = ?, updated_at = CURRENT_TIMESTAMP
     WHERE household_id = ? AND normalized_person = ?`,
    [JSON.stringify(next), householdId, norm]
  );
  return await getPersonProfile(householdId, person);
}

// Append food/allergy/notes facts for a person. Returns the merged profile.
export async function updatePersonProfile(householdId, person, fields = {}) {
  const name = String(person ?? '').trim();
  const norm = normalizePersonKey(name);
  if (!norm) return null;
  const existing = await getPersonProfile(householdId, name);
  const base = existing || { acceptedFoods: [], rejectedFoods: [], allergies: [], notes: [] };

  const addedAccepted = toStringList(fields.acceptedFoods);
  const addedRejected = toStringList(fields.rejectedFoods);
  const newlyAccepted = new Set(addedAccepted.map((f) => f.toLowerCase()));
  const newlyRejected = new Set(addedRejected.map((f) => f.toLowerCase()));

  let acceptedFoods = dedupeStrings([...base.acceptedFoods, ...addedAccepted]);
  let rejectedFoods = dedupeStrings([...base.rejectedFoods, ...addedRejected]);
  // A food can't be both. The most recent statement wins.
  rejectedFoods = rejectedFoods.filter((f) => !newlyAccepted.has(f.toLowerCase()));
  acceptedFoods = acceptedFoods.filter((f) => !newlyRejected.has(f.toLowerCase()));

  const allergies = dedupeStrings([...base.allergies, ...toStringList(fields.allergies)]);
  const notes = dedupeStrings([...base.notes, ...toStringList(fields.notes ?? fields.note)]);

  if (existing) {
    await run(
      `UPDATE person_profiles
       SET person = ?, accepted_foods_json = ?, rejected_foods_json = ?, allergies_json = ?, notes_json = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE household_id = ? AND normalized_person = ?`,
      [
        name || existing.person,
        JSON.stringify(acceptedFoods),
        JSON.stringify(rejectedFoods),
        JSON.stringify(allergies),
        JSON.stringify(notes),
        householdId,
        norm,
      ]
    );
  } else {
    await run(
      `INSERT INTO person_profiles
         (household_id, person, normalized_person, accepted_foods_json, rejected_foods_json, allergies_json, notes_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        householdId,
        name,
        norm,
        JSON.stringify(acceptedFoods),
        JSON.stringify(rejectedFoods),
        JSON.stringify(allergies),
        JSON.stringify(notes),
      ]
    );
  }
  return await getPersonProfile(householdId, name);
}

export async function getChatRuntimeState(chatId, householdId) {
  const row = await get(
    `SELECT chat_id, household_id, mode, working_context_json, updated_at
     FROM chat_runtime_state
     WHERE chat_id = ? AND household_id = ?
     LIMIT 1`,
    [chatId, householdId]
  );
  if (!row) return { mode: 'kb', workingContext: null };
  const workingContext = parseJsonObject(row.working_context_json, {});
  return {
    mode: row.mode || 'kb',
    workingContext: workingContext && Object.keys(workingContext).length > 0 ? workingContext : null,
    updatedAt: row.updated_at,
  };
}

export async function setChatRuntimeState(chatId, householdId, state = {}) {
  const mode = String(state.mode || 'kb');
  const workingContext =
    state.workingContext && typeof state.workingContext === 'object' && !Array.isArray(state.workingContext)
      ? state.workingContext
      : {};
  // NOTE: the proposed_next_action_json column is retained (NOT NULL DEFAULT '{}') but no longer
  // read or written — the next-action state machine was removed. Left inert to avoid a migration;
  // it keeps its '{}' default on every row.
  await run(
    `INSERT INTO chat_runtime_state (chat_id, household_id, mode, working_context_json, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(chat_id) DO UPDATE SET
       household_id = excluded.household_id,
       mode = excluded.mode,
       working_context_json = excluded.working_context_json,
       updated_at = CURRENT_TIMESTAMP`,
    [chatId, householdId, mode, JSON.stringify(workingContext)]
  );
  return true;
}

export async function clearChatRuntimeState(chatId, householdId) {
  await run(`DELETE FROM chat_runtime_state WHERE chat_id = ? AND household_id = ?`, [chatId, householdId]);
  return true;
}

export async function insertAnthropicUsageLedgerRow(row) {
  const result = await run(
    `INSERT INTO anthropic_usage_ledger (
       household_id, chat_id, runtime_enabled, turn_id, action_capability, action_query, prompt_hash, prompt_excerpt,
       call_surface, call_purpose, model, request_kind,
       input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
       web_search_enabled_at_call, used_web_search_tool
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(row.householdId),
      normalizeOptionalForeignKey(row.chatId),
      row.runtimeEnabled === false ? 0 : 1,
      row.turnId != null ? String(row.turnId) : null,
      row.actionCapability != null ? String(row.actionCapability) : null,
      row.actionQuery != null ? String(row.actionQuery) : null,
      row.promptHash != null ? String(row.promptHash) : null,
      row.promptExcerpt != null ? String(row.promptExcerpt) : null,
      String(row.callSurface || 'background'),
      String(row.callPurpose || 'unknown'),
      normalizeUsageLedgerModel(row.model, row.callPurpose),
      String(row.requestKind || 'create'),
      Number(row.inputTokens ?? 0) || 0,
      Number(row.outputTokens ?? 0) || 0,
      row.cacheCreationInputTokens == null ? null : Number(row.cacheCreationInputTokens),
      row.cacheReadInputTokens == null ? null : Number(row.cacheReadInputTokens),
      row.webSearchEnabledAtCall ? 1 : 0,
      row.usedWebSearchTool ? 1 : 0,
    ]
  );
  return Number(result.lastID);
}

export async function getAnthropicUsageLedgerAllRows(filters = {}) {
  const clauses = [];
  const params = [];
  if (filters.householdId != null) {
    clauses.push(`household_id = ?`);
    params.push(Number(filters.householdId));
  }
  if (filters.startDate) {
    clauses.push(`created_at >= ?`);
    params.push(String(filters.startDate));
  }
  if (filters.endDate) {
    clauses.push(`created_at < ?`);
    params.push(String(filters.endDate));
  }
  if (filters.callPurpose) {
    clauses.push(`call_purpose = ?`);
    params.push(String(filters.callPurpose));
  }
  if (filters.callSurface) {
    clauses.push(`call_surface = ?`);
    params.push(String(filters.callSurface));
  }
  if (typeof filters.webSearchEnabledAtCall === 'boolean') {
    clauses.push(`web_search_enabled_at_call = ?`);
    params.push(filters.webSearchEnabledAtCall ? 1 : 0);
  }
  if (typeof filters.usedWebSearchTool === 'boolean') {
    clauses.push(`used_web_search_tool = ?`);
    params.push(filters.usedWebSearchTool ? 1 : 0);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return await all(
    `SELECT id, created_at, household_id, chat_id, runtime_enabled, turn_id, action_capability, action_query, prompt_hash, prompt_excerpt,
            call_surface, call_purpose, model, request_kind,
            input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
            web_search_enabled_at_call, used_web_search_tool
     FROM anthropic_usage_ledger
     ${where}
     ORDER BY created_at DESC, id DESC`,
    params
  );
}
