import { statSync } from 'node:fs';
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

export function renderClientBootTags(bootData = {}, { scriptSrc = '/app.js' } = {}) {
  const src = String(scriptSrc || '/app.js');
  const versionedSrc = src.includes('?') ? src : `${src}?v=${APP_JS_VERSION}`;
  return [
    `<script id="kb-boot-data" type="application/json">${safeJsonForHtml(bootData)}</script>`,
    `<script src="${versionedSrc}"></script>`,
  ].join('\n      ');
}
