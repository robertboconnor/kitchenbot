// kb-claim-guard.mjs
// Truthfulness safety net for the agent loop. The brain's system prompt forbids claiming
// a completed action it didn't actually take via a tool — but nothing ENFORCED it, so the
// model could end a turn with "Saved it!" while never calling cookbook.save. This module
// deterministically cross-checks the model's final reply against the turn's real tool trace:
// if the reply asserts a completed WRITE for a capability family that had no successful tool
// call this turn, the loop resets the streamed text and forces the model to either actually
// do it or retract the claim. This is a post-hoc integrity check on the brain's own output —
// it does NOT select actions or infer user intent (that stays the brain's job).

// A write "counts as done" if the tool ran with ok:true and a status that isn't one of these
// (these mean nothing was persisted). 'unchanged' / 'already_present' / 'duplicate' DO count —
// the thing is on the list / in the cookbook, so "it's saved" is truthful.
const NON_COMMITTAL_STATUSES = new Set([
  'invalid',
  'no_items',
  'error',
  'skipped',
  'ambiguous',
  'missing',
  'empty_plan',
  'invalid_section',
  'unavailable',
  'needs_clarification',
]);

// capability -> family, for the two cross-list moves whose prefix would otherwise mislead.
const EXACT_CAP_FAMILY = {
  'grocery.move_to_pantry': 'pantry',
  'pantry.move_to_grocery': 'grocery',
};

