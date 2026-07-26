// FRONTEND SAFETY NET
//
// Until 2026-07-25 the app had 182 backend tests and ZERO covering the frontend, while the whole
// UI lived in two files never meant to hold it: a ~6,400-line HTML+CSS template string inside
// kitchenbot.mjs, and a 4,993-line single-global-scope public/app.js wired together by ~254
// getElementById() lookups. That combination has no compiler and no test — renaming an id, losing
// a CSS rule, or dropping an element is silent until a human happens to click the right thing.
//
// These tests exist so the Phase-5 re-plumb (lifting CSS/HTML/JS into real files) is verifiable.
// They assert the HTTP-level contract of what the server serves, NOT any internal render
// function, so they keep working no matter how the page is assembled internally.
//
// Snapshots: run `UPDATE_FRONTEND_SNAPSHOTS=1 node --test tests/frontend-shell.test.mjs` to
// regenerate after an INTENTIONAL change, and eyeball the diff before committing it.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

import { withKitchenbotServer } from '../test-support/server-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = path.join(HERE, '__snapshots__');
const UPDATING = process.env.UPDATE_FRONTEND_SNAPSHOTS === '1';

async function compareSnapshot(name, actual, hint) {
  const file = path.join(SNAPSHOT_DIR, name);
  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
  if (UPDATING) {
    await fs.writeFile(file, actual);
    return;
  }
  let expected;
  try {
    expected = await fs.readFile(file, 'utf8');
  } catch {
    await fs.writeFile(file, actual);
    return; // first run seeds the baseline
  }
  assert.equal(actual, expected, hint);
}

// Every stylesheet the browser applies, in document order — inline <style> blocks and linked
// files alike. Concatenation order is part of the contract: CSS cascade depends on it, so this
// catches a rule that is lost AND a rule that merely moves.
async function collectAppliedCss($, baseUrl) {
  const chunks = [];
  const nodes = $('style, link[rel="stylesheet"]').toArray();
  for (const el of nodes) {
    const node = $(el);
    if (el.tagName === 'style') {
      chunks.push(node.html() || '');
    } else {
      const href = node.attr('href');
      if (!href) continue;
      const res = await fetch(new URL(href, baseUrl));
      assert.equal(res.status, 200, `stylesheet ${href} should be served`);
      chunks.push(await res.text());
    }
  }
  return chunks.join('\n');
}

// Collapse formatting-only differences so re-indenting during extraction is not a failure,
// while any change to actual selectors/properties/order still is.
function normalizeCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};:,])\s*/g, '$1')
    .trim();
}

