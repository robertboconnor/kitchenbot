import {
  createChat,
  listChats,
  listAllChats,
  touchChat,
  updateChatTitle,
  deleteChatById,
  addMessage,
  getMessages,
  getMemories,
  clearMessages,
  upsertMemory,
  deleteMemory,
  deleteLegacySeedMemories,
  addGroceryItems,
  getGroceryItems,
  updateGroceryItemAmount,
  updateGroceryItem,
  deleteGroceryItem,
  clearGroceryItems,
  listAllHouseholdsSummary,
  getUserComplimentState,
  incrementUserMessageCount,
  shouldTriggerCompliment,
  recordCompliment,
  selectComplimentAvoidingRecent,
  setUserLoveBoost,
  ensureUserComplimentStateRow,
  updateHouseholdUserComplimentsEnabled,
  updateHouseholdUserChatColor,
  runMigrations,
  normalizeChatColor,
  needsBootstrap,
  bootstrapFirstHousehold,
  createHouseholdWithInitialOwner,
  isGlobalAdminUser,
  getFirstHouseholdId,
  getHouseholdById,
  getHouseholdByKey,
  setHouseholdWebSearchEnabled,
  listHouseholdUsers,
  getUserByHouseholdAndDisplayName,
  getHouseholdUserById,
  createHouseholdUser,
  updateHouseholdUserPin,
  updateHouseholdUserRole,
  updateHouseholdAnthropicSettings,
  setHouseholdAnthropicMode,
  setHouseholdAnthropicApiKey,
  verifyPin,
  getHouseholdMessageStats,
  getUserMessageCountsInHousehold,
  getChatThreadContext,
  upsertChatThreadContext,
} from './db.mjs';
import 'dotenv/config';
import os from 'os';
import http from 'http';
import express from 'express';
import { createClient } from 'redis';
import { WebSocketServer } from 'ws';
import Anthropic from '@anthropic-ai/sdk';
import crypto from 'crypto';

async function incrementUserMessageCountForSender(req) {
  const uid = req.userId;
  if (!Number.isFinite(uid)) return;
  try {
    await ensureUserComplimentStateRow(uid);
    await incrementUserMessageCount(uid);
  } catch (e) {
    // ignore
  }
}

const app = express();
const port = process.env.PORT || 3000;
const server = http.createServer(app);

async function resolveDefaultHouseholdId() {
  const envId = process.env.HOUSEHOLD_ID;
  if (envId != null && envId !== '') {
    const n = Number(envId);
    if (Number.isFinite(n)) return n;
  }
  return getFirstHouseholdId();
}

function hasInitialSeedEnv() {
  const n = process.env.INITIAL_HOUSEHOLD_NAME;
  const k = process.env.INITIAL_HOUSEHOLD_KEY;
  const o = process.env.INITIAL_OWNER_NAME;
  const p = process.env.INITIAL_OWNER_PIN;
  return !!(
    n &&
    String(n).trim() &&
    k &&
    String(k).trim() &&
    o &&
    String(o).trim() &&
    p &&
    String(p).trim()
  );
}

async function seedInitialHouseholdFromEnvIfNeeded() {
  if (!(await needsBootstrap())) return;
  if (!hasInitialSeedEnv()) return;
  const householdName = process.env.INITIAL_HOUSEHOLD_NAME.trim();
  const householdKey = process.env.INITIAL_HOUSEHOLD_KEY.trim();
  const ownerDisplayName = process.env.INITIAL_OWNER_NAME.trim();
  const pin = process.env.INITIAL_OWNER_PIN.trim();
  try {
    await createHouseholdWithInitialOwner({ householdName, householdKey, ownerDisplayName, pin });
    console.log('Seeded initial household from INITIAL_* environment variables.');
  } catch (e) {
    console.error('Initial household seeding failed:', e.message || e);
  }
}

async function getAnthropicClient(householdId) {
  const h = await getHouseholdById(householdId);
  if (!h) {
    throw new Error('Household not found.');
  }
  const webSearchEnabled = Number(h.web_search_enabled) === 1;
  const mode = h.anthropic_key_mode || 'shared';
  if (mode === 'household') {
    const k = h.anthropic_api_key && String(h.anthropic_api_key).trim();
    if (!k) {
      throw new Error('This household does not have an Anthropic API key configured.');
    }
    return { client: new Anthropic({ apiKey: k }), webSearchEnabled };
  }
  const shared = process.env.ANTHROPIC_API_KEY && String(process.env.ANTHROPIC_API_KEY).trim();
  if (!shared) {
    throw new Error('Shared Anthropic API key is not configured on this server.');
  }
  return { client: new Anthropic({ apiKey: shared }), webSearchEnabled };
}