const WRITE_FAMILIES = [
  {
    family: 'cookbook',
    prefixes: ['cookbook.'],
    patterns: [
      /\b(saved|added|tucked|stored|popped|put)\b[^.!?\n]{0,50}\bcookbook\b/i,
      /\b(it'?s|that'?s|they'?re|you'?ll find (?:it|them|that))\b[^.!?\n]{0,40}\b(?:in|to) your cookbook\b/i,
      /\badded\b[^.!?\n]{0,40}\bto your (?:saved )?recipes\b/i,
      /\bsaved\b[^.!?\n]{0,40}\b(?:recipe|as a[^.!?\n]{0,30}recipe)\b/i,
    ],
  },
  {
    family: 'grocery',
    prefixes: ['grocery.'],
    patterns: [
      /\b(added|put|updated|removed|cleared|took|crossed|checked|marked)\b[^.!?\n]{0,50}\b(?:grocery|shopping) list\b/i,
      /\b(added|put)\b[^.!?\n]{0,30}\bto (?:your|the) list\b/i,
      /\b(updated|cleared) (?:your|the) (?:grocery|shopping )?list\b/i,
      /\bit'?s on (?:your|the) (?:grocery|shopping) list\b/i,
    ],
  },
  {
    family: 'pantry',
    prefixes: ['pantry.'],
    patterns: [
      /\b(added|stocked|put|removed|refiled|re-filed|moved)\b[^.!?\n]{0,50}\bpantry\b/i,
      /\b(it'?s|that'?s|they'?re) (?:now )?in (?:your|the) pantry\b/i,
    ],
  },
  {
    family: 'plan',
    prefixes: ['plan.'],
    patterns: [
      /\b(added|put)\b[^.!?\n]{0,40}\bthis week(?:'?s)?(?: plan| menu)?\b/i,
      /\bon (?:your|the|this)(?: week'?s| weekly)? plan\b/i,
      /\bmarked\b[^.!?\n]{0,40}\bcooked\b/i,
      /\badded\b[^.!?\n]{0,40}\bto (?:the |your |this week'?s )?plan\b/i,
    ],
  },
  {
    family: 'memory',
    prefixes: ['memory.'],
    patterns: [
      /\b(saved|noted|stored|recorded)\b[^.!?\n]{0,40}\b(?:to memory|that down|for (?:later|next time)|in (?:my )?memory)\b/i,
      /\bi'?ll (?:remember|keep that in mind|note that)\b/i,
      /\bgot it[,—-]?\s*(?:i'?ve )?(?:saved|noted|recorded)\b/i,
    ],
  },
  {
    family: 'profile',
    prefixes: ['person.'],
    patterns: [
      /\b(updated|added to|saved|recorded|noted)\b[^.!?\n]{0,40}\b(profile|accepted foods?|rejected foods?|allerg(?:y|ies))\b/i,
      /\b(?:it'?s|that'?s|they'?re) (?:now )?(?:in|on|off) (?:her|his|their|the)[^.!?\n]{0,30}\b(profile|accepted|rejected)\b/i,
      /\b(added|moved)\b[^.!?\n]{0,40}\b(?:to |into |onto )?(?:her|his|their|the)?[^.!?\n]{0,15}\b(accepted|rejected)\b[^.!?\n]{0,15}\b(?:foods?|list)\b/i,
    ],
  },
];

// Object-less completion claims ("Saved it!") that name no surface. These only fire when the
// turn had NO successful write at all — the exact shape of the reported bug.
const BARE_COMPLETION_PATTERNS = [
  /\bsaved it\b/i,
  /\bsaved that\b/i,
  /\bsaved this\b/i,
  /^\s*saved[!.]?\s*$/im,
  /\b(?:all set|done)[!.]?\s+(?:it'?s|that'?s|they'?re)\s+(?:saved|added|updated|on|in)\b/i,
];

function familyForCapability(cap) {
  const c = String(cap ?? '').trim().toLowerCase();
  if (!c) return null;
  if (EXACT_CAP_FAMILY[c]) return EXACT_CAP_FAMILY[c];
  for (const fam of WRITE_FAMILIES) {
    if (fam.prefixes.some((p) => c.startsWith(p))) return fam.family;
  }
  return null;
}

function backedFamiliesFromOutcomes(collectedOutcomes) {
  const backed = new Set();
  let anyBackedWrite = false;
  for (const entry of Array.isArray(collectedOutcomes) ? collectedOutcomes : []) {
    if (!entry || entry.isWrite !== true || entry.ok !== true) continue;
    const status = String(entry.outcome?.status ?? '').trim().toLowerCase();
    if (status && NON_COMMITTAL_STATUSES.has(status)) continue;
    anyBackedWrite = true;
    const fam = familyForCapability(entry.capability ?? entry.outcome?.capability);
    if (fam) backed.add(fam);
  }
  return { backed, anyBackedWrite };
}

function firstMatch(reply, patterns) {
  for (const re of patterns) {
    const m = reply.match(re);
    if (m) return m[0].trim().replace(/\s+/g, ' ').slice(0, 80);
  }
  return null;
}

// --- Description-context suppression --------------------------------------------------------
// The guard hunts for completion vocabulary ("added to your list", "saved it"). But DESCRIBING a
// capability reuses the exact same verbs — "grocery.write adds items to your list" reads like
// "added it to your list". So when the user asks "what can you do" / "list your tools", an honest
// answer trips the guard, gets wiped, and the loop emits a bogus "I didn't actually complete it"
// message. (Real prod bug, 2026-07-23.) These detectors recognize the description case and skip
// the check for that turn — the core claim-matching stays fully active for real action requests.
const TOOL_IDENTIFIER_RE = /\b(?:cookbook|grocery|pantry|plan|memory|web|thread|person)\.[a-z_]+(?:\.[a-z_]+)?\b/gi;

// True when the reply names two or more DISTINCT tool identifiers — i.e. it is enumerating tools,
// not reporting one action. One incidental mention does not disarm the guard; a rundown does.
function looksLikeToolRundown(reply) {
  const found = new Set();
  for (const m of String(reply ?? '').matchAll(TOOL_IDENTIFIER_RE)) {
    found.add(m[0].toLowerCase());
    if (found.size >= 2) return true;
  }
  return false;
}

// True when the user's turn is asking what KB can do / to list its tools — a description request,
// not an action request, so nothing in the reply should be read as a completed-write claim.
function isCapabilityQuestion(prompt) {
  const p = String(prompt ?? '').toLowerCase();
  if (!p.trim()) return false;
  return (
    /\bwhat (?:can|do|could|all can|else can) you (?:do|help|offer|handle)\b/.test(p) ||
    /\b(?:what|which)\b[^.?!]{0,20}\b(?:your|you)\b[^.?!]{0,24}\b(?:tools?|features?|capabilit(?:y|ies)|commands?|functions?)\b/.test(p) ||
    /\b(?:list|show|tell me|explain|enumerate|name)\b[^.?!]{0,30}\b(?:tools?|features?|capabilit(?:y|ies)|commands?|functions?|everything you can)\b/.test(p) ||
    /\bhow (?:do|does) (?:you|kb|kitchenbot|this app) work\b/.test(p) ||
    /\bwhat (?:does|do)\b[^.?!]{0,30}\.[a-z_]+[^.?!]{0,20}\bdo\b/.test(p)
  );
}

// Returns [] when the reply is honest. Otherwise returns [{ family, phrase }] for each
// completed-write claim that has no matching successful tool call this turn.
export function findUnbackedWriteClaims(replyText, collectedOutcomes = [], context = {}) {
  const reply = String(replyText ?? '');
  if (!reply.trim()) return [];
  // Description-context suppression: if the reply is a tool rundown, or the user asked what KB can
  // do, the completion vocabulary is descriptive — do not read it as a false claim.
  if (looksLikeToolRundown(reply) || isCapabilityQuestion(context.userPrompt)) return [];
  const { backed, anyBackedWrite } = backedFamiliesFromOutcomes(collectedOutcomes);

  const unbacked = [];
  for (const fam of WRITE_FAMILIES) {
    if (backed.has(fam.family)) continue;
    const phrase = firstMatch(reply, fam.patterns);
    if (phrase) unbacked.push({ family: fam.family, phrase });
  }

  // Bare "Saved it!"-style claims: only suspicious when literally nothing was written.
  if (unbacked.length === 0 && !anyBackedWrite) {
    const phrase = firstMatch(reply, BARE_COMPLETION_PATTERNS);
    if (phrase) unbacked.push({ family: 'unknown', phrase });
  }
  return unbacked;
}

const FAMILY_TOOL_HINT = {
  cookbook: 'cookbook.save (or cookbook.update for one already saved)',
  grocery: 'grocery.write / grocery.update_item',
  pantry: 'pantry.add',
  plan: 'plan.add / plan.update',
  memory: 'memory.save',
  profile: 'person.profile.update',
};

// The corrective message fed back to the model when it claimed a write it didn't make.
export function buildClaimCorrectionMessage(unbacked = []) {
  const families = [...new Set(unbacked.map((u) => u.family))].filter((f) => f && f !== 'unknown');
  const toolHint = families.length ? families.map((f) => FAMILY_TOOL_HINT[f] || f).join(', ') : 'the matching write tool';
  const example = unbacked[0]?.phrase || 'saved it';
  return (
    `STOP — your draft reply told the user you completed an action ("${example}"), but you did NOT successfully call ` +
    `the tool for it this turn. Your rules forbid claiming you changed something unless a tool actually did it. ` +
    `Do ONE of these now: (1) call ${toolHint} to actually do it, then confirm truthfully; or (2) if you can't or ` +
    `shouldn't, rewrite your reply to say plainly that it is NOT done and how to proceed. Do not repeat the false claim.`
  );
}