function cssSelectorInventory(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [];
  for (const match of withoutComments.matchAll(/(^|[};])\s*([^{}@;]+?)\s*\{/g)) {
    const selector = match[2].replace(/\s+/g, ' ').trim();
    // Skip declaration bodies of at-rules (e.g. the inside of @media) picking up stray text.
    if (!selector || selector.includes(':') && !/[.#\[a-zA-Z]/.test(selector[0])) continue;
    selectors.push(selector);
  }
  return [...new Set(selectors)].sort();
}

test('served app shell: every element id the client JS looks up actually exists in the HTML', async () => {
  // THE headline test. public/app.js finds its DOM by string id ~254 times with no compiler to
  // check them. If the re-plumb renames or drops an element, the JS silently no-ops (exactly how
  // the cross-device markdown bug and the missing .g-item-name rule happened). This fails loudly.
  await withKitchenbotServer('ids', async ({ baseUrl }) => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    const $ = cheerio.load(html);
    const presentIds = new Set($('[id]').map((_, el) => $(el).attr('id')).get());

    const appJs = await fs.readFile(path.join(HERE, '..', 'public', 'app.js'), 'utf8');
    const referenced = new Set(
      [...appJs.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
    );
    assert.ok(referenced.size > 100, `sanity: expected many id lookups, found ${referenced.size}`);

    // Ids created at runtime by the client itself (never server-rendered) are legitimately absent.
    const clientCreated = new Set(
      [...appJs.matchAll(/\.id\s*=\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
    );

    const missing = [...referenced].filter((id) => !presentIds.has(id) && !clientCreated.has(id)).sort();
    assert.deepEqual(
      missing,
      [],
      `public/app.js calls getElementById() for ids that the served page does not contain:\n  ${missing.join('\n  ')}`
    );
  });
});

test('served app shell: the applied CSS is unchanged (content AND cascade order)', async () => {
  // Guards the CSS extraction: moving ~2,787 lines of CSS out of the template string into real
  // stylesheets must not lose, alter, or reorder a single rule.
  await withKitchenbotServer('css', async ({ baseUrl }) => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    const $ = cheerio.load(html);
    const css = await collectAppliedCss($, baseUrl);
    assert.ok(css.length > 20000, `sanity: expected a substantial stylesheet, got ${css.length} chars`);
    await compareSnapshot(
      'app-shell.css.txt',
      normalizeCss(css),
      'The CSS the browser applies changed. If intentional, re-run with UPDATE_FRONTEND_SNAPSHOTS=1 and review the diff.'
    );
  });
});

test('served app shell: the CSS selector inventory is unchanged', async () => {
  // A readable companion to the byte-level CSS snapshot — when that one fails, this names which
  // selectors appeared or vanished.
  await withKitchenbotServer('css-selectors', async ({ baseUrl }) => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    const $ = cheerio.load(html);
    const css = await collectAppliedCss($, baseUrl);
    await compareSnapshot(
      'app-shell.css-selectors.txt',
      `${cssSelectorInventory(css).join('\n')}\n`,
      'The set of CSS selectors changed. If intentional, re-run with UPDATE_FRONTEND_SNAPSHOTS=1.'
    );
  });
});

test('served app shell: the element-id inventory is unchanged', async () => {
  // Guards the HTML extraction: lifting markup out of the template string must not drop or rename
  // an element that the client JS or the styles depend on.
  await withKitchenbotServer('id-inventory', async ({ baseUrl }) => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    const $ = cheerio.load(html);
    const ids = [...new Set($('[id]').map((_, el) => $(el).attr('id')).get())].sort();
    assert.ok(ids.length > 50, `sanity: expected many ids, found ${ids.length}`);
    await compareSnapshot(
      'app-shell.element-ids.txt',
      `${ids.join('\n')}\n`,
      'The set of element ids changed. If intentional, re-run with UPDATE_FRONTEND_SNAPSHOTS=1.'
    );
  });
});

test('served app shell: core regions, palettes, font and boot tags are present', async () => {
  // Explicit assertions for the load-bearing pieces, so a failure names the actual feature that
  // broke rather than just "a snapshot changed".
  await withKitchenbotServer('structure', async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    const $ = cheerio.load(html);
    const css = await collectAppliedCss($, baseUrl);

    for (const id of ['chat', 'chat-list', 'input-area', 'prompt', 'send', 'attach-btn', 'attach-menu']) {
      assert.equal($(`#${id}`).length, 1, `#${id} must exist in the served shell`);
    }

    // All three user-selectable palettes must survive as [data-palette] blocks.
    for (const palette of ['cotton-candy', 'sweetwater', 'sous-chef']) {
      assert.ok(
        css.includes(`data-palette="${palette}"`) || css.includes(`data-palette='${palette}'`),
        `palette "${palette}" must still be defined in CSS`
      );
    }
    assert.ok(/--accent-strong\s*:/.test(css), 'core accent token must be defined');
    assert.ok(/@font-face/.test(css), 'self-hosted font @font-face must survive');

    // Cache-busted client bundle + boot data (see app-shell.mjs).
    assert.ok(/<script[^>]+src="\/app\.js\?v=\d+"/.test(html), 'versioned app.js tag must be present');
    assert.equal($('#kb-boot-data').length, 1, 'client boot-data script tag must be present');

    // Security headers are a shipped feature; keep them from silently regressing.
    const csp = res.headers.get('content-security-policy') || '';
    assert.ok(csp.includes("default-src 'self'"), 'CSP header must still be sent');
  });
});

test('view templates: every KB placeholder is substituted, and a missing value throws', async () => {
  // The importer page is auth-gated so the HTTP net above cannot reach it; this covers the
  // template + loader directly. Also pins the loader's fail-loudly contract: a placeholder with
  // no supplied value must throw at render time rather than silently shipping a stray comment.
  const { renderHtmlTemplate } = await import('../app-shell.mjs');

  const importer = renderHtmlTemplate('recipe-importer', {
    stylesheet: '<link rel="stylesheet" href="/recipe-importer.css" />',
    sourceOptions: '<option value="Salt Fat Acid Heat">Salt Fat Acid Heat</option>',
    clientBoot: '<script src="/recipe-importer.js"></script>',
  });
  assert.doesNotMatch(importer, /<!--KB:/, 'no placeholder may survive rendering');
  assert.match(importer, /<!doctype html>/i);
  assert.match(importer, /Salt Fat Acid Heat/, 'dynamic cookbook-source options are injected');
  assert.match(importer, /recipe-importer\.css/);
  assert.match(importer, /Back to KitchenBot/);

  const app = renderHtmlTemplate('app', { stylesheet: '', clientBoot: '' });
  assert.doesNotMatch(app, /<!--KB:/, 'no placeholder may survive rendering');
  assert.match(app, /id="tab-chat"/);

  assert.throws(
    () => renderHtmlTemplate('app', { stylesheet: '' }),
    /placeholder "clientBoot" with no value/,
    'a placeholder with no supplied value must throw, not render blank'
  );
});

test('served app shell: every stylesheet and script the page references actually resolves', async () => {
  // Extraction moves assets to new URLs; a typo'd path would 404 and silently unstyle the app.
  await withKitchenbotServer('assets', async ({ baseUrl }) => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    const $ = cheerio.load(html);
    const refs = [
      ...$('link[rel="stylesheet"]').map((_, el) => $(el).attr('href')).get(),
      ...$('script[src]').map((_, el) => $(el).attr('src')).get(),
    ].filter((href) => href && !/^https?:/i.test(href));

    for (const href of refs) {
      const res = await fetch(new URL(href, baseUrl));
      assert.equal(res.status, 200, `referenced asset ${href} must resolve (got ${res.status})`);
    }
  });
});
