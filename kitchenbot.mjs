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
  addGroceryItems,
  addPantryItems,
  getPantryItems,
  findPantryItemById,
  getGroceryItems,
  updateGroceryItemAmount,
  updateGroceryItemProbablyPantry,
  backfillGroceryItemSourceChatIfSafe,
  updateGroceryItem,
  deleteGroceryItem,
  deletePantryItem,
  clearGroceryItems,
  getMealPlanItems,
  updateMealPlanItem,
  deleteMealPlanItem,
  addChatAttachment,
  getChatAttachmentsForChat,
  getChatAttachmentById,
  deleteChatAttachments,
  listAllHouseholdsSummary,
  updateHouseholdUserChatColor,
  updateHouseholdUserPalette,
  runMigrations,
  normalizeChatColor,
  normalizePalette,
  needsBootstrap,
  bootstrapFirstHousehold,
  createHouseholdWithInitialOwner,
  isGlobalAdminUser,
  getFirstHouseholdId,
  getHouseholdById,
  deleteHousehold,
  getHouseholdByKey,
  listHouseholdUsers,
  listPersonProfiles,
  getPersonProfile,
  updatePersonProfile,
  removePersonProfileValue,
  getUserByHouseholdAndDisplayName,
  getHouseholdUserById,
  createHouseholdUser,
  updateHouseholdUserPin,
  updateHouseholdAnthropicSettings,
  setHouseholdAnthropicMode,
  setHouseholdAnthropicApiKey,
  verifyPin,
  getHouseholdMessageStats,
  getUserMessageCountsInHousehold,
  listCookbookEntries,
  listCookbookSourceBookTitles,
  getCookbookEntryById,
  saveCookbookEntry,
  deleteCookbookEntry,
  getHouseholdDefaults,
  saveHouseholdDefaults,
  clearChatRuntimeState,
  getAnthropicUsageLedgerAllRows,
} from './db.mjs';
import { handleKbChatTurn } from './kb-runtime.mjs';
import { respondWithKbErrorReply } from './kb-reply.mjs';
import { buildKbContextPacket } from './kb-memory-store.mjs';
import {
  buildCookbookRecordForStorage,
  COOKBOOK_CATEGORY_OPTIONS,
  getCookbookCategoryLabel,
  getCookbookDisplayProvenance,
  getCookbookDisplaySource,
  getCookbookDisplayTitle,
  isFailedCookbookPlaceholder,
} from './cookbook-store.mjs';
import {
  buildAnthropicUsageReport,
  classifyAnthropicUsageFunction,
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
import {
  normalizeAdminHouseholdSummary,
  normalizeAdminUsage,
  normalizeAdminUsers,
} from './admin-households.mjs';
import { DEFAULT_ASSISTANT_NAME } from './kb-persona.mjs';
import {
  getRecipeImportDraft,
  importRecipeFromImages,
  importRecipeFromUrl,
  createManualRecipeImportDraft,
  saveRecipeImportDraftToCookbook,
  updateRecipeImportDraft,
} from './recipe-importer-service.mjs';
import 'dotenv/config';
import os from 'os';
import http from 'http';
import { pathToFileURL } from 'url';
import express from 'express';
import multer from 'multer';
import { createClient } from 'redis';
import { WebSocketServer } from 'ws';
import Anthropic from '@anthropic-ai/sdk';
import crypto from 'crypto';
import { renderClientBootTags, renderHtmlTemplate, renderStylesheetLink } from './app-shell.mjs';

async function incrementUserMessageCountForSender(req) {
  void req;
}

function safeTrim(text) {
  return String(text ?? '').trim();
}

const app = express();
const port = process.env.PORT || 3000;
const server = http.createServer(app);
const recipeImporterUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 8,
    fileSize: 10 * 1024 * 1024,
  },
});

