// Repeatable feature extraction for the Phase 5 re-plumb.
//
// Moves a named set of top-level functions (plus their state and DOM handles) out of
// public/app.js into public/modules/<feature>.js, preserving the moved code verbatim so each
// commit is a MOVE, not a rewrite. DOM handles become module-level `let`s bound in an
// init<Feature>() call, which is what keeps every internal reference unchanged.
//
// Usage: node tools/extract-feature.mjs <config.json>
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const APP = 'public/app.js';
const src = fs.readFileSync(APP, 'utf8');
const lines = src.split('\n');

// ---- locate the named functions ----
const found = new Map();
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/);
  if (!m || !cfg.functions.includes(m[1])) continue;
  let depth = 0, end = i;
  for (let j = i; j < lines.length; j++) {
    depth += (lines[j].match(/\{/g) || []).length - (lines[j].match(/\}/g) || []).length;
    if (j > i && depth <= 0) { end = j; break; }
  }
  found.set(m[1], { start: i, end });
}
const missing = cfg.functions.filter((n) => !found.has(n));
if (missing.length) {
  console.error(`  ABORT: functions not found: ${missing.join(', ')}`);
  process.exit(1);
}

// ---- DOM handles: only those whose id starts with one of the configured prefixes ----
const domConsts = [...src.matchAll(/^const ([A-Za-z_$][\w$]*) = document\.getElementById\('([^']+)'\);$/gm)]
  .filter((m) => (cfg.domPrefixes || []).some((p) => m[2].startsWith(p)))
  .map((m) => ({ name: m[1], id: m[2] }));

// ---- module body, in source order so related code stays adjacent ----
const ordered = [...found.entries()].sort((a, b) => a[1].start - b[1].start);
let body = ordered.map(([, r]) => lines.slice(r.start, r.end + 1).join('\n')).join('\n\n');

for (const [from, to] of Object.entries(cfg.replace || {})) {
  body = body.split(from).join(to);
}
for (const name of cfg.exports || []) {
  body = body.replace(new RegExp(`^(async )?function ${name}\\(`, 'm'), (m) => `export ${m}`);
}
for (const banned of cfg.mustNotContain || []) {
  if (body.includes(banned)) {
    console.error(`  ABORT: moved code still references "${banned}"`);
    process.exit(1);
  }
}

const header = `${cfg.header}
${(cfg.imports || []).join('\n')}

${(cfg.state || []).join('\n')}

${domConsts.length ? `// DOM handles, bound by ${cfg.initName}() once the document exists. Declared here rather than\n// resolved per call so the moved code below reads exactly as it did in app.js.\n${domConsts.map((d) => `let ${d.name} = null;`).join('\n')}` : ''}
`;

const init = `
/** Bind DOM handles and wire this feature's own listeners. Called once at startup. */
export function ${cfg.initName}() {
${domConsts.map((d) => `  ${d.name} = document.getElementById('${d.id}');`).join('\n')}
${(cfg.initBody || []).map((l) => `  ${l}`).join('\n')}
}
`;

fs.writeFileSync(`public/modules/${cfg.module}.js`, `${header}\n${body.trim()}\n${init}`);

// ---- remove from app.js (bottom-up) ----
for (const [, r] of [...ordered].reverse()) lines.splice(r.start, r.end - r.start + 1);
let out = lines.join('\n');
for (const d of domConsts) {
  out = out.replace(new RegExp(`^const ${d.name} = document\\.getElementById\\('${d.id}'\\);\\n`, 'm'), '');
}
for (const decl of cfg.state || []) out = out.replace(`${decl}\n`, '');
for (const [from, to] of Object.entries(cfg.appReplace || {})) out = out.split(from).join(to);
if (cfg.appImport) {
  out = out.replace(cfg.appImportAfter, `${cfg.appImportAfter}\n${cfg.appImport}`);
}
if (cfg.initCall) out = out.replace('\ninitPalette();', `\ninitPalette();\n${cfg.initCall}`);
fs.writeFileSync(APP, out);

console.log(`  ${cfg.module}.js: ${found.size} functions, ${domConsts.length} DOM handles`);
console.log(`  app.js: ${src.split('\n').length} -> ${out.split('\n').length} lines`);
