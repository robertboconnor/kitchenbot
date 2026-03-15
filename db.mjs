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