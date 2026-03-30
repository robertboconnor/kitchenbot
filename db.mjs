import sqlite3 from 'sqlite3';
import crypto from 'crypto';

const dbPath = process.env.DB_PATH || './kitchenbot.db';
const db = new sqlite3.Database(dbPath);

const SCRYPT_KEY_LEN = 64;

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(pin, salt, SCRYPT_KEY_LEN);
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

const HOUSEHOLD_KEY_PATTERN = /^[a-z0-9-]+$/;

/** Allowed user chat bubble color keys (must match kitchenbot palette). */
export const CHAT_COLOR_KEYS = new Set(['pink', 'blue', 'mint', 'lavender', 'peach']);
export const DEFAULT_CHAT_COLOR = 'blue';

export function normalizeChatColor(raw) {
  const k = String(raw ?? '')
    .trim()
    .toLowerCase();
  return CHAT_COLOR_KEYS.has(k) ? k : DEFAULT_CHAT_COLOR;
}

export function normalizeHouseholdKey(key) {
  return String(key ?? '').trim().toLowerCase();
}

/** @param {string} key normalized or raw */
export function isValidHouseholdKeyFormat(key) {
  const n = normalizeHouseholdKey(key);
  return n.length > 0 && n.length <= 128 && HOUSEHOLD_KEY_PATTERN.test(n);
}

