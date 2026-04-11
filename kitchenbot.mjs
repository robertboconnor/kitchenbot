import {
  createChat,
  listChats,
  listAllChats,
  touchChat,
  updateChatTitle,
  deleteChatById,
  addMessage,
  getMessages,
  clearMessages,
  deleteKbMemory,
  addGroceryItems,
  addPantryItems,
  getPantryItems,
  findPantryItemById,
  getGroceryItems,
  updateGroceryItemAmount,
  backfillGroceryItemSourceChatIfSafe,
  updateGroceryItem,
  deleteGroceryItem,
  deletePantryItem,
  clearGroceryItems,
  pruneStaleGroceryItemsForChat,
  listAllHouseholdsSummary,
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
  getKbMemoryByTypeAndLabel,
  listKbMemories,
  saveKbMemory,
  getHouseholdDefaults,
  saveHouseholdDefaults,
  clearChatRuntimeState,
  getAnthropicUsageLedgerAllRows,
} from './db.mjs';
import { handleKbChatTurn } from './kb-runtime.mjs';
import {
  buildPersonSummary,
  buildMemoryRecordForStorage,
  buildKbContextPacket,
  mergeMemoryRecord,
  normalizeMemoryType,
  normalizePersonNotes,
} from './kb-memory-store.mjs';
import {
  createLoggedAnthropicMessage,
  finalizeLoggedAnthropicStream,
  estimateAnthropicLedgerCostUsd,
} from './anthropic-usage.mjs';
import { resolveAnthropicModelForCallPurpose } from './anthropic-model-policy.mjs';
import {
  createInventoryServices,
  normalizeInventoryNameKey,
} from './inventory-service.mjs';
import { buildKbRuntimeDeps } from './kb-server-deps.mjs';
import { registerKitchenInventoryRoutes } from './kitchen-inventory-routes.mjs';
import 'dotenv/config';
import os from 'os';
import http from 'http';
import express from 'express';
import { createClient } from 'redis';
import { WebSocketServer } from 'ws';
import Anthropic from '@anthropic-ai/sdk';
import crypto from 'crypto';

async function incrementUserMessageCountForSender(req) {
  void req;
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
    throw new Error(`Initial household seeding failed: ${e?.message || e}`);
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

function normalizeUsageFilterBoolean(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s || s === 'all') return null;
  if (s === 'enabled' || s === 'used' || s === 'true' || s === '1') return true;
  if (s === 'disabled' || s === 'not_used' || s === 'false' || s === '0') return false;
  return null;
}

function weeklyPlanDraftHasMeaningfulContent(draft) {
  if (!draft || typeof draft !== 'object') return false;
  const label = String(draft.label ?? '').trim();
  const meals = Array.isArray(draft.meals) ? draft.meals.filter((m) => String(m).trim()) : [];
  const notes = String(draft.notes ?? '').trim();
  return (
    (label && label.length > 0) ||
    meals.length > 0 ||
    (notes && notes.length > 0)
  );
}

function classifyUsageBucket(callPurpose) {
  return String(callPurpose ?? '') === 'chat_reply' ? 'actual_chat' : 'background';
}

function isoDayStartUtc(rawDate) {
  const s = String(rawDate ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return `${s}T00:00:00Z`;
}

function isoNextDayStartUtc(rawDate) {
  const s = String(rawDate ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 19) + 'Z';
}

function buildAnthropicUsageReport(rows) {
  const totals = {
    callCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    estimatedCostUsd: 0,
    estimatedCostAvailable: true,
  };

  const byHousehold = new Map();
  const byPurpose = new Map();
  const byBucket = new Map();
  const byWebSearchEnabled = new Map();
  const byWebSearchUsage = new Map();

  function bump(map, key, row, costUsd) {
    const k = String(key);
    if (!map.has(k)) {
      map.set(k, {
        key: k,
        callCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        estimatedCostUsd: 0,
        estimatedCostAvailable: true,
      });
    }
    const entry = map.get(k);
    entry.callCount += 1;
    entry.inputTokens += Number(row.input_tokens ?? 0) || 0;
    entry.outputTokens += Number(row.output_tokens ?? 0) || 0;
    entry.cacheCreationInputTokens += Number(row.cache_creation_input_tokens ?? 0) || 0;
    entry.cacheReadInputTokens += Number(row.cache_read_input_tokens ?? 0) || 0;
    if (costUsd == null) {
      entry.estimatedCostAvailable = false;
    } else if (entry.estimatedCostAvailable) {
      entry.estimatedCostUsd += costUsd;
    }
  }

  for (const row of rows) {
    totals.callCount += 1;
    totals.inputTokens += Number(row.input_tokens ?? 0) || 0;
    totals.outputTokens += Number(row.output_tokens ?? 0) || 0;
    totals.cacheCreationInputTokens += Number(row.cache_creation_input_tokens ?? 0) || 0;
    totals.cacheReadInputTokens += Number(row.cache_read_input_tokens ?? 0) || 0;
    const costUsd = estimateAnthropicLedgerCostUsd(row);
    if (costUsd == null) {
      totals.estimatedCostAvailable = false;
    } else if (totals.estimatedCostAvailable) {
      totals.estimatedCostUsd += costUsd;
    }
    bump(byHousehold, row.household_id, row, costUsd);
    bump(byPurpose, row.call_purpose, row, costUsd);
    bump(byBucket, classifyUsageBucket(row.call_purpose), row, costUsd);
    bump(byWebSearchEnabled, Number(row.web_search_enabled_at_call) === 1 ? 'enabled' : 'disabled', row, costUsd);
    bump(byWebSearchUsage, Number(row.used_web_search_tool) === 1 ? 'used' : 'not_used', row, costUsd);
  }

  function finalizeGroups(map) {
    return Array.from(map.values()).sort((a, b) => {
      if (b.inputTokens !== a.inputTokens) return b.inputTokens - a.inputTokens;
      return b.callCount - a.callCount;
    });
  }

  return {
    totals,
    byHousehold: finalizeGroups(byHousehold),
    byPurpose: finalizeGroups(byPurpose),
    byBucket: finalizeGroups(byBucket),
    byWebSearchEnabled: finalizeGroups(byWebSearchEnabled),
    byWebSearchUsage: finalizeGroups(byWebSearchUsage),
  };
}

function truncateSmartModeContext(s, max) {
  const t = String(s ?? '');
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + '…';
}

function parseJsonObjectFromModelText(raw) {
  let s = String(raw ?? '').trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)```$/im);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

function createBoundInventoryServices() {
  return createInventoryServices({
    getAnthropicClient,
    getGroceryItems,
    updateGroceryItemAmount,
    backfillGroceryItemSourceChatIfSafe,
    addGroceryItems,
  });
}

/** Compact line for system prompt; never dumps raw JSON. */
function formatWeeklyPlanDraftForPrompt(draft) {
  if (!draft || typeof draft !== 'object') return '(none yet)';
  const label = String(draft.label ?? '').trim();
  const meals = Array.isArray(draft.meals) ? draft.meals.filter((m) => String(m).trim()) : [];
  const notes = String(draft.notes ?? '').trim();
  const hasContent =
    (label && label.length > 0) ||
    meals.length > 0 ||
    (notes && notes.length > 0);
  if (!hasContent) return '(none yet)';
  const parts = [];
  if (label) parts.push(`label: ${label}`);
  if (meals.length) parts.push(`meals: ${meals.map((m, i) => `${i + 1}) ${String(m).trim()}`).join(' · ')}`);
  if (notes) parts.push(`notes: ${notes}`);
  return truncateSmartModeContext(parts.join(' | '), 1200) || '(none yet)';
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
const AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
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
  const cookieParts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}`,
  ];
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

