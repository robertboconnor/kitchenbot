import sqlite3 from 'sqlite3';
import crypto from 'crypto';
import {
  GROCERY_SECTION_KEYS,
  PANTRY_SECTION_KEYS,
  normalizePantrySection,
} from './inventory-classification.mjs';
import { normalizeInventoryNameKey } from './inventory-service.mjs';

const dbPath = process.env.DB_PATH || './kitchenbot.db';
const db = new sqlite3.Database(dbPath);

const SCRYPT_KEY_LEN = 64;
const HOUSEHOLD_KEY_PATTERN = /^[a-z0-9-]+$/;

export const CHAT_COLOR_KEYS = new Set(['pink', 'blue', 'mint', 'lavender', 'peach']);
export const DEFAULT_CHAT_COLOR = 'blue';

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
      session_version INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(household_id, display_name)
    );

    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      owner TEXT NOT NULL,
      title TEXT NOT NULL,
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
      source_chat_id INTEGER NULL REFERENCES chats(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
  `);

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
    `SELECT id, household_id, display_name, role, pin_hash, chat_color, session_version, created_at
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
    `SELECT id, household_id, display_name, role, pin_hash, chat_color, session_version, created_at
     FROM household_users
     WHERE household_id = ? AND lower(display_name) = lower(?)
     LIMIT 1`,
    [householdId, String(displayName ?? '').trim()]
  );
}

export async function getHouseholdUserById(householdId, userId) {
  return await get(
    `SELECT id, household_id, display_name, role, pin_hash, chat_color, session_version, created_at
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
    `SELECT id, household_id, owner, title, created_at, updated_at
     FROM chats
     WHERE household_id = ? AND owner = ?
     ORDER BY updated_at DESC, id DESC`,
    [householdId, String(owner ?? '').trim()]
  );
}

export async function listAllChats(householdId) {
  return await all(
    `SELECT id, household_id, owner, title, created_at, updated_at
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

export async function clearMessages(chatId, householdId) {
  const result = await run(`DELETE FROM messages WHERE chat_id = ? AND household_id = ?`, [chatId, householdId]);
  return Number(result.changes) || 0;
}

export async function getHouseholdMessageStats(householdId) {
  const row = await get(
    `SELECT COUNT(*) AS total_messages, COUNT(DISTINCT chat_id) AS total_chats
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
    await run(
      `INSERT INTO grocery_items (household_id, name, section, amount, checked, source_chat_id)
       VALUES (?, ?, ?, ?, 0, ?)`,
      [householdId, name, section, amount, Number.isFinite(Number(opts.sourceChatId)) ? Number(opts.sourceChatId) : null]
    );
    inserted += 1;
  }
  return inserted;
}

export async function getGroceryItems(householdId) {
  return await all(
    `SELECT id, household_id, name, section, amount, checked, source_chat_id, created_at
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

export async function pruneStaleGroceryItemsForChat(householdId, keepKeysRaw) {
  const keepKeys = new Set(Array.isArray(keepKeysRaw) ? keepKeysRaw.map((value) => String(value)) : []);
  const existing = await getGroceryItems(householdId);
  let deleted = 0;
  for (const item of existing) {
    if (Number(item.checked) === 1) continue;
    const key = normalizeInventoryNameKey(item.name);
    if (keepKeys.has(key)) continue;
    deleted += await deleteGroceryItem(householdId, item.id);
  }
  return deleted;
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
  const sourceChatId = Number.isFinite(Number(opts.sourceChatId ?? record?.sourceChatId))
    ? Number(opts.sourceChatId ?? record.sourceChatId)
    : null;
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
      weeknightCookingStyle: null,
    };
  }
  return {
    defaultDinnerPortions:
      row.default_dinner_portions == null || !Number.isFinite(Number(row.default_dinner_portions))
        ? null
        : Number(row.default_dinner_portions),
    weeknightCookingStyle: normalizeWeeknightCookingStyle(row.weeknight_cooking_style),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getHouseholdDefaults(householdId) {
  const row = await get(
    `SELECT household_id, assumed_pantry_items_json, default_dinner_portions, weeknight_cooking_style, created_at, updated_at
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

  await run(
    `INSERT INTO household_defaults (
       household_id, assumed_pantry_items_json, default_dinner_portions, weeknight_cooking_style, updated_at
     ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(household_id) DO UPDATE SET
       assumed_pantry_items_json = excluded.assumed_pantry_items_json,
       default_dinner_portions = excluded.default_dinner_portions,
       weeknight_cooking_style = excluded.weeknight_cooking_style,
       updated_at = CURRENT_TIMESTAMP`,
    [
      householdId,
      '[]',
      defaultDinnerPortions,
      weeknightCookingStyle,
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

export async function getChatRuntimeState(chatId, householdId) {
  const row = await get(
    `SELECT chat_id, household_id, mode, proposed_next_action_json, working_context_json, updated_at
     FROM chat_runtime_state
     WHERE chat_id = ? AND household_id = ?
     LIMIT 1`,
    [chatId, householdId]
  );
  if (!row) return { mode: 'kb', proposedNextAction: null, workingContext: null };
  const proposed = parseJsonObject(row.proposed_next_action_json, {});
  const workingContext = parseJsonObject(row.working_context_json, {});
  return {
    mode: row.mode || 'kb',
    proposedNextAction: proposed && Object.keys(proposed).length > 0 ? proposed : null,
    workingContext: workingContext && Object.keys(workingContext).length > 0 ? workingContext : null,
    updatedAt: row.updated_at,
  };
}

export async function setChatRuntimeState(chatId, householdId, state = {}) {
  const mode = String(state.mode || 'kb');
  const proposedNextAction =
    state.proposedNextAction && typeof state.proposedNextAction === 'object' && !Array.isArray(state.proposedNextAction)
      ? state.proposedNextAction
      : {};
  const workingContext =
    state.workingContext && typeof state.workingContext === 'object' && !Array.isArray(state.workingContext)
      ? state.workingContext
      : {};
  await run(
    `INSERT INTO chat_runtime_state (chat_id, household_id, mode, proposed_next_action_json, working_context_json, updated_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(chat_id) DO UPDATE SET
       household_id = excluded.household_id,
       mode = excluded.mode,
       proposed_next_action_json = excluded.proposed_next_action_json,
       working_context_json = excluded.working_context_json,
       updated_at = CURRENT_TIMESTAMP`,
    [chatId, householdId, mode, JSON.stringify(proposedNextAction), JSON.stringify(workingContext)]
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
       household_id, chat_id, runtime_enabled, call_surface, call_purpose, model, request_kind,
       input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
       web_search_enabled_at_call, used_web_search_tool
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(row.householdId),
      row.chatId != null ? Number(row.chatId) : null,
      row.runtimeEnabled === false ? 0 : 1,
      String(row.callSurface || 'background'),
      String(row.callPurpose || 'unknown'),
      String(row.model || 'unknown'),
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
    `SELECT id, created_at, household_id, chat_id, runtime_enabled, call_surface, call_purpose, model, request_kind,
            input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
            web_search_enabled_at_call, used_web_search_tool
     FROM anthropic_usage_ledger
     ${where}
     ORDER BY created_at DESC, id DESC`,
    params
  );
}