function renderRecipeImporterPage({ knownCookbookSources = [] } = {}) {
  const escapeHtml = (value) =>
    String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const sourceOptions = Array.from(
    new Set(
      (Array.isArray(knownCookbookSources) ? knownCookbookSources : [])
        .map((value) => safeTrim(value))
        .filter(Boolean)
    )
  )
    .sort((a, b) => a.localeCompare(b))
    .map((title) => `<option value="${escapeHtml(title)}">${escapeHtml(title)}</option>`)
    .join('');
  return renderHtmlTemplate('recipe-importer', {
    stylesheet: renderStylesheetLink('recipe-importer.css'),
    sourceOptions,
    clientBoot: renderClientBootTags(
      { cookbookCategoryOptions: COOKBOOK_CATEGORY_OPTIONS, knownCookbookSources },
      { scriptSrc: '/recipe-importer.js' }
    ),
  });
}

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
  // Web search is on for EVERY household — the per-household gate was removed 2026-07-24
  // (Rob: "give web search to every account"). The brain still decides WHEN to actually use it.
  // The web_search_enabled column is left inert so the gate could be restored later if wanted.
  const webSearchEnabled = true;
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

function describeAnthropicHouseholdStatus(household) {
  const mode = household?.anthropic_key_mode || 'shared';
  const hasKey = !!(household?.anthropic_api_key && String(household.anthropic_api_key).trim());
  if (mode === 'shared') {
    return {
      mode,
      hasKey,
      usingSharedKey: true,
      statusText: "This household is using Rob's Anthropic key.",
      statusBrief: 'Using shared key',
      keyStatus: 'shared',
    };
  }
  if (hasKey) {
    return {
      mode,
      hasKey,
      usingSharedKey: false,
      statusText: 'Household key configured.',
      statusBrief: 'Household key configured',
      keyStatus: 'household_configured',
    };
  }
  return {
    mode,
    hasKey,
    usingSharedKey: false,
    statusText: 'Household key missing.',
    statusBrief: 'Household key missing',
    keyStatus: 'household_missing',
  };
}

function buildAnthropicUsageReportResponse(rows, households, options = {}) {
  const householdNameById = new Map((households || []).map((hh) => [Number(hh.id), hh.name]));
  const report = buildAnthropicUsageReport(rows);
  const recentRows = rows.slice(0, 100).map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    householdId: Number(row.household_id),
    householdName: householdNameById.get(Number(row.household_id)) || `Household ${row.household_id}`,
    chatId: row.chat_id != null ? Number(row.chat_id) : null,
    turnId: row.turn_id ? String(row.turn_id) : '',
    actionCapability: row.action_capability ? String(row.action_capability) : '',
    actionQuery: row.action_query ? String(row.action_query) : '',
    promptHash: row.prompt_hash ? String(row.prompt_hash) : '',
    promptExcerpt: row.prompt_excerpt ? String(row.prompt_excerpt) : '',
    runtimeEnabled: Number(row.runtime_enabled ?? 1) === 1,
    callSurface: row.call_surface,
    callPurpose: row.call_purpose,
    callFunction: classifyAnthropicUsageFunction(row.call_purpose),
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

  return {
    filtersApplied: options.filtersApplied || {},
    totals: report.totals,
    byFunction: report.byFunction,
    byHousehold,
    byPurpose: report.byPurpose,
    recentRows,
    ...(options.household ? { household: options.household } : {}),
  };
}

function collapseUsagePreviewText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function truncateUsagePreviewText(value, limit = 80) {
  const text = collapseUsagePreviewText(value);
  if (!text) return '';
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - 1)).trimEnd() + '…';
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
    updateGroceryItemProbablyPantry,
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

