import sqlite3 from 'sqlite3';

const dbPath = process.env.DB_PATH || './chat.db';
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      role TEXT,
      name TEXT,
      content TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS memories (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS grocery_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      section TEXT NOT NULL,
      amount TEXT,
      checked INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS guest_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      message_count INTEGER DEFAULT 0,
      must_relogin INTEGER DEFAULT 0,
      password TEXT
    )
  `);

  db.run(`
    INSERT OR IGNORE INTO guest_state (id, message_count, must_relogin) VALUES (1, 0, 0)
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS elle_compliment_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      messages_since_last_compliment INTEGER DEFAULT 0,
      last_compliment_timestamp TEXT,
      recent_compliments TEXT,
      recent_templates TEXT,
      boost_mode INTEGER DEFAULT 0
    )
  `);

  db.run(`
    INSERT OR IGNORE INTO elle_compliment_state (
      id,
      messages_since_last_compliment,
      last_compliment_timestamp,
      recent_compliments,
      recent_templates,
      boost_mode
    )
    VALUES (1, 0, NULL, '[]', '[]', 0)
  `);

  // In case the table was created before boost_mode existed, try to add it.
  // This ALTER is safe to run on every startup; if the column already exists,
  // SQLite will return an error, which we ignore.
  db.run(
    `ALTER TABLE elle_compliment_state ADD COLUMN boost_mode INTEGER DEFAULT 0`,
    [],
    (err) => {
      // Ignore "duplicate column" style errors; they just mean we're already up to date.
      if (err && err.code !== 'SQLITE_ERROR') {
        // For unexpected errors, log but don't crash the process.
        console.error('elle_compliment_state migration error:', err);
      }
    }
  );

  db.run(`
    INSERT OR IGNORE INTO memories (key, value) VALUES
      ('child_nickname', 'Bizzy'),
      ('rob_style', 'concise'),
      ('elle_style', 'slightly more guided'),
      ('assistant_name', 'KitchenBot')
  `);
});

export function createChat(owner, title) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO chats (owner, title) VALUES (?, ?)`,
      [owner, title],
      function (err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

export function listChats(owner) {
  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT id, owner, title, created_at, updated_at
      FROM chats
      WHERE owner = ?
      ORDER BY updated_at DESC, id DESC
      `,
      [owner],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

export function listAllChats() {
  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT id, owner, title, created_at, updated_at
      FROM chats
      ORDER BY updated_at DESC, id DESC
      `,
      [],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

export function touchChat(chatId) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [chatId],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

export function updateChatTitle(chatId, title) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE chats SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [title, chatId],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

export function addMessage(chatId, role, name, content) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO messages (chat_id, role, name, content) VALUES (?, ?, ?, ?)`,
      [chatId, role, name, content],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

export function getMessages(chatId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT role, name, content FROM messages WHERE chat_id = ? ORDER BY id ASC`,
      [chatId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

export function clearMessages(chatId) {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM messages WHERE chat_id = ?`, [chatId], function (err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function deleteChat(owner, chatId) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(
        `DELETE FROM messages WHERE chat_id = ?`,
        [chatId],
        function (err) {
          if (err) {
            reject(err);
          }
        }
      );
      db.run(
        `DELETE FROM chats WHERE id = ? AND owner = ?`,
        [chatId, owner],
        function (err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  });
}

export function deleteChatById(chatId) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`DELETE FROM messages WHERE chat_id = ?`, [chatId], function (err) {
        if (err) reject(err);
      });
      db.run(`DELETE FROM chats WHERE id = ?`, [chatId], function (err) {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

export function upsertMemory(key, value) {
  return new Promise((resolve, reject) => {
    db.run(
      `
      INSERT INTO memories (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
      [key, value],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

export function addGroceryItems(items) {
  return new Promise((resolve, reject) => {
    if (!items || items.length === 0) return resolve();

    const stmt = db.prepare(
      `INSERT INTO grocery_items (name, section, amount, checked) VALUES (?, ?, ?, 0)`
    );

    db.serialize(() => {
      for (const item of items) {
        stmt.run([item.name, item.section, item.amount || '']);
      }
      stmt.finalize(err => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

export function getGroceryItems() {
  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT id, name, section, amount, checked
      FROM grocery_items
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
      [],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

export function getMemories() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT key, value FROM memories ORDER BY key ASC`,
      [],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

export function updateGroceryItem(id, { checked }) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE grocery_items SET checked = ? WHERE id = ?`,
      [checked ? 1 : 0, id],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

export function deleteGroceryItem(id) {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM grocery_items WHERE id = ?`,
      [id],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

export function clearGroceryItems() {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM grocery_items`, [], function (err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function getGuestState() {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT message_count, must_relogin, password FROM guest_state WHERE id = 1`,
      [],
      (err, row) => {
        if (err) reject(err);
        else resolve(row || { message_count: 0, must_relogin: 0, password: null });
      }
    );
  });
}

export function getGuestMessageCount() {
  return getGuestState().then(s => s.message_count);
}

export function incrementGuestMessageCount() {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE guest_state SET message_count = message_count + 1 WHERE id = 1`,
      [],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

export function resetGuestMessageCount() {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE guest_state SET message_count = 0 WHERE id = 1`,
      [],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

export function setGuestMustRelogin(value) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE guest_state SET must_relogin = ? WHERE id = 1`,
      [value ? 1 : 0],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

export function setGuestPassword(password) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE guest_state SET password = ? WHERE id = 1`,
      [password],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

export function getElleComplimentState() {
  return new Promise((resolve, reject) => {
    db.get(
      `
      SELECT
        messages_since_last_compliment,
        last_compliment_timestamp,
        recent_compliments,
        recent_templates
      FROM elle_compliment_state
      WHERE id = 1
      `,
      [],
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

export function incrementElleMessageCount() {
  return new Promise((resolve, reject) => {
    db.run(
      `
      UPDATE elle_compliment_state
      SET messages_since_last_compliment = messages_since_last_compliment + 1
      WHERE id = 1
      `,
      [],
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

  // Baseline probability: small but non-zero from the start, increasing with message count.
  // Example: 1% base + 2% per message, capped so we don't explode before time multipliers.
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

  // Temporary boost mode (from !love) overrides organic probability.
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

  const complimentPool = compliments.filter(c => !recentCompliments.includes(c));
  const templatePool = templates.filter(t => !recentTemplates.includes(t));

  const availableCompliments = complimentPool.length > 0 ? complimentPool : compliments;
  const availableTemplates = templatePool.length > 0 ? templatePool : templates;

  const compliment =
    availableCompliments[Math.floor(Math.random() * availableCompliments.length)];
  const template =
    availableTemplates[Math.floor(Math.random() * availableTemplates.length)];

  return { compliment, template };
}

export function recordCompliment(compliment, template, now = new Date()) {
  return getElleComplimentState().then((state) => {
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
        UPDATE elle_compliment_state
        SET
          messages_since_last_compliment = 0,
          last_compliment_timestamp = ?,
          recent_compliments = ?,
          recent_templates = ?,
          boost_mode = 0
        WHERE id = 1
        `,
        [
          now.toISOString(),
          JSON.stringify(trimmedCompliments),
          JSON.stringify(trimmedTemplates),
        ],
        function (err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  });
}

export function setElleLoveBoost(active) {
  return new Promise((resolve, reject) => {
    db.run(
      `
      UPDATE elle_compliment_state
      SET boost_mode = ?
      WHERE id = 1
      `,
      [active ? 1 : 0],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}