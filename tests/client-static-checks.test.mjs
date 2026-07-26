// Tests for the static checks that guard the client-side module split.
//
// These tools ARE the safety net for the frontend re-plumb, so they need their own net. The first
// version of check-client-refs.mjs stripped strings with regexes; a template literal containing
// `${ {nested: braces} }` broke the backtick pairing, it silently swallowed 80% of public/app.js,
// and reported "clean" while the app had a boot-breaking undefined reference. A checker that
// under-reports is worse than no checker, so the tokenizer gets pinned here.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { blankNonCode } from '../tools/js-scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

test('js-scan: blanks comments, strings and regexes but keeps the code around them', () => {
  const src = [
    'const a = "hello"; // trailing',
    "const b = 'wor/ld';",
    '/* block\n   comment */',
    'const re = /a[/]b/g;',
    'callMe(a, b);',
  ].join('\n');
  const out = blankNonCode(src);

  assert.ok(!out.includes('hello'), 'double-quoted string contents must be gone');
  assert.ok(!out.includes('wor/ld'), 'single-quoted string contents must be gone');
  assert.ok(!out.includes('trailing'), 'line comment must be gone');
  assert.ok(!out.includes('block'), 'block comment must be gone');
  assert.ok(out.includes('callMe'), 'real code after a regex literal must survive');
  assert.equal(out.length, src.length, 'offsets must be preserved');
  assert.equal(out.split('\n').length, src.split('\n').length, 'line numbers must be preserved');
});

test('js-scan: a template literal with nested braces does not swallow the rest of the file', () => {
  // THE regression. The old regex was /`(?:\$\{[^}]*\}|[^`])*`/ — `[^}]*` stops at the FIRST
  // closing brace, so the literal below mis-paired and everything up to the next backtick
  // (potentially hundreds of lines later) was blanked as if it were a string.
  const src = [
    'const t = `x ${ { a: 1 } } y`;',
    'brokenReference();',
    'const t2 = `${ items.map((i) => `${i.name}`).join("") }`;',
    'anotherReference();',
  ].join('\n');
  const out = blankNonCode(src);

  assert.ok(out.includes('brokenReference'), 'code after a nested-brace template must survive');
  assert.ok(out.includes('anotherReference'), 'code after a nested template must survive');
  assert.ok(!out.includes('x '), 'the literal text chunks must still be blanked');
  // The ${...} expression IS code and can reference real names, so it must be kept.
  assert.ok(out.includes('items') && out.includes('join'), 'template expressions are real code');
});

test('js-scan: survives division vs regex ambiguity without eating code', () => {
  const src = 'const half = total / 2; const r = /x/; keepMe();';
  const out = blankNonCode(src);
  assert.ok(out.includes('total'), 'division must not be treated as a regex start');
  assert.ok(out.includes('keepMe'), 'code after a real regex must survive');
});

test('js-scan: the real client files tokenize without collapsing', async () => {
  // The guard that would have caught the incident: if the tokenizer eats a file, say so loudly.
  const clientDir = path.join(ROOT, 'public');
  const moduleDir = path.join(clientDir, 'modules');
  const files = [
    path.join(clientDir, 'app.js'),
    path.join(clientDir, 'recipe-importer.js'),
    ...(await fs.readdir(moduleDir)).filter((f) => f.endsWith('.js')).map((f) => path.join(moduleDir, f)),
  ];

  for (const file of files) {
    const raw = await fs.readFile(file, 'utf8');
    const out = blankNonCode(raw);
    assert.equal(out.length, raw.length, `${path.basename(file)}: length must be preserved`);
    // Braces are a decent proxy for "the structure survived". Comments legitimately contain braces
    // (JSDoc like `detail: { chatId }`), so they come out of the baseline first — with a blunt
    // regex, which is fine here because it only affects the number we compare against.
    const withoutComments = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
    const rawBraces = (withoutComments.match(/[{}]/g) || []).length;
    const outBraces = (out.match(/[{}]/g) || []).length;
    if (rawBraces >= 10) {
      assert.ok(
        // Braces inside string literals are legitimately blanked, so this is a collapse detector,
        // not an exact match: the incident collapsed app.js to ~20%.
        outBraces >= rawBraces * 0.75,
        `${path.basename(file)}: only ${outBraces}/${rawBraces} code braces survived tokenizing — the scanner is eating code`
      );
    }
  }
});

test('the client reference checks pass (no undefined names, no unresolved imports)', async () => {
  // Runs the two tools for real. A failure here means the app would throw a ReferenceError at boot
  // in a browser — invisible to every other node test, because these files never run under node.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  for (const tool of ['tools/check-client-refs.mjs', 'tools/check-client-imports.mjs']) {
    try {
      await run(process.execPath, [tool], { cwd: ROOT });
    } catch (err) {
      assert.fail(`${tool} reported problems:\n${err.stdout || ''}${err.stderr || ''}`);
    }
  }
});
