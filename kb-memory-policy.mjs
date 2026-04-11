function normalizeKey(raw) {
  let s = String(raw ?? '').trim().toLowerCase();
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/ /g, '_');
  return s;
}

function stripOuterFormatting(text) {
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

export function normalizeMemoryKey(raw) {
  return normalizeKey(stripOuterFormatting(String(raw ?? '')));
}

export function normalizeMemoryValue(raw) {
  return stripOuterFormatting(String(raw ?? ''));
}

function mergeValues(existingRaw, incomingRaw) {
  const existing = String(existingRaw ?? '').trim();
  const incoming = String(incomingRaw ?? '').trim();
  if (!incoming) return existing;
  if (!existing) return incoming;
  if (existing.toLowerCase() === incoming.toLowerCase()) return existing;
  return `${existing}; ${incoming}`;
}

export function mergeMemoryProposal(existingRaw, proposedRaw) {
  const existing = String(existingRaw ?? '').trim();
  const proposed = String(proposedRaw ?? '').trim();
  if (!proposed) return null;
  if (!existing) return proposed;
  if (proposed.toLowerCase() === existing.toLowerCase()) return null;
  if (proposed.toLowerCase().includes(existing.toLowerCase())) return proposed;
  if (existing.toLowerCase().includes(proposed.toLowerCase()) && proposed.length >= 4) return null;
  return mergeValues(existing, proposed);
}

function buildPreferenceKey(prefKey, fragment) {
  const k = normalizeKey(prefKey);
  const frag = String(fragment ?? '').trim();
  if (!k || !frag) return null;
  return { key: k, value: frag };
}

function buildHouseholdNoteValue(fragment) {
  return normalizeMemoryValue(String(fragment ?? '').trim().replace(/^[:,]\s*/, ''));
}

function buildHouseholdNote(fragment) {
  const value = buildHouseholdNoteValue(fragment);
  if (!value) return null;
  return { key: normalizeKey('household_note'), value };
}

function looksLikePrimaryNonMemoryTaskClause(beforeText) {
  const t = String(beforeText ?? '').trim().toLowerCase();
  if (t.length < 10) return false;
  return (
    /\b(generate|create|make|build|draft|write|plan|help\s+me|suggest|give\s+me|what\s+should\s+i|can\s+you\s+|how\s+do\s+i|explain|compare)\b/.test(t) ||
    /\b(recipe|recipes|menu|grocery|shopping\s*list|dinners?|breakfast|lunch)\b/.test(t)
  );
}

export function inferMemoryKeyAndValue(payload, memoriesByKey = new Map(), opts = {}) {
  let p = String(payload ?? '').trim();
  if (!p) return null;
  p = p.slice(0, 500);
  const activeSpeakerName = String(opts.activeSpeakerName ?? '').trim();
  const activeSpeakerKey = activeSpeakerName
    ? normalizeKey(activeSpeakerName.replace(/[^a-z0-9 ]+/gi, ' ').trim())
    : '';

  let m = p.match(/\b(?:your\s+)?(?:writing\s+)?tone\s+should\s+be\s+(.+)$/i);
  if (m) return { key: normalizeKey('tone'), value: m[1].trim() };
  m = p.match(/\b(?:your\s+)?(?:writing\s+)?tone\s+is\s+(.+)$/i);
  if (m) return { key: normalizeKey('tone'), value: m[1].trim() };
  m = p.match(/\b(?:writing\s+)?style\s+should\s+be\s+(.+)$/i);
  if (m) return { key: normalizeKey('tone'), value: m[1].trim() };

  m = p.match(/^([A-Za-z][a-z]{1,24})\s+does\s+not\s+like\s+(.+)$/i);
  if (!m) m = p.match(/^([A-Za-z][a-z]{1,24})\s+doesn't\s+like\s+(.+)$/i);
  if (m) return buildPreferenceKey(`${m[1].toLowerCase()}_preferences`, `doesn't like ${m[2].trim()}`);

  m = p.match(/^that\s+([a-z][a-z0-9]{1,23})\s+loves\s+(.+)$/i);
  if (!m) m = p.match(/^([a-z][a-z0-9]{1,23})\s+loves\s+(.+)$/i);
  if (m) return buildPreferenceKey(`${m[1].toLowerCase()}_preferences`, `loves ${m[2].trim()}`);

  m = p.match(/^that\s+([a-z][a-z0-9]{1,23})\s+hates\s+(.+)$/i);
  if (!m) m = p.match(/^([a-z][a-z0-9]{1,23})\s+hates\s+(.+)$/i);
  if (m) return buildPreferenceKey(`${m[1].toLowerCase()}_preferences`, `hates ${m[2].trim()}`);

  if (activeSpeakerKey) {
    m = p.match(/^i\s+do\s+not\s+like\s+(.+)$/i);
    if (!m) m = p.match(/^i\s+don't\s+like\s+(.+)$/i);
    if (m) return buildPreferenceKey(`${activeSpeakerKey}_preferences`, `doesn't like ${m[1].trim()}`);

    m = p.match(/^i\s+hate\s+(.+)$/i);
    if (m) return buildPreferenceKey(`${activeSpeakerKey}_preferences`, `hates ${m[1].trim()}`);

    m = p.match(/^i\s+love\s+(.+)$/i);
    if (m) return buildPreferenceKey(`${activeSpeakerKey}_preferences`, `loves ${m[1].trim()}`);

    m = p.match(/^i\s+like\s+(.+)$/i);
    if (m) return buildPreferenceKey(`${activeSpeakerKey}_preferences`, `likes ${m[1].trim()}`);
  }

  m = p.match(/^that\s+our\s+household\s+(.+)$/i);
  if (!m) m = p.match(/^our\s+household\s+(.+)$/i);
  if (!m) m = p.match(/^that\s+our\s+kitchen\s+(.+)$/i);
  if (!m) m = p.match(/^our\s+kitchen\s+(.+)$/i);
  if (!m) m = p.match(/^that\s+we\s+(.+)$/i);
  if (!m) m = p.match(/^we\s+(.+)$/i);
  if (m) {
    const householdNote = buildHouseholdNote(`We ${m[1].trim()}`);
    if (householdNote) return householdNote;
  }

  return buildHouseholdNote(p);
}

export function detectMemorySaveIntent(rawPrompt, memoriesByKey = new Map(), opts = {}) {
  const s = String(rawPrompt ?? '').trim();
  if (!s) return null;

  const anchoredPatterns = [
    /^(?:please\s+)?remember\s+that\s+(.*)$/is,
    /^(?:please\s+)?remember\s+(.*)$/is,
    /^(?:please\s+)?save\s+(?:this|it|that)\s+to\s+(?:household\s+)?memory\b[.:\s]*(?:[-—]\s*)?(.*)$/is,
    /^(?:please\s+)?write\s+(?:this|it|that)\s+to\s+(?:household\s+)?memory\b[.:\s]*(?:[-—]\s*)?(.*)$/is,
    /^(?:please\s+)?don['']?t\s+forget\s+that\s+(.*)$/is,
  ];
  for (const re of anchoredPatterns) {
    const m = s.match(re);
    if (!m) continue;
    const payload = (m[1] ?? '').trim();
    if (!payload) continue;
    if (looksLikePrimaryNonMemoryTaskClause(payload)) return null;
    const inferred = inferMemoryKeyAndValue(payload, memoriesByKey, opts);
    return inferred?.key && inferred?.value ? inferred : null;
  }

  return null;
}
