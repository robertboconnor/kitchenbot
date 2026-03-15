import {
  createChat,
  listChats,
  listAllChats,
  touchChat,
  updateChatTitle,
  deleteChat,
  deleteChatById,
  addMessage,
  getMessages,
  getMemories,
  clearMessages,
  upsertMemory,
  addGroceryItems,
  getGroceryItems,
  updateGroceryItem,
  deleteGroceryItem,
  clearGroceryItems,
  getGuestState,
  getGuestMessageCount,
  incrementGuestMessageCount,
  resetGuestMessageCount,
  setGuestMustRelogin,
  setGuestPassword,
} from './db.mjs';
import 'dotenv/config';
import os from 'os';
import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import Anthropic from '@anthropic-ai/sdk';
import crypto from 'crypto';

const app = express();
const port = process.env.PORT || 3000;
const server = http.createServer(app);

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const USERS = {
  Rob: process.env.ROB_PASSWORD,
  Elle: process.env.ELLE_PASSWORD,
  Guest: process.env.GUEST_PASSWORD,
};

const COOKIE_NAME = 'kitchenbot_auth';
const COOKIE_SECRET = process.env.KITCHENBOT_SECRET;
if (!COOKIE_SECRET) {
  throw new Error('Missing KITCHENBOT_SECRET');
}

function signToken(name) {
  const hmac = crypto.createHmac('sha256', COOKIE_SECRET);
  hmac.update(name);
  const sig = hmac.digest('hex');
  return `${name}.${sig}`;
}

function verifyToken(token) {
  if (!token) return null;
  const [name, sig] = token.split('.');
  if (!name || !sig) return null;
  if (name !== 'Guest' && !USERS[name]) return null;

  const hmac = crypto.createHmac('sha256', COOKIE_SECRET);
  hmac.update(name);
  const expected = hmac.digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) {
    return null;
  }

  return name;
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return header.split(';').reduce((acc, part) => {
    const [key, ...rest] = part.trim().split('=');
    if (!key) return acc;
    acc[key] = decodeURIComponent(rest.join('='));
    return acc;
  }, {});
}

function getUserFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  return verifyToken(token);
}

async function requireAuth(req, res, next) {
  const user = getUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (user === 'Guest') {
    try {
      const state = await getGuestState();
      if (state.must_relogin) {
        return res.status(401).json({ error: 'Guest session invalidated. Please log in again.' });
      }
    } catch (e) {
      return res.status(500).json({ error: 'Server error' });
    }
  }
  req.user = user;
  next();
}

function parseMemoryCommand(prompt) {
  const match = prompt.match(/^!remember\s+([a-zA-Z0-9_]+)\s*=\s*(.+)$/);
  if (!match) return null;

  return {
    key: match[1].trim(),
    value: match[2].trim()
  };
}

function isMemoriesCommand(prompt) {
  return prompt === '!memories';
}

function isGroceryListCommand(prompt) {
  return prompt === '!grocerylist';
}

function getHelpReply(name) {
  const base = [
    'Memories & grocery',
    '• !remember `<key>` = `<value>` — Save a memory',
    '• !memories — List all memories',
    '• !grocerylist — Build grocery list from this chat',
    '',
    'Guest management',
    '• !resetguest — Reset Guest message count to 0',
    '• !bootguest — Invalidate Guest sessions (force re-login)',
    '• !guestpassword = `<string>` — Set Guest password',
    '',
    '• !rename — Have KitchenBot rename this chat',
    '• !rename `<string>` — Rename this chat manually',
    '• !help — Show this message',
  ];
  if (name === 'Rob') return base.join('\n');
  if (name === 'Elle') {
    return 'No special commands — just chat with KitchenBot as usual.\n\n' +
      '• !rename — Have KitchenBot rename this chat\n' +
      '• !rename `<string>` — Rename this chat manually\n' +
      '• !help — Show this message';
  }
  return 'You have a 5-message limit. You can view the grocery list but not edit it.\n\n' +
    '• !rename — Have KitchenBot rename this chat\n' +
    '• !rename `<string>` — Rename this chat manually\n' +
    '• !help — Show this message';
}

const compliments = [
  "you have a cute butt",
  "you are an awesome mother",
  "you look great today",
  "you have excellent taste in food",
  "you make this house run",
  "you are extremely charming",
  "you are ridiculously thoughtful",
  "you are the hottest dog-walker in the neighborhood"
];

const complimentTemplates = [
  "Oh and %s.",
  "Also, %s.",
  "By the way, %s.",
  "Quick aside: %s.",
  "Unrelated, but %s.",
  "%s btw.",
  "Small note: %s.",
  "And just so you know, %s.",
  "Before I forget: %s.",
  "One more thing — %s."
];

app.use(express.json());
app.use(express.static('public'));

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const rateLimitChat = new Map();

function rateLimitChatMiddleware(req, res, next) {
  const user = req.user;
  if (!user) return next();
  const now = Date.now();
  let entry = rateLimitChat.get(user);
  if (!entry) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitChat.set(user, entry);
  }
  if (now >= entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({ reply: 'Too many requests. Please slow down.' });
  }
  next();
}

