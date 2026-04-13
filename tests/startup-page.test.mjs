import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { renderClientBootTags } from '../app-shell.mjs';

const execFileAsync = promisify(execFile);

test('renderClientBootTags emits an external browser runtime and HTML-safe boot JSON', async () => {
  const html = renderClientBootTags({
    cookbookCategoryOptions: [
      { value: 'pasta', label: 'Pasta </script><script>alert(1)</script>' },
    ],
  });

  assert.match(html, /<script id="kb-boot-data" type="application\/json">/);
  assert.match(html, /<script src="\/app\.js"><\/script>/);
  assert.doesNotMatch(html, /Pasta <\/script><script>alert\(1\)<\/script>/);
  assert.match(html, /\\u003c\/script\\u003e\\u003cscript\\u003ealert\(1\)\\u003c\/script\\u003e/);
});

test('public app runtime parses as a standalone browser file', async () => {
  await execFileAsync(process.execPath, [
    '--check',
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public/app.js'),
  ]);
});

test('public app runtime includes cookbook display helpers used by cookbook rendering', async () => {
  const source = await fs.readFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public/app.js'), 'utf8');
  assert.match(source, /function getCookbookDisplayTitle\(/);
  assert.match(source, /function getCookbookDisplaySource\(/);
  assert.match(source, /function getCookbookDisplayProvenance\(/);
});

test('root page template uses the extracted external client runtime hook', async () => {
  const source = await fs.readFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../kitchenbot.mjs'), 'utf8');
  assert.match(source, /renderClientBootTags\(\{ cookbookCategoryOptions: COOKBOOK_CATEGORY_OPTIONS \}\)/);
  assert.match(source, /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/marked\/marked\.min\.js"><\/script>/);
});

test('settings UI includes household id and key slots for quick household-context debugging', async () => {
  const source = await fs.readFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../kitchenbot.mjs'), 'utf8');
  const appSource = await fs.readFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public/app.js'), 'utf8');
  assert.match(source, /id="my-settings-hh-id"/);
  assert.match(source, /id="my-settings-hh-key"/);
  assert.match(appSource, /document\.getElementById\('my-settings-hh-id'\)/);
  assert.match(appSource, /idEl\.textContent = String\(data\.household\.id \?\? ''\)/);
});