/** Heuristic: attach Anthropic web search only when the user message likely needs live web context. */
function shouldEnableWebSearchForPrompt(prompt) {
  const s = String(prompt ?? '').trim();
  if (!s) return false;

  if (/https?:\/\/\S|www\.\S/i.test(s)) return true;

  if (
    /\b(?:current|latest|today|tonight|right now|this week|this year|live|breaking|as of|updated|recently|up to date|up-to-date|news|headlines)\b/i.test(
      s
    )
  ) {
    return true;
  }

  if (/\b(?:according to|per the|via)\s+[A-Z]/.test(s)) return true;

  if (/\b(?:from|on|at)\s+(?:the\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/.test(s)) return true;

  if (/\b(?:from|on)\s+(?:the\s+)?[A-Z][a-zA-Z]+(?:'s)?\s+(?:recipe|recipes|article|articles|guide|page|post)\b/.test(s)) {
    return true;
  }

  if (
    /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b[\s\S]{0,240}\b(?:recipe|recipes|article|articles)\b/i.test(s)
  ) {
    return true;
  }

  return false;
}

async function requireHousehold(req, res, next) {
  try {
    if (await needsBootstrap()) {
      return res.status(503).json({ error: 'bootstrap_required' });
    }
    const id = await resolveDefaultHouseholdId();
    if (id == null) {
      return res.status(500).json({ error: 'No household configured. Run bootstrap or set HOUSEHOLD_ID.' });
    }
    req.householdId = id;
    next();
  } catch (e) {
    next(e);
  }
}

const COOKIE_NAME = 'kitchenbot_auth';
const COOKIE_SECRET = process.env.KITCHENBOT_SECRET;
if (!COOKIE_SECRET) {
  throw new Error('Missing KITCHENBOT_SECRET');
}

/**
 * @param {{
 *   householdId: number,
 *   userId: number,
 *   displayName: string,
 *   sessionVersion: number,
 *   isImpersonating?: boolean,
 *   impersonationReadOnly?: boolean,
 *   adminUserId?: number,
 *   adminHouseholdId?: number,
 *   adminDisplayName?: string,
 * }} payload
 */
function signToken(payload) {
  const householdId = Number(payload.householdId);
  const userId = Number(payload.userId);
  const displayName = String(payload.displayName ?? '');
  const sessionVersion = Math.trunc(Number(payload.sessionVersion ?? 0));
  const o = { householdId, userId, displayName, sessionVersion };
  if (payload.isImpersonating) {
    const adminUserId = Number(payload.adminUserId);
    const adminHouseholdId = Number(payload.adminHouseholdId);
    if (!Number.isFinite(adminUserId) || !Number.isFinite(adminHouseholdId)) {
      throw new Error('Invalid impersonation admin ids');
    }
    o.isImpersonating = true;
    o.impersonationReadOnly = payload.impersonationReadOnly !== false;
    o.adminUserId = adminUserId;
    o.adminHouseholdId = adminHouseholdId;
    o.adminDisplayName = String(payload.adminDisplayName ?? '');
  }
  const json = JSON.stringify(o);
  const hmac = crypto.createHmac('sha256', COOKIE_SECRET);
  hmac.update(json);
  const sig = hmac.digest('hex');
  const b64 = Buffer.from(json, 'utf8').toString('base64url');
  return `v2.${b64}.${sig}`;
}

function setAuthCookie(res, token) {
  const cookieParts = [`${COOKIE_NAME}=${encodeURIComponent(token)}`, 'HttpOnly', 'Path=/', 'SameSite=Lax'];
  if (process.env.NODE_ENV === 'production') {
    cookieParts.push('Secure');
  }
  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function verifyToken(token) {
  if (!token || !token.startsWith('v2.')) return null;
  const without = token.slice(3);
  const lastDot = without.lastIndexOf('.');
  if (lastDot === -1) return null;
  const b64 = without.slice(0, lastDot);
  const sig = without.slice(lastDot + 1);
  if (!/^[0-9a-f]+$/i.test(sig)) return null;
  let json;
  try {
    json = Buffer.from(b64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const hmac = crypto.createHmac('sha256', COOKIE_SECRET);
  hmac.update(json);
  const expected = hmac.digest('hex');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) {
    return null;
  }
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (
    data == null ||
    typeof data !== 'object' ||
    data.householdId == null ||
    data.userId == null ||
    typeof data.displayName !== 'string'
  ) {
    return null;
  }
  const householdId = Number(data.householdId);
  const userId = Number(data.userId);
  if (!Number.isFinite(householdId) || !Number.isFinite(userId)) {
    return null;
  }
  let sessionVersion = 0;
  if (Object.prototype.hasOwnProperty.call(data, 'sessionVersion') && data.sessionVersion != null) {
    const sv = Number(data.sessionVersion);
    if (!Number.isFinite(sv)) return null;
    sessionVersion = Math.trunc(sv);
  }
  const out = { householdId, userId, displayName: data.displayName, sessionVersion };
  if (data.isImpersonating === true) {
    const adminUserId = Number(data.adminUserId);
    const adminHouseholdId = Number(data.adminHouseholdId);
    if (!Number.isFinite(adminUserId) || !Number.isFinite(adminHouseholdId)) return null;
    if (typeof data.adminDisplayName !== 'string') return null;
    out.isImpersonating = true;
    out.impersonationReadOnly = data.impersonationReadOnly !== false;
    out.adminUserId = adminUserId;
    out.adminHouseholdId = adminHouseholdId;
    out.adminDisplayName = data.adminDisplayName;
  }
  return out;
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
  const auth = getUserFromRequest(req);
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const u = await getHouseholdUserById(auth.householdId, auth.userId);
    if (!u) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const tokenSv = Math.trunc(Number(auth.sessionVersion ?? 0));
    const dbSv = Math.trunc(Number(u.session_version != null ? u.session_version : 0));
    if (tokenSv !== dbSv) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  } catch (e) {
    return next(e);
  }

  req.user = auth.displayName;
  req.userId = auth.userId;
  req.householdId = auth.householdId;
  req.isImpersonating = !!auth.isImpersonating;
  req.impersonationReadOnly = !!(auth.isImpersonating && auth.impersonationReadOnly);
  req.adminUserId = auth.adminUserId;
  req.adminHouseholdId = auth.adminHouseholdId;
  req.adminDisplayName = auth.adminDisplayName;

  next();
}

function requireNotImpersonatingReadOnly(req, res, next) {
  if (req.impersonationReadOnly) {
    return res.status(403).json({ error: 'God Mode is read-only. Exit God Mode to make changes.' });
  }
  next();
}

function requireNotAlreadyImpersonating(req, res, next) {
  if (req.isImpersonating) {
    return res.status(400).json({ error: 'Exit God Mode before starting a new impersonation.' });
  }
  next();
}

async function isRequestGlobalAdmin(req) {
  const uid =
    req.isImpersonating && req.adminUserId != null && Number.isFinite(Number(req.adminUserId))
      ? Number(req.adminUserId)
      : req.userId;
  return isGlobalAdminUser(uid);
}

async function requireOwner(req, res, next) {
  try {
    const u = await getHouseholdUserById(req.householdId, req.userId);
    if (!u || u.role !== 'owner') {
      return res.status(403).json({ error: 'Owner only' });
    }
    next();
  } catch (e) {
    next(e);
  }
}

async function requireGlobalAdmin(req, res, next) {
  try {
    const ok = await isGlobalAdminUser(req.userId);
    if (!ok) {
      return res.status(403).json({ error: 'Global admin only' });
    }
    next();
  } catch (e) {
    next(e);
  }
}

/** Global admin or read-only God Mode with a global admin in the cookie (admin reads while impersonating). */
async function requireGlobalAdminRead(req, res, next) {
  try {
    const ok = await isRequestGlobalAdmin(req);
    if (!ok) {
      return res.status(403).json({ error: 'Global admin only' });
    }
    next();
  } catch (e) {
    next(e);
  }
}

const ANTHROPIC_KEY_USER_MESSAGE = 'Invalid or missing Anthropic key.';

function isAnthropicSdkAuthOrKeyError(err) {
  if (!err || typeof err !== 'object') return false;
  const status = err.status ?? err.statusCode;
  if (status === 401 || status === 403) return true;
  const t = err.error?.type;
  if (t === 'authentication_error' || t === 'permission_error') return true;
  const msg = String(err.message ?? '');
  if (/401|403|invalid[_\s]*(api[_\s]*)?key|authentication|incorrect api key/i.test(msg)) return true;
  return false;
}

async function resolveAnthropicTargetHouseholdId(req, res, rawHouseholdId) {
  if (rawHouseholdId != null && rawHouseholdId !== '') {
    const n = Number(rawHouseholdId);
    if (!Number.isFinite(n)) {
      res.status(400).json({ error: 'Invalid householdId' });
      return null;
    }
    const admin = await isRequestGlobalAdmin(req);
    if (!admin) {
      res.status(403).json({ error: 'Forbidden' });
      return null;
    }
    const h = await getHouseholdById(n);
    if (!h) {
      res.status(404).json({ error: 'Household not found' });
      return null;
    }
    return n;
  }
  return req.householdId;
}

function normalizeRememberKey(raw) {
  let s = String(raw ?? '').trim().toLowerCase();
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/ /g, '_');
  return s;
}

/** @returns {null | { key: string, value: string } | { error: string }} */
function parseMemoryCommand(prompt) {
  const trimmed = String(prompt ?? '').trim();
  if (!/^!remember(\s|$)/i.test(trimmed)) return null;
  const rest = trimmed.replace(/^!remember\s*/i, '').trim();
  const eq = rest.indexOf('=');
  if (eq === -1) {
    return { error: 'Usage: !remember <key> = <value>' };
  }
  const rawKey = rest.slice(0, eq);
  const rawVal = rest.slice(eq + 1);
  const key = normalizeRememberKey(rawKey);
  const value = String(rawVal).trim();
  if (!key) {
    return { error: 'Memory key cannot be empty.' };
  }
  if (!value) {
    return { error: 'Memory value cannot be empty.' };
  }
  return { key, value };
}

function isMemoriesCommand(prompt) {
  return prompt === '!memories';
}

/**
 * Private chat commands: reply goes only to the HTTP client (sender). No server-side
 * persistence for these exchanges and no broadcastToChat — other household members see no trace.
 * Shared commands use isSharedChatCommand (see below).
 */
function isPrivateChatCommand(prompt) {
  const p = String(prompt ?? '').trim();
  if (p === '!help') return true;
  if (isMemoriesCommand(p)) return true;
  if (/^!love(?:\s|$)/.test(p)) return true;
  return false;
}

function isGroceryListCommand(prompt) {
  return String(prompt ?? '').trim() === '!grocerylist';
}

/** Shared chat commands: !remember (non-null memoryParsed) and !grocerylist — addMessage + broadcastToChat. */
function isSharedChatCommand(prompt, memoryParsed) {
  if (memoryParsed != null) return true;
  if (isGroceryListCommand(prompt)) return true;
  return false;
}

function getHelpReply() {
  return [
    'Memories & grocery',
    '• !remember `<key>` = `<value>` — Save a memory',
    '• !memories — List all memories',
    '• !grocerylist — Build grocery list from this chat',
    '',
    '• !rename — Have KitchenBot choose a new name for this chat based on the chat context',
    '• !rename `<string>` — Rename this chat manually',
    '',
    'Love & compliments',
    '• !love `<display name>` — Temporarily boost that person\'s compliment chances',
    '',
    '• !help — Show this message',
  ].join('\n');
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

app.get('/bootstrap/status', async (req, res) => {
  try {
    const needs = await needsBootstrap();
    const seedEnvConfigured = hasInitialSeedEnv();
    res.json({
      needsBootstrap: needs,
      allowPublicBootstrap: needs && !seedEnvConfigured,
    });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/bootstrap', async (req, res) => {
  try {
    if (!(await needsBootstrap())) {
      return res.status(403).json({ error: 'Bootstrap already completed' });
    }
    if (hasInitialSeedEnv()) {
      return res.status(403).json({
        error:
          'Public bootstrap is disabled when INITIAL_* seed environment variables are set. Use env-based seeding or remove those variables.',
      });
    }
    const householdName = req.body.householdName?.trim();
    const householdKey = req.body.householdKey?.trim();
    const ownerDisplayName = req.body.ownerDisplayName?.trim();
    const pin = req.body.pin?.trim();
    if (!householdName || !householdKey || !ownerDisplayName || !pin) {
      return res.status(400).json({ error: 'householdName, householdKey, ownerDisplayName, and pin are required' });
    }
    const result = await bootstrapFirstHousehold({
      householdName,
      householdKey,
      ownerDisplayName,
      pin,
    });
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Bootstrap failed' });
  }
});

app.get('/admin/households', requireHousehold, requireAuth, requireGlobalAdminRead, async (req, res) => {
  try {
    const households = await listAllHouseholdsSummary();
    return res.json({ households });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.get('/admin/households/:id', requireHousehold, requireAuth, requireGlobalAdminRead, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid household id' });
    }
    const households = await listAllHouseholdsSummary();
    const hh = households.find((h) => h.id === id);
    if (!hh) {
      return res.status(404).json({ error: 'Household not found' });
    }
    const [stats, messagesByUser] = await Promise.all([
      getHouseholdMessageStats(id),
      getUserMessageCountsInHousehold(id),
    ]);
    return res.json({
      household: hh,
      usage: {
        totalMessages: stats.totalMessages,
        latestMessageAt: stats.latestMessageAt,
        messagesByUser,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post(
  '/admin/households/:householdId/users/:userId/pin',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
  requireGlobalAdmin,
  async (req, res) => {
    try {
      const householdId = Number(req.params.householdId);
      const userId = Number(req.params.userId);
      if (!Number.isFinite(householdId) || !Number.isFinite(userId)) {
        return res.status(400).json({ error: 'Invalid household or user id' });
      }
      const pin = req.body.pin?.trim();
      if (!pin) {
        return res.status(400).json({ error: 'pin is required' });
      }
      const u = await getHouseholdUserById(householdId, userId);
      if (!u) {
        return res.status(404).json({ error: 'User not found in this household' });
      }
      await updateHouseholdUserPin(householdId, userId, pin);
      return res.json({
        ok: true,
        householdId,
        userId,
        displayName: u.display_name,
      });
    } catch (e) {
      if (e && e.message === 'User not found') {
        return res.status(404).json({ error: 'User not found' });
      }
      console.error(e);
      return res.status(500).json({ error: e.message || 'Failed to update PIN' });
    }
  }
);

app.post(
  '/admin/households',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
  requireGlobalAdmin,
  async (req, res) => {
  try {
    const householdName = req.body.householdName?.trim();
    const householdKey = req.body.householdKey?.trim();
    const ownerDisplayName = req.body.ownerDisplayName?.trim();
    const ownerPin = req.body.ownerPin?.trim();
    if (!householdName || !householdKey || !ownerDisplayName || !ownerPin) {
      return res.status(400).json({ error: 'householdName, householdKey, ownerDisplayName, and ownerPin are required' });
    }
    const result = await createHouseholdWithInitialOwner({
      householdName,
      householdKey,
      ownerDisplayName,
      pin: ownerPin,
    });
    const h = await getHouseholdById(result.householdId);
    return res.json({
      household: {
        id: h.id,
        name: h.name,
        householdKey: h.household_key,
      },
      owner: {
        id: result.ownerUserId,
        displayName: ownerDisplayName,
        role: 'owner',
      },
    });
  } catch (e) {
    if (e && e.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ error: 'A household with this key already exists' });
    }
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed to create household' });
  }
});

app.post(
  '/admin/impersonate',
  requireHousehold,
  requireAuth,
  requireNotAlreadyImpersonating,
  requireGlobalAdmin,
  async (req, res) => {
    try {
      const targetHid = Number(req.body.householdId);
      const targetUid = Number(req.body.userId);
      if (!Number.isFinite(targetHid) || !Number.isFinite(targetUid)) {
        return res.status(400).json({ error: 'householdId and userId are required' });
      }
      const target = await getHouseholdUserById(targetHid, targetUid);
      if (!target) {
        return res.status(404).json({ error: 'User not found in this household' });
      }
      const adminRow = await getHouseholdUserById(req.householdId, req.userId);
      if (!adminRow) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const token = signToken({
        householdId: targetHid,
        userId: targetUid,
        displayName: target.display_name,
        sessionVersion: target.session_version != null ? Math.trunc(Number(target.session_version)) : 0,
        isImpersonating: true,
        impersonationReadOnly: true,
        adminUserId: req.userId,
        adminHouseholdId: req.householdId,
        adminDisplayName: adminRow.display_name,
      });
      setAuthCookie(res, token);
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Impersonation failed' });
    }
  }
);

const DEMO_VIEW_HOUSEHOLD_KEY = 'demo-env';
const DEMO_VIEW_USER_DISPLAY_NAME = 'Rob';

app.post(
  '/demo/view',
  requireHousehold,
  requireAuth,
  requireNotAlreadyImpersonating,
  async (req, res) => {
    try {
      const demoHousehold = await getHouseholdByKey(DEMO_VIEW_HOUSEHOLD_KEY);
      if (!demoHousehold) {
        return res.status(404).json({ error: 'Demo household is not configured (expected key demo-env).' });
      }
      const demoUser = await getUserByHouseholdAndDisplayName(
        demoHousehold.id,
        DEMO_VIEW_USER_DISPLAY_NAME
      );
      if (!demoUser) {
        return res
          .status(404)
          .json({ error: 'Demo user is not configured (expected display name Rob in demo household).' });
      }
      const realRow = await getHouseholdUserById(req.householdId, req.userId);
      if (!realRow) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const token = signToken({
        householdId: demoHousehold.id,
        userId: demoUser.id,
        displayName: demoUser.display_name,
        sessionVersion: demoUser.session_version != null ? Math.trunc(Number(demoUser.session_version)) : 0,
        isImpersonating: true,
        impersonationReadOnly: true,
        adminUserId: req.userId,
        adminHouseholdId: req.householdId,
        adminDisplayName: realRow.display_name,
      });
      setAuthCookie(res, token);
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Demo view failed' });
    }
  }
);

app.post('/admin/impersonate/exit', requireHousehold, requireAuth, async (req, res) => {
  try {
    const auth = getUserFromRequest(req);
    if (!auth || !auth.isImpersonating) {
      return res.status(400).json({ error: 'Not in God Mode.' });
    }
    const adminUser = await getHouseholdUserById(auth.adminHouseholdId, auth.adminUserId);
    if (!adminUser) {
      return res.status(401).json({ error: 'Admin session invalid. Log in again.' });
    }
    const token = signToken({
      householdId: adminUser.household_id,
      userId: adminUser.id,
      displayName: adminUser.display_name,
      sessionVersion: adminUser.session_version != null ? Math.trunc(Number(adminUser.session_version)) : 0,
    });
    setAuthCookie(res, token);
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to exit God Mode' });
  }
});

app.get('/login/household', async (req, res) => {
  try {
    const raw = req.query.key;
    if (raw == null || String(raw).trim() === '') {
      return res.status(400).json({ error: 'key is required' });
    }
    const household = await getHouseholdByKey(raw);
    if (!household) {
      return res.status(404).json({ error: 'Household not found' });
    }
    const rows = await listHouseholdUsers(household.id);
    return res.json({
      household: {
        id: household.id,
        name: household.name,
        key: household.household_key,
      },
      users: rows.map((u) => ({
        id: u.id,
        displayName: u.display_name,
        role: u.role,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

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

        #login-form,
        #bootstrap-form {
          background: var(--card-bg);
          border-radius: var(--radius-lg);
          padding: 16px 18px;
          box-shadow: var(--shadow-soft);
          border: 1px solid rgba(148, 163, 184, 0.25);
        }

        #login-form {
          display: none;
          flex-wrap: wrap;
          gap: 10px 12px;
          align-items: center;
        }

        #login-form.login-form-visible {
          display: inline-flex;
        }

        #bootstrap-form {
          display: none;
          flex-direction: column;
          align-items: stretch;
          gap: 10px;
          max-width: 420px;
          width: 100%;
        }

        #bootstrap-form.bootstrap-form-visible {
          display: flex;
        }

        #bootstrap-household-name,
        #bootstrap-household-key,
        #bootstrap-owner-display-name,
        #bootstrap-pin {
          padding: 6px 9px;
          border-radius: 999px;
          border: 1px solid var(--border-subtle);
          font-size: 14px;
          outline: none;
          width: 100%;
          box-sizing: border-box;
        }

        #bootstrap-household-name:focus,
        #bootstrap-household-key:focus,
        #bootstrap-owner-display-name:focus,
        #bootstrap-pin:focus {
          border-color: var(--accent);
          box-shadow: 0 0 0 2px rgba(255, 122, 162, 0.25);
        }

        #bootstrap-submit {
          border-radius: var(--radius-pill);
          background: var(--accent);
          color: #fff;
          border: none;
          font-size: 14px;
          padding: 8px 14px;
          font-weight: 500;
          cursor: pointer;
          margin-top: 4px;
        }

        #bootstrap-submit:hover {
          background: var(--accent-strong);
        }

        #bootstrap-status {
          font-size: 12px;
          color: var(--accent-strong);
          min-height: 1em;
        }

        #login-auth-form {
          margin: 0;
          padding: 0;
          border: none;
        }

        #login-form h2,
        #bootstrap-form h2,
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

        .login-key-row {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          align-items: center;
        }

        #login-household-key {
          flex: 1;
          min-width: 140px;
        }

        #login-find-household {
          border-radius: var(--radius-pill);
          background: var(--accent-blue-soft);
          color: var(--accent-blue);
          border: 1px solid rgba(107, 155, 209, 0.45);
          font-size: 13px;
          padding: 6px 12px;
          font-weight: 500;
          cursor: pointer;
          white-space: nowrap;
        }

        #login-find-household:hover {
          background: #dce8f4;
        }

        .login-household-resolved {
          width: 100%;
          margin: 0;
          font-size: 13px;
          color: var(--text-soft);
        }

        .login-household-resolved strong {
          color: var(--text-main);
          font-weight: 600;
        }

        #login-household-key,
        #login-name,
        #login-password {
          padding: 6px 9px;
          border-radius: 999px;
          border: 1px solid var(--border-subtle);
          font-size: 14px;
          outline: none;
          min-width: 120px;
        }

        #login-household-key:focus,
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

        #grocery-panel,
        #settings-panel {
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

        #settings-panel h2 {
          margin: 0 0 8px;
          font-size: 18px;
        }

        .settings-subtab-btn {
          padding: 8px 14px;
          border-radius: 8px;
          border: 1px solid var(--border-subtle);
          background: #fff;
          cursor: pointer;
          font-size: 14px;
        }

        .settings-subtab-btn.settings-subtab-active {
          border-color: var(--accent-strong);
          font-weight: 600;
        }

        #settings-panel h3 {
          margin: 12px 0 6px;
          font-size: 14px;
          color: var(--text-soft);
        }

        #settings-panel input[type='text'],
        #settings-panel input[type='password'],
        #settings-panel select {
          padding: 6px 10px;
          border-radius: 8px;
          border: 1px solid var(--border-subtle);
          font-size: 14px;
        }

        #settings-add-form {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          align-items: center;
        }

        .settings-user-row {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          align-items: center;
          margin-bottom: 8px;
          padding: 8px;
          border: 1px solid rgba(229, 231, 235, 0.95);
          border-radius: 8px;
          background: rgba(249, 250, 251, 0.9);
          transition: box-shadow 0.2s ease, background 0.2s ease;
        }

        .settings-user-row.settings-user-row-role-flash {
          box-shadow: 0 0 0 2px var(--accent-strong);
          background: rgba(255, 122, 162, 0.14);
        }

        .settings-user-row-role-col {
          display: flex;
          flex-direction: column;
          gap: 4px;
          align-items: flex-start;
        }

        .settings-user-row-role-feedback {
          font-size: 12px;
          line-height: 1.35;
          min-height: 1.35em;
          max-width: 280px;
        }

        #my-settings-msg {
          font-size: 13px;
          color: var(--accent-strong);
          min-height: 1.2em;
        }

        #grocery-manual-add {
          margin-bottom: 4px;
        }

        #grocery-manual-add button#grocery-add-submit {
          padding: 6px 12px;
          font-size: 14px;
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

        .kb-thinking {
          color: var(--text-soft);
        }
        .kb-thinking-anim {
          animation: kb-thinking-pulse 1.35s ease-in-out infinite;
        }
        @keyframes kb-thinking-pulse {
          0%, 100% { opacity: 0.5; }
          50% { opacity: 1; }
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

        .message.user.user-msg-chat-pink {
          background: #ffe4ea;
          border: 1px solid rgba(255, 122, 162, 0.38);
        }
        .message.user.user-msg-chat-blue {
          background: #dbeafe;
          border: 1px solid rgba(59, 130, 246, 0.35);
        }
        .message.user.user-msg-chat-mint {
          background: #d1fae5;
          border: 1px solid rgba(16, 185, 129, 0.35);
        }
        .message.user.user-msg-chat-lavender {
          background: #ede9fe;
          border: 1px solid rgba(139, 92, 246, 0.32);
        }
        .message.user.user-msg-chat-peach {
          background: #ffedd5;
          border: 1px solid rgba(249, 115, 22, 0.35);
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

        #prompt {
          height: auto;
          min-height: 44px;
          max-height: none;
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
          width: 44px;
          height: 44px;
          min-width: 44px;
          min-height: 44px;
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

          #login-form.login-form-visible {
            display: flex;
            flex-direction: column;
            align-items: stretch;
            width: 100%;
            padding: 20px 18px;
            gap: 14px;
          }

          #bootstrap-form.bootstrap-form-visible {
            max-width: 100%;
            padding: 20px 18px;
            gap: 14px;
          }

          #bootstrap-household-name,
          #bootstrap-household-key,
          #bootstrap-owner-display-name,
          #bootstrap-pin {
            min-height: 44px;
            padding: 10px 14px;
            font-size: 16px;
            border-radius: 12px;
          }

          #bootstrap-submit {
            min-height: 44px;
            padding: 12px 20px;
            font-size: 16px;
          }

          #login-form label {
            font-size: 14px;
            margin-bottom: -6px;
          }

          #bootstrap-form label {
            font-size: 14px;
            margin-bottom: -6px;
          }

          #login-form label + select,
          #login-form label + input {
            margin-top: 4px;
          }

          #bootstrap-form label + input {
            margin-top: 4px;
          }

          .login-key-row {
            width: 100%;
            flex-direction: column;
            align-items: stretch;
          }

          #login-find-household {
            min-height: 44px;
            width: 100%;
            border-radius: 12px;
          }

          #login-household-key,
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
          <button id="tab-settings" type="button" class="tab-button" style="display: none;">Settings</button>
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
      </aside>

      <div id="login-area">
        <div id="login-brand">
          <img src="/logo.png" alt="" class="login-logo" />
          <h1 class="login-title">KitchenBot</h1>
        </div>
        <div id="bootstrap-blocked" style="display: none; max-width: 420px; width: 100%; background: var(--card-bg); border-radius: var(--radius-lg); padding: 16px 18px; box-shadow: var(--shadow-soft); border: 1px solid rgba(148, 163, 184, 0.25);">
          <h2 style="margin-top: 0;">Waiting for server seed</h2>
          <p style="margin: 0 0 8px; font-size: 14px; color: var(--text-soft); line-height: 1.45;">
            The database is empty, but this server is configured to create the first household from <code>INITIAL_*</code> environment variables instead of the public setup form. If you still see this after a restart, check the server logs for seeding errors, fix the configuration, and restart.
          </p>
        </div>
        <div id="bootstrap-form">
          <h2>Set up your household</h2>
          <label for="bootstrap-household-name">Household name</label>
          <input id="bootstrap-household-name" type="text" autocomplete="organization" placeholder="My home" />
          <label for="bootstrap-household-key">Household key</label>
          <input id="bootstrap-household-key" type="text" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="e.g. oconnor-home" />
          <label for="bootstrap-owner-display-name">Owner display name</label>
          <input id="bootstrap-owner-display-name" type="text" autocomplete="name" placeholder="Rob" />
          <label for="bootstrap-pin">PIN</label>
          <input id="bootstrap-pin" type="password" autocomplete="new-password" />
          <button type="button" id="bootstrap-submit">Create household</button>
          <div id="bootstrap-status"></div>
        </div>
        <div id="login-form">
          <form id="login-auth-form" action="#" method="post" autocomplete="on">
            <label for="login-household-key">Household key:</label>
            <div class="login-key-row">
              <input id="login-household-key" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="e.g. account-key" />
              <button type="button" id="login-find-household">Find household</button>
            </div>
            <p id="login-household-resolved" class="login-household-resolved" style="display: none;">
              <span class="login-household-resolved-label">Household:</span>
              <strong id="login-household-name"></strong>
            </p>
            <label for="login-name">User:</label>
            <select id="login-name" disabled>
              <option value="">— Select user —</option>
            </select>
            <label for="login-password">PIN:</label>
            <input id="login-password" type="password" autocomplete="current-password" />
            <button type="submit" id="login-button" disabled>Login</button>
            <div id="login-status"></div>
          </form>
        </div>
      </div>

      <div id="app" style="display:none;">
        <div
          id="god-mode-banner"
          style="display: none; flex-shrink: 0; width: 100%; box-sizing: border-box; padding: 10px 14px; background: #4c1d95; color: #faf5ff; font-size: 14px; border-bottom: 2px solid #7c3aed; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;"
        >
          <div id="god-mode-banner-text" style="flex: 1; min-width: 200px; line-height: 1.4;"></div>
          <button
            type="button"
            id="god-mode-exit-btn"
            style="padding: 8px 14px; border-radius: 8px; border: none; font-weight: 600; cursor: pointer; background: #f5f3ff; color: #4c1d95;"
          >
            Exit God Mode
          </button>
        </div>
        <div id="chat" class="panel panel-active"></div>

        <div id="typing-indicator" aria-live="polite"></div>

        <div id="grocery-panel" class="panel" style="display:none;">
          <div id="grocery-manual-add">
            <label for="grocery-add-name" style="font-size:13px;color:var(--text-soft);">Add item</label>
            <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:6px;">
              <input id="grocery-add-name" type="text" placeholder="Item name" autocomplete="off" style="min-width:140px;flex:1;padding:6px 10px;border-radius:8px;border:1px solid var(--border-subtle);font-size:14px;" />
              <input id="grocery-add-amount" type="text" placeholder="Amount (optional)" autocomplete="off" style="min-width:100px;padding:6px 10px;border-radius:8px;border:1px solid var(--border-subtle);font-size:14px;" />
              <label for="grocery-add-section" style="font-size:13px;color:var(--text-soft);">Section</label>
              <select id="grocery-add-section" style="padding:6px 10px;border-radius:8px;border:1px solid var(--border-subtle);font-size:14px;">
                <option value="produce">Produce</option>
                <option value="meat">Meat</option>
                <option value="dairy">Dairy</option>
                <option value="frozen">Frozen</option>
                <option value="dry">Dry</option>
                <option value="other" selected>Other</option>
              </select>
              <button type="button" id="grocery-add-submit">Add</button>
            </div>
          </div>
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

        <div id="settings-panel" class="panel" style="display: none;">
          <h2 style="margin-top: 0;">Settings</h2>
          <div id="settings-subnav" style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px;">
            <button type="button" id="settings-subtab-my-btn" class="settings-subtab-btn settings-subtab-active">My household</button>
            <button type="button" id="settings-subtab-admin-btn" class="settings-subtab-btn" style="display: none;">Global admin</button>
          </div>

          <div id="settings-view-my" class="settings-subview">
            <h3 style="margin-top: 0;">Your household</h3>
            <p style="margin: 0 0 12px; font-size: 13px; color: var(--text-soft); max-width: 520px;">
              Everything here applies to the household you are logged into (your session household).
            </p>
            <p style="margin: 0;"><strong>Name:</strong> <span id="my-settings-hh-name"></span></p>
            <p style="margin: 0;"><strong>Key:</strong> <code id="my-settings-hh-key"></code></p>
            <div style="margin: 14px 0 12px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border-subtle); max-width: 520px;">
              <p style="margin: 0 0 8px; font-size: 13px; color: var(--text-soft); line-height: 1.45;">
                Open a read-only walkthrough as the sample user in the shared demo household.
              </p>
              <button type="button" id="settings-demo-view-btn" style="padding: 6px 12px; border-radius: 8px; font-size: 14px;">
                See how to use this
              </button>
              <span id="settings-demo-view-msg" style="margin-left: 8px; font-size: 13px; color: var(--accent-strong);"></span>
            </div>
            <h3>Anthropic API</h3>
            <div id="settings-anthropic-block" style="margin-bottom: 12px;">
              <p id="settings-anthropic-status" style="margin: 0 0 8px; font-size: 14px;"></p>
              <div id="settings-anthropic-owner-key-section" style="display: none; margin-top: 10px;">
                <p id="settings-anthropic-key-disclaimer" style="margin: 0 0 10px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border-subtle); border-left: 3px solid var(--accent-strong); font-size: 13px; color: var(--text-soft); line-height: 1.45; max-width: 520px;">
                  This is a hobby app and is inherently insecure. You should set spend limits and monitor usage in your Anthropic account when using your own API key.
                </p>
                <label for="settings-anthropic-owner-key" style="font-size: 13px; color: var(--text-soft);">Household Anthropic API key</label>
                <input id="settings-anthropic-owner-key" type="password" placeholder="sk-ant-…" autocomplete="off" style="width: 100%; max-width: 420px; margin-top: 4px; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border-subtle);" />
                <button type="button" id="settings-anthropic-owner-key-save" style="margin-top: 8px;">Save key</button>
                <span id="settings-anthropic-owner-key-msg" style="margin-left: 8px; font-size: 13px; color: var(--accent-strong);"></span>
              </div>
            </div>
            <h3>Users</h3>
            <div id="my-settings-users-list"></div>
            <h3>Add user</h3>
            <div id="settings-add-form">
              <input id="settings-new-display" type="text" placeholder="Display name" autocomplete="off" />
              <select id="settings-new-role" aria-label="Role">
                <option value="member">member</option>
                <option value="owner">owner</option>
              </select>
              <input id="settings-new-pin" type="password" placeholder="PIN" autocomplete="new-password" />
              <button type="button" id="settings-add-submit">Add user</button>
            </div>
            <div id="my-settings-memories-wrap">
              <h3>Household memories</h3>
              <p style="margin: 0 0 8px; font-size: 13px; color: var(--text-soft); max-width: 520px;">
                These entries are included in chat context for everyone in this household.
              </p>
              <div id="my-settings-memories-list" style="margin-bottom: 12px; font-size: 13px;"></div>
              <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; margin-bottom: 8px;">
                <div>
                  <label for="my-settings-memory-key" style="font-size: 12px; color: var(--text-soft); display: block;">Key</label>
                  <input id="my-settings-memory-key" type="text" autocomplete="off" placeholder="e.g. dietary_notes" style="width: 180px;" />
                </div>
                <div style="flex: 1; min-width: 160px;">
                  <label for="my-settings-memory-value" style="font-size: 12px; color: var(--text-soft); display: block;">Value</label>
                  <input id="my-settings-memory-value" type="text" autocomplete="off" placeholder="Value" style="width: 100%; max-width: 360px;" />
                </div>
                <button type="button" id="my-settings-memory-save">Save</button>
                <button type="button" id="my-settings-memory-cancel-edit" style="display: none;">Cancel</button>
              </div>
              <div id="my-settings-memories-msg" style="font-size: 13px; color: var(--accent-strong); margin-bottom: 8px;"></div>
            </div>
            <div id="my-settings-msg"></div>
          </div>

          <div id="settings-view-admin" class="settings-subview" style="display: none;">
            <h3 style="margin-top: 0;">Global admin</h3>
            <p style="margin: 0 0 12px; font-size: 13px; color: var(--text-soft); max-width: 560px;">
              Actions below apply to the household you select — not necessarily the household you are logged into.
            </p>
            <div id="admin-editing-banner" style="margin-bottom: 12px; padding: 10px 12px; border: 2px solid var(--accent-strong); border-radius: 8px; font-size: 14px; font-weight: 600; background: rgba(255, 122, 162, 0.08);"></div>
            <h4 style="margin: 0 0 8px; font-size: 15px;">All households</h4>
            <div id="settings-admin-households-list" style="font-size: 13px; margin-bottom: 12px;"></div>
            <label for="admin-anthropic-household-select" style="font-size: 13px;">Selected household</label><br />
            <select id="admin-anthropic-household-select" style="margin: 4px 0 12px; max-width: min(100%, 420px); padding: 6px;"></select>
            <div id="settings-admin-household-detail" style="margin-bottom: 16px; padding: 10px; border: 1px solid var(--border-subtle); border-radius: 8px; font-size: 13px;">
              <div><strong>Name:</strong> <span id="admin-detail-name"></span></div>
              <div style="margin-top: 4px;"><strong>Key:</strong> <code id="admin-detail-key"></code></div>
              <div id="admin-detail-usage" style="margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border-subtle);"></div>
              <div style="margin-top: 8px;"><strong>Users (this household only)</strong></div>
              <table style="width: 100%; border-collapse: collapse; margin-top: 4px; font-size: 13px;">
                <thead><tr><th style="text-align:left; border-bottom:1px solid var(--border-subtle); padding: 4px;">Display name</th><th style="text-align:left; border-bottom:1px solid var(--border-subtle); padding: 4px;">Role</th><th style="text-align:left; border-bottom:1px solid var(--border-subtle); padding: 4px;">PIN (global admin)</th><th style="text-align:left; border-bottom:1px solid var(--border-subtle); padding: 4px;">View as</th></tr></thead>
                <tbody id="admin-detail-users-body"></tbody>
              </table>
              <p id="admin-pin-global-msg" style="margin: 8px 0 0; font-size: 13px; color: var(--accent-strong);"></p>
              <p id="admin-anthropic-selected-status" style="margin: 10px 0 0; font-size: 13px;"></p>
            </div>
            <h4 style="margin: 16px 0 8px; font-size: 15px;">Anthropic mode</h4>
            <p style="font-size: 13px; color: var(--text-soft); margin: 0 0 8px;">Switch who provides the API key for the <strong>selected</strong> household. Owners set their own key under My household when mode is household.</p>
            <div id="admin-anthropic-edit-controls">
              <div style="display: flex; flex-direction: column; gap: 8px;">
                <label style="display: flex; align-items: center; gap: 8px;">
                  <input type="radio" name="admin-anthropic-mode" id="admin-anthropic-mode-shared" value="shared" />
                  <span>Shared — server key (Rob&apos;s)</span>
                </label>
                <label style="display: flex; align-items: center; gap: 8px;">
                  <input type="radio" name="admin-anthropic-mode" id="admin-anthropic-mode-household" value="household" />
                  <span>Household — owner supplies key</span>
                </label>
              </div>
              <p id="admin-anthropic-shared-help" style="margin: 8px 0 0; font-size: 13px; color: var(--text-soft); display: none;">Selected household uses the server shared key.</p>
              <button type="button" id="admin-anthropic-mode-save" style="margin-top: 8px;">Save mode</button>
              <span id="admin-anthropic-msg" style="margin-left: 8px; font-size: 13px; color: var(--accent-strong);"></span>
            </div>
            <h4 style="margin: 16px 0 8px; font-size: 15px;">Anthropic web search</h4>
            <p style="font-size: 13px; color: var(--text-soft); margin: 0 0 8px; max-width: 560px;">
              For the <strong>selected</strong> household only: when enabled, KitchenBot may attach Anthropic&apos;s web search tool on messages that look like they need live web context (URLs, current/latest info, or references to a named external source). Ordinary recipe chat stays on regular requests without web search.
            </p>
            <label style="display: flex; align-items: flex-start; gap: 8px; max-width: 520px;">
              <input type="checkbox" id="admin-web-search-enabled" style="margin-top: 3px;" />
              <span>Enable web search for this household</span>
            </label>
            <div style="margin-top: 8px;">
              <button type="button" id="admin-web-search-save">Save web search setting</button>
              <span id="admin-web-search-msg" style="margin-left: 8px; font-size: 13px; color: var(--accent-strong);"></span>
            </div>
            <h4 style="margin: 20px 0 8px; font-size: 15px;">Create household</h4>
            <p style="font-size: 13px; color: var(--text-soft); margin: 0 0 8px;">Creates a new household with only the owner user. Share the household key and owner PIN separately.</p>
            <div style="display: flex; flex-direction: column; gap: 6px; max-width: 420px;">
              <input id="admin-new-hh-name" type="text" placeholder="Household name" autocomplete="organization" />
              <input id="admin-new-hh-key" type="text" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="Household key (e.g. smith-home)" />
              <input id="admin-new-owner-name" type="text" placeholder="Owner display name" autocomplete="name" />
              <input id="admin-new-owner-pin" type="password" placeholder="Owner PIN" autocomplete="new-password" />
              <button type="button" id="admin-new-hh-submit">Create household</button>
            </div>
            <p id="admin-new-hh-msg" style="font-size: 13px; margin-top: 8px;"></p>
          </div>
        </div>

        <div id="input-area">
          <textarea id="prompt" placeholder="Ask KitchenBot or type !help" rows="1"></textarea>
          <button id="send" type="button" aria-label="Send">↑</button>
        </div>
      </div>

      <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
      <script>
        const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        const useMobileEnterBehavior = isMobile;
        const loginArea = document.getElementById('login-area');
        const appArea = document.getElementById('app');
        const loginHouseholdKeyInput = document.getElementById('login-household-key');
        const loginFindHouseholdButton = document.getElementById('login-find-household');
        const loginNameSelect = document.getElementById('login-name');
        const loginPasswordInput = document.getElementById('login-password');
        const loginButton = document.getElementById('login-button');
        const loginAuthForm = document.getElementById('login-auth-form');
        const loginStatus = document.getElementById('login-status');
        const speakerName = document.getElementById('speaker-name');
        const menuButton = document.getElementById('menu-button');
        const sidebar = document.getElementById('sidebar');
        const sidebarBackdrop = document.getElementById('sidebar-backdrop');
        const chatListEl = document.getElementById('chat-list');
        const newChatButton = document.getElementById('new-chat');
        const chat = document.getElementById('chat');
        const groceryPanel = document.getElementById('grocery-panel');
        const settingsPanel = document.getElementById('settings-panel');
        const tabChat = document.getElementById('tab-chat');
        const tabGroceries = document.getElementById('tab-groceries');
        const tabSettings = document.getElementById('tab-settings');
        const inputArea = document.getElementById('input-area');
        const groceryRefreshButton = document.getElementById('grocery-refresh');
        const groceryClearButton = document.getElementById('grocery-clear');
        const groceryAddName = document.getElementById('grocery-add-name');
        const groceryAddAmount = document.getElementById('grocery-add-amount');
        const groceryAddSection = document.getElementById('grocery-add-section');
        const groceryAddSubmit = document.getElementById('grocery-add-submit');
        const promptInput = document.getElementById('prompt');
        const sendButton = document.getElementById('send');
        const logoutButton = document.getElementById('logout');
        const typingIndicator = document.getElementById('typing-indicator');
        let cachedAdminHouseholds = null;
        let currentSettingsSubView = 'my';

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
        let currentHouseholdId = null;
        let currentUserId = null;
        let isCurrentUserOwner = false;
        let godModeReadOnly = false;
        let editingMemoryKey = null;
        /** Normalized display name (trim + lower) -> chat color key */
        let displayNameToColor = {};
        const CHAT_COLOR_OPTIONS = [
          { key: 'pink', label: 'Pink' },
          { key: 'blue', label: 'Blue' },
          { key: 'mint', label: 'Mint' },
          { key: 'lavender', label: 'Lavender' },
          { key: 'peach', label: 'Peach' },
        ];
        function normalizeDisplayNameKey(name) {
          return String(name ?? '').trim().toLowerCase();
        }
        function rebuildDisplayNameToColorFromMeChatColors(chatColors) {
          displayNameToColor = {};
          if (chatColors && typeof chatColors === 'object' && !Array.isArray(chatColors)) {
            for (const k of Object.keys(chatColors)) {
              const nk = normalizeDisplayNameKey(k);
              if (nk) displayNameToColor[nk] = chatColors[k];
            }
          }
        }
        function rebuildDisplayNameToColorFromSettingsUsers(users) {
          displayNameToColor = {};
          for (const u of users || []) {
            const nk = normalizeDisplayNameKey(u.displayName);
            if (nk) displayNameToColor[nk] = u.chatColor || 'blue';
          }
        }
        function userMessageBubbleClass(displayName) {
          const nk = normalizeDisplayNameKey(displayName);
          const raw = nk ? displayNameToColor[nk] : undefined;
          const k =
            typeof raw === 'string' && raw.trim()
              ? raw.trim().toLowerCase()
              : 'blue';
          const ok = CHAT_COLOR_OPTIONS.some((o) => o.key === k);
          return 'user-msg-chat-' + (ok ? k : 'blue');
        }
        let chatsCache = [];
        let lastDeletedGrocery = null;
        let lastDeletedTimeout = null;
        let lastMePayload = null;

        function applyGodModeFromMe(data) {
          if (data && typeof data.name === 'string' && data.householdId != null) {
            lastMePayload = data;
          }
          const ro = !!(data && data.impersonationReadOnly && data.isImpersonating);
          godModeReadOnly = ro;
          const banner = document.getElementById('god-mode-banner');
          const textEl = document.getElementById('god-mode-banner-text');
          if (banner && textEl) {
            if (data && data.isImpersonating) {
              textEl.textContent = '';
              const strong = document.createElement('strong');
              strong.textContent =
                'Viewing as ' +
                String(data.name || 'user') +
                ' in ' +
                String(data.householdName || 'this household');
              textEl.appendChild(strong);
              textEl.appendChild(document.createElement('br'));
              const sub = document.createElement('span');
              sub.style.opacity = '0.92';
              sub.textContent =
                data.isGlobalAdmin === true ? 'Read-only God Mode' : 'Read-only Demo Mode';
              textEl.appendChild(sub);
              banner.style.display = 'flex';
              const exitBtn = document.getElementById('god-mode-exit-btn');
              if (exitBtn) {
                exitBtn.textContent =
                  data.isGlobalAdmin === true ? 'Exit God Mode' : 'Exit Demo Mode';
              }
            } else {
              textEl.textContent = '';
              banner.style.display = 'none';
              const exitBtn = document.getElementById('god-mode-exit-btn');
              if (exitBtn) exitBtn.textContent = 'Exit God Mode';
            }
          }
          if (promptInput) {
            promptInput.readOnly = ro;
            promptInput.style.opacity = ro ? '0.65' : '';
          }
          if (sendButton) {
            sendButton.disabled = ro;
            sendButton.style.opacity = ro ? '0.5' : '';
          }
          if (newChatButton) {
            newChatButton.disabled = ro;
            newChatButton.style.opacity = ro ? '0.5' : '';
          }
          const gas = document.getElementById('settings-anthropic-owner-key-save');
          const sas = document.getElementById('settings-add-submit');
          const memSave = document.getElementById('my-settings-memory-save');
          const adminModeSave = document.getElementById('admin-anthropic-mode-save');
          const adminNewHh = document.getElementById('admin-new-hh-submit');
          const demoViewBtn = document.getElementById('settings-demo-view-btn');
          if (gas) gas.disabled = ro;
          if (sas) sas.disabled = ro;
          if (memSave) memSave.disabled = ro;
          if (demoViewBtn) demoViewBtn.disabled = ro;
          if (adminModeSave) adminModeSave.disabled = ro;
          if (adminNewHh) adminNewHh.disabled = ro;
          if (groceryAddName) {
            groceryAddName.readOnly = ro;
            groceryAddName.style.opacity = ro ? '0.65' : '';
          }
          if (groceryAddAmount) {
            groceryAddAmount.readOnly = ro;
            groceryAddAmount.style.opacity = ro ? '0.65' : '';
          }
          if (groceryAddSection) groceryAddSection.disabled = ro;
          if (groceryAddSubmit) groceryAddSubmit.disabled = ro;
          if (groceryClearButton) groceryClearButton.disabled = ro;
        }

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
          if (currentHouseholdId == null || !Number.isFinite(Number(currentHouseholdId))) return;
          typingWs.send(JSON.stringify({ type: 'viewing', householdId: currentHouseholdId, chatId: currentChatId }));
          typingUsers.clear();
          updateTypingIndicator();
        }

        function connectTypingWs() {
          if (!currentUserName || currentHouseholdId == null || currentUserId == null) return;
          if (!Number.isFinite(Number(currentHouseholdId)) || !Number.isFinite(Number(currentUserId))) return;
          const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
          const url = proto + '//' + location.host;
          try {
            const ws = new WebSocket(url);
            ws.onopen = () => {
              ws.send(
                JSON.stringify({
                  type: 'identify',
                  householdId: currentHouseholdId,
                  userId: currentUserId,
                  user: currentUserName,
                })
              );
              sendTypingViewing();
            };
            ws.onmessage = (event) => {
              try {
                const msg = JSON.parse(event.data);
                const msgChatId = msg.chatId != null ? Number(msg.chatId) : null;
                const msgHid = msg.householdId != null ? Number(msg.householdId) : null;
                if (msg.type === 'chat_updated' && msgChatId === currentChatId) {
                  if (msgHid != null && currentHouseholdId != null && msgHid !== Number(currentHouseholdId)) {
                    return;
                  }
                  if (msg.user && msg.user === currentUserName) {
                    return;
                  }
                  remoteStreamBodyEl = null;
                  if (!weAreStreamingThisChat) loadHistory();
                  return;
                }
                if (msg.type === 'stream_delta' && msgChatId === currentChatId) {
                  if (msgHid != null && currentHouseholdId != null && msgHid !== Number(currentHouseholdId)) {
                    return;
                  }
                  if (
                    weAreStreamingThisChat &&
                    msg.user &&
                    currentUserName &&
                    msg.user === currentUserName
                  ) {
                    return;
                  }
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
                  if (currentHouseholdId == null || !Number.isFinite(Number(currentHouseholdId))) return;
                  if (msgHid == null || msgHid !== Number(currentHouseholdId)) return;
                  if (msgChatId != null && msgChatId !== currentChatId) return;
                  if (msg.userId != null && currentUserId != null && Number(msg.userId) === Number(currentUserId)) return;
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

        function showBootstrapForm() {
          const bf = document.getElementById('bootstrap-form');
          const lf = document.getElementById('login-form');
          const blk = document.getElementById('bootstrap-blocked');
          if (blk) blk.style.display = 'none';
          if (bf) bf.classList.add('bootstrap-form-visible');
          if (lf) lf.classList.remove('login-form-visible');
        }

        function showBootstrapBlocked() {
          const bf = document.getElementById('bootstrap-form');
          const lf = document.getElementById('login-form');
          const blk = document.getElementById('bootstrap-blocked');
          if (bf) bf.classList.remove('bootstrap-form-visible');
          if (lf) lf.classList.remove('login-form-visible');
          if (blk) blk.style.display = 'block';
        }

        function showLoginFormOnly() {
          const bf = document.getElementById('bootstrap-form');
          const lf = document.getElementById('login-form');
          const blk = document.getElementById('bootstrap-blocked');
          if (blk) blk.style.display = 'none';
          if (bf) bf.classList.remove('bootstrap-form-visible');
          if (lf) lf.classList.add('login-form-visible');
        }

        function showLogin() {
          loginArea.style.display = 'block';
          appArea.style.display = 'none';
          headerEl.classList.add('hide-tabs');
          showLoginFormOnly();
          if (tabSettings) tabSettings.style.display = 'none';
          setActiveTab('chat');
        }

        function setActiveTab(tab) {
          tabChat.classList.toggle('tab-active', tab === 'chat');
          tabGroceries.classList.toggle('tab-active', tab === 'groceries');
          if (tabSettings) tabSettings.classList.toggle('tab-active', tab === 'settings');
          chat.style.display = tab === 'chat' ? 'flex' : 'none';
          groceryPanel.style.display = tab === 'groceries' ? 'flex' : 'none';
          if (settingsPanel) settingsPanel.style.display = tab === 'settings' ? 'flex' : 'none';
          if (inputArea) inputArea.style.display = tab === 'chat' ? 'flex' : 'none';
          if (tab === 'settings') loadSettingsPanel();
        }

        function syncMemoriesWrapVisibility() {
          const w = document.getElementById('my-settings-memories-wrap');
          if (w) w.style.display = isCurrentUserOwner ? '' : 'none';
        }

        function resetMemoryEditForm() {
          editingMemoryKey = null;
          const keyIn = document.getElementById('my-settings-memory-key');
          const valIn = document.getElementById('my-settings-memory-value');
          const cancelBtn = document.getElementById('my-settings-memory-cancel-edit');
          if (keyIn) {
            keyIn.value = '';
            keyIn.readOnly = false;
          }
          if (valIn) valIn.value = '';
          if (cancelBtn) cancelBtn.style.display = 'none';
        }

        async function loadHouseholdMemoriesEditor() {
          const listEl = document.getElementById('my-settings-memories-list');
          const memMsg = document.getElementById('my-settings-memories-msg');
          if (!listEl || !isCurrentUserOwner) return;
          try {
            const r = await fetch('/settings/household/memories');
            if (!r.ok) {
              listEl.innerHTML = '';
              if (memMsg) memMsg.textContent = 'Could not load memories.';
              return;
            }
            const data = await r.json();
            listEl.innerHTML = '';
            for (const m of data.memories || []) {
              if (m.key === 'assistant_name') continue;
              const row = document.createElement('div');
              row.style.cssText =
                'display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--border-subtle);';
              const kv = document.createElement('div');
              kv.style.flex = '1';
              kv.style.minWidth = '0';
              const strong = document.createElement('strong');
              strong.style.fontSize = '13px';
              strong.textContent = m.key;
              kv.appendChild(strong);
              kv.appendChild(document.createTextNode(': '));
              const span = document.createElement('span');
              span.style.wordBreak = 'break-word';
              span.textContent = m.value;
              kv.appendChild(span);
              row.appendChild(kv);
              const editBtn = document.createElement('button');
              editBtn.type = 'button';
              editBtn.textContent = 'Edit';
              editBtn.addEventListener('click', () => {
                editingMemoryKey = m.key;
                const keyIn = document.getElementById('my-settings-memory-key');
                const valIn = document.getElementById('my-settings-memory-value');
                const cancelBtn = document.getElementById('my-settings-memory-cancel-edit');
                if (keyIn) {
                  keyIn.value = m.key;
                  keyIn.readOnly = true;
                }
                if (valIn) valIn.value = m.value;
                if (cancelBtn) cancelBtn.style.display = '';
                if (memMsg) memMsg.textContent = '';
              });
              const delBtn = document.createElement('button');
              delBtn.type = 'button';
              delBtn.textContent = 'Delete';
              delBtn.addEventListener('click', async () => {
                if (!confirm('Delete memory "' + m.key + '"?')) return;
                const dr = await fetch('/settings/household/memories/' + encodeURIComponent(m.key), {
                  method: 'DELETE',
                });
                const errBody = await dr.json().catch(() => ({}));
                if (memMsg) {
                  memMsg.textContent = dr.ok ? 'Memory deleted.' : errBody.error || 'Delete failed';
                }
                if (dr.ok) {
                  resetMemoryEditForm();
                  await loadHouseholdMemoriesEditor();
                }
              });
              row.appendChild(editBtn);
              row.appendChild(delBtn);
              listEl.appendChild(row);
            }
          } catch (e) {
            listEl.innerHTML = '';
            if (memMsg) memMsg.textContent = 'Load failed.';
          }
        }

        async function loadMyHouseholdView() {
          const msgEl = document.getElementById('my-settings-msg');
          const nameEl = document.getElementById('my-settings-hh-name');
          const keyEl = document.getElementById('my-settings-hh-key');
          const listEl = document.getElementById('my-settings-users-list');
          if (!listEl || !nameEl || !keyEl) return;
          try {
            const r = await fetch('/settings/household');
            if (!r.ok) {
              if (msgEl) msgEl.textContent = 'Could not load settings.';
              return;
            }
            const data = await r.json();
            nameEl.textContent = data.household.name;
            keyEl.textContent = data.household.key;
            rebuildDisplayNameToColorFromSettingsUsers(data.users);
            if (currentChatId) {
              try {
                await loadHistory();
              } catch (e) {}
            }
            listEl.innerHTML = '';
            for (const u of data.users) {
              const row = document.createElement('div');
              row.className = 'settings-user-row';
              const label = document.createElement('span');
              label.style.flex = '1';
              label.textContent = u.displayName;
              const roleCol = document.createElement('div');
              roleCol.className = 'settings-user-row-role-col';
              const roleWrap = document.createElement('div');
              roleWrap.style.display = 'flex';
              roleWrap.style.alignItems = 'center';
              roleWrap.style.flexWrap = 'wrap';
              roleWrap.style.gap = '6px';
              const roleLbl = document.createElement('span');
              roleLbl.textContent = 'Role';
              roleLbl.style.fontSize = '13px';
              roleLbl.style.color = 'var(--text-soft)';
              const roleSel = document.createElement('select');
              roleSel.setAttribute('aria-label', 'Role for ' + u.displayName);
              [['owner', 'Owner'], ['member', 'Member']].forEach(([val, lab]) => {
                const o = document.createElement('option');
                o.value = val;
                o.textContent = lab;
                roleSel.appendChild(o);
              });
              roleSel.value = u.role === 'owner' ? 'owner' : 'member';
              let prevRole = roleSel.value;
              const roleBtn = document.createElement('button');
              roleBtn.type = 'button';
              roleBtn.textContent = 'Update role';
              const roleFeedback = document.createElement('div');
              roleFeedback.className = 'settings-user-row-role-feedback';
              roleFeedback.setAttribute('aria-live', 'polite');
              const isSelf = u.id === data.currentUser.id;
              function syncRoleButtonState() {
                if (isSelf) return;
                roleBtn.disabled = roleSel.value === prevRole;
              }
              if (isSelf) {
                roleSel.disabled = true;
                roleBtn.disabled = true;
              } else {
                roleSel.addEventListener('change', () => {
                  roleFeedback.textContent = '';
                  syncRoleButtonState();
                });
                syncRoleButtonState();
              }
              roleBtn.addEventListener('click', async () => {
                const newRole = roleSel.value;
                if (newRole === prevRole) {
                  roleFeedback.textContent = 'No changes';
                  roleFeedback.style.color = 'var(--text-soft)';
                  return;
                }
                const originalBtnText = 'Update role';
                roleBtn.textContent = 'Saving...';
                roleBtn.disabled = true;
                if (!isSelf) roleSel.disabled = true;
                roleFeedback.textContent = '';
                try {
                  const rr = await fetch('/settings/household/users/' + u.id + '/role', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ role: newRole }),
                  });
                  const errBody = await rr.json().catch(() => ({}));
                  if (rr.ok) {
                    prevRole = newRole;
                    roleFeedback.textContent = 'Role updated';
                    roleFeedback.style.color = 'var(--accent-strong)';
                    row.classList.add('settings-user-row-role-flash');
                    setTimeout(() => row.classList.remove('settings-user-row-role-flash'), 2000);
                  } else {
                    roleFeedback.textContent = errBody.error || 'Failed to update role';
                    roleFeedback.style.color = '#b91c1c';
                    roleSel.value = prevRole;
                  }
                } catch (e) {
                  roleFeedback.textContent = 'Request failed';
                  roleFeedback.style.color = '#b91c1c';
                  roleSel.value = prevRole;
                } finally {
                  roleBtn.textContent = originalBtnText;
                  if (!isSelf) roleSel.disabled = false;
                  if (!isSelf) syncRoleButtonState();
                }
              });
              roleWrap.appendChild(roleLbl);
              roleWrap.appendChild(roleSel);
              roleWrap.appendChild(roleBtn);
              roleCol.appendChild(roleWrap);
              roleCol.appendChild(roleFeedback);
              const pinCol = document.createElement('div');
              pinCol.className = 'settings-user-row-role-col';
              const pinRow = document.createElement('div');
              pinRow.style.display = 'flex';
              pinRow.style.flexWrap = 'wrap';
              pinRow.style.gap = '6px';
              pinRow.style.alignItems = 'center';
              const pinIn = document.createElement('input');
              pinIn.type = 'password';
              pinIn.placeholder = 'new PIN';
              pinIn.autocomplete = 'new-password';
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.textContent = 'Update PIN';
              const pinFeedback = document.createElement('div');
              pinFeedback.className = 'settings-user-row-role-feedback';
              pinFeedback.setAttribute('aria-live', 'polite');
              let pinSaving = false;
              function syncPinButton() {
                if (pinSaving) return;
                btn.disabled = pinIn.value.trim() === '';
              }
              syncPinButton();
              pinIn.addEventListener('input', () => {
                pinFeedback.textContent = '';
                syncPinButton();
              });
              btn.addEventListener('click', async () => {
                if (pinSaving) return;
                const pin = pinIn.value.trim();
                if (!pin) {
                  pinFeedback.textContent = 'Enter a PIN.';
                  pinFeedback.style.color = 'var(--text-soft)';
                  return;
                }
                pinSaving = true;
                btn.disabled = true;
                pinIn.disabled = true;
                btn.textContent = 'Saving...';
                pinFeedback.textContent = '';
                try {
                  const rr = await fetch('/settings/household/users/' + u.id + '/pin', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pin }),
                  });
                  const errBody = await rr.json().catch(() => ({}));
                  if (rr.ok) {
                    pinIn.value = '';
                    pinFeedback.textContent = 'PIN updated';
                    pinFeedback.style.color = 'var(--accent-strong)';
                    row.classList.add('settings-user-row-role-flash');
                    setTimeout(() => row.classList.remove('settings-user-row-role-flash'), 2000);
                  } else {
                    pinFeedback.textContent = errBody.error || 'Failed to update PIN';
                    pinFeedback.style.color = '#b91c1c';
                  }
                } catch (e) {
                  pinFeedback.textContent = 'Request failed';
                  pinFeedback.style.color = '#b91c1c';
                } finally {
                  pinSaving = false;
                  pinIn.disabled = false;
                  btn.textContent = 'Update PIN';
                  syncPinButton();
                }
              });
              pinRow.appendChild(pinIn);
              pinRow.appendChild(btn);
              pinCol.appendChild(pinRow);
              pinCol.appendChild(pinFeedback);
              row.appendChild(label);
              row.appendChild(roleCol);
              row.appendChild(pinCol);
              const complCol = document.createElement('div');
              complCol.className = 'settings-user-row-role-col';
              complCol.style.marginLeft = '8px';
              const complWrap = document.createElement('label');
              complWrap.style.display = 'flex';
              complWrap.style.alignItems = 'center';
              complWrap.style.gap = '6px';
              complWrap.style.fontSize = '13px';
              const complChk = document.createElement('input');
              complChk.type = 'checkbox';
              complChk.checked = u.complimentsEnabled !== false;
              const complFeedback = document.createElement('div');
              complFeedback.className = 'settings-user-row-role-feedback';
              complFeedback.setAttribute('aria-live', 'polite');
              let complimentsSaving = false;
              complChk.addEventListener('change', async () => {
                if (complimentsSaving) return;
                const desired = complChk.checked;
                complimentsSaving = true;
                complChk.disabled = true;
                complFeedback.textContent = '';
                try {
                  const rr = await fetch('/settings/household/users/' + u.id + '/compliments', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ complimentsEnabled: desired }),
                  });
                  const errBody = await rr.json().catch(() => ({}));
                  if (rr.ok) {
                    complFeedback.textContent = desired ? 'Compliments enabled' : 'Compliments disabled';
                    complFeedback.style.color = 'var(--accent-strong)';
                    row.classList.add('settings-user-row-role-flash');
                    setTimeout(() => row.classList.remove('settings-user-row-role-flash'), 2000);
                  } else {
                    complChk.checked = !desired;
                    complFeedback.textContent = errBody.error || 'Failed to update compliments';
                    complFeedback.style.color = '#b91c1c';
                  }
                } catch (e) {
                  complChk.checked = !desired;
                  complFeedback.textContent = 'Request failed';
                  complFeedback.style.color = '#b91c1c';
                } finally {
                  complimentsSaving = false;
                  complChk.disabled = false;
                }
              });
              const complLbl = document.createElement('span');
              complLbl.textContent = 'Compliments';
              complWrap.appendChild(complChk);
              complWrap.appendChild(complLbl);
              complCol.appendChild(complWrap);
              complCol.appendChild(complFeedback);
              row.appendChild(complCol);
              const colorCol = document.createElement('div');
              colorCol.className = 'settings-user-row-role-col';
              const colorWrap = document.createElement('div');
              colorWrap.style.display = 'flex';
              colorWrap.style.alignItems = 'center';
              colorWrap.style.flexWrap = 'wrap';
              colorWrap.style.gap = '6px';
              const colorLbl = document.createElement('span');
              colorLbl.textContent = 'Chat color';
              colorLbl.style.fontSize = '13px';
              colorLbl.style.color = 'var(--text-soft)';
              const colorSel = document.createElement('select');
              colorSel.setAttribute('aria-label', 'Chat color for ' + u.displayName);
              CHAT_COLOR_OPTIONS.forEach((opt) => {
                const o = document.createElement('option');
                o.value = opt.key;
                o.textContent = opt.label;
                colorSel.appendChild(o);
              });
              colorSel.value = u.chatColor || 'blue';
              let prevChatColor = colorSel.value;
              const colorFeedback = document.createElement('div');
              colorFeedback.className = 'settings-user-row-role-feedback';
              colorFeedback.setAttribute('aria-live', 'polite');
              let chatColorSaving = false;
              colorSel.addEventListener('change', async () => {
                if (chatColorSaving) return;
                const attempted = colorSel.value;
                chatColorSaving = true;
                colorSel.disabled = true;
                colorFeedback.textContent = 'Saving...';
                colorFeedback.style.color = 'var(--text-soft)';
                try {
                  const rr = await fetch('/settings/household/users/' + u.id + '/chat-color', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chatColor: attempted }),
                  });
                  const errBody = await rr.json().catch(() => ({}));
                  if (rr.ok) {
                    displayNameToColor[normalizeDisplayNameKey(u.displayName)] = attempted;
                    prevChatColor = attempted;
                    colorSel.value = attempted;
                    colorFeedback.textContent = 'Chat color updated';
                    colorFeedback.style.color = 'var(--accent-strong)';
                    row.classList.add('settings-user-row-role-flash');
                    setTimeout(() => row.classList.remove('settings-user-row-role-flash'), 2000);
                    if (currentChatId) await loadHistory();
                  } else {
                    colorSel.value = prevChatColor;
                    colorFeedback.textContent = errBody.error || 'Failed to update chat color';
                    colorFeedback.style.color = '#b91c1c';
                  }
                } catch (e) {
                  colorSel.value = prevChatColor;
                  colorFeedback.textContent = 'Request failed';
                  colorFeedback.style.color = '#b91c1c';
                } finally {
                  chatColorSaving = false;
                  colorSel.disabled = false;
                }
              });
              colorWrap.appendChild(colorLbl);
              colorWrap.appendChild(colorSel);
              colorCol.appendChild(colorWrap);
              colorCol.appendChild(colorFeedback);
              row.appendChild(colorCol);
              listEl.appendChild(row);
            }
            if (msgEl) msgEl.textContent = '';
            await loadHouseholdMemoriesEditor();
          } catch (e) {
            if (msgEl) msgEl.textContent = 'Load failed.';
          }
        }

        async function loadSettingsPanel() {
          await loadMyHouseholdView();
          const isGa = await loadAnthropicSection();
          const subAdminBtn = document.getElementById('settings-subtab-admin-btn');
          if (subAdminBtn) subAdminBtn.style.display = isGa ? 'inline-block' : 'none';
          if (!isGa) {
            currentSettingsSubView = 'my';
          }
          if (isGa) {
            await loadGlobalAdminView();
          }
          showSettingsSubView(currentSettingsSubView);
          if (lastMePayload) applyGodModeFromMe(lastMePayload);
        }

        function loadGlobalAdminView() {
          return refreshAdminHouseholdsList();
        }

        function showSettingsSubView(view) {
          const myV = document.getElementById('settings-view-my');
          const adminV = document.getElementById('settings-view-admin');
          const myBtn = document.getElementById('settings-subtab-my-btn');
          const adminBtn = document.getElementById('settings-subtab-admin-btn');
          if (view === 'admin' && adminBtn && adminBtn.style.display === 'none') {
            view = 'my';
          }
          currentSettingsSubView = view;
          if (view === 'admin') {
            if (myV) myV.style.display = 'none';
            if (adminV) adminV.style.display = 'block';
            if (myBtn) myBtn.classList.remove('settings-subtab-active');
            if (adminBtn) adminBtn.classList.add('settings-subtab-active');
          } else {
            if (myV) myV.style.display = 'block';
            if (adminV) adminV.style.display = 'none';
            if (myBtn) myBtn.classList.add('settings-subtab-active');
            if (adminBtn) adminBtn.classList.remove('settings-subtab-active');
          }
        }

        function updateAdminAnthropicFormVisibility() {
          const sharedRadio = document.getElementById('admin-anthropic-mode-shared');
          const help = document.getElementById('admin-anthropic-shared-help');
          const isShared = sharedRadio && sharedRadio.checked;
          if (help) help.style.display = isShared ? 'block' : 'none';
        }

        function renderAdminHouseholdDetail(detailData) {
          const hh = detailData && detailData.household;
          if (!hh) return;
          const usage = detailData.usage;
          const nameEl = document.getElementById('admin-detail-name');
          const keyEl = document.getElementById('admin-detail-key');
          const tbody = document.getElementById('admin-detail-users-body');
          const banner = document.getElementById('admin-editing-banner');
          const usageEl = document.getElementById('admin-detail-usage');
          const pinGlobalMsg = document.getElementById('admin-pin-global-msg');
          if (pinGlobalMsg) pinGlobalMsg.textContent = '';
          if (nameEl) nameEl.textContent = hh.name;
          if (keyEl) keyEl.textContent = hh.householdKey;
          if (banner) {
            banner.textContent =
              'Editing: #' + hh.id + ' — ' + hh.name + ' (household key: ' + hh.householdKey + ')';
          }
          if (usageEl) {
            if (usage) {
              let html =
                '<strong>Message usage (stored messages)</strong><br />' +
                'Total messages (this household): ' +
                (usage.totalMessages != null ? usage.totalMessages : 0) +
                '<br />';
              html +=
                'Latest message: ' +
                (usage.latestMessageAt ? String(usage.latestMessageAt) : '—') +
                '<br />';
              html += '<strong style="display:inline-block;margin-top:6px;">User messages by name</strong> (role=user rows):';
              const rows = usage.messagesByUser || [];
              if (rows.length === 0) {
                html += '<div style="margin-top:4px;color:var(--text-soft);">No user messages yet.</div>';
              } else {
                html += '<ul style="margin:4px 0 0;padding-left:18px;">';
                for (const row of rows) {
                  html +=
                    '<li>' +
                    (row.displayName || '—') +
                    ': ' +
                    (row.count != null ? row.count : 0) +
                    '</li>';
                }
                html += '</ul>';
              }
              usageEl.innerHTML = html;
            } else {
              usageEl.innerHTML = '';
            }
          }
          if (tbody) {
            tbody.innerHTML = '';
            for (const u of hh.users || []) {
              const tr = document.createElement('tr');
              const td1 = document.createElement('td');
              td1.style.padding = '4px 4px 4px 0';
              td1.textContent = u.displayName;
              const td2 = document.createElement('td');
              td2.style.padding = '4px';
              td2.textContent = u.role;
              const td3 = document.createElement('td');
              td3.style.padding = '4px';
              const pinIn = document.createElement('input');
              pinIn.type = 'password';
              pinIn.placeholder = 'new PIN';
              pinIn.autocomplete = 'new-password';
              pinIn.style.maxWidth = '120px';
              pinIn.style.padding = '4px 6px';
              pinIn.disabled = godModeReadOnly;
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.textContent = 'Set PIN';
              btn.style.marginLeft = '6px';
              btn.disabled = godModeReadOnly;
              btn.addEventListener('click', async () => {
                const pin = pinIn.value.trim();
                if (!pin) {
                  if (pinGlobalMsg) pinGlobalMsg.textContent = 'Enter a PIN for ' + u.displayName + '.';
                  return;
                }
                const rr = await fetch(
                  '/admin/households/' + encodeURIComponent(hh.id) + '/users/' + encodeURIComponent(u.id) + '/pin',
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pin }),
                  }
                );
                const errBody = await rr.json().catch(() => ({}));
                if (pinGlobalMsg) {
                  pinGlobalMsg.textContent = rr.ok
                    ? 'PIN updated for #' + hh.id + ' — ' + hh.name + ' / user "' + u.displayName + '" (id ' + u.id + ').'
                    : errBody.error || 'Failed to update PIN.';
                }
                if (rr.ok) pinIn.value = '';
              });
              td3.appendChild(pinIn);
              td3.appendChild(btn);
              const td4 = document.createElement('td');
              td4.style.padding = '4px';
              if (!godModeReadOnly) {
                const viewAsBtn = document.createElement('button');
                viewAsBtn.type = 'button';
                viewAsBtn.textContent = 'View as';
                viewAsBtn.style.padding = '4px 8px';
                viewAsBtn.addEventListener('click', async () => {
                  try {
                    const rr = await fetch('/admin/impersonate', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ householdId: hh.id, userId: u.id }),
                    });
                    const errBody = await rr.json().catch(() => ({}));
                    if (!rr.ok) {
                      if (pinGlobalMsg) {
                        pinGlobalMsg.textContent = errBody.error || 'Could not start God Mode.';
                      }
                      return;
                    }
                    location.reload();
                  } catch (e) {
                    if (pinGlobalMsg) pinGlobalMsg.textContent = 'Request failed.';
                  }
                });
                td4.appendChild(viewAsBtn);
              } else {
                td4.textContent = '—';
              }
              tr.appendChild(td1);
              tr.appendChild(td2);
              tr.appendChild(td3);
              tr.appendChild(td4);
              tbody.appendChild(tr);
            }
          }
        }

        async function loadAdminAnthropicForSelected() {
          const sel = document.getElementById('admin-anthropic-household-select');
          const hid = sel && sel.value ? Number(sel.value) : NaN;
          const sharedRadio = document.getElementById('admin-anthropic-mode-shared');
          const hhRadio = document.getElementById('admin-anthropic-mode-household');
          const statEl = document.getElementById('admin-anthropic-selected-status');
          const msgEl = document.getElementById('admin-anthropic-msg');
          if (!sharedRadio || !hhRadio || !Number.isFinite(hid)) return;
          try {
            const rDetail = await fetch('/admin/households/' + encodeURIComponent(hid));
            if (rDetail.ok) {
              const detailData = await rDetail.json();
              if (detailData.household) {
                renderAdminHouseholdDetail(detailData);
                if (cachedAdminHouseholds) {
                  const ix = cachedAdminHouseholds.findIndex((h) => h.id === hid);
                  if (ix >= 0) cachedAdminHouseholds[ix] = detailData.household;
                }
              }
            }
            const r = await fetch('/settings/anthropic?householdId=' + encodeURIComponent(hid));
            if (!r.ok) return;
            const d = await r.json();
            if (d.household.anthropicKeyMode === 'household') {
              hhRadio.checked = true;
            } else {
              sharedRadio.checked = true;
            }
            const webCb = document.getElementById('admin-web-search-enabled');
            if (webCb) {
              webCb.checked = !!d.household.webSearchEnabled;
              webCb.disabled = godModeReadOnly;
            }
            const webSaveBtn = document.getElementById('admin-web-search-save');
            if (webSaveBtn) webSaveBtn.disabled = godModeReadOnly;
            if (statEl) {
              statEl.textContent =
                'Anthropic: ' +
                (d.statusBrief || d.statusText || '') +
                ' · Web search: ' +
                (d.household.webSearchEnabled ? 'on' : 'off');
            }
            updateAdminAnthropicFormVisibility();
            if (msgEl) msgEl.textContent = '';
            const webMsg = document.getElementById('admin-web-search-msg');
            if (webMsg) webMsg.textContent = '';
          } catch (e) {}
        }

        async function refreshAdminHouseholdsList() {
          const listEl = document.getElementById('settings-admin-households-list');
          const sel = document.getElementById('admin-anthropic-household-select');
          if (!listEl && !sel) return;
          try {
            const r = await fetch('/admin/households');
            if (!r.ok) return;
            const data = await r.json();
            const households = data.households || [];
            cachedAdminHouseholds = households;
            const prevSel = sel && sel.value;
            if (listEl) {
              listEl.innerHTML = '';
              for (const hh of households) {
                const row = document.createElement('div');
                row.style.marginBottom = '6px';
                const n =
                  hh.totalMessages != null && Number.isFinite(Number(hh.totalMessages))
                    ? Number(hh.totalMessages)
                    : 0;
                const msgLabel = n === 1 ? 'msg' : 'msgs';
                row.textContent =
                  '#' +
                  hh.id +
                  ' · ' +
                  hh.name +
                  ' · key ' +
                  hh.householdKey +
                  ' · ' +
                  n +
                  ' ' +
                  msgLabel +
                  ' · ' +
                  hh.anthropicStatusLabel +
                  (hh.webSearchEnabled ? ' · web search on' : '');
                listEl.appendChild(row);
              }
            }
            if (sel) {
              sel.innerHTML = '';
              for (const hh of households) {
                const opt = document.createElement('option');
                opt.value = String(hh.id);
                opt.textContent = '#' + hh.id + ' — ' + hh.name;
                sel.appendChild(opt);
              }
              if (prevSel && households.some((h) => String(h.id) === prevSel)) {
                sel.value = prevSel;
              } else if (households.length) {
                sel.selectedIndex = 0;
              }
              await loadAdminAnthropicForSelected();
            }
          } catch (e) {}
        }

        async function loadAnthropicSection() {
          const statusEl = document.getElementById('settings-anthropic-status');
          const ownerSection = document.getElementById('settings-anthropic-owner-key-section');
          const ownerKeyInput = document.getElementById('settings-anthropic-owner-key');
          const ownerMsg = document.getElementById('settings-anthropic-owner-key-msg');
          try {
            const r = await fetch('/settings/anthropic');
            if (!r.ok) return false;
            const d = await r.json();
            if (statusEl) {
              statusEl.textContent = d.statusText || '';
            }
            if (ownerSection && ownerKeyInput) {
              if (d.canEditKey) {
                ownerSection.style.display = 'block';
                ownerKeyInput.value = '';
              } else {
                ownerSection.style.display = 'none';
                ownerKeyInput.value = '';
              }
              if (ownerMsg) ownerMsg.textContent = '';
            }
            return !!d.isGlobalAdmin;
          } catch (e) {
            return false;
          }
        }

        async function refreshOwnerSettingsTab() {
          if (!tabSettings) return;
          try {
            const r = await fetch('/settings/household');
            tabSettings.style.display = r.ok ? '' : 'none';
          } catch (e) {
            tabSettings.style.display = 'none';
          }
        }

        function sendTyping(isTyping) {
          if (godModeReadOnly) return;
          if (!typingWs || typingWs.readyState !== 1 || !currentChatId) return;
          if (currentHouseholdId == null || !Number.isFinite(Number(currentHouseholdId))) return;
          typingWs.send(
            JSON.stringify({
              type: isTyping ? 'typing' : 'stopped_typing',
              householdId: currentHouseholdId,
              chatId: currentChatId,
            })
          );
        }

        function resizePromptInput() {
          if (!promptInput) return;
          const cs = getComputedStyle(promptInput);
          const lh = parseFloat(cs.lineHeight);
          const lineHeight = Number.isFinite(lh) ? lh : 14 * 1.4;
          const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
          const maxLines = 5;
          const maxHeight = Math.ceil(lineHeight * maxLines + padY);
          promptInput.style.height = 'auto';
          const sh = promptInput.scrollHeight;
          const h = Math.min(sh, maxHeight);
          promptInput.style.height = h + 'px';
          promptInput.style.maxHeight = maxHeight + 'px';
          promptInput.style.overflowY = sh > maxHeight ? 'auto' : 'hidden';
        }

        promptInput.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') return;
          if (useMobileEnterBehavior) return;
          if (event.shiftKey) return;
          event.preventDefault();
          sendButton.click();
        });

        promptInput.addEventListener('input', () => {
          resizePromptInput();
          if (godModeReadOnly) return;
          if (!currentChatId) return;
          sendTyping(true);
          if (typingStopTimeout) clearTimeout(typingStopTimeout);
          typingStopTimeout = setTimeout(() => {
            typingStopTimeout = null;
            sendTyping(false);
          }, 2000);
        });
        resizePromptInput();

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
            div.classList.add(userMessageBubbleClass(name));
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

            for (const item of data.items || []) {
              const li = document.createElement('li');
              li.className = 'g-item' + (item.checked ? ' g-item-checked' : '');
              li.dataset.id = item.id;
              li.dataset.section = item.section;

              const left = document.createElement('div');
              left.className = 'g-left';

              const checkbox = document.createElement('input');
              checkbox.type = 'checkbox';
              checkbox.checked = !!item.checked;
              checkbox.disabled = godModeReadOnly;
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

              const del = document.createElement('button');
              del.className = 'g-delete';
              del.textContent = '×';
              del.disabled = godModeReadOnly;
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

              const targetList = groceryLists[item.section] || groceryLists.other;
              targetList.appendChild(li);
            }

            groceryClearButton.style.display = isCurrentUserOwner ? '' : 'none';
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

            if (isCurrentUserOwner && !godModeReadOnly) {
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
                  try {
                    await refreshAdminHouseholdsList();
                  } catch (e) {}
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
            if (godModeReadOnly) {
              currentChatId = null;
              chat.innerHTML = '';
              renderChats();
              return;
            }
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
            const bs = await fetch('/bootstrap/status');
            if (!bs.ok) {
              loginArea.style.display = 'block';
              appArea.style.display = 'none';
              headerEl.classList.add('hide-tabs');
              showLoginFormOnly();
              return;
            }
            const bsData = await bs.json();
            if (bsData.needsBootstrap) {
              loginArea.style.display = 'block';
              appArea.style.display = 'none';
              headerEl.classList.add('hide-tabs');
              if (bsData.allowPublicBootstrap === false) {
                showBootstrapBlocked();
              } else {
                showBootstrapForm();
              }
              return;
            }

            showLoginFormOnly();
            const response = await fetch('/me');
            if (!response.ok) {
              showLogin();
              return;
            }

            const data = await response.json();
            currentUserName = data.name;
            currentHouseholdId = data.householdId != null ? Number(data.householdId) : null;
            currentUserId = data.userId != null ? Number(data.userId) : null;
            isCurrentUserOwner = !!data.isOwner;
            applyGodModeFromMe(data);
            syncMemoriesWrapVisibility();
            rebuildDisplayNameToColorFromMeChatColors(data.chatColors);
            showApp(data.name);
            await loadChatsAndEnsureOne();
            await loadHistory();
            connectTypingWs();
            refreshOwnerSettingsTab();
          } catch (error) {
            showLogin();
          }
        }

        tabChat.addEventListener('click', () => {
          setActiveTab('chat');
        });

        tabGroceries.addEventListener('click', async () => {
          setActiveTab('groceries');
          await loadGroceries();
        });

        if (tabSettings) {
          tabSettings.addEventListener('click', () => {
            setActiveTab('settings');
          });
        }

        const settingsAddSubmit = document.getElementById('settings-add-submit');
        const adminAnthropicShared = document.getElementById('admin-anthropic-mode-shared');
        const adminAnthropicHousehold = document.getElementById('admin-anthropic-mode-household');
        const adminAnthropicHouseholdSelect = document.getElementById('admin-anthropic-household-select');
        if (adminAnthropicShared) adminAnthropicShared.addEventListener('change', updateAdminAnthropicFormVisibility);
        if (adminAnthropicHousehold) adminAnthropicHousehold.addEventListener('change', updateAdminAnthropicFormVisibility);
        if (adminAnthropicHouseholdSelect) {
          adminAnthropicHouseholdSelect.addEventListener('change', () => {
            loadAdminAnthropicForSelected();
          });
        }

        const adminAnthropicModeSave = document.getElementById('admin-anthropic-mode-save');
        if (adminAnthropicModeSave) {
          adminAnthropicModeSave.addEventListener('click', async () => {
            const sel = document.getElementById('admin-anthropic-household-select');
            const hid = sel && sel.value ? Number(sel.value) : NaN;
            const msgEl = document.getElementById('admin-anthropic-msg');
            if (!Number.isFinite(hid)) {
              if (msgEl) msgEl.textContent = 'Select a household.';
              return;
            }
            const shared = document.getElementById('admin-anthropic-mode-shared');
            const mode = shared && shared.checked ? 'shared' : 'household';
            try {
              const r = await fetch('/settings/anthropic/mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ householdId: hid, anthropicKeyMode: mode }),
              });
              const errBody = await r.json().catch(() => ({}));
              if (!r.ok) {
                if (msgEl) msgEl.textContent = errBody.error || 'Save failed';
                return;
              }
              if (msgEl) msgEl.textContent = 'Mode saved.';
              await loadGlobalAdminView();
            } catch (e) {
              if (msgEl) msgEl.textContent = 'Request failed.';
            }
          });
        }

        const adminWebSearchSave = document.getElementById('admin-web-search-save');
        if (adminWebSearchSave) {
          adminWebSearchSave.addEventListener('click', async () => {
            const sel = document.getElementById('admin-anthropic-household-select');
            const hid = sel && sel.value ? Number(sel.value) : NaN;
            const msgEl = document.getElementById('admin-web-search-msg');
            const cb = document.getElementById('admin-web-search-enabled');
            if (!Number.isFinite(hid)) {
              if (msgEl) msgEl.textContent = 'Select a household.';
              return;
            }
            try {
              const r = await fetch('/settings/anthropic/web-search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ householdId: hid, webSearchEnabled: !!(cb && cb.checked) }),
              });
              const errBody = await r.json().catch(() => ({}));
              if (!r.ok) {
                if (msgEl) msgEl.textContent = errBody.error || 'Save failed';
                return;
              }
              if (msgEl) msgEl.textContent = 'Saved.';
              await loadGlobalAdminView();
            } catch (e) {
              if (msgEl) msgEl.textContent = 'Request failed.';
            }
          });
        }

        const settingsAnthropicOwnerKeySave = document.getElementById('settings-anthropic-owner-key-save');
        if (settingsAnthropicOwnerKeySave) {
          settingsAnthropicOwnerKeySave.addEventListener('click', async () => {
            const keyInput = document.getElementById('settings-anthropic-owner-key');
            const msgEl = document.getElementById('settings-anthropic-owner-key-msg');
            const key = keyInput && keyInput.value.trim();
            if (!key) {
              if (msgEl) msgEl.textContent = 'Enter an API key.';
              return;
            }
            try {
              const r = await fetch('/settings/anthropic/key', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ anthropicApiKey: key }),
              });
              const errBody = await r.json().catch(() => ({}));
              if (!r.ok) {
                if (msgEl) msgEl.textContent = errBody.error || 'Save failed';
                return;
              }
              if (msgEl) msgEl.textContent = 'Key saved.';
              if (keyInput) keyInput.value = '';
              await loadMyHouseholdView();
              await loadAnthropicSection();
            } catch (e) {
              if (msgEl) msgEl.textContent = 'Request failed.';
            }
          });
        }

        const adminNewHhSubmit = document.getElementById('admin-new-hh-submit');
        if (adminNewHhSubmit) {
          adminNewHhSubmit.addEventListener('click', async () => {
            const householdName = document.getElementById('admin-new-hh-name').value.trim();
            const householdKey = document.getElementById('admin-new-hh-key').value.trim();
            const ownerDisplayName = document.getElementById('admin-new-owner-name').value.trim();
            const ownerPin = document.getElementById('admin-new-owner-pin').value;
            const msgEl = document.getElementById('admin-new-hh-msg');
            if (!householdName || !householdKey || !ownerDisplayName || !ownerPin) {
              if (msgEl) msgEl.textContent = 'All fields are required.';
              return;
            }
            if (msgEl) msgEl.textContent = 'Creating…';
            try {
              const r = await fetch('/admin/households', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ householdName, householdKey, ownerDisplayName, ownerPin }),
              });
              const data = await r.json().catch(() => ({}));
              if (!r.ok) {
                if (msgEl) msgEl.textContent = data.error || 'Failed';
                return;
              }
              if (msgEl) {
                msgEl.textContent =
                  'Created household #' + data.household.id + ' — owner user id ' + data.owner.id + '.';
              }
              document.getElementById('admin-new-hh-name').value = '';
              document.getElementById('admin-new-hh-key').value = '';
              document.getElementById('admin-new-owner-name').value = '';
              document.getElementById('admin-new-owner-pin').value = '';
              await loadGlobalAdminView();
            } catch (e) {
              if (msgEl) msgEl.textContent = 'Request failed.';
            }
          });
        }

        const settingsSubtabMyBtn = document.getElementById('settings-subtab-my-btn');
        const settingsSubtabAdminBtn = document.getElementById('settings-subtab-admin-btn');
        if (settingsSubtabMyBtn) {
          settingsSubtabMyBtn.addEventListener('click', () => {
            showSettingsSubView('my');
          });
        }
        if (settingsSubtabAdminBtn) {
          settingsSubtabAdminBtn.addEventListener('click', async () => {
            await loadGlobalAdminView();
            showSettingsSubView('admin');
          });
        }

        if (settingsAddSubmit) {
          settingsAddSubmit.addEventListener('click', async () => {
            const displayName = document.getElementById('settings-new-display').value.trim();
            const role = document.getElementById('settings-new-role').value;
            const pin = document.getElementById('settings-new-pin').value.trim();
            const msgEl = document.getElementById('my-settings-msg');
            if (!displayName || !pin) {
              if (msgEl) msgEl.textContent = 'Display name and PIN required.';
              return;
            }
            try {
              const r = await fetch('/settings/household/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ displayName, role, pin }),
              });
              const data = await r.json().catch(() => ({}));
              if (!r.ok) {
                if (msgEl) msgEl.textContent = data.error || 'Failed';
                return;
              }
              document.getElementById('settings-new-display').value = '';
              document.getElementById('settings-new-pin').value = '';
              if (msgEl) msgEl.textContent = 'User added.';
              displayNameToColor[normalizeDisplayNameKey(displayName)] = data.chatColor || 'blue';
              await loadMyHouseholdView();
              await loadAnthropicSection();
              const subBtn = document.getElementById('settings-subtab-admin-btn');
              if (subBtn && subBtn.style.display !== 'none') {
                await loadGlobalAdminView();
              }
            } catch (e) {
              if (msgEl) msgEl.textContent = 'Request failed.';
            }
          });
        }

        const settingsDemoViewBtn = document.getElementById('settings-demo-view-btn');
        if (settingsDemoViewBtn) {
          settingsDemoViewBtn.addEventListener('click', async () => {
            const msgEl = document.getElementById('settings-demo-view-msg');
            if (msgEl) msgEl.textContent = '';
            try {
              const r = await fetch('/demo/view', { method: 'POST' });
              const errBody = await r.json().catch(() => ({}));
              if (!r.ok) {
                if (msgEl) msgEl.textContent = errBody.error || 'Could not open demo view.';
                return;
              }
              location.reload();
            } catch (e) {
              if (msgEl) msgEl.textContent = 'Request failed.';
            }
          });
        }

        const memSaveBtn = document.getElementById('my-settings-memory-save');
        const memCancelBtn = document.getElementById('my-settings-memory-cancel-edit');
        if (memSaveBtn) {
          memSaveBtn.addEventListener('click', async () => {
            const keyIn = document.getElementById('my-settings-memory-key');
            const valIn = document.getElementById('my-settings-memory-value');
            const memMsg = document.getElementById('my-settings-memories-msg');
            const key =
              editingMemoryKey != null ? editingMemoryKey : keyIn && String(keyIn.value).trim();
            const value = valIn && String(valIn.value).trim();
            if (!key) {
              if (memMsg) memMsg.textContent = 'Key is required.';
              return;
            }
            if (!value) {
              if (memMsg) memMsg.textContent = 'Value is required.';
              return;
            }
            try {
              const r = await fetch('/settings/household/memories', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key, value }),
              });
              const errBody = await r.json().catch(() => ({}));
              if (memMsg) {
                memMsg.textContent = r.ok ? 'Saved.' : errBody.error || 'Save failed';
              }
              if (r.ok) {
                resetMemoryEditForm();
                await loadHouseholdMemoriesEditor();
              }
            } catch (e) {
              if (memMsg) memMsg.textContent = 'Request failed.';
            }
          });
        }
        if (memCancelBtn) {
          memCancelBtn.addEventListener('click', () => {
            const memMsg = document.getElementById('my-settings-memories-msg');
            resetMemoryEditForm();
            if (memMsg) memMsg.textContent = '';
          });
        }

        menuButton.addEventListener('click', async () => {
          try {
            const resp = await fetch('/chats');
            if (resp.ok) {
              const data = await resp.json();
              chatsCache = data.chats || [];
              renderChats();
            }
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

        let lastResolvedKey = null;
        let blurFindTimeout = null;

        function clearHouseholdLookup() {
          lastResolvedKey = null;
          const resolvedEl = document.getElementById('login-household-resolved');
          if (resolvedEl) resolvedEl.style.display = 'none';
          loginNameSelect.innerHTML = '';
          const ph = document.createElement('option');
          ph.value = '';
          ph.textContent = '— Select user —';
          ph.disabled = true;
          ph.selected = true;
          loginNameSelect.appendChild(ph);
          loginNameSelect.disabled = true;
          loginPasswordInput.value = '';
          loginButton.disabled = true;
          loginStatus.textContent = '';
        }

        function updateLoginEnabled() {
          const canTry =
            lastResolvedKey != null &&
            loginNameSelect.value &&
            loginPasswordInput.value.trim().length > 0;
          loginButton.disabled = !canTry;
        }

        async function findHousehold() {
          const key = loginHouseholdKeyInput.value.trim();
          if (!key) {
            loginStatus.textContent = 'Enter a household key.';
            clearHouseholdLookup();
            return;
          }
          loginStatus.textContent = 'Looking up…';
          try {
            const r = await fetch('/login/household?' + new URLSearchParams({ key }));
            if (r.status === 404) {
              clearHouseholdLookup();
              loginStatus.textContent = 'No household found for that key.';
              return;
            }
            if (!r.ok) {
              clearHouseholdLookup();
              loginStatus.textContent = 'Could not look up household.';
              return;
            }
            const data = await r.json();
            lastResolvedKey = data.household.key;
            const nameEl = document.getElementById('login-household-name');
            if (nameEl) nameEl.textContent = data.household.name;
            const resolvedEl = document.getElementById('login-household-resolved');
            if (resolvedEl) resolvedEl.style.display = 'block';
            loginNameSelect.innerHTML = '';
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = '— Select user —';
            placeholder.disabled = true;
            placeholder.selected = true;
            loginNameSelect.appendChild(placeholder);
            for (const u of data.users) {
              const opt = document.createElement('option');
              opt.value = u.displayName;
              opt.textContent = u.role ? (u.displayName + ' (' + u.role + ')') : u.displayName;
              loginNameSelect.appendChild(opt);
            }
            loginNameSelect.disabled = false;
            loginStatus.textContent = '';
            updateLoginEnabled();
          } catch (e) {
            clearHouseholdLookup();
            loginStatus.textContent = 'Lookup failed.';
          }
        }

        loginHouseholdKeyInput.addEventListener('input', () => {
          const v = loginHouseholdKeyInput.value.trim().toLowerCase();
          if (lastResolvedKey != null && v !== lastResolvedKey) {
            clearHouseholdLookup();
          }
        });

        loginHouseholdKeyInput.addEventListener('blur', () => {
          blurFindTimeout = setTimeout(() => {
            blurFindTimeout = null;
            if (loginHouseholdKeyInput.value.trim()) {
              findHousehold();
            }
          }, 250);
        });

        loginFindHouseholdButton.addEventListener('mousedown', (e) => {
          if (blurFindTimeout) {
            clearTimeout(blurFindTimeout);
            blurFindTimeout = null;
          }
        });

        loginFindHouseholdButton.addEventListener('click', () => {
          findHousehold();
        });

        loginNameSelect.addEventListener('change', updateLoginEnabled);
        loginPasswordInput.addEventListener('input', updateLoginEnabled);

        async function performLogin() {
          const householdKey = lastResolvedKey;
          const displayName = loginNameSelect.value;
          const pin = loginPasswordInput.value;

          if (!householdKey) {
            loginStatus.textContent = 'Find your household first.';
            return;
          }
          if (!displayName) {
            loginStatus.textContent = 'Select a user.';
            return;
          }
          if (!pin) {
            loginStatus.textContent = 'PIN is required.';
            return;
          }

          loginStatus.textContent = 'Logging in...';

          try {
            const response = await fetch('/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ householdKey, displayName, pin })
            });

            if (!response.ok) {
              loginStatus.textContent = 'Invalid user or PIN.';
              return;
            }

            let data = {};
            try {
              data = await response.json();
            } catch (e) {}

            loginPasswordInput.value = '';
            loginStatus.textContent = '';
            const resolvedName = data.displayName ?? data.name ?? displayName;
            currentUserName = resolvedName;
            currentHouseholdId = data.householdId != null ? Number(data.householdId) : null;
            currentUserId = data.userId != null ? Number(data.userId) : null;
            isCurrentUserOwner = !!data.isOwner;
            syncMemoriesWrapVisibility();
            showApp(resolvedName);
            try {
              const meR = await fetch('/me');
              if (meR.ok) {
                const meData = await meR.json();
                rebuildDisplayNameToColorFromMeChatColors(meData.chatColors);
                applyGodModeFromMe(meData);
              }
            } catch (e) {}
            await loadChatsAndEnsureOne();
            await loadHistory();
            connectTypingWs();
            refreshOwnerSettingsTab();
          } catch (error) {
            loginStatus.textContent = 'Login failed.';
          }
        }

        if (loginAuthForm) {
          loginAuthForm.addEventListener('submit', (e) => {
            e.preventDefault();
            if (loginButton.disabled) return;
            void performLogin();
          });
        }

        document.getElementById('bootstrap-submit').addEventListener('click', async () => {
          const householdName = document.getElementById('bootstrap-household-name').value.trim();
          const householdKey = document.getElementById('bootstrap-household-key').value.trim();
          const ownerDisplayName = document.getElementById('bootstrap-owner-display-name').value.trim();
          const pin = document.getElementById('bootstrap-pin').value;
          const bootstrapStatusEl = document.getElementById('bootstrap-status');
          if (!householdName || !householdKey || !ownerDisplayName || !pin) {
            bootstrapStatusEl.textContent = 'All fields are required.';
            return;
          }
          bootstrapStatusEl.textContent = 'Creating…';
          try {
            const r = await fetch('/bootstrap', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ householdName, householdKey, ownerDisplayName, pin }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) {
              bootstrapStatusEl.textContent = data.error || 'Bootstrap failed.';
              return;
            }
            document.getElementById('bootstrap-pin').value = '';
            bootstrapStatusEl.textContent = '';
            showLoginFormOnly();
            loginHouseholdKeyInput.value = data.householdKey || householdKey;
            await findHousehold();
          } catch (e) {
            bootstrapStatusEl.textContent = 'Something went wrong.';
          }
        });

        checkAuth();

        const godModeExitBtn = document.getElementById('god-mode-exit-btn');
        if (godModeExitBtn) {
          godModeExitBtn.addEventListener('click', async () => {
            try {
              const r = await fetch('/admin/impersonate/exit', { method: 'POST' });
              if (!r.ok) return;
              location.reload();
            } catch (e) {}
          });
        }

        sendButton.addEventListener('click', async () => {
          if (godModeReadOnly) return;
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
          resizePromptInput();
          weAreStreamingThisChat = true;

          const thinkingDiv = document.createElement('div');
          thinkingDiv.className = 'message assistant';
          const thinkingAuthor = document.createElement('span');
          thinkingAuthor.className = 'message-author';
          thinkingAuthor.textContent = 'KitchenBot';
          thinkingDiv.appendChild(thinkingAuthor);
          const thinkingBody = document.createElement('div');
          thinkingBody.className = 'message-body kb-thinking kb-thinking-anim';
          thinkingBody.textContent = 'Thinking…';
          thinkingDiv.appendChild(thinkingBody);
          chat.appendChild(thinkingDiv);
          chat.scrollTop = chat.scrollHeight;
          remoteStreamBodyEl = thinkingBody;

          try {
            const response = await fetch('/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ prompt, name: speaker, chatId: currentChatId })
            });

            if (!response.ok) {
              remoteStreamBodyEl = null;
              weAreStreamingThisChat = false;
              thinkingBody.classList.remove('kb-thinking', 'kb-thinking-anim');
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
              const errData = await response.json().catch(() => ({}));
              let replyText =
                errData.reply ||
                errData.error ||
                (response.status === 503 ? 'Service unavailable.' : 'Something went wrong.');
              if (
                typeof replyText === 'string' &&
                /^\s*\{/.test(replyText.trim()) &&
                replyText.includes('"type"')
              ) {
                replyText = 'Invalid or missing Anthropic key.';
              }
              thinkingBody.textContent = replyText;
              return;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            let fullReply = '';
            let firstStreamChunk = true;

            while (true) {
              const { value, done } = await reader.read();
              if (done) break;

              const chunk = decoder.decode(value, { stream: true });
              if (!chunk) continue;
              fullReply += chunk;
              if (firstStreamChunk) {
                thinkingBody.classList.remove('kb-thinking', 'kb-thinking-anim');
                thinkingBody.textContent = '';
                firstStreamChunk = false;
              }
              thinkingBody.appendChild(document.createTextNode(chunk));
              chat.scrollTop = chat.scrollHeight;
            }

            thinkingBody.classList.remove('kb-thinking', 'kb-thinking-anim');
            thinkingBody.textContent = '';
            thinkingBody.appendChild(renderMarkdown(fullReply));
            chat.scrollTop = chat.scrollHeight;
            remoteStreamBodyEl = null;
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
            remoteStreamBodyEl = null;
            weAreStreamingThisChat = false;
          }
        });

        logoutButton.addEventListener('click', async () => {
          try {
            await fetch('/logout', { method: 'POST' });
          } catch (e) {
            // ignore errors, just force login state
          }
          sidebar.classList.remove('open');
          sidebarBackdrop.classList.remove('open');
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
          currentHouseholdId = null;
          currentUserId = null;
          isCurrentUserOwner = false;
          lastMePayload = null;
          applyGodModeFromMe({ isImpersonating: false, impersonationReadOnly: false });
          syncMemoriesWrapVisibility();
          displayNameToColor = {};
          showLogin();
          chat.innerHTML = '';
        });

        groceryRefreshButton.addEventListener('click', async () => {
          await loadGroceries();
        });

        if (groceryAddSubmit) {
          groceryAddSubmit.addEventListener('click', async () => {
            const name = groceryAddName && groceryAddName.value.trim();
            if (!name) return;
            const amount = groceryAddAmount && groceryAddAmount.value.trim();
            const section =
              groceryAddSection && groceryAddSection.value ? groceryAddSection.value : 'other';
            try {
              const r = await fetch('/groceries', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  items: [{ name, section, amount: amount || '' }],
                }),
              });
              if (!r.ok) return;
              if (groceryAddAmount) groceryAddAmount.value = '';
              if (groceryAddName) groceryAddName.value = '';
              await loadGroceries();
              if (groceryAddName) groceryAddName.focus();
            } catch (e) {}
          });
        }

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
    if (await needsBootstrap()) {
      return res.status(503).json({ error: 'bootstrap_required' });
    }

    const householdKeyRaw = req.body.householdKey;
    const pinDisplayName = req.body.displayName?.trim();
    const pin = req.body.pin?.trim();
    if (householdKeyRaw == null || String(householdKeyRaw).trim() === '' || !pinDisplayName || !pin) {
      return res.status(400).json({ error: 'householdKey, displayName, and pin are required.' });
    }
    const household = await getHouseholdByKey(householdKeyRaw);
    if (!household) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    const user = await getUserByHouseholdAndDisplayName(household.id, pinDisplayName);
    if (!user || !user.pin_hash || !verifyPin(pin, user.pin_hash)) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    const token = signToken({
      householdId: user.household_id,
      userId: user.id,
      displayName: user.display_name,
      sessionVersion: user.session_version != null ? Math.trunc(Number(user.session_version)) : 0,
    });
    setAuthCookie(res, token);
    return res.json({
      householdId: user.household_id,
      householdKey: household.household_key,
      userId: user.id,
      displayName: user.display_name,
      isOwner: user.role === 'owner',
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.get('/me', requireHousehold, requireAuth, async (req, res) => {
  try {
    const users = await listHouseholdUsers(req.householdId);
    const chatColors = {};
    for (const u of users) {
      chatColors[u.display_name] = normalizeChatColor(u.chat_color);
    }
    const me = await getHouseholdUserById(req.householdId, req.userId);
    const h = await getHouseholdById(req.householdId);
    const householdName = h ? h.name : '';
    const globalAdminCheckId =
      req.isImpersonating && req.adminUserId != null ? req.adminUserId : req.userId;
    const isGlobalAdmin = await isGlobalAdminUser(globalAdminCheckId);
    return res.json({
      name: req.user,
      chatColors,
      householdId: req.householdId,
      userId: req.userId,
      isOwner: !!(me && me.role === 'owner'),
      householdName,
      isGlobalAdmin,
      isImpersonating: !!req.isImpersonating,
      impersonationReadOnly: !!req.impersonationReadOnly,
      ...(req.isImpersonating
        ? {
            adminDisplayName: req.adminDisplayName,
            realUserId: req.adminUserId,
            realHouseholdId: req.adminHouseholdId,
          }
        : {
            realUserId: req.userId,
            realHouseholdId: req.householdId,
          }),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

const SETTINGS_ROLES = new Set(['owner', 'member']);

app.get('/settings/household', requireHousehold, requireAuth, requireOwner, async (req, res) => {
  try {
    const h = await getHouseholdById(req.householdId);
    if (!h) {
      return res.status(404).json({ error: 'Household not found' });
    }
    const currentUser = await getHouseholdUserById(req.householdId, req.userId);
    if (!currentUser) {
      return res.status(404).json({ error: 'User not found' });
    }
    const users = await listHouseholdUsers(req.householdId);
    return res.json({
      household: {
        id: h.id,
        name: h.name,
        key: h.household_key,
      },
      currentUser: {
        id: currentUser.id,
        displayName: currentUser.display_name,
        role: currentUser.role,
      },
      users: users.map((u) => ({
        id: u.id,
        displayName: u.display_name,
        role: u.role,
        chatColor: normalizeChatColor(u.chat_color),
        complimentsEnabled:
          u.compliments_enabled === null || u.compliments_enabled === undefined
            ? true
            : Number(u.compliments_enabled) === 1,
      })),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.get('/settings/household/memories', requireHousehold, requireAuth, requireOwner, async (req, res) => {
  try {
    const rows = (await getMemories(req.householdId)).filter((r) => r.key !== 'assistant_name');
    res.json({
      memories: rows.map((r) => ({ key: r.key, value: r.value })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load memories' });
  }
});

app.post(
  '/settings/household/memories',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
  requireOwner,
  async (req, res) => {
  try {
    const key = req.body.key != null ? String(req.body.key).trim() : '';
    const value = req.body.value != null ? String(req.body.value).trim() : '';
    if (!key) {
      return res.status(400).json({ error: 'Key is required' });
    }
    if (!value) {
      return res.status(400).json({ error: 'Value is required' });
    }
    if (key === 'assistant_name') {
      return res.status(403).json({ error: 'assistant_name is a system memory and cannot be modified' });
    }
    await upsertMemory(req.householdId, key, value);
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to save memory' });
  }
});

app.delete(
  '/settings/household/memories/:key',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
  requireOwner,
  async (req, res) => {
  try {
    const key = String(req.params.key ?? '').trim();
    if (!key) {
      return res.status(400).json({ error: 'Invalid key' });
    }
    if (key === 'assistant_name') {
      return res.status(403).json({ error: 'assistant_name is a system memory and cannot be modified' });
    }
    await deleteMemory(req.householdId, key);
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to delete memory' });
  }
});

app.post(
  '/settings/household/users/:id/chat-color',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
  requireOwner,
  async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    const raw = req.body.chatColor;
    if (raw == null || String(raw).trim() === '') {
      return res.status(400).json({ error: 'chatColor is required' });
    }
    const target = await getHouseholdUserById(req.householdId, userId);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }
    const normalized = await updateHouseholdUserChatColor(req.householdId, userId, raw);
    return res.json({ ok: true, chatColor: normalized });
  } catch (e) {
    if (e && e.message === 'invalid_chat_color') {
      return res.status(400).json({
        error: 'Invalid chatColor. Use one of: pink, blue, mint, lavender, peach.',
      });
    }
    if (e && e.message === 'User not found') {
      return res.status(404).json({ error: 'User not found' });
    }
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed to update chat color' });
  }
});

app.post(
  '/settings/household/users/:id/compliments',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
  requireOwner,
  async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    if (typeof req.body.complimentsEnabled !== 'boolean') {
      return res.status(400).json({ error: 'complimentsEnabled (boolean) is required' });
    }
    const target = await getHouseholdUserById(req.householdId, userId);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }
    await updateHouseholdUserComplimentsEnabled(req.householdId, userId, req.body.complimentsEnabled);
    return res.json({ ok: true, complimentsEnabled: req.body.complimentsEnabled });
  } catch (e) {
    if (e && e.message === 'User not found') {
      return res.status(404).json({ error: 'User not found' });
    }
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed to update' });
  }
});

app.post(
  '/settings/household/users',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
  requireOwner,
  async (req, res) => {
  try {
    const displayName = req.body.displayName?.trim();
    const role = req.body.role?.trim();
    const pin = req.body.pin?.trim();
    if (!displayName || !role || !pin) {
      return res.status(400).json({ error: 'displayName, role, and pin are required' });
    }
    if (!SETTINGS_ROLES.has(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    const existing = await getUserByHouseholdAndDisplayName(req.householdId, displayName);
    if (existing) {
      return res.status(409).json({ error: 'A user with this display name already exists' });
    }
    const id = await createHouseholdUser(req.householdId, { displayName, role, pin });
    const created = await getHouseholdUserById(req.householdId, id);
    return res.json({
      id,
      displayName,
      role,
      chatColor: created ? normalizeChatColor(created.chat_color) : 'blue',
    });
  } catch (e) {
    if (e && e.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ error: 'A user with this display name already exists' });
    }
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed to create user' });
  }
});

app.post(
  '/settings/household/users/:id/pin',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
  requireOwner,
  async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    const pin = req.body.pin?.trim();
    if (!pin) {
      return res.status(400).json({ error: 'pin is required' });
    }
    const target = await getHouseholdUserById(req.householdId, userId);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }
    await updateHouseholdUserPin(req.householdId, userId, pin);
    return res.json({ ok: true });
  } catch (e) {
    if (e && e.message === 'User not found') {
      return res.status(404).json({ error: 'User not found' });
    }
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed to update PIN' });
  }
});

app.post(
  '/settings/household/users/:userId/role',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
  requireOwner,
  async (req, res) => {
  try {
    const targetUserId = Number(req.params.userId);
    if (!Number.isFinite(targetUserId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    if (targetUserId === req.userId) {
      return res.status(400).json({ error: 'Cannot change your own role' });
    }
    const role = req.body.role;
    if (role !== 'owner' && role !== 'member') {
      return res.status(400).json({ error: 'role must be owner or member' });
    }
    const target = await getHouseholdUserById(req.householdId, targetUserId);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (target.role === 'owner' && role === 'member') {
      const householdUsers = await listHouseholdUsers(req.householdId);
      const ownerCount = householdUsers.filter((u) => u.role === 'owner').length;
      if (ownerCount <= 1) {
        return res.status(400).json({ error: 'Cannot remove the last owner from the household' });
      }
    }
    await updateHouseholdUserRole(req.householdId, targetUserId, role);
    return res.json({ ok: true, userId: targetUserId, role });
  } catch (e) {
    if (e && e.message === 'User not found') {
      return res.status(404).json({ error: 'User not found' });
    }
    if (e && e.message === 'invalid_role') {
      return res.status(400).json({ error: 'role must be owner or member' });
    }
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed to update role' });
  }
});

const ANTHROPIC_MODES = new Set(['shared', 'household']);

app.get('/settings/anthropic', requireHousehold, requireAuth, async (req, res) => {
  try {
    const targetId = await resolveAnthropicTargetHouseholdId(req, res, req.query.householdId);
    if (targetId == null) return;
    const globalAdmin = await isRequestGlobalAdmin(req);
    const sessionUser = await getHouseholdUserById(req.householdId, req.userId);
    const isOwnerSession = sessionUser && sessionUser.role === 'owner';
    if (targetId === req.householdId) {
      if (!isOwnerSession && !globalAdmin) {
        return res.status(403).json({ error: 'Owner only' });
      }
    } else if (!globalAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const h = await getHouseholdById(targetId);
    if (!h) {
      return res.status(404).json({ error: 'Household not found' });
    }
    const mode = h.anthropic_key_mode || 'shared';
    const hasKey = !!(h.anthropic_api_key && String(h.anthropic_api_key).trim());
    let statusText;
    let statusBrief;
    let keyStatus;
    if (mode === 'shared') {
      statusText = "This household is using Rob's Anthropic key.";
      statusBrief = 'Using shared key';
      keyStatus = 'shared';
    } else if (hasKey) {
      statusText = 'Household key configured.';
      statusBrief = 'Household key configured';
      keyStatus = 'household_configured';
    } else {
      statusText = 'Household key missing.';
      statusBrief = 'Household key missing';
      keyStatus = 'household_missing';
    }
    const canEditKey =
      isOwnerSession && targetId === req.householdId && mode === 'household';
    return res.json({
      household: {
        id: h.id,
        name: h.name,
        key: h.household_key,
        anthropicKeyMode: mode,
        webSearchEnabled: Number(h.web_search_enabled) === 1,
      },
      usingSharedKey: mode === 'shared',
      hasHouseholdKey: hasKey,
      statusText,
      statusBrief,
      keyStatus,
      isGlobalAdmin: globalAdmin,
      canEditKey,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post(
  '/settings/anthropic/mode',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
  requireGlobalAdmin,
  async (req, res) => {
  try {
    const householdId = Number(req.body.householdId);
    if (!Number.isFinite(householdId)) {
      return res.status(400).json({ error: 'householdId is required' });
    }
    const targetId = await resolveAnthropicTargetHouseholdId(req, res, householdId);
    if (targetId == null) return;
    const anthropicKeyMode = req.body.anthropicKeyMode?.trim();
    if (!ANTHROPIC_MODES.has(anthropicKeyMode)) {
      return res.status(400).json({ error: 'anthropicKeyMode must be shared or household' });
    }
    await setHouseholdAnthropicMode(targetId, anthropicKeyMode);
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed to save mode' });
  }
});

app.post(
  '/settings/anthropic/web-search',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
  requireGlobalAdmin,
  async (req, res) => {
  try {
    const householdId = Number(req.body.householdId);
    if (!Number.isFinite(householdId)) {
      return res.status(400).json({ error: 'householdId is required' });
    }
    const targetId = await resolveAnthropicTargetHouseholdId(req, res, householdId);
    if (targetId == null) return;
    const raw = req.body.webSearchEnabled;
    const enabled = raw === true || raw === 1 || raw === '1' || String(raw).toLowerCase() === 'true';
    await setHouseholdWebSearchEnabled(targetId, enabled);
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed to save web search setting' });
  }
});

app.post(
  '/settings/anthropic/key',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
  async (req, res) => {
  try {
    const u = await getHouseholdUserById(req.householdId, req.userId);
    if (!u || u.role !== 'owner') {
      return res.status(403).json({ error: 'Owner only' });
    }
    const anthropicApiKey = String(req.body.anthropicApiKey ?? '').trim();
    if (!anthropicApiKey) {
      return res.status(400).json({ error: 'anthropicApiKey is required' });
    }
    const h = await getHouseholdById(req.householdId);
    if (!h) {
      return res.status(404).json({ error: 'Household not found' });
    }
    if ((h.anthropic_key_mode || 'shared') !== 'household') {
      return res.status(400).json({ error: 'Household is not in household key mode' });
    }
    try {
      await setHouseholdAnthropicApiKey(req.householdId, anthropicApiKey);
    } catch (err) {
      if (err && err.message === 'not_household_key_mode') {
        return res.status(400).json({ error: 'Household is not in household key mode' });
      }
      throw err;
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed to save key' });
  }
});

app.get('/usage', requireHousehold, requireAuth, async (req, res) => {
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

app.get('/chats', requireHousehold, requireAuth, async (req, res) => {
  try {
    const chats = await listAllChats(req.householdId);
    res.json({ chats });
  } catch (error) {
    console.error(error);
    res.status(500).json({ chats: [] });
  }
});

app.post('/chats', requireHousehold, requireAuth, requireNotImpersonatingReadOnly, async (req, res) => {
  try {
    const owner = req.user;
    const title = req.body.title?.trim() || 'New chat';
    const id = await createChat(req.householdId, owner, title);
    res.json({ id, owner, title });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create chat' });
  }
});

app.delete(
  '/chats/:id',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
  requireOwner,
  async (req, res) => {
  try {
    const chatId = Number(req.params.id);
    if (!Number.isFinite(chatId)) {
      return res.status(400).json({ error: 'Invalid chat id.' });
    }
    const deleted = await deleteChatById(chatId, req.householdId);
    if (deleted === 0) {
      return res.status(404).json({ error: 'Chat not found' });
    }
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

app.get('/history', requireHousehold, requireAuth, async (req, res) => {
  try {
    const chatId = Number(req.query.chatId);
    if (!Number.isFinite(chatId)) {
      return res.status(400).json({ conversation: [] });
    }
    const conversation = await getMessages(chatId, req.householdId);
    res.json({ conversation });
  } catch (error) {
    console.error(error);
    res.status(500).json({ conversation: [] });
  }
});

const GROCERY_SECTION_KEYS = new Set(['produce', 'meat', 'dairy', 'frozen', 'dry', 'other']);

/** Trim, drop empty names, coerce unknown sections to `other`. Compatible with !grocerylist and manual adds. */
function normalizeGroceryItemsForPost(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  const out = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.name ?? '').trim();
    if (!name) continue;
    let section = String(raw.section ?? '').trim().toLowerCase();
    if (!GROCERY_SECTION_KEYS.has(section)) section = 'other';
    const amount = raw.amount != null && String(raw.amount).trim() !== '' ? String(raw.amount).trim() : '';
    out.push({ name, section, amount });
  }
  return out;
}

function normalizeGroceryNameKey(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Merge AI-parsed rows into existing list: match unchecked items by section + normalized name; update amount or insert. */
async function mergeGroceryItemsFromAi(householdId, parsedItems) {
  if (!parsedItems.length) return;
  const existing = await getGroceryItems(householdId);
  const byKey = new Map();
  for (const e of existing) {
    if (!e.checked) {
      const k = `${e.section}::${normalizeGroceryNameKey(e.name)}`;
      byKey.set(k, e);
    }
  }
  const toInsert = [];
  const pendingByKey = new Map();
  for (const item of parsedItems) {
    const nameDisp = String(item.name).trim();
    if (!nameDisp) continue;
    const section = item.section;
    const newAmt = String(item.amount ?? '').trim();
    const k = `${section}::${normalizeGroceryNameKey(nameDisp)}`;
    if (byKey.has(k)) {
      const match = byKey.get(k);
      const oldAmt = String(match.amount ?? '').trim();
      if (newAmt !== '' && newAmt !== oldAmt) {
        try {
          await updateGroceryItemAmount(householdId, match.id, newAmt);
          match.amount = newAmt;
        } catch (e) {
          // Row checked or removed since load
        }
      }
    } else if (pendingByKey.has(k)) {
      const pend = pendingByKey.get(k);
      if (newAmt !== '' && newAmt !== String(pend.amount ?? '').trim()) {
        pend.amount = newAmt;
      }
    } else {
      const row = { name: nameDisp, section, amount: newAmt };
      toInsert.push(row);
      pendingByKey.set(k, row);
    }
  }
  if (toInsert.length) await addGroceryItems(householdId, toInsert);
}

app.get('/groceries', requireHousehold, requireAuth, async (req, res) => {
  try {
    const items = await getGroceryItems(req.householdId);
    res.json({ items });
  } catch (error) {
    console.error(error);
    res.status(500).json({ items: [] });
  }
});

app.post('/groceries', requireHousehold, requireAuth, requireNotImpersonatingReadOnly, async (req, res) => {
  try {
    const normalized = normalizeGroceryItemsForPost(req.body.items);
    if (normalized.length === 0) {
      return res.status(400).json({ error: 'No valid items. Each item needs a non-empty name.' });
    }
    await addGroceryItems(req.householdId, normalized);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false });
  }
});

app.patch('/groceries/:id', requireHousehold, requireAuth, requireNotImpersonatingReadOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { checked } = req.body;
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid id.' });
    }
    await updateGroceryItem(req.householdId, id, { checked: !!checked });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false });
  }
});

app.delete('/groceries/:id', requireHousehold, requireAuth, requireNotImpersonatingReadOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid id.' });
    }
    await deleteGroceryItem(req.householdId, id);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false });
  }
});

app.post(
  '/groceries/clear',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
  requireOwner,
  async (req, res) => {
  try {
    await clearGroceryItems(req.householdId);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false });
  }
});

app.post(
  '/chat',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
  rateLimitChatMiddleware,
  async (req, res) => {
  try {
    const prompt = req.body.prompt?.trim();
    const name = req.user || req.body.name?.trim() || 'Rob';
    const chatId = Number(req.body.chatId);
    if (!Number.isFinite(chatId)) {
      return res.status(400).json({ reply: 'chatId is required.' });
    }

    // Private commands (!love, !help, !memories): isPrivateChatCommand — HTTP reply to sender only; no addMessage / broadcastToChat.
    if (isPrivateChatCommand(prompt) && /^!love(?:\s|$)/.test(prompt)) {
      const loveRest = prompt.match(/^!love\s*(.*)$/);
      const targetName = loveRest && loveRest[1] != null ? String(loveRest[1]).trim() : '';
      if (!targetName) {
        const reply =
          'Usage: !love <display name> — boosts that household user\'s compliment chances for their next messages. Example: !love Jamie';
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.end(reply);
      }
      const targetUser = await getUserByHouseholdAndDisplayName(req.householdId, targetName);
      if (!targetUser) {
        const reply = 'No household user with that display name. Check spelling or add them under Settings.';
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.end(reply);
      }
      await ensureUserComplimentStateRow(targetUser.id);
      await setUserLoveBoost(targetUser.id, true);
      const reply =
        'Love boost activated for ' +
        targetName +
        '. Their next few messages are extra likely to get a compliment.';
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(reply);
    }

    if (prompt === '!help' && isPrivateChatCommand(prompt)) {
      const reply = '📋 KitchenBot commands\n\n' + getHelpReply();
      await incrementUserMessageCountForSender(req);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(reply);
    }

    let anthropic;
    let householdWebSearchEnabled = false;
    try {
      const ac = await getAnthropicClient(req.householdId);
      anthropic = ac.client;
      householdWebSearchEnabled = ac.webSearchEnabled;
    } catch (keyErr) {
      const m = keyErr && String(keyErr.message);
      if (m && m.includes('Household not found')) {
        return res.status(503).json({ reply: 'Household not found.' });
      }
      return res.status(503).json({ reply: ANTHROPIC_KEY_USER_MESSAGE });
    }

    const renameMatch = prompt?.match(/^!rename\s*(.*)$/);
    if (renameMatch) {
      const arg = typeof renameMatch[1] === 'string' ? renameMatch[1].trim() : '';
      await incrementUserMessageCountForSender(req);
      let title;
      if (arg) {
        title = arg.slice(0, 200);
      } else {
        const conv = await getMessages(chatId, req.householdId);
        const forContext = conv.filter(m => m.role !== 'user' || !String(m.content).trim().startsWith('!'));
        const recent = forContext.length > 20 ? forContext.slice(-20) : forContext;
        const titleMessages = recent.map(m => ({
          role: m.role,
          content: m.role === 'user' ? `${m.name}: ${m.content}` : m.content,
        }));
        try {
          const titleRes = await anthropic.messages.create({
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
          if (isAnthropicSdkAuthOrKeyError(e)) throw e;
          console.error('Title suggestion failed:', e);
          title = 'New chat';
        }
      }
      await updateChatTitle(chatId, req.householdId, title);
      const reply = `Renamed this chat to "${title}".`;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(reply);
    }

    const memoriesCommand = isMemoriesCommand(prompt);

    const memoryParsed = parseMemoryCommand(prompt);
    const groceryListCommand = isGroceryListCommand(prompt);

    if (memoriesCommand && isPrivateChatCommand(prompt)) {
      const memories = (await getMemories(req.householdId)).filter((m) => m.key !== 'assistant_name');

      const reply = memories.length
        ? 'Current memories:\n' + memories.map(memory => `- ${memory.key}: ${memory.value}`).join('\n')
        : 'No memories stored.';

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(reply);
    }

    // Shared command !remember: isSharedChatCommand (memoryParsed); persist + broadcast.
    if (memoryParsed && isSharedChatCommand(prompt, memoryParsed)) {
      await addMessage(chatId, req.householdId, 'user', name, prompt);
      let reply;
      if (memoryParsed.error) {
        reply = memoryParsed.error;
        await addMessage(chatId, req.householdId, 'assistant', 'KitchenBot', reply);
      } else {
        const newValue = memoryParsed.value;
        const rows = await getMemories(req.householdId);
        const existing = rows.find((r) => r.key === memoryParsed.key);
        if (!existing) {
          await upsertMemory(req.householdId, memoryParsed.key, newValue);
          reply = `Got it. I saved memory \`${memoryParsed.key}\` = "${newValue}".`;
        } else {
          const existingValue = String(existing.value ?? '');
          if (existingValue.includes(newValue)) {
            reply = `No change — \`${memoryParsed.key}\` already includes that.`;
          } else {
            const storedValue = existingValue ? `${existingValue}; ${newValue}` : newValue;
            await upsertMemory(req.householdId, memoryParsed.key, storedValue);
            reply = `Got it. I saved memory \`${memoryParsed.key}\` = "${storedValue}".`;
          }
        }
        await addMessage(chatId, req.householdId, 'assistant', 'KitchenBot', reply);
      }
      if (typeof broadcastToChat === 'function') {
        broadcastToChat(chatId, {
          type: 'chat_updated',
          householdId: req.householdId,
          chatId,
          user: name,
        });
      }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(reply);
    }

    if (groceryListCommand && isSharedChatCommand(prompt, memoryParsed)) {
      await incrementUserMessageCountForSender(req);

      const conversation = await getMessages(chatId, req.householdId);
      const conversationForContext = conversation.filter(
        m => m.role !== 'user' || !String(m.content || '').trim().startsWith('!')
      );
      const recentConversation =
        conversationForContext.length > 40 ? conversationForContext.slice(-40) : conversationForContext;

      const memories = await getMemories(req.householdId);
      const priorCtx = await getChatThreadContext(chatId, req.householdId);
      const priorMealPlanSummary = priorCtx.mealPlanSummary;
      const priorThreadGrocerySummary = priorCtx.threadGrocerySummary;

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

      const groceryResponse = await anthropic.messages.create({
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
        const nameTrim = String(nameRaw).trim();
        if (!sectionRaw || !nameTrim) continue;

        items.push({
          section: sectionRaw,
          name: nameTrim,
          amount: amountRaw != null ? String(amountRaw).trim() : '',
        });
      }

      const normalizedItems = normalizeGroceryItemsForPost(items);
      const groceryListWasUpdated = normalizedItems.length > 0;
      if (groceryListWasUpdated) {
        await mergeGroceryItemsFromAi(req.householdId, normalizedItems);
      }

      const conversationSnippet = recentConversation
        .map((m) =>
          m.role === 'user' ? `${m.name}: ${m.content}` : String(m.content ?? '')
        )
        .join('\n\n');
      const commandOutcomeBlock = groceryListWasUpdated
        ? `Command outcome (this request only — server facts; treat as true):\n- User ran !grocerylist in this chat.\n- A grocery list was generated for this thread via !grocerylist and the household grocery list was updated in the app with the items from this run.`
        : `Command outcome (this request only — server facts; treat as true):\n- User ran !grocerylist in this chat.\n- No grocery items were saved from this run (nothing to merge); the household grocery list was not updated by this request.`;

      const itemsThisRunText =
        normalizedItems.length > 0
          ? normalizedItems
              .map((i) => `${i.section} | ${i.name} | ${i.amount || ''}`)
              .join('\n')
          : '(none parsed this run)';

      let mealPlanToStore = priorMealPlanSummary;
      let threadGroceryToStore = priorThreadGrocerySummary;

      try {
        const summaryResponse = await anthropic.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 700,
          system: `You maintain one concise, factual meal-plan summary for a single chat thread. Output plain text only (no markdown). At most a few short paragraphs total.

Rules:
- Produce a full replacement summary for the thread (not an open-ended append).
- Cover: planned meals or themes; ingredient choices; substitutions or additions; ingredients the user explicitly rejected or wanted to avoid when clear; unresolved questions if any.
- Ground statements in the prior summary, household memory, recent conversation, and the "Command outcome" block below; do not invent specifics beyond them.
- Do not invent app or database actions. You may state outcomes that appear explicitly in the "Command outcome (this request only)" section.`,
          messages: [
            {
              role: 'user',
              content: `${commandOutcomeBlock}\n\nPrevious meal-plan summary for this thread (may be empty):\n${priorMealPlanSummary.trim() || '(none)'}\n\nHousehold memory:\n${memoryText || '(none)'}\n\nRecent conversation (this chat, before this !grocerylist turn is persisted):\n${conversationSnippet}\n\nWrite the updated replacement summary for this thread. Reflect the command outcome above accurately (e.g. if the grocery list was updated in the app, say so; do not say the user still needs to run a command to save it).`,
            },
          ],
        });
        const summaryBlocks = summaryResponse.content.filter((b) => b.type === 'text');
        const newMealPlanSummary = summaryBlocks.map((b) => b.text).join('\n').trim();
        if (newMealPlanSummary) {
          mealPlanToStore = newMealPlanSummary;
        }
      } catch (e) {
        console.error('Meal plan summary update failed:', e.message || e);
      }

      try {
        const groceryCumulativeResponse = await anthropic.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 900,
          system: `You maintain one cumulative plain-text summary of what this chat thread has decided to buy across all !grocerylist runs (purchase intent for this thread). Output plain text only (no markdown). Be concise.

Use these section headings when you have content (omit empty sections):
Proteins
Produce
Dairy / frozen
Pantry / starches
Other
Notes / clarifications

Rules:
- Output a full replacement summary that merges the previous cumulative thread grocery summary with this run's items and the thread context below. Dedupe overlapping items; keep the list stable and scannable.
- Ground items in the previous thread grocery summary, meal plan context, conversation, and the "Items from this run" lines only—do not pull from any household grocery database or shopping tab.
- Do not invent items not supported by those inputs.`,
          messages: [
            {
              role: 'user',
              content: `${commandOutcomeBlock}\n\nPrevious cumulative thread grocery summary (may be empty):\n${priorThreadGrocerySummary.trim() || '(none)'}\n\nMeal plan context for this thread (may be empty):\n${mealPlanToStore.trim() || '(none)'}\n\nItems from this !grocerylist run (section | product | amount):\n${itemsThisRunText}\n\nHousehold memory (context only):\n${memoryText || '(none)'}\n\nRecent conversation (this chat, before this !grocerylist line is persisted):\n${conversationSnippet}\n\nWrite the full replacement cumulative thread grocery summary for what this thread intends to buy so far.`,
            },
          ],
        });
        const gBlocks = groceryCumulativeResponse.content.filter((b) => b.type === 'text');
        const newThreadGrocery = gBlocks.map((b) => b.text).join('\n').trim();
        if (newThreadGrocery) {
          threadGroceryToStore = newThreadGrocery;
        }
      } catch (e) {
        console.error('Thread grocery summary update failed:', e.message || e);
      }

      try {
        await upsertChatThreadContext(chatId, req.householdId, {
          mealPlanSummary: mealPlanToStore,
          threadGrocerySummary: threadGroceryToStore,
        });
      } catch (e) {
        console.error('chat thread context upsert failed:', e.message || e);
      }

      const reply = groceryListWasUpdated
        ? 'I updated the grocery list. Head over to the Grocery List tab to check it.'
        : 'I was not able to build a grocery list from our conversation.';

      await addMessage(chatId, req.householdId, 'user', name, prompt);
      await addMessage(chatId, req.householdId, 'assistant', 'KitchenBot', reply);
      if (typeof broadcastToChat === 'function') {
        broadcastToChat(chatId, {
          type: 'chat_updated',
          householdId: req.householdId,
          chatId,
          user: name,
        });
      }

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(reply);
    }

    if (prompt.trim().startsWith('!')) {
      const reply = 'Unknown command.\n\n' + getHelpReply();
      await incrementUserMessageCountForSender(req);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(reply);
    }

    if (!prompt) {
      return res.status(400).json({ reply: 'Prompt is required.' });
    }

    await addMessage(chatId, req.householdId, 'user', name, prompt);
    await incrementUserMessageCountForSender(req);
    if (typeof broadcastToChat === 'function') {
      broadcastToChat(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });
    }

    const conversation = await getMessages(chatId, req.householdId);
    const conversationForContext = conversation.filter(
      m => m.role !== 'user' || !String(m.content || '').trim().startsWith('!')
    );
    const recentConversation =
      conversationForContext.length > 40 ? conversationForContext.slice(-40) : conversationForContext;

    const memories = await getMemories(req.householdId);

    const memoryText = memories
      .map(memory => `${memory.key}: ${memory.value}`)
      .join('\n');

    const threadCtx = await getChatThreadContext(chatId, req.householdId);

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
        const titleResponse = await anthropic.messages.create({
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
        await updateChatTitle(chatId, req.householdId, safeTitle);
      } catch (e) {
        if (isAnthropicSdkAuthOrKeyError(e)) throw e;
        console.error('Title generation failed:', e);
      }
    }

    const useWebSearchTool =
      householdWebSearchEnabled && shouldEnableWebSearchForPrompt(prompt);

    const webSearchCapabilityBlock = useWebSearchTool
      ? `Web (this request): Anthropic web_search IS attached. Only attribute content to a site or URL if the search tool actually returned that material this turn. Do not fabricate "exact" ingredients, steps, or quotes from a page you did not receive via the tool. If the tool did not return a page body, say you do not have the exact text from that source.`
      : householdWebSearchEnabled
        ? `Web (this request): Web search is NOT attached—no live fetch of links for this reply. Seeing a URL in the user's message does not mean you read it. Do not imply you extracted, checked, read, or matched that page.`
        : `Web (this request): Web search is off for this household. You cannot load URLs. A link in the chat is not page content—do not imply you read it.`;

    const streamParams = {
      model: 'claude-sonnet-4-5',
      max_tokens: useWebSearchTool ? 4096 : 800,
      system: `You are a concise household assistant. Respond in plain text by default. Only use code blocks when the user explicitly asks for code.

    Capability contract — this reply is plain text generation only. It does not run app actions.
    - What actually changes persisted app state are user-typed commands and the Settings UI—not conversational phrasing. Command-backed examples: \`!remember <key> = <value>\` (memories), \`!grocerylist\` (grocery list from chat), \`!rename\` / \`!rename <title>\` (chat title), \`!love <name>\` (compliment boost). Listing memories: \`!memories\`. Full list: \`!help\`.
    - You can suggest, draft, summarize, format, and explain. You cannot execute those commands yourself from this reply.
    - Action honesty: Never claim the app changed (grocery list, memory, chat title, settings, etc.) unless you are quoting what the user must type or describing a hypothetical. Avoid "done", "saved", "updated", "I remembered", "I renamed" for real state. If they asked in plain English for persistence, say you have not changed anything in the app yet, then give a draft and the right \`!\` command or next step.

    ${webSearchCapabilityBlock}
    Source-specific content: You may only present ingredients, steps, prices, dates, or other details as coming from a named site, book, or URL if those exact details are already in this chat (including household memory below), or came from web_search tool results this turn. Otherwise you do not have that source—say so plainly. Never pass off pattern-matching or general knowledge as "from that page" or "from that recipe." If they share only a URL, you cannot give the real ingredient list from that page without tool results or pasted text; offer a clearly labeled generic version (e.g. "a typical baked mac and cheese, not the exact Chunky Chef recipe") or ask them to paste the ingredients.

    Label what you are giving when it matters: (1) Source-backed — only when text/facts are in chat or in this turn's search results. (2) Generic / approximate — say so explicitly. (3) Suggested next step — e.g. paste text, or use \`!remember\` / \`!grocerylist\`. (4) App actions — only as instructions for the user, not as claims you performed.

    Consistency: When you do have a real selected recipe or source (from chat, memory, or search results), keep later lists faithful to it; do not silently drift. When you do not have the source, do not fake fidelity—say the content is unavailable and separate generic help from source-specific claims.

    Thread-specific meal plan context (this chat only; last updated when someone runs \`!grocerylist\`; read-only during normal chat; not the live Grocery tab):
    ${threadCtx.mealPlanSummary.trim() || '(none yet)'}

    Thread-specific cumulative grocery intent (this chat only; updated across \`!grocerylist\` runs in this thread; read-only here; not the live grocery list / grocery_items table):
    ${threadCtx.threadGrocerySummary.trim() || '(none yet)'}

    Household memory (read-only context for you; household-wide; saving still requires \`!remember\` or other commands):
    ${memoryText}`,
      messages: claudeMessages,
    };
    if (useWebSearchTool) {
      streamParams.tools = [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
      ];
    }

    const stream = await anthropic.messages.stream(streamParams);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');

    let finalReply = '';

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const delta = event.delta.text;
        finalReply += delta;
        res.write(delta);
        if (typeof broadcastToChat === 'function') {
          broadcastToChat(chatId, {
            type: 'stream_delta',
            householdId: req.householdId,
            chatId,
            delta,
            user: name,
          });
        }
      }
    }

    /* ---- COMPLIMENT LOGIC (per sending user) ---- */

    const senderForCompliment = await getHouseholdUserById(req.householdId, req.userId);
    const complimentsEnabled =
      senderForCompliment &&
      (senderForCompliment.compliments_enabled === null ||
        senderForCompliment.compliments_enabled === undefined ||
        Number(senderForCompliment.compliments_enabled) === 1);
    if (complimentsEnabled) {
      await ensureUserComplimentStateRow(req.userId);
      const state = await getUserComplimentState(req.userId);
      const { trigger } = shouldTriggerCompliment(state);

      if (trigger) {
        const { compliment, template } = selectComplimentAvoidingRecent(compliments, complimentTemplates, state);
        const complimentLine = template.replace('%s', compliment);
        const complimentAppend = '\n\n' + complimentLine;
        finalReply += complimentAppend;
        await recordCompliment(req.userId, compliment, template);
        res.write(complimentAppend);
        if (typeof broadcastToChat === 'function') {
          broadcastToChat(chatId, {
            type: 'stream_delta',
            householdId: req.householdId,
            chatId,
            delta: complimentAppend,
            user: name,
          });
        }
      }
    }

    /* ---- END OF COMPLIMENT LOGIC ---- */

    await addMessage(chatId, req.householdId, 'assistant', 'KitchenBot', finalReply);
    if (typeof broadcastToChat === 'function') {
      broadcastToChat(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });
    }

    return res.end();

  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      if (isAnthropicSdkAuthOrKeyError(error)) {
        return res.status(503).json({ reply: ANTHROPIC_KEY_USER_MESSAGE });
      }
      const msg = error && error.message;
      return res.status(500).json({ reply: msg || 'Something went wrong.' });
    }
    res.end();
  }
});