app.get('/', (req, res) => {
  res.send(`
  <!doctype html>
  <html>
    <head>
      <title>KitchenBot</title>
      <link rel="icon" href="/logo.png" type="image/png" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <style>
        :root {
          --bg-gradient: radial-gradient(circle at top left, #ffe6f2, #e3f2ff 40%, #ffffff 80%);
          --card-bg: #ffffff;
          --accent: #ff7aa2;
          --accent-soft: #ffe0ec;
          --accent-strong: #ff4f87;
          --accent-blue: #6b9bd1;
          --accent-blue-soft: #e8f0f8;
          --assistant-bg: #f4f6fb;
          --border-subtle: #e3e6ee;
          --text-main: #1f2430;
          --text-soft: #6b7280;
          --shadow-soft: 0 18px 40px rgba(15, 23, 42, 0.12);
          --radius-lg: 18px;
          --radius-pill: 999px;
          --sidebar-bg: rgba(255, 255, 255, 0.94);
          --sidebar-border: rgba(148, 163, 184, 0.25);
          --sidebar-text-main: #1f2430;
          --sidebar-text-soft: #64748b;
        }

        * {
          box-sizing: border-box;
        }

        body {
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
          margin: 0;
          padding: 24px 16px 12px;
          height: 100vh;
          min-height: 0;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          align-items: stretch;
          background: var(--bg-gradient);
          color: var(--text-main);
        }

        #header {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 8px;
          flex-shrink: 0;
        }

        #header .tab-bar {
          flex: 1;
          display: flex;
          gap: 8px;
          margin-bottom: 0;
        }

        #header .tab-bar .tab-button {
          flex: 1;
        }

        #header.hide-tabs .tab-bar {
          display: none;
        }

        #header.hide-tabs #menu-button {
          display: none;
        }

        #login-area,
        #app {
          max-width: 900px;
          width: 100%;
          margin: 0 auto;
          flex: 1;
          min-width: 0;
        }

        #app {
          display: flex;
          flex-direction: column;
          gap: 12px;
          flex: 1;
          min-height: 0;
          overflow: hidden;
        }

        #sidebar-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.2);
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.15s ease;
          z-index: 20;
        }

        #sidebar {
          position: fixed;
          top: 0;
          left: 0;
          bottom: 0;
          width: 260px;
          max-width: 80%;
          background: var(--sidebar-bg);
          backdrop-filter: blur(12px);
          color: var(--sidebar-text-main);
          border-right: 1px solid var(--sidebar-border);
          box-shadow: 8px 0 24px rgba(0, 0, 0, 0.08);
          transform: translateX(-100%);
          transition: transform 0.18s ease-out;
          z-index: 30;
          display: flex;
          flex-direction: column;
          padding: 14px 12px;
        }

        #sidebar.open {
          transform: translateX(0);
        }

        #sidebar-backdrop.open {
          opacity: 1;
          pointer-events: auto;
        }

        #sidebar-header {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 10px;
        }

        #sidebar-header .sidebar-logo {
          width: 36px;
          height: 36px;
          object-fit: contain;
          flex-shrink: 0;
        }

        #sidebar-header .sidebar-header-text {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          min-width: 0;
        }

        #sidebar-header h2 {
          margin: 0;
          font-size: 14px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--sidebar-text-soft);
        }

        #new-chat {
          padding: 5px 10px;
          font-size: 12px;
          border-radius: 999px;
          border: 1px solid var(--accent);
          background: var(--accent);
          color: #fff;
        }

        #new-chat:hover {
          background: var(--accent-strong);
          border-color: var(--accent-strong);
        }

        #chat-list {
          list-style: none;
          margin: 0;
          padding: 0;
          flex: 1;
          overflow-y: auto;
        }

        #sidebar-footer {
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px solid var(--sidebar-border);
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          font-size: 12px;
          color: var(--sidebar-text-soft);
        }

        #sidebar-user {
          color: var(--sidebar-text-main);
          font-weight: 600;
        }

        #logout {
          padding: 6px 12px;
          font-size: 12px;
          border-radius: 999px;
          border: 1px solid var(--border-subtle);
          background: #fff;
          color: var(--text-main);
        }

        #logout:hover {
          background: var(--accent-blue-soft);
          border-color: var(--accent-blue);
          color: var(--text-main);
        }

        #sidebar-usage {
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px solid var(--sidebar-border);
          font-size: 12px;
          color: var(--sidebar-text-soft);
        }

        #sidebar-usage .sidebar-usage-label {
          margin-right: 4px;
        }

        #usage-amount {
          font-weight: 600;
          color: var(--sidebar-text-main);
        }

        .chat-list-item {
          padding: 7px 9px;
          border-radius: 9px;
          font-size: 13px;
          cursor: pointer;
          margin-bottom: 4px;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .chat-list-item span.title {
          display: block;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .chat-list-item span.meta {
          display: block;
          font-size: 11px;
          color: #9ca3af;
        }

        .chat-list-item.active {
          background: var(--accent-soft);
          color: var(--text-main);
        }

        .chat-list-item .g-delete {
          flex-shrink: 0;
          min-width: 28px;
          min-height: 28px;
        }

        #menu-button {
          width: 34px;
          height: 34px;
          border-radius: 999px;
          border: 1px solid var(--border-subtle);
          background: rgba(255, 255, 255, 0.9);
          color: var(--text-main);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 18px;
          box-shadow: var(--shadow-soft);
          padding: 0;
        }

        #menu-button:hover {
          background: var(--accent-blue-soft);
          border-color: var(--accent-blue);
        }

        #login-area {
          margin-top: 24px;
        }

        #login-brand {
          text-align: center;
          margin-bottom: 20px;
        }

        #login-brand .login-logo {
          width: 80px;
          height: 80px;
          object-fit: contain;
          display: block;
          margin: 0 auto 12px;
        }

        #login-brand .login-title {
          margin: 0;
          font-size: 26px;
          font-weight: 700;
          color: var(--text-main);
          letter-spacing: -0.02em;
        }

        #login-form {
          background: var(--card-bg);
          border-radius: var(--radius-lg);
          padding: 16px 18px;
          box-shadow: var(--shadow-soft);
          border: 1px solid rgba(148, 163, 184, 0.25);
          display: inline-flex;
          flex-wrap: wrap;
          gap: 10px 12px;
          align-items: center;
        }

        #login-form h2,
        #login-area h2 {
          font-size: 16px;
          margin: 0 0 8px;
          color: var(--text-soft);
          font-weight: 500;
        }

        label {
          font-size: 13px;
          color: var(--text-soft);
        }

        #login-name,
        #login-password {
          padding: 6px 9px;
          border-radius: 999px;
          border: 1px solid var(--border-subtle);
          font-size: 14px;
          outline: none;
          min-width: 120px;
        }

        #login-name:focus,
        #login-password:focus {
          border-color: var(--accent);
          box-shadow: 0 0 0 2px rgba(255, 122, 162, 0.25);
        }

        #login-button {
          border-radius: var(--radius-pill);
          background: var(--accent);
          color: #fff;
          border: none;
          font-size: 14px;
          padding: 8px 14px;
          font-weight: 500;
          box-shadow: 0 8px 18px rgba(255, 122, 162, 0.45);
          transition: transform 0.08s ease, box-shadow 0.08s ease, background 0.12s ease;
        }

        #login-button:hover {
          background: var(--accent-strong);
          transform: translateY(-1px);
          box-shadow: 0 10px 20px rgba(255, 79, 135, 0.5);
        }

        #login-button:active {
          transform: translateY(0);
          box-shadow: 0 6px 14px rgba(255, 79, 135, 0.45);
        }

        #login-status {
          font-size: 12px;
          color: var(--accent-strong);
          min-height: 1em;
        }

        #chat {
          border-radius: var(--radius-lg);
          padding: 16px 18px;
          background: rgba(255, 255, 255, 0.9);
          backdrop-filter: blur(14px);
          display: flex;
          flex-direction: column;
          flex: 1;
          overflow-y: auto;
          min-height: 0;
          box-shadow: var(--shadow-soft);
          border: 1px solid rgba(148, 163, 184, 0.18);
        }

        .tab-bar {
          display: flex;
          gap: 8px;
        }

        .tab-button {
          flex: 1;
          justify-content: center;
          border-radius: 999px;
          font-size: 13px;
          padding-block: 7px;
          border: 1px solid rgba(148, 163, 184, 0.7);
          background: rgba(255, 255, 255, 0.7);
          -webkit-tap-highlight-color: transparent;
          touch-action: manipulation;
        }

        .tab-button:not(.tab-active):hover {
          background: #f3f4ff;
          transform: translateY(-0.5px);
          box-shadow: 0 6px 14px rgba(148, 163, 184, 0.35);
        }

        .tab-button:not(.tab-active):active {
          transform: translateY(0);
          box-shadow: 0 3px 8px rgba(148, 163, 184, 0.3);
        }

        .tab-active {
          background: var(--accent);
          color: #fff;
          border-color: var(--accent);
          box-shadow: 0 4px 12px rgba(255, 122, 162, 0.4);
        }

        .tab-button.tab-active:hover,
        .tab-button.tab-active:active {
          background: var(--accent-strong);
          color: #fff;
          border-color: var(--accent-strong);
          transform: none;
          box-shadow: 0 4px 12px rgba(255, 79, 135, 0.4);
        }

        .panel {
          border-radius: var(--radius-lg);
        }

        #grocery-panel {
          background: rgba(255, 255, 255, 0.9);
          backdrop-filter: blur(14px);
          box-shadow: var(--shadow-soft);
          border: 1px solid rgba(148, 163, 184, 0.18);
          padding: 14px 16px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          flex: 1;
          overflow-y: auto;
        }

        #grocery-sections {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .g-section h3 {
          margin: 0 0 6px;
          font-size: 13px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--text-soft);
        }

        .g-list {
          list-style: none;
          margin: 0;
          padding: 0;
          font-size: 14px;
        }

        .g-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          padding: 6px 8px;
          border-radius: 10px;
          border: 1px solid rgba(229, 231, 235, 0.9);
          background: rgba(249, 250, 251, 0.85);
          margin-bottom: 4px;
        }

        .g-left {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .g-item input[type='checkbox'] {
          width: 16px;
          height: 16px;
        }

        .g-text-main {
          font-weight: 500;
        }

        .g-text-amount {
          font-size: 12px;
          color: var(--text-soft);
        }

        .g-item-checked {
          background: #e5e7eb;
          text-decoration: line-through;
          opacity: 0.7;
        }

        .g-delete {
          border-radius: 999px;
          padding: 4px 8px;
          font-size: 11px;
          border-color: #fecaca;
          background: #fef2f2;
          color: #b91c1c;
        }

        .g-delete:hover {
          background: #fee2e2;
        }

        #grocery-actions {
          margin-top: 8px;
          display: flex;
          justify-content: flex-end;
          gap: 8px;
        }

        .message {
          margin-bottom: 10px;
          padding: 9px 12px;
          border-radius: 16px;
          white-space: pre-wrap;
          max-width: 80%;
          font-size: 14px;
          line-height: 1.4;
        }

        .message-author {
          display: block;
          font-size: 11px;
          font-weight: 600;
          color: var(--text-soft);
          margin-bottom: 4px;
          letter-spacing: 0.02em;
        }

        .message-body {
          white-space: pre-wrap;
        }

        .message.assistant .message-body {
          white-space: normal;
        }

        .message.assistant .md-wrap {
          white-space: normal;
        }

        .message.assistant .md-wrap p:first-child { margin-top: 0; }
        .message.assistant .md-wrap p:last-child { margin-bottom: 0; }
        .message.assistant .md-wrap p { margin: 0.5em 0; }
        .message.assistant .md-wrap h1 { font-size: 1.25em; margin: 0.75em 0 0.35em; font-weight: 700; }
        .message.assistant .md-wrap h2 { font-size: 1.1em; margin: 0.65em 0 0.3em; font-weight: 700; }
        .message.assistant .md-wrap h3 { font-size: 1em; margin: 0.5em 0 0.25em; font-weight: 600; }
        .message.assistant .md-wrap ul, .message.assistant .md-wrap ol { margin: 0.5em 0; padding-left: 1.4em; }
        .message.assistant .md-wrap li { margin: 0.2em 0; }
        .message.assistant .md-wrap blockquote { margin: 0.5em 0; padding: 0.35em 0 0.35em 0.75em; border-left: 3px solid var(--text-soft); color: var(--text-soft); }
        .message.assistant .md-wrap code { background: rgba(0,0,0,0.06); padding: 0.15em 0.4em; border-radius: 4px; font-size: 0.9em; }
        .message.assistant .md-wrap pre { margin: 0.5em 0; padding: 10px; border-radius: 8px; background: rgba(0,0,0,0.06); overflow-x: auto; white-space: pre; }
        .message.assistant .md-wrap pre code { background: none; padding: 0; }
        .message.assistant .md-wrap table { border-collapse: collapse; margin: 0.5em 0; font-size: 0.9em; }
        .message.assistant .md-wrap th, .message.assistant .md-wrap td { border: 1px solid var(--border-subtle); padding: 4px 8px; text-align: left; }
        .message.assistant .md-wrap th { background: rgba(0,0,0,0.04); font-weight: 600; }
        .message.assistant .md-wrap hr { border: none; border-top: 1px solid var(--border-subtle); margin: 0.75em 0; }
        .message.assistant .md-wrap a { color: var(--accent-strong); text-decoration: none; }
        .message.assistant .md-wrap a:hover { text-decoration: underline; }

        .user {
          background: var(--accent-soft);
          margin-left: auto;
          text-align: left;
        }

        .assistant {
          background: var(--assistant-bg);
          margin-right: auto;
          text-align: left;
        }

        .rob {
          background: #dbeafe;
        }

        .elle {
          background: #ffe4ea;
        }

        .guest {
          background: #f1f5f9;
        }

        textarea {
          flex: 1;
          min-width: 0;
          height: 44px;
          min-height: 44px;
          max-height: 120px;
          padding: 10px 12px;
          box-sizing: border-box;
          border-radius: 20px;
          border: 1px solid var(--border-subtle);
          resize: none;
          font-size: 14px;
          font-family: inherit;
          outline: none;
          line-height: 1.4;
        }

        textarea:focus {
          border-color: var(--accent);
          box-shadow: 0 0 0 2px rgba(255, 122, 162, 0.25);
        }

        #typing-indicator {
          flex-shrink: 0;
          min-height: 20px;
          font-size: 12px;
          color: var(--text-soft);
          padding: 2px 0 4px;
        }

        #typing-indicator:empty {
          display: none;
        }

        #input-area {
          display: flex;
          flex-direction: row;
          align-items: flex-end;
          gap: 8px;
          flex-shrink: 0;
        }

        button {
          padding: 9px 14px;
          cursor: pointer;
          align-self: flex-start;
          border-radius: var(--radius-pill);
          border: 1px solid rgba(148, 163, 184, 0.7);
          background: #ffffff;
          font-size: 14px;
          font-weight: 500;
          color: var(--text-main);
          transition: background 0.1s ease, transform 0.08s ease, box-shadow 0.08s ease;
        }

        button:hover {
          background: #f3f4ff;
          transform: translateY(-0.5px);
          box-shadow: 0 6px 14px rgba(148, 163, 184, 0.35);
        }

        button:active {
          transform: translateY(0);
          box-shadow: 0 3px 8px rgba(148, 163, 184, 0.3);
        }

        #logout {
          padding: 6px 12px;
          font-size: 12px;
          border-color: rgba(148, 163, 184, 0.6);
          background: #ffffff;
        }

        #logout:hover {
          background: var(--accent-blue-soft);
        }

        #input-area #send {
          flex-shrink: 0;
          width: 36px;
          height: 36px;
          min-width: 36px;
          min-height: 36px;
          padding: 0;
          border-radius: 50%;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 18px;
          line-height: 1;
          background: var(--accent);
          color: #fff;
          border: none;
          box-shadow: 0 2px 8px rgba(255, 122, 162, 0.5);
        }

        #input-area #send:hover {
          background: var(--accent-strong);
          box-shadow: 0 4px 12px rgba(255, 79, 135, 0.55);
        }

        @media (max-width: 640px) {
          body {
            padding: 8px 6px 6px;
          }

          #sidebar {
            width: 88%;
            max-width: 88%;
          }

          #login-area,
          #app {
            max-width: 100%;
          }

          #app {
            /* already flex: 1 min-height: 0 from base */
          }

          #login-area {
            margin-top: 16px;
            width: 100%;
          }

          #login-area h2 {
            font-size: 18px;
            margin-bottom: 16px;
            color: var(--text-main);
          }

          #login-form {
            display: flex;
            flex-direction: column;
            align-items: stretch;
            width: 100%;
            padding: 20px 18px;
            gap: 14px;
          }

          #login-form label {
            font-size: 14px;
            margin-bottom: -6px;
          }

          #login-form label + select,
          #login-form label + input {
            margin-top: 4px;
          }

          #login-name,
          #login-password {
            width: 100%;
            min-width: 0;
            min-height: 44px;
            padding: 10px 14px;
            font-size: 16px;
            border-radius: 12px;
          }

          #login-button {
            min-height: 44px;
            padding: 12px 20px;
            font-size: 16px;
            margin-top: 4px;
          }

          #login-status {
            margin-top: -4px;
          }

          #chat {
            padding: 10px 8px;
          }

          .message {
            max-width: 100%;
          }

          textarea {
            min-height: 44px;
            font-size: 16px;
          }
        }

        @supports (height: 100dvh) {
          body {
            height: 100dvh;
          }
        }
      </style>
    </head>
    <body>
      <div id="header" class="hide-tabs">
        <button id="menu-button" aria-label="Open chat history">☰</button>
        <div id="tab-bar" class="tab-bar">
          <button id="tab-chat" class="tab-button tab-active">Chat</button>
          <button id="tab-groceries" class="tab-button">Grocery List</button>
        </div>
      </div>

      <div id="sidebar-backdrop"></div>
      <aside id="sidebar">
        <div id="sidebar-header">
          <img src="/logo.png" alt="" class="sidebar-logo" />
          <div class="sidebar-header-text">
            <h2>Your chats</h2>
            <button id="new-chat">+ New</button>
          </div>
        </div>
        <ul id="chat-list"></ul>
        <div id="sidebar-footer">
          <span>Logged in as: <strong id="speaker-name"></strong></span>
          <button id="logout">Logout</button>
        </div>
        <div id="sidebar-usage">
          <span class="sidebar-usage-label">Usage (L30d):</span>
          <span id="usage-amount">—</span>
        </div>
      </aside>

      <div id="login-area">
        <div id="login-brand">
          <img src="/logo.png" alt="" class="login-logo" />
          <h1 class="login-title">KitchenBot</h1>
        </div>
        <div id="login-form">
          <label for="login-name">Name:</label>
          <select id="login-name">
            <option value="Rob">Rob</option>
            <option value="Elle">Elle</option>
            <option value="Guest">Guest</option>
          </select>
          <label for="login-password">Password:</label>
          <input id="login-password" type="password" />
          <button id="login-button">Login</button>
          <div id="login-status"></div>
        </div>
      </div>

      <div id="app" style="display:none;">
        <div id="chat" class="panel panel-active"></div>

        <div id="typing-indicator" aria-live="polite"></div>

        <div id="grocery-panel" class="panel" style="display:none;">
          <div id="grocery-sections">
            <div class="g-section" data-section="produce">
              <h3>Produce</h3>
              <ul class="g-list" id="g-list-produce"></ul>
            </div>
            <div class="g-section" data-section="meat">
              <h3>Meat</h3>
              <ul class="g-list" id="g-list-meat"></ul>
            </div>
            <div class="g-section" data-section="dairy">
              <h3>Dairy</h3>
              <ul class="g-list" id="g-list-dairy"></ul>
            </div>
            <div class="g-section" data-section="frozen">
              <h3>Frozen</h3>
              <ul class="g-list" id="g-list-frozen"></ul>
            </div>
            <div class="g-section" data-section="dry">
              <h3>Dry Goods</h3>
              <ul class="g-list" id="g-list-dry"></ul>
            </div>
            <div class="g-section" data-section="other">
              <h3>Other</h3>
              <ul class="g-list" id="g-list-other"></ul>
            </div>
          </div>
          <div id="grocery-actions">
            <button id="grocery-refresh">Refresh list</button>
            <button id="grocery-clear">Clear list</button>
          </div>
        </div>

        <div id="input-area">
          <textarea id="prompt" placeholder="Ask KitchenBot something..." rows="1"></textarea>
          <button id="send" type="button" aria-label="Send">↑</button>
        </div>
      </div>

      <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
      <script>
        const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        const hasTouch = typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 0;
        const useMobileEnterBehavior = isMobile || hasTouch;
        const loginArea = document.getElementById('login-area');
        const appArea = document.getElementById('app');
        const loginNameSelect = document.getElementById('login-name');
        const loginPasswordInput = document.getElementById('login-password');
        const loginButton = document.getElementById('login-button');
        const loginStatus = document.getElementById('login-status');
        const speakerName = document.getElementById('speaker-name');
        const menuButton = document.getElementById('menu-button');
        const sidebar = document.getElementById('sidebar');
        const sidebarBackdrop = document.getElementById('sidebar-backdrop');
        const chatListEl = document.getElementById('chat-list');
        const newChatButton = document.getElementById('new-chat');
        const chat = document.getElementById('chat');
        const groceryPanel = document.getElementById('grocery-panel');
        const tabChat = document.getElementById('tab-chat');
        const tabGroceries = document.getElementById('tab-groceries');
        const groceryRefreshButton = document.getElementById('grocery-refresh');
        const groceryClearButton = document.getElementById('grocery-clear');
        const promptInput = document.getElementById('prompt');
        const sendButton = document.getElementById('send');
        const logoutButton = document.getElementById('logout');
        const typingIndicator = document.getElementById('typing-indicator');

        const groceryLists = {
          produce: document.getElementById('g-list-produce'),
          meat: document.getElementById('g-list-meat'),
          dairy: document.getElementById('g-list-dairy'),
          frozen: document.getElementById('g-list-frozen'),
          dry: document.getElementById('g-list-dry'),
          other: document.getElementById('g-list-other'),
        };

        let currentChatId = null;
        let currentUserName = null;
        let chatsCache = [];
        let lastDeletedGrocery = null;
        let lastDeletedTimeout = null;

        let typingWs = null;
        const typingUsers = new Set();
        let typingStopTimeout = null;
        let weAreStreamingThisChat = false;
        let remoteStreamBodyEl = null;

        const headerEl = document.getElementById('header');

        function formatTypingText(users) {
          const arr = Array.from(users).filter(u => u && u !== currentUserName);
          if (arr.length === 0) return '';
          if (arr.length === 1) return arr[0] + ' is typing…';
          if (arr.length === 2) return arr[0] + ' and ' + arr[1] + ' are typing…';
          return arr.slice(0, -1).join(', ') + ', and ' + arr[arr.length - 1] + ' are typing…';
        }

        function updateTypingIndicator() {
          if (chat.style.display === 'none') {
            typingIndicator.textContent = '';
            return;
          }
          typingIndicator.textContent = formatTypingText(typingUsers);
        }

        function sendTypingViewing() {
          if (!typingWs || typingWs.readyState !== 1) return;
          typingWs.send(JSON.stringify({ type: 'viewing', chatId: currentChatId }));
          typingUsers.clear();
          updateTypingIndicator();
        }

        function connectTypingWs() {
          if (!currentUserName) return;
          const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
          const url = proto + '//' + location.host;
          try {
            const ws = new WebSocket(url);
            ws.onopen = () => {
              ws.send(JSON.stringify({ type: 'identify', user: currentUserName }));
              sendTypingViewing();
            };
            ws.onmessage = (event) => {
              try {
                const msg = JSON.parse(event.data);
                const msgChatId = msg.chatId != null ? Number(msg.chatId) : null;
                if (msg.type === 'chat_updated' && msgChatId === currentChatId) {
                  remoteStreamBodyEl = null;
                  if (!weAreStreamingThisChat) loadHistory();
                  return;
                }
                if (msg.type === 'stream_delta' && msgChatId === currentChatId && !weAreStreamingThisChat) {
                  if (!remoteStreamBodyEl) {
                    const wrap = document.createElement('div');
                    wrap.className = 'message assistant';
                    const author = document.createElement('span');
                    author.className = 'message-author';
                    author.textContent = 'KitchenBot';
                    wrap.appendChild(author);
                    const body = document.createElement('div');
                    body.className = 'message-body';
                    wrap.appendChild(body);
                    chat.appendChild(wrap);
                    remoteStreamBodyEl = body;
                    chat.scrollTop = chat.scrollHeight;
                  }
                  if (remoteStreamBodyEl && msg.delta) {
                    remoteStreamBodyEl.appendChild(document.createTextNode(msg.delta));
                    chat.scrollTop = chat.scrollHeight;
                  }
                  return;
                }
                if (msg.type === 'user_typing' || msg.type === 'user_stopped_typing') {
                  if (msgChatId != null && msgChatId !== currentChatId) return;
                  if (msg.user === currentUserName) return;
                  if (msg.type === 'user_typing') {
                    typingUsers.add(msg.user);
                    updateTypingIndicator();
                  } else {
                    typingUsers.delete(msg.user);
                    updateTypingIndicator();
                  }
                }
              } catch (e) {}
            };
            ws.onclose = () => {
              typingWs = null;
            };
            typingWs = ws;
          } catch (e) {}
        }

        function showApp(name) {
          loginArea.style.display = 'none';
          appArea.style.display = 'flex';
          appArea.style.flexDirection = 'column';
          headerEl.classList.remove('hide-tabs');
          if (name) {
            speakerName.textContent = name;
          }
        }

        function showLogin() {
          loginArea.style.display = 'block';
          appArea.style.display = 'none';
          headerEl.classList.add('hide-tabs');
        }

        function setActiveTab(tab) {
          if (tab === 'chat') {
            tabChat.classList.add('tab-active');
            tabGroceries.classList.remove('tab-active');
            chat.style.display = 'flex';
            groceryPanel.style.display = 'none';
          } else {
            tabGroceries.classList.add('tab-active');
            tabChat.classList.remove('tab-active');
            chat.style.display = 'none';
            groceryPanel.style.display = 'flex';
          }
        }

        function sendTyping(isTyping) {
          if (!typingWs || typingWs.readyState !== 1 || !currentChatId) return;
          typingWs.send(JSON.stringify({
            type: isTyping ? 'typing' : 'stopped_typing',
            chatId: currentChatId,
          }));
        }

        promptInput.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') return;
          if (useMobileEnterBehavior) return;
          if (event.shiftKey) return;
          event.preventDefault();
          sendButton.click();
        });

        promptInput.addEventListener('input', () => {
          if (!currentChatId) return;
          sendTyping(true);
          if (typingStopTimeout) clearTimeout(typingStopTimeout);
          typingStopTimeout = setTimeout(() => {
            typingStopTimeout = null;
            sendTyping(false);
          }, 2000);
        });

        function renderMarkdown(text) {
          if (typeof marked === 'undefined') return document.createTextNode(text);
          try {
            const html = marked.parse(String(text), { gfm: true, breaks: true });
            const wrap = document.createElement('span');
            wrap.className = 'md-wrap';
            wrap.innerHTML = html;
            return wrap;
          } catch (e) {
            return document.createTextNode(text);
          }
        }

        function addMessage(role, name, content) {
          if (content === undefined && typeof name === 'string' && name.includes(': ')) {
            const idx = name.indexOf(': ');
            content = name.slice(idx + 2);
            name = name.slice(0, idx);
          } else if (content === undefined) {
            content = name;
            name = role === 'user' ? (speakerName && speakerName.textContent) || 'User' : 'KitchenBot';
          }
          const div = document.createElement('div');
          div.className = 'message ' + role;
          if (role === 'user') {
            if (name === 'Rob') div.classList.add('rob');
            if (name === 'Elle') div.classList.add('elle');
            if (name === 'Guest') div.classList.add('guest');
          }
          const author = document.createElement('span');
          author.className = 'message-author';
          author.textContent = name;
          div.appendChild(author);
          const body = document.createElement('div');
          body.className = 'message-body';
          if (role === 'assistant') {
            body.appendChild(renderMarkdown(content));
          } else {
            body.textContent = content;
          }
          div.appendChild(body);
          chat.appendChild(div);
          chat.scrollTop = chat.scrollHeight;
        }

        async function loadHistory() {
          if (!currentChatId) return;
          remoteStreamBodyEl = null;
          const response = await fetch('/history?chatId=' + encodeURIComponent(currentChatId));
          if (!response.ok) {
            if (response.status === 401) {
              showLogin();
            }
            return;
          }
          const data = await response.json();

          chat.innerHTML = '';

          for (const message of data.conversation) {
            addMessage(message.role, message.name, message.content);
          }
          sendTypingViewing();
        }

        async function loadGroceries() {
          try {
            const response = await fetch('/groceries');
            if (!response.ok) {
              return;
            }
            const data = await response.json();

            Object.values(groceryLists).forEach(list => {
              list.innerHTML = '';
            });

            const isGuest = currentUserName === 'Guest';

            for (const item of data.items || []) {
              const li = document.createElement('li');
              li.className = 'g-item' + (item.checked ? ' g-item-checked' : '');
              li.dataset.id = item.id;
              li.dataset.section = item.section;

              const left = document.createElement('div');
              left.className = 'g-left';

              if (!isGuest) {
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = !!item.checked;
                checkbox.addEventListener('change', async () => {
                  li.classList.toggle('g-item-checked', checkbox.checked);
                  try {
                    await fetch('/groceries/' + item.id, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ checked: checkbox.checked })
                    });
                  } catch (e) {}
                });
                left.appendChild(checkbox);
              }

              const textContainer = document.createElement('div');
              const main = document.createElement('div');
              main.className = 'g-text-main';
              main.textContent = item.name;
              const amount = document.createElement('div');
              amount.className = 'g-text-amount';
              amount.textContent = item.amount || '';
              textContainer.appendChild(main);
              if (item.amount) {
                textContainer.appendChild(amount);
              }

              left.appendChild(textContainer);

              li.appendChild(left);

              if (!isGuest) {
                const del = document.createElement('button');
                del.className = 'g-delete';
                del.textContent = '×';
                del.addEventListener('click', async () => {
                const removedItem = { ...item };
                li.remove();
                try {
                  await fetch('/groceries/' + item.id, { method: 'DELETE' });
                } catch (e) {}

                if (lastDeletedTimeout) {
                  clearTimeout(lastDeletedTimeout);
                  lastDeletedTimeout = null;
                }
                lastDeletedGrocery = removedItem;

                let undoBar = document.getElementById('grocery-undo');
                if (!undoBar) {
                  undoBar = document.createElement('div');
                  undoBar.id = 'grocery-undo';
                  undoBar.style.position = 'fixed';
                  undoBar.style.bottom = '16px';
                  undoBar.style.left = '50%';
                  undoBar.style.transform = 'translateX(-50%)';
                  undoBar.style.background = '#111827';
                  undoBar.style.color = '#f9fafb';
                  undoBar.style.padding = '6px 10px';
                  undoBar.style.borderRadius = '999px';
                  undoBar.style.fontSize = '12px';
                  undoBar.style.display = 'flex';
                  undoBar.style.alignItems = 'center';
                  undoBar.style.gap = '6px';
                  const textSpan = document.createElement('span');
                  textSpan.textContent = 'Item deleted';
                  const undoBtn = document.createElement('button');
                  undoBtn.textContent = 'Undo';
                  undoBtn.style.background = '#f9fafb';
                  undoBtn.style.color = '#111827';
                  undoBtn.style.borderRadius = '999px';
                  undoBtn.style.border = 'none';
                  undoBtn.style.fontSize = '12px';
                  undoBtn.style.padding = '3px 8px';
                  undoBtn.addEventListener('click', async () => {
                    if (!lastDeletedGrocery) return;
                    const toRestore = lastDeletedGrocery;
                    lastDeletedGrocery = null;
                    undoBar.remove();
                    try {
                      await fetch('/groceries', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ items: [toRestore] }),
                      });
                      await loadGroceries();
                    } catch (e) {}
                  });
                  undoBar.appendChild(textSpan);
                  undoBar.appendChild(undoBtn);
                  document.body.appendChild(undoBar);
                }

                lastDeletedTimeout = setTimeout(() => {
                  const bar = document.getElementById('grocery-undo');
                  if (bar) bar.remove();
                  lastDeletedGrocery = null;
                  lastDeletedTimeout = null;
                }, 3000);
              });
                li.appendChild(del);
              }

              const targetList = groceryLists[item.section] || groceryLists.other;
              targetList.appendChild(li);
            }

            groceryClearButton.style.display = (currentUserName === 'Rob') ? '' : 'none';
          } catch (e) {
            // ignore for now
          }
        }

        function renderChats() {
          chatListEl.innerHTML = '';
          for (const chatInfo of chatsCache) {
            const li = document.createElement('li');
            li.className = 'chat-list-item' + (chatInfo.id === currentChatId ? ' active' : '');
            const titleSpan = document.createElement('span');
            titleSpan.className = 'title';
            titleSpan.textContent = chatInfo.title || 'Untitled chat';
            const metaSpan = document.createElement('span');
            metaSpan.className = 'meta';
            metaSpan.textContent = chatInfo.created_at ? new Date(chatInfo.created_at).toLocaleDateString() : '';

            const contentDiv = document.createElement('div');
            contentDiv.style.flex = '1';
            contentDiv.style.minWidth = '0';
            contentDiv.appendChild(titleSpan);
            contentDiv.appendChild(metaSpan);

            li.appendChild(contentDiv);

            if (currentUserName === 'Rob') {
              const delBtn = document.createElement('button');
              delBtn.textContent = '×';
              delBtn.className = 'g-delete';
              delBtn.style.marginLeft = '4px';
              if (chatInfo.id === currentChatId) {
                delBtn.disabled = true;
                delBtn.style.opacity = '0.4';
              }
              delBtn.addEventListener('click', async (event) => {
                event.stopPropagation();
                if (chatInfo.id === currentChatId) return;
                if (!confirm('Delete this chat?')) return;
                try {
                  const resp = await fetch('/chats/' + chatInfo.id, { method: 'DELETE' });
                  if (!resp.ok) return;
                  chatsCache = chatsCache.filter(c => c.id !== chatInfo.id);
                  if (currentChatId === chatInfo.id) {
                    currentChatId = chatsCache.length ? chatsCache[0].id : null;
                    chat.innerHTML = '';
                    if (currentChatId) {
                      await loadHistory();
                    }
                  }
                  renderChats();
                } catch (e) {}
              });
              li.appendChild(delBtn);
            }

            li.addEventListener('click', async () => {
              currentChatId = chatInfo.id;
              renderChats();
              sidebar.classList.remove('open');
              sidebarBackdrop.classList.remove('open');
              await loadHistory();
            });
            chatListEl.appendChild(li);
          }
        }

        async function loadChatsAndEnsureOne() {
          const response = await fetch('/chats');
          if (!response.ok) {
            throw new Error('Failed to load chats');
          }
          const data = await response.json();
          chatsCache = data.chats || [];
          if (chatsCache.length === 0) {
            const createResp = await fetch('/chats', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ title: 'New chat' }),
            });
            if (!createResp.ok) throw new Error('Failed to create chat');
            const created = await createResp.json();
            currentChatId = created.id;
            chatsCache.unshift({ id: created.id, owner: created.owner, title: created.title, created_at: new Date().toISOString() });
          } else {
            currentChatId = chatsCache[0].id;
          }
          renderChats();
        }

        async function checkAuth() {
          try {
            const response = await fetch('/me');
            if (!response.ok) {
              showLogin();
              return;
            }

            const data = await response.json();
            currentUserName = data.name;
            showApp(data.name);
            await loadChatsAndEnsureOne();
            await loadHistory();
            connectTypingWs();
            loadUsage();
          } catch (error) {
            showLogin();
          }
        }

        checkAuth();

        tabChat.addEventListener('click', () => {
          setActiveTab('chat');
        });

        tabGroceries.addEventListener('click', async () => {
          setActiveTab('groceries');
          await loadGroceries();
        });

        async function loadUsage() {
          const block = document.getElementById('sidebar-usage');
          const el = document.getElementById('usage-amount');
          if (block) block.style.display = (currentUserName === 'Rob' || currentUserName === 'Elle') ? '' : 'none';
          if (currentUserName !== 'Rob' && currentUserName !== 'Elle') return;
          if (!el) return;
          try {
            const resp = await fetch('/usage');
            const data = await resp.json().catch(() => ({}));
            if (data.error) {
              el.textContent = '—';
              el.title = data.error;
            } else if (typeof data.totalUsd === 'number') {
              el.textContent = '$' + data.totalUsd.toFixed(2);
              el.title = '';
            } else {
              el.textContent = '—';
              el.title = '';
            }
          } catch (e) {
            el.textContent = '—';
            el.title = '';
          }
        }

        menuButton.addEventListener('click', async () => {
          try {
            const resp = await fetch('/chats');
            if (resp.ok) {
              const data = await resp.json();
              chatsCache = data.chats || [];
              renderChats();
            }
            loadUsage();
          } catch (e) {}
          sidebar.classList.add('open');
          sidebarBackdrop.classList.add('open');
        });

        sidebarBackdrop.addEventListener('click', () => {
          sidebar.classList.remove('open');
          sidebarBackdrop.classList.remove('open');
        });

        newChatButton.addEventListener('click', async () => {
          try {
            const resp = await fetch('/chats', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ title: 'New chat' }),
            });
            if (!resp.ok) return;
            const created = await resp.json();
            currentChatId = created.id;
            sendTypingViewing();
            chatsCache.unshift({
              id: created.id,
              owner: created.owner,
              title: created.title,
              created_at: new Date().toISOString(),
            });
            renderChats();
            chat.innerHTML = '';
            sidebar.classList.remove('open');
            sidebarBackdrop.classList.remove('open');
          } catch (e) {
            // ignore
          }
        });

        loginButton.addEventListener('click', async () => {
          const name = loginNameSelect.value;
          const password = loginPasswordInput.value;

          if (!password) {
            loginStatus.textContent = 'Password is required.';
            return;
          }

          loginStatus.textContent = 'Logging in...';

          try {
            const response = await fetch('/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name, password })
            });

            if (!response.ok) {
              loginStatus.textContent = 'Invalid name or password.';
              return;
            }

            loginPasswordInput.value = '';
            loginStatus.textContent = '';
            currentUserName = name;
            showApp(name);
            await loadChatsAndEnsureOne();
            await loadHistory();
            connectTypingWs();
            loadUsage();
          } catch (error) {
            loginStatus.textContent = 'Login failed.';
          }
        });

        loginPasswordInput.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            loginButton.click();
          }
        });

        sendButton.addEventListener('click', async () => {
          const prompt = promptInput.value.trim();

          if (!prompt) return;

          sendTyping(false);
          if (typingStopTimeout) {
            clearTimeout(typingStopTimeout);
            typingStopTimeout = null;
          }

          const speaker = speakerName.textContent || 'Rob';
          addMessage('user', speaker, prompt);
          promptInput.value = '';
          weAreStreamingThisChat = true;

          const thinkingDiv = document.createElement('div');
          thinkingDiv.className = 'message assistant';
          const thinkingAuthor = document.createElement('span');
          thinkingAuthor.className = 'message-author';
          thinkingAuthor.textContent = 'KitchenBot';
          thinkingDiv.appendChild(thinkingAuthor);
          const thinkingBody = document.createElement('div');
          thinkingBody.className = 'message-body';
          thinkingBody.textContent = 'Thinking...';
          thinkingDiv.appendChild(thinkingBody);
          chat.appendChild(thinkingDiv);
          chat.scrollTop = chat.scrollHeight;

          try {
            const response = await fetch('/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ prompt, name: speaker, chatId: currentChatId })
            });

            if (!response.ok) {
              weAreStreamingThisChat = false;
              if (response.status === 401) {
                thinkingBody.textContent = 'Please log in.';
                showLogin();
                return;
              }
              if (response.status === 429) {
                const data = await response.json().catch(() => ({}));
                thinkingBody.textContent = data.reply || 'Too many requests. Please slow down.';
                return;
              }
              thinkingBody.textContent = 'Something went wrong.';
              return;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            thinkingBody.textContent = '';

            let fullReply = '';

            while (true) {
              const { value, done } = await reader.read();
              if (done) break;

              const chunk = decoder.decode(value, { stream: true });
              fullReply += chunk;
              thinkingBody.textContent = fullReply;
              chat.scrollTop = chat.scrollHeight;
            }

            thinkingBody.textContent = '';
            thinkingBody.appendChild(renderMarkdown(fullReply));
            chat.scrollTop = chat.scrollHeight;
            weAreStreamingThisChat = false;

            try {
              const r = await fetch('/chats');
              if (r.ok) {
                const data = await r.json();
                chatsCache = data.chats || [];
                renderChats();
              }
            } catch (e) {}
          }
          
          catch (error) {
            thinkingBody.textContent = 'Something went wrong.';
            weAreStreamingThisChat = false;
          }
        });

        logoutButton.addEventListener('click', async () => {
          try {
            await fetch('/logout', { method: 'POST' });
          } catch (e) {
            // ignore errors, just force login state
          }
          if (typingWs) {
            typingWs.close();
            typingWs = null;
          }
          typingUsers.clear();
          typingIndicator.textContent = '';
          if (typingStopTimeout) clearTimeout(typingStopTimeout);
          typingStopTimeout = null;
          speakerName.textContent = '';
          currentUserName = null;
          showLogin();
          chat.innerHTML = '';
        });

        groceryRefreshButton.addEventListener('click', async () => {
          await loadGroceries();
        });

        groceryClearButton.addEventListener('click', async () => {
          if (!confirm('Clear entire grocery list?')) return;
          try {
            await fetch('/groceries/clear', { method: 'POST' });
            Object.values(groceryLists).forEach(list => {
              list.innerHTML = '';
            });
          } catch (e) {}
        });
      </script>
    </body>
  </html>
`);
});

