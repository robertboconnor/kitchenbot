// Companion to check-client-refs.mjs, for the OTHER boot-killing mistake:
// `import { foo } from './x.js'` where x.js never exports foo. The browser refuses to evaluate the
// whole module graph — the app just doesn't boot — and no node test catches it, because these files
// only run in a browser.
//
// Also flags import cycles, which are legal but a common source of "undefined at module init".
//
// Usage: node tools/check-client-imports.mjs
import fs from 'node:fs';
import path from 'node:path';

const CLIENT = 'public';

function exportsOf(src) {
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) names.add(part.trim().split(/\s+as\s+/).pop().trim());
  }
  return names;
}

function importsOf(src) {
  const out = [];
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const names = m[1].split(',').map((p) => p.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    out.push({ names, from: m[2] });
  }
  return out;
}

const files = ['app.js', ...fs.readdirSync(path.join(CLIENT, 'modules')).filter((f) => f.endsWith('.js')).map((f) => `modules/${f}`)];
const src = new Map(files.map((f) => [f, fs.readFileSync(path.join(CLIENT, f), 'utf8')]));
const exp = new Map([...src].map(([f, s]) => [f, exportsOf(s)]));
const graph = new Map();
let problems = 0;

for (const [file, code] of src) {
  const dir = path.dirname(file);
  const deps = [];
  for (const { names, from } of importsOf(code)) {
    if (!from.startsWith('.')) continue;
    const target = path.normalize(path.join(dir, from)).replace(/\\/g, '/');
    deps.push(target);
    const available = exp.get(target);
    if (!available) { console.log(`  ${file}: imports from missing file ${from}`); problems++; continue; }
    const bad = names.filter((n) => !available.has(n));
    if (bad.length) { console.log(`  ${file}: ${from} does not export ${bad.join(', ')}`); problems += bad.length; }
  }
  graph.set(file, deps);
}

// Cycle report (informational — cycles are legal, but worth seeing).
const seen = new Set(); const stack = [];
const cycles = [];
(function walk(node) {
  if (stack.includes(node)) { cycles.push([...stack.slice(stack.indexOf(node)), node].join(' -> ')); return; }
  if (seen.has(node)) return;
  seen.add(node); stack.push(node);
  for (const d of graph.get(node) || []) walk(d);
  stack.pop();
})('app.js');
for (const c of [...new Set(cycles)]) console.log(`  cycle: ${c}`);

if (!problems) console.log('  every named import resolves to a real export ✓');
process.exit(problems ? 1 : 0);
