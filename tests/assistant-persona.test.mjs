import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAssistantPersonaSystemText,
  getAssistantPersonaSettings,
  normalizeAssistantName,
  normalizeAssistantTone,
} from '../kb-persona.mjs';

test('assistant persona settings normalize to safe defaults', () => {
  assert.equal(normalizeAssistantName(''), 'KitchenBot');
  assert.equal(normalizeAssistantTone('???'), 'helpful'); // garbage (no letters) → default
  assert.equal(normalizeAssistantTone(''), 'helpful');
  assert.equal(normalizeAssistantTone('terse'), 'terse'); // free-text tone is preserved (KB can set any)
  assert.equal(normalizeAssistantTone('sexy'), 'thirsty');
  assert.equal(normalizeAssistantTone('friendly'), 'helpful');
  assert.equal(normalizeAssistantTone('sassy'), 'witty');
  assert.deepEqual(getAssistantPersonaSettings({ assistantName: 'Sous-Chef', assistantTone: 'witty' }), {
    assistantName: 'Sous-Chef',
    assistantTone: 'witty',
  });
});

test('assistant persona system text keeps tone bounded', () => {
  const system = buildAssistantPersonaSystemText(
    { assistantName: 'Sous-Chef', assistantTone: 'thirsty' },
    { role: 'assistant' }
  );
  assert.match(system, /Sous-Chef/);
  assert.match(system, /hilariously thirsty, boldly lewd, and sexually charged/);
  assert.match(system, /most attractive person you have ever met/);
  assert.match(system, /Tone affects style only/);
});

test('witty tone instruction is dry and deadpan instead of generic banter', () => {
  const system = buildAssistantPersonaSystemText(
    { assistantName: 'Sous-Chef', assistantTone: 'witty' },
    { role: 'assistant' }
  );
  assert.match(system, /dry, understated humor/i);
  assert.match(system, /deadpan phrasing/i);
  assert.match(system, /do not become snide, zany, or evasive/i);
});
