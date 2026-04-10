import sqlite3 from 'sqlite3';
import crypto from 'crypto';

const dbPath = process.env.DB_PATH || './kitchenbot.db';
const db = new sqlite3.Database(dbPath);

let resolveSchemaReady;
let rejectSchemaReady;
const schemaReady = new Promise((resolve, reject) => {
  resolveSchemaReady = resolve;
  rejectSchemaReady = reject;
});

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
      web_search_enabled INTEGER NOT NULL DEFAULT 0,
      smart_mode_enabled INTEGER NOT NULL DEFAULT 0,
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
      title_user_locked INTEGER NOT NULL DEFAULT 0,
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

  db.run(`
    CREATE TABLE IF NOT EXISTS chat_meal_plan_context (
      chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      meal_plan_summary TEXT NOT NULL DEFAULT '',
      thread_grocery_summary TEXT NOT NULL DEFAULT '',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chat_runtime_state (
      chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      mode TEXT NOT NULL DEFAULT 'smart',
      pending_json TEXT NOT NULL DEFAULT '{}',
      checkpoint_json TEXT NOT NULL DEFAULT '{}',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS anthropic_usage_ledger (
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
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_anthropic_usage_created_at ON anthropic_usage_ledger(created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_anthropic_usage_household_created ON anthropic_usage_ledger(household_id, created_at)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS smart_durable_memories (
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
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_smart_durable_memories_household ON smart_durable_memories(household_id, updated_at)`);

  db.run(
    `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
    )
    `,
    (err) => {
      if (err) rejectSchemaReady(err);
      else resolveSchemaReady();
    }
  );
});

function migrationRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function migrationAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

async function migrationTableHasColumn(table, column) {
  const rows = await migrationAll(`PRAGMA table_info(${table})`);
  return rows.some((c) => c.name === column);
}