/** Strip hidden KitchenBot control markers from model text before streaming or persisting. */
function stripKitchenBotHiddenMarkers(text) {
  let s = String(text ?? '').replace(/\[\[KB_[A-Z0-9_]+\]\]/g, '');
  s = s.replace(/\[\[KB_PENDING:[^\]]+\]\]/g, '');
  s = s.replace(/\[\[KB_[A-Z0-9_]*$/g, '');
  return s;
}

/** Strip markers from stored DB message content for display, /history, and model context (not for pending recovery). */
function stripStoredMessageContentForDisplay(content) {
  return stripKitchenBotHiddenMarkers(String(content ?? ''));
}



function parseThreadGrocerySummaryKeys(summaryText) {
  const keys = new Set();
  const lines = String(summaryText ?? '').split('\n');
  for (let line of lines) {
    line = String(line ?? '').trim();
    if (!line) continue;
    if (/^(proteins|produce|dairy\s*\/\s*frozen|pantry\s*\/\s*starches|other|notes\s*\/\s*clarifications)\s*:?\s*$/i.test(line)) {
      continue;
    }
    line = line.replace(/^[-*•]\s*/, '');
    const pipe = line.split('|').map((p) => p.trim()).filter(Boolean);
    let candidate = pipe.length >= 2 ? pipe[1] : pipe[0];
    if (!candidate) continue;
    candidate = candidate.replace(/\(.*?\)/g, '').trim();
    if (!candidate) continue;
    const k = normalizeInventoryNameKey(candidate);
    if (k) keys.add(k);
  }
  return keys;
}

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

app.get('/admin/usage-report', requireHousehold, requireAuth, requireGlobalAdminRead, async (req, res) => {
  try {
    const householdIdRaw = req.query.householdId;
    const householdId =
      householdIdRaw == null || String(householdIdRaw).trim() === '' || String(householdIdRaw).trim() === 'all'
        ? null
        : Number(householdIdRaw);
    if (householdId != null && !Number.isFinite(householdId)) {
      return res.status(400).json({ error: 'Invalid household id' });
    }

    const startDate = isoDayStartUtc(req.query.startDate);
    const endDateExclusive = isoNextDayStartUtc(req.query.endDate);
    const filters = {
      householdId,
      startDate,
      endDate: endDateExclusive,
      callPurpose: req.query.callPurpose ? String(req.query.callPurpose).trim() : null,
      callSurface: req.query.callSurface ? String(req.query.callSurface).trim() : null,
      webSearchEnabledAtCall: normalizeUsageFilterBoolean(req.query.webSearchEnabled),
      usedWebSearchTool: normalizeUsageFilterBoolean(req.query.usedWebSearchUsed),
    };

    const [rows, households] = await Promise.all([
      getAnthropicUsageLedgerAllRows(filters),
      listAllHouseholdsSummary(),
    ]);

    const householdNameById = new Map(households.map((hh) => [Number(hh.id), hh.name]));
    const report = buildAnthropicUsageReport(rows);
    const recentRows = rows.slice(0, 100).map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      householdId: Number(row.household_id),
      householdName: householdNameById.get(Number(row.household_id)) || `Household ${row.household_id}`,
      chatId: row.chat_id != null ? Number(row.chat_id) : null,
      runtimeEnabled: Number(row.runtime_enabled ?? 1) === 1,
      callSurface: row.call_surface,
      callPurpose: row.call_purpose,
      bucket: classifyUsageBucket(row.call_purpose),
      model: row.model,
      requestKind: row.request_kind,
      inputTokens: Number(row.input_tokens ?? 0) || 0,
      outputTokens: Number(row.output_tokens ?? 0) || 0,
      cacheCreationInputTokens: Number(row.cache_creation_input_tokens ?? 0) || 0,
      cacheReadInputTokens: Number(row.cache_read_input_tokens ?? 0) || 0,
      webSearchEnabledAtCall: Number(row.web_search_enabled_at_call) === 1,
      usedWebSearchTool: Number(row.used_web_search_tool) === 1,
      estimatedCostUsd: estimateAnthropicLedgerCostUsd(row),
    }));

    const byHousehold = report.byHousehold.map((entry) => ({
      ...entry,
      householdId: Number(entry.key),
      householdName: householdNameById.get(Number(entry.key)) || `Household ${entry.key}`,
    }));

    return res.json({
      filtersApplied: {
        householdId,
        startDate: req.query.startDate ? String(req.query.startDate) : null,
        endDate: req.query.endDate ? String(req.query.endDate) : null,
        callPurpose: filters.callPurpose || null,
        callSurface: filters.callSurface || null,
        webSearchEnabled: filters.webSearchEnabledAtCall,
        usedWebSearchTool: filters.usedWebSearchTool,
      },
      totals: report.totals,
      byHousehold,
      byPurpose: report.byPurpose,
      byBucket: report.byBucket,
      byWebSearchEnabled: report.byWebSearchEnabled,
      byWebSearchUsage: report.byWebSearchUsage,
      recentRows,
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
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 12px;
          min-height: calc(100vh - 28px);
          margin: 0;
        }

        #login-brand {
          text-align: center;
          margin-bottom: 8px;
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
          width: 100%;
          max-width: 420px;
          box-sizing: border-box;
        }

        #login-form {
          display: none;
          flex-direction: column;
          gap: 10px;
          align-items: stretch;
        }

        #login-form.login-form-visible {
          display: flex;
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
          white-space: nowrap;
          border-radius: 999px;
          font-size: 13px;
          line-height: 1.1;
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
          margin: 0;
          font-size: 22px;
          letter-spacing: -0.02em;
        }

        .settings-subtab-btn {
          padding: 9px 16px;
          border-radius: 999px;
          border: 1px solid rgba(148, 163, 184, 0.45);
          background: rgba(255, 255, 255, 0.86);
          cursor: pointer;
          font-size: 14px;
        }

        .settings-subtab-btn.settings-subtab-active {
          border-color: var(--accent-strong);
          font-weight: 600;
          box-shadow: 0 8px 18px rgba(255, 122, 162, 0.18);
          background: rgba(255, 245, 248, 0.95);
        }

        .settings-page-intro {
          margin: 2px 0 0;
          font-size: 14px;
          color: var(--text-soft);
          max-width: 680px;
          line-height: 1.5;
        }

        .settings-card-grid,
        .settings-admin-grid {
          display: grid;
          gap: 14px;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        }

        .settings-admin-grid--wide {
          grid-column: 1 / -1;
        }

        .settings-card {
          background: rgba(255, 255, 255, 0.94);
          border: 1px solid rgba(148, 163, 184, 0.18);
          border-radius: 18px;
          padding: 16px 18px;
          box-shadow: 0 12px 30px rgba(148, 163, 184, 0.12);
        }

        .settings-card h3,
        .settings-card h4 {
          margin: 0;
          font-size: 16px;
          color: var(--text-main);
        }

        .settings-card-header {
          display: flex;
          justify-content: space-between;
          gap: 10px;
          align-items: flex-start;
          margin-bottom: 10px;
        }

        .settings-card-subtitle {
          margin: 4px 0 0;
          font-size: 13px;
          color: var(--text-soft);
          line-height: 1.45;
        }

        .settings-pill-note {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 10px;
          border-radius: 999px;
          background: rgba(107, 155, 209, 0.12);
          color: var(--accent-blue);
          font-size: 12px;
          font-weight: 600;
          white-space: nowrap;
        }

        .settings-meta-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
          gap: 10px;
          margin-bottom: 12px;
        }

        .settings-meta-item {
          padding: 10px 12px;
          border-radius: 14px;
          background: rgba(248, 250, 252, 0.95);
          border: 1px solid rgba(226, 232, 240, 0.95);
        }

        .settings-meta-item .label {
          display: block;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--text-soft);
          margin-bottom: 4px;
        }

        .settings-meta-item .value {
          font-size: 15px;
          color: var(--text-main);
          font-weight: 600;
          word-break: break-word;
        }

        .settings-section-note {
          margin: 0 0 10px;
          font-size: 13px;
          color: var(--text-soft);
          line-height: 1.45;
        }

        .settings-inline-banner {
          margin: 0 0 10px;
          padding: 12px 14px;
          border-radius: 14px;
          border: 1px solid rgba(148, 163, 184, 0.2);
          background: linear-gradient(135deg, rgba(255,255,255,0.96), rgba(244,247,251,0.98));
        }

        .settings-split-grid {
          display: grid;
          gap: 12px;
          grid-template-columns: minmax(0, 1.35fr) minmax(260px, 0.95fr);
        }

        #settings-panel input[type='text'],
        #settings-panel input[type='number'],
        #settings-panel input[type='password'],
        #settings-panel select {
          padding: 9px 12px;
          border-radius: 12px;
          border: 1px solid var(--border-subtle);
          font-size: 14px;
          background: rgba(255, 255, 255, 0.95);
        }

        #settings-panel input[type='number'] {
          appearance: textfield;
          -moz-appearance: textfield;
        }

        #settings-panel input[type='number']::-webkit-outer-spin-button,
        #settings-panel input[type='number']::-webkit-inner-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }

        #settings-panel label {
          font-size: 12px;
          color: var(--text-soft);
        }

        #settings-panel button {
          align-self: auto;
        }

        .settings-form-row {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          align-items: flex-end;
        }

        .settings-form-field {
          display: flex;
          flex-direction: column;
          gap: 4px;
          min-width: 140px;
          flex: 1;
        }

        .settings-actions-row {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          align-items: center;
        }

        .settings-divider {
          height: 1px;
          background: linear-gradient(90deg, rgba(148,163,184,0.08), rgba(148,163,184,0.32), rgba(148,163,184,0.08));
          margin: 14px 0;
        }

        .settings-memory-viewer {
          padding: 12px;
          border-radius: 14px;
          background: rgba(248, 250, 252, 0.72);
          border: 1px solid rgba(226, 232, 240, 0.92);
          min-height: 84px;
        }

        .settings-memory-editor {
          padding: 12px;
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.86);
          border: 1px dashed rgba(148, 163, 184, 0.42);
        }

        .settings-admin-selectors {
          display:flex;
          flex-wrap:wrap;
          gap:10px;
          align-items:flex-end;
        }

        .settings-admin-detail-card {
          padding: 14px;
          border-radius: 16px;
          background: rgba(248, 250, 252, 0.82);
          border: 1px solid rgba(226, 232, 240, 0.92);
        }

        .admin-report-empty {
          color: var(--text-soft);
          font-size: 13px;
        }

        .admin-report-title {
          font-size: 16px;
          font-weight: 700;
          color: var(--text-main);
          margin-bottom: 10px;
        }

        .admin-report-stats {
          display:grid;
          gap:10px;
          grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
          margin-bottom: 14px;
        }

        .admin-report-stat {
          padding: 12px;
          border-radius: 14px;
          background: rgba(248, 250, 252, 0.95);
          border: 1px solid rgba(226, 232, 240, 0.95);
        }

        .admin-report-stat .label {
          display:block;
          font-size:11px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--text-soft);
          margin-bottom: 4px;
        }

        .admin-report-stat .value {
          font-size: 18px;
          font-weight: 700;
          color: var(--text-main);
        }

        .admin-report-grid {
          display:grid;
          gap:12px;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        }

        .admin-report-section {
          padding: 12px;
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.92);
          border: 1px solid rgba(226, 232, 240, 0.92);
        }

        .admin-report-section h5 {
          margin: 0 0 8px;
          font-size: 13px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--text-soft);
        }

        .admin-report-table-wrap {
          overflow-x: auto;
        }

        .admin-report-table {
          width:100%;
          border-collapse: collapse;
          font-size: 12px;
        }

        .admin-report-table th,
        .admin-report-table td {
          padding: 6px 4px;
          border-bottom: 1px solid rgba(226, 232, 240, 0.9);
        }

        .admin-report-table th {
          color: var(--text-soft);
          font-weight: 600;
          text-align:left;
        }

        .admin-report-table td.num,
        .admin-report-table th.num {
          text-align:right;
        }

        #settings-panel h3 {
          margin: 0;
          font-size: 16px;
          color: var(--text-main);
        }

        #settings-add-form {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          align-items: flex-end;
        }

        .settings-user-row {
          display: grid;
          grid-template-columns: minmax(140px, 180px) minmax(180px, 1fr) minmax(180px, 1fr) minmax(220px, 1fr);
          gap: 10px;
          align-items: start;
          margin-bottom: 8px;
          padding: 10px;
          border: 1px solid rgba(229, 231, 235, 0.95);
          border-radius: 8px;
          background: rgba(249, 250, 251, 0.9);
          transition: box-shadow 0.2s ease, background 0.2s ease;
        }

        .settings-user-name {
          font-weight: 600;
          font-size: 14px;
          line-height: 1.3;
          word-break: break-word;
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

        .settings-user-inline-controls {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 6px;
          width: 100%;
        }

        .settings-user-inline-controls label,
        .settings-user-inline-controls span {
          font-size: 13px;
          color: var(--text-soft);
        }

        .settings-user-pref-grid {
          display: grid;
          gap: 8px;
          width: 100%;
          grid-template-columns: 1fr;
        }

        .settings-user-pref-toggle {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 13px;
        }

        .settings-user-row-role-feedback {
          font-size: 12px;
          line-height: 1.35;
          min-height: 1.35em;
          max-width: 280px;
        }

        .settings-memory-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .settings-memory-group {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .settings-memory-group-title {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin: 0;
          font-size: 13px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--text-soft);
        }

        .settings-memory-group-title .count {
          font-size: 11px;
          font-weight: 700;
          color: var(--accent-blue);
        }

        .settings-memory-row {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          align-items: flex-start;
          justify-content: space-between;
          padding: 12px;
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.94);
          border: 1px solid rgba(226, 232, 240, 0.95);
        }

        .settings-memory-row-main {
          flex: 1;
          min-width: 0;
        }

        .settings-memory-row-title {
          display: block;
          margin-bottom: 4px;
          font-size: 14px;
          font-weight: 700;
          color: var(--text-main);
          word-break: break-word;
        }

        .settings-memory-row-body {
          font-size: 13px;
          color: var(--text-main);
          line-height: 1.45;
          word-break: break-word;
        }

        .settings-memory-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          align-items: center;
        }

        .settings-memory-chip {
          display: inline-flex;
          align-items: center;
          padding: 4px 8px;
          border-radius: 999px;
          background: rgba(107, 155, 209, 0.1);
          color: var(--accent-blue);
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.03em;
          text-transform: uppercase;
        }

        .settings-memory-empty {
          padding: 12px;
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.78);
          border: 1px dashed rgba(148, 163, 184, 0.45);
          color: var(--text-soft);
          font-size: 13px;
        }

        .settings-memory-note-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-top: 10px;
        }

        .settings-memory-note-item {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          align-items: flex-start;
          justify-content: space-between;
          padding: 10px 12px;
          border-radius: 12px;
          background: rgba(248, 250, 252, 0.82);
          border: 1px solid rgba(226, 232, 240, 0.95);
        }

        .settings-memory-note-item .settings-memory-row-body {
          min-width: 200px;
        }

        .settings-admin-household-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .settings-admin-household-row {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          justify-content: space-between;
          padding: 12px 14px;
          border-radius: 14px;
          background: rgba(248, 250, 252, 0.78);
          border: 1px solid rgba(226, 232, 240, 0.95);
        }

        .settings-admin-household-row-main {
          flex: 1;
          min-width: 220px;
        }

        .settings-admin-household-name {
          display: block;
          margin-bottom: 4px;
          font-size: 14px;
          font-weight: 700;
          color: var(--text-main);
        }

        .settings-admin-household-meta {
          font-size: 13px;
          color: var(--text-soft);
          line-height: 1.45;
          word-break: break-word;
        }

        .settings-admin-household-tags {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          align-items: flex-start;
          justify-content: flex-end;
        }

        .settings-admin-tag {
          display: inline-flex;
          align-items: center;
          padding: 4px 8px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.03em;
          text-transform: uppercase;
          background: rgba(226, 232, 240, 0.9);
          color: var(--text-soft);
        }

        .settings-admin-tag.settings-admin-tag--on {
          background: rgba(255, 122, 162, 0.12);
          color: var(--accent-strong);
        }

        .settings-admin-usage-summary {
          padding: 12px;
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.92);
          border: 1px solid rgba(226, 232, 240, 0.95);
        }

        .settings-admin-usage-summary h5 {
          margin: 0 0 8px;
          font-size: 13px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--text-soft);
        }

        .settings-admin-usage-summary ul {
          margin: 8px 0 0;
          padding-left: 18px;
          color: var(--text-main);
          font-size: 13px;
        }

        .settings-admin-inline-message {
          margin: 8px 0 0;
          font-size: 13px;
          color: var(--accent-strong);
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

        #grocery-sections,
        #pantry-sections {
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
          min-width: 0;
          flex: 1;
        }

        .g-text-wrap {
          min-width: 0;
        }

        .g-actions {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-left: auto;
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
            width: 100%;
            min-height: calc(100vh - 18px);
            justify-content: center;
            gap: 10px;
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

          .settings-user-row {
            grid-template-columns: 1fr;
            gap: 10px;
          }

          .settings-card-grid,
          .settings-admin-grid,
          .settings-split-grid,
          .admin-report-grid,
          .admin-report-stats {
            grid-template-columns: 1fr;
          }

          .settings-card {
            padding: 14px;
          }

          .settings-meta-grid {
            grid-template-columns: 1fr;
          }

          .settings-user-name {
            margin-bottom: 2px;
          }

          .settings-user-row-role-col {
            width: 100%;
          }

          .settings-user-inline-controls {
            flex-direction: column;
            align-items: stretch;
          }

          .settings-user-inline-controls select,
          .settings-user-inline-controls input,
          .settings-user-inline-controls button {
            width: 100%;
          }

          .settings-form-row,
          .settings-actions-row,
          .settings-admin-selectors,
          .settings-memory-row,
          .settings-memory-note-item,
          .settings-admin-household-row {
            flex-direction: column;
            align-items: stretch;
          }

          .settings-form-field {
            width: 100%;
            max-width: none !important;
          }

          .settings-actions-row button,
          .settings-admin-selectors button {
            width: 100%;
          }

          .settings-memory-actions,
          .settings-admin-household-tags {
            justify-content: flex-start;
          }

          .settings-user-pref-toggle {
            width: 100%;
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
          <button id="tab-groceries" class="tab-button">Kitchen</button>
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
          <div id="grocery-subtabs" style="display:flex;gap:8px;margin-bottom:14px;">
            <button id="grocery-subtab-list" type="button" class="settings-subtab-btn settings-subtab-active">Grocery List</button>
            <button id="grocery-subtab-pantry" type="button" class="settings-subtab-btn">Pantry</button>
          </div>
          <div id="grocery-subview-list" class="grocery-subview">
            <div id="grocery-manual-add">
              <label for="grocery-add-name" style="font-size:13px;color:var(--text-soft);">Add item</label>
              <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:6px;">
                <input id="grocery-add-name" type="text" placeholder="Item name" autocomplete="off" style="min-width:140px;flex:1;padding:6px 10px;border-radius:8px;border:1px solid var(--border-subtle);font-size:14px;" />
                <input id="grocery-add-amount" type="text" placeholder="Amount (optional)" autocomplete="off" style="min-width:100px;padding:6px 10px;border-radius:8px;border:1px solid var(--border-subtle);font-size:14px;" />
                <label for="grocery-add-section" style="font-size:13px;color:var(--text-soft);">Section</label>
                <select id="grocery-add-section" style="padding:6px 10px;border-radius:8px;border:1px solid var(--border-subtle);font-size:14px;">
                  <option value="" selected>Auto</option>
                  <option value="produce">Produce</option>
                  <option value="meat">Meat</option>
                  <option value="dairy">Dairy</option>
                  <option value="frozen">Frozen</option>
                  <option value="dry">Dry</option>
                  <option value="other">Other</option>
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
          <div id="grocery-subview-pantry" class="grocery-subview" style="display:none;">
            <div id="pantry-manual-add">
              <label for="pantry-add-name" style="font-size:13px;color:var(--text-soft);">Add pantry item</label>
              <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:6px;">
                <input id="pantry-add-name" type="text" placeholder="Item name" autocomplete="off" style="min-width:140px;flex:1;padding:6px 10px;border-radius:8px;border:1px solid var(--border-subtle);font-size:14px;" />
                <input id="pantry-add-amount" type="text" placeholder="Amount (optional)" autocomplete="off" style="min-width:100px;padding:6px 10px;border-radius:8px;border:1px solid var(--border-subtle);font-size:14px;" />
                <label for="pantry-add-section" style="font-size:13px;color:var(--text-soft);">Section</label>
                <select id="pantry-add-section" style="padding:6px 10px;border-radius:8px;border:1px solid var(--border-subtle);font-size:14px;">
                  <option value="" selected>Auto</option>
                  <option value="spices_herbs">Spices & Herbs</option>
                  <option value="oils_vinegars">Oils, Vinegars & Cooking Liquids</option>
                  <option value="baking">Baking</option>
                  <option value="sweeteners">Sweeteners</option>
                  <option value="condiments_sauces">Condiments & Sauces</option>
                  <option value="pasta_grains_dry_goods">Pasta, Grains & Dry Goods</option>
                  <option value="other_pantry">Other Pantry</option>
                </select>
                <button type="button" id="pantry-add-submit">Add</button>
              </div>
            </div>
            <div id="pantry-sections">
              <div class="g-section" data-section="spices_herbs">
                <h3>Spices & Herbs</h3>
                <ul class="g-list" id="p-list-spices_herbs"></ul>
              </div>
              <div class="g-section" data-section="oils_vinegars">
                <h3>Oils, Vinegars & Cooking Liquids</h3>
                <ul class="g-list" id="p-list-oils_vinegars"></ul>
              </div>
              <div class="g-section" data-section="baking">
                <h3>Baking</h3>
                <ul class="g-list" id="p-list-baking"></ul>
              </div>
              <div class="g-section" data-section="sweeteners">
                <h3>Sweeteners</h3>
                <ul class="g-list" id="p-list-sweeteners"></ul>
              </div>
              <div class="g-section" data-section="condiments_sauces">
                <h3>Condiments & Sauces</h3>
                <ul class="g-list" id="p-list-condiments_sauces"></ul>
              </div>
              <div class="g-section" data-section="pasta_grains_dry_goods">
                <h3>Pasta, Grains & Dry Goods</h3>
                <ul class="g-list" id="p-list-pasta_grains_dry_goods"></ul>
              </div>
              <div class="g-section" data-section="other_pantry">
                <h3>Other Pantry</h3>
                <ul class="g-list" id="p-list-other_pantry"></ul>
              </div>
            </div>
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
            <p class="settings-page-intro">
              Everything here applies to the household you are logged into (your session household).
            </p>
            <div class="settings-card-grid">
              <section class="settings-card">
                <div class="settings-card-header">
                  <div>
                    <h3>Household</h3>
                    <p class="settings-card-subtitle">Core identity and a quick demo walkthrough for sharing how KitchenBot works.</p>
                  </div>
                  <span class="settings-pill-note">Session household</span>
                </div>
                <div class="settings-meta-grid">
                  <div class="settings-meta-item">
                    <span class="label">Household name</span>
                    <span class="value" id="my-settings-hh-name"></span>
                  </div>
                  <div class="settings-meta-item">
                    <span class="label">Household key</span>
                    <span class="value"><code id="my-settings-hh-key"></code></span>
                  </div>
                </div>
                <div class="settings-inline-banner">
                  <p class="settings-section-note" style="margin-bottom: 8px;">
                    Open a read-only walkthrough as the sample user in the shared demo household.
                  </p>
                  <div class="settings-actions-row">
                    <button type="button" id="settings-demo-view-btn">See how to use this</button>
                    <span id="settings-demo-view-msg" style="font-size: 13px; color: var(--accent-strong);"></span>
                  </div>
                </div>
              </section>
              <section class="settings-card settings-admin-grid--wide">
                <div class="settings-card-header">
                  <div>
                    <h3>Users</h3>
                    <p class="settings-card-subtitle">Manage who can access this household and adjust their role, PIN, and chat color.</p>
                  </div>
                </div>
                <div id="my-settings-users-list"></div>
                <div class="settings-divider"></div>
                <h4 style="margin:0 0 8px;">Add user</h4>
                <div id="settings-add-form">
                  <input id="settings-new-display" type="text" placeholder="Display name" autocomplete="off" />
                  <select id="settings-new-role" aria-label="Role">
                    <option value="member">member</option>
                    <option value="owner">owner</option>
                  </select>
                  <input id="settings-new-pin" type="password" placeholder="PIN" autocomplete="new-password" />
                  <button type="button" id="settings-add-submit">Add user</button>
                </div>
              </section>

              <section class="settings-card settings-admin-grid--wide">
                <div class="settings-card-header">
                  <div>
                    <h3>Memory</h3>
                    <p class="settings-card-subtitle">KitchenBot uses these saved notes across chats when they are relevant.</p>
                  </div>
                </div>
                <div class="settings-split-grid">
                  <div id="my-settings-household-defaults-wrap">
                    <h4 style="margin:0 0 6px;">Household defaults</h4>
                    <p class="settings-section-note">
                      KitchenBot treats these as your household's default assumptions for dinner ideas and weeknight cooking.
                    </p>
                    <div class="settings-memory-editor" style="margin-top: 12px;">
                      <div class="settings-form-row" style="margin-bottom:8px;">
                        <div class="settings-form-field" style="max-width: 180px;">
                          <label for="my-settings-defaults-portions">Default dinner portions</label>
                          <input id="my-settings-defaults-portions" type="number" min="1" max="24" step="1" autocomplete="off" placeholder="4" />
                        </div>
                        <div class="settings-form-field" style="max-width: 220px;">
                          <label for="my-settings-defaults-style">Weeknight cooking style</label>
                          <select id="my-settings-defaults-style">
                            <option value="">No default</option>
                            <option value="easy">easy</option>
                            <option value="normal">normal</option>
                            <option value="ambitious">ambitious</option>
                          </select>
                        </div>
                      </div>
                      <div class="settings-actions-row">
                        <button type="button" id="my-settings-defaults-save">Save defaults</button>
                        <span id="my-settings-defaults-msg" style="font-size: 13px; color: var(--accent-strong);"></span>
                      </div>
                    </div>
                  </div>
                  <div id="my-settings-entity-memories-wrap" style="display: none;">
                    <h4 style="margin:0 0 6px;">People and household memory</h4>
                    <p class="settings-section-note">
                      KitchenBot uses this to remember people and household preferences across chats.
                    </p>
                    <div class="settings-memory-viewer">
                      <div id="my-settings-entity-memories-list" style="font-size: 13px;"></div>
                    </div>
                    <div id="my-settings-entity-memories-msg" style="font-size: 13px; color: var(--accent-strong); margin: 8px 0 0;"></div>
                    <div class="settings-memory-editor" style="margin-top: 12px;">
                      <div class="settings-form-row" style="margin-bottom:8px;">
                        <div class="settings-form-field" style="max-width: 180px;">
                          <label for="my-settings-memory-type">Save under</label>
                          <select id="my-settings-memory-type">
                            <option value="person">person</option>
                            <option value="household_note">household_note</option>
                          </select>
                        </div>
                        <div class="settings-form-field" style="max-width: 220px;">
                          <label for="my-settings-memory-label">Person or label</label>
                          <input id="my-settings-memory-label" type="text" autocomplete="off" placeholder="e.g. Elle or concise recipes" />
                        </div>
                        <div class="settings-form-field">
                          <label for="my-settings-memory-summary">Preference or note</label>
                          <input id="my-settings-memory-summary" type="text" autocomplete="off" placeholder="What KitchenBot should remember" />
                        </div>
                      </div>
                      <div class="settings-actions-row">
                        <button type="button" id="my-settings-memory-save">Save</button>
                        <button type="button" id="my-settings-memory-cancel-edit" style="display: none;">Cancel</button>
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              <section class="settings-card">
                <div class="settings-card-header">
                  <div>
                    <h3>Anthropic API</h3>
                    <p class="settings-card-subtitle">Control whether this household uses the shared server key or an owner-provided Anthropic key.</p>
                  </div>
                </div>
                <div id="settings-anthropic-block">
                  <p id="settings-anthropic-status" style="margin: 0 0 8px; font-size: 14px;"></p>
                  <div id="settings-anthropic-owner-key-section" style="display: none; margin-top: 10px;">
                    <p id="settings-anthropic-key-disclaimer" class="settings-inline-banner" style="font-size: 13px; color: var(--text-soft); line-height: 1.45;">
                      This is a hobby app and is inherently insecure. You should set spend limits and monitor usage in your Anthropic account when using your own API key.
                    </p>
                    <div class="settings-form-field" style="max-width: 420px;">
                      <label for="settings-anthropic-owner-key">Household Anthropic API key</label>
                      <input id="settings-anthropic-owner-key" type="password" placeholder="sk-ant-…" autocomplete="off" />
                    </div>
                    <div class="settings-actions-row" style="margin-top: 8px;">
                      <button type="button" id="settings-anthropic-owner-key-save">Save key</button>
                      <span id="settings-anthropic-owner-key-msg" style="font-size: 13px; color: var(--accent-strong);"></span>
                    </div>
                  </div>
                </div>
              </section>
            </div>
            <div id="my-settings-msg"></div>
          </div>

          <div id="settings-view-admin" class="settings-subview" style="display: none;">
            <h3 style="margin-top: 0;">Global admin</h3>
            <p class="settings-page-intro">
              Actions below apply to the household you select — not necessarily the household you are logged into.
            </p>
            <div class="settings-admin-grid">
              <section class="settings-card settings-admin-grid--wide">
                <div class="settings-card-header">
                  <div>
                    <h3>Households</h3>
                    <p class="settings-card-subtitle">Pick the household you want to inspect, then adjust configuration or review usage for that specific household.</p>
                  </div>
                </div>
                <div id="admin-editing-banner" class="settings-inline-banner" style="margin-bottom: 12px;"></div>
                <h4 style="margin: 0 0 8px;">All households</h4>
                <div id="settings-admin-households-list" style="font-size: 13px; margin-bottom: 12px;"></div>
                <div class="settings-admin-selectors">
                  <div class="settings-form-field" style="max-width: 420px;">
                    <label for="admin-anthropic-household-select">Selected household</label>
                    <select id="admin-anthropic-household-select"></select>
                  </div>
                </div>
                <div id="settings-admin-household-detail" class="settings-admin-detail-card" style="margin-top: 12px; font-size: 13px;">
                  <div class="settings-meta-grid">
                    <div class="settings-meta-item">
                      <span class="label">Selected household</span>
                      <span class="value" id="admin-detail-name"></span>
                    </div>
                    <div class="settings-meta-item">
                      <span class="label">Household key</span>
                      <span class="value"><code id="admin-detail-key"></code></span>
                    </div>
                  </div>
                  <div id="admin-detail-usage" style="margin-top: 10px;"></div>
                  <div class="settings-divider"></div>
                  <div style="margin-top: 8px;"><strong>Users (this household only)</strong></div>
                  <div class="admin-report-table-wrap" style="margin-top: 4px;">
                    <table class="admin-report-table" style="font-size: 13px;">
                      <thead><tr><th>Display name</th><th>Role</th><th>PIN (global admin)</th><th>View as</th></tr></thead>
                      <tbody id="admin-detail-users-body"></tbody>
                    </table>
                  </div>
                  <p id="admin-pin-global-msg" style="margin: 8px 0 0; font-size: 13px; color: var(--accent-strong);"></p>
                  <p id="admin-anthropic-selected-status" style="margin: 10px 0 0; font-size: 13px;"></p>
                </div>
              </section>

              <section class="settings-card settings-admin-grid--wide">
                <div class="settings-card-header">
                  <div>
                    <h3>Anthropic usage</h3>
                    <p class="settings-card-subtitle">Review token, cost, and web-search usage with filters that make the underlying call ledger easier to scan.</p>
                  </div>
                </div>
                <div class="settings-admin-selectors" style="margin-bottom: 10px;">
                  <div class="settings-form-field" style="max-width: 170px;">
                    <label for="admin-usage-start-date">Start date</label>
                    <input id="admin-usage-start-date" type="date" />
                  </div>
                  <div class="settings-form-field" style="max-width: 170px;">
                    <label for="admin-usage-end-date">End date</label>
                    <input id="admin-usage-end-date" type="date" />
                  </div>
                  <div class="settings-form-field" style="max-width: 200px;">
                    <label for="admin-usage-household-select">Household</label>
                    <select id="admin-usage-household-select"></select>
                  </div>
                  <div class="settings-form-field" style="max-width: 180px;">
                    <label for="admin-usage-websearch-setting">Web search setting</label>
                    <select id="admin-usage-websearch-setting">
                      <option value="all">All</option>
                      <option value="enabled">Enabled</option>
                      <option value="disabled">Disabled</option>
                    </select>
                  </div>
                  <div class="settings-form-field" style="max-width: 180px;">
                    <label for="admin-usage-websearch-used">Web search used</label>
                    <select id="admin-usage-websearch-used">
                      <option value="all">All</option>
                      <option value="used">Used</option>
                      <option value="not_used">Not used</option>
                    </select>
                  </div>
                  <button type="button" id="admin-usage-refresh">Refresh usage</button>
                </div>
                <div id="admin-usage-msg" style="font-size: 13px; color: var(--accent-strong); margin-bottom: 8px;"></div>
                <div id="admin-usage-report" class="settings-admin-detail-card" style="font-size: 13px;"></div>
              </section>

              <section class="settings-card">
                <div class="settings-card-header">
                  <div>
                    <h3>Anthropic mode</h3>
                    <p class="settings-card-subtitle">Switch whether the selected household uses the shared server key or an owner-provided key.</p>
                  </div>
                </div>
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
                  <div class="settings-actions-row" style="margin-top: 10px;">
                    <button type="button" id="admin-anthropic-mode-save">Save mode</button>
                    <span id="admin-anthropic-msg" style="font-size: 13px; color: var(--accent-strong);"></span>
                  </div>
                </div>
              </section>

              <section class="settings-card">
                <div class="settings-card-header">
                  <div>
                    <h3>Household feature flags</h3>
                    <p class="settings-card-subtitle">Adjust the household-specific capability toggle that affects live model behavior.</p>
                  </div>
                </div>
                <div class="settings-inline-banner" style="margin-bottom: 12px;">
                  <p style="font-size: 13px; color: var(--text-soft); margin: 0 0 8px;">
                    For the <strong>selected</strong> household only: when enabled, KitchenBot may attach Anthropic&apos;s web search tool on messages that look like they need live web context.
                  </p>
                  <label style="display: flex; align-items: flex-start; gap: 8px;">
                    <input type="checkbox" id="admin-web-search-enabled" style="margin-top: 3px;" />
                    <span>Enable web search for this household</span>
                  </label>
                  <div class="settings-actions-row" style="margin-top: 8px;">
                    <button type="button" id="admin-web-search-save">Save web search setting</button>
                    <span id="admin-web-search-msg" style="font-size: 13px; color: var(--accent-strong);"></span>
                  </div>
                </div>
              </section>

              <section class="settings-card">
                <div class="settings-card-header">
                  <div>
                    <h3>Create household</h3>
                    <p class="settings-card-subtitle">Provision a new household with an initial owner. Share the household key and PIN separately.</p>
                  </div>
                </div>
                <div style="display: flex; flex-direction: column; gap: 8px; max-width: 420px;">
                  <input id="admin-new-hh-name" type="text" placeholder="Household name" autocomplete="organization" />
                  <input id="admin-new-hh-key" type="text" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="Household key (e.g. smith-home)" />
                  <input id="admin-new-owner-name" type="text" placeholder="Owner display name" autocomplete="name" />
                  <input id="admin-new-owner-pin" type="password" placeholder="Owner PIN" autocomplete="new-password" />
                  <button type="button" id="admin-new-hh-submit">Create household</button>
                </div>
                <p id="admin-new-hh-msg" style="font-size: 13px; margin-top: 8px;"></p>
              </section>
            </div>
          </div>
        </div>

        <div id="input-area">
          <textarea id="prompt" placeholder="Ask KitchenBot" rows="1"></textarea>
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
        const grocerySubtabList = document.getElementById('grocery-subtab-list');
        const grocerySubtabPantry = document.getElementById('grocery-subtab-pantry');
        const grocerySubviewList = document.getElementById('grocery-subview-list');
        const grocerySubviewPantry = document.getElementById('grocery-subview-pantry');
        const groceryAddName = document.getElementById('grocery-add-name');
        const groceryAddAmount = document.getElementById('grocery-add-amount');
        const groceryAddSection = document.getElementById('grocery-add-section');
        const groceryAddSubmit = document.getElementById('grocery-add-submit');
        const pantryAddName = document.getElementById('pantry-add-name');
        const pantryAddAmount = document.getElementById('pantry-add-amount');
        const pantryAddSection = document.getElementById('pantry-add-section');
        const pantryAddSubmit = document.getElementById('pantry-add-submit');
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
        const pantryLists = {
          spices_herbs: document.getElementById('p-list-spices_herbs'),
          oils_vinegars: document.getElementById('p-list-oils_vinegars'),
          baking: document.getElementById('p-list-baking'),
          sweeteners: document.getElementById('p-list-sweeteners'),
          condiments_sauces: document.getElementById('p-list-condiments_sauces'),
          pasta_grains_dry_goods: document.getElementById('p-list-pasta_grains_dry_goods'),
          other_pantry: document.getElementById('p-list-other_pantry'),
        };

        let currentChatId = null;
        let currentUserName = null;
        let currentHouseholdId = null;
        let currentUserId = null;
        let isCurrentUserOwner = false;
        let currentGroceriesSubview = 'list';
        let godModeReadOnly = false;
        let editingSmartMemoryId = null;
        let editingSmartMemoryNoteIndex = null;
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
        /** Last persisted message count from /history per chat (DB rows only). */
        const lastPersistedMessageCountByChatId = new Map();
        /**
         * Sender-only ephemeral !command turns (session memory): merged after each loadHistory.
         * anchor = persisted row count when the exchange happened; seq = stable order for same anchor.
         */
        const ephemeralExchangesByChatId = new Map();
        const nextEphemeralSeqByChatId = new Map();

        /** @returns {'God mode' | 'Demo mode' | 'Read-only mode'} */
        function impersonationReadOnlyModeLabel() {
          if (!lastMePayload || !lastMePayload.isImpersonating) return 'Read-only mode';
          return lastMePayload.isGlobalAdmin === true ? 'God mode' : 'Demo mode';
        }

        function impersonationReadOnlyNoticeText() {
          const mode = impersonationReadOnlyModeLabel();
          if (mode === 'Read-only mode') {
            return 'Read-only mode. Exit to make changes.';
          }
          if (mode === 'God mode') {
            return 'God Mode is read-only. Exit God Mode to make changes.';
          }
          return 'Demo mode is read-only. Exit Demo Mode to make changes.';
        }

        /** Maps server 403 God Mode copy to Demo Mode when the session is read-only Demo impersonation. */
        function mapServerReadOnlyErrorMessage(rawError) {
          const s = rawError == null ? '' : String(rawError);
          if (!godModeReadOnly || !lastMePayload || !lastMePayload.isImpersonating) {
            return s || 'Request failed.';
          }
          if (/God Mode is read-only|Exit God Mode to make changes/i.test(s)) {
            return impersonationReadOnlyNoticeText();
          }
          return s || 'Request failed.';
        }

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
          const memorySaveButton = document.getElementById('my-settings-memory-save');
          const adminModeSave = document.getElementById('admin-anthropic-mode-save');
          const adminNewHh = document.getElementById('admin-new-hh-submit');
          const demoViewBtn = document.getElementById('settings-demo-view-btn');
          if (gas) gas.disabled = ro;
          if (sas) sas.disabled = ro;
          if (memSave) memSave.disabled = ro;
          if (memorySaveButton) memorySaveButton.disabled = ro;
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
          if (pantryAddName) {
            pantryAddName.readOnly = ro;
            pantryAddName.style.opacity = ro ? '0.65' : '';
          }
          if (pantryAddAmount) {
            pantryAddAmount.readOnly = ro;
            pantryAddAmount.style.opacity = ro ? '0.65' : '';
          }
          if (pantryAddSection) pantryAddSection.disabled = ro;
          if (pantryAddSubmit) pantryAddSubmit.disabled = ro;
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

        function teardownRealtimeUi() {
          if (typingWs) {
            typingWs.close();
            typingWs = null;
          }
          typingUsers.clear();
          typingIndicator.textContent = '';
          if (typingStopTimeout) clearTimeout(typingStopTimeout);
          typingStopTimeout = null;
          remoteStreamBodyEl = null;
          weAreStreamingThisChat = false;
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
                  // Prevent the sending client from applying the same assistant stream chunk twice.
                  if (weAreStreamingThisChat) {
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
          clearEntityMemoryUiMessage();
          tabChat.classList.toggle('tab-active', tab === 'chat');
          tabGroceries.classList.toggle('tab-active', tab === 'groceries');
          if (tabSettings) tabSettings.classList.toggle('tab-active', tab === 'settings');
          chat.style.display = tab === 'chat' ? 'flex' : 'none';
          groceryPanel.style.display = tab === 'groceries' ? 'flex' : 'none';
          if (settingsPanel) settingsPanel.style.display = tab === 'settings' ? 'flex' : 'none';
          if (inputArea) inputArea.style.display = tab === 'chat' ? 'flex' : 'none';
          if (tab === 'groceries') setGroceriesSubview(currentGroceriesSubview);
          if (tab === 'settings') loadSettingsPanel();
        }

        function closeSidebarAndGoToChatTab() {
          setActiveTab('chat');
          sidebar.classList.remove('open');
          sidebarBackdrop.classList.remove('open');
        }

        function syncEntityMemoriesWrapVisibility(runtimeEnabled) {
          const w = document.getElementById('my-settings-entity-memories-wrap');
          if (w) w.style.display = isCurrentUserOwner && runtimeEnabled ? '' : 'none';
        }

        function syncMemoriesWrapVisibility() {
          syncEntityMemoriesWrapVisibility(true);
        }

        function clearEntityMemoryUiMessage() {
          const el = document.getElementById('my-settings-entity-memories-msg');
          if (el) el.textContent = '';
        }

        function clearHouseholdDefaultsUiMessage() {
          const el = document.getElementById('my-settings-defaults-msg');
          if (el) el.textContent = '';
        }

        function resetSmartMemoryEditForm() {
          editingSmartMemoryId = null;
          editingSmartMemoryNoteIndex = null;
          const typeIn = document.getElementById('my-settings-memory-type');
          const labelIn = document.getElementById('my-settings-memory-label');
          const summaryIn = document.getElementById('my-settings-memory-summary');
          const cancelBtn = document.getElementById('my-settings-memory-cancel-edit');
          if (typeIn) typeIn.value = 'person';
          if (labelIn) labelIn.value = '';
          if (summaryIn) summaryIn.value = '';
          if (cancelBtn) cancelBtn.style.display = 'none';
        }

        function stripMemoryDisplayWrappers(s) {
          let t = String(s ?? '').trim();
          while (t.length >= 2 && t.startsWith('\`') && t.endsWith('\`')) {
            t = t.slice(1, -1).trim();
          }
          if (t.length >= 2) {
            const a = t[0];
            const b = t[t.length - 1];
            if ((a === '"' || a === "'") && a === b) {
              t = t.slice(1, -1).trim();
            }
          }
          return t;
        }


        async function loadMemoryNotesEditor() {
          const listEl = document.getElementById('my-settings-entity-memories-list');
          const memMsg = document.getElementById('my-settings-entity-memories-msg');
          if (!listEl || !isCurrentUserOwner) return;
          try {
            const r = await fetch('/settings/household/memory-notes');
            if (!r.ok) {
              listEl.innerHTML = '';
              if (memMsg) memMsg.textContent = 'Could not load saved memories.';
              return;
            }
            const data = await r.json();
            listEl.innerHTML = '';
            listEl.className = 'settings-memory-list';
            const all = Array.isArray(data.memories) ? data.memories : [];
            const people = all.filter((m) => m.memoryType === 'person');
            const householdNotes = all.filter((m) => m.memoryType !== 'person');

            function buildSection(title, emptyText) {
              const section = document.createElement('div');
              section.className = 'settings-memory-group';
              const heading = document.createElement('div');
              heading.className = 'settings-memory-group-title';
              heading.textContent = title;
              section.appendChild(heading);
              if (!emptyText) return section;
              const empty = document.createElement('div');
              empty.className = 'settings-memory-empty';
              empty.textContent = emptyText;
              section.appendChild(empty);
              return section;
            }

            const peopleSection = buildSection('People', people.length ? '' : 'No people saved yet.');
            if (people.length) {
              const count = document.createElement('span');
              count.className = 'count';
              count.textContent = people.length + ' saved';
              peopleSection.firstChild.appendChild(count);
            }
            for (const m of people) {
              const card = document.createElement('div');
              card.className = 'settings-memory-row';
              const top = document.createElement('div');
              top.className = 'settings-memory-row-main';
              const label = document.createElement('strong');
              label.className = 'settings-memory-row-title';
              label.textContent = String(m.label || '');
              const chip = document.createElement('span');
              chip.className = 'settings-memory-chip';
              chip.textContent = 'Person';
              top.appendChild(chip);
              top.appendChild(label);
              const notes = Array.isArray(m.attributes && m.attributes.notes) ? m.attributes.notes : [];
              const summary = document.createElement('div');
              summary.className = 'settings-memory-row-body';
              summary.textContent =
                notes.length === 1 ? '1 saved preference' : notes.length + ' saved preferences';
              top.appendChild(summary);
              const actions = document.createElement('div');
              actions.className = 'settings-memory-actions';
              const delPersonBtn = document.createElement('button');
              delPersonBtn.type = 'button';
              delPersonBtn.textContent = 'Delete person';
              delPersonBtn.addEventListener('click', async () => {
                if (!confirm('Delete all Smart memory for "' + m.label + '"?')) return;
                const dr = await fetch('/settings/household/memory-notes/' + encodeURIComponent(m.id), { method: 'DELETE' });
                const errBody = await dr.json().catch(() => ({}));
                if (memMsg) memMsg.textContent = dr.ok ? 'Person deleted.' : mapServerReadOnlyErrorMessage(errBody.error) || 'Delete failed';
                if (dr.ok) {
                  resetSmartMemoryEditForm();
                  await loadMemoryNotesEditor();
                }
              });
              actions.appendChild(delPersonBtn);
              card.appendChild(top);
              card.appendChild(actions);
              const noteList = document.createElement('div');
              noteList.className = 'settings-memory-note-list';
              if (!notes.length) {
                const empty = document.createElement('div');
                empty.className = 'settings-memory-empty';
                empty.textContent = '(No saved notes yet)';
                noteList.appendChild(empty);
              }
              notes.forEach((note, idx) => {
                const row = document.createElement('div');
                row.className = 'settings-memory-note-item';
                const text = document.createElement('div');
                text.className = 'settings-memory-row-body';
                text.textContent = note && note.text ? note.text : '';
                row.appendChild(text);
                const noteActions = document.createElement('div');
                noteActions.className = 'settings-memory-actions';
                const editBtn = document.createElement('button');
                editBtn.type = 'button';
                editBtn.textContent = 'Edit';
                editBtn.addEventListener('click', () => {
                  editingSmartMemoryId = m.id;
                  editingSmartMemoryNoteIndex = idx;
                  const typeIn = document.getElementById('my-settings-memory-type');
                  const labelIn = document.getElementById('my-settings-memory-label');
                  const summaryIn = document.getElementById('my-settings-memory-summary');
                  const cancelBtn = document.getElementById('my-settings-memory-cancel-edit');
                  if (typeIn) typeIn.value = 'person';
                  if (labelIn) labelIn.value = m.label || '';
                  if (summaryIn) summaryIn.value = note && note.text ? note.text : '';
                  if (cancelBtn) cancelBtn.style.display = '';
                  clearEntityMemoryUiMessage();
                });
                noteActions.appendChild(editBtn);
                const delBtn = document.createElement('button');
                delBtn.type = 'button';
                delBtn.textContent = 'Delete';
                delBtn.addEventListener('click', async () => {
                  if (!confirm('Delete this saved note for "' + m.label + '"?')) return;
                  const dr = await fetch('/settings/household/memory-notes/' + encodeURIComponent(m.id) + '?noteIndex=' + encodeURIComponent(idx), { method: 'DELETE' });
                  const errBody = await dr.json().catch(() => ({}));
                  if (memMsg) memMsg.textContent = dr.ok ? 'Saved note deleted.' : mapServerReadOnlyErrorMessage(errBody.error) || 'Delete failed';
                  if (dr.ok) {
                    resetSmartMemoryEditForm();
                    await loadMemoryNotesEditor();
                  }
                });
                noteActions.appendChild(delBtn);
                row.appendChild(noteActions);
                noteList.appendChild(row);
              });
              card.appendChild(noteList);
              peopleSection.appendChild(card);
            }
            listEl.appendChild(peopleSection);

            const householdSection = buildSection('Household preferences', householdNotes.length ? '' : 'No household preferences saved yet.');
            if (householdNotes.length) {
              const count = document.createElement('span');
              count.className = 'count';
              count.textContent = householdNotes.length + ' saved';
              householdSection.firstChild.appendChild(count);
            }
            for (const m of householdNotes) {
              const row = document.createElement('div');
              row.className = 'settings-memory-row';
              const kv = document.createElement('div');
              kv.className = 'settings-memory-row-main';
              const chip = document.createElement('span');
              chip.className = 'settings-memory-chip';
              chip.textContent = 'Household';
              kv.appendChild(chip);
              const strong = document.createElement('strong');
              strong.className = 'settings-memory-row-title';
              strong.textContent = String(m.label || '');
              kv.appendChild(strong);
              const span = document.createElement('span');
              span.className = 'settings-memory-row-body';
              span.textContent = m.summary;
              kv.appendChild(span);
              row.appendChild(kv);
              const actions = document.createElement('div');
              actions.className = 'settings-memory-actions';
              const editBtn = document.createElement('button');
              editBtn.type = 'button';
              editBtn.textContent = 'Edit';
              editBtn.addEventListener('click', () => {
                editingSmartMemoryId = m.id;
                editingSmartMemoryNoteIndex = null;
                const typeIn = document.getElementById('my-settings-memory-type');
                const labelIn = document.getElementById('my-settings-memory-label');
                const summaryIn = document.getElementById('my-settings-memory-summary');
                const cancelBtn = document.getElementById('my-settings-memory-cancel-edit');
                if (typeIn) typeIn.value = 'household_note';
                if (labelIn) labelIn.value = m.label || '';
                if (summaryIn) summaryIn.value = m.summary || '';
                if (cancelBtn) cancelBtn.style.display = '';
                clearEntityMemoryUiMessage();
              });
              actions.appendChild(editBtn);
              const delBtn = document.createElement('button');
              delBtn.type = 'button';
              delBtn.textContent = 'Delete';
              delBtn.addEventListener('click', async () => {
                if (!confirm('Delete household preference "' + m.label + '"?')) return;
                const dr = await fetch('/settings/household/memory-notes/' + encodeURIComponent(m.id), { method: 'DELETE' });
                const errBody = await dr.json().catch(() => ({}));
                if (memMsg) memMsg.textContent = dr.ok ? 'Household preference deleted.' : mapServerReadOnlyErrorMessage(errBody.error) || 'Delete failed';
                if (dr.ok) {
                  resetSmartMemoryEditForm();
                  await loadMemoryNotesEditor();
                }
              });
              actions.appendChild(delBtn);
              row.appendChild(actions);
              householdSection.appendChild(row);
            }
            listEl.appendChild(householdSection);
            if (memMsg) memMsg.textContent = '';
          } catch (e) {
            listEl.innerHTML = '';
            if (memMsg) memMsg.textContent = 'Load failed.';
          }
        }

        async function loadHouseholdDefaultsEditor() {
          const portionsEl = document.getElementById('my-settings-defaults-portions');
          const styleEl = document.getElementById('my-settings-defaults-style');
          const msgEl = document.getElementById('my-settings-defaults-msg');
          if (!portionsEl || !styleEl || !isCurrentUserOwner) return;
          try {
            const r = await fetch('/settings/household/defaults');
            if (!r.ok) {
              if (msgEl) msgEl.textContent = 'Could not load household defaults.';
              return;
            }
            const data = await r.json();
            const defaults = data.defaults || {};
            portionsEl.value =
              defaults.defaultDinnerPortions == null || !Number.isFinite(Number(defaults.defaultDinnerPortions))
                ? ''
                : String(Number(defaults.defaultDinnerPortions));
            styleEl.value = defaults.weeknightCookingStyle || '';
            if (msgEl) msgEl.textContent = '';
          } catch (e) {
            if (msgEl) msgEl.textContent = 'Load failed.';
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
            isCurrentUserOwner = !!data.canManageHouseholdSettings;
            syncMemoriesWrapVisibility();
            syncEntityMemoriesWrapVisibility(true);
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
              label.className = 'settings-user-name';
              label.textContent = u.displayName;
              const roleCol = document.createElement('div');
              roleCol.className = 'settings-user-row-role-col';
              const roleWrap = document.createElement('div');
              roleWrap.className = 'settings-user-inline-controls';
              const roleLbl = document.createElement('span');
              roleLbl.textContent = 'Role';
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
                  clearEntityMemoryUiMessage();
                  roleFeedback.textContent = '';
                  syncRoleButtonState();
                });
                syncRoleButtonState();
              }
              roleBtn.addEventListener('click', async () => {
                clearEntityMemoryUiMessage();
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
                    roleFeedback.textContent =
                      mapServerReadOnlyErrorMessage(errBody.error) || 'Failed to update role';
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
              pinRow.className = 'settings-user-inline-controls';
              const pinLbl = document.createElement('span');
              pinLbl.textContent = 'PIN';
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
                clearEntityMemoryUiMessage();
                pinFeedback.textContent = '';
                syncPinButton();
              });
              btn.addEventListener('click', async () => {
                clearEntityMemoryUiMessage();
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
                    pinFeedback.textContent =
                      mapServerReadOnlyErrorMessage(errBody.error) || 'Failed to update PIN';
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
              pinRow.appendChild(pinLbl);
              pinRow.appendChild(pinIn);
              pinRow.appendChild(btn);
              pinCol.appendChild(pinRow);
              pinCol.appendChild(pinFeedback);
              row.appendChild(label);
              row.appendChild(roleCol);
              row.appendChild(pinCol);
              const prefGrid = document.createElement('div');
              prefGrid.className = 'settings-user-pref-grid';
              const colorCol = document.createElement('div');
              colorCol.className = 'settings-user-row-role-col';
              const colorWrap = document.createElement('div');
              colorWrap.className = 'settings-user-inline-controls';
              const colorLbl = document.createElement('span');
              colorLbl.textContent = 'Chat color';
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
                clearEntityMemoryUiMessage();
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
                    colorFeedback.textContent =
                      mapServerReadOnlyErrorMessage(errBody.error) || 'Failed to update chat color';
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
              prefGrid.appendChild(colorCol);
              row.appendChild(prefGrid);
              listEl.appendChild(row);
            }
            if (msgEl) msgEl.textContent = '';
            await loadHouseholdDefaultsEditor();
            await loadMemoryNotesEditor();
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
          clearEntityMemoryUiMessage();
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

        function escapeAdminHtml(value) {
          return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        }

        function formatAdminUsageUsd(value, available = true) {
          if (!available) return 'Unavailable';
          const n = Number(value);
          if (!Number.isFinite(n)) return 'Unavailable';
          return '$' + n.toFixed(4);
        }

        function renderAdminUsageSection(title, rows, labelKey) {
          if (!Array.isArray(rows) || rows.length === 0) {
            return (
              '<section class="admin-report-section"><h5>' +
              escapeAdminHtml(title) +
              '</h5><div class="admin-report-empty">No rows.</div></section>'
            );
          }
          let html =
            '<section class="admin-report-section"><h5>' +
            escapeAdminHtml(title) +
            '</h5><div class="admin-report-table-wrap"><table class="admin-report-table">' +
            '<thead><tr><th>' +
            escapeAdminHtml(labelKey) +
            '</th><th class="num">Calls</th><th class="num">In</th><th class="num">Out</th><th class="num">Est. cost</th></tr></thead><tbody>';
          for (const row of rows) {
            const label = row.householdName || row.key || '—';
            html +=
              '<tr><td>' +
              escapeAdminHtml(label) +
              '</td><td class="num">' +
              escapeAdminHtml(row.callCount != null ? row.callCount : 0) +
              '</td><td class="num">' +
              escapeAdminHtml(row.inputTokens != null ? row.inputTokens : 0) +
              '</td><td class="num">' +
              escapeAdminHtml(row.outputTokens != null ? row.outputTokens : 0) +
              '</td><td class="num">' +
              escapeAdminHtml(
                formatAdminUsageUsd(row.estimatedCostUsd, row.estimatedCostAvailable !== false)
              ) +
              '</td></tr>';
          }
          html += '</tbody></table></div></section>';
          return html;
        }

        function renderAdminUsageReport(reportData) {
          const root = document.getElementById('admin-usage-report');
          if (!root) return;
          if (!reportData || !reportData.totals) {
            root.innerHTML = '<span class="admin-report-empty">No usage data yet.</span>';
            return;
          }
          const totals = reportData.totals || {};
          let html = '<div class="admin-report-title">Anthropic call ledger</div>';
          html += '<div class="admin-report-stats">';
          html += '<div class="admin-report-stat"><span class="label">Calls</span><span class="value">' + escapeAdminHtml(totals.callCount != null ? totals.callCount : 0) + '</span></div>';
          html += '<div class="admin-report-stat"><span class="label">Input tokens</span><span class="value">' + escapeAdminHtml(totals.inputTokens != null ? totals.inputTokens : 0) + '</span></div>';
          html += '<div class="admin-report-stat"><span class="label">Output tokens</span><span class="value">' + escapeAdminHtml(totals.outputTokens != null ? totals.outputTokens : 0) + '</span></div>';
          html += '<div class="admin-report-stat"><span class="label">Estimated cost</span><span class="value">' +
            escapeAdminHtml(formatAdminUsageUsd(totals.estimatedCostUsd, totals.estimatedCostAvailable !== false)) +
            '</span></div>';
          html += '</div>';
          html += '<div class="admin-report-grid">';
          html += renderAdminUsageSection('By bucket', reportData.byBucket || [], 'Bucket');
          html += renderAdminUsageSection('By household', reportData.byHousehold || [], 'Household');
          html += renderAdminUsageSection('By purpose', reportData.byPurpose || [], 'Purpose');
          html += renderAdminUsageSection('By web search setting', reportData.byWebSearchEnabled || [], 'Setting');
          html += renderAdminUsageSection('By actual web search usage', reportData.byWebSearchUsage || [], 'Usage');
          html += '</div>';
          const recentRows = Array.isArray(reportData.recentRows) ? reportData.recentRows : [];
          html += '<section class="admin-report-section" style="margin-top:12px;"><h5>Recent calls</h5>';
          if (recentRows.length === 0) {
            html += '<div class="admin-report-empty">No rows.</div>';
          } else {
            html +=
              '<div class="admin-report-table-wrap"><table class="admin-report-table">' +
              '<thead><tr><th>Time</th><th>Household</th><th>Purpose</th><th>Model</th><th class="num">In</th><th class="num">Out</th><th class="num">Cost</th></tr></thead><tbody>';
            for (const row of recentRows) {
              html +=
                '<tr><td>' +
                escapeAdminHtml(row.createdAt || '—') +
                '</td><td>' +
                escapeAdminHtml(row.householdName || row.householdId || '—') +
                '</td><td>' +
                escapeAdminHtml(row.callPurpose || '—') +
                '</td><td>' +
                escapeAdminHtml(row.model || '—') +
                '</td><td class="num">' +
                escapeAdminHtml(row.inputTokens != null ? row.inputTokens : 0) +
                '</td><td class="num">' +
                escapeAdminHtml(row.outputTokens != null ? row.outputTokens : 0) +
                '</td><td class="num">' +
                escapeAdminHtml(formatAdminUsageUsd(row.estimatedCostUsd, row.estimatedCostUsd != null)) +
                '</td></tr>';
            }
            html += '</tbody></table></div>';
          }
          html += '</section>';
          root.innerHTML = html;
        }

        async function refreshAdminUsageReport() {
          const msgEl = document.getElementById('admin-usage-msg');
          const reportEl = document.getElementById('admin-usage-report');
          const startEl = document.getElementById('admin-usage-start-date');
          const endEl = document.getElementById('admin-usage-end-date');
          const hhEl = document.getElementById('admin-usage-household-select');
          const wsSettingEl = document.getElementById('admin-usage-websearch-setting');
          const wsUsedEl = document.getElementById('admin-usage-websearch-used');
          if (!reportEl || !startEl || !endEl || !hhEl || !wsSettingEl || !wsUsedEl) return;
          if (msgEl) msgEl.textContent = 'Loading usage…';
          try {
            const qs = new URLSearchParams();
            if (startEl.value) qs.set('startDate', startEl.value);
            if (endEl.value) qs.set('endDate', endEl.value);
            if (hhEl.value && hhEl.value !== 'all') qs.set('householdId', hhEl.value);
            if (wsSettingEl.value && wsSettingEl.value !== 'all') qs.set('webSearchEnabled', wsSettingEl.value);
            if (wsUsedEl.value && wsUsedEl.value !== 'all') qs.set('usedWebSearch', wsUsedEl.value);
            const r = await fetch('/admin/usage-report?' + qs.toString());
            const data = await r.json().catch(() => ({}));
            if (!r.ok) {
              if (msgEl) msgEl.textContent = data.error || 'Failed to load usage.';
              return;
            }
            renderAdminUsageReport(data);
            if (msgEl) msgEl.textContent = '';
          } catch (e) {
            if (msgEl) msgEl.textContent = 'Failed to load usage.';
          }
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
                '<div class="settings-admin-usage-summary"><h5>Message usage (stored messages)</h5>' +
                '<div>Total messages (this household): <strong>' +
                (usage.totalMessages != null ? usage.totalMessages : 0) +
                '</strong></div>';
              html +=
                '<div style="margin-top:6px;">Latest message: <strong>' +
                (usage.latestMessageAt ? String(usage.latestMessageAt) : '—') +
                '</strong></div>';
              html += '<div style="margin-top:10px; font-size:12px; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-soft);">User messages by name</div>';
              const rows = usage.messagesByUser || [];
              if (rows.length === 0) {
                html += '<div class="admin-report-empty" style="margin-top:6px;">No user messages yet.</div>';
              } else {
                html += '<ul>';
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
              html += '</div>';
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
              td1.textContent = u.displayName;
              const td2 = document.createElement('td');
              td2.textContent = u.role;
              const td3 = document.createElement('td');
              const pinIn = document.createElement('input');
              pinIn.type = 'password';
              pinIn.placeholder = 'new PIN';
              pinIn.autocomplete = 'new-password';
              pinIn.style.maxWidth = '120px';
              pinIn.disabled = godModeReadOnly;
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.textContent = 'Set PIN';
              btn.style.marginLeft = '8px';
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
                    : mapServerReadOnlyErrorMessage(errBody.error) || 'Failed to update PIN.';
                }
                if (rr.ok) pinIn.value = '';
              });
              td3.appendChild(pinIn);
              td3.appendChild(btn);
              const td4 = document.createElement('td');
              if (!godModeReadOnly) {
                const viewAsBtn = document.createElement('button');
                viewAsBtn.type = 'button';
                viewAsBtn.textContent = 'View as';
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
                    const meR = await fetch('/me');
                    if (!meR.ok) {
                      showLogin();
                      return;
                    }
                    const meData = await meR.json();
                    await rehydrateAuthenticatedApp(meData, { forceChatTab: true, resetSessionView: true });
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
                (d.household.webSearchEnabled ? 'on' : 'off') +
                ' · Runtime: Smart only';
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
          const usageSel = document.getElementById('admin-usage-household-select');
          if (!listEl && !sel && !usageSel) return;
          try {
            const r = await fetch('/admin/households');
            if (!r.ok) return;
            const data = await r.json();
            const households = data.households || [];
            cachedAdminHouseholds = households;
            const prevSel = sel && sel.value;
            const prevUsageSel = usageSel && usageSel.value;
            if (listEl) {
              listEl.innerHTML = '';
              listEl.className = 'settings-admin-household-list';
              for (const hh of households) {
                const row = document.createElement('div');
                row.className = 'settings-admin-household-row';
                const main = document.createElement('div');
                main.className = 'settings-admin-household-row-main';
                const n =
                  hh.totalMessages != null && Number.isFinite(Number(hh.totalMessages))
                    ? Number(hh.totalMessages)
                    : 0;
                const msgLabel = n === 1 ? 'msg' : 'msgs';
                const name = document.createElement('strong');
                name.className = 'settings-admin-household-name';
                name.textContent = '#' + hh.id + ' — ' + hh.name;
                const meta = document.createElement('div');
                meta.className = 'settings-admin-household-meta';
                meta.textContent =
                  'Key ' +
                  hh.householdKey +
                  ' • ' +
                  n +
                  ' ' +
                  msgLabel +
                  ' • ' +
                  hh.anthropicStatusLabel;
                main.appendChild(name);
                main.appendChild(meta);
                const tags = document.createElement('div');
                tags.className = 'settings-admin-household-tags';
                const webTag = document.createElement('span');
                webTag.className =
                  'settings-admin-tag' + (hh.webSearchEnabled ? ' settings-admin-tag--on' : '');
                webTag.textContent = hh.webSearchEnabled ? 'Web search on' : 'Web search off';
                tags.appendChild(webTag);
                row.appendChild(main);
                row.appendChild(tags);
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
            if (usageSel) {
              usageSel.innerHTML = '';
              const allOpt = document.createElement('option');
              allOpt.value = 'all';
              allOpt.textContent = 'All households';
              usageSel.appendChild(allOpt);
              for (const hh of households) {
                const opt = document.createElement('option');
                opt.value = String(hh.id);
                opt.textContent = '#' + hh.id + ' — ' + hh.name;
                usageSel.appendChild(opt);
              }
              if (prevUsageSel && (prevUsageSel === 'all' || households.some((h) => String(h.id) === prevUsageSel))) {
                usageSel.value = prevUsageSel;
              } else {
                usageSel.value = 'all';
              }
            }
            await refreshAdminUsageReport();
          } catch (e) {}
        }

        function initializeAdminUsageFilters() {
          const startEl = document.getElementById('admin-usage-start-date');
          const endEl = document.getElementById('admin-usage-end-date');
          if (!startEl || !endEl) return;
          if (!endEl.value) {
            const end = new Date();
            endEl.value = end.toISOString().slice(0, 10);
          }
          if (!startEl.value) {
            const start = new Date();
            start.setDate(start.getDate() - 7);
            startEl.value = start.toISOString().slice(0, 10);
          }
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
          const persisted = data.conversation || [];
          const cid = Number(currentChatId);
          lastPersistedMessageCountByChatId.set(cid, persisted.length);

          chat.innerHTML = '';

          const epList = ephemeralExchangesByChatId.get(cid) || [];
          const sortedEp = [...epList].sort((a, b) => a.anchor - b.anchor || a.seq - b.seq);
          let pIdx = 0;
          let dbEmitted = 0;
          for (const ep of sortedEp) {
            while (dbEmitted < ep.anchor && pIdx < persisted.length) {
              const m = persisted[pIdx++];
              addMessage(m.role, m.name, m.content);
              dbEmitted++;
            }
            addMessage('user', ep.userName, ep.user);
            addMessage('assistant', 'KitchenBot', ep.assistant);
          }
          while (pIdx < persisted.length) {
            const m = persisted[pIdx++];
            addMessage(m.role, m.name, m.content);
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
              textContainer.className = 'g-text-wrap';
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

              const actions = document.createElement('div');
              actions.className = 'g-actions';

              const moveBtn = document.createElement('button');
              moveBtn.className = 'g-delete';
              moveBtn.textContent = 'Move to pantry';
              moveBtn.title = 'Move to Pantry';
              moveBtn.disabled = godModeReadOnly;
              moveBtn.addEventListener('click', async () => {
                try {
                  await fetch('/groceries/' + item.id + '/move-to-pantry', { method: 'POST' });
                  await Promise.all([loadGroceries(), loadPantry()]);
                } catch (e) {}
              });
              actions.appendChild(moveBtn);

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
              actions.appendChild(del);
              li.appendChild(actions);

              const targetList = groceryLists[item.section] || groceryLists.other;
              targetList.appendChild(li);
            }

            groceryClearButton.style.display = isCurrentUserOwner ? '' : 'none';
          } catch (e) {
            // ignore for now
          }
        }

        async function loadPantry() {
          try {
            const response = await fetch('/pantry');
            if (!response.ok) return;
            const data = await response.json();

            Object.values(pantryLists).forEach((list) => {
              list.innerHTML = '';
            });

            for (const item of data.items || []) {
              const li = document.createElement('li');
              li.className = 'g-item';
              li.dataset.id = item.id;
              li.dataset.section = item.section;

              const left = document.createElement('div');
              left.className = 'g-left';

              const textContainer = document.createElement('div');
              textContainer.className = 'g-text-wrap';
              const main = document.createElement('div');
              main.className = 'g-text-main';
              main.textContent = item.name;
              textContainer.appendChild(main);
              if (item.amount) {
                const amount = document.createElement('div');
                amount.className = 'g-text-amount';
                amount.textContent = item.amount || '';
                textContainer.appendChild(amount);
              }
              left.appendChild(textContainer);
              li.appendChild(left);

              const actions = document.createElement('div');
              actions.className = 'g-actions';

              const moveBtn = document.createElement('button');
              moveBtn.className = 'g-delete';
              moveBtn.textContent = 'Move to grocery';
              moveBtn.title = 'Move to Grocery List';
              moveBtn.disabled = godModeReadOnly;
              moveBtn.addEventListener('click', async () => {
                try {
                  await fetch('/pantry/' + item.id + '/move-to-groceries', { method: 'POST' });
                  await Promise.all([loadPantry(), loadGroceries()]);
                } catch (e) {}
              });
              actions.appendChild(moveBtn);

              const del = document.createElement('button');
              del.className = 'g-delete';
              del.textContent = '×';
              del.disabled = godModeReadOnly;
              del.addEventListener('click', async () => {
                try {
                  await fetch('/pantry/' + item.id, { method: 'DELETE' });
                  await loadPantry();
                } catch (e) {}
              });
              actions.appendChild(del);
              li.appendChild(actions);

              const targetList = pantryLists[item.section] || pantryLists.other_pantry;
              targetList.appendChild(li);
            }
          } catch (e) {
            // ignore for now
          }
        }

        function setGroceriesSubview(view) {
          currentGroceriesSubview = view === 'pantry' ? 'pantry' : 'list';
          if (grocerySubtabList) grocerySubtabList.classList.toggle('settings-subtab-active', currentGroceriesSubview === 'list');
          if (grocerySubtabPantry) grocerySubtabPantry.classList.toggle('settings-subtab-active', currentGroceriesSubview === 'pantry');
          if (grocerySubviewList) grocerySubviewList.style.display = currentGroceriesSubview === 'list' ? '' : 'none';
          if (grocerySubviewPantry) grocerySubviewPantry.style.display = currentGroceriesSubview === 'pantry' ? '' : 'none';
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
              closeSidebarAndGoToChatTab();
              renderChats();
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
            await rehydrateAuthenticatedApp(data, { forceChatTab: true, resetSessionView: true });
          } catch (error) {
            showLogin();
          }
        }

        async function rehydrateAuthenticatedApp(meData, opts = {}) {
          const forceChatTab = opts.forceChatTab !== false;
          const resetSessionView = opts.resetSessionView !== false;
          teardownRealtimeUi();
          if (resetSessionView) {
            currentChatId = null;
            chatsCache = [];
            chat.innerHTML = '';
            sidebar.classList.remove('open');
            sidebarBackdrop.classList.remove('open');
            lastPersistedMessageCountByChatId.clear();
            ephemeralExchangesByChatId.clear();
            nextEphemeralSeqByChatId.clear();
          }
          currentUserName = meData.name;
          currentHouseholdId = meData.householdId != null ? Number(meData.householdId) : null;
          currentUserId = meData.userId != null ? Number(meData.userId) : null;
          isCurrentUserOwner = !!meData.isOwner;
          applyGodModeFromMe(meData);
          syncMemoriesWrapVisibility();
          rebuildDisplayNameToColorFromMeChatColors(meData.chatColors);
          showApp(meData.name);
          if (forceChatTab) setActiveTab('chat');
          await loadChatsAndEnsureOne();
          await loadHistory();
          connectTypingWs();
          refreshOwnerSettingsTab();
        }

        tabChat.addEventListener('click', () => {
          setActiveTab('chat');
        });

        tabGroceries.addEventListener('click', async () => {
          setActiveTab('groceries');
          await Promise.all([loadGroceries(), loadPantry()]);
        });

        if (grocerySubtabList) {
          grocerySubtabList.addEventListener('click', () => {
            setGroceriesSubview('list');
          });
        }
        if (grocerySubtabPantry) {
          grocerySubtabPantry.addEventListener('click', () => {
            setGroceriesSubview('pantry');
          });
        }

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
        initializeAdminUsageFilters();
        const adminUsageRefresh = document.getElementById('admin-usage-refresh');
        if (adminUsageRefresh) {
          adminUsageRefresh.addEventListener('click', async () => {
            await refreshAdminUsageReport();
          });
        }
        const adminUsageHouseholdSelect = document.getElementById('admin-usage-household-select');
        if (adminUsageHouseholdSelect) {
          adminUsageHouseholdSelect.addEventListener('change', () => {
            refreshAdminUsageReport();
          });
        }
        const adminUsageStartDate = document.getElementById('admin-usage-start-date');
        if (adminUsageStartDate) {
          adminUsageStartDate.addEventListener('change', () => {
            refreshAdminUsageReport();
          });
        }
        const adminUsageEndDate = document.getElementById('admin-usage-end-date');
        if (adminUsageEndDate) {
          adminUsageEndDate.addEventListener('change', () => {
            refreshAdminUsageReport();
          });
        }
        const adminUsageWebSearchSetting = document.getElementById('admin-usage-websearch-setting');
        if (adminUsageWebSearchSetting) {
          adminUsageWebSearchSetting.addEventListener('change', () => {
            refreshAdminUsageReport();
          });
        }
        const adminUsageWebSearchUsed = document.getElementById('admin-usage-websearch-used');
        if (adminUsageWebSearchUsed) {
          adminUsageWebSearchUsed.addEventListener('change', () => {
            refreshAdminUsageReport();
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
                if (msgEl) msgEl.textContent = mapServerReadOnlyErrorMessage(errBody.error) || 'Save failed';
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
                if (msgEl) msgEl.textContent = mapServerReadOnlyErrorMessage(errBody.error) || 'Save failed';
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
            clearEntityMemoryUiMessage();
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
                if (msgEl) msgEl.textContent = mapServerReadOnlyErrorMessage(errBody.error) || 'Save failed';
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
                if (msgEl) msgEl.textContent = mapServerReadOnlyErrorMessage(data.error) || 'Failed';
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
            clearEntityMemoryUiMessage();
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
                if (msgEl) msgEl.textContent = mapServerReadOnlyErrorMessage(data.error) || 'Failed';
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
                if (msgEl) msgEl.textContent = mapServerReadOnlyErrorMessage(errBody.error) || 'Could not open demo view.';
                return;
              }
              const meR = await fetch('/me');
              if (!meR.ok) {
                showLogin();
                return;
              }
              const meData = await meR.json();
              await rehydrateAuthenticatedApp(meData, { forceChatTab: true, resetSessionView: true });
            } catch (e) {
              if (msgEl) msgEl.textContent = 'Request failed.';
            }
          });
        }

        const memorySaveButton = document.getElementById('my-settings-memory-save');
        const memoryCancelButton = document.getElementById('my-settings-memory-cancel-edit');
        if (memorySaveButton) {
          memorySaveButton.addEventListener('click', async () => {
            clearEntityMemoryUiMessage();
            const typeIn = document.getElementById('my-settings-memory-type');
            const labelIn = document.getElementById('my-settings-memory-label');
            const summaryIn = document.getElementById('my-settings-memory-summary');
            const memMsg = document.getElementById('my-settings-entity-memories-msg');
            const memoryType = typeIn && String(typeIn.value).trim();
            const label = labelIn && String(labelIn.value).trim();
            const summary = summaryIn && String(summaryIn.value).trim();
            if (!memoryType || !label || !summary) {
              if (memMsg) memMsg.textContent = 'Type, label, and summary are required.';
              return;
            }
            try {
              const r = await fetch('/settings/household/memory-notes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  id: editingSmartMemoryId,
                  memoryType,
                  label,
                  summary,
                  noteIndex: editingSmartMemoryNoteIndex,
                }),
              });
              const errBody = await r.json().catch(() => ({}));
              if (memMsg) {
                memMsg.textContent = r.ok ? 'Saved.' : mapServerReadOnlyErrorMessage(errBody.error) || 'Save failed';
              }
              if (r.ok) {
                resetSmartMemoryEditForm();
                await loadMemoryNotesEditor();
              }
            } catch (e) {
              if (memMsg) memMsg.textContent = 'Request failed.';
            }
          });
        }
        if (memoryCancelButton) {
          memoryCancelButton.addEventListener('click', () => {
            clearEntityMemoryUiMessage();
            resetSmartMemoryEditForm();
          });
        }
        const memoryTypeInputEl = document.getElementById('my-settings-memory-type');
        const memoryLabelInputEl = document.getElementById('my-settings-memory-label');
        const memorySummaryInputEl = document.getElementById('my-settings-memory-summary');
        const onMemoryFieldInput = () => clearEntityMemoryUiMessage();
        if (memoryTypeInputEl) memoryTypeInputEl.addEventListener('input', onMemoryFieldInput);
        if (memoryLabelInputEl) memoryLabelInputEl.addEventListener('input', onMemoryFieldInput);
        if (memorySummaryInputEl) memorySummaryInputEl.addEventListener('input', onMemoryFieldInput);

        const defaultsSaveButton = document.getElementById('my-settings-defaults-save');
        if (defaultsSaveButton) {
          defaultsSaveButton.addEventListener('click', async () => {
            clearHouseholdDefaultsUiMessage();
            const portionsEl = document.getElementById('my-settings-defaults-portions');
            const styleEl = document.getElementById('my-settings-defaults-style');
            const msgEl = document.getElementById('my-settings-defaults-msg');
            const defaultDinnerPortions = portionsEl && String(portionsEl.value).trim() ? Number(portionsEl.value) : null;
            const weeknightCookingStyle = styleEl && String(styleEl.value).trim() ? String(styleEl.value).trim() : null;
            try {
              const r = await fetch('/settings/household/defaults', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  defaultDinnerPortions,
                  weeknightCookingStyle,
                }),
              });
              const errBody = await r.json().catch(() => ({}));
              if (msgEl) {
                msgEl.textContent = r.ok ? 'Saved.' : mapServerReadOnlyErrorMessage(errBody.error) || 'Save failed';
              }
              if (r.ok) {
                await loadHouseholdDefaultsEditor();
              }
            } catch (e) {
              if (msgEl) msgEl.textContent = 'Request failed.';
            }
          });
        }
        const defaultsPortionsInputEl = document.getElementById('my-settings-defaults-portions');
        const defaultsStyleInputEl = document.getElementById('my-settings-defaults-style');
        const onDefaultsFieldInput = () => clearHouseholdDefaultsUiMessage();
        if (defaultsPortionsInputEl) defaultsPortionsInputEl.addEventListener('input', onDefaultsFieldInput);
        if (defaultsStyleInputEl) defaultsStyleInputEl.addEventListener('input', onDefaultsFieldInput);

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
            closeSidebarAndGoToChatTab();
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

        function buildClientTimeContext() {
          const now = new Date();
          const offsetMinutes = -now.getTimezoneOffset();
          const sign = offsetMinutes >= 0 ? '+' : '-';
          const absMinutes = Math.abs(offsetMinutes);
          const offsetHours = String(Math.floor(absMinutes / 60)).padStart(2, '0');
          const offsetRemainder = String(absMinutes % 60).padStart(2, '0');
          const isoLocal =
            now.getFullYear() +
            '-' +
            String(now.getMonth() + 1).padStart(2, '0') +
            '-' +
            String(now.getDate()).padStart(2, '0') +
            'T' +
            String(now.getHours()).padStart(2, '0') +
            ':' +
            String(now.getMinutes()).padStart(2, '0') +
            ':' +
            String(now.getSeconds()).padStart(2, '0') +
            sign +
            offsetHours +
            ':' +
            offsetRemainder;
          return {
            localDateTime: isoLocal,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
            localDayName: now.toLocaleDateString(undefined, { weekday: 'long' }),
            localHour: now.getHours(),
          };
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
            try {
              const meR = await fetch('/me');
              if (meR.ok) {
                const meData = await meR.json();
                await rehydrateAuthenticatedApp(meData, { forceChatTab: true, resetSessionView: true });
                return;
              }
            } catch (e) {}
            const resolvedName = data.displayName ?? data.name ?? displayName;
            await rehydrateAuthenticatedApp(
              {
                name: resolvedName,
                householdId: data.householdId,
                userId: data.userId,
                isOwner: data.isOwner,
                chatColors: {},
                isImpersonating: false,
                impersonationReadOnly: false,
              },
              { forceChatTab: true, resetSessionView: true }
            );
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
              const meR = await fetch('/me');
              if (!meR.ok) {
                showLogin();
                return;
              }
              const meData = await meR.json();
              await rehydrateAuthenticatedApp(meData, { forceChatTab: true, resetSessionView: true });
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

          const ephemeralAnchorPersistedCount =
            lastPersistedMessageCountByChatId.get(Number(currentChatId)) ?? 0;

          try {
            const response = await fetch('/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                prompt,
                name: speaker,
                chatId: currentChatId,
                timeContext: buildClientTimeContext(),
              })
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

            const serverActionManaged = response.headers.get('X-KitchenBot-Server-Action-Managed') === '1';

            const chatResponseEphemeral = response.headers.get('X-KitchenBot-Ephemeral') === '1';

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

            if (chatResponseEphemeral && currentChatId != null) {
              const cid = Number(currentChatId);
              const seq = (nextEphemeralSeqByChatId.get(cid) || 0) + 1;
              nextEphemeralSeqByChatId.set(cid, seq);
              const list = ephemeralExchangesByChatId.get(cid) || [];
              list.push({
                anchor: ephemeralAnchorPersistedCount,
                seq,
                userName: speaker,
                user: prompt,
                assistant: fullReply,
              });
              ephemeralExchangesByChatId.set(cid, list);
            }

            try {
              await loadHistory();
            } catch (e) {}
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
          teardownRealtimeUi();
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
          lastPersistedMessageCountByChatId.clear();
          ephemeralExchangesByChatId.clear();
          nextEphemeralSeqByChatId.clear();
        });

        groceryRefreshButton.addEventListener('click', async () => {
          await Promise.all([loadGroceries(), loadPantry()]);
        });

        if (groceryAddSubmit) {
          groceryAddSubmit.addEventListener('click', async () => {
            const name = groceryAddName && groceryAddName.value.trim();
            if (!name) return;
            const amount = groceryAddAmount && groceryAddAmount.value.trim();
            const section =
              groceryAddSection ? groceryAddSection.value : '';
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
              if (groceryAddSection) groceryAddSection.value = '';
              await loadGroceries();
              if (groceryAddName) groceryAddName.focus();
            } catch (e) {}
          });
        }

        if (pantryAddSubmit) {
          pantryAddSubmit.addEventListener('click', async () => {
            const name = pantryAddName && pantryAddName.value.trim();
            if (!name) return;
            const amount = pantryAddAmount && pantryAddAmount.value.trim();
            const section =
              pantryAddSection && pantryAddSection.value ? pantryAddSection.value : 'other';
            try {
              const r = await fetch('/pantry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  items: [{ name, section, amount: amount || '' }],
                }),
              });
              if (!r.ok) return;
              if (pantryAddAmount) pantryAddAmount.value = '';
              if (pantryAddName) pantryAddName.value = '';
              if (pantryAddSection) pantryAddSection.value = '';
              await loadPantry();
              if (pantryAddName) pantryAddName.focus();
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
    const canManageHouseholdSettings =
      currentUser.role === 'owner' || (await isGlobalAdminUser(req.userId));
    const users = await listHouseholdUsers(req.householdId);
    const defaults = await getHouseholdDefaults(req.householdId);
    return res.json({
      household: {
        id: h.id,
        name: h.name,
        key: h.household_key,
        runtimeEnabled: true,
      },
      currentUser: {
        id: currentUser.id,
        displayName: currentUser.display_name,
        role: currentUser.role,
      },
      defaults,
      canManageHouseholdSettings,
      users: users.map((u) => ({
        id: u.id,
        displayName: u.display_name,
        role: u.role,
        chatColor: normalizeChatColor(u.chat_color),
      })),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.get('/settings/household/defaults', requireHousehold, requireAuth, requireOwner, async (req, res) => {
  try {
    const defaults = await getHouseholdDefaults(req.householdId);
    return res.json({ defaults });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load household defaults' });
  }
});

app.post(
  '/settings/household/defaults',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
  requireOwner,
  async (req, res) => {
    try {
      const defaults = await saveHouseholdDefaults(req.householdId, {
        defaultDinnerPortions: req.body.defaultDinnerPortions,
        weeknightCookingStyle: req.body.weeknightCookingStyle,
      });
      return res.json({ ok: true, defaults });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to save household defaults' });
    }
  }
);

app.get('/settings/household/memory-notes', requireHousehold, requireAuth, requireOwner, async (req, res) => {
  try {
    const rows = await listKbMemories(req.householdId);
    res.json({
      memories: rows.map((row) => {
        const memoryType = normalizeMemoryType(row.memoryType);
        const notes = normalizePersonNotes(row?.attributes?.notes || []);
        return {
          id: row.id,
          memoryType,
          label: row.label,
          summary: memoryType === 'person' ? buildPersonSummary(notes) : row.summary,
          attributes: memoryType === 'person' ? { ...(row.attributes || {}), notes } : row.attributes,
          sourceKind: row.sourceKind,
          updatedAt: row.updatedAt,
        };
      }),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load saved memories' });
  }
});

app.post(
  '/settings/household/memory-notes',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
  requireOwner,
  async (req, res) => {
    try {
      const id = req.body.id != null && Number.isFinite(Number(req.body.id)) ? Number(req.body.id) : null;
      const noteIndex =
        req.body.noteIndex != null && Number.isFinite(Number(req.body.noteIndex)) ? Number(req.body.noteIndex) : null;
      if (id && req.body.memoryType === 'person' && noteIndex != null) {
        const rows = await listKbMemories(req.householdId);
        const existing = rows.find((row) => Number(row.id) === id);
        if (!existing) return res.status(404).json({ error: 'Memory not found' });
        const currentNotes = normalizePersonNotes(existing?.attributes?.notes || []);
        if (noteIndex < 0 || noteIndex >= currentNotes.length) {
          return res.status(400).json({ error: 'Invalid saved note index' });
        }
        currentNotes[noteIndex] = { text: String(req.body.summary || '').trim() };
        const record = buildMemoryRecordForStorage({
          type: 'person',
          label: req.body.label || existing.label,
          attributes: { ...(existing.attributes || {}), notes: currentNotes },
        });
        if (!record) return res.status(400).json({ error: 'Label and note are required' });
        await saveKbMemory(req.householdId, record, {
          id,
          sourceKind: 'manual',
        });
        return res.json({ ok: true });
      }
      const record = buildMemoryRecordForStorage({
        type: req.body.memoryType,
        label: req.body.label,
        summary: req.body.summary,
        attributes: req.body.attributes,
      });
      if (!record) {
        return res.status(400).json({ error: 'Type, label, and summary are required' });
      }
      if (id) {
        await saveKbMemory(req.householdId, record, {
          id,
          sourceKind: 'manual',
        });
        return res.json({ ok: true });
      }
      const prior = await getKbMemoryByTypeAndLabel(
        req.householdId,
        record.memoryType,
        record.normalizedLabel
      );
      const merged = prior ? mergeMemoryRecord(prior, record) : record;
      await saveKbMemory(req.householdId, merged, {
        id: prior?.id ?? null,
        sourceKind: 'manual',
      });
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to save memory' });
    }
  }
);

app.delete(
  '/settings/household/memory-notes/:id',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
  requireOwner,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: 'Invalid memory id' });
      }
      const noteIndex =
        req.query.noteIndex != null && Number.isFinite(Number(req.query.noteIndex)) ? Number(req.query.noteIndex) : null;
      if (noteIndex != null) {
        const rows = await listKbMemories(req.householdId);
        const existing = rows.find((row) => Number(row.id) === id);
        if (!existing) return res.status(404).json({ error: 'Memory not found' });
        if (normalizeMemoryType(existing.memoryType) !== 'person') {
          return res.status(400).json({ error: 'Only people support note-level deletion' });
        }
        const currentNotes = normalizePersonNotes(existing?.attributes?.notes || []);
        if (noteIndex < 0 || noteIndex >= currentNotes.length) {
          return res.status(400).json({ error: 'Invalid saved note index' });
        }
        const nextNotes = currentNotes.filter((_, idx) => idx !== noteIndex);
        if (nextNotes.length === 0) {
          await deleteKbMemory(req.householdId, id);
          return res.json({ ok: true });
        }
        const record = buildMemoryRecordForStorage({
          type: 'person',
          label: existing.label,
          attributes: { ...(existing.attributes || {}), notes: nextNotes },
        });
        if (!record) return res.status(400).json({ error: 'Could not rebuild person memory' });
        await saveKbMemory(req.householdId, record, {
          id,
          sourceKind: 'manual',
        });
        return res.json({ ok: true });
      }
      await deleteKbMemory(req.householdId, id);
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to delete memory' });
    }
  }
);

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
        runtimeEnabled: true,
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
    const conversationForClient = conversation.map((m) => ({
      ...m,
      content: stripStoredMessageContentForDisplay(m.content),
    }));
    res.json({ conversation: conversationForClient });
  } catch (error) {
    console.error(error);
    res.status(500).json({ conversation: [] });
  }
});