export async function requireHousehold(req, res, next) {
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
export function signToken(payload) {
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

export function verifyToken(token) {
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

export async function requireAuth(req, res, next) {
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
const ANTHROPIC_RUNTIME_USER_MESSAGE = 'There’s a problem with Anthropic right now. Please try again in a bit.';

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

function getAnthropicUserFacingErrorMessage(err) {
  if (!err || typeof err !== 'object') return '';
  if (isAnthropicSdkAuthOrKeyError(err)) return ANTHROPIC_KEY_USER_MESSAGE;
  const status = Number(err.status ?? err.statusCode ?? err.response?.status);
  const type = String(err.error?.type ?? err.type ?? '').trim().toLowerCase();
  const message = String(err.error?.message ?? err.message ?? '').trim();
  if (
    status === 429 ||
    status === 529 ||
    type === 'rate_limit_error' ||
    type === 'overloaded_error' ||
    /rate\s*limit|overloaded|capacity|quota|credit balance|usage limit|too many requests|temporarily unavailable/i.test(message)
  ) {
    return ANTHROPIC_RUNTIME_USER_MESSAGE;
  }
  return '';
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

// Security headers. Hash-based CSP with NO 'unsafe-inline' for scripts: the only inline
// script is the static palette no-flash bootstrap (whitelisted by its sha256), and marked +
// DOMPurify are vendored under /vendor (script-src 'self'), so no CDN origin is trusted.
// If the inline palette-boot script changes, recompute this hash.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'sha256-2WlGCYkFT0X36gYjviA+w6amZw2frQQIyYL0r90p5SE='",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.use(express.json({ limit: '12mb' })); // headroom for downscaled base64 image attachments on /chat
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
    const enriched = await Promise.all(
      households.map(async (household) => {
        const stats = await getHouseholdMessageStats(household.id);
        return normalizeAdminHouseholdSummary(household, stats);
      })
    );
    return res.json({ households: enriched });
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
    const [stats, messagesByUser, users] = await Promise.all([
      getHouseholdMessageStats(id),
      getUserMessageCountsInHousehold(id),
      listHouseholdUsers(id),
    ]);
    return res.json({
      household: {
        ...normalizeAdminHouseholdSummary(hh, stats),
        users: normalizeAdminUsers(users),
      },
      usage: normalizeAdminUsage(stats, messagesByUser),
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
    };

    const [rows, households] = await Promise.all([
      getAnthropicUsageLedgerAllRows(filters),
      listAllHouseholdsSummary(),
    ]);
    return res.json(
      buildAnthropicUsageReportResponse(rows, households, {
        filtersApplied: {
          householdId,
          startDate: req.query.startDate ? String(req.query.startDate) : null,
          endDate: req.query.endDate ? String(req.query.endDate) : null,
          callPurpose: filters.callPurpose || null,
          callSurface: filters.callSurface || null,
          webSearchEnabled: filters.webSearchEnabledAtCall,
        },
      })
    );
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.get('/settings/household/anthropic-usage', requireHousehold, requireAuth, async (req, res) => {
  try {
    const startDate = isoDayStartUtc(req.query.startDate);
    const endDateExclusive = isoNextDayStartUtc(req.query.endDate);
    const filters = {
      householdId: req.householdId,
      startDate,
      endDate: endDateExclusive,
      webSearchEnabledAtCall: normalizeUsageFilterBoolean(req.query.webSearchEnabled),
    };
    const [rows, households, household] = await Promise.all([
      getAnthropicUsageLedgerAllRows(filters),
      listAllHouseholdsSummary(),
      getHouseholdById(req.householdId),
    ]);
    if (!household) {
      return res.status(404).json({ error: 'Household not found' });
    }
    const anthropic = describeAnthropicHouseholdStatus(household);
    return res.json(
      buildAnthropicUsageReportResponse(rows, households, {
        filtersApplied: {
          householdId: req.householdId,
          startDate: req.query.startDate ? String(req.query.startDate) : null,
          endDate: req.query.endDate ? String(req.query.endDate) : null,
          webSearchEnabled: filters.webSearchEnabledAtCall,
        },
        household: {
          id: household.id,
          name: household.name,
          key: household.household_key,
          anthropicKeyMode: anthropic.mode,
          webSearchEnabled: Number(household.web_search_enabled) === 1,
          usingSharedKey: anthropic.usingSharedKey,
          statusText: anthropic.statusText,
          statusBrief: anthropic.statusBrief,
          keyStatus: anthropic.keyStatus,
        },
      })
    );
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

// God Mode: permanently delete a household + all its data (cascade). Cannot delete the household
// you are currently signed into (avoids bricking your own session).
app.delete(
  '/admin/households/:id',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
  requireGlobalAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid household id' });
      if (id === Number(req.householdId)) {
        return res.status(400).json({ error: 'You cannot delete the household you are currently signed into.' });
      }
      const h = await getHouseholdById(id);
      if (!h) return res.status(404).json({ error: 'Household not found' });
      await deleteHousehold(id);
      return res.json({ ok: true, deletedId: id, deletedName: h.name });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: e.message || 'Failed to delete household' });
    }
  }
);

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
  res.send(
    renderHtmlTemplate('app', {
      stylesheet: renderStylesheetLink('app.css'),
      clientBoot: renderClientBootTags(
        { cookbookCategoryOptions: COOKBOOK_CATEGORY_OPTIONS },
        { asModule: true }
      ),
    })
  );
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
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

export async function handleGetMe(req, res) {
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
      palette: normalizePalette(me?.palette),
      householdName,
      householdKey: h ? h.household_key : '',
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
}

app.get('/me', requireHousehold, requireAuth, handleGetMe);

// Self-service: each user sets their OWN UI palette (not owner-gated, unlike chat_color).
app.post('/settings/me/palette', requireHousehold, requireAuth, requireNotImpersonatingReadOnly, async (req, res) => {
  try {
    const palette = normalizePalette(req.body?.palette);
    await updateHouseholdUserPalette(req.householdId, req.userId, palette);
    return res.json({ ok: true, palette });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Family food profiles — visible + editable by any household member (collaborative, not owner-gated).
// The brain's person.profile.* tools and this UI write to the same person_profiles store.
const FAMILY_PROFILE_FIELDS = new Set(['acceptedFoods', 'rejectedFoods', 'allergies', 'notes']);

app.get('/family/profiles', requireHousehold, requireAuth, async (req, res) => {
  try {
    const [users, profiles] = await Promise.all([
      listHouseholdUsers(req.householdId).catch(() => []),
      listPersonProfiles(req.householdId).catch(() => []),
    ]);
    const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    const byKey = new Map();
    const order = [];
    const ensure = (name) => {
      const display = String(name ?? '').trim();
      const key = norm(display);
      if (!display || !key) return null;
      if (!byKey.has(key)) {
        byKey.set(key, { person: display, acceptedFoods: [], rejectedFoods: [], allergies: [], notes: [] });
        order.push(key);
      }
      return byKey.get(key);
    };
    for (const u of users) ensure(u.display_name);
    for (const p of profiles) {
      const entry = ensure(p.person);
      if (entry) {
        entry.acceptedFoods = p.acceptedFoods || [];
        entry.rejectedFoods = p.rejectedFoods || [];
        entry.allergies = p.allergies || [];
        entry.notes = p.notes || [];
      }
    }
    return res.json({ profiles: order.map((k) => byKey.get(k)) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/family/profiles/add', requireHousehold, requireAuth, requireNotImpersonatingReadOnly, async (req, res) => {
  try {
    const person = String(req.body?.person ?? '').trim();
    const field = String(req.body?.field ?? '').trim();
    const value = String(req.body?.value ?? '').trim();
    if (!person || !FAMILY_PROFILE_FIELDS.has(field) || !value) {
      return res.status(400).json({ error: 'person, field, and value are required' });
    }
    const profile = await updatePersonProfile(req.householdId, person, { [field]: [value] });
    return res.json({ ok: true, profile });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/family/profiles/remove', requireHousehold, requireAuth, requireNotImpersonatingReadOnly, async (req, res) => {
  try {
    const person = String(req.body?.person ?? '').trim();
    const field = String(req.body?.field ?? '').trim();
    const value = String(req.body?.value ?? '').trim();
    if (!person || !FAMILY_PROFILE_FIELDS.has(field) || !value) {
      return res.status(400).json({ error: 'person, field, and value are required' });
    }
    const profile = await removePersonProfileValue(req.householdId, person, field, value);
    return res.json({ ok: true, profile });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});


app.get('/settings/household', requireHousehold, requireAuth, async (req, res) => {
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
      },
      defaults,
      users: users.map((u) => ({
        id: u.id,
        displayName: u.display_name,
        chatColor: normalizeChatColor(u.chat_color),
      })),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.get('/settings/household/defaults', requireHousehold, requireAuth, async (req, res) => {
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
  async (req, res) => {
    try {
      const defaults = await saveHouseholdDefaults(req.householdId, {
        defaultDinnerPortions: req.body.defaultDinnerPortions,
        weeknightCookingStyle: req.body.weeknightCookingStyle,
        assistantName: req.body.assistantName,
        assistantTone: req.body.assistantTone,
      });
      return res.json({ ok: true, defaults });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to save household defaults' });
    }
  }
);

function normalizeCookbookEditorTextList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? '').trim())
      .filter(Boolean);
  }
  return String(value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function handleGetCookbook(req, res) {
  try {
    const items = (await listCookbookEntries(req.householdId)).filter((entry) => !isFailedCookbookPlaceholder(entry));
    return res.json({ items });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load cookbook' });
  }
}

app.get('/cookbook', requireHousehold, requireAuth, handleGetCookbook);

app.get('/cookbook/:id', requireHousehold, requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid cookbook id' });
    }
    const item = await getCookbookEntryById(req.householdId, id);
    if (!item || isFailedCookbookPlaceholder(item)) {
      return res.status(404).json({ error: 'Cookbook entry not found' });
    }
    return res.json({ item });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load cookbook entry' });
  }
});

app.patch(
  '/cookbook/:id',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: 'Invalid cookbook id' });
      }
      const existing = await getCookbookEntryById(req.householdId, id);
      if (!existing || isFailedCookbookPlaceholder(existing)) {
        return res.status(404).json({ error: 'Cookbook entry not found' });
      }
      const record = buildCookbookRecordForStorage({
        title: req.body.title,
        summary: req.body.summary,
        category: req.body.category,
        recipeType: existing.recipeType,
        ingredients: normalizeCookbookEditorTextList(req.body.ingredients),
        instructions: normalizeCookbookEditorTextList(req.body.instructions),
        notes: normalizeCookbookEditorTextList(req.body.notes),
        tags: Array.isArray(req.body.tags)
          ? req.body.tags
          : String(req.body.tags ?? '')
              .split(',')
              .map((tag) => tag.trim())
              .filter(Boolean),
        sourceBookTitle: existing.sourceBookTitle,
        sourceTitle: existing.sourceTitle,
        sourceUrl: existing.sourceUrl,
        sourceKind: existing.sourceKind,
        sourceChatId: existing.sourceChatId,
        lastUsedAt: existing.lastUsedAt,
      });
      if (!record) {
        return res.status(400).json({ error: 'Title, summary, ingredients, and instructions are required.' });
      }
      await saveCookbookEntry(req.householdId, record, {
        id,
        sourceKind: existing.sourceKind,
        sourceChatId: existing.sourceChatId,
        lastUsedAt: existing.lastUsedAt,
      });
      const item = await getCookbookEntryById(req.householdId, id);
      return res.json({ ok: true, item });
    } catch (e) {
      if (e && e.code === 'SQLITE_CONSTRAINT') {
        return res.status(409).json({ error: 'A cookbook recipe with that title already exists.' });
      }
      console.error(e);
      return res.status(500).json({ error: 'Failed to update cookbook entry' });
    }
  }
);

app.delete(
  '/cookbook/:id',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: 'Invalid cookbook id' });
      }
      const changes = await deleteCookbookEntry(req.householdId, id);
      if (!changes) {
        return res.status(404).json({ error: 'Cookbook entry not found' });
      }
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to delete cookbook entry' });
    }
  }
);

