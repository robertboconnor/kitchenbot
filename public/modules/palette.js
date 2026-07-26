// Per-user colour palette. A self-contained feature: it owns its own option list and its picker,
// and reacts to the session rather than being called by other features.
//
// Keys must match the CSS [data-palette] blocks in public/app.css AND the server's PALETTE_KEYS.
// The inline pre-paint script in views/app.html reads the same localStorage key to avoid a flash
// of the wrong palette on load — see app-shell.inlineScriptCspHashes(), whose derived CSP hash is
// what keeps that script running.

import { EVENTS, on } from './events.js';

export const PALETTE_OPTIONS = [
  { key: 'sweetwater', label: 'Sweetwater' },
  { key: 'cotton-candy', label: 'Cotton Candy' },
  { key: 'sous-chef', label: 'Sous Chef' },
];

export const DEFAULT_PALETTE = 'sweetwater';
const PALETTE_KEY_SET = new Set(PALETTE_OPTIONS.map((p) => p.key));

/** Exported for tests: an unknown or missing palette must fall back rather than break styling. */
export function normalizePalette(palette) {
  return PALETTE_KEY_SET.has(palette) ? palette : DEFAULT_PALETTE;
}

/** Apply a palette to the document, cache it for the pre-paint script, and sync the picker. */
export function applyPalette(palette) {
  const key = normalizePalette(palette);
  document.documentElement.setAttribute('data-palette', key);
  try {
    localStorage.setItem('kb-palette', key);
  } catch (e) {
    /* private browsing / storage disabled — the palette still applies for this page */
  }
  const select = document.getElementById('my-palette-select');
  if (select && select.value !== key) select.value = key;
  return key;
}

async function savePalette(chosen) {
  const message = document.getElementById('my-palette-msg');
  applyPalette(chosen);
  if (message) message.textContent = 'Saving…';
  try {
    const response = await fetch('/settings/me/palette', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ palette: chosen }),
    });
    if (!response.ok) throw new Error('save failed');
    const data = await response.json().catch(() => ({}));
    // Trust the server's answer over the local guess.
    if (data && data.palette) applyPalette(data.palette);
    if (message) {
      message.textContent = 'Saved ✓';
      setTimeout(() => {
        if (message.textContent === 'Saved ✓') message.textContent = '';
      }, 1500);
    }
  } catch (e) {
    if (message) message.textContent = 'Could not save';
  }
}

/**
 * Wire the feature up. Called once at startup; nothing else needs to know this module exists.
 * The palette follows the signed-in user, so it listens for the session instead of being pushed
 * a value by whatever code happens to load /me.
 */
export function initPalette() {
  on(EVENTS.SESSION_CHANGED, ({ session }) => {
    if (session?.raw?.palette) applyPalette(session.raw.palette);
  });

  const select = document.getElementById('my-palette-select');
  if (select) {
    select.addEventListener('change', () => savePalette(select.value));
  }
}