registerKitchenInventoryRoutes(app, {
  middleware: {
    requireHousehold,
    requireAuth,
    requireNotImpersonatingReadOnly,
    requireOwner,
  },
  db: {
    getGroceryItems,
    getPantryItems,
    addGroceryItems,
    addPantryItems,
    updateGroceryItem,
    deleteGroceryItem,
    deletePantryItem,
    clearGroceryItems,
    findPantryItemById,
  },
  inventory: createBoundInventoryServices(),
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

      const inventoryServices = createBoundInventoryServices();

      const kbDeps = buildKbRuntimeDeps({
        ANTHROPIC_KEY_USER_MESSAGE,
        addMessage,
        broadcastToChat,
        clearChatRuntimeState,
        getAnthropicClient,
        buildKbContextPacket,
        incrementUserMessageCountForSender,
        isAnthropicSdkAuthOrKeyError,
        mergeGroceryItemsFromAi: inventoryServices.mergeGroceryItemsFromAi,
        normalizeGroceryItemsForPost: inventoryServices.normalizeGroceryItemsForPost,
        normalizeInventoryNameKey: inventoryServices.normalizeInventoryNameKey,
        pruneStaleGroceryItemsForChat,
        stripStoredMessageContentForDisplay,
        clearGroceryItems,
      });

      return await handleKbChatTurn({
        req,
        res,
        name,
        chatId,
        prompt,
        deps: kbDeps,
      });
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
  }
);

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
})().catch((error) => {
  console.error('KitchenBot startup failed:', error?.message || error);
  process.exit(1);
});