app.get('/recipe-importer', requireHousehold, requireAuth, async (req, res) => {
  try {
    const knownCookbookSources = await listCookbookSourceBookTitles(req.householdId);
    res.send(renderRecipeImporterPage({ knownCookbookSources }));
  } catch (error) {
    console.error(error);
    res.send(renderRecipeImporterPage({ knownCookbookSources: [] }));
  }
});

app.post(
  '/recipe-importer/drafts',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
  async (req, res) => {
    try {
      const draft = await createManualRecipeImportDraft({
        householdId: req.householdId,
        userId: req.userId,
        recipe: req.body?.recipe || {},
        provenance: req.body?.provenance || {},
      });
      return res.json({ ok: true, draft });
    } catch (error) {
      return res.status(500).json({ error: safeTrim(error?.message) || 'Could not create a new recipe draft right now.' });
    }
  }
);

app.post(
  '/recipe-importer/import-url',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
  async (req, res) => {
    try {
      const url = safeTrim(req.body?.url);
      if (!url) return res.status(400).json({ error: 'Paste a recipe URL first.' });
      let anthropic = null;
      try {
        anthropic = (await getAnthropicClient(req.householdId)).client;
      } catch {
        anthropic = null;
      }
      const draft = await importRecipeFromUrl({
        url,
        householdId: req.householdId,
        userId: req.userId,
        anthropic,
      });
      return res.json({ ok: true, draft });
    } catch (error) {
      const message = safeTrim(error?.message);
      if (message === 'invalid_url') return res.status(400).json({ error: 'That does not look like a valid URL.' });
      if (message === 'riveter_unconfigured') {
        return res.status(503).json({ error: 'Recipe URL import is not configured yet. Add RIVETER_API_KEY to .env first.' });
      }
      return res.status(500).json({ error: message || 'Could not import that URL right now.' });
    }
  }
);

