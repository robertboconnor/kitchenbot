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

// Cache-bust the client bundle so a deploy never leaves a browser on a stale app.js
// (which would show new server-rendered HTML but old client JS). app.js's mtime changes
// on every checkout/deploy; computed once at startup, so no per-request stat.
const APP_JS_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return String(Math.floor(statSync(join(here, 'public', 'app.js')).mtimeMs));
  } catch {
    return String(Date.now());
  }
})();

export function renderClientBootTags(bootData = {}, { scriptSrc = '/app.js' } = {}) {
  const src = String(scriptSrc || '/app.js');
  const versionedSrc = src.includes('?') ? src : `${src}?v=${APP_JS_VERSION}`;
  return [
    `<script id="kb-boot-data" type="application/json">${safeJsonForHtml(bootData)}</script>`,
    `<script src="${versionedSrc}"></script>`,
  ].join('\n      ');
}
