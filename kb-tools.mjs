// kb-tools.mjs
// Bridges the existing KB_SKILLS registry to Anthropic native tool-use.
//
// Design: the agent loop (kb-agent-loop.mjs) is the brain — it decides which
// tools to call. Each KB_SKILL becomes one Anthropic tool. A tool call maps back
// to a { capability, input } action that runs through the SAME executors the old
// switch-based runtime used, so the domain logic (grocery, cookbook, pantry, ...)
// is untouched. We are changing who decides, not what the skills do.

import {
  KB_SKILLS,
  listKbSkills,
  getKbSkill,
  normalizeKbSkillAction,
} from './kb-skills.mjs';
import { GROCERY_SECTION_KEYS, PANTRY_SECTION_KEYS } from './inventory-classification.mjs';

const GROCERY_SECTIONS = [...GROCERY_SECTION_KEYS];
const PANTRY_SECTIONS = [...PANTRY_SECTION_KEYS];

// ---------------------------------------------------------------------------
// Capability <-> Anthropic tool-name mapping.
// Anthropic tool names must match ^[a-zA-Z0-9_-]{1,64}$, but capabilities use
// dots (e.g. "grocery.write"). We swap "." <-> "__" and keep an explicit map so
// there is never any ambiguity with the single underscores already in names
// like "pantry.move_to_grocery".
// ---------------------------------------------------------------------------

const CAPABILITY_TO_TOOL = new Map();
const TOOL_TO_CAPABILITY = new Map();
for (const capability of Object.keys(KB_SKILLS)) {
  const toolName = capability.replace(/\./g, '__');
  CAPABILITY_TO_TOOL.set(capability, toolName);
  TOOL_TO_CAPABILITY.set(toolName, capability);
}

export function capabilityToToolName(capability) {
  return CAPABILITY_TO_TOOL.get(String(capability ?? '').trim()) || null;
}

export function toolNameToCapability(toolName) {
  return TOOL_TO_CAPABILITY.get(String(toolName ?? '').trim()) || null;
}

// ---------------------------------------------------------------------------
// Read vs write classification (used by the loop + Pass 3 guardrails).
// "write" = mutates durable app state (DB). Reads/drafts/searches do not.
// ---------------------------------------------------------------------------

const READ_ONLY_CAPABILITIES = new Set([
  'cookbook.list',
  'grocery.list',
  'pantry.list',
  'household.defaults.get',
  'inventory.sections',
  'grocery.preview',
  'web.search',
]);

export function isWriteCapability(capability) {
  return !READ_ONLY_CAPABILITIES.has(String(capability ?? '').trim());
}

// ---------------------------------------------------------------------------
// Per-capability JSON input schemas. Derived from each skill's exampleAction in
// KB_SKILLS. The executors' normalizers are lenient, but explicit schemas keep
// the model honest and self-documenting.
// ---------------------------------------------------------------------------

const NAME_ONLY = {
  type: 'object',
  properties: { name: { type: 'string', description: 'The item name.' } },
  required: ['name'],
};
const NO_INPUT = { type: 'object', properties: {} };

