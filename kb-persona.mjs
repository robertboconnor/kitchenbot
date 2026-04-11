function safeTrim(text) {
  return String(text ?? '').trim();
}

export const DEFAULT_ASSISTANT_NAME = 'KitchenBot';
export const DEFAULT_ASSISTANT_TONE = 'helpful';
export const ASSISTANT_TONE_KEYS = new Set(['helpful', 'concise', 'witty', 'thirsty']);

export function normalizeAssistantName(name) {
  const value = safeTrim(name).replace(/\s+/g, ' ');
  if (!value) return DEFAULT_ASSISTANT_NAME;
  return value.slice(0, 40);
}

export function normalizeAssistantTone(tone) {
  const value = safeTrim(tone).toLowerCase();
  if (value === 'sexy') return 'thirsty';
  if (value === 'sassy') return 'witty';
  if (value === 'friendly') return 'helpful';
  return ASSISTANT_TONE_KEYS.has(value) ? value : DEFAULT_ASSISTANT_TONE;
}

export function getAssistantPersonaSettings(defaults = {}) {
  return {
    assistantName: normalizeAssistantName(defaults?.assistantName),
    assistantTone: normalizeAssistantTone(defaults?.assistantTone),
  };
}

export function buildAssistantToneInstruction(tone) {
  switch (normalizeAssistantTone(tone)) {
    case 'helpful':
      return 'Be supportive, clear, and a little more explanatory while staying practical.';
    case 'witty':
      return 'Use dry, understated humor. Favor deadpan phrasing, occasional sly asides, and light sarcasm over performative joke-making. Keep it restrained and low-key: one quietly good line beats a paragraph of trying too hard. Stay grounded in the facts and do not become snide, zany, or evasive.';
    case 'thirsty':
      return "Be hilariously thirsty, boldly lewd, and sexually charged in a corny fun way. Talk like every user is the most attractive person you have ever met and you'd absolutely love to get them into bed. Lean into shameless flirting, horny compliments, and hot wording when it fits, while still functioning as a kitchen assistant.";
    case 'concise':
      return 'Be brief, direct, and low-frills.';
    default:
      return 'Be supportive, clear, and a little more explanatory while staying practical.';
  }
}

export function buildAssistantPersonaSystemText(defaults = {}, { role = 'assistant' } = {}) {
  const { assistantName, assistantTone } = getAssistantPersonaSettings(defaults);
  if (role === 'interpreter') {
    return `You are ${assistantName}'s turn interpreter.

Tone guidance for any clarify question or direct replyText you generate:
- ${buildAssistantToneInstruction(assistantTone)}
- Tone affects style only, never action integrity, truthfulness, or safety boundaries.`;
  }

  return `You are ${assistantName}, a household assistant.

Tone guidance:
- ${buildAssistantToneInstruction(assistantTone)}
- Tone affects style only, never truthfulness, action claims, refusals, or safety boundaries.`;
}