export function verifyPin(pin, stored) {
  if (!stored || typeof pin !== 'string') return false;
  const parts = stored.split(':');
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

db.serialize(() => {
  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS households (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      household_key TEXT NOT NULL UNIQUE,
      anthropic_key_mode TEXT NOT NULL DEFAULT 'shared',
      anthropic_api_key TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS household_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      pin_hash TEXT,
      compliments_enabled INTEGER NOT NULL DEFAULT 0,
      chat_color TEXT NOT NULL DEFAULT 'blue',
      session_version INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(household_id, display_name)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      owner TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT,
      name TEXT,
      content TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS memories (
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (household_id, key)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS grocery_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      section TEXT NOT NULL,
      amount TEXT,
      checked INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_compliment_state (
      household_user_id INTEGER PRIMARY KEY REFERENCES household_users(id) ON DELETE CASCADE,
      messages_since_last_compliment INTEGER DEFAULT 0,
      last_compliment_timestamp TEXT,
      recent_compliments TEXT,
      recent_templates TEXT,
      boost_mode INTEGER DEFAULT 0
    )
  `);
});

/** For DB files created before chat_color existed. Safe no-op if column is present. */
export function ensureHouseholdUserChatColorColumnAsync() {
  return new Promise((resolve) => {
    db.all(`PRAGMA table_info(household_users)`, [], (err, cols) => {
      if (err) return resolve();
      if ((cols || []).some((c) => c.name === 'chat_color')) return resolve();
      db.run(
        `ALTER TABLE household_users ADD COLUMN chat_color TEXT NOT NULL DEFAULT 'blue'`,
        () => resolve()
      );
    });
  });
}

/** For DB files created before session_version existed; existing rows default to 0. */
export function ensureHouseholdUserSessionVersionColumnAsync() {
  return new Promise((resolve) => {
    db.all(`PRAGMA table_info(household_users)`, [], (err, cols) => {
      if (err) return resolve();
      if ((cols || []).some((c) => c.name === 'session_version')) return resolve();
      db.run(
        `ALTER TABLE household_users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0`,
        () => resolve()
      );
    });
  });
}

export function needsBootstrap() {
  return new Promise((resolve, reject) => {
    db.get(`SELECT COUNT(*) AS c FROM households`, [], (err, row) => {
      if (err) reject(err);
      else resolve(!row || row.c === 0);
    });
  });
}

export function getFirstHouseholdId() {
  return new Promise((resolve, reject) => {
    db.get(`SELECT id FROM households ORDER BY id ASC LIMIT 1`, [], (err, row) => {
      if (err) reject(err);
      else resolve(row ? row.id : null);
    });
  });
}

/** First owner user in the first household (by id) — global admin for this app. */
export function getGlobalAdminUserId() {
  return new Promise((resolve, reject) => {
    db.get(`SELECT id FROM households ORDER BY id ASC LIMIT 1`, [], (err, row) => {
      if (err) return reject(err);
      if (!row) return resolve(null);
      const householdId = row.id;
      db.get(
        `SELECT id FROM household_users WHERE household_id = ? AND role = 'owner' ORDER BY id ASC LIMIT 1`,
        [householdId],
        (err2, urow) => {
          if (err2) reject(err2);
          else resolve(urow ? urow.id : null);
        }
      );
    });
  });
}

export function isGlobalAdminUser(userId) {
  return getGlobalAdminUserId().then((gid) => gid != null && Number(userId) === Number(gid));
}

export function getHouseholdById(householdId) {
  return new Promise((resolve, reject) => {
    db.get(
      `
      SELECT id, name, household_key, anthropic_key_mode, anthropic_api_key, created_at
      FROM households
      WHERE id = ?
      `,
      [householdId],
      (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      }
    );
  });
}

export function getHouseholdByKey(householdKey) {
  const key = normalizeHouseholdKey(householdKey);
  if (!key) {
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    db.get(
      `
      SELECT id, name, household_key, anthropic_key_mode, anthropic_api_key, created_at
      FROM households
      WHERE household_key = ?
      `,
      [key],
      (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      }
    );
  });
}

export function updateHouseholdAnthropicSettings(householdId, { anthropicKeyMode, anthropicApiKey }) {
  return new Promise((resolve, reject) => {
    if (anthropicKeyMode === 'shared') {
      db.run(
        `UPDATE households SET anthropic_key_mode = 'shared', anthropic_api_key = NULL WHERE id = ?`,
        [householdId],
        function (err) {
          if (err) reject(err);
          else resolve();
        }
      );
    } else {
      db.run(
        `UPDATE households SET anthropic_key_mode = 'household', anthropic_api_key = ? WHERE id = ?`,
        [anthropicApiKey, householdId],
        function (err) {
          if (err) reject(err);
          else resolve();
        }
      );
    }
  });
}

/** Set mode only: shared clears key; household preserves existing key column. */
export function setHouseholdAnthropicMode(householdId, mode) {
  if (mode === 'shared') {
    return updateHouseholdAnthropicSettings(householdId, { anthropicKeyMode: 'shared', anthropicApiKey: null });
  }
  return new Promise((resolve, reject) => {
    db.run(`UPDATE households SET anthropic_key_mode = 'household' WHERE id = ?`, [householdId], function (err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

/** Only when mode is already household; used by household owners. */
export function setHouseholdAnthropicApiKey(householdId, anthropicApiKey) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE households SET anthropic_api_key = ? WHERE id = ? AND anthropic_key_mode = 'household'`,
      [anthropicApiKey, householdId],
      function (err) {
        if (err) reject(err);
        else if (this.changes === 0) reject(new Error('not_household_key_mode'));
        else resolve();
      }
    );
  });
}

export function listHouseholdUsers(householdId) {
  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT id, display_name, role, compliments_enabled, chat_color
      FROM household_users
      WHERE household_id = ?
      ORDER BY id ASC
      `,
      [householdId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

export function ensureUserComplimentStateRow(householdUserId) {
  return new Promise((resolve, reject) => {
    db.run(
      `
      INSERT OR IGNORE INTO user_compliment_state (
        household_user_id,
        messages_since_last_compliment,
        last_compliment_timestamp,
        recent_compliments,
        recent_templates,
        boost_mode
      ) VALUES (?, 0, NULL, '[]', '[]', 0)
      `,
      [householdUserId],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

export function createHouseholdWithInitialOwner({ householdName, householdKey, ownerDisplayName, pin }) {
  return new Promise((resolve, reject) => {
    const keyNorm = normalizeHouseholdKey(householdKey);
    if (!isValidHouseholdKeyFormat(keyNorm)) {
      reject(new Error('householdKey must be 1–128 chars: lowercase letters, digits, and hyphens only'));
      return;
    }
    const pinHashOwner = hashPin(pin);
    db.serialize(() => {
      db.run(
        `INSERT INTO households (name, household_key, anthropic_key_mode, anthropic_api_key) VALUES (?, ?, 'shared', NULL)`,
        [householdName, keyNorm],
        function (err) {
          if (err) {
            reject(err);
            return;
          }
          const householdId = this.lastID;
          db.run(
            `INSERT INTO household_users (household_id, display_name, role, pin_hash, compliments_enabled) VALUES (?, ?, 'owner', ?, 0)`,
            [householdId, ownerDisplayName, pinHashOwner],
            function (err2) {
              if (err2) {
                reject(err2);
                return;
              }
              const ownerUserId = this.lastID;
              ensureUserComplimentStateRow(ownerUserId)
                .then(() => {
                  db.run(
                    `
                    INSERT INTO memories (household_id, key, value) VALUES
                      (?, 'assistant_name', 'KitchenBot')
                    `,
                    [householdId],
                    (err4) => {
                      if (err4) reject(err4);
                      else resolve({ householdId, ownerUserId, householdKey: keyNorm });
                    }
                  );
                })
                .catch(reject);
            }
          );
        }
      );
    });
  });
}

/** For global admin: all households with users and Anthropic summary (no raw API keys). */
export async function listAllHouseholdsSummary() {
  const countRows = await new Promise((resolve, reject) => {
    db.all(
      `SELECT household_id, COUNT(*) AS total_messages FROM messages GROUP BY household_id`,
      [],
      (err, r) => {
        if (err) reject(err);
        else resolve(r || []);
      }
    );
  });
  const messageCountByHouseholdId = new Map();
  for (const row of countRows) {
    messageCountByHouseholdId.set(Number(row.household_id), Number(row.total_messages));
  }
  const rows = await new Promise((resolve, reject) => {
    db.all(
      `SELECT id, name, household_key, anthropic_key_mode, anthropic_api_key FROM households ORDER BY id ASC`,
      [],
      (err, r) => {
        if (err) reject(err);
        else resolve(r || []);
      }
    );
  });
  const out = [];
  for (const h of rows) {
    const users = await listHouseholdUsers(h.id);
    const mode = h.anthropic_key_mode || 'shared';
    const hasKey = !!(h.anthropic_api_key && String(h.anthropic_api_key).trim());
    let anthropicStatusLabel;
    if (mode === 'shared') {
      anthropicStatusLabel = "Rob's shared key";
    } else if (hasKey) {
      anthropicStatusLabel = 'Household key (set)';
    } else {
      anthropicStatusLabel = 'Household key (missing)';
    }
    out.push({
      id: h.id,
      name: h.name,
      householdKey: h.household_key,
      anthropicKeyMode: mode,
      hasHouseholdKey: hasKey,
      anthropicStatusLabel,
      totalMessages: messageCountByHouseholdId.get(h.id) ?? 0,
      users: users.map((u) => ({ id: u.id, displayName: u.display_name, role: u.role })),
    });
  }
  return out;
}

export function bootstrapFirstHousehold(args) {
  return createHouseholdWithInitialOwner(args);
}

/** Total rows in messages for household + latest created_at (ISO-ish string from SQLite). */
export function getHouseholdMessageStats(householdId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT COUNT(*) AS total, MAX(created_at) AS latest FROM messages WHERE household_id = ?`,
      [householdId],
      (err, row) => {
        if (err) reject(err);
        else
          resolve({
            totalMessages: row && row.total != null ? Number(row.total) : 0,
            latestMessageAt: row && row.latest != null ? String(row.latest) : null,
          });
      }
    );
  });
}