app.post('/login', async (req, res) => {
  try {
    const name = req.body.name?.trim();
    const password = req.body.password?.trim();

    if (!name || !password) {
      return res.status(400).json({ error: 'Name and password are required.' });
    }

    if (name === 'Guest') {
      const state = await getGuestState();
      const guestPassword = state.password ?? process.env.GUEST_PASSWORD;
      if (!guestPassword || password !== guestPassword) {
        return res.status(401).json({ error: 'Invalid credentials.' });
      }
      await setGuestMustRelogin(false);
    } else if (!USERS[name] || USERS[name] !== password) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const token = signToken(name);

    const cookieParts = [`${COOKIE_NAME}=${encodeURIComponent(token)}`, 'HttpOnly', 'Path=/', 'SameSite=Lax'];
    if (process.env.NODE_ENV === 'production') {
      cookieParts.push('Secure');
    }

    res.setHeader('Set-Cookie', cookieParts.join('; '));
    return res.json({ name });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.get('/me', (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.json({ name: user });
});

app.get('/usage', requireAuth, async (req, res) => {
  if (req.user !== 'Rob' && req.user !== 'Elle') {
    return res.status(403).json({ error: 'Usage is only available to Rob and Elle.' });
  }
  const adminKey = process.env.ANTHROPIC_ADMIN_API_KEY;
  if (!adminKey || !adminKey.startsWith('sk-ant-admin')) {
    return res.json({
      error: 'Usage requires an Anthropic organization and Admin API key. Add ANTHROPIC_ADMIN_API_KEY (sk-ant-admin...) to .env to enable.',
    });
  }
  try {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 30);
    const starting_at = start.toISOString().slice(0, 19) + 'Z';
    const ending_at = end.toISOString().slice(0, 19) + 'Z';
    let totalCents = 0;
    let page = null;
    do {
      const url = new URL('https://api.anthropic.com/v1/organizations/cost_report');
      url.searchParams.set('starting_at', starting_at);
      url.searchParams.set('ending_at', ending_at);
      url.searchParams.set('bucket_width', '1d');
      if (page) url.searchParams.set('page', page);
      const r = await fetch(url.toString(), {
        headers: {
          'anthropic-version': '2023-06-01',
          'x-api-key': adminKey,
        },
      });
      if (!r.ok) {
        const err = await r.text();
        return res.json({ error: `Anthropic API: ${r.status} ${err}` });
      }
      const report = await r.json();
      for (const bucket of report.data || []) {
        for (const item of bucket.results || []) {
          if (item.amount != null) totalCents += Number(item.amount);
        }
      }
      page = report.has_more ? report.next_page : null;
    } while (page);
    const totalUsd = Math.round(totalCents) / 100;
    return res.json({ totalUsd });
  } catch (e) {
    console.error('Usage fetch error:', e);
    return res.json({ error: e.message || 'Failed to fetch usage' });
  }
});

app.get('/chats', requireAuth, async (req, res) => {
  try {
    const chats = await listAllChats();
    res.json({ chats });
  } catch (error) {
    console.error(error);
    res.status(500).json({ chats: [] });
  }
});

app.post('/chats', requireAuth, async (req, res) => {
  try {
    const owner = req.user;
    const title = req.body.title?.trim() || 'New chat';
    const id = await createChat(owner, title);
    res.json({ id, owner, title });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create chat' });
  }
});

app.delete('/chats/:id', requireAuth, async (req, res) => {
  try {
    if (req.user !== 'Rob') {
      return res.status(403).json({ error: 'Only Rob can delete chats.' });
    }
    const chatId = Number(req.params.id);
    if (!Number.isFinite(chatId)) {
      return res.status(400).json({ error: 'Invalid chat id.' });
    }
    await deleteChatById(chatId);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete chat' });
  }
});

app.post('/logout', (req, res) => {
  const cookieParts = [`${COOKIE_NAME}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (process.env.NODE_ENV === 'production') {
    cookieParts.push('Secure');
  }
  res.setHeader('Set-Cookie', cookieParts.join('; '));
  return res.json({ ok: true });
});

app.get('/history', requireAuth, async (req, res) => {
  try {
    const chatId = Number(req.query.chatId);
    if (!Number.isFinite(chatId)) {
      return res.status(400).json({ conversation: [] });
    }
    const conversation = await getMessages(chatId);
    res.json({ conversation });
  } catch (error) {
    console.error(error);
    res.status(500).json({ conversation: [] });
  }
});

app.get('/groceries', requireAuth, async (req, res) => {
  try {
    const items = await getGroceryItems();
    res.json({ items });
  } catch (error) {
    console.error(error);
    res.status(500).json({ items: [] });
  }
});

app.post('/groceries', requireAuth, async (req, res) => {
  if (req.user === 'Guest') {
    return res.status(403).json({ error: 'Guests cannot modify the grocery list.' });
  }
  try {
    const items = req.body.items;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Items are required.' });
    }
    await addGroceryItems(items);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false });
  }
});

app.patch('/groceries/:id', requireAuth, async (req, res) => {
  if (req.user === 'Guest') {
    return res.status(403).json({ error: 'Guests cannot modify the grocery list.' });
  }
  try {
    const id = Number(req.params.id);
    const { checked } = req.body;
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid id.' });
    }
    await updateGroceryItem(id, { checked: !!checked });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false });
  }
});

app.delete('/groceries/:id', requireAuth, async (req, res) => {
  if (req.user === 'Guest') {
    return res.status(403).json({ error: 'Guests cannot modify the grocery list.' });
  }
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid id.' });
    }
    await deleteGroceryItem(id);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false });
  }
});

app.post('/groceries/clear', requireAuth, async (req, res) => {
  if (req.user !== 'Rob') {
    return res.status(403).json({ error: 'Only Rob can clear the grocery list.' });
  }
  try {
    await clearGroceryItems();
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false });
  }
});

app.post('/chat', requireAuth, rateLimitChatMiddleware, async (req, res) => {
  try {
    const prompt = req.body.prompt?.trim();
    const name = req.user || req.body.name?.trim() || 'Rob';
    const chatId = Number(req.body.chatId);
    if (!Number.isFinite(chatId)) {
      return res.status(400).json({ reply: 'chatId is required.' });
    }

    if (name === 'Guest') {
      const count = await getGuestMessageCount();
      if (count >= 5) {
        await addMessage(chatId, 'user', name, prompt);
        const reply = 'Guest message limit (5) reached. Ask Rob to reset with !resetguest.';
        await addMessage(chatId, 'assistant', 'KitchenBot', reply);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.end(reply);
      }
    }

    if (prompt === '!help') {
      const reply = '📋 KitchenBot commands\n\n' + getHelpReply(name);
      await addMessage(chatId, 'user', name, prompt);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(reply);
    }

    const renameMatch = prompt?.match(/^!rename\s*(.*)$/);
    if (renameMatch) {
      const arg = typeof renameMatch[1] === 'string' ? renameMatch[1].trim() : '';
      await addMessage(chatId, 'user', name, prompt);
      let title;
      if (arg) {
        title = arg.slice(0, 200);
      } else {
        const conv = await getMessages(chatId);
        const forContext = conv.filter(m => m.role !== 'user' || !String(m.content).trim().startsWith('!'));
        const recent = forContext.length > 20 ? forContext.slice(-20) : forContext;
        const titleMessages = recent.map(m => ({
          role: m.role,
          content: m.role === 'user' ? `${m.name}: ${m.content}` : m.content,
        }));
        try {
          const titleRes = await client.messages.create({
            model: 'claude-sonnet-4-5',
            max_tokens: 30,
            system: 'You generate very short chat titles (3–6 words). Respond with ONLY the title, no quotes or punctuation.',
            messages: [
              ...titleMessages,
              { role: 'user', content: 'Suggest a very short title for this chat (3–6 words only).' },
            ],
          });
          const blocks = titleRes.content.filter(b => b.type === 'text');
          const raw = blocks.map(b => b.text).join(' ').trim().split('\n')[0].trim();
          title = (raw && raw.length > 0) ? raw.slice(0, 80) : 'New chat';
        } catch (e) {
          console.error('Title suggestion failed:', e);
          title = 'New chat';
        }
      }
      await updateChatTitle(chatId, title);
      const reply = `Renamed this chat to "${title}".`;
      await addMessage(chatId, 'assistant', 'KitchenBot', reply);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(reply);
    }

    if (prompt === '!resetguest') {
      if (name !== 'Rob') {
        await addMessage(chatId, 'user', name, prompt);
        const reply = 'The !resetguest command is only available to Rob.';
        await addMessage(chatId, 'assistant', 'KitchenBot', reply);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.end(reply);
      }
      await addMessage(chatId, 'user', name, prompt);
      await resetGuestMessageCount();
      const reply = 'Guest message count has been reset to 0.';
      await addMessage(chatId, 'assistant', 'KitchenBot', reply);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(reply);
    }

    if (prompt === '!bootguest') {
      if (name !== 'Rob') {
        await addMessage(chatId, 'user', name, prompt);
        const reply = 'The !bootguest command is only available to Rob.';
        await addMessage(chatId, 'assistant', 'KitchenBot', reply);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.end(reply);
      }
      await addMessage(chatId, 'user', name, prompt);
      await setGuestMustRelogin(true);
      const reply = 'Guest sessions invalidated. Guest must log in again.';
      await addMessage(chatId, 'assistant', 'KitchenBot', reply);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(reply);
    }

    const guestPasswordMatch = prompt?.match(/^!guestpassword\s*=\s*(.+)$/);
    if (guestPasswordMatch) {
      if (name !== 'Rob') {
        await addMessage(chatId, 'user', name, prompt);
        const reply = 'The !guestpassword command is only available to Rob.';
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.end(reply);
      }
      const newPassword = guestPasswordMatch[1].trim();
      await addMessage(chatId, 'user', name, prompt);
      await setGuestPassword(newPassword);
      const reply = 'Guest password has been updated.';
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(reply);
    }

    const memoriesCommand = isMemoriesCommand(prompt);

    const memoryCommand = parseMemoryCommand(prompt);
    const groceryListCommand = isGroceryListCommand(prompt);

    if (memoriesCommand) {
      if (name !== 'Rob') {
        const reply = 'The !memories command is only available to Rob.';
        await addMessage(chatId, 'user', name, prompt);
        await addMessage(chatId, 'assistant', 'KitchenBot', reply);

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.end(reply);
      }

      await addMessage(chatId, 'user', name, prompt);

      const memories = await getMemories();

      const reply = memories.length
        ? 'Current memories:\n' + memories.map(memory => `- ${memory.key}: ${memory.value}`).join('\n')
        : 'No memories stored.';

      await addMessage(chatId, 'assistant', 'KitchenBot', reply);

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(reply);
    }

    if (memoryCommand) {
      if (name !== 'Rob') {
        const reply = 'The !remember command is only available to Rob.';
        await addMessage(chatId, 'user', name, prompt);
        await addMessage(chatId, 'assistant', 'KitchenBot', reply);

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.end(reply);
      }

      await addMessage(chatId, 'user', name, prompt);
      await upsertMemory(memoryCommand.key, memoryCommand.value);

      const reply = `Got it. I saved memory \`${memoryCommand.key}\` = "${memoryCommand.value}".`;
      await addMessage(chatId, 'assistant', 'KitchenBot', reply);

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(reply);
    }

    if (groceryListCommand) {
      if (name !== 'Rob') {
        const reply = 'The !grocerylist command is only available to Rob.';
        await addMessage(chatId, 'user', name, prompt);
        await addMessage(chatId, 'assistant', 'KitchenBot', reply);

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.end(reply);
      }

      await addMessage(chatId, 'user', name, prompt);

      const conversation = await getMessages(chatId);
      const conversationForContext = conversation.filter(
        m => m.role !== 'user' || !String(m.content || '').trim().startsWith('!')
      );
      const recentConversation =
        conversationForContext.length > 40 ? conversationForContext.slice(-40) : conversationForContext;

      const memories = await getMemories();

      const memoryText = memories
        .map(memory => `${memory.key}: ${memory.value}`)
        .join('\n');

      const claudeMessages = recentConversation.map(message => ({
        role: message.role,
        content:
          message.role === 'user'
            ? `${message.name}: ${message.content}`
            : message.content
      }));

      const groceryResponse = await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 400,
        system: `You are a household assistant that generates grocery lists.

Household memory:
${memoryText}

When the user asks for a grocery list, respond ONLY with plain text lines in the format:
section | product | amount

Where:
- section is one of: produce, meat, dairy, frozen, dry, other
- product is a short item name
- amount is a human-readable quantity (like "2 lbs", "3", "1 carton")`,
        messages: [
          ...claudeMessages,
          {
            role: 'user',
            content:
              'Based on the meal planning we have discussed, build a complete grocery list using the format "section | product | amount", one item per line. Do not include any commentary, headers, or bullet points—only raw lines in that format.'
          }
        ],
      });

      const textBlocks = groceryResponse.content.filter(
        block => block.type === 'text'
      );
      const fullText = textBlocks.map(b => b.text).join('\n');

      const lines = fullText
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);

      const items = [];

      for (const line of lines) {
        const parts = line.split('|').map(p => p.trim());
        if (parts.length < 2) continue;
        const [sectionRaw, nameRaw, amountRaw] = parts;
        if (!sectionRaw || !nameRaw) continue;

        const section = sectionRaw.toLowerCase();
        const normalizedSection = ['produce', 'meat', 'dairy', 'frozen', 'dry', 'other'].includes(section)
          ? section
          : 'other';

        items.push({
          section: normalizedSection,
          name: nameRaw,
          amount: amountRaw || '',
        });
      }

      if (items.length > 0) {
        await clearGroceryItems();
        await addGroceryItems(items);
      }

      const reply =
        items.length > 0
          ? 'I built the grocery list. Head over to the Grocery List tab to check it.'
          : 'I was not able to build a grocery list from our conversation.';

      await addMessage(chatId, 'assistant', 'KitchenBot', reply);

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(reply);
    }

    if (prompt.trim().startsWith('!')) {
      const reply = 'Unknown command.\n\n' + getHelpReply(name);
      await addMessage(chatId, 'user', name, prompt);
      await addMessage(chatId, 'assistant', 'KitchenBot', reply);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(reply);
    }

    if (!prompt) {
      return res.status(400).json({ reply: 'Prompt is required.' });
    }

    await addMessage(chatId, 'user', name, prompt);
    if (typeof broadcastToChat === 'function') broadcastToChat(chatId, { type: 'chat_updated', chatId });

    const conversation = await getMessages(chatId);
    const conversationForContext = conversation.filter(
      m => m.role !== 'user' || !String(m.content || '').trim().startsWith('!')
    );
    const recentConversation =
      conversationForContext.length > 40 ? conversationForContext.slice(-40) : conversationForContext;

    let elleMessageCount = conversation.filter(
      m => m.role === 'user' && m.name === 'Elle'
    ).length;

    const memories = await getMemories();

    const memoryText = memories
      .map(memory => `${memory.key}: ${memory.value}`)
      .join('\n');

    const claudeMessages = recentConversation.map(message => ({
      role: message.role,
      content:
        message.role === 'user'
          ? `${message.name}: ${message.content}`
          : message.content
    }));

    const userMessagesForTitle = conversation.filter(
      m => m.role === 'user'
    );

    const shouldNameChat =
      userMessagesForTitle.length === 1 || userMessagesForTitle.length === 3;

    if (shouldNameChat) {
      try {
        const titleResponse = await client.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 30,
          system:
            'You generate very short chat titles (3-6 words) based on the conversation. Respond with ONLY the title text, no quotes or punctuation.',
          messages: [
            ...claudeMessages.slice(-10),
            {
              role: 'user',
              content:
                'Based on this conversation, generate a very short, descriptive title for this chat (3-6 words only, no quotes).',
            },
          ],
        });

        const titleBlocks = titleResponse.content.filter(
          b => b.type === 'text'
        );
        const rawTitle = titleBlocks.map(b => b.text).join(' ').trim().split('\n')[0].trim();
        const safeTitle = (rawTitle && rawTitle.length > 0) ? rawTitle.slice(0, 80) : 'New chat';
        await updateChatTitle(chatId, safeTitle);
      } catch (e) {
        console.error('Title generation failed:', e);
      }
    }

    const stream = await client.messages.stream({
      model: 'claude-sonnet-4-5',
      max_tokens: 800,
      system: `You are a concise household assistant. Respond in plain text by default. Only use code blocks when the user explicitly asks for code.

    Household memory:
    ${memoryText}`,
      messages: claudeMessages,
    });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    let finalReply = '';

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const delta = event.delta.text;
        finalReply += delta;
        res.write(delta);
        if (typeof broadcastToChat === 'function') broadcastToChat(chatId, { type: 'stream_delta', chatId, delta });
      }
    }

    /* ---- COMPLIMENT LOGIC ---- */

    if (name === 'Elle') {
      const trigger = Math.floor(Math.random() * 11) + 10;

      if (elleMessageCount % trigger === 0) {
        const compliment =
          compliments[Math.floor(Math.random() * compliments.length)];

        const template =
          complimentTemplates[Math.floor(Math.random() * complimentTemplates.length)];

        const complimentLine = template.replace("%s", compliment);

        finalReply += "\n\n" + complimentLine;
      }
    }

    /* ---- END OF COMPLIMENT LOGIC ---- */

    await addMessage(chatId, 'assistant', 'KitchenBot', finalReply);
    if (typeof broadcastToChat === 'function') broadcastToChat(chatId, { type: 'chat_updated', chatId });

    if (name === 'Guest') {
      await incrementGuestMessageCount();
    }

    return res.end();

  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      return res.status(500).json({ reply: 'Something went wrong.' });
    }
    res.end();
  }
});