app.post(
  '/recipe-importer/import-images',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
  recipeImporterUpload.array('images', 8),
  async (req, res) => {
    try {
      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length === 0) return res.status(400).json({ error: 'Upload at least one image first.' });
      let anthropic = null;
      try {
        anthropic = (await getAnthropicClient(req.householdId)).client;
      } catch {
        anthropic = null;
      }
      const draft = await importRecipeFromImages({
        files,
        householdId: req.householdId,
        userId: req.userId,
        anthropic,
      });
      return res.json({ ok: true, draft });
    } catch (error) {
      const message = safeTrim(error?.message);
      if (message === 'no_images') return res.status(400).json({ error: 'Upload at least one image first.' });
      if (message === 'google_document_ai_unconfigured') {
        return res.status(503).json({
          error:
            'Image import is not configured yet. Add GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_DOCUMENT_AI_PROJECT_ID, and GOOGLE_DOCUMENT_AI_PROCESSOR_ID to .env first.',
        });
      }
      if (message === 'google_document_ai_auth_failed') {
        return res.status(503).json({
          error:
            'Google Document AI could not authenticate. Double-check GOOGLE_APPLICATION_CREDENTIALS and make sure the JSON key file still exists.',
        });
      }
      return res.status(500).json({ error: message || 'Could not import those images right now.' });
    }
  }
);