/** User messages only, grouped by display name (messages.name). */
export function getUserMessageCountsInHousehold(householdId) {
  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT name AS display_name, COUNT(*) AS c
      FROM messages
      WHERE household_id = ? AND role = 'user' AND name IS NOT NULL AND TRIM(name) != ''
      GROUP BY name
      ORDER BY name ASC
      `,
      [householdId],
      (err, rows) => {
        if (err) reject(err);
        else resolve((rows || []).map((r) => ({ displayName: r.display_name, count: Number(r.c) })));
      }
    );
  });
}

export function getUserByHouseholdAndDisplayName(householdId, displayName) {
  return new Promise((resolve, reject) => {
    db.get(
      `
      SELECT id, household_id, display_name, role, pin_hash, compliments_enabled, chat_color, session_version
      FROM household_users
      WHERE household_id = ? AND display_name = ?
      `,
      [householdId, displayName],
      (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      }
    );
  });
}

export function getHouseholdUserById(householdId, userId) {
  return new Promise((resolve, reject) => {
    db.get(
      `
      SELECT id, household_id, display_name, role, pin_hash, compliments_enabled, chat_color, session_version
      FROM household_users
      WHERE household_id = ? AND id = ?
      `,
      [householdId, userId],
      (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      }
    );
  });
}

export function createHouseholdUser(householdId, { displayName, role, pin }) {
  const pinHash = hashPin(pin);
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO household_users (household_id, display_name, role, pin_hash, compliments_enabled) VALUES (?, ?, ?, ?, 0)`,
      [householdId, displayName, role, pinHash],
      function (err) {
        if (err) {
          reject(err);
          return;
        }
        const newId = this.lastID;
        ensureUserComplimentStateRow(newId)
          .then(() => resolve(newId))
          .catch(reject);
      }
    );
  });
}