const wss = new WebSocketServer({ server });

const wsConnections = new Map();

let redisPub = null;

function doLocalBroadcast(chatId, payload, opts = {}) {
  const { excludeUser = null, excludeWs = null, excludeUserId = null } = opts;
  const msg = JSON.stringify(payload);
  const hid = payload && payload.householdId != null ? Number(payload.householdId) : null;
  for (const [ws, data] of wsConnections) {
    if (ws.readyState !== 1) continue;
    if (hid != null && Number.isFinite(hid) && data.householdId !== hid) continue;
    if (data.chatId !== chatId) continue;
    if (excludeWs != null && ws === excludeWs) continue;
    if (excludeUserId != null && data.userId === excludeUserId) continue;
    if (excludeUser != null && data.user === excludeUser) continue;
    try {
      ws.send(msg);
    } catch (e) {
      // ignore
    }
  }
}

function broadcastToChat(chatId, payload, excludeWs = null, excludeUser = null, excludeUserId = null) {
  if (redisPub) {
    redisPub
      .publish(
        'kitchenbot:broadcast',
        JSON.stringify({ chatId, payload, excludeUser, excludeUserId })
      )
      .catch(() => {});
    return;
  }
  doLocalBroadcast(chatId, payload, { excludeWs, excludeUser, excludeUserId });
}