const INPUT_SCHEMAS = {
  'memory.save': {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Short stable label, e.g. "rob_preferences".' },
      value: { type: 'string', description: 'The fact to remember.' },
      scope: { type: 'string', enum: ['household', 'person'], description: 'Whose memory this is. Defaults to household.' },
      person: { type: 'string', description: 'Person name when scope is "person".' },
    },
    required: ['value'],
  },
  'recipe.revise': {
    type: 'object',
    properties: { request: { type: 'string', description: 'The requested change to the active recipe in this chat.' } },
    required: ['request'],
  },
  'cookbook.save': {
    type: 'object',
    properties: { request: { type: 'string', description: 'What to save and any framing, e.g. "save this recipe to our cookbook".' } },
  },
  'cookbook.update': {
    type: 'object',
    properties: { request: { type: 'string', description: 'Which saved recipe to replace and with what revised version.' } },
  },
  'cookbook.list': NO_INPUT,
  'cookbook.delete': {
    type: 'object',
    properties: { name: { type: 'string', description: 'Name of the saved cookbook recipe to delete.' } },
    required: ['name'],
  },
  'chat.rename': {
    type: 'object',
    properties: { request: { type: 'string', description: 'Exact new title, or a request to auto-generate one from context.' } },
  },
  'grocery.write': {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description:
          'The exact grocery items to add — YOU decide them. When building a list from meals/recipes, ' +
          'enumerate every ingredient yourself (scaled to portions), exclude anything pantry.list shows is ' +
          'already on hand, and pass them here. Set each item\'s section and quantity when you know them.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            quantity: { type: 'string', description: 'Human-readable amount, e.g. "2 lbs", "1 carton".' },
            section: { type: 'string', enum: GROCERY_SECTIONS, description: 'Which grocery section it belongs in.' },
          },
          required: ['name'],
        },
      },
      mode: { type: 'string', enum: ['add', 'replace'], description: '"add" (default) appends; "replace" wipes the list then writes.' },
      source: { type: 'string', description: 'Set to "explicit_items" when you pass items (the normal case).' },
    },
  },
  'grocery.preview': NO_INPUT,
  'grocery.list': NO_INPUT,
  'pantry.list': NO_INPUT,
  'household.defaults.get': NO_INPUT,
  'grocery.remove': NAME_ONLY,
  'grocery.check': NAME_ONLY,
  'grocery.uncheck': NAME_ONLY,
  'grocery.update_item': {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name of the item already on the list to update.' },
      amount: { type: 'string', description: 'The new quantity/amount, e.g. "12" or "2 dozen". Omit to leave the amount unchanged.' },
      checked: { type: 'boolean', description: 'Set false to put a bought item back on the active list, true to mark it bought. Omit to leave unchanged.' },
      section: { type: 'string', enum: GROCERY_SECTIONS, description: 'Re-file the item under a different grocery section. Omit to leave it where it is.' },
    },
    required: ['name'],
  },
  'grocery.clear': NO_INPUT,
  'household.defaults.update': {
    type: 'object',
    properties: {
      defaultDinnerPortions: { type: 'integer', description: 'Default number of dinner portions.' },
      weeknightCookingStyle: { type: 'string', description: 'e.g. "easy", "quick", "involved".' },
    },
  },
  'pantry.add': {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'Staples/on-hand items to add to the Pantry. Set each item\'s section yourself when you know it (you know pantry items well) so it lands in the right place; leave it off only if unsure.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            section: { type: 'string', enum: PANTRY_SECTIONS, description: 'Which pantry section this belongs in.' },
            amount: { type: 'string', description: 'Optional quantity, e.g. "2 bags".' },
          },
          required: ['name'],
        },
      },
    },
    required: ['items'],
  },
  'pantry.recategorize': {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name of the pantry item to re-file.' },
      section: { type: 'string', enum: PANTRY_SECTIONS, description: 'The pantry section to move it into.' },
    },
    required: ['name', 'section'],
  },
  'inventory.sections': NO_INPUT,
  'pantry.remove': NAME_ONLY,
  'pantry.move_to_grocery': NAME_ONLY,
  'grocery.move_to_pantry': NAME_ONLY,
  'web.search': {
    type: 'object',
    properties: { query: { type: 'string', description: 'The web search query.' } },
    required: ['query'],
  },
};

function inputSchemaForCapability(capability) {
  return INPUT_SCHEMAS[capability] || NO_INPUT;
}

// ---------------------------------------------------------------------------
// Build the Anthropic `tools` array from the live skill registry.
// web.search is only exposed when the household has it enabled (mirrors the old
// filterSkillsForInterpreter behavior).
// ---------------------------------------------------------------------------