export function updateHouseholdUserComplimentsEnabled(householdId, userId, enabled) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE household_users SET compliments_enabled = ? WHERE id = ? AND household_id = ?`,
      [enabled ? 1 : 0, userId, householdId],
      function (err) {
        if (err) reject(err);
        else if (this.changes === 0) reject(new Error('User not found'));
        else resolve();
      }
    );
  });
}

export function updateHouseholdUserRole(householdId, userId, role) {
  if (role !== 'owner' && role !== 'member') {
    return Promise.reject(new Error('invalid_role'));
  }
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE household_users SET role = ? WHERE id = ? AND household_id = ?`,
      [role, userId, householdId],
      function (err) {
        if (err) reject(err);
        else if (this.changes === 0) reject(new Error('User not found'));
        else resolve();
      }
    );
  });
}

export function updateHouseholdUserChatColor(householdId, userId, chatColor) {
  const normalized = String(chatColor ?? '')
    .trim()
    .toLowerCase();
  if (!CHAT_COLOR_KEYS.has(normalized)) {
    return Promise.reject(new Error('invalid_chat_color'));
  }
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE household_users SET chat_color = ? WHERE id = ? AND household_id = ?`,
      [normalized, userId, householdId],
      function (err) {
        if (err) reject(err);
        else if (this.changes === 0) reject(new Error('User not found'));
        else resolve(normalized);
      }
    );
  });
}

export function updateHouseholdUserPin(householdId, userId, pin) {
  const pinHash = hashPin(pin);
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE household_users SET pin_hash = ?, session_version = session_version + 1 WHERE id = ? AND household_id = ?`,
      [pinHash, userId, householdId],
      function (err) {
        if (err) reject(err);
        else if (this.changes === 0) reject(new Error('User not found'));
        else resolve();
      }
    );
  });
}

export function createChat(householdId, owner, title) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO chats (household_id, owner, title) VALUES (?, ?, ?)`,
      [householdId, owner, title],
      function (err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

export function listChats(householdId, owner) {
  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT id, owner, title, created_at, updated_at
      FROM chats
      WHERE household_id = ? AND owner = ?
      ORDER BY updated_at DESC, id DESC
      `,
      [householdId, owner],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

