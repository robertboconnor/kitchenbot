// Server-injected boot data, read once from the <script id="kb-boot-data"> tag that
// app-shell.renderClientBootTags() emits.
//
// Guarded for a DOM-less environment on purpose: that is what lets the pure modules which depend
// on this (e.g. cookbook-display.js) be imported and unit-tested in Node without a browser.

export function readKitchenBotBootData() {
  if (typeof document === 'undefined') return {};
  const el = document.getElementById('kb-boot-data');
  if (!el) return {};
  try {
    return JSON.parse(el.textContent || '{}');
  } catch (error) {
    console.error('KitchenBot boot data parse failed:', error);
    return {};
  }
}

export const KB_BOOT = readKitchenBotBootData();

export const COOKBOOK_CATEGORY_OPTIONS = Array.isArray(KB_BOOT.cookbookCategoryOptions)
  ? KB_BOOT.cookbookCategoryOptions
  : [];