const MIGRATIONS = [
  {
    name: '001_add_chat_color_to_household_users',
    async up() {
      if (!(await migrationTableHasColumn('household_users', 'chat_color'))) {
        await migrationRun(
          `ALTER TABLE household_users ADD COLUMN chat_color TEXT NOT NULL DEFAULT 'blue'`
        );
      }
    },
  },
  {
    name: '002_add_session_version_to_household_users',
    async up() {
      if (!(await migrationTableHasColumn('household_users', 'session_version'))) {
        await migrationRun(
          `ALTER TABLE household_users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0`
        );
      }
    },
  },
  {
    name: '003_add_web_search_enabled_to_households',
    async up() {
      if (!(await migrationTableHasColumn('households', 'web_search_enabled'))) {
        await migrationRun(
          `ALTER TABLE households ADD COLUMN web_search_enabled INTEGER NOT NULL DEFAULT 0`
        );
      }
    },
  },
  {
    name: '004_add_chat_meal_plan_context',
    async up() {
      await migrationRun(`
        CREATE TABLE IF NOT EXISTS chat_meal_plan_context (
          chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
          household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
          meal_plan_summary TEXT NOT NULL DEFAULT '',
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
    },
  },
  {
    name: '005_add_thread_grocery_summary_to_chat_meal_plan_context',
    async up() {
      if (!(await migrationTableHasColumn('chat_meal_plan_context', 'thread_grocery_summary'))) {
        await migrationRun(
          `ALTER TABLE chat_meal_plan_context ADD COLUMN thread_grocery_summary TEXT NOT NULL DEFAULT ''`
        );
      }
    },
  },
  {
    name: '006_add_source_chat_id_to_grocery_items',
    async up() {
      if (!(await migrationTableHasColumn('grocery_items', 'source_chat_id'))) {
        await migrationRun(`ALTER TABLE grocery_items ADD COLUMN source_chat_id INTEGER NULL`);
      }
    },
  },
  {
    name: '007_add_smart_mode_enabled_to_households',
    async up() {
      if (!(await migrationTableHasColumn('households', 'smart_mode_enabled'))) {
        await migrationRun(
          `ALTER TABLE households ADD COLUMN smart_mode_enabled INTEGER NOT NULL DEFAULT 0`
        );
      }
    },
  },
  {
    name: '008_add_thread_scene_json_to_chat_meal_plan_context',
    async up() {
      if (!(await migrationTableHasColumn('chat_meal_plan_context', 'thread_scene_json'))) {
        await migrationRun(
          `ALTER TABLE chat_meal_plan_context ADD COLUMN thread_scene_json TEXT NOT NULL DEFAULT '{}'`
        );
      }
    },
  },
  {
    name: '009_add_weekly_plan_draft_json_to_chat_meal_plan_context',
    async up() {
      if (!(await migrationTableHasColumn('chat_meal_plan_context', 'weekly_plan_draft_json'))) {
        await migrationRun(
          `ALTER TABLE chat_meal_plan_context ADD COLUMN weekly_plan_draft_json TEXT NOT NULL DEFAULT '{}'`
        );
      }
    },
  },
  {
    name: '010_add_chat_runtime_state',
    async up() {
      await migrationRun(`
        CREATE TABLE IF NOT EXISTS chat_runtime_state (
          chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
          household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
          mode TEXT NOT NULL DEFAULT 'smart',
          pending_json TEXT NOT NULL DEFAULT '{}',
          checkpoint_json TEXT NOT NULL DEFAULT '{}',
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
    },
  },
  {
    name: '011_add_anthropic_usage_ledger',
    async up() {
      await migrationRun(`
        CREATE TABLE IF NOT EXISTS anthropic_usage_ledger (
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
        )
      `);
      await migrationRun(
        `CREATE INDEX IF NOT EXISTS idx_anthropic_usage_created_at ON anthropic_usage_ledger(created_at)`
      );
      await migrationRun(
        `CREATE INDEX IF NOT EXISTS idx_anthropic_usage_household_created ON anthropic_usage_ledger(household_id, created_at)`
      );
    },
  },
  {
    name: '012_add_smart_durable_memories',
    async up() {
      await migrationRun(`
        CREATE TABLE IF NOT EXISTS smart_durable_memories (
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
        )
      `);
      await migrationRun(
        `CREATE INDEX IF NOT EXISTS idx_smart_durable_memories_household ON smart_durable_memories(household_id, updated_at)`
      );
    },
  },
  {
    name: '013_add_title_user_locked_to_chats',
    async up() {
      if (!(await migrationTableHasColumn('chats', 'title_user_locked'))) {
        await migrationRun(`ALTER TABLE chats ADD COLUMN title_user_locked INTEGER NOT NULL DEFAULT 0`);
      }
    },
  },
];

/** Runs ordered migrations once each; fails startup if any migration fails. */
export async function runMigrations() {
  await schemaReady;
  const appliedRows = await migrationAll(`SELECT name FROM schema_migrations`);
  const applied = new Set(appliedRows.map((r) => r.name));

  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    await migrationRun('BEGIN IMMEDIATE');
    try {
      await m.up();
      await migrationRun(`INSERT INTO schema_migrations (name) VALUES (?)`, [m.name]);
      await migrationRun('COMMIT');
    } catch (e) {
      await migrationRun('ROLLBACK').catch(() => {});
      console.error(`Migration failed: ${m.name}`, e);
      throw e;
    }
  }
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
      SELECT id, name, household_key, anthropic_key_mode, anthropic_api_key, web_search_enabled, smart_mode_enabled, created_at
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
      SELECT id, name, household_key, anthropic_key_mode, anthropic_api_key, web_search_enabled, smart_mode_enabled, created_at
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

/** Global admin only: enable/disable Anthropic web search tool for a household. */
export function setHouseholdWebSearchEnabled(householdId, enabled) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE households SET web_search_enabled = ? WHERE id = ?`,
      [enabled ? 1 : 0, householdId],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

/** Global admin only: enable/disable Smart Mode (broader NL pending-offer detection) for a household. */
export function setHouseholdSmartModeEnabled(householdId, enabled) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE households SET smart_mode_enabled = ? WHERE id = ?`,
      [enabled ? 1 : 0, householdId],
      function (err) {
        if (err) reject(err);
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
      `SELECT id, name, household_key, anthropic_key_mode, anthropic_api_key, web_search_enabled, smart_mode_enabled FROM households ORDER BY id ASC`,
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
      webSearchEnabled: Number(h.web_search_enabled) === 1,
      smartModeEnabled: Number(h.smart_mode_enabled) === 1,
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

export function insertAnthropicUsageLedgerRow(row) {
  return new Promise((resolve, reject) => {
    db.run(
      `
      INSERT INTO anthropic_usage_ledger (
        household_id,
        chat_id,
        smart_mode_enabled,
        call_surface,
        call_purpose,
        model,
        request_kind,
        input_tokens,
        output_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        web_search_enabled_at_call,
        used_web_search_tool
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        Number(row.householdId),
        row.chatId != null ? Number(row.chatId) : null,
        row.smartModeEnabled ? 1 : 0,
        String(row.callSurface ?? 'background'),
        String(row.callPurpose ?? 'unknown'),
        String(row.model ?? 'unknown'),
        String(row.requestKind ?? 'create'),
        Number(row.inputTokens ?? 0),
        Number(row.outputTokens ?? 0),
        row.cacheCreationInputTokens != null ? Number(row.cacheCreationInputTokens) : null,
        row.cacheReadInputTokens != null ? Number(row.cacheReadInputTokens) : null,
        row.webSearchEnabledAtCall ? 1 : 0,
        row.usedWebSearchTool ? 1 : 0,
      ],
      function (err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

export function getAnthropicUsageLedgerRows(filters = {}, limit = 100) {
  const where = [];
  const params = [];

  if (filters.startDate) {
    where.push(`created_at >= ?`);
    params.push(String(filters.startDate));
  }
  if (filters.endDate) {
    where.push(`created_at < ?`);
    params.push(String(filters.endDate));
  }
  if (filters.householdId != null) {
    where.push(`household_id = ?`);
    params.push(Number(filters.householdId));
  }
  if (filters.callPurpose) {
    where.push(`call_purpose = ?`);
    params.push(String(filters.callPurpose));
  }
  if (filters.callSurface) {
    where.push(`call_surface = ?`);
    params.push(String(filters.callSurface));
  }
  if (filters.webSearchEnabledAtCall === true || filters.webSearchEnabledAtCall === false) {
    where.push(`web_search_enabled_at_call = ?`);
    params.push(filters.webSearchEnabledAtCall ? 1 : 0);
  }
  if (filters.usedWebSearchTool === true || filters.usedWebSearchTool === false) {
    where.push(`used_web_search_tool = ?`);
    params.push(filters.usedWebSearchTool ? 1 : 0);
  }

  const sql =
    `
    SELECT id, created_at, household_id, chat_id, smart_mode_enabled, call_surface, call_purpose, model, request_kind,
           input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
           web_search_enabled_at_call, used_web_search_tool
    FROM anthropic_usage_ledger
    ` +
    (where.length ? `WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY datetime(created_at) DESC, id DESC LIMIT ?`;
  params.push(Number(limit) > 0 ? Number(limit) : 100);

  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

export function getAnthropicUsageLedgerAllRows(filters = {}) {
  const where = [];
  const params = [];

  if (filters.startDate) {
    where.push(`created_at >= ?`);
    params.push(String(filters.startDate));
  }
  if (filters.endDate) {
    where.push(`created_at < ?`);
    params.push(String(filters.endDate));
  }
  if (filters.householdId != null) {
    where.push(`household_id = ?`);
    params.push(Number(filters.householdId));
  }
  if (filters.callPurpose) {
    where.push(`call_purpose = ?`);
    params.push(String(filters.callPurpose));
  }
  if (filters.callSurface) {
    where.push(`call_surface = ?`);
    params.push(String(filters.callSurface));
  }
  if (filters.webSearchEnabledAtCall === true || filters.webSearchEnabledAtCall === false) {
    where.push(`web_search_enabled_at_call = ?`);
    params.push(filters.webSearchEnabledAtCall ? 1 : 0);
  }
  if (filters.usedWebSearchTool === true || filters.usedWebSearchTool === false) {
    where.push(`used_web_search_tool = ?`);
    params.push(filters.usedWebSearchTool ? 1 : 0);
  }

  const sql =
    `
    SELECT id, created_at, household_id, chat_id, smart_mode_enabled, call_surface, call_purpose, model, request_kind,
           input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
           web_search_enabled_at_call, used_web_search_tool
    FROM anthropic_usage_ledger
    ` +
    (where.length ? `WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY datetime(created_at) DESC, id DESC`;

  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
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

export function updateChatTitleAndLock(chatId, householdId, title) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE chats SET title = ?, title_user_locked = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND household_id = ?`,
      [title, chatId, householdId],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes || 0);
      }
    );
  });
}

export function updateChatTitleAutoIfUnlocked(chatId, householdId, title) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE chats SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND household_id = ? AND COALESCE(title_user_locked, 0) = 0`,
      [title, chatId, householdId],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes || 0);
      }
    );
  });
}

function parseThreadSceneJson(raw) {
  if (raw == null || raw === '') return {};
  try {
    const parsed = JSON.parse(String(raw));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    return {};
  }
}

function parseWeeklyPlanDraftJson(raw) {
  if (raw == null || raw === '') return {};
  try {
    const parsed = JSON.parse(String(raw));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    return {};
  }
}

function parseChatRuntimeStateJson(raw) {
  if (raw == null || raw === '') return {};
  try {
    const parsed = JSON.parse(String(raw));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    return {};
  }
}

const MAX_THREAD_SCENE_JSON_CHARS = 12000;
const MAX_WEEKLY_PLAN_DRAFT_JSON_CHARS = 6000;

const PLANNER_RESUME_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function sanitizeWeeklyMealTitle(raw) {
  return String(raw ?? '').trim().slice(0, 120);
}

function sanitizeWeeklyMealList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 20)
    .map((m) => sanitizeWeeklyMealTitle(m))
    .filter((s) => s.length > 0);
}

function normalizeMealMatchKey(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(?:the|a|an|some|thing|dish|dinner|meal|night)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mealMatchScore(target, candidate) {
  const t = normalizeMealMatchKey(target);
  const c = normalizeMealMatchKey(candidate);
  if (!t || !c) return 0;
  if (t === c) return 1000;
  if (c.includes(t) || t.includes(c)) return 500 + Math.min(t.length, c.length);
  const tTokens = new Set(t.split(' ').filter(Boolean));
  const cTokens = c.split(' ').filter(Boolean);
  let overlap = 0;
  for (const token of cTokens) {
    if (tTokens.has(token)) overlap += 1;
  }
  return overlap;
}

function findBestMealMatchIndex(meals, matchText) {
  const list = Array.isArray(meals) ? meals : [];
  let bestIndex = -1;
  let bestScore = 0;
  for (let i = 0; i < list.length; i += 1) {
    const score = mealMatchScore(matchText, list[i]);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestScore > 0 ? bestIndex : -1;
}

function sanitizeWeeklyMealEdit(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const op = String(raw.op ?? '').trim().toLowerCase();
  if (op === 'set') {
    const slot = Math.trunc(Number(raw.slot));
    const meal = sanitizeWeeklyMealTitle(raw.meal);
    if (!Number.isFinite(slot) || slot < 1 || slot > 20 || !meal) return null;
    return { op: 'set', slot, meal };
  }
  if (op === 'remove') {
    const slot = Math.trunc(Number(raw.slot));
    if (!Number.isFinite(slot) || slot < 1 || slot > 20) return null;
    return { op: 'remove', slot };
  }
  if (op === 'append') {
    const meal = sanitizeWeeklyMealTitle(raw.meal);
    if (!meal) return null;
    return { op: 'append', meal };
  }
  if (op === 'replace_match') {
    const match = String(raw.match ?? '').trim().slice(0, 120);
    const meal = sanitizeWeeklyMealTitle(raw.meal);
    if (!match || !meal) return null;
    return { op: 'replace_match', match, meal };
  }
  return null;
}

function sanitizeWeeklyMealEdits(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 20)
    .map((edit) => sanitizeWeeklyMealEdit(edit))
    .filter(Boolean);
}

function applyWeeklyMealEdits(baseMeals, rawEdits) {
  const meals = sanitizeWeeklyMealList(baseMeals);
  const edits = sanitizeWeeklyMealEdits(rawEdits);
  if (edits.length === 0) return meals;
  const nextMeals = [...meals];
  for (const edit of edits) {
    if (edit.op === 'append') {
      if (nextMeals.length < 20) nextMeals.push(edit.meal);
      continue;
    }
    if (edit.op === 'set') {
      const index = edit.slot - 1;
      if (index >= nextMeals.length) nextMeals.push(edit.meal);
      else nextMeals[index] = edit.meal;
      continue;
    }
    if (edit.op === 'remove') {
      const index = edit.slot - 1;
      if (index >= 0 && index < nextMeals.length) nextMeals.splice(index, 1);
      continue;
    }
    if (edit.op === 'replace_match') {
      const index = findBestMealMatchIndex(nextMeals, edit.match);
      if (index >= 0) nextMeals[index] = edit.meal;
      else if (nextMeals.length < 20) nextMeals.push(edit.meal);
    }
  }
  return sanitizeWeeklyMealList(nextMeals);
}

/**
 * Strict server-side shape for plannerResume nested in weekly plan draft.
 * remainingActions: only !grocerylist (remember must not appear — completed before checkpoint).
 */
function sanitizePlannerResumeForStorage(pr) {
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)) return null;
  if (pr.active !== true) return null;
  if (String(pr.kind ?? '') !== 'grocery_disambiguation_resume') return null;
  const createdAt = Number(pr.createdAt);
  if (!Number.isFinite(createdAt) || createdAt <= 0) return null;
  if (Date.now() - createdAt > PLANNER_RESUME_MAX_AGE_MS) return null;
  const rawActions = pr.remainingActions;
  if (!Array.isArray(rawActions) || rawActions.length !== 1) return null;
  const a0 = rawActions[0];
  if (!a0 || typeof a0 !== 'object' || Array.isArray(a0)) return null;
  const cmd = String(a0.command ?? '');
  if (cmd !== '!grocerylist') return null;
  const mode = a0.mode != null ? String(a0.mode) : null;
  if (
    mode != null &&
    mode !== '' &&
    mode !== 'append' &&
    mode !== 'replace' &&
    mode !== 'prune'
  ) {
    return null;
  }
  const actionOut = { command: '!grocerylist' };
  if (mode && (mode === 'append' || mode === 'replace' || mode === 'prune')) {
    actionOut.mode = mode;
  }
  let rememberAckFragment = null;
  if (Object.prototype.hasOwnProperty.call(pr, 'rememberAckFragment')) {
    const raf = pr.rememberAckFragment;
    if (raf === null || raf === undefined) {
      rememberAckFragment = null;
    } else if (typeof raf === 'string') {
      rememberAckFragment = raf.trim().slice(0, 600) || null;
    } else {
      return null;
    }
  }
  return {
    active: true,
    kind: 'grocery_disambiguation_resume',
    createdAt,
    remainingActions: [actionOut],
    rememberAckFragment,
  };
}

/**
 * Planner-only: weekly plan draft fields with no plannerResume and no unknown keys.
 * Same field rules as sanitizeWeeklyPlanDraftPatch for label/meals/notes/status.
 * @returns {Record<string, unknown> | null} null if empty object from model or no-op after sanitize
 */
export function sanitizePlannerWeeklyPlanPatchOnly(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  for (const k of Object.keys(raw)) {
    if (k !== 'label' && k !== 'meals' && k !== 'mealEdits' && k !== 'notes' && k !== 'status') return null;
  }
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(raw, 'label')) {
    if (typeof raw.label !== 'string' && raw.label != null) return null;
    if (typeof raw.label === 'string') patch.label = raw.label.trim().slice(0, 200);
    else patch.label = '';
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'meals')) {
    if (raw.meals == null) patch.meals = [];
    else if (Array.isArray(raw.meals)) patch.meals = sanitizeWeeklyMealList(raw.meals);
    else return null;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'mealEdits')) {
    if (raw.mealEdits == null) patch.mealEdits = [];
    else if (Array.isArray(raw.mealEdits)) patch.mealEdits = sanitizeWeeklyMealEdits(raw.mealEdits);
    else return null;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'notes')) {
    if (typeof raw.notes !== 'string' && raw.notes != null) return null;
    if (typeof raw.notes === 'string') patch.notes = raw.notes.trim().slice(0, 500);
    else patch.notes = '';
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'status')) {
    const st = String(raw.status ?? '').trim().toLowerCase();
    if (st !== 'empty') return null;
    patch.status = st;
  }
  if (Object.keys(patch).length === 0) return null;
  return patch;
}

/**
 * Sanitize a shallow patch for weekly plan draft (label, meals, notes, status, plannerResume).
 * plannerResume: null removes the key from merged draft when merged explicitly.
 * @returns {Record<string, unknown> | null} null if nothing valid to merge
 */
function sanitizeWeeklyPlanDraftPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null;
  const out = {};
  let hasPlannerResumeDelete = false;
  if (Object.prototype.hasOwnProperty.call(patch, 'plannerResume')) {
    if (patch.plannerResume === null) {
      hasPlannerResumeDelete = true;
    } else {
      const sr = sanitizePlannerResumeForStorage(patch.plannerResume);
      if (sr) out.plannerResume = sr;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'label')) {
    if (typeof patch.label === 'string') out.label = patch.label.trim().slice(0, 200);
    else if (patch.label === null || patch.label === undefined) out.label = '';
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'meals')) {
    if (Array.isArray(patch.meals)) {
      out.meals = sanitizeWeeklyMealList(patch.meals);
    } else if (patch.meals === null || patch.meals === undefined) {
      out.meals = [];
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'mealEdits')) {
    if (Array.isArray(patch.mealEdits)) {
      out.mealEdits = sanitizeWeeklyMealEdits(patch.mealEdits);
    } else if (patch.mealEdits === null || patch.mealEdits === undefined) {
      out.mealEdits = [];
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'notes')) {
    if (typeof patch.notes === 'string') out.notes = patch.notes.trim().slice(0, 500);
    else if (patch.notes === null || patch.notes === undefined) out.notes = '';
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
    const st = String(patch.status ?? '').trim().toLowerCase();
    if (st === 'empty') out.status = st;
  }
  if (hasPlannerResumeDelete) {
    out.__deletePlannerResume = true;
  }
  if (Object.keys(out).length > 0) return out;
  return null;
}

/** Thread-scoped context: meal/grocery summaries, thread scene, weekly plan draft (read-only for chat prompts). */
export function getChatThreadContext(chatId, householdId) {
  return new Promise((resolve, reject) => {
    db.get(
      `
      SELECT meal_plan_summary, thread_grocery_summary, thread_scene_json, weekly_plan_draft_json
      FROM chat_meal_plan_context
      WHERE chat_id = ? AND household_id = ?
      `,
      [chatId, householdId],
      (err, row) => {
        if (err) reject(err);
        else if (!row) {
          resolve({
            mealPlanSummary: '',
            threadGrocerySummary: '',
            threadScene: {},
            weeklyPlanDraft: {},
          });
        } else {
          resolve({
            mealPlanSummary: String(row.meal_plan_summary ?? ''),
            threadGrocerySummary: String(row.thread_grocery_summary ?? ''),
            threadScene: parseThreadSceneJson(row.thread_scene_json),
            weeklyPlanDraft: parseWeeklyPlanDraftJson(row.weekly_plan_draft_json),
          });
        }
      }
    );
  });
}

/**
 * Shallow-merge patch into persisted weekly plan draft JSON. Preserves meal_plan_summary, thread_grocery_summary, thread_scene_json.
 * Creates the row if missing. Ignores invalid patch shapes.
 */
export function updateWeeklyPlanDraft(chatId, householdId, patch) {
  const sanitized = sanitizeWeeklyPlanDraftPatch(patch);
  if (!sanitized) return Promise.resolve();
  return new Promise((resolve, reject) => {
    db.get(
      `
      SELECT meal_plan_summary, thread_grocery_summary, thread_scene_json, weekly_plan_draft_json
      FROM chat_meal_plan_context
      WHERE chat_id = ? AND household_id = ?
      `,
      [chatId, householdId],
      (err, row) => {
        if (err) return reject(err);
        const existing = parseWeeklyPlanDraftJson(row?.weekly_plan_draft_json);
        const delPr = sanitized.__deletePlannerResume === true;
        const { __deletePlannerResume, mealEdits, ...restSan } = sanitized;
        const merged = { ...existing, ...restSan };
        if (Object.prototype.hasOwnProperty.call(sanitized, 'meals') || Array.isArray(mealEdits)) {
          const baseMeals = Object.prototype.hasOwnProperty.call(restSan, 'meals')
            ? restSan.meals
            : existing.meals;
          merged.meals = applyWeeklyMealEdits(baseMeals, mealEdits);
        }
        if (delPr) {
          delete merged.plannerResume;
        }
        let jsonStr;
        try {
          jsonStr = JSON.stringify(merged);
        } catch {
          return resolve();
        }
        if (jsonStr.length > MAX_WEEKLY_PLAN_DRAFT_JSON_CHARS) {
          return resolve();
        }
        if (row) {
          db.run(
            `
            UPDATE chat_meal_plan_context
            SET weekly_plan_draft_json = ?, updated_at = CURRENT_TIMESTAMP
            WHERE chat_id = ? AND household_id = ?
            `,
            [jsonStr, chatId, householdId],
            function (err2) {
              if (err2) reject(err2);
              else resolve();
            }
          );
        } else {
          db.run(
            `
            INSERT INTO chat_meal_plan_context (chat_id, household_id, meal_plan_summary, thread_grocery_summary, thread_scene_json, weekly_plan_draft_json, updated_at)
            VALUES (?, ?, '', '', '{}', ?, CURRENT_TIMESTAMP)
            `,
            [chatId, householdId, jsonStr],
            function (err2) {
              if (err2) reject(err2);
              else resolve();
            }
          );
        }
      }
    );
  });
}

/**
 * Shallow-merge `patch` into persisted thread scene. Preserves meal_plan_summary and thread_grocery_summary.
 * Creates the row if missing. Does not replace grocery/meal columns.
 */
export function updateChatThreadScene(chatId, householdId, patch) {
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  return new Promise((resolve, reject) => {
    db.get(
      `
      SELECT meal_plan_summary, thread_grocery_summary, thread_scene_json
      FROM chat_meal_plan_context
      WHERE chat_id = ? AND household_id = ?
      `,
      [chatId, householdId],
      (err, row) => {
        if (err) return reject(err);
        const existing = parseThreadSceneJson(row?.thread_scene_json);
        let merged = { ...existing, ...p };
        let jsonStr = JSON.stringify(merged);
        if (jsonStr.length > MAX_THREAD_SCENE_JSON_CHARS) {
          merged = existing;
          jsonStr = JSON.stringify(merged);
        }
        if (row) {
          db.run(
            `
            UPDATE chat_meal_plan_context
            SET thread_scene_json = ?, updated_at = CURRENT_TIMESTAMP
            WHERE chat_id = ? AND household_id = ?
            `,
            [jsonStr, chatId, householdId],
            function (err2) {
              if (err2) reject(err2);
              else resolve();
            }
          );
        } else {
          db.run(
            `
            INSERT INTO chat_meal_plan_context (chat_id, household_id, meal_plan_summary, thread_grocery_summary, thread_scene_json, updated_at)
            VALUES (?, ?, '', '', ?, CURRENT_TIMESTAMP)
            `,
            [chatId, householdId, jsonStr],
            function (err2) {
              if (err2) reject(err2);
              else resolve();
            }
          );
        }
      }
    );
  });
}

/**
 * Replace persisted thread scene JSON exactly (no merge). Preserves meal_plan_summary and thread_grocery_summary.
 * Creates the row if missing. Intended for temp admin editor tools; trusted app code continues to use updateChatThreadScene for merges.
 */
export function replaceChatThreadScene(chatId, householdId, sceneObject) {
  if (sceneObject == null || typeof sceneObject !== 'object' || Array.isArray(sceneObject)) {
    return Promise.reject(new Error('thread scene must be a plain object'));
  }
  let jsonStr;
  try {
    jsonStr = JSON.stringify(sceneObject);
  } catch {
    return Promise.reject(new Error('thread scene is not JSON-serializable'));
  }
  if (jsonStr.length > MAX_THREAD_SCENE_JSON_CHARS) {
    return Promise.reject(new Error('thread scene JSON exceeds maximum size'));
  }
  return new Promise((resolve, reject) => {
    db.get(
      `
      SELECT meal_plan_summary, thread_grocery_summary, thread_scene_json
      FROM chat_meal_plan_context
      WHERE chat_id = ? AND household_id = ?
      `,
      [chatId, householdId],
      (err, row) => {
        if (err) return reject(err);
        if (row) {
          db.run(
            `
            UPDATE chat_meal_plan_context
            SET thread_scene_json = ?, updated_at = CURRENT_TIMESTAMP
            WHERE chat_id = ? AND household_id = ?
            `,
            [jsonStr, chatId, householdId],
            function (err2) {
              if (err2) reject(err2);
              else resolve();
            }
          );
        } else {
          db.run(
            `
            INSERT INTO chat_meal_plan_context (chat_id, household_id, meal_plan_summary, thread_grocery_summary, thread_scene_json, updated_at)
            VALUES (?, ?, '', '', ?, CURRENT_TIMESTAMP)
            `,
            [chatId, householdId, jsonStr],
            function (err2) {
              if (err2) reject(err2);
              else resolve();
            }
          );
        }
      }
    );
  });
}

export function upsertChatThreadContext(chatId, householdId, { mealPlanSummary, threadGrocerySummary }) {
  const mp = String(mealPlanSummary ?? '').slice(0, 12000);
  const tg = String(threadGrocerySummary ?? '').slice(0, 12000);
  return new Promise((resolve, reject) => {
    db.run(
      `
      INSERT INTO chat_meal_plan_context (chat_id, household_id, meal_plan_summary, thread_grocery_summary, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(chat_id) DO UPDATE SET
        meal_plan_summary = excluded.meal_plan_summary,
        thread_grocery_summary = excluded.thread_grocery_summary,
        household_id = excluded.household_id,
        updated_at = CURRENT_TIMESTAMP
      `,
      [chatId, householdId, mp, tg],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

export function getChatRuntimeState(chatId, householdId) {
  return new Promise((resolve, reject) => {
    db.get(
      `
      SELECT mode, pending_json, checkpoint_json
      FROM chat_runtime_state
      WHERE chat_id = ? AND household_id = ?
      `,
      [chatId, householdId],
      (err, row) => {
        if (err) reject(err);
        else if (!row) {
          resolve({ mode: 'smart', pending: {}, checkpoint: {}, continuation: {}, proposedNextAction: {} });
        } else {
          const rawCheckpoint = parseChatRuntimeStateJson(row.checkpoint_json);
          const proposedNextAction =
            rawCheckpoint &&
            typeof rawCheckpoint === 'object' &&
            !Array.isArray(rawCheckpoint) &&
            rawCheckpoint.proposedNextAction &&
            typeof rawCheckpoint.proposedNextAction === 'object' &&
            !Array.isArray(rawCheckpoint.proposedNextAction)
              ? rawCheckpoint.proposedNextAction
              : {};
          const continuation =
            rawCheckpoint &&
            typeof rawCheckpoint === 'object' &&
            !Array.isArray(rawCheckpoint) &&
            rawCheckpoint.continuation &&
            typeof rawCheckpoint.continuation === 'object' &&
            !Array.isArray(rawCheckpoint.continuation)
              ? rawCheckpoint.continuation
              : {};
          const checkpoint =
            rawCheckpoint &&
            typeof rawCheckpoint === 'object' &&
            !Array.isArray(rawCheckpoint) &&
            rawCheckpoint.legacy &&
            typeof rawCheckpoint.legacy === 'object' &&
            !Array.isArray(rawCheckpoint.legacy)
              ? rawCheckpoint.legacy
              : rawCheckpoint;
          resolve({
            mode: String(row.mode ?? 'smart') || 'smart',
            pending: parseChatRuntimeStateJson(row.pending_json),
            checkpoint,
            continuation,
            proposedNextAction,
          });
        }
      }
    );
  });
}

export function setChatRuntimeState(chatId, householdId, state = {}) {
  const mode = String(state.mode ?? 'smart').trim() || 'smart';
  let pendingJson = '{}';
  let checkpointJson = '{}';
  try {
    const checkpoint =
      state.checkpoint && typeof state.checkpoint === 'object' && !Array.isArray(state.checkpoint)
        ? state.checkpoint
        : {};
    const continuation =
      state.continuation && typeof state.continuation === 'object' && !Array.isArray(state.continuation)
        ? state.continuation
        : null;
    const proposedNextAction =
      state.proposedNextAction && typeof state.proposedNextAction === 'object' && !Array.isArray(state.proposedNextAction)
        ? state.proposedNextAction
        : null;
    pendingJson = JSON.stringify(
      state.pending && typeof state.pending === 'object' && !Array.isArray(state.pending) ? state.pending : {}
    );
    checkpointJson = JSON.stringify(
      continuation || proposedNextAction
        ? {
            ...(continuation ? { continuation } : {}),
            ...(proposedNextAction ? { proposedNextAction } : {}),
            legacy: checkpoint,
          }
        : checkpoint
    );
  } catch {
    return Promise.reject(new Error('runtime state must be JSON-serializable'));
  }
  return new Promise((resolve, reject) => {
    db.run(
      `
      INSERT INTO chat_runtime_state (chat_id, household_id, mode, pending_json, checkpoint_json, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(chat_id) DO UPDATE SET
        household_id = excluded.household_id,
        mode = excluded.mode,
        pending_json = excluded.pending_json,
        checkpoint_json = excluded.checkpoint_json,
        updated_at = CURRENT_TIMESTAMP
      `,
      [chatId, householdId, mode, pendingJson, checkpointJson],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

export function clearChatRuntimeState(chatId, householdId) {
  return setChatRuntimeState(chatId, householdId, {
    mode: 'smart',
    pending: {},
    checkpoint: {},
    continuation: {},
    proposedNextAction: {},
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

/** @param {{ sourceChatId?: number | null }} [opts] When set (e.g. !grocerylist), attributes rows to that chat for targeted prune. */
export function addGroceryItems(householdId, items, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!items || items.length === 0) return resolve();

    const rawSrc = opts.sourceChatId;
    const sourceChatId =
      rawSrc != null && Number.isFinite(Number(rawSrc)) ? Number(rawSrc) : null;

    const stmt = db.prepare(
      `INSERT INTO grocery_items (household_id, name, section, amount, checked, source_chat_id) VALUES (?, ?, ?, ?, 0, ?)`
    );

    db.serialize(() => {
      for (const item of items) {
        stmt.run([householdId, item.name, item.section, item.amount || '', sourceChatId]);
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
      SELECT id, name, section, amount, checked, source_chat_id
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

function parseSmartDurableMemoryAttributes(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function listSmartDurableMemories(householdId) {
  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT id, household_id, memory_type, label, normalized_label, summary, attributes_json, source_kind, source_chat_id, created_at, updated_at
      FROM smart_durable_memories
      WHERE household_id = ?
      ORDER BY datetime(updated_at) DESC, label COLLATE NOCASE ASC
      `,
      [householdId],
      (err, rows) => {
        if (err) reject(err);
        else resolve((rows || []).map((row) => ({
          id: row.id,
          householdId: row.household_id,
          memoryType: row.memory_type,
          label: row.label,
          normalizedLabel: row.normalized_label,
          summary: row.summary,
          attributes: parseSmartDurableMemoryAttributes(row.attributes_json),
          sourceKind: row.source_kind,
          sourceChatId: row.source_chat_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })));
      }
    );
  });
}