export function listAllChats(householdId) {
  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT id, owner, title, created_at, updated_at
      FROM chats
      WHERE household_id = ?
      ORDER BY updated_at DESC, id DESC
      `,
      [householdId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

export function touchChat(chatId, householdId) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ? AND household_id = ?`,
      [chatId, householdId],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

export function updateChatTitle(chatId, householdId, title) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE chats SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND household_id = ?`,
      [title, chatId, householdId],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

export function addMessage(chatId, householdId, role, name, content) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO messages (household_id, chat_id, role, name, content) VALUES (?, ?, ?, ?, ?)`,
      [householdId, chatId, role, name, content],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

export function getMessages(chatId, householdId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT role, name, content FROM messages WHERE chat_id = ? AND household_id = ? ORDER BY id ASC`,
      [chatId, householdId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

export function clearMessages(chatId, householdId) {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM messages WHERE chat_id = ? AND household_id = ?`, [chatId, householdId], function (err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function deleteChat(owner, chatId, householdId) {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM chats WHERE id = ? AND household_id = ? AND owner = ?`,
      [chatId, householdId, owner],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

export function deleteChatById(chatId, householdId) {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM chats WHERE id = ? AND household_id = ?`,
      [chatId, householdId],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

/** One-time cleanup: remove old globally-personal seed keys from all households. */
export function deleteLegacySeedMemories() {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM memories WHERE key IN ('child_nickname', 'partner_style', 'rob_style')`,
      [],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

export function upsertMemory(householdId, key, value) {
  return new Promise((resolve, reject) => {
    db.run(
      `
      INSERT INTO memories (household_id, key, value)
      VALUES (?, ?, ?)
      ON CONFLICT(household_id, key) DO UPDATE SET value = excluded.value
      `,
      [householdId, key, value],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

export function addGroceryItems(householdId, items) {
  return new Promise((resolve, reject) => {
    if (!items || items.length === 0) return resolve();

    const stmt = db.prepare(
      `INSERT INTO grocery_items (household_id, name, section, amount, checked) VALUES (?, ?, ?, ?, 0)`
    );

    db.serialize(() => {
      for (const item of items) {
        stmt.run([householdId, item.name, item.section, item.amount || '']);
      }
      stmt.finalize((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

export function getGroceryItems(householdId) {
  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT id, name, section, amount, checked
      FROM grocery_items
      WHERE household_id = ?
      ORDER BY
        CASE section
          WHEN 'produce' THEN 1
          WHEN 'meat' THEN 2
          WHEN 'dairy' THEN 3
          WHEN 'frozen' THEN 4
          WHEN 'dry' THEN 5
          ELSE 6
        END,
        name ASC
      `,
      [householdId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

export function getMemories(householdId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT key, value FROM memories WHERE household_id = ? ORDER BY key ASC`,
      [householdId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

export function deleteMemory(householdId, key) {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM memories WHERE household_id = ? AND key = ?`,
      [householdId, key],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

export function updateGroceryItem(householdId, id, { checked }) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE grocery_items SET checked = ? WHERE id = ? AND household_id = ?`,
      [checked ? 1 : 0, id, householdId],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

/** Only unchecked rows; used when !grocerylist merges a new amount onto an existing line item. */
export function updateGroceryItemAmount(householdId, id, amount) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE grocery_items SET amount = ? WHERE id = ? AND household_id = ? AND checked = 0`,
      [amount ?? '', id, householdId],
      function (err) {
        if (err) reject(err);
        else if (this.changes === 0) reject(new Error('grocery_item_not_found_or_checked'));
        else resolve();
      }
    );
  });
}

export function deleteGroceryItem(householdId, id) {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM grocery_items WHERE id = ? AND household_id = ?`, [id, householdId], function (err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function clearGroceryItems(householdId) {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM grocery_items WHERE household_id = ?`, [householdId], function (err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function getUserComplimentState(householdUserId) {
  return new Promise((resolve, reject) => {
    db.get(
      `
      SELECT
        messages_since_last_compliment,
        last_compliment_timestamp,
        recent_compliments,
        recent_templates,
        boost_mode
      FROM user_compliment_state
      WHERE household_user_id = ?
      `,
      [householdUserId],
      (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        const safeRow = row || {};
        let recentCompliments = [];
        let recentTemplates = [];
        try {
          if (safeRow.recent_compliments) {
            recentCompliments = JSON.parse(safeRow.recent_compliments);
            if (!Array.isArray(recentCompliments)) recentCompliments = [];
          }
        } catch {
          recentCompliments = [];
        }
        try {
          if (safeRow.recent_templates) {
            recentTemplates = JSON.parse(safeRow.recent_templates);
            if (!Array.isArray(recentTemplates)) recentTemplates = [];
          }
        } catch {
          recentTemplates = [];
        }
        resolve({
          messages_since_last_compliment: safeRow.messages_since_last_compliment || 0,
          last_compliment_timestamp: safeRow.last_compliment_timestamp || null,
          recent_compliments: recentCompliments,
          recent_templates: recentTemplates,
          boost_mode: safeRow.boost_mode ? 1 : 0,
        });
      }
    );
  });
}

export function incrementUserMessageCount(householdUserId) {
  return new Promise((resolve, reject) => {
    db.run(
      `
      UPDATE user_compliment_state
      SET messages_since_last_compliment = messages_since_last_compliment + 1
      WHERE household_user_id = ?
      `,
      [householdUserId],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

export function shouldTriggerCompliment(state, now = new Date()) {
  if (!state) return { trigger: false, probability: 0 };

  const count = state.messages_since_last_compliment || 0;

  let baseProb = 0.01 + Math.min(count, 30) * 0.02;

  let multiplier = 1;
  const lastTs = state.last_compliment_timestamp;
  if (!lastTs) {
    multiplier = 3;
  } else {
    const last = new Date(lastTs);
    if (!Number.isNaN(last.getTime())) {
      const diffMs = now.getTime() - last.getTime();
      const oneDay = 24 * 60 * 60 * 1000;
      const threeDays = 3 * oneDay;
      if (diffMs > threeDays) {
        multiplier = 5;
      } else if (diffMs > oneDay) {
        multiplier = 3;
      }
    }
  }

  let finalProb = baseProb * multiplier;

  if (state.boost_mode) {
    finalProb = Math.max(finalProb, 0.5);
  }
  if (finalProb > 1) finalProb = 1;
  if (finalProb < 0) finalProb = 0;

  const rnd = Math.random();
  const trigger = rnd < finalProb;

  return { trigger, probability: finalProb };
}

export function selectComplimentAvoidingRecent(compliments, templates, state) {
  const recentCompliments = state?.recent_compliments || [];
  const recentTemplates = state?.recent_templates || [];

  const complimentPool = compliments.filter((c) => !recentCompliments.includes(c));
  const templatePool = templates.filter((t) => !recentTemplates.includes(t));

  const availableCompliments = complimentPool.length > 0 ? complimentPool : compliments;
  const availableTemplates = templatePool.length > 0 ? templatePool : templates;

  const compliment =
    availableCompliments[Math.floor(Math.random() * availableCompliments.length)];
  const template =
    availableTemplates[Math.floor(Math.random() * availableTemplates.length)];

  return { compliment, template };
}

export function recordCompliment(householdUserId, compliment, template, now = new Date()) {
  return getUserComplimentState(householdUserId).then((state) => {
    const recentCompliments = Array.isArray(state.recent_compliments)
      ? state.recent_compliments.slice()
      : [];
    const recentTemplates = Array.isArray(state.recent_templates)
      ? state.recent_templates.slice()
      : [];

    recentCompliments.push(compliment);
    recentTemplates.push(template);

    const trimmedCompliments = recentCompliments.slice(-5);
    const trimmedTemplates = recentTemplates.slice(-5);

    return new Promise((resolve, reject) => {
      db.run(
        `
        UPDATE user_compliment_state
        SET
          messages_since_last_compliment = 0,
          last_compliment_timestamp = ?,
          recent_compliments = ?,
          recent_templates = ?,
          boost_mode = 0
        WHERE household_user_id = ?
        `,
        [now.toISOString(), JSON.stringify(trimmedCompliments), JSON.stringify(trimmedTemplates), householdUserId],
        function (err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  });
}

export function setUserLoveBoost(householdUserId, active) {
  return new Promise((resolve, reject) => {
    db.run(
      `
      UPDATE user_compliment_state
      SET boost_mode = ?
      WHERE household_user_id = ?
      `,
      [active ? 1 : 0, householdUserId],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}
