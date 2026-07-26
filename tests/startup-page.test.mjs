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
  // app.js is cache-busted with a ?v=<deploy version> query so deploys never serve stale JS.
  assert.match(html, /<script src="\/app\.js(\?v=\d+)?"><\/script>/);
  // type="module" is opt-in per page: it implies strict mode and removes top-level names from
  // global scope, so a classic-script page must not inherit it by default.
  assert.doesNotMatch(html, /type="module"/);
  const moduleHtml = renderClientBootTags({}, { asModule: true });
  assert.match(moduleHtml, /<script type="module" src="\/app\.js(\?v=\d+)?"><\/script>/);
  assert.doesNotMatch(html, /Pasta <\/script><script>alert\(1\)<\/script>/);
  assert.match(html, /\\u003c\/script\\u003e\\u003cscript\\u003ealert\(1\)\\u003c\/script\\u003e/);
});

test('renderClientBootTags supports a dedicated client runtime per page', async () => {
  const html = renderClientBootTags({ ok: true }, { scriptSrc: '/recipe-importer.js' });
  assert.match(html, /<script src="\/recipe-importer\.js(\?v=\d+)?"><\/script>/);
});

test('every client file parses as a standalone browser file', async () => {
  // app.js AND each feature module. These only ever run in a browser, so without this a syntax
  // error in a module is invisible to the node suite until a Playwright run notices the app is
  // simply gone.
  const clientDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public');
  const moduleDir = path.join(clientDir, 'modules');
  const files = [
    path.join(clientDir, 'app.js'),
    ...(await fs.readdir(moduleDir)).filter((f) => f.endsWith('.js')).map((f) => path.join(moduleDir, f)),
  ];
  for (const file of files) {
    await execFileAsync(process.execPath, ['--check', file]);
  }
});

test('recipe importer runtime parses as a standalone browser file', async () => {
  await execFileAsync(process.execPath, [
    '--check',
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public/recipe-importer.js'),
  ]);
});