export function buildKbToolDefinitions({ webSearchEnabled = false } = {}) {
  return listKbSkills()
    .filter((skill) => (skill.id === 'web.search' ? !!webSearchEnabled : true))
    .map((skill) => ({
      name: capabilityToToolName(skill.id),
      description: skill.interpreterDescription || skill.description || skill.id,
      input_schema: inputSchemaForCapability(skill.id),
    }));
}

// ---------------------------------------------------------------------------
// Execute a single tool call by routing it through the existing skill executor.
// Returns { ok, capability, outcome, resultText } — resultText is what we hand
// back to the model as the tool_result content.
// ---------------------------------------------------------------------------

export async function executeKbToolCall(toolName, toolInput, context = {}) {
  const capability = toolNameToCapability(toolName);
  if (!capability) {
    return { ok: false, capability: toolName, outcome: null, resultText: `Unknown tool "${toolName}".` };
  }

  const skill = getKbSkill(capability);
  if (!skill) {
    return { ok: false, capability, outcome: null, resultText: `No skill registered for "${capability}".` };
  }

  const action = normalizeKbSkillAction({ capability, input: toolInput || {} }, context);
  if (!action) {
    return {
      ok: false,
      capability,
      outcome: null,
      resultText:
        `The input for "${capability}" could not be used as given. ` +
        `Re-check the required fields and call the tool again with a corrected input.`,
    };
  }

  const outcome = await skill.execute(action, {
    ...context,
    userMessageAlreadyPersisted: true,
    runtimeManagedResponse: true,
    kbModeEnabled: true,
  });

  return {
    ok: true,
    capability,
    outcome,
    resultText: summarizeOutcomeForModel(capability, outcome),
    isWrite: isWriteCapability(capability),
  };
}

// ---------------------------------------------------------------------------
// Turn a skill outcome into a compact, truthful tool_result string for the model.
// The model uses this to decide next steps and to write an honest final reply,
// so it must reflect what ACTUALLY happened (contract: no fake certainty).
// ---------------------------------------------------------------------------

const OUTCOME_PASSTHROUGH_KEYS = [
  'ok',
  'status',
  'success',
  'error',
  'message',
  'summary',
  'replyText',
  'note',
  'saved',
  'updated',
  'removed',
  'added',
  'cleared',
  'moved',
  'checked',
  'count',
  'name',
  'itemName',
  'amount',
  'previousAmount',
  'amountChanged',
  'checkedChanged',
  'section',
  'previousSection',
  'sectionChanged',
  'requestedSection',
  'validSections',
  'grocerySections',
  'pantrySections',
  'cookbookCategories',
  'missingName',
  'question',
  'title',
  'duplicate',
  'alreadyPresent',
  'nothingToDo',
  'itemsAdded',
  'addedItems',
  'alreadyOnList',
  'matchedItems',
  'itemsRemoved',
  'items',
  'checkedCount',
  'defaults',
  'results',
  'sources',
  'query',
];

export function summarizeOutcomeForModel(capability, outcome) {
  if (outcome == null) {
    return `Tool "${capability}" ran but returned no result object.`;
  }
  if (typeof outcome !== 'object') {
    return `Tool "${capability}" result: ${String(outcome)}`;
  }

  const picked = {};
  for (const key of OUTCOME_PASSTHROUGH_KEYS) {
    if (outcome[key] === undefined) continue;
    let value = outcome[key];
    // Cap large arrays so a huge grocery/search payload does not blow the context.
    if (Array.isArray(value) && value.length > 100) {
      value = [...value.slice(0, 100), `...(${value.length} total)`];
    }
    picked[key] = value;
  }

  const body = Object.keys(picked).length ? picked : { note: 'completed; no standard summary fields present' };
  let json;
  try {
    json = JSON.stringify(body);
  } catch {
    json = '{"note":"outcome not serializable"}';
  }
  // Cap total size defensively.
  if (json.length > 12000) json = json.slice(0, 12000) + '…(truncated)';
  return `Tool "${capability}" result: ${json}`;
}
