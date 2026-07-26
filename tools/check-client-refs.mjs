// Static check for the one failure mode that keeps biting during the feature extraction:
// a name that moved to another module and was never imported back.
//
// Browsers report this only at runtime, as a ReferenceError that aborts module evaluation — which
// looks like "the whole app is broken", not "one identifier is missing". This finds it in a second.
//
// It checks BOTH shapes, because both have already broken boot in this refactor:
//   - calls:            loadAnthropicSection()       <- function moved to settings.js
//   - bare identifiers: if (settingsSubtabMyBtn) {   <- DOM handle moved to settings.js
//
// Comments and strings are removed with a real tokenizer (tools/js-scan.mjs), NOT regexes — see the
// comment at the top of that file for the incident that made this non-negotiable.
//
// Usage: node tools/check-client-refs.mjs
import fs from 'node:fs';
import path from 'node:path';

import { blankNonCode } from './js-scan.mjs';

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
  'Element', 'HTMLElement', 'Node', 'File', 'DataTransfer', 'AbortSignal', 'Response', 'Request',
  'Headers', 'Notification', 'screen', 'top', 'self', 'parent', 'scrollTo', 'open', 'close',
]);
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await', 'async', 'new',
  'this', 'super', 'of', 'in', 'do', 'else', 'try', 'finally', 'throw', 'case', 'default', 'break',
  'continue', 'delete', 'void', 'instanceof', 'yield', 'let', 'const', 'var', 'class', 'extends',
  'import', 'export', 'from', 'as', 'null', 'true', 'false', 'get', 'set', 'static', 'arguments',
]);

function declaredNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/(?:^|\s)(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:^|\s)(?:export\s+)?(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/import\s*\{([^}]+)\}/g)) {
    // `import { a as b }` binds b, but a still appears in the source text, so declare both —
    // otherwise the alias's original name reads as an undefined reference.
    for (const part of m[1].split(',')) for (const n of part.split(/\s+as\s+/)) names.add(n.trim());
  }
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) names.add(m[1]);
  // Parameter lists. Deliberately NOT the generic `(...) {` shape: that also matches `if (x) {`
  // and `while (x) {`, which would declare every name tested in a condition and silently hide
  // exactly the bug this tool exists to find (it did — `if (settingsPanel && ...)` made a moved
  // DOM handle look declared). Only real parameter positions count.
  for (const m of src.matchAll(/function\s*\*?\s*[A-Za-z_$][\w$]*\s*\(([^()]*)\)/g)) {
    for (const n of m[1].match(/[A-Za-z_$][\w$]*/g) || []) names.add(n);
  }
  for (const m of src.matchAll(/function\s*\(([^()]*)\)/g)) {
    for (const n of m[1].match(/[A-Za-z_$][\w$]*/g) || []) names.add(n);
  }
  for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const n of m[1].match(/[A-Za-z_$][\w$]*/g) || []) names.add(n);
  }
  for (const m of src.matchAll(/(?:catch|for)\s*\(\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^{}]*)\}/g)) {
    for (const n of m[1].match(/[A-Za-z_$][\w$]*/g) || []) names.add(n);
  }
  for (const m of src.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]/g)) {
    for (const n of m[1].match(/[A-Za-z_$][\w$]*/g) || []) names.add(n);
  }
  return names;
}

const files = ['app.js', ...fs.readdirSync(MODULES).filter((f) => f.endsWith('.js')).map((f) => `modules/${f}`)];
let problems = 0;

for (const rel of files) {
  const raw = fs.readFileSync(path.join(CLIENT, rel), 'utf8');
  const code = blankNonCode(raw);

  // Sanity: the tokenizer must not have eaten the file — that is exactly how the regex version
  // reported "clean" on a broken app. Comments are legitimately blanked, so they come out of the
  // denominator; what is left is code + string/regex literals, which should mostly survive.
  const commentChars = countCommentChars(raw);
  const denominator = Math.max(1, raw.replace(/\s/g, '').length - commentChars);
  const codeDensity = code.replace(/\s/g, '').length / denominator;
  if (codeDensity < 0.35) {
    console.log(`  ${rel}: SCANNER PROBLEM — only ${(codeDensity * 100).toFixed(0)}% of the non-comment file survived tokenizing; refusing to report a clean bill of health`);
    problems += 1;
    continue;
  }

  const declared = declaredNames(raw);
  const missing = new Map();
  const lineOf = (idx) => code.slice(0, idx).split('\n').length;

  for (const m of code.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const name = m[0];
    const before = code.slice(Math.max(0, m.index - 40), m.index);
    // Skip property access (`a.b`), optional access (`a?.b`) and object keys (`{ b: … }`).
    if (/[.?]\s*$/.test(before)) continue;
    const after = code.slice(m.index + name.length, m.index + name.length + 3);
    if (/^\s*:/.test(after) && !/\?\s*$/.test(before)) continue; // object literal key / label
    if (declared.has(name) || BROWSER_GLOBALS.has(name) || KEYWORDS.has(name)) continue;
    if (!missing.has(name)) missing.set(name, lineOf(m.index));
  }

  if (missing.size) {
    problems += missing.size;
    const list = [...missing].sort((a, b) => a[1] - b[1]).map(([n, l]) => `${n} (line ${l})`);
    console.log(`  ${rel}:\n    ${list.join('\n    ')}`);
  }
}

/** Characters inside // and /* comments, used only to keep the sanity check honest. */
function countCommentChars(src) {
  let n = 0;
  for (const m of src.matchAll(/\/\*[\s\S]*?\*\//g)) n += m[0].replace(/\s/g, '').length;
  for (const m of src.matchAll(/(?:^|[^:'"`\\])(\/\/.*)$/gm)) n += m[1].replace(/\s/g, '').length;
  return n;
}

if (!problems) console.log('  no undefined references ✓');
process.exit(problems ? 1 : 0);