app.get('/recipe-importer/drafts/:id', requireHousehold, requireAuth, async (req, res) => {
  try {
    const draft = await getRecipeImportDraft({
      draftId: req.params.id,
      householdId: req.householdId,
      userId: req.userId,
    });
    if (!draft) return res.status(404).json({ error: 'Import draft not found.' });
    return res.json({ ok: true, draft });
  } catch (error) {
    return res.status(500).json({ error: safeTrim(error?.message) || 'Could not load that draft right now.' });
  }
});

app.put(
  '/recipe-importer/drafts/:id',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
  async (req, res) => {
    try {
      const draft = await updateRecipeImportDraft({
        draftId: req.params.id,
        householdId: req.householdId,
        userId: req.userId,
        patch: req.body || {},
      });
      if (!draft) return res.status(404).json({ error: 'Import draft not found.' });
      return res.json({ ok: true, draft });
    } catch (error) {
      return res.status(500).json({ error: safeTrim(error?.message) || 'Could not update that draft right now.' });
    }
  }
);

app.post(
  '/recipe-importer/drafts/:id/save',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
  async (req, res) => {
    try {
      const item = await saveRecipeImportDraftToCookbook({
        draftId: req.params.id,
        householdId: req.householdId,
        userId: req.userId,
        overwriteExisting: !!req.body?.overwriteExisting,
      });
      return res.json({ ok: true, item });
    } catch (error) {
      const message = safeTrim(error?.message);
      if (error?.code === 'duplicate_recipe_title') {
        return res.status(409).json({
          error: message || 'That recipe already exists in your Cookbook.',
          code: 'duplicate_recipe_title',
          conflict: error.conflict || null,
        });
      }
      if (message === 'draft_not_found') return res.status(404).json({ error: 'Import draft not found.' });
      if (/before saving/i.test(message) || message === 'invalid_recipe_record') {
        return res.status(400).json({
          error: message === 'invalid_recipe_record' ? 'The draft still needs a little repair before saving.' : message,
        });
      }
      return res.status(500).json({ error: message || 'Could not save that recipe right now.' });
    }
  }
);