export function getSmartDurableMemoryByTypeAndLabel(householdId, memoryType, normalizedLabel) {
  return new Promise((resolve, reject) => {
    db.get(
      `
      SELECT id, household_id, memory_type, label, normalized_label, summary, attributes_json, source_kind, source_chat_id, created_at, updated_at
      FROM smart_durable_memories
      WHERE household_id = ? AND memory_type = ? AND normalized_label = ?
      LIMIT 1
      `,
      [householdId, memoryType, normalizedLabel],
      (err, row) => {
        if (err) reject(err);
        else if (!row) resolve(null);
        else resolve({
          id: row.id,
          householdId: row.household_id,
          memoryType: row.memory_type,
          label: row.label,
          normalizedLabel: row.normalized_label,
          summary: row.summary,
          attributes: parseSmartDurableMemoryAttributes(row.attributes_json),
          sourceKind: row.source_kind,
          sourceChatId: row.source_chat_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
      }
    );
  });
}

export function saveSmartDurableMemory(householdId, record, opts = {}) {
  const attributesJson = JSON.stringify(record.attributes || {});
  const sourceKind = String(opts.sourceKind ?? 'manual').trim() || 'manual';
  const sourceChatId =
    opts.sourceChatId != null && Number.isFinite(Number(opts.sourceChatId)) ? Number(opts.sourceChatId) : null;
  const id = opts.id != null && Number.isFinite(Number(opts.id)) ? Number(opts.id) : null;
  return new Promise((resolve, reject) => {
    if (id) {
      db.run(
        `
        UPDATE smart_durable_memories
        SET memory_type = ?, label = ?, normalized_label = ?, summary = ?, attributes_json = ?, source_kind = ?, source_chat_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE household_id = ? AND id = ?
        `,
        [
          record.memoryType,
          record.label,
          record.normalizedLabel,
          record.summary,
          attributesJson,
          sourceKind,
          sourceChatId,
          householdId,
          id,
        ],
        function (err) {
          if (err) reject(err);
          else resolve({ id, changes: this.changes });
        }
      );
      return;
    }

    db.run(
      `
      INSERT INTO smart_durable_memories (
        household_id, memory_type, label, normalized_label, summary, attributes_json, source_kind, source_chat_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(household_id, memory_type, normalized_label)
      DO UPDATE SET
        label = excluded.label,
        summary = excluded.summary,
        attributes_json = excluded.attributes_json,
        source_kind = excluded.source_kind,
        source_chat_id = excluded.source_chat_id,
        updated_at = CURRENT_TIMESTAMP
      `,
      [
        householdId,
        record.memoryType,
        record.label,
        record.normalizedLabel,
        record.summary,
        attributesJson,
        sourceKind,
        sourceChatId,
      ],
      function (err) {
        if (err) reject(err);
        else resolve({ id: this.lastID || null, changes: this.changes });
      }
    );
  });
}

export function deleteSmartDurableMemory(householdId, id) {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM smart_durable_memories WHERE household_id = ? AND id = ?`,
      [householdId, id],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes);
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

/**
 * For matched unchecked rows during !grocerylist merge:
 * - Set source_chat_id when currently NULL
 * - Keep as-is when already this chat
 * - Never overwrite another chat's non-null provenance
 */
export function backfillGroceryItemSourceChatIfSafe(householdId, id, sourceChatId) {
  const cid = Number(sourceChatId);
  if (!Number.isFinite(cid)) return Promise.resolve(0);
  return new Promise((resolve, reject) => {
    db.run(
      `
      UPDATE grocery_items
      SET source_chat_id = ?
      WHERE id = ?
        AND household_id = ?
        AND checked = 0
        AND (source_chat_id IS NULL OR source_chat_id = ?)
      `,
      [cid, id, householdId, cid],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes || 0);
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
      else resolve(this.changes || 0);
    });
  });
}

function normalizeGroceryNameKeyForPrune(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Remove unchecked stale rows for prune mode:
 * - Rows attributed to sourceChatId: delete when normalized name is not in the current run (unchanged).
 * - Rows with NULL source_chat_id: delete only when normalized name is in staleNormalizedKeys (e.g. swapped-out ingredients).
 * - Never delete checked rows. Never delete rows attributed to a different non-null chat.
 */
export async function pruneStaleGroceryItemsForChat(
  householdId,
  currentRunNameKeys,
  sourceChatId,
  staleNormalizedKeys
) {
  const cid = Number(sourceChatId);
  if (!Number.isFinite(cid)) return 0;
  const runKeys = currentRunNameKeys instanceof Set ? currentRunNameKeys : new Set();
  const staleKeys = staleNormalizedKeys instanceof Set ? staleNormalizedKeys : new Set();
  const existing = await getGroceryItems(householdId);
  let removed = 0;
  for (const e of existing) {
    if (e.checked) continue;
    const k = normalizeGroceryNameKeyForPrune(e.name);
    const sid = e.source_chat_id == null ? null : Number(e.source_chat_id);
    let shouldDelete = false;
    if (sid === cid) {
      if (!runKeys.has(k)) shouldDelete = true;
    } else if (sid == null && staleKeys.has(k)) {
      shouldDelete = true;
    }
    if (!shouldDelete) continue;
    try {
      await deleteGroceryItem(householdId, e.id);
      removed += 1;
    } catch (_) {
      // Row removed concurrently.
    }
  }
  return removed;
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
