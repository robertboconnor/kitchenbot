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
  backfillGroceryItemSourceChatIfSafe,
  updateGroceryItem,
  deleteGroceryItem,
  clearGroceryItems,
  pruneStaleGroceryItemsForChat,
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

/** Strip outer backticks and one layer of matching surrounding quotes (wrapper-only; preserves inner content). */
function stripOuterFormattingWrappers(text) {
  let s = String(text ?? '').trim();
  while (s.length >= 2 && s.startsWith('`') && s.endsWith('`')) {
    s = s.slice(1, -1).trim();
  }
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if ((a === '"' || a === "'") && a === b) {
      s = s.slice(1, -1).trim();
    }
  }
  return s;
}

/** Normalize remember key before DB persist (explicit !remember, pending, Settings). */
function normalizeRememberKeyForStorage(raw) {
  return normalizeRememberKey(stripOuterFormattingWrappers(String(raw ?? '')));
}

/** Normalize remember value before DB persist. */
function normalizeRememberValueForStorage(raw) {
  return stripOuterFormattingWrappers(String(raw ?? ''));
}

async function upsertHouseholdMemory(householdId, rawKey, rawValue) {
  const key = normalizeRememberKeyForStorage(rawKey);
  const value = normalizeRememberValueForStorage(rawValue);
  await upsertMemory(householdId, key, value);
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

/** Remove model-authored lines that duplicate the backend mixed-memory offer (narrow; only obvious offer/save dupes). */
function stripModelAuthoredMemoryOfferLines(text) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      out.push(line);
      continue;
    }
    if (/^If you want, I can save .+ so I remember it next time too\.?$/i.test(t)) continue;
    if (/^Want me to save that as a household preference/i.test(t)) continue;
    if (/^Want me to save the favorite /i.test(t)) continue;
    if (/^If you want, I can save your tone preference /i.test(t)) continue;
    if (/^If you want, I can save this \(/i.test(t)) continue;
    if (/^If you want, I can save that \(/i.test(t)) continue;
    if (/^Would you like me to save\b/i.test(t)) continue;
    if (/^just confirm and I['']ll save it\.?$/i.test(t)) continue;
    if (/^I can note that\b/i.test(t) && /\b(save it|save that|household memory|for future)\b/i.test(t)) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/**
 * When no [[KB_OFFER_GROCERY_UPDATE]] was emitted, drop model lines that imply a real app grocery action or confirmable pending.
 * Also strips invitation-style grocery/shopping-list questions so users are not prompted to say "yes" with nothing to confirm.
 */
function stripFakeGroceryOperationalLines(text) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    // Tail uses \s+ so NBSP/other Unicode spaces between "Grocery", "List", and "tab" still match (model output).
    const stripGroceryTabCtaLine =
      /^If you(?:(?:'|\u2019)d like| want), I can(?:\s+also|\s+just)?\s+(?:add this to|add .+ to|update) (?:the )?Grocery\s+List\s+tab/i;
    if (/^That's a command-backed action/i.test(t)) continue;
    if (/^Want me to do that now\?/i.test(t)) continue;
    if (/\bSay\s+yes\s+and\s+i(?:'|')ll\s+add\s+it\b/i.test(t)) continue;
    if (/^I can run !grocerylist for you/i.test(t)) continue;
    // Fake tab CTA: same opening as system prompt ("If you want,") plus small model drift ("If you'd like", "I can also add …").
    if (stripGroceryTabCtaLine.test(t)) continue;
    // Narrow CTA / confirmation invites (must mention grocery or shopping list); short lines only
    if (t.length <= 320 && /\b(?:grocery|shopping)\s+list\b/i.test(t)) {
      const asks = /\?\s*$/.test(t);
      if (asks) {
        if (
          /\b(?:do you want|would you like)\s+(?:a\s+|the\s+|me\s+to\s+)?(?:a\s+)?(?:grocery|shopping)\s+list\b/i.test(t) ||
          /\b(?:do you want|would you like)\s+me\s+to\b.*\b(?:grocery|shopping)\s+list\b/i.test(t) ||
          /^want me to\b.*\b(?:grocery|shopping)\s+list\b/i.test(t) ||
          /^(?:should i|can i|could i|shall i)\b.*\b(?:grocery|shopping)\s+list\b/i.test(t)
        ) {
          continue;
        }
      } else if (
        /^want me to\s+(?:make|build|create|put together|add)\s+(?:a\s+|the\s+)?(?:grocery|shopping)\s+list\b/i.test(t) ||
        /^let me know if\b.*\b(?:grocery|shopping)\s+list\b/i.test(t)
      ) {
        continue;
      }
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/** Minimal safety net for normal chat streaming: never persist fake saved-memory claims. */
function scrubUnsavedMemoryClaimsInNormalChatReply(text) {
  let s = String(text ?? '');
  const ap = "['\u2019]";
  s = s.replace(new RegExp(`\\bI${ap}ve noted that\\b`, 'gi'), 'You mentioned that');
  s = s.replace(new RegExp(`\\bI${ap}ve noted\\b`, 'gi'), 'For this reply');
  s = s.replace(new RegExp(`\\bI${ap}ll keep that in mind for future meals\\b`, 'gi'), 'For this reply only');
  s = s.replace(new RegExp(`\\bI${ap}ll keep that in mind\\b`, 'gi'), 'For this reply only');
  s = s.replace(new RegExp(`\\bI${ap}ll remember that next time\\b`, 'gi'), 'If you confirm saving it, I can remember that next time');
  s = s.replace(new RegExp(`\\bI${ap}ll remember that for future\\b`, 'gi'), 'If you confirm saving it, I can remember that for future chats');
  s = s.replace(new RegExp(`\\bI${ap}ve updated\\b[^.\\n]{0,120}preferences\\b`, 'gi'), 'I can update preferences if you confirm a save');
  s = s.replace(new RegExp(`\\bI${ap}ve updated\\b`, 'gi'), 'I can offer to update');
  s = s.replace(/\bI saved memory\b/gi, 'I can save to memory if you confirm');
  s = s.replace(/\bI updated memory\b/gi, 'I can update memory if you confirm');
  return s;
}

/** Merge a new memory fragment into an existing value; prefer semicolons between distinct facts (no comma-spliced dumps). */
function mergeMemoryValuesForUpsert(existingRaw, incomingRaw) {
  const existing = String(existingRaw ?? '').trim();
  const incoming = String(incomingRaw ?? '').trim();
  if (!incoming) return existing;
  if (!existing) return incoming;
  if (existing.toLowerCase() === incoming.toLowerCase()) return existing;
  return `${existing}; ${incoming}`;
}

/**
 * When AI or NL proposes a value for a key that already exists, merge or reject duplicates.
 * @returns {string | null} null = skip offer / no change
 */
function mergeMemoryProposalWithExisting(existingRaw, proposedRaw) {
  const existing = String(existingRaw ?? '').trim();
  const proposed = String(proposedRaw ?? '').trim();
  if (!proposed) return null;
  if (!existing) return proposed;
  if (proposed.toLowerCase() === existing.toLowerCase()) return null;
  if (proposed.toLowerCase().includes(existing.toLowerCase())) return proposed;
  if (existing.toLowerCase().includes(proposed.toLowerCase()) && proposed.length >= 4) return null;
  return mergeMemoryValuesForUpsert(existing, proposed);
}

/** Heuristic: leading clause before "remember that" looks like a non-memory primary ask. */
function looksLikePrimaryNonMemoryTaskClause(beforeText) {
  const t = String(beforeText ?? '').trim().toLowerCase();
  if (t.length < 10) return false;
  return (
    /\b(generate|create|make|build|draft|write|plan|help\s+me|suggest|give\s+me|what\s+should\s+i|can\s+you\s+|how\s+do\s+i|explain|compare)\b/.test(t) ||
    /\b(meal\s*plan|recipe|menu|grocery|shopping\s*list|week(?:'s)?\s+meals|dinners?|breakfast|lunch)\b/.test(t) ||
    /\b(planning|plan)\s+(?:meals?|for)\b/.test(t) ||
    /\bfor\s+this\s+week\b/.test(t)
  );
}

/**
 * Merge a new preference fragment into an existing key when present in the memories map.
 * @param {Map<string, string>} memoriesByKey
 */
function mergeIntoExistingPreferenceKey(prefKey, fragment, memoriesByKey) {
  const k = normalizeRememberKey(prefKey);
  const frag = String(fragment ?? '').trim();
  if (!k || !frag) return null;
  if (memoriesByKey.has(k)) {
    const merged = mergeMemoryProposalWithExisting(String(memoriesByKey.get(k) ?? ''), frag);
    if (merged === null) return { key: k, value: String(memoriesByKey.get(k) ?? '') };
    return { key: k, value: merged };
  }
  return { key: k, value: frag };
}

function mergeIntoHouseholdStaples(listFragment, memoriesByKey) {
  const k = normalizeRememberKey('household_staples');
  const frag = String(listFragment ?? '').trim().replace(/^[:,]\s*/, '');
  if (!frag) return null;
  if (memoriesByKey.has(k)) {
    return { key: k, value: mergeMemoryValuesForUpsert(String(memoriesByKey.get(k) ?? ''), frag) };
  }
  return { key: k, value: frag };
}

/** AI or bad parsers sometimes emit sentence-shaped keys; never store those as-is. */
function isSentenceLikeRememberKey(k) {
  const s = String(k ?? '').trim();
  if (!s) return true;
  if (s.length > 48) return true;
  const parts = s.split('_');
  if (parts.length > 5) return true;
  if (/^(that|our|my|the|remember|we|if|when|your)_/.test(s)) return true;
  return false;
}

/**
 * Deterministic key/value from NL memory payload; prefers existing household keys when relevant.
 * `saved_note` is only used when the fact does not fit a stable category and existing-key hints.
 * @param {Map<string, string>} memoriesByKey
 * @returns {null | { key: string, value: string }}
 */
function inferRememberKeyAndValueFromPayload(payload, memoriesByKey = new Map()) {
  let p = String(payload ?? '').trim();
  if (!p) return null;
  p = p.slice(0, 500);

  let m = p.match(/\b(?:your\s+)?(?:writing\s+)?tone\s+should\s+be\s+(.+)$/i);
  if (m) return { key: normalizeRememberKey('tone'), value: m[1].trim() };
  m = p.match(/\b(?:your\s+)?(?:writing\s+)?tone\s+is\s+(.+)$/i);
  if (m) return { key: normalizeRememberKey('tone'), value: m[1].trim() };
  m = p.match(/\b(?:writing\s+)?style\s+should\s+be\s+(.+)$/i);
  if (m) return { key: normalizeRememberKey('tone'), value: m[1].trim() };

  m = p.match(/\bfavorite\s+(food|pasta|meal)\s+(?:is|should\s+be)\s+(.+)$/i);
  if (m) return { key: normalizeRememberKey(`favorite_${m[1]}`), value: m[2].trim() };
  m = p.match(/\bfavorite\s+(food|pasta|meal)\s+(.+)$/i);
  if (m) return { key: normalizeRememberKey(`favorite_${m[1]}`), value: m[2].trim() };

  m = p.match(/^([A-Za-z][a-z]{1,24})\s+does\s+not\s+like\s+(.+)$/i);
  if (!m) m = p.match(/^([A-Za-z][a-z]{1,24})\s+doesn't\s+like\s+(.+)$/i);
  if (m) {
    const name = m[1].toLowerCase();
    const thing = m[2].trim();
    if (name && thing) {
      return mergeIntoExistingPreferenceKey(`${name}_preferences`, `doesn't like ${thing}`, memoriesByKey);
    }
  }

  m = p.match(/^that\s+([a-z][a-z0-9]{1,23})\s+loves\s+(.+)$/i);
  if (!m) m = p.match(/^([a-z][a-z0-9]{1,23})\s+loves\s+(.+)$/i);
  if (m) {
    const name = m[1].toLowerCase();
    const thing = m[2].trim();
    if (name && thing) {
      return mergeIntoExistingPreferenceKey(`${name}_preferences`, `loves ${thing}`, memoriesByKey);
    }
  }

  m = p.match(/^that\s+([a-z][a-z0-9]{1,23})\s+hates\s+(.+)$/i);
  if (!m) m = p.match(/^([a-z][a-z0-9]{1,23})\s+hates\s+(.+)$/i);
  if (m) {
    const name = m[1].toLowerCase();
    const thing = m[2].trim();
    if (name && thing) {
      return mergeIntoExistingPreferenceKey(`${name}_preferences`, `hates ${thing}`, memoriesByKey);
    }
  }

  m = p.match(/^our\s+child(?:'s|\u2019s)?\s+name\s+is\s+(.+)$/i);
  if (!m) m = p.match(/^our\s+kid(?:'s|\u2019s)?\s+name\s+is\s+(.+)$/i);
  if (!m) m = p.match(/^that\s+our\s+child(?:'s|\u2019s)?\s+name\s+is\s+(.+)$/i);
  if (!m) m = p.match(/^that\s+our\s+kid(?:'s|\u2019s)?\s+name\s+is\s+(.+)$/i);
  if (m) {
    const v = m[1].trim();
    if (v) {
      const k = normalizeRememberKey('child_name');
      return { key: k, value: v };
    }
  }

  m = p.match(
    /^that\s+our\s+household\s+always\s+has\s+(?:these\s+)?(?:items?|ingredients?)\s*:?\s*(.+)$/i
  );
  if (!m) m = p.match(/^our\s+household\s+always\s+has\s+(?:these\s+)?(?:items?|ingredients?)\s*:?\s*(.+)$/i);
  if (!m) {
    m = p.match(
      /^that\s+our\s+kitchen\s+always\s+has\s+(?:these\s+)?(?:items?|ingredients?)\s*:?\s*(.+)$/i
    );
  }
  if (!m) m = p.match(/^our\s+kitchen\s+always\s+has\s+(?:these\s+)?(?:items?|ingredients?)\s*:?\s*(.+)$/i);
  if (!m) m = p.match(/^we\s+always\s+have\s+(.+)$/i);
  if (m) {
    const list = m[1].trim().replace(/^[:,]\s*/, '');
    if (list) return mergeIntoHouseholdStaples(list, memoriesByKey);
  }

  if (memoriesByKey.has('household_staples') && looksLikeStaplesListFragment(p)) {
    return mergeIntoHouseholdStaples(p, memoriesByKey);
  }

  if (memoriesByKey.has('child_name') && looksLikeChildNameUpdatePayload(p)) {
    const v = extractChildNameFromPayload(p);
    if (v) return { key: normalizeRememberKey('child_name'), value: v };
  }

  return { key: normalizeRememberKey('saved_note'), value: p };
}

/** Comma- or "and"-separated pantry-style list without a stronger pattern match. */
function looksLikeStaplesListFragment(p) {
  const t = String(p ?? '').trim().toLowerCase();
  if (t.length < 8) return false;
  if (/\b(olive\s+oil|vegetable\s+oil|salt|pepper|vinegar|ketchup|flour|sugar|butter)\b/.test(t)) {
    return true;
  }
  return /,/.test(t) && t.split(',').length >= 2;
}

function looksLikeChildNameUpdatePayload(p) {
  return /\bchild(?:'s|\u2019s)?\s+name\s+is\b/i.test(p) || /\bkid(?:'s|\u2019s)?\s+name\s+is\b/i.test(p);
}

function extractChildNameFromPayload(p) {
  const m = String(p).match(/\b(?:child|kid)(?:'s|\u2019s)?\s+name\s+is\s+(.+)$/i);
  return m ? m[1].trim().replace(/[.!?]+$/, '') : null;
}

/**
 * Extract memory payload from obvious NL phrases, or signal mixed intent (skip memory pending).
 * @returns {{ payload: string } | { mixed: true } | null}
 */
function tryExtractNaturalLanguageRememberPayload(raw) {
  const s = String(raw ?? '').trim();

  const subordinate = s.match(/^(.{20,}?)\bremember(?:ing)?\s+that\s+(.+)$/is);
  if (subordinate) {
    const before = subordinate[1].trim();
    const payload = subordinate[2].trim();
    if (looksLikePrimaryNonMemoryTaskClause(before)) {
      return { mixed: true };
    }
    if (payload) return { payload };
  }

  const anchoredPatterns = [
    /^(?:please\s+)?remember\s+that\s+(.+)$/i,
    /^(?:please\s+)?save\s+(?:this|it)\s+to\s+memory\s*:?\s*(.+)$/i,
    /^(?:please\s+)?write\s+(?:this|it)\s+to\s+memory\s*:?\s*(.+)$/i,
    /^(?:please\s+)?don['']t\s+forget\s+that\s+(.+)$/i,
  ];
  for (const re of anchoredPatterns) {
    const m = s.match(re);
    if (m?.[1]?.trim()) return { payload: m[1].trim() };
  }
  return null;
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
  const key = normalizeRememberKeyForStorage(rawKey);
  const value = normalizeRememberValueForStorage(rawVal);
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

/**
 * Follow-up preference lines only when `<name>_preferences` already exists (e.g. "also elle loves capers").
 * @param {Map<string, string>} memoriesByKey
 */
function tryFollowUpPreferencePendingFromMemories(raw, memoriesByKey) {
  if (!memoriesByKey || memoriesByKey.size === 0) return null;
  const s = String(raw ?? '').trim();
  if (s.length > 240) return null;
  if (/\bremember(?:ing)?\s+that\b/i.test(s)) return null;

  let m = s.match(/^\s*(?:also\s+)?([A-Za-z][a-z]{1,24})\s+(loves|likes)\s+(.+)$/i);
  if (m) {
    const nameRaw = m[1];
    const verb = String(m[2] ?? '').toLowerCase();
    const thing = String(m[3] ?? '').trim();
    if (!thing) return null;
    const key = normalizeRememberKey(`${nameRaw}_preferences`);
    if (!memoriesByKey.has(key)) return null;
    const existing = String(memoriesByKey.get(key) ?? '');
    const fragment = verb === 'loves' ? `loves ${thing}` : `likes ${thing}`;
    const merged = mergeMemoryProposalWithExisting(existing, fragment);
    if (merged === null) return null;
    return sanitizePendingAction({ command: '!remember', args: { key, value: merged } });
  }

  m = s.match(/^\s*(?:also\s+)?([A-Za-z][a-z]{1,24})\s+doesn['\u2019]t\s+like\s+(.+)$/i);
  if (!m) m = s.match(/^\s*(?:also\s+)?([A-Za-z][a-z]{1,24})\s+does\s+not\s+like\s+(.+)$/i);
  if (m) {
    const nameRaw = m[1];
    const thing = String(m[2] ?? '').trim();
    if (!thing) return null;
    const key = normalizeRememberKey(`${nameRaw}_preferences`);
    if (!memoriesByKey.has(key)) return null;
    const existing = String(memoriesByKey.get(key) ?? '');
    const fragment = `doesn't like ${thing}`;
    const merged = mergeMemoryProposalWithExisting(existing, fragment);
    if (merged === null) return null;
    return sanitizePendingAction({ command: '!remember', args: { key, value: merged } });
  }

  m = s.match(/^\s*(?:also\s+)?([A-Za-z][a-z]{1,24})\s+dislikes\s+(.+)$/i);
  if (m) {
    const nameRaw = m[1];
    const thing = String(m[2] ?? '').trim();
    if (!thing) return null;
    const key = normalizeRememberKey(`${nameRaw}_preferences`);
    if (!memoriesByKey.has(key)) return null;
    const existing = String(memoriesByKey.get(key) ?? '');
    const fragment = `dislikes ${thing}`;
    const merged = mergeMemoryProposalWithExisting(existing, fragment);
    if (merged === null) return null;
    return sanitizePendingAction({ command: '!remember', args: { key, value: merged } });
  }

  return null;
}

/**
 * True when this thread already has a concrete grocery draft: persisted thread summary from a prior
 * !grocerylist run, a visible grocery-offer line in recent assistant text, or list-like assistant output.
 */
function threadHasConcreteGroceryDraftForFollowUp(threadGrocerySummary, recentAssistantContents) {
  if (String(threadGrocerySummary ?? '').trim().length > 0) return true;
  const blob = recentAssistantContents.map((c) => stripKitchenBotHiddenMarkers(String(c ?? ''))).join('\n\n');
  if (/If you want, I can (?:add this to|update) (?:the )?Grocery List tab/i.test(blob)) {
    return true;
  }
  const lines = blob.split(/\n/).map((l) => l.trim()).filter(Boolean);
  let score = 0;
  for (const line of lines) {
    if (/^\d+[\.\)]\s+\S/.test(line)) score++;
    if (/^[-*•]\s+\S/.test(line)) score++;
    if (/\|[^|]+\|[^|]+/.test(line)) score += 2;
  }
  return score >= 3;
}

/**
 * Deictic "add this to the tab/list" follow-ups — only after a draft exists (see threadHasConcreteGroceryDraftForFollowUp).
 * @returns {ReturnType<typeof sanitizePendingAction> | null}
 */
function tryGroceryTabDeicticFollowUpPending(raw, hasGroceryDraft) {
  if (!hasGroceryDraft) return null;
  const lower = String(raw ?? '').trim().toLowerCase();
  // Only treat deictic tab/list phrasing as a grocery action when a concrete draft exists (thread summary, offer line, or list-like assistant output).
  const deictic =
    /\b(?:add|put)\s+(?:this|these|those|it|them)\s+(?:to|on|into)\s+(?:the\s+)?(?:grocery\s+list|shopping\s+list)\b/.test(lower) ||
    /\b(?:add|put)\s+(?:this|these|those|it|them)\s+to\s+(?:the\s+)?grocery\s+list\s+tab\b/.test(lower) ||
    /\b(?:add|put)\s+(?:this|these|those|it|them)\s+to\s+(?:the\s+)?tab\b/.test(lower) ||
    /\bcan\s+you\s+add\s+(?:this|these|those|it|them)\s+to\s+(?:the\s+)?(?:grocery\s+list|shopping\s+list)(?:\s+for\s+me)?\b/.test(lower) ||
    /\bcan\s+you\s+add\s+(?:this|these|those|it|them)\s+to\s+the\s+tab\b/.test(lower) ||
    /\bupdate\s+(?:the\s+)?grocery\s+list\s+tab\s+with\s+(?:this|that|these|those)\b/.test(lower) ||
    /\bput\s+(?:this|these|those|it|them)\s+on\s+(?:the\s+)?(?:grocery\s+list|shopping\s+list)\b/.test(lower) ||
    /\bmake\s+a\s+grocery\s+list\s+from\s+this\b/.test(lower) ||
    /\bturn\s+this\s+into\s+(?:a\s+)?grocery\s+list\b/.test(lower);
  if (!deictic) return null;
  return sanitizePendingAction({ command: '!grocerylist' });
}

function detectCommandIntentFromNaturalLanguage(prompt, memoriesByKey = new Map(), intentOpts = {}) {
  const raw = String(prompt ?? '').trim();
  if (!raw) return { pendingAction: null };
  if (raw.startsWith('!')) return { pendingAction: null };

  const followUpFirst = tryFollowUpPreferencePendingFromMemories(raw, memoriesByKey);
  if (followUpFirst) {
    return { pendingAction: followUpFirst };
  }

  const hasGroceryDraft = !!intentOpts.hasGroceryDraft;
  const groceryFollow = tryGroceryTabDeicticFollowUpPending(raw, hasGroceryDraft);
  if (groceryFollow) {
    return { pendingAction: groceryFollow };
  }

  const lower = raw.toLowerCase();

  const hasMealIdeationLanguage =
    /\bhelp me think of\b/.test(lower) ||
    /\bwhat should i make\b/.test(lower) ||
    /\bmeal ideas?\b/.test(lower) ||
    /\bplan meals?\b/.test(lower) ||
    /\beasy meals?\b/.test(lower) ||
    /\bdinners?\s+for\s+this\s+week\b/.test(lower);

  // Grocery: draft-first — do not escalate NL to pending !grocerylist for list-for-recipe / format / show-me drafting.
  const groceryDraftSuppression =
    /\bshopping\s+list\s+for\b/.test(lower) ||
    /\bgrocery\s+list\s+for\b/.test(lower) ||
    /\bingredients\s+for\b/.test(lower) ||
    /\bin\s+grocery\s+list\s+format\b/.test(lower) ||
    /\bmake\s+something\s+up\b/.test(lower) ||
    /\b(don't|do\s+not)\s+run\s+a\s+web\s+search\b/.test(lower) ||
    /\bshow\s+me\b/.test(lower) ||
    /\bwhat\s+would\s+i\s+need\b/.test(lower) ||
    /\bwhat\s+ingredients\s+would\s+i\s+need\b/.test(lower);

  const strongGroceryAppAction =
    /\brun\s+!grocerylist\b/.test(lower) ||
    /\b(?:add|put|push)\s+(?:this|these|those|it|them)\s+(?:to|on|into)\s+(?:the\s+)?(?:grocery\s+list|shopping\s+list)\b/.test(lower) ||
    /\b(?:add|put)\s+(?:this|these|those|it|them)\s+to\s+(?:the\s+)?grocery\s+list\s+tab\b/.test(lower) ||
    /\bupdate\s+(?:the\s+)?(?:grocery\s+list|grocery\s+list\s+tab)\b/.test(lower) ||
    /\bcan\s+you\s+(?:add|update)\s+(?:this|these|those|it|them)?\s*(?:to|on)?\s*(?:the\s+)?(?:grocery\s+list(?:\s+for\s+me)?|grocery\s+list\s+tab)\b/.test(lower) ||
    /\bcan\s+you\s+update\s+(?:the\s+)?grocery\s+list\s+tab\b/.test(lower) ||
    /\bput\s+(?:this|these|those|it|them)\s+on\s+(?:the\s+)?(?:grocery\s+list|shopping\s+list)\b/.test(lower);

  if (!groceryDraftSuppression && !hasMealIdeationLanguage && strongGroceryAppAction) {
    return { pendingAction: { command: '!grocerylist' } };
  }

  const s = lower.trim();
  const wantsHelpMenu =
    /^help\s*[!?.]*$/.test(s) ||
    /^what can you do\s*[!?.]*$/.test(s) ||
    /\bhelp menu\b/.test(s) ||
    /\bshow help\b/.test(s) ||
    /\bshow\s+(?:me\s+)?(?:the\s+)?commands?\b/.test(s) ||
    /\blist\s+(?:me\s+)?(?:the\s+)?commands?\b/.test(s) ||
    /\bwhat\s+commands?\b/.test(s);
  if (wantsHelpMenu) {
    return { pendingAction: { command: '!help' } };
  }

  const renameManual = raw.match(/\brename(?:\s+this)?\s+chat\s+to\s+["“]?(.+?)["”]?\s*$/i);
  if (renameManual) {
    const title = String(renameManual[1] ?? '').trim().slice(0, 200);
    if (title) {
      return { pendingAction: { command: '!rename', mode: 'manual', args: { title } } };
    }
  }
  if (/\brename(?:\s+this)?\s+chat\b/i.test(raw)) {
    return { pendingAction: { command: '!rename', mode: 'auto' } };
  }

  const rememberMatch = raw.match(/\bremember\b\s+([a-zA-Z0-9 _-]{1,60})\s*(?:=|:|\bis\b)\s*(.+)$/i);
  if (rememberMatch) {
    const key = normalizeRememberKey(rememberMatch[1]);
    const value = String(rememberMatch[2] ?? '').trim();
    if (key && value) {
      return { pendingAction: { command: '!remember', args: { key, value } } };
    }
  }

  const nlRemember = tryExtractNaturalLanguageRememberPayload(raw);
  if (nlRemember && 'mixed' in nlRemember && nlRemember.mixed) {
    return { pendingAction: null };
  }
  if (nlRemember && 'payload' in nlRemember) {
    const inferred = inferRememberKeyAndValueFromPayload(nlRemember.payload, memoriesByKey);
    if (inferred?.key && inferred?.value) {
      return {
        pendingAction: { command: '!remember', args: { key: inferred.key, value: inferred.value } },
      };
    }
  }

  return { pendingAction: null };
}

function sanitizePendingAction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const cmd = String(raw.command ?? '');
  if (cmd === '!grocerylist') {
    const mode = raw.mode == null ? null : String(raw.mode);
    if (mode == null || mode === '') return { command: '!grocerylist' };
    if (mode === 'append' || mode === 'replace' || mode === 'prune') {
      return { command: '!grocerylist', mode };
    }
    return null;
  }
  if (cmd === '!help') return { command: cmd };
  if (cmd === '!remember') {
    const key = normalizeRememberKeyForStorage(raw.args?.key);
    const value = normalizeRememberValueForStorage(raw.args?.value);
    if (!key || !value) return null;
    return { command: '!remember', args: { key, value } };
  }
  if (cmd === '!rename') {
    const mode = raw.mode === 'manual' ? 'manual' : 'auto';
    if (mode === 'manual') {
      const title = String(raw.args?.title ?? '').trim().slice(0, 200);
      if (!title) return null;
      return { command: '!rename', mode, args: { title } };
    }
    return { command: '!rename', mode: 'auto' };
  }
  return null;
}

/**
 * Map a sanitized pending action to the route prompt used by /chat (must match client executePendingAction routing).
 */
function routePromptFromSanitizedPendingAction(action, fallbackPrompt) {
  if (!action || typeof action !== 'object') return fallbackPrompt;
  const cmd = String(action.command ?? '');
  if (cmd === '!grocerylist') return '!grocerylist';
  if (cmd === '!help') return '!help';
  if (cmd === '!rename') {
    return action.mode === 'manual' && action.args?.title
      ? `!rename ${String(action.args.title).trim()}`
      : '!rename';
  }
  if (cmd === '!remember' && action.args?.key != null && action.args?.value != null) {
    return `!remember ${action.args.key} = ${action.args.value}`;
  }
  return fallbackPrompt;
}

/**
 * Append a machine-readable pending payload to persisted assistant content (stripped for display).
 * @param {string} content
 * @param {object} pendingAction raw or sanitized pending object
 */
function appendPendingMarkerToAssistantContent(content, pendingAction) {
  const sanitized = sanitizePendingAction(pendingAction);
  if (!sanitized) return String(content ?? '');
  const encoded = encodeURIComponent(JSON.stringify(sanitized));
  return String(content ?? '').trimEnd() + '\n[[KB_PENDING:' + encoded + ']]';
}

/**
 * Recover pending from hidden marker in stored assistant text (before regex fallbacks).
 * @returns {ReturnType<typeof sanitizePendingAction> | null}
 */
function parsePendingMarkerFromAssistantContent(rawContent) {
  const t = String(rawContent ?? '');
  const m = t.match(/\[\[KB_PENDING:([^\]]+)\]\]/);
  if (!m) return null;
  try {
    const json = decodeURIComponent(m[1]);
    const obj = JSON.parse(json);
    return sanitizePendingAction(obj);
  } catch (e) {
    return null;
  }
}

function escapeInlineCodeSegment(s) {
  return String(s ?? '').replace(/`/g, "'");
}

/**
 * @param {Map<string, string> | null} memoriesByKey When set, remember offers can acknowledge an existing key and show merged value.
 */
function buildPendingActionReply(action, memoriesByKey = null) {
  if (!action) return '';
  if (action.command === '!grocerylist') {
    return "If you want, I can add this to the Grocery List tab. Want me to do that?";
  }
  if (action.command === '!help') {
    return 'I can show the help menu for you. Want me to do that?';
  }
  if (action.command === '!remember' && action.args?.key && action.args?.value) {
    const k = String(action.args.key);
    const v = String(action.args.value);
    const mergedCode = escapeInlineCodeSegment(`${k} = ${v}`);
    const memMap = memoriesByKey instanceof Map ? memoriesByKey : null;
    if (memMap && memMap.has(k)) {
      const existingRaw = String(memMap.get(k) ?? '').trim();
      if (existingRaw && existingRaw !== v.trim()) {
        const existingEsc = escapeInlineCodeSegment(existingRaw);
        const keyEsc = escapeInlineCodeSegment(k);
        return (
          `There is already a memory called \`${keyEsc}\` that says \`${existingEsc}\`. ` +
          `I can add this to it as \`${mergedCode}\`. Want me to do that?`
        );
      }
    }
    return `I can save that to memory as \`${mergedCode}\`. Want me to do that?`;
  }
  if (action.command === '!remember') {
    return 'I can save that to memory. Want me to do that?';
  }
  if (action.command === '!rename' && action.mode === 'manual') {
    return `I can rename this chat to "${action.args.title}". Want me to do that?`;
  }
  if (action.command === '!rename') {
    return 'I can rename this chat for you based on the thread context. Want me to do that?';
  }
  return '';
}

/**
 * Closing line for mixed-intent memory (primary task + memory clause). Deterministic, specific;
 * pairs with X-KitchenBot-Pending-Action for the same sanitized !remember proposal.
 */
function buildMixedMemoryOfferLine(pendingRemember, userMessage) {
  const key = pendingRemember?.args?.key ?? '';
  const val = String(pendingRemember?.args?.value ?? '').trim();
  const raw = String(userMessage ?? '');

  function nameHintFromMessage() {
    const m1 = raw.match(/\b([A-Z][a-z]+)\s+does\s+not\s+like\b/);
    if (m1) return m1[1];
    const m2 = raw.match(/\b([a-z]+)\s+does\s+not\s+like\b/i);
    if (m2) return m2[1].charAt(0).toUpperCase() + m2[1].slice(1).toLowerCase();
    const m3 = raw.match(/\bremember(?:ing)?\s+that\s+([A-Z][a-z]+)\b/i);
    if (m3) return m3[1];
    const m4 = raw.match(/\bremember(?:ing)?\s+that\s+([a-z]{2,})\b/i);
    if (m4) {
      const w = m4[1].toLowerCase();
      if (['your', 'the', 'our', 'my', 'this', 'that', 'their', 'they', 'there', 'she', 'he'].includes(w)) {
        return null;
      }
      return m4[1].charAt(0).toUpperCase() + m4[1].slice(1).toLowerCase();
    }
    return null;
  }

  if (!key || !val) {
    return 'Want me to save that as a household preference too?';
  }

    const prefMatch = key.match(/^([a-z][a-z0-9]*)_preferences$/);
  if (prefMatch) {
    const fromKey = prefMatch[1].charAt(0).toUpperCase() + prefMatch[1].slice(1);
    const hint = nameHintFromMessage();
    const label = hint && hint.toLowerCase() === prefMatch[1].toLowerCase() ? hint : fromKey;
    const detail = String(val ?? '').trim();
    if (detail) {
      return `If you want, I can save ${label}'s preference (${detail}) so I remember it next time too.`;
    }
    return `Want me to save that as a household preference for ${label} too?`;
  }

  if (key === 'tone') {
    const short = val.length > 70 ? val.slice(0, 67) + '…' : val;
    return `If you want, I can save your tone preference (${short}) so I remember it next time too.`;
  }

  const fav = key.match(/^favorite_(food|pasta|meal)$/);
  if (fav) {
    const short = val.length > 60 ? val.slice(0, 57) + '…' : val;
    return `Want me to save the favorite ${fav[1]} (${short}) as a household note too?`;
  }

  if (key === normalizeRememberKey('child_name')) {
    const short = val.length > 60 ? val.slice(0, 57) + '…' : val;
    return `If you want, I can save your child's name (${short}) for next time too.`;
  }

  if (key === normalizeRememberKey('household_staples')) {
    const short = val.length > 90 ? val.slice(0, 87) + '…' : val;
    return `If you want, I can save household staples (${short}) for next time too.`;
  }

  if (key === 'saved_note') {
    const short = val.length > 90 ? val.slice(0, 87) + '…' : val;
    return `If you want, I can save this (${short}) under household memory for next time too.`;
  }

  const short = val.length > 80 ? val.slice(0, 77) + '…' : val;
  return `If you want, I can save that (${short}) so I remember it next time too.`;
}

/** Narrow gate: only run AI memory proposal when the user clearly invoked memory language. */
function hasStrongMemoryIntentKeywords(text) {
  const lower = String(text ?? '').toLowerCase();
  if (/\bremember(?:ing)?\b/.test(lower)) return true;
  if (/\bmemory\b/.test(lower)) return true;
  if (/\bsave\s+this\b/.test(lower)) return true;
  if (/\bdon['']t\s+forget\b/.test(lower)) return true;
  return false;
}

/**
 * True when memory is likely secondary to another primary ask (meal plan, etc.).
 * Server-side heuristic; never overridden by the model.
 */
function isMixedIntentMemoryMessage(raw) {
  const nl = tryExtractNaturalLanguageRememberPayload(raw);
  if (nl && 'mixed' in nl && nl.mixed) return true;
  if (looksLikePrimaryNonMemoryTaskClause(raw) && /\b(remember|memory|remembering|don['']t\s+forget)\b/i.test(raw)) {
    return true;
  }
  return false;
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

/**
 * Structured memory proposal only; never persists. Returns a sanitized pending action or null.
 */
async function tryAiMemoryProposal(anthropic, userMessage, memoriesList) {
  if (!hasStrongMemoryIntentKeywords(userMessage)) return null;
  const existing = (memoriesList || [])
    .filter((m) => m && m.key !== 'assistant_name')
    .map((m) => `${m.key}: ${m.value}`)
    .join('\n');
  try {
    const res = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 400,
      system: `You help propose household memory key/value pairs. Output ONLY one JSON object (no markdown fences, no commentary) with this shape:
{"should_offer_memory":boolean,"key":string,"value":string,"confidence":number}

Rules:
- should_offer_memory: true only if the user clearly wants to save something for later recall (preferences, tone, dietary facts, names).
- Prefer reusing an EXISTING key from the list when the new fact belongs to the same topic (e.g. consolidate Elle-related preferences under elle_preferences, not a new key like elle or elle_eggs).
- Use stable snake_case keys (lowercase, underscores): e.g. elle_preferences, rob_preferences, household_staples, child_name, tone, favorite_food — never a long sentence as a key or keys like that_our_household_always_has_these_items. Values are short, natural preference text (e.g. "doesn't like eggs"), not commands or prefixes like "avoid …".
- If the key already exists in the list, the value field must be the full merged text you want stored: combine prior facts with the new fact in clear prose; separate distinct facts with semicolons. Do not comma-splice unrelated clauses (e.g. avoid "doesn't like eggs, loves capers"); prefer "doesn't like eggs; loves capers" or two short sentences.
- confidence: 0.0–1.0 (your confidence that this should be offered as a save).
- If there is nothing to save, set should_offer_memory to false, key and value to "", confidence to 0.`,
      messages: [
        {
          role: 'user',
          content: `Existing household memories (keys are unique; reuse when appropriate):\n${existing || '(none)'}\n\nUser message:\n${String(userMessage).slice(0, 4000)}`,
        },
      ],
    });
    const blocks = res.content.filter((b) => b.type === 'text');
    const raw = blocks.map((b) => b.text).join('\n').trim();
    const parsed = parseJsonObjectFromModelText(raw);
    if (!parsed || typeof parsed.should_offer_memory !== 'boolean') return null;
    const conf = Number(parsed.confidence);
    if (!parsed.should_offer_memory || !Number.isFinite(conf) || conf < 0.55) return null;
    let key = normalizeRememberKeyForStorage(parsed.key);
    let value = normalizeRememberValueForStorage(
      String(parsed.value ?? '')
        .trim()
        .slice(0, 2000)
    );
    if (!key || !value) return null;
    const memMap = new Map(
      (memoriesList || []).filter((m) => m && m.key).map((m) => [m.key, m.value])
    );
    if (isSentenceLikeRememberKey(key)) {
      const fromVal = inferRememberKeyAndValueFromPayload(value, memMap);
      const fromUser = inferRememberKeyAndValueFromPayload(String(userMessage ?? '').trim(), memMap);
      const picked =
        fromVal && fromVal.key !== normalizeRememberKey('saved_note')
          ? fromVal
          : fromUser && fromUser.key !== normalizeRememberKey('saved_note')
            ? fromUser
            : null;
      if (picked) {
        key = picked.key;
        value = picked.value;
      } else {
        key = normalizeRememberKey('saved_note');
      }
    }
    const prior = (memoriesList || []).find((m) => m && m.key === key);
    if (prior) {
      const merged = mergeMemoryProposalWithExisting(String(prior.value ?? ''), value);
      if (merged === null) return null;
      if (merged.trim() === String(prior.value ?? '').trim()) return null;
      value = merged;
    }
    return sanitizePendingAction({ command: '!remember', args: { key, value } });
  } catch (e) {
    if (isAnthropicSdkAuthOrKeyError(e)) throw e;
    console.error('Memory proposal AI failed:', e.message || e);
    return null;
  }
}

/** Matches client-side pending confirmation phrases (short replies only). */
function isShortAffirmativeConfirm(text) {
  const t = String(text ?? '').trim();
  if (t.length > 120) return false;
  const lower = t.toLowerCase();
  const s = lower.replace(/[!?.]/g, '').replace(/\s+/g, ' ').trim();
  if (
    [
      'yes',
      'yep',
      'yeah',
      'sure',
      'do it',
      'run it',
      'go ahead',
      'sure go ahead',
      'sure, go ahead',
      'yes please',
      'okay',
      'ok',
      'okay do it',
      'ok do it',
      'please do',
      'yeah save it',
      'yes save it',
      'sure save it',
      'yep save it',
      'ok save it',
      'okay save it',
      'yes save the preference please',
      'yeah save the preference please',
      'sure save the preference please',
      'yep save the preference please',
      'ok save the preference please',
      'okay save the preference please',
    ].includes(s)
  ) {
    return true;
  }
  if (/^(yes|yeah|yep|sure|ok|okay)\s+save\s+it$/.test(s)) {
    return true;
  }
  if (/^(yes|yeah|yep|sure|ok|okay)\s+save(\s+the)?\s+preference(\s+please)?$/.test(s)) {
    return true;
  }
  if (
    /^(yes|yeah|yep|sure|ok|okay)\s+update(\s+the)?\s+preferences(\s+please)?$/.test(s) ||
    /^(yes|yeah|yep|sure|ok|okay)\s+update\s+it(\s+please)?$/.test(s) ||
    /^(yes|yeah|yep|sure|ok|okay)\s+save(\s+the)?\s+preferences(\s+please)?$/.test(s)
  ) {
    return true;
  }
  if (['add it', 'add them', 'update it', 'push it', 'push it over'].includes(s)) {
    return true;
  }
  return /^(sure|yes|okay|ok)(?:,\s*|\s+)?(?:go ahead|do it|please)?$/.test(s);
}

/**
 * Natural-language confirmations for a recovered !grocerylist offer (not used without a matching last assistant offer).
 */
function isNaturalLanguageGroceryPendingConfirmation(text) {
  const t = String(text ?? '').trim();
  if (t.length > 200) return false;
  const lower = t.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/^\s*(why|what|when|where|who|how)\b/i.test(lower)) return false;
  if (/\b(don'?t|do not|never mind|nevermind|cancel|no thanks|no thank you)\b/i.test(lower)) return false;
  if (
    /^(okay|ok|yes|sure|yeah|yep)\s*,?\s*(let'?s|let us)\s+update\s+(the\s+)?grocery\s+list\b/i.test(lower) ||
    /^(let'?s|let us)\s+update\s+(the\s+)?grocery\s+list\b/i.test(lower)
  ) {
    return true;
  }
  if (
    /^(okay|ok|yes|sure|yeah|yep)\s*,?\s*(please\s+)?(go ahead\s+(and\s+)?)?update\s+(the\s+)?grocery\s+list\b/i.test(lower)
  ) {
    return true;
  }
  if (
    /^\s*(please\s+)?(go ahead\s+(and\s+)?)?update\s+(the\s+)?grocery\s+list\s*[!?.]*\s*$/i.test(lower)
  ) {
    return true;
  }
  if (
    /\b(go ahead|please)\s*,?\s*(and\s+)?(update\s+(the\s+)?grocery\s+list|add\s+(this|that|it|these|those)\s+to\s+(the\s+)?grocery\s+list)\b/i.test(lower)
  ) {
    return true;
  }
  if (
    /^(okay|ok|yes|sure|yeah|yep)\b/i.test(lower) &&
    /\b(add|put)\s+(this|that|it|these|those)\s+to\s+(the\s+)?(grocery|shopping)\s+list\b/i.test(lower)
  ) {
    return true;
  }
  // Same phrases as tryGroceryTabDeicticFollowUpPending: explicit follow-up after an in-chat draft + recoverable tab offer—confirm !grocerylist instead of re-offering / streaming another draft.
  if (
    /\bmake\s+a\s+grocery\s+list\s+from\s+this\b/.test(lower) ||
    /\bturn\s+this\s+into\s+(?:a\s+)?grocery\s+list\b/.test(lower)
  ) {
    return true;
  }
  return false;
}

/**
 * True if the user is confirming a recovered sanitized pending action (extends short phrases with NL grocery confirms).
 * @param {string} text
 * @param {ReturnType<typeof sanitizePendingAction>} pending
 */
function isPendingActionConfirmation(text, pending) {
  if (!pending || !text) return false;
  if (isShortAffirmativeConfirm(text)) return true;
  const cmd = String(pending.command ?? '');
  if (cmd === '!grocerylist') {
    return isNaturalLanguageGroceryPendingConfirmation(text);
  }
  return false;
}

/**
 * Parse mixed-intent memory offer closing lines (same templates as buildMixedMemoryOfferLine).
 * @returns {ReturnType<typeof sanitizePendingAction> | null}
 */
function recoverRememberFromMixedOfferAssistantContent(content) {
  const t = stripKitchenBotHiddenMarkers(String(content ?? ''));
  let m = t.match(
    /If you want, I can save (.+?)['\u2019]s preference \(([^)]+)\) so I remember it next time too\.?/
  );
  if (m) {
    const name = m[1].trim();
    const detail = m[2].trim();
    const key = normalizeRememberKey(`${name}_preferences`);
    const value = detail;
    return sanitizePendingAction({ command: '!remember', args: { key, value } });
  }
  m = t.match(
    /If you want, I can save your tone preference \(([^)]+)\) so I remember it next time too\.?/
  );
  if (m) {
    return sanitizePendingAction({ command: '!remember', args: { key: 'tone', value: m[1].trim() } });
  }
  m = t.match(/Want me to save the favorite (food|pasta|meal) \(([^)]+)\) as a household note too\?/);
  if (m) {
    return sanitizePendingAction({
      command: '!remember',
      args: { key: normalizeRememberKey(`favorite_${m[1]}`), value: m[2].trim() },
    });
  }
  m = t.match(
    /If you want, I can save this \(([^)]+)\) under household memory for next time too\.?/
  );
  if (m) {
    const inferred = inferRememberKeyAndValueFromPayload(m[1].trim(), new Map());
    if (inferred?.key && inferred?.value) {
      return sanitizePendingAction({ command: '!remember', args: { key: inferred.key, value: inferred.value } });
    }
    return sanitizePendingAction({
      command: '!remember',
      args: { key: 'saved_note', value: m[1].trim() },
    });
  }
  m = t.match(/If you want, I can save that \(([^)]+)\) so I remember it next time too\.?/);
  if (m) {
    const inferred = inferRememberKeyAndValueFromPayload(m[1].trim(), new Map());
    if (inferred?.key && inferred?.value) {
      return sanitizePendingAction({ command: '!remember', args: { key: inferred.key, value: inferred.value } });
    }
    return sanitizePendingAction({
      command: '!remember',
      args: { key: 'saved_note', value: m[1].trim() },
    });
  }
  return null;
}

/**
 * Recover !remember from merge-aware offer (see buildPendingActionReply with existing key).
 */
function parseRememberMergeOfferFromAssistantContent(content) {
  const t = String(content ?? '');
  const re =
    /There is already a memory called `([^`]+)` that says `([^`]*)`\.\s+I can add this to it as `([^`]+)`\. Want me to do that\?/i;
  const m = t.match(re);
  if (!m) return null;
  const combined = String(m[3] ?? '').trim();
  const eq = combined.indexOf(' = ');
  if (eq === -1) return null;
  const keyRaw = combined.slice(0, eq).trim();
  const valueRaw = combined.slice(eq + 3).trim();
  const key = normalizeRememberKey(keyRaw);
  const value = String(valueRaw).trim();
  if (!key || !value) return null;
  return sanitizePendingAction({ command: '!remember', args: { key, value } });
}

/**
 * Recover a !remember pending action from assistant message text (same chat).
 * Matches standard offer lines with plain and/or backticked key/value (case-insensitive anchor).
 * @returns {ReturnType<typeof sanitizePendingAction> | null}
 */
function parseRememberPendingFromAssistantContent(rawContent) {
  const content = stripKitchenBotHiddenMarkers(String(rawContent ?? ''));
  const mergePending = parseRememberMergeOfferFromAssistantContent(content);
  if (mergePending) return mergePending;
  const anchorRe = /I can save that to memory as /i;
  const am = anchorRe.exec(content);
  if (!am) return recoverRememberFromMixedOfferAssistantContent(content);
  const suffix = '. Want me to do that?';
  const afterAnchor = am.index + am[0].length;
  const end = content.indexOf(suffix, afterAnchor);
  if (end === -1) return recoverRememberFromMixedOfferAssistantContent(content);
  let mid = content.slice(afterAnchor, end).trim();
  function stripOuterBackticks(seg) {
    const t = String(seg).trim();
    if (t.length >= 2 && t.startsWith('`') && t.endsWith('`')) return t.slice(1, -1);
    return t;
  }
  const inner = stripOuterBackticks(mid);
  const eq = inner.indexOf(' = ');
  if (eq === -1) return recoverRememberFromMixedOfferAssistantContent(content);
  const keyRaw = inner.slice(0, eq).trim();
  const valueRaw = inner.slice(eq + 3).trim();
  const key = normalizeRememberKey(keyRaw);
  const value = String(valueRaw).trim();
  if (!key || !value) return recoverRememberFromMixedOfferAssistantContent(content);
  return sanitizePendingAction({ command: '!remember', args: { key, value } });
}

/**
 * Recover !grocerylist from assistant text (marker is stripped before persist; match visible offer lines).
 * @returns {ReturnType<typeof sanitizePendingAction> | null}
 */
function recoverGroceryPendingFromAssistantContent(rawContent) {
  const t = stripKitchenBotHiddenMarkers(String(rawContent ?? ''));
  if (
    /If you want, I can add this to (?:the )?Grocery List tab(?:\s+for you)?\.?/i.test(t) ||
    /If you want, I can update (?:the )?Grocery List tab(?:\s+for you)?\.?/i.test(t) ||
    /That's a command-backed action\.\s*I can run !grocerylist for you\.\s*Want me to do that\?/i.test(t) ||
    /\bI can run !grocerylist for you\b/i.test(t)
  ) {
    return sanitizePendingAction({ command: '!grocerylist' });
  }
  return null;
}

/**
 * Recover !help / !rename offers from buildPendingActionReply text.
 * @returns {ReturnType<typeof sanitizePendingAction> | null}
 */
function recoverHelpPendingFromAssistantContent(rawContent) {
  const t = stripKitchenBotHiddenMarkers(String(rawContent ?? ''));
  if (/I can show the help menu for you\.\s*Want me to do that\?/i.test(t)) {
    return sanitizePendingAction({ command: '!help' });
  }
  return null;
}

/**
 * @returns {ReturnType<typeof sanitizePendingAction> | null}
 */
function recoverRenamePendingFromAssistantContent(rawContent) {
  const t = stripKitchenBotHiddenMarkers(String(rawContent ?? ''));
  const manual = t.match(
    /I can rename this chat to ["\u201c](.+?)["\u201d]\.\s*Want me to do that\?/i
  );
  if (manual) {
    const title = String(manual[1] ?? '')
      .trim()
      .slice(0, 200);
    if (title) return sanitizePendingAction({ command: '!rename', mode: 'manual', args: { title } });
  }
  if (
    /I can rename this chat for you based on the thread context\.\s*Want me to do that\?/i.test(t)
  ) {
    return sanitizePendingAction({ command: '!rename', mode: 'auto' });
  }
  return null;
}

/**
 * If the client lost X-KitchenBot-Pending-Action, recover a pending action from the latest assistant message in this chat.
 * Replaces the old memory-only recoverRememberPendingFromLastAssistantMessage.
 * Parsers are ordered: [[KB_PENDING:…]] marker → remember → grocery → rename → help (memory before grocery when both appear, e.g. mixed intent + marker).
 * Add new command recoverers here; map them in routePromptFromSanitizedPendingAction.
 */
async function recoverPendingActionFromLastAssistantMessage(chatId, householdId) {
  const conv = await getMessages(chatId, householdId);
  const lastAssistant = [...conv].reverse().find((m) => m.role === 'assistant');
  if (!lastAssistant) return null;
  const raw = lastAssistant.content;
  return (
    parsePendingMarkerFromAssistantContent(raw) ||
    parseRememberPendingFromAssistantContent(raw) ||
    recoverGroceryPendingFromAssistantContent(raw) ||
    recoverRenamePendingFromAssistantContent(raw) ||
    recoverHelpPendingFromAssistantContent(raw)
  );
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
    const k = normalizeGroceryNameKey(candidate);
    if (k) keys.add(k);
  }
  return keys;
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
              <div id="my-settings-memories-msg" style="font-size: 13px; color: var(--accent-strong); margin-bottom: 8px;"></div>
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
        const pendingActionByChatId = new Map();

        function isPendingActionAffirmative(text) {
          const t = String(text ?? '').trim().toLowerCase();
          const s = t.replace(/[!?.]/g, '').replace(/\s+/g, ' ').trim();
          if (t.length > 120) return false;
          if (
            [
              'yes',
              'yep',
              'yeah',
              'sure',
              'do it',
              'run it',
              'go ahead',
              'sure go ahead',
              'sure, go ahead',
              'yes please',
              'okay',
              'ok',
              'okay do it',
              'ok do it',
              'please do',
              'yeah save it',
              'yes save it',
              'sure save it',
              'yep save it',
              'ok save it',
              'okay save it',
              'yes save the preference please',
              'yeah save the preference please',
              'sure save the preference please',
              'yep save the preference please',
              'ok save the preference please',
              'okay save the preference please',
            ].includes(s)
          ) {
            return true;
          }
          if (/^(yes|yeah|yep|sure|ok|okay)\s+save\s+it$/.test(s)) {
            return true;
          }
          if (/^(yes|yeah|yep|sure|ok|okay)\s+save(\s+the)?\s+preference(\s+please)?$/.test(s)) {
            return true;
          }
          if (
            [
              'add it',
              'add them',
              'update it',
              'push it',
              'push it over',
            ].includes(s)
          ) {
            return true;
          }
          return /^(sure|yes|okay|ok)(?:,\s*|\s+)?(?:go ahead|do it|please)?$/.test(s);
        }

        function isPendingActionDecline(text) {
          const t = String(text ?? '').trim().toLowerCase();
          return ['no', 'nope', 'cancel', 'nevermind', 'never mind'].includes(t);
        }

        /** Vague affirmations that must not pick append/prune/replace for grocery_mode_choice. */
        function isGroceryVagueOrAffirmative(t) {
          const s = String(t ?? '').trim().toLowerCase();
          if (!s) return false;
          if (
            [
              'yes',
              'yep',
              'yeah',
              'do it',
              'run it',
              'go ahead',
              'update it',
              'fix it',
              'sure',
              'ok',
              'okay',
            ].includes(s)
          ) {
            return true;
          }
          return /^(yes|sure|ok|okay)\s*[!?.]*\s*$/i.test(s);
        }

        function groceryPendingClarifyText(pending) {
          const opts = pending && Array.isArray(pending.options) ? pending.options : [];
          if (opts.some((o) => o.mode === 'prune')) {
            return 'I need to know which behavior you want: keep the old items too, or remove the items we swapped out?';
          }
          if (opts.some((o) => o.mode === 'replace')) {
            return "I need to know which behavior you want: start a new grocery list, or add these items to what's already there?";
          }
          return "Please choose one option so I don't run the wrong action: say 'add', 'start new', 'keep', or 'remove swapped-out items'.";
        }

        /** Replace (start fresh) intent for grocery_mode_choice — not used for vague affirmations (caller checks first). */
        function groceryUserWantsReplace(t) {
          const s = String(t ?? '').trim().toLowerCase();
          if (!s) return false;
          if (isGroceryVagueOrAffirmative(s)) return false;
          if (s === 'new' || /^new\s*[!?.]*\s*$/i.test(s)) return true;
          if (s === 'fresh' || /^fresh\s*[!?.]*\s*$/i.test(s)) return true;
          if (s === 'replace' || /^replace\s*[!?.]*\s*$/i.test(s)) return true;
          if (s === 'overwrite' || /^overwrite\s*[!?.]*\s*$/i.test(s)) return true;
          const phrases = [
            'start new',
            'start a new',
            'start a new one',
            'start a new list',
            'start a new grocery list',
            'new list',
            'start fresh',
            'start over',
            'wipe it and start over',
            'replace it',
            "replace what's there",
            'replace what’s there',
          ];
          for (const p of phrases) {
            if (s.includes(p)) return true;
          }
          if (s.includes('replace what') && s.includes('there')) return true;
          return false;
        }

        function resolvePendingActionFromUserReply(text, pending) {
          const t = String(text ?? '').trim().toLowerCase();
          if (!pending) return { kind: 'none', action: null };
          if (isPendingActionDecline(t)) return { kind: 'decline', action: null };
          if (Array.isArray(pending.options) && pending.options.length > 0) {
            const options = pending.options;
            const hasPrune = options.some((o) => String(o.mode || '') === 'prune');
            const hasReplace = options.some((o) => String(o.mode || '') === 'replace');

            const strictAppendToList =
              /^\s*(add|append|keep)(\s*[!?.])?\s*$/i.test(t) ||
              /^\s*keep\s*$/i.test(t) ||
              /^\s*keep\s+both\s*$/i.test(t) ||
              /\bkeep\s+both\b/i.test(t) ||
              /\b(add|keep)\s+both\b/i.test(t) ||
              /\bkeep\s+old\s+and\s+new\b/i.test(t) ||
              /\bkeep\s+(?:them|old\s+items|everything|the\s+old(?:\s+items)?)\b/i.test(t) ||
              /\bkeep\s+old\b/i.test(t) ||
              /\badd\s+(?:to|these|it)\b/i.test(t) ||
              /\badd\s+to\s+what(?:'|'|\u2019)s\s+(?:already\s+)?there\b/i.test(t);

            const mealPrune =
              /\bprune\b/i.test(t) ||
              /^\s*remove\s*[!?.]*\s*$/i.test(t) ||
              /\bremove\s+the\s+ones\s+we\s+swapped\s+out\b/i.test(t) ||
              /\bremove\s+old\b/i.test(t) ||
              /\bremove\s+(?:old\s+items|swapped\s*-?\s*out\s+items|the\s+items\s+we\s+swapped\s+out)\b/i.test(t) ||
              /\bremove\s+swapped/i.test(t) ||
              /\b(swapped|swap)\s+them\s+out\b/i.test(t) ||
              /\bclean\s+up\s+old\s+items\b/i.test(t) ||
              /\breplace\s+old\s+items\b/i.test(t) ||
              /\bswapped[- ]?out\b/i.test(t) ||
              /\bdrop\s+old\b/i.test(t);

            if (hasPrune) {
              if (isGroceryVagueOrAffirmative(t)) return { kind: 'ambiguous', action: null };
              if (mealPrune) {
                return {
                  kind: 'execute',
                  action: options.find((o) => o.command === '!grocerylist' && o.mode === 'prune') || null,
                };
              }
              if (strictAppendToList) {
                return {
                  kind: 'execute',
                  action: options.find((o) => o.command === '!grocerylist' && o.mode === 'append') || null,
                };
              }
              return { kind: 'none', action: null };
            }

            if (hasReplace) {
              if (isGroceryVagueOrAffirmative(t)) {
                return { kind: 'ambiguous', action: null };
              }
              const wantsReplace = groceryUserWantsReplace(t);
              const replaceAction =
                options.find(
                  (o) =>
                    String(o.command ?? '') === '!grocerylist' && String(o.mode ?? '') === 'replace'
                ) || null;
              if (wantsReplace) {
                return {
                  kind: 'execute',
                  action: replaceAction,
                };
              }
              if (strictAppendToList) {
                return {
                  kind: 'execute',
                  action:
                    options.find(
                      (o) =>
                        String(o.command ?? '') === '!grocerylist' && String(o.mode ?? '') === 'append'
                    ) || null,
                };
              }
              return { kind: 'none', action: null };
            }

            return { kind: 'none', action: null };
          }
          if (isPendingActionAffirmative(t)) return { kind: 'execute', action: pending };
          return { kind: 'none', action: null };
        }

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
          clearMemoryUiMessage();
          tabChat.classList.toggle('tab-active', tab === 'chat');
          tabGroceries.classList.toggle('tab-active', tab === 'groceries');
          if (tabSettings) tabSettings.classList.toggle('tab-active', tab === 'settings');
          chat.style.display = tab === 'chat' ? 'flex' : 'none';
          groceryPanel.style.display = tab === 'groceries' ? 'flex' : 'none';
          if (settingsPanel) settingsPanel.style.display = tab === 'settings' ? 'flex' : 'none';
          if (inputArea) inputArea.style.display = tab === 'chat' ? 'flex' : 'none';
          if (tab === 'settings') loadSettingsPanel();
        }

        function closeSidebarAndGoToChatTab() {
          setActiveTab('chat');
          sidebar.classList.remove('open');
          sidebarBackdrop.classList.remove('open');
        }

        function syncMemoriesWrapVisibility() {
          const w = document.getElementById('my-settings-memories-wrap');
          if (w) w.style.display = isCurrentUserOwner ? '' : 'none';
        }

        function clearMemoryUiMessage() {
          const el = document.getElementById('my-settings-memories-msg');
          if (el) el.textContent = '';
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
              strong.textContent = stripMemoryDisplayWrappers(m.key);
              kv.appendChild(strong);
              kv.appendChild(document.createTextNode(': '));
              const span = document.createElement('span');
              span.style.wordBreak = 'break-word';
              span.textContent = stripMemoryDisplayWrappers(m.value);
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
                  keyIn.value = stripMemoryDisplayWrappers(m.key);
                  keyIn.readOnly = true;
                }
                if (valIn) valIn.value = stripMemoryDisplayWrappers(m.value);
                if (cancelBtn) cancelBtn.style.display = '';
                clearMemoryUiMessage();
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
                  memMsg.textContent = dr.ok
                    ? 'Memory deleted.'
                    : mapServerReadOnlyErrorMessage(errBody.error) || 'Delete failed';
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
                  clearMemoryUiMessage();
                  roleFeedback.textContent = '';
                  syncRoleButtonState();
                });
                syncRoleButtonState();
              }
              roleBtn.addEventListener('click', async () => {
                clearMemoryUiMessage();
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
                clearMemoryUiMessage();
                pinFeedback.textContent = '';
                syncPinButton();
              });
              btn.addEventListener('click', async () => {
                clearMemoryUiMessage();
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
              const complCol = document.createElement('div');
              complCol.className = 'settings-user-row-role-col';
              const prefGrid = document.createElement('div');
              prefGrid.className = 'settings-user-pref-grid';
              const complWrap = document.createElement('label');
              complWrap.className = 'settings-user-pref-toggle';
              const complChk = document.createElement('input');
              complChk.type = 'checkbox';
              complChk.checked = u.complimentsEnabled !== false;
              const complFeedback = document.createElement('div');
              complFeedback.className = 'settings-user-row-role-feedback';
              complFeedback.setAttribute('aria-live', 'polite');
              let complimentsSaving = false;
              complChk.addEventListener('change', async () => {
                clearMemoryUiMessage();
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
                    complFeedback.textContent =
                      mapServerReadOnlyErrorMessage(errBody.error) || 'Failed to update compliments';
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
                clearMemoryUiMessage();
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
              prefGrid.appendChild(complWrap);
              prefGrid.appendChild(complFeedback);
              prefGrid.appendChild(colorCol);
              complCol.appendChild(prefGrid);
              row.appendChild(complCol);
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
          clearMemoryUiMessage();
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
                    : mapServerReadOnlyErrorMessage(errBody.error) || 'Failed to update PIN.';
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
            clearMemoryUiMessage();
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
            clearMemoryUiMessage();
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
            clearMemoryUiMessage();
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
                memMsg.textContent = r.ok ? 'Saved.' : mapServerReadOnlyErrorMessage(errBody.error) || 'Save failed';
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
            clearMemoryUiMessage();
            resetMemoryEditForm();
          });
        }

        const memKeyInputEl = document.getElementById('my-settings-memory-key');
        const memValInputEl = document.getElementById('my-settings-memory-value');
        const onMemoryFieldInput = () => clearMemoryUiMessage();
        if (memKeyInputEl) memKeyInputEl.addEventListener('input', onMemoryFieldInput);
        if (memValInputEl) memValInputEl.addEventListener('input', onMemoryFieldInput);

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
          const pendingForChat =
            currentChatId != null ? pendingActionByChatId.get(Number(currentChatId)) : null;
          const pendingHasOptions =
            pendingForChat &&
            Array.isArray(pendingForChat.options) &&
            pendingForChat.options.length > 0;
          const pendingResolution = resolvePendingActionFromUserReply(prompt, pendingForChat);
          const actionToExecute =
            pendingResolution.kind === 'execute' && pendingResolution.action
              ? pendingResolution.action
              : null;
          const groceryClarifyMsg = pendingHasOptions
            ? groceryPendingClarifyText(pendingForChat)
            : "Please choose one option so I don't run the wrong action: say 'add', 'start new', 'keep', or 'remove swapped-out items'.";
          if (pendingForChat && pendingResolution.kind === 'decline') {
            pendingActionByChatId.delete(Number(currentChatId));
          } else if (pendingForChat && pendingResolution.kind === 'none' && pendingHasOptions) {
            addMessage('user', speaker, prompt);
            addMessage('assistant', 'KitchenBot', groceryClarifyMsg);
            promptInput.value = '';
            resizePromptInput();
            chat.scrollTop = chat.scrollHeight;
            return;
          } else if (pendingForChat && pendingResolution.kind === 'none') {
            pendingActionByChatId.delete(Number(currentChatId));
          } else if (pendingForChat && pendingResolution.kind === 'ambiguous') {
            addMessage('user', speaker, prompt);
            addMessage('assistant', 'KitchenBot', groceryClarifyMsg);
            promptInput.value = '';
            resizePromptInput();
            chat.scrollTop = chat.scrollHeight;
            return;
          } else if (pendingForChat && actionToExecute) {
            pendingActionByChatId.delete(Number(currentChatId));
          }
          // Grocery mode-choice replies must continue into the real !grocerylist command path, not return success early.
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
              body: JSON.stringify({
                prompt,
                name: speaker,
                chatId: currentChatId,
                ...(actionToExecute ? { executePendingAction: actionToExecute } : {}),
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

            const pendingActionHeader = response.headers.get('X-KitchenBot-Pending-Action');
            if (pendingActionHeader && currentChatId != null) {
              try {
                pendingActionByChatId.set(
                  Number(currentChatId),
                  JSON.parse(decodeURIComponent(pendingActionHeader))
                );
              } catch (e) {
                pendingActionByChatId.delete(Number(currentChatId));
              }
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
    await upsertHouseholdMemory(req.householdId, key, value);
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

/**
 * Merge AI-parsed rows into existing list: match unchecked items by section + normalized name; update amount or insert.
 * @returns {{ insertedCount: number, updatedCount: number, backfilledCount: number, changedCount: number }}
 * `changedCount` is inserts + amount updates only (not provenance backfill).
 */
async function mergeGroceryItemsFromAi(householdId, parsedItems, sourceChatId) {
  const empty = { insertedCount: 0, updatedCount: 0, backfilledCount: 0, changedCount: 0 };
  if (!parsedItems.length) return empty;
  let insertedCount = 0;
  let updatedCount = 0;
  let backfilledCount = 0;
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
      if (Number.isFinite(Number(sourceChatId))) {
        try {
          const n = await backfillGroceryItemSourceChatIfSafe(householdId, match.id, sourceChatId);
          backfilledCount += Number(n) || 0;
        } catch (_) {
          // Non-fatal provenance backfill.
        }
      }
      const oldAmt = String(match.amount ?? '').trim();
      if (newAmt !== '' && newAmt !== oldAmt) {
        try {
          await updateGroceryItemAmount(householdId, match.id, newAmt);
          updatedCount += 1;
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
  if (toInsert.length) {
    await addGroceryItems(householdId, toInsert, {
      sourceChatId: Number.isFinite(Number(sourceChatId)) ? Number(sourceChatId) : null,
    });
    insertedCount = toInsert.length;
  }
  const changedCount = insertedCount + updatedCount;
  return { insertedCount, updatedCount, backfilledCount, changedCount };
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
    let executePendingAction = sanitizePendingAction(req.body.executePendingAction);
    let routePrompt = routePromptFromSanitizedPendingAction(executePendingAction, prompt);

    /** Last assistant recoverable pending (if any); used before NL intent and to avoid duplicate offers. */
    let recoveredPending = null;
    if (!executePendingAction && prompt) {
      recoveredPending = await recoverPendingActionFromLastAssistantMessage(chatId, req.householdId);
      if (recoveredPending && isPendingActionConfirmation(prompt, recoveredPending)) {
        executePendingAction = recoveredPending;
        routePrompt = routePromptFromSanitizedPendingAction(recoveredPending, prompt);
        // Recovered confirmations must flow through the real command path, never plain chat.
      }
    }

    const commandUserTextForPersistence = executePendingAction ? prompt : routePrompt;

    const memories = await getMemories(req.householdId);
    const memoriesByKey = new Map(memories.map((m) => [m.key, m.value]));

    // Only reach this fallback if no executePendingAction exists AND recovery failed.
    if (!executePendingAction && prompt && isShortAffirmativeConfirm(prompt) && !String(routePrompt ?? '').trim().startsWith('!')) {
      const reply =
        'Looks like I thought there was an action ready to run here, but there wasn\'t. You can keep chatting normally, or if you meant to run a command, type it explicitly.';
      await addMessage(chatId, req.householdId, 'user', name, commandUserTextForPersistence);
      await addMessage(chatId, req.householdId, 'assistant', 'KitchenBot', reply);
      await incrementUserMessageCountForSender(req);
      if (typeof broadcastToChat === 'function') {
        broadcastToChat(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });
      }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(reply);
    }

    if (!executePendingAction && routePrompt && !String(routePrompt).trim().startsWith('!')) {
      if (!isShortAffirmativeConfirm(prompt)) {
        const threadCtxForIntent = await getChatThreadContext(chatId, req.householdId);
        const convForDraft = await getMessages(chatId, req.householdId);
        const assistantContents = convForDraft
          .filter((m) => m.role === 'assistant')
          .slice(-3)
          .map((m) => stripStoredMessageContentForDisplay(m.content));
        const hasGroceryDraft = threadHasConcreteGroceryDraftForFollowUp(
          threadCtxForIntent.threadGrocerySummary,
          assistantContents
        );
        const intent = detectCommandIntentFromNaturalLanguage(routePrompt, memoriesByKey, {
          hasGroceryDraft,
        });
        if (intent.pendingAction) {
          const dupGroceryOffer =
            recoveredPending &&
            recoveredPending.command === '!grocerylist' &&
            intent.pendingAction.command === '!grocerylist';
          if (!dupGroceryOffer) {
            const reply = buildPendingActionReply(intent.pendingAction, memoriesByKey);
            await addMessage(chatId, req.householdId, 'user', name, routePrompt);
            await addMessage(
              chatId,
              req.householdId,
              'assistant',
              'KitchenBot',
              appendPendingMarkerToAssistantContent(reply, intent.pendingAction)
            );
            await incrementUserMessageCountForSender(req);
            if (typeof broadcastToChat === 'function') {
              broadcastToChat(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });
            }
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('X-KitchenBot-Pending-Action', encodeURIComponent(JSON.stringify(intent.pendingAction)));
            return res.end(reply);
          }
          // duplicate !grocerylist offer vs last assistant: fall through to normal chat for this turn
        }
      }
    }

    // Private commands (!love, !help, !memories): isPrivateChatCommand — HTTP reply to sender only; no addMessage / broadcastToChat.
    if (isPrivateChatCommand(routePrompt) && /^!love(?:\s|$)/.test(routePrompt)) {
      const loveRest = routePrompt.match(/^!love\s*(.*)$/);
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

    if (routePrompt === '!help' && isPrivateChatCommand(routePrompt)) {
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

    const renameMatch = routePrompt?.match(/^!rename\s*(.*)$/);
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
          content:
            m.role === 'user' ? `${m.name}: ${m.content}` : stripStoredMessageContentForDisplay(m.content),
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

    const memoriesCommand = isMemoriesCommand(routePrompt);

    const memoryParsed =
      executePendingAction?.command === '!remember'
        ? { key: executePendingAction.args.key, value: executePendingAction.args.value }
        : parseMemoryCommand(routePrompt);
    const groceryListCommand = isGroceryListCommand(routePrompt);

    if (memoriesCommand && isPrivateChatCommand(routePrompt)) {
      const memoriesFiltered = memories.filter((m) => m.key !== 'assistant_name');

      const reply = memoriesFiltered.length
        ? 'Current memories:\n' + memoriesFiltered.map(memory => `- ${memory.key}: ${memory.value}`).join('\n')
        : 'No memories stored.';

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(reply);
    }

    // Shared command !remember: isSharedChatCommand (memoryParsed); persist + broadcast.
    if (memoryParsed && isSharedChatCommand(routePrompt, memoryParsed)) {
      await addMessage(chatId, req.householdId, 'user', name, commandUserTextForPersistence);
      let reply;
      if (memoryParsed.error) {
        reply = memoryParsed.error;
        await addMessage(chatId, req.householdId, 'assistant', 'KitchenBot', reply);
      } else {
        const normKey = normalizeRememberKeyForStorage(memoryParsed.key);
        const newValue = normalizeRememberValueForStorage(memoryParsed.value);
        const existing = memories.find((r) => r.key === normKey);
        if (!existing) {
          await upsertHouseholdMemory(req.householdId, memoryParsed.key, memoryParsed.value);
          reply = `Got it. I saved memory ${normKey} = ${newValue}.`;
        } else {
          const existingValue = String(existing.value ?? '');
          const merged = mergeMemoryProposalWithExisting(existingValue, newValue);
          if (merged === null || merged.trim() === existingValue.trim()) {
            reply = `No change — ${normKey} already includes that.`;
          } else {
            const mergedStored = normalizeRememberValueForStorage(merged);
            await upsertHouseholdMemory(req.householdId, normKey, mergedStored);
            reply = `Got it. I saved memory ${normKey} = ${mergedStored}.`;
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

    if (groceryListCommand && isSharedChatCommand(routePrompt, memoryParsed)) {
      await incrementUserMessageCountForSender(req);
      const requestedGroceryMode =
        executePendingAction && executePendingAction.command === '!grocerylist'
          ? executePendingAction.mode || null
          : null;

      const conversation = await getMessages(chatId, req.householdId);
      const conversationForContext = conversation.filter(
        m => m.role !== 'user' || !String(m.content || '').trim().startsWith('!')
      );
      const recentConversation =
        conversationForContext.length > 40 ? conversationForContext.slice(-40) : conversationForContext;

      const priorCtx = await getChatThreadContext(chatId, req.householdId);
      const priorMealPlanSummary = priorCtx.mealPlanSummary;
      const priorThreadGrocerySummary = priorCtx.threadGrocerySummary;
      const threadHasGroceryContext = priorThreadGrocerySummary.trim().length > 0;
      const existingGroceryItems = await getGroceryItems(req.householdId);

      const memoryText = memories
        .map(memory => `${memory.key}: ${memory.value}`)
        .join('\n');

      if (requestedGroceryMode == null && !threadHasGroceryContext && existingGroceryItems.length > 0) {
        const reply =
          "Looks like you already have items in your Grocery tab. Do you want me to start a new list or add these to what's already there?";
        await addMessage(chatId, req.householdId, 'user', name, commandUserTextForPersistence);
        await addMessage(chatId, req.householdId, 'assistant', 'KitchenBot', reply);
        if (typeof broadcastToChat === 'function') {
          broadcastToChat(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });
        }
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader(
          'X-KitchenBot-Pending-Action',
          encodeURIComponent(
            JSON.stringify({
              type: 'grocery_mode_choice',
              options: [
                { command: '!grocerylist', mode: 'replace' },
                { command: '!grocerylist', mode: 'append' },
              ],
            })
          )
        );
        return res.end(reply);
      }

      const claudeMessages = recentConversation.map(message => ({
        role: message.role,
        content:
          message.role === 'user'
            ? `${message.name}: ${message.content}`
            : stripStoredMessageContentForDisplay(message.content),
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
      const priorKeys = parseThreadGrocerySummaryKeys(priorThreadGrocerySummary);
      const runKeys = new Set(normalizedItems.map((i) => normalizeGroceryNameKey(i.name)).filter(Boolean));
      const likelyRemovedKeys = new Set([...priorKeys].filter((k) => !runKeys.has(k)));
      const likelyAddedKeys = new Set([...runKeys].filter((k) => !priorKeys.has(k)));
      const planChangedLikely =
        priorKeys.size > 0 && runKeys.size > 0 && (likelyRemovedKeys.size > 0 || likelyAddedKeys.size > 0);

      if (requestedGroceryMode == null && threadHasGroceryContext && planChangedLikely) {
        const reply =
          'We made some changes to this plan. Do you want me to keep the old items or remove the items we swapped out?';
        await addMessage(chatId, req.householdId, 'user', name, commandUserTextForPersistence);
        await addMessage(chatId, req.householdId, 'assistant', 'KitchenBot', reply);
        if (typeof broadcastToChat === 'function') {
          broadcastToChat(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });
        }
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader(
          'X-KitchenBot-Pending-Action',
          encodeURIComponent(
            JSON.stringify({
              type: 'grocery_mode_choice',
              options: [
                { command: '!grocerylist', mode: 'append' },
                { command: '!grocerylist', mode: 'prune' },
              ],
            })
          )
        );
        return res.end(reply);
      }

      const effectiveGroceryMode = requestedGroceryMode || 'append';
      const beforeGroceryCount = existingGroceryItems.length;
      let replaceClearedCount = 0;
      let prunedCount = 0;
      if (effectiveGroceryMode === 'replace') {
        replaceClearedCount = await clearGroceryItems(req.householdId);
      } else if (effectiveGroceryMode === 'prune') {
        try {
          prunedCount = await pruneStaleGroceryItemsForChat(
            req.householdId,
            runKeys,
            chatId,
            likelyRemovedKeys
          );
        } catch (e) {
          console.error('Grocery prune failed:', e.message || e);
        }
      }
      let mergeStats = { insertedCount: 0, updatedCount: 0, backfilledCount: 0, changedCount: 0 };
      if (normalizedItems.length > 0) {
        mergeStats = await mergeGroceryItemsFromAi(req.householdId, normalizedItems, chatId);
      }
      const afterGroceryItems = await getGroceryItems(req.householdId);
      const afterGroceryCount = afterGroceryItems.length;

      const totalDbContentChanges =
        replaceClearedCount + prunedCount + mergeStats.changedCount;
      const groceryListWasUpdated = totalDbContentChanges > 0;

      const conversationSnippet = recentConversation
        .map((m) =>
          m.role === 'user'
            ? `${m.name}: ${m.content}`
            : stripStoredMessageContentForDisplay(String(m.content ?? ''))
        )
        .join('\n\n');
      const commandOutcomeBlock = groceryListWasUpdated
        ? `Command outcome (this request only — server facts; treat as true):\n- User ran !grocerylist in this chat.\n- The household grocery list in the app changed this request: ${totalDbContentChanges} total (inserts: ${mergeStats.insertedCount}, amount updates: ${mergeStats.updatedCount}, prune removals: ${prunedCount}, replace-mode rows cleared: ${replaceClearedCount}). Provenance-only backfills (not list content): ${mergeStats.backfilledCount}.\n- Sanity check: grocery row count before ${beforeGroceryCount}, after ${afterGroceryCount}.`
        : `Command outcome (this request only — server facts; treat as true):\n- User ran !grocerylist in this chat.\n- The household grocery list in the app was not changed by this request (inserts: ${mergeStats.insertedCount}, amount updates: ${mergeStats.updatedCount}, prune removals: ${prunedCount}, replace-mode rows cleared: ${replaceClearedCount}; provenance backfills: ${mergeStats.backfilledCount}). Parsed item lines: ${normalizedItems.length}.\n- Sanity check: grocery row count before ${beforeGroceryCount}, after ${afterGroceryCount}.`;
      const commandOutcomeWithPrune = commandOutcomeBlock;

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
              content: `${commandOutcomeWithPrune}\n\nPrevious meal-plan summary for this thread (may be empty):\n${priorMealPlanSummary.trim() || '(none)'}\n\nHousehold memory:\n${memoryText || '(none)'}\n\nRecent conversation (this chat, before this !grocerylist turn is persisted):\n${conversationSnippet}\n\nWrite the updated replacement summary for this thread. Reflect the command outcome above accurately (e.g. if the grocery list was updated in the app, say so; do not say the user still needs to run a command to save it).`,
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
              content: `${commandOutcomeWithPrune}\n\nPrevious cumulative thread grocery summary (may be empty):\n${priorThreadGrocerySummary.trim() || '(none)'}\n\nMeal plan context for this thread (may be empty):\n${mealPlanToStore.trim() || '(none)'}\n\nItems from this !grocerylist run (section | product | amount):\n${itemsThisRunText}\n\nHousehold memory (context only):\n${memoryText || '(none)'}\n\nRecent conversation (this chat, before this !grocerylist line is persisted):\n${conversationSnippet}\n\nWrite the full replacement cumulative thread grocery summary for what this thread intends to buy so far.`,
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

      let reply;
      if (groceryListWasUpdated) {
        reply = 'I updated the grocery list. Head over to the Grocery List tab to check it.';
      } else if (normalizedItems.length > 0) {
        reply =
          'The grocery list already had those items, so there wasn\'t anything new to update.';
      } else {
        reply = 'I was not able to build a grocery list from our conversation.';
      }

      await addMessage(chatId, req.householdId, 'user', name, commandUserTextForPersistence);
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

    if (String(routePrompt ?? '').trim().startsWith('!')) {
      const reply = 'Unknown command.\n\n' + getHelpReply();
      await incrementUserMessageCountForSender(req);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(reply);
    }

    if (!routePrompt) {
      return res.status(400).json({ reply: 'Prompt is required.' });
    }

    await addMessage(chatId, req.householdId, 'user', name, routePrompt);
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

    const memoryText = memories
      .map(memory => `${memory.key}: ${memory.value}`)
      .join('\n');

    const threadCtx = await getChatThreadContext(chatId, req.householdId);

    const claudeMessages = recentConversation.map(message => ({
      role: message.role,
      content:
        message.role === 'user'
          ? `${message.name}: ${message.content}`
          : stripStoredMessageContentForDisplay(message.content),
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

    let mixedMemoryProposal = null;
    let mixedMemoryOfferLine = null;
    if (hasStrongMemoryIntentKeywords(routePrompt)) {
      const proposed = await tryAiMemoryProposal(anthropic, routePrompt, memories);
      if (proposed) {
        const mixed = isMixedIntentMemoryMessage(routePrompt);
        if (!mixed) {
          const reply = buildPendingActionReply(proposed, memoriesByKey);
          await addMessage(
            chatId,
            req.householdId,
            'assistant',
            'KitchenBot',
            appendPendingMarkerToAssistantContent(reply, proposed)
          );
          if (typeof broadcastToChat === 'function') {
            broadcastToChat(chatId, { type: 'chat_updated', householdId: req.householdId, chatId, user: name });
          }
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('X-KitchenBot-Pending-Action', encodeURIComponent(JSON.stringify(proposed)));
          return res.end(reply);
        }
        mixedMemoryProposal = proposed;
        mixedMemoryOfferLine = buildMixedMemoryOfferLine(proposed, routePrompt);
      }
    }

    const mixedIntentBlock = mixedMemoryProposal
      ? `

    Mixed-intent (this user message): They asked for a primary task plus a memory-like fact. Complete the primary task first; apply the memory fact in-context (e.g. dietary exclusions). Do NOT add any line offering to save to household memory, asking to confirm a save, or mirroring the backend offer—the server appends exactly one such line after your reply; duplicate offer text is stripped. Do not ask again to save; a pending confirmation is already attached. Never output [[KB_OFFER_MEMORY_SAVE]] or any [[KB_...]] marker (it will be stripped).`
      : '';

    const useWebSearchTool =
      householdWebSearchEnabled && shouldEnableWebSearchForPrompt(routePrompt);

    const webSearchCapabilityBlock = useWebSearchTool
      ? `Web (this request): Anthropic web_search IS attached. Only attribute content to a site or URL if the search tool actually returned that material this turn. Do not fabricate "exact" ingredients, steps, or quotes from a page you did not receive via the tool. If the tool did not return a page body, say you do not have the exact text from that source.`
      : householdWebSearchEnabled
        ? `Web (this request): Web search is NOT attached—no live fetch of links for this reply. Seeing a URL in the user's message does not mean you read it. Do not imply you extracted, checked, read, or matched that page.`
        : `Web (this request): Web search is off for this household. You cannot load URLs. A link in the chat is not page content—do not imply you read it.`;

    const streamParams = {
      model: 'claude-sonnet-4-5',
      max_tokens: useWebSearchTool ? 4096 : 800,
      system: `You are KitchenBot: a concise household assistant. Always use first person (I/me/my)—never describe "KitchenBot" as a separate system. Plain text by default; code blocks only if the user asks.

    App contract: This message is plain text only; it does not run \`!\` commands or change stored state by itself. Persisted changes happen only through explicit commands, Settings, or when I offer a save/list update and the app attaches a real pending confirmation—your next reply alone cannot complete that unless the client sends that confirmation.
    - Do not claim I saved, updated, or changed the app this turn unless the history shows a real command or confirmation outcome. Do not narrate a successful grocery or memory write unless the thread shows the actual backend confirmation for that action.
    - New facts may inform this reply only; do not describe them as already saved or remembered for future use unless the backend actually executed a save in this thread (visible command outcome in history).
    - Do not say \`I saved memory …\`, \`I updated memory …\`, or \`I've updated … preferences\` unless the thread history clearly shows the real command-backed assistant message from a save. Ephemeral facts: a new user fact not already in household memory below may be used only for this reply. Do not say I noted it, saved it, will remember it next time, updated preferences, or kept it in mind for future meals—unless quoting a confirmed command outcome from chat history. Only a real \`!remember\` or confirmed pending action is a save.
    - Do not ask "which would you prefer?" or offer Settings vs chat-style forks for actions I cannot complete from the next natural-language reply. Give one clear path (e.g. edit in Settings, or confirm when I have attached a real pending action).
    - Do not tell users to type \`!remember\` here; if they only say yes/sure/ok, they may be confirming an offer—no command tutorials.
    ${mixedIntentBlock}

    One reply per user message; finish here (no "stand by" or promised follow-ups). If web_search is attached, use it in this reply. Do not print raw search queries unless asked.

    Grocery (draft-first): first output the shopping/ingredient list in this reply. If you do not start the reply with [[KB_OFFER_GROCERY_UPDATE]] (hidden; never explain it), include one brief sentence that this list is a draft in chat only and the Grocery List tab in the app is unchanged by this reply alone—so users are not left wondering whether the real tab updated. Only after a concrete list in this message may you offer once: "If you want, I can add this to the Grocery List tab." (optionally add one short clause about plan swaps if relevant). Do not claim the tab is already updated. Do not say \`That's a command-backed action\`, \`run !grocerylist\`, or \`say yes and I'll add it\` unless you start the reply with [[KB_OFFER_GROCERY_UPDATE]] (hidden; never explain it)—that marker is what attaches a real pending action. If you do not use the marker, do not imply the user can confirm to save to the tab. Do not ask them to type \`!grocerylist\`.

    ${webSearchCapabilityBlock}
    Sources: Attribute ingredients/steps/prices to a URL or site only if those details are in this chat, memory below, or web_search results this turn; otherwise say you don't have that page. Generic help is OK if labeled approximate.

    Thread meal-plan summary (read-only; updated on \`!grocerylist\`; not the live Grocery tab):
    ${threadCtx.mealPlanSummary.trim() || '(none yet)'}

    Thread grocery intent (read-only; not the live grocery_items list):
    ${threadCtx.threadGrocerySummary.trim() || '(none yet)'}

    Household memory (read-only; edits via Settings or a confirmed save offer):
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
    if (mixedMemoryProposal) {
      res.setHeader(
        'X-KitchenBot-Pending-Action',
        encodeURIComponent(JSON.stringify(mixedMemoryProposal))
      );
    }

    let finalReply = '';
    let streamRawAccum = '';
    const pendingOfferMarker = '[[KB_OFFER_GROCERY_UPDATE]]';
    let pendingOfferDecisionMade = false;
    let pendingOfferAction = null;
    let pendingOfferBuffer = '';
    let streamEnded = false;
    let displayEmittedLen = 0;

    /**
     * Stream text that matches what we will persist: when no real grocery pending action is attached,
     * strip fake grocery-offer lines before emitting (same as post-stream finalReply cleanup).
     * Never show a grocery-offer line unless the matching pending action is actually attached.
     */
    function flushDisplayEmit() {
      const cleaned = stripKitchenBotHiddenMarkers(streamRawAccum);
      // Mixed-intent: only [[KB_PENDING]] encodes memory; grocery header/marker are suppressed — strip model grocery CTAs so "yes" is not ambiguous.
      const persistPlain =
        pendingOfferAction && !mixedMemoryProposal ? cleaned : stripFakeGroceryOperationalLines(cleaned);
      finalReply = persistPlain;

      if (mixedMemoryProposal) return;

      let emitPlain;
      if (pendingOfferAction) {
        emitPlain = cleaned;
      } else {
        emitPlain = persistPlain;
        if (!streamEnded) {
          const lastNl = emitPlain.lastIndexOf('\n');
          if (lastNl === -1) return;
          emitPlain = emitPlain.slice(0, lastNl + 1);
        }
      }

      displayEmittedLen = Math.min(displayEmittedLen, emitPlain.length);
      const newSuffix = emitPlain.slice(displayEmittedLen);
      if (!newSuffix) return;
      displayEmittedLen += newSuffix.length;
      res.write(newSuffix);
      if (typeof broadcastToChat === 'function') {
        broadcastToChat(chatId, {
          type: 'stream_delta',
          householdId: req.householdId,
          chatId,
          delta: newSuffix,
          user: name,
        });
      }
    }

    function writeChatDelta(delta) {
      if (!delta) return;
      streamRawAccum += delta;
      flushDisplayEmit();
    }

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const delta = event.delta.text;
        pendingOfferBuffer += delta;
        if (!pendingOfferDecisionMade) {
          if (
            pendingOfferBuffer.length >= pendingOfferMarker.length ||
            pendingOfferBuffer.includes('\n') ||
            pendingOfferBuffer.includes('\r')
          ) {
            if (pendingOfferBuffer.startsWith(pendingOfferMarker)) {
              pendingOfferAction = { command: '!grocerylist' };
              if (!mixedMemoryProposal) {
                res.setHeader(
                  'X-KitchenBot-Pending-Action',
                  encodeURIComponent(JSON.stringify(pendingOfferAction))
                );
              }
              pendingOfferBuffer = pendingOfferBuffer.slice(pendingOfferMarker.length);
              pendingOfferBuffer = pendingOfferBuffer.replace(/^\s*\n/, '');
            }
            pendingOfferDecisionMade = true;
            if (pendingOfferBuffer) {
              writeChatDelta(pendingOfferBuffer);
              pendingOfferBuffer = '';
            }
        }
          continue;
        }
        writeChatDelta(delta);
      }
    }
    if (!pendingOfferDecisionMade) {
      if (pendingOfferBuffer.startsWith(pendingOfferMarker)) {
        pendingOfferAction = { command: '!grocerylist' };
        if (!mixedMemoryProposal) {
          res.setHeader(
            'X-KitchenBot-Pending-Action',
            encodeURIComponent(JSON.stringify(pendingOfferAction))
          );
        }
        pendingOfferBuffer = pendingOfferBuffer.slice(pendingOfferMarker.length);
        pendingOfferBuffer = pendingOfferBuffer.replace(/^\s*\n/, '');
      }
      if (pendingOfferBuffer) {
        writeChatDelta(pendingOfferBuffer);
        pendingOfferBuffer = '';
      }
      pendingOfferDecisionMade = true;
    }

    streamEnded = true;
    flushDisplayEmit();

    // Grocery offers and mode-choice replies must continue into the real !grocerylist command path before final success is emitted.
    if (!pendingOfferAction && !mixedMemoryProposal) {
      finalReply = stripFakeGroceryOperationalLines(finalReply);
    }

    if (mixedMemoryProposal) {
      finalReply = stripModelAuthoredMemoryOfferLines(finalReply);
      if (mixedMemoryOfferLine) {
        finalReply += '\n\n' + mixedMemoryOfferLine;
      }
      res.write(finalReply);
      if (typeof broadcastToChat === 'function') {
        broadcastToChat(chatId, {
          type: 'stream_delta',
          householdId: req.householdId,
          chatId,
          delta: finalReply,
          user: name,
        });
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

    {
      const offerSep = mixedMemoryProposal && mixedMemoryOfferLine ? '\n\n' + mixedMemoryOfferLine : null;
      let beforeScrub = finalReply;
      let afterScrub = '';
      if (offerSep && finalReply.includes(offerSep)) {
        const idx = finalReply.lastIndexOf(offerSep);
        beforeScrub = finalReply.slice(0, idx);
        afterScrub = finalReply.slice(idx);
      }
      finalReply = scrubUnsavedMemoryClaimsInNormalChatReply(beforeScrub) + afterScrub;
    }

    const streamPendingForMarker = mixedMemoryProposal || pendingOfferAction || null;
    const finalReplyToPersist = streamPendingForMarker
      ? appendPendingMarkerToAssistantContent(finalReply, streamPendingForMarker)
      : finalReply;
    await addMessage(chatId, req.householdId, 'assistant', 'KitchenBot', finalReplyToPersist);
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
