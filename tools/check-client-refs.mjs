// Static check for the one failure mode that keeps biting during the feature extraction:
// a module (or app.js) referencing a name that moved somewhere else and was never imported.
//
// Browsers report this only at runtime, as a ReferenceError that aborts module evaluation — which
// looks like "the whole app is broken", not "one identifier is missing". This finds it in a second.
//
// Usage: node tools/check-client-refs.mjs
import fs from 'node:fs';
import path from 'node:path';

const CLIENT = 'public';
const MODULES = path.join(CLIENT, 'modules');

const BROWSER_GLOBALS = new Set([
  'document', 'window', 'console', 'fetch', 'JSON', 'Object', 'Array', 'String', 'Number',
  'Boolean', 'Math', 'Date', 'Promise', 'Set', 'Map', 'WeakMap', 'RegExp', 'Error', 'parseInt',
  'parseFloat', 'isNaN', 'isFinite', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'localStorage', 'sessionStorage', 'navigator', 'location', 'history', 'alert', 'confirm',
  'prompt', 'WebSocket', 'FormData', 'FileReader', 'Image', 'Blob', 'URL', 'URLSearchParams',
  'encodeURIComponent', 'decodeURIComponent', 'requestAnimationFrame', 'cancelAnimationFrame',
  'getComputedStyle', 'matchMedia', 'AbortController', 'CustomEvent', 'Event', 'Intl', 'Symbol',
  'structuredClone', 'queueMicrotask', 'btoa', 'atob', 'TextDecoder', 'TextEncoder', 'performance',
  'ResizeObserver', 'MutationObserver', 'IntersectionObserver', 'crypto', 'marked', 'DOMPurify',
  'globalThis', 'Infinity', 'NaN', 'undefined', 'Function', 'Reflect', 'Proxy', 'BigInt',
]);
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await', 'async', 'new',
  'this', 'super', 'of', 'in', 'do', 'else', 'try', 'finally', 'throw', 'case', 'default', 'break',
  'continue', 'delete', 'void', 'instanceof', 'yield', 'let', 'const', 'var', 'class', 'extends',
  'import', 'export', 'from', 'as', 'null', 'true', 'false', 'get', 'set', 'static',
]);

function declaredNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/^(?:export )?(?:async )?function ([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/(?:^|\s)(?:export )?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/import\s+\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) names.add(part.trim().split(/\s+as\s+/).pop().trim());
  }
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) names.add(m[1]);
  // Parameters and destructuring — approximate, but only ever ADDS names, so it cannot cause a
  // false positive; at worst it hides one.
  for (const m of src.matchAll(/function[^(]*\(([^)]*)\)/g)) {
    for (const p of m[1].split(',')) { const n = p.trim().replace(/^\.\.\./, '').split(/[=:\s]/)[0]; if (n) names.add(n.replace(/[{}[\]]/g, '')); }
  }
  for (const m of src.matchAll(/\(([^)]*)\)\s*=>/g)) {
    for (const p of m[1].split(',')) { const n = p.trim().replace(/^\.\.\./, '').split(/[=:\s]/)[0]; if (n) names.add(n.replace(/[{}[\]]/g, '')); }
  }
  for (const m of src.matchAll(/(?:catch|for)\s*\(\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1]);
  for (const m of src.matchAll(/\{([^{}]*)\}\s*=/g)) {
    for (const p of m[1].split(',')) { const n = p.trim().split(/[:=\s]/).pop().trim(); if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n); }
  }
  return names;
}

// Strip comments and string/template literals so prose never counts as a reference.
function stripNonCode(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
    .replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

const files = ['app.js', ...fs.readdirSync(MODULES).filter((f) => f.endsWith('.js')).map((f) => `modules/${f}`)];
let problems = 0;

for (const rel of files) {
  const raw = fs.readFileSync(path.join(CLIENT, rel), 'utf8');
  const code = stripNonCode(raw);
  const declared = declaredNames(raw);
  const missing = new Set();
  // Only CALLS — a bare identifier is too noisy to check this crudely, and a missing function is
  // the failure mode that actually breaks boot.
  for (const m of code.matchAll(/(?<![.\w$?])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (declared.has(name) || BROWSER_GLOBALS.has(name) || KEYWORDS.has(name)) continue;
    missing.add(name);
  }
  if (missing.size) {
    problems += missing.size;
    console.log(`  ${rel}: ${[...missing].sort().join(', ')}`);
  }
}

if (!problems) console.log('  no undefined function references ✓');
process.exit(problems ? 1 : 0);