wss.on('connection', (ws) => {
  const data = { householdId: null, userId: null, user: null, chatId: null };
  wsConnections.set(ws, data);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'identify') {
        const hid = Number(msg.householdId);
        const uid = Number(msg.userId);
        const user = msg.user != null ? String(msg.user).trim() : '';
        if (Number.isFinite(hid) && Number.isFinite(uid) && user !== '') {
          data.householdId = hid;
          data.userId = uid;
          data.user = user;
        }
        return;
      }
      if (msg.type === 'viewing') {
        if (data.householdId == null || !Number.isFinite(data.householdId)) return;
        const vh = msg.householdId != null ? Number(msg.householdId) : NaN;
        if (!Number.isFinite(vh) || vh !== data.householdId) return;
        data.chatId = msg.chatId != null ? Number(msg.chatId) : null;
        return;
      }
      if (msg.type === 'typing' || msg.type === 'stopped_typing') {
        if (!data.householdId || !data.userId || !data.user) return;
        const mh = msg.householdId != null ? Number(msg.householdId) : NaN;
        if (!Number.isFinite(mh) || mh !== data.householdId) return;
        const cid = msg.chatId != null ? Number(msg.chatId) : NaN;
        if (!Number.isFinite(cid) || data.chatId == null || cid !== data.chatId) return;
        const out = {
          type: msg.type === 'typing' ? 'user_typing' : 'user_stopped_typing',
          householdId: data.householdId,
          chatId: cid,
          user: data.user,
          userId: data.userId,
        };
        broadcastToChat(cid, out, ws, null, data.userId);
        return;
      }
    } catch (e) {
      // ignore malformed
    }
  });

  ws.on('close', () => {
    if (
      data.householdId != null &&
      data.userId != null &&
      data.user &&
      data.chatId != null &&
      Number.isFinite(data.chatId)
    ) {
      broadcastToChat(
        data.chatId,
        {
          type: 'user_stopped_typing',
          householdId: data.householdId,
          chatId: data.chatId,
          user: data.user,
          userId: data.userId,
        },
        ws,
        data.user,
        data.userId
      );
    }
    wsConnections.delete(ws);
  });
});

async function connectRedis() {
  const url = process.env.REDIS_URL;
  if (!url) return;
  try {
    const pub = createClient({ url });
    pub.on('error', (err) => console.error('Redis pub error:', err));
    await pub.connect();
    const sub = pub.duplicate();
    sub.on('error', (err) => console.error('Redis sub error:', err));
    await sub.connect();
    await sub.subscribe('kitchenbot:broadcast', (message) => {
      try {
        const { chatId, payload, excludeUser, excludeUserId } = JSON.parse(message);
        doLocalBroadcast(chatId, payload, { excludeUser, excludeUserId });
      } catch (e) {
        // ignore
      }
    });
    redisPub = pub;
    console.log('Redis pub/sub connected');
  } catch (e) {
    console.error('Redis connect failed:', e.message);
  }
}

(async () => {
  await runMigrations();
  await connectRedis();
  try {
    const n = await deleteLegacySeedMemories();
    if (n > 0) console.log(`Removed ${n} legacy seed memory row(s).`);
  } catch (e) {
    console.error('Legacy memory cleanup failed:', e.message || e);
  }
  await seedInitialHouseholdFromEnvIfNeeded();
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
})();
