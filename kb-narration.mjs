// kb-narration.mjs
// Whimsical, TRUTHFUL progress lines shown while the agent loop works — one per
// tool it actually calls, so the wait reads as real work being done for you (not a
// canned stall). A static map (no model call, no added latency), broadcast to BOTH
// users in a household via emitKbProgress.
//
// Keyed by the dotted capability id. The loop hands us the Anthropic tool name
// (dots replaced with "__", e.g. "grocery__write"), so map it back first.
import { toolNameToCapability } from './kb-tools.mjs';

export const WHIMSY_BY_CAPABILITY = {
  'grocery.list': 'Peeking at your grocery list…',
  'pantry.list': 'Rummaging through the pantry…',
  'cookbook.list': 'Flipping through the cookbook…',
  'grocery.write': 'Scribbling that onto the list…',
  'grocery.remove': 'Crossing that off the list…',
  'grocery.check': 'Ticking that off…',
  'grocery.uncheck': 'Putting that back on the list…',
  'grocery.update_item': 'Tweaking that on the list…',
  'grocery.clear': 'Wiping the list clean…',
  'grocery.move_to_pantry': 'Stashing that in the pantry…',
  'pantry.add': 'Stocking the pantry…',
  'pantry.remove': 'Clearing that out of the pantry…',
  'pantry.recategorize': 'Refiling that in the pantry…',
  'inventory.sections': 'Checking the category list…',
  'pantry.move_to_grocery': 'Adding that to the shopping run…',
  'memory.save': 'Committing that to memory…',
  'cookbook.save': 'Tucking that into the cookbook…',
  'cookbook.update': 'Updating the cookbook…',
  'cookbook.delete': 'Tearing that page out of the cookbook…',
  'web.search': 'Scouring the web…',
  'household.defaults.get': 'Checking your house rules…',
  'household.defaults.update': 'Updating your house rules…',
  'chat.rename': 'Renaming this chat…',
  'plan.list': "Checking this week's plan…",
  'plan.add': 'Pinning that to this week…',
  'plan.update': "Updating this week's plan…",
  'plan.remove': 'Taking that off this week…',
  'thread.search': 'Looking back through this chat…',
  'person.profile.update': 'Noting that down for them…',
  'person.profile.get': 'Checking what they eat…',
};

// Non-tool beats.
export const NARRATION_READING = 'Reading the room…';
export const NARRATION_REPLYING = 'Plating it up…';
const NARRATION_FALLBACK = 'Working on it…';

// Given the Anthropic tool name (e.g. "grocery__write"), return its whimsy line.
export function narrationForToolName(toolName) {
  const capability = toolNameToCapability(toolName);
  return (capability && WHIMSY_BY_CAPABILITY[capability]) || NARRATION_FALLBACK;
}
