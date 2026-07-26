import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function safeJsonForHtml(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// Cache-bust client assets so a deploy never leaves a browser on a stale file (which would
// pair new server-rendered HTML with old client JS, or new markup with old styles). An asset's
// mtime changes on every checkout/deploy; computed once at startup, so no per-request stat.
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');

function assetVersion(relativePath) {
  try {
    return String(Math.floor(statSync(join(PUBLIC_DIR, relativePath)).mtimeMs));
  } catch {
    return String(Date.now());
  }
}

const APP_JS_VERSION = assetVersion('app.js');

/**
 * A versioned <link> for a stylesheet in public/. Stylesheets live in real .css files rather
 * than an inline <style> block so editors can lint them, the browser can cache them separately
 * from the HTML, and a component's rules can be found by name.
 */
export function renderStylesheetLink(href) {
  const clean = String(href || '').replace(/^\//, '');
  return `<link rel="stylesheet" href="/${clean}?v=${assetVersion(clean)}" />`;
}

// Page markup lives in real .html files under views/ rather than inside a JS template literal,
// so editors highlight and lint it and an unclosed tag is visible. views/ is NOT served
// statically — these are server-side templates, read once at startup (edit one, restart the
// server, exactly as when the markup lived in kitchenbot.mjs).
const VIEWS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'views');
const templateCache = new Map();

/**
 * Render a views/<name>.html template, substituting `<!--KB:token-->` comment placeholders.
 * HTML comments are the placeholder syntax on purpose: an un-substituted one is inert in the
 * browser rather than printing stray text, and it keeps the file valid HTML for tooling.
 */
export function renderHtmlTemplate(name, replacements = {}) {
  let html = templateCache.get(name);
  if (html === undefined) {
    html = readFileSync(join(VIEWS_DIR, `${name}.html`), 'utf8');
    templateCache.set(name, html);
  }
  return html.replace(/<!--KB:([a-zA-Z0-9_]+)-->/g, (match, token) => {
    if (!(token in replacements)) {
      throw new Error(`views/${name}.html has placeholder "${token}" with no value supplied`);
    }
    return String(replacements[token] ?? '');
  });
}

/**
 * Boot-data JSON + the page's client bundle.
 *
 * `asModule` is opt-in per page, NOT a global default: type="module" also implies strict mode and
 * removes top-level names from global scope, so a page whose runtime was written as a classic
 * script must not be flipped without auditing it. app.js opts in (it has real imports);
 * recipe-importer.js deliberately does not.
 *
 * Deferral is safe for app.js: the tag sits at the end of <body> so the DOM is already parsed,
 * the vendored classic scripts still execute first, and no markup uses inline on* handlers.
 */
export function renderClientBootTags(bootData = {}, { scriptSrc = '/app.js', asModule = false } = {}) {
  const src = String(scriptSrc || '/app.js');
  const versionedSrc = src.includes('?') ? src : `${src}?v=${APP_JS_VERSION}`;
  const typeAttr = asModule ? 'type="module" ' : '';
  return [
    `<script id="kb-boot-data" type="application/json">${safeJsonForHtml(bootData)}</script>`,
    `<script ${typeAttr}src="${versionedSrc}"></script>`,
  ].join('\n      ');
}