const wss = new WebSocketServer({ server });

const wsConnections = new Map();

function broadcastToChat(chatId, payload, excludeWs = null) {
  const msg = JSON.stringify(payload);
  for (const [ws, data] of wsConnections) {
    if (ws === excludeWs || ws.readyState !== 1) continue;
    if (data.chatId !== chatId) continue;
    try {
      ws.send(msg);
    } catch (e) {
      // ignore
    }
  }
}

wss.on('connection', (ws) => {
  const data = { user: null, chatId: null };
  wsConnections.set(ws, data);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'identify' && msg.user) {
        data.user = msg.user;
        return;
      }
      if (msg.type === 'viewing') {
        data.chatId = msg.chatId != null ? Number(msg.chatId) : null;
        return;
      }
      if (msg.type === 'typing' && data.user && msg.chatId != null) {
        broadcastToChat(Number(msg.chatId), { type: 'user_typing', chatId: Number(msg.chatId), user: data.user }, ws);
        return;
      }
      if (msg.type === 'stopped_typing' && data.user && msg.chatId != null) {
        broadcastToChat(Number(msg.chatId), { type: 'user_stopped_typing', chatId: Number(msg.chatId), user: data.user }, ws);
        return;
      }
    } catch (e) {
      // ignore malformed
    }
  });

  ws.on('close', () => {
    if (data.user != null && data.chatId != null) {
      broadcastToChat(data.chatId, { type: 'user_stopped_typing', chatId: data.chatId, user: data.user }, ws);
    }
    wsConnections.delete(ws);
  });
});

server.listen(port, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  let lanIp = '';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        lanIp = net.address;
        break;
      }
    }
    if (lanIp) break;
  }
  console.log(`Server running at http://localhost:${port}`);
  if (lanIp) console.log(`Local network:  http://${lanIp}:${port}`);
});
