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

test('renderClientBootTags supports a dedicated client runtime per page', async () => {
  const html = renderClientBootTags({ ok: true }, { scriptSrc: '/recipe-importer.js' });
  assert.match(html, /<script src="\/recipe-importer\.js"><\/script>/);
});

test('public app runtime parses as a standalone browser file', async () => {
  await execFileAsync(process.execPath, [
    '--check',
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public/app.js'),
  ]);
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
  const source = await fs.readFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public/app.js'), 'utf8');
  assert.match(source, /function getCookbookDisplayTitle\(/);
  assert.match(source, /function getCookbookDisplaySource\(/);
  assert.match(source, /function getCookbookDisplayProvenance\(/);
  assert.match(source, /function buildCookbookOverflowMenu\(/);
  assert.match(source, /function buildCookbookCardTags\(/);
  assert.match(source, /function fitCookbookCardTags\(/);
  assert.match(source, /function renderCookbookDetailActions\(/);
  assert.match(source, /cookbookDetailActions/);
  assert.match(source, /cookbook-card-mobile-row/);
  assert.match(source, /summary\.textContent = 'More'/);
  assert.doesNotMatch(source, /let currentCookbookExpandedCardId = null/);
  assert.doesNotMatch(source, /Tap to preview/);
  assert.doesNotMatch(source, /cookbook-card-mobile-body/);
});

test('root page template uses the extracted external client runtime hook', async () => {
  const source = await fs.readFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../kitchenbot.mjs'), 'utf8');
  assert.match(source, /renderClientBootTags\(\{ cookbookCategoryOptions: COOKBOOK_CATEGORY_OPTIONS \}\)/);
  assert.match(source, /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/marked\/marked\.min\.js"><\/script>/);
  assert.match(source, /scriptSrc: '\/recipe-importer\.js'/);
  assert.match(source, /Kitchen workspace/);
  assert.match(source, /Recipe library/);
  assert.match(source, /Import Recipe/);
  assert.match(source, /\.cookbook-card-more-toggle/);
  assert.match(source, /\.cookbook-card-summary/);
  assert.match(source, /\.cookbook-card--mobile/);
  assert.match(source, /\.cookbook-card-mobile-row/);
  assert.match(source, /\.cookbook-detail-actions/);
  assert.match(source, /id="tab-chat"/);
  assert.match(source, /id="tab-groceries"/);
  assert.match(source, /id="sidebar-household"/);
  assert.match(source, /max-height: calc\(100vh - 118px\)/);
  assert.match(source, /app\.get\('\/recipe-importer', requireHousehold, requireAuth/);
  assert.match(source, /You can also type one in by hand\./);
  assert.match(source, /<a href="\/#cookbook">Back to KitchenBot<\/a>/);
  assert.match(source, /Overwrite existing recipe/);
  assert.match(source, /importer-conflict-state/);
  assert.match(source, /\.importer-action-state\[data-state-visible="true"\]\s*\{\s*display: flex !important;/);
  assert.doesNotMatch(source, /\.cookbook-card-mobile-body/);
  assert.doesNotMatch(source, /id="tab-settings"/);
});

test('main app runtime treats #cookbook as a first-class route into the cookbook subview', async () => {
  const source = await fs.readFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public/app.js'), 'utf8');
  assert.match(source, /function isCookbookHash\(/);
  assert.match(source, /\^#cookbook\(\?:\\\/\\d\+\)\?\$\//);
  assert.match(source, /function reapplyVisibleAppTab\(/);
  assert.match(source, /const shouldOpenCookbookFromHash = isCookbookHash\(\)/);
  assert.match(source, /if \(isCookbookHash\(\)\) \{/);
  assert.match(source, /const KITCHEN_SECTION_STORAGE_KEY = 'kb_kitchen_active_section'/);
  assert.match(source, /let currentGroceriesSubview = readKitchenSectionPreference\(\)/);
  assert.match(source, /function syncCookbookWorkspaceLayout\(/);
  assert.match(source, /const sidebarHouseholdButton = document\.getElementById\('sidebar-household'\)/);
  assert.match(source, /function closeSidebarAndGoToSettingsTab\(/);
  assert.match(source, /sidebarHouseholdButton\.style\.display = r\.ok \? '' : 'none'/);
  assert.match(source, /closeSidebarAndGoToSettingsTab\(\)/);
  assert.match(source, /window\.addEventListener\('pageshow', \(\) => \{\s*reapplyVisibleAppTab\(\);/);
});

test('settings UI includes household id and key slots for quick household-context debugging', async () => {
  const source = await fs.readFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../kitchenbot.mjs'), 'utf8');
  const appSource = await fs.readFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public/app.js'), 'utf8');
  assert.match(source, /id="my-settings-hh-id"/);
  assert.match(source, /id="my-settings-hh-key"/);
  assert.match(appSource, /document\.getElementById\('my-settings-hh-id'\)/);
  assert.match(appSource, /idEl\.textContent = String\(data\.household\.id \?\? ''\)/);
});