app.post(
  '/settings/household/users/:id/chat-color',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
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
  async (req, res) => {
  try {
    const displayName = req.body.displayName?.trim();
    const pin = req.body.pin?.trim();
    if (!displayName || !pin) {
      return res.status(400).json({ error: 'displayName and pin are required' });
    }
    const existing = await getUserByHouseholdAndDisplayName(req.householdId, displayName);
    if (existing) {
      return res.status(409).json({ error: 'A user with this display name already exists' });
    }
    // Roles were removed; every household member is equal. Stamp a fixed value only to satisfy
    // the (now inert) NOT NULL role column.
    const id = await createHouseholdUser(req.householdId, { displayName, role: 'member', pin });
    const created = await getHouseholdUserById(req.householdId, id);
    return res.json({
      id,
      displayName,
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

const ANTHROPIC_MODES = new Set(['shared', 'household']);

app.get('/settings/anthropic', requireHousehold, requireAuth, async (req, res) => {
  try {
    const targetId = await resolveAnthropicTargetHouseholdId(req, res, req.query.householdId);
    if (targetId == null) return;
    const globalAdmin = await isRequestGlobalAdmin(req);
    // Roles removed: any member may view their OWN household's key settings; only God Mode
    // may view another household's.
    if (targetId !== req.householdId && !globalAdmin) {
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
    const canEditKey = targetId === req.householdId && mode === 'household';
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
  '/settings/anthropic/key',
  requireHousehold,
  requireAuth,
  requireNotImpersonatingReadOnly,
  async (req, res) => {
  try {
    // Roles removed: any authenticated member of this household may set its key.
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

export async function handleGetChats(req, res) {
  try {
    const chats = await listAllChats(req.householdId);
    res.json({ chats });
  } catch (error) {
    console.error(error);
    res.status(500).json({ chats: [] });
  }
}

app.get('/chats', requireHousehold, requireAuth, handleGetChats);

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

// Validate a chat attachment from the client. Returns {kind, mediaType, name, data, byteSize} or
// null. Images arrive as base64 (already downscaled in the browser); text arrives as utf8.
const ATTACHMENT_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const ATTACHMENT_TEXT_TYPES = new Set(['text/plain', 'text/markdown']);
const MAX_IMAGE_BASE64_LEN = 9_000_000; // ~6.7MB decoded (Anthropic per-image cap is 5MB) + slack
const MAX_TEXT_LEN = 400_000; // ~400KB of text
function parseChatAttachment(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const kind = String(raw.kind ?? '').trim();
  const mediaType = String(raw.mediaType ?? raw.media_type ?? '').trim().toLowerCase();
  const name = String(raw.name ?? '').trim().slice(0, 200) || null;
  const data = typeof raw.data === 'string' ? raw.data : '';
  if (!data) return null;
  if (kind === 'image') {
    if (!ATTACHMENT_IMAGE_TYPES.has(mediaType) || data.length > MAX_IMAGE_BASE64_LEN) return null;
    return { kind: 'image', mediaType, name, data, byteSize: Math.floor((data.length * 3) / 4) };
  }
  if (kind === 'text') {
    if (data.length > MAX_TEXT_LEN) return null;
    return {
      kind: 'text',
      mediaType: ATTACHMENT_TEXT_TYPES.has(mediaType) ? mediaType : 'text/plain',
      name,
      data,
      byteSize: Buffer.byteLength(data, 'utf8'),
    };
  }
  return null;
}

app.get('/history', requireHousehold, requireAuth, async (req, res) => {
  try {
    const chatId = Number(req.query.chatId);
    if (!Number.isFinite(chatId)) {
      return res.status(400).json({ conversation: [] });
    }
    const conversation = await getMessages(chatId, req.householdId);
    const defaults = await getHouseholdDefaults(req.householdId).catch(() => ({}));
    const attachments = await getChatAttachmentsForChat(req.householdId, chatId).catch(() => []);
    const attachmentsByMessage = new Map();
    for (const a of attachments) {
      if (a.messageId == null) continue;
      if (!attachmentsByMessage.has(a.messageId)) attachmentsByMessage.set(a.messageId, []);
      attachmentsByMessage.get(a.messageId).push({ id: a.id, kind: a.kind, mediaType: a.mediaType, name: a.name });
    }
    const conversationForClient = conversation.map((m) => ({
      ...m,
      content: stripStoredMessageContentForDisplay(m.content),
      attachments: attachmentsByMessage.get(Number(m.id)) || [],
    }));
    res.json({ conversation: conversationForClient, assistantName: defaults.assistantName || DEFAULT_ASSISTANT_NAME });
  } catch (error) {
    console.error(error);
    res.status(500).json({ conversation: [] });
  }
});

// Serve one attachment's bytes to household members (images render via <img src>; text inline).
app.get('/attachment/:id', requireHousehold, requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).end();
    const att = await getChatAttachmentById(req.householdId, id);
    if (!att) return res.status(404).end();
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('Content-Disposition', 'inline');
    if (att.kind === 'image') {
      res.setHeader('Content-Type', att.mediaType || 'image/jpeg');
      return res.end(Buffer.from(att.data, 'base64'));
    }
    res.setHeader('Content-Type', `${att.mediaType || 'text/plain'}; charset=utf-8`);
    return res.end(att.data);
  } catch (error) {
    console.error(error);
    return res.status(500).end();
  }
});

registerKitchenInventoryRoutes(app, {
  middleware: {
    requireHousehold,
    requireAuth,
    requireNotImpersonatingReadOnly,
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
    getMealPlanItems,
    updateMealPlanItem,
    deleteMealPlanItem,
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
    let prompt = '';
    let name = 'Rob';
    let chatId = NaN;
    let kbDeps = null;
    try {
      prompt = req.body.prompt?.trim();
      name = req.user || req.body.name?.trim() || 'Rob';
      chatId = Number(req.body.chatId);
      if (!Number.isFinite(chatId)) {
        return res.status(400).json({ reply: 'chatId is required.' });
      }
      req.kbAttachment = parseChatAttachment(req.body.attachment);

      const inventoryServices = createBoundInventoryServices();

      kbDeps = buildKbRuntimeDeps({
        ANTHROPIC_KEY_USER_MESSAGE,
        addMessage,
        broadcastToChat,
        emitKbProgress,
        clearChatRuntimeState,
        getAnthropicClient,
        isGlobalAdminUser,
        addChatAttachment,
        buildKbContextPacket,
        incrementUserMessageCountForSender,
        isAnthropicSdkAuthOrKeyError,
        getAnthropicUserFacingErrorMessage,
        mergeGroceryItemsFromAi: inventoryServices.mergeGroceryItemsFromAi,
        normalizeGroceryItemsForPost: inventoryServices.normalizeGroceryItemsForPost,
        normalizeInventoryNameKey: inventoryServices.normalizeInventoryNameKey,
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
      const anthropicReply = getAnthropicUserFacingErrorMessage(error);
      if (!res.headersSent && anthropicReply && Number.isFinite(chatId) && kbDeps) {
        return await respondWithKbErrorReply({
          req,
          res,
          name,
          chatId,
          turnId: req.kbTurnId || null,
          routePrompt: prompt,
          replyText: anthropicReply,
          memoryContext: null,
          groundedTurn: null,
          workingContext: null,
          userMessageAlreadyPersisted: !!req.kbUserMessagePersisted,
          deps: kbDeps,
        });
      }
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

function writeSenderChatStreamEvent(res, event) {
  if (!res || typeof res.write !== 'function') return;
  if (!res.headersSent) {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-KitchenBot-Stream-Format', 'ndjson');
  }
  res.write(`${JSON.stringify(event)}\n`);
}

async function emitKbProgress({ chatId, householdId, turnId = null, text = '', phase = '', senderRes = null }) {
  const progressText = String(text ?? '').trim();
  if (!Number.isFinite(Number(chatId)) || !Number.isFinite(Number(householdId)) || !progressText) return;
  writeSenderChatStreamEvent(senderRes, {
    type: 'progress',
    householdId: Number(householdId),
    chatId: Number(chatId),
    turnId: turnId ? String(turnId) : null,
    phase: String(phase ?? '').trim() || null,
    text: progressText,
  });
  broadcastToChat(Number(chatId), {
    type: 'kb_progress',
    householdId: Number(householdId),
    chatId: Number(chatId),
    turnId: turnId ? String(turnId) : null,
    phase: String(phase ?? '').trim() || null,
    text: progressText,
  });
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

export async function startKitchenbotServer() {
  await runMigrations();
  await connectRedis();
  await seedInitialHouseholdFromEnvIfNeeded();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject);
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
      resolve();
    });
  });
  return server;
}

const isMainModule =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMainModule) {
  startKitchenbotServer().catch((error) => {
    console.error('KitchenBot startup failed:', error?.message || error);
    process.exit(1);
  });
}