test('recipe importer runtime includes sticky save-state controls for saved and dirty drafts', async () => {
  const source = await fs.readFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public/recipe-importer.js'), 'utf8');
  assert.match(source, /lastSavedDraftSignature/);
  assert.match(source, /function isDirtySinceSave\(/);
  assert.match(source, /function renderActionBarState\(/);
  assert.match(source, /Saved to Cookbook\./);
  assert.match(source, /That recipe already exists\./);
  assert.match(source, /kb_recipe_importer_last_draft_id/);
  assert.match(source, /importer-primary-actions/);
  assert.match(source, /importer-conflict-state/);
  assert.match(source, /importer-saving-state/);
  assert.match(source, /importer-save-actions/);
  assert.match(source, /Paste a URL or add photos and I’ll turn it into an editable recipe draft, or add one manually\./);
});

test('public app runtime includes cookbook display helpers used by cookbook rendering', async () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const source = await fs.readFile(path.resolve(here, '../public/app.js'), 'utf8');
  // The pure display/search helpers now live in their own importable module; app.js imports them.
  const displayModule = await fs.readFile(path.resolve(here, '../public/modules/cookbook-display.js'), 'utf8');
  const cookbookFeatureSource = await fs.readFile(path.resolve(here, '../public/modules/cookbook.js'), 'utf8');
  assert.match(displayModule, /export function getCookbookDisplayTitle\(/);
  assert.match(displayModule, /export function getCookbookDisplaySource\(/);
  assert.match(displayModule, /export function getCookbookDisplayProvenance\(/);
  // cookbook.js is the only consumer now that app.js is a composition root, so assert the import
  // where it actually lives rather than pinning it to whichever file used to hold the rendering.
  assert.match(cookbookFeatureSource, /from '\.\/cookbook-display\.js'/);
  // Card/detail rendering moved into the cookbook feature module.
  const cookbookModule = await fs.readFile(path.resolve(here, '../public/modules/cookbook.js'), 'utf8');
  assert.match(cookbookModule, /function buildCookbookOverflowMenu\(/);
  assert.match(cookbookModule, /function buildCookbookCardTags\(/);
  assert.match(cookbookModule, /function fitCookbookCardTags\(/);
  assert.match(cookbookModule, /function renderCookbookDetailActions\(/);
  assert.match(cookbookModule, /cookbookDetailActions/);
  assert.match(cookbookModule, /cookbook-card-mobile-row/);
  assert.match(cookbookModule, /summary\.textContent = 'More'/);
  assert.doesNotMatch(cookbookModule, /let currentCookbookExpandedCardId = null/);
  assert.doesNotMatch(cookbookModule, /Tap to preview/);
  assert.doesNotMatch(cookbookModule, /cookbook-card-mobile-body/);
});

test('root page template uses the extracted external client runtime hook', async () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const source = await fs.readFile(path.resolve(here, '../kitchenbot.mjs'), 'utf8');
  // Styles now live in real stylesheets instead of an inline <style> block in the template
  // string, so selector assertions read the .css files (see app-shell.renderStylesheetLink).
  const appCss = await fs.readFile(path.resolve(here, '../public/app.css'), 'utf8');
  const importerCss = await fs.readFile(path.resolve(here, '../public/recipe-importer.css'), 'utf8');
  // Page markup now lives in real .html templates under views/ (see app-shell.renderHtmlTemplate),
  // so markup assertions read those; kitchenbot.mjs keeps only routing and the dynamic values.
  const appHtml = await fs.readFile(path.resolve(here, '../views/app.html'), 'utf8');
  const importerHtml = await fs.readFile(path.resolve(here, '../views/recipe-importer.html'), 'utf8');

  // Wiring: the routes supply each template's placeholders.
  assert.match(source, /renderHtmlTemplate\('app', \{/);
  assert.match(source, /renderHtmlTemplate\('recipe-importer', \{/);
  assert.match(source, /renderStylesheetLink\('app\.css'\)/);
  assert.match(source, /renderStylesheetLink\('recipe-importer\.css'\)/);
  assert.match(source, /renderClientBootTags\(\s*\{ cookbookCategoryOptions: COOKBOOK_CATEGORY_OPTIONS \}/);
  // The app bundle opts into type="module"; the importer's classic runtime deliberately does not.
  assert.match(source, /\{ asModule: true \}/);
  assert.match(source, /scriptSrc: '\/recipe-importer\.js'/);
  assert.match(source, /Content-Security-Policy/);
  assert.match(source, /app\.get\('\/recipe-importer', requireHousehold, requireAuth/);
  // Every placeholder in a template must be fed by its route.
  assert.match(appHtml, /<!--KB:stylesheet-->/);
  assert.match(appHtml, /<!--KB:clientBoot-->/);
  assert.match(importerHtml, /<!--KB:sourceOptions-->/);

  // marked + DOMPurify are vendored locally (no unpinned CDN).
  assert.match(appHtml, /<script src="\/vendor\/marked\.min\.js"><\/script>/);
  assert.match(appHtml, /<script src="\/vendor\/purify\.min\.js"><\/script>/);
  assert.match(appHtml, /Kitchen workspace/);
  assert.match(appHtml, /Recipe library/);
  assert.match(appHtml, /Import Recipe/);
  assert.match(appHtml, /id="tab-chat"/);
  assert.match(appHtml, /id="tab-groceries"/);
  assert.match(appHtml, /id="tab-settings"/);
  assert.match(importerHtml, /You can also type one in by hand\./);
  assert.match(importerHtml, /<a href="\/#cookbook">Back to KitchenBot<\/a>/);
  assert.match(importerHtml, /Overwrite existing recipe/);
  assert.match(importerHtml, /importer-conflict-state/);

  assert.match(appCss, /\.cookbook-card-more-toggle/);
  assert.match(appCss, /\.cookbook-card-summary/);
  assert.match(appCss, /\.cookbook-card--mobile/);
  assert.match(appCss, /\.cookbook-card-mobile-row/);
  assert.match(appCss, /\.cookbook-detail-actions/);
  assert.match(appCss, /max-height: calc\(100vh - 118px\)/);
  assert.match(importerCss, /\.importer-action-state\[data-state-visible="true"\]\s*\{\s*display: flex !important;/);
  assert.doesNotMatch(appCss, /\.cookbook-card-mobile-body/);
});

test('main app runtime treats #cookbook as a first-class route into the cookbook subview', async () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const source = await fs.readFile(path.resolve(here, '../public/app.js'), 'utf8');
  // Tab / Kitchen sub-view routing now lives in its own module, which only ANNOUNCES navigation
  // (TAB_CHANGED / KITCHEN_VIEW_CHANGED) instead of calling into settings, plan, and cookbook.
  const nav = await fs.readFile(path.resolve(here, '../public/modules/navigation.js'), 'utf8');
  assert.match(nav, /export function isCookbookHash\(/);
  assert.match(nav, /\^#cookbook\(\?:\\\/\\d\+\)\?\$\//);
  assert.match(nav, /const KITCHEN_SECTION_STORAGE_KEY = 'kb_kitchen_active_section'/);
  assert.match(nav, /let currentKitchenView = readKitchenSectionPreference\(\)/);
  assert.match(nav, /emit\(EVENTS\.TAB_CHANGED/);
  assert.match(nav, /emit\(EVENTS\.KITCHEN_VIEW_CHANGED/);
  // Navigation must not reach back into the features it used to call directly. Comments are
  // stripped first — the module's own header explains what it no longer calls, by name.
  const navCode = nav.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(navCode, /loadSettingsPanel|renderThisWeekStrip|loadThisWeek|syncCookbookWorkspaceLayout/);
  // reapplyVisibleAppTab decides which tab to restore, so it lives with navigation now.
  assert.match(nav, /export function reapplyVisibleAppTab\(/);
  assert.match(nav, /if \(isCookbookHash\(\)\) \{/);
  assert.match(source, /const shouldOpenCookbookFromHash = isCookbookHash\(\)/);
  const cookbookFeature = await fs.readFile(path.resolve(here, '../public/modules/cookbook.js'), 'utf8');
  assert.match(cookbookFeature, /export function syncCookbookWorkspaceLayout\(/);
  // The old sidebar "Household" settings button was removed (Settings is a first-class tab now).
  assert.doesNotMatch(source, /sidebar-household/);
  assert.match(source, /window\.addEventListener\('pageshow', \(\) => \{\s*reapplyVisibleAppTab\(\);/);
});

test('settings UI includes household id and key slots for quick household-context debugging', async () => {
  const appHtml = await fs.readFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../views/app.html'), 'utf8');
  // Settings lives in its own module now, so scan the whole client (app.js + modules) rather than
  // pinning this to whichever file happens to own the code today.
  const clientDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public');
  const moduleDir = path.join(clientDir, 'modules');
  const clientFiles = [
    path.join(clientDir, 'app.js'),
    ...(await fs.readdir(moduleDir)).filter((f) => f.endsWith('.js')).map((f) => path.join(moduleDir, f)),
  ];
  const appSource = (await Promise.all(clientFiles.map((f) => fs.readFile(f, 'utf8')))).join('\n');
  assert.match(appHtml, /id="my-settings-hh-id"/);
  assert.match(appHtml, /id="my-settings-hh-key"/);
  assert.match(appSource, /document\.getElementById\('my-settings-hh-id'\)/);
  assert.match(appSource, /idEl\.textContent = String\(data\.household\.id \?\? ''\)/);
});
