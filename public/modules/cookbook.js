// The cookbook: the recipe library, its filters and search, and the detail/edit view.
//
// Owns all of its own state (the cache, the three filters, the open entry and its edit draft) —
// none of it was ever shared, it just lived in the same global scope as everything else.
//
// Talks to the rest of the app only through published interfaces: navigation for tab/sub-view
// moves, session for the read-only flag, and a COMPOSE_PROMPT event when the user asks to build a
// grocery list from a recipe (so the cookbook never reaches into the chat composer).

import { EVENTS, emit, on } from './events.js';
import { isCookbookHash, setActiveTab, setKitchenView } from './navigation.js';
import { isReadOnly } from './session.js';
import { isMobile } from './device.js';
import { COOKBOOK_CATEGORY_OPTIONS } from './boot-data.js';
import {
  buildCookbookSearchFields,
  cookbookDetailHash,
  formatCookbookBullets,
  formatCookbookCategoryLabel,
  getCookbookCardMetaText,
  getCookbookCardSummary,
  getCookbookDisplayProvenance,
  getCookbookDisplaySource,
  getCookbookDisplayTitle,
  getCookbookProvenanceLabel,
  getCookbookSourceDisplay,
  normalizeCookbookDisplayTitleKey,
  normalizeCookbookDisplayTitleText,
  normalizeCookbookDisplayUrl,
  normalizeCookbookSearchText,
  safeCookbookTrim,
  sanitizeCookbookDisplaySourceTitle,
  sanitizeCookbookDisplayTitle,
  scoreCookbookSearchMatch,
  splitCookbookEditorLines,
  stripCookbookDisplayMarkdown,
  tokenizeCookbookSearch,
} from './cookbook-display.js';

// Feature-local state (verified by the 2026-07-26 audit to be read/written only here).
let cookbookCache = [];
let currentCookbookCategoryFilter = '';
let currentCookbookTagFilter = '';
let currentCookbookSearchFilter = '';
let currentCookbookEntryId = null;
let cookbookDetailEntry = null;
let cookbookDetailDraft = null;
let cookbookDetailEditing = false;
let cookbookTagMeasureEl = null;

// DOM handles, bound by initCookbook() once the document exists. Declared here rather than
// resolved per-call so the moved code below reads exactly as it did in app.js.
let cookbookWorkspace = null;
let cookbookResultsArea = null;
let cookbookList = null;
let cookbookEmpty = null;
let cookbookToolbar = null;
let cookbookCategoryFilter = null;
let cookbookTagFilter = null;
let cookbookSearchFilter = null;
let cookbookDetailView = null;
let cookbookDetailBack = null;
let cookbookDetailMeta = null;
let cookbookDetailEdit = null;
let cookbookDetailCancel = null;
let cookbookDetailSave = null;
let cookbookDetailTitle = null;
let cookbookDetailCategory = null;
let cookbookDetailSummary = null;
let cookbookDetailIngredients = null;
let cookbookDetailInstructions = null;
let cookbookDetailNotes = null;
let cookbookDetailTags = null;
let cookbookDetailSource = null;
let cookbookDetailMessage = null;
let cookbookDetailActions = null;

/** Read-only (God Mode impersonation). Kept as a local alias so moved code is untouched. */
function readOnlyNow() {
  return isReadOnly();
}

export function populateCookbookCategoryControls() {
  if (cookbookCategoryFilter && cookbookCategoryFilter.options.length <= 2) {
    for (const option of COOKBOOK_CATEGORY_OPTIONS) {
      const el = document.createElement('option');
      el.value = option.value;
      el.textContent = option.label;
      cookbookCategoryFilter.appendChild(el);
    }
  }
  if (cookbookDetailCategory && cookbookDetailCategory.options.length <= 1) {
    for (const option of COOKBOOK_CATEGORY_OPTIONS) {
      const el = document.createElement('option');
      el.value = option.value;
      el.textContent = option.label;
      cookbookDetailCategory.appendChild(el);
    }
  }
}

function buildCookbookTagOptions(entries) {
  const values = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!Array.isArray(entry.tags)) continue;
    for (const rawTag of entry.tags) {
      const tag = String(rawTag || '').trim();
      if (tag) values.add(tag);
    }
  }
  return Array.from(values).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function populateCookbookTagFilter(entries) {
  if (!cookbookTagFilter) return;
  const previousValue = currentCookbookTagFilter || cookbookTagFilter.value || '';
  cookbookTagFilter.innerHTML = '';
  const allOption = document.createElement('option');
  allOption.value = '';
  allOption.textContent = 'All tags';
  cookbookTagFilter.appendChild(allOption);
  const tags = buildCookbookTagOptions(entries);
  for (const tag of tags) {
    const option = document.createElement('option');
    option.value = tag;
    option.textContent = tag;
    cookbookTagFilter.appendChild(option);
  }
  const nextValue = tags.includes(previousValue) ? previousValue : '';
  currentCookbookTagFilter = nextValue;
  cookbookTagFilter.value = nextValue;
}







function appendCookbookSourceRow(container, entry) {
  if (!container) return;
  const source = getCookbookSourceDisplay(entry);
  if (!source) return;
  const row = document.createElement('div');
  row.className = 'cookbook-detail-source-row';

  const label = document.createElement('span');
  label.className = 'cookbook-detail-source-label';
  label.textContent = 'Source:';
  row.appendChild(label);

  if (source.url) {
    const link = document.createElement('a');
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'cookbook-detail-source-link';
    link.textContent = source.label;
    row.appendChild(link);
  } else {
    const text = document.createElement('span');
    text.textContent = source.label;
    row.appendChild(text);
  }

  container.appendChild(row);
}

function shouldShowCookbookSourceInCard(entry) {
  const source = getCookbookSourceDisplay(entry);
  if (!source || !source.label) return false;
  if (source.url) return true;
  const normalizedLabel = normalizeCookbookDisplayTitleKey(source.label);
  if (!normalizedLabel || normalizedLabel === 'kitchenbot original') return false;
  return normalizedLabel !== normalizeCookbookDisplayTitleKey(getCookbookDisplayTitle(entry));
}

function buildCookbookCardSource(entry) {
  const source = getCookbookSourceDisplay(entry);
  if (!source || !shouldShowCookbookSourceInCard(entry)) return null;
  const row = document.createElement('div');
  row.className = 'cookbook-card-source';
  if (source.url) {
    const link = document.createElement('a');
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = source.label;
    row.appendChild(link);
  } else {
    row.textContent = source.label;
  }
  return row;
}


function ensureCookbookTagMeasureEl() {
  if (cookbookTagMeasureEl) return cookbookTagMeasureEl;
  const el = document.createElement('span');
  el.style.position = 'absolute';
  el.style.visibility = 'hidden';
  el.style.pointerEvents = 'none';
  el.style.whiteSpace = 'nowrap';
  el.style.left = '-9999px';
  el.style.top = '-9999px';
  document.body.appendChild(el);
  cookbookTagMeasureEl = el;
  return el;
}

function measureCookbookTagChipWidth(text, { overflow = false } = {}) {
  const el = ensureCookbookTagMeasureEl();
  el.className = overflow ? 'cookbook-tag-chip cookbook-tag-chip--overflow' : 'cookbook-tag-chip';
  el.textContent = text;
  return Math.ceil(el.getBoundingClientRect().width);
}

function fitCookbookCardTags(tags, maxWidth) {
  const cleaned = Array.isArray(tags) ? tags.filter(Boolean) : [];
  if (!cleaned.length) return { visibleTags: [], overflowCount: 0 };
  const gap = 6;
  const available = Math.max(120, Math.floor(Number(maxWidth) || 0));
  let used = 0;
  const visibleTags = [];

  for (let index = 0; index < cleaned.length; index += 1) {
    const tag = cleaned[index];
    const chipWidth = measureCookbookTagChipWidth(tag);
    const nextUsed = used + (visibleTags.length ? gap : 0) + chipWidth;
    const remainingAfter = cleaned.length - (index + 1);
    if (remainingAfter > 0) {
      const overflowWidth = measureCookbookTagChipWidth('+' + String(remainingAfter), { overflow: true });
      if (nextUsed + gap + overflowWidth <= available) {
        visibleTags.push(tag);
        used = nextUsed;
        continue;
      }
      break;
    }
    if (nextUsed <= available || visibleTags.length === 0) {
      visibleTags.push(tag);
    }
    break;
  }

  return {
    visibleTags,
    overflowCount: Math.max(0, cleaned.length - visibleTags.length),
  };
}

function buildCookbookCardTags(entry, { maxWidth = 240 } = {}) {
  const tags = Array.isArray(entry.tags) ? entry.tags.filter(Boolean) : [];
  if (!tags.length) return null;
  const { visibleTags, overflowCount } = fitCookbookCardTags(tags, maxWidth);
  const wrap = document.createElement('div');
  wrap.className = 'cookbook-card-tags';
  for (const tag of visibleTags) {
    const chip = document.createElement('span');
    chip.className = 'cookbook-tag-chip';
    chip.textContent = tag;
    wrap.appendChild(chip);
  }
  if (overflowCount > 0) {
    const overflow = document.createElement('span');
    overflow.className = 'cookbook-tag-chip cookbook-tag-chip--overflow';
    overflow.textContent = '+' + String(overflowCount);
    wrap.appendChild(overflow);
  }
  return wrap;
}



async function deleteCookbookEntry(entry, { closeDetailOnSuccess = false } = {}) {
  if (!entry || !Number.isFinite(Number(entry.id))) return false;
  if (!confirm('Delete "' + entry.title + '" from the cookbook?')) return false;
  try {
    const response = await fetch('/cookbook/' + encodeURIComponent(entry.id), {
      method: 'DELETE',
    });
    if (!response.ok) return false;
    if (closeDetailOnSuccess && Number(currentCookbookEntryId) === Number(entry.id)) {
      closeCookbookDetail({ pushHash: true, force: true });
    }
    await loadCookbook();
    return true;
  } catch (e) {
    return false;
  }
}

function buildCookbookOverflowMenu(entry, { includeEditInline = false } = {}) {
  const moreWrap = document.createElement('details');
  moreWrap.className = 'cookbook-card-more';

  const summary = document.createElement('summary');
  summary.textContent = 'More';
  summary.className = 'cookbook-card-more-toggle';
  moreWrap.appendChild(summary);

  const menu = document.createElement('div');
  menu.className = 'cookbook-card-more-menu';

  if (!includeEditInline) {
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'cookbook-card-menu-btn';
    editBtn.textContent = 'Edit';
    editBtn.disabled = readOnlyNow();
    editBtn.addEventListener('click', () => {
      moreWrap.open = false;
      openCookbookDetail(entry.id, { edit: true, pushHash: true });
    });
    menu.appendChild(editBtn);
  }

  const planBtn = document.createElement('button');
  planBtn.type = 'button';
  planBtn.className = 'cookbook-card-menu-btn';
  planBtn.textContent = 'Use for planning';
  planBtn.addEventListener('click', () => {
    moreWrap.open = false;
    seedCookbookPrompt('Plan dinners from our cookbook, and make sure to include "' + entry.title + '".');
  });
  menu.appendChild(planBtn);

  const groceryBtn = document.createElement('button');
  groceryBtn.type = 'button';
  groceryBtn.className = 'cookbook-card-menu-btn';
  groceryBtn.textContent = 'Generate grocery list';
  groceryBtn.addEventListener('click', () => {
    moreWrap.open = false;
    seedCookbookPrompt('Make me a grocery list from our cookbook recipe "' + entry.title + '".');
  });
  menu.appendChild(groceryBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'cookbook-card-menu-btn cookbook-card-menu-btn--danger';
  deleteBtn.textContent = 'Delete';
  deleteBtn.disabled = readOnlyNow();
  deleteBtn.addEventListener('click', async () => {
    moreWrap.open = false;
    await deleteCookbookEntry(entry);
  });
  menu.appendChild(deleteBtn);

  moreWrap.appendChild(menu);
  return moreWrap;
}

function buildCookbookCardHeading(entry, { compact = false } = {}) {
  const headingWrap = document.createElement('div');
  headingWrap.className = 'cookbook-card-heading';

  const title = document.createElement('div');
  title.className = 'cookbook-card-title';
  title.textContent = getCookbookDisplayTitle(entry) || 'Untitled recipe';
  headingWrap.appendChild(title);

  const metaText = getCookbookCardMetaText(entry);
  if (metaText) {
    const metaEl = document.createElement('div');
    metaEl.className = 'cookbook-card-meta';
    metaEl.textContent = metaText;
    headingWrap.appendChild(metaEl);
  }

  const sourceRow = compact ? null : buildCookbookCardSource(entry);
  if (sourceRow) headingWrap.appendChild(sourceRow);
  return headingWrap;
}

function renderCookbookDetailActions(entry) {
  if (!cookbookDetailActions) return;
  cookbookDetailActions.innerHTML = '';
  if (!entry) return;

  const disablePromptActions = cookbookDetailEditing;

  const planBtn = document.createElement('button');
  planBtn.type = 'button';
  planBtn.className = 'cookbook-detail-button cookbook-card-action-secondary';
  planBtn.textContent = 'Use for planning';
  planBtn.disabled = disablePromptActions;
  planBtn.addEventListener('click', () => {
    seedCookbookPrompt('Plan dinners from our cookbook, and make sure to include "' + entry.title + '".');
  });
  cookbookDetailActions.appendChild(planBtn);

  const groceryBtn = document.createElement('button');
  groceryBtn.type = 'button';
  groceryBtn.className = 'cookbook-detail-button cookbook-card-action-secondary';
  groceryBtn.textContent = 'Generate grocery list';
  groceryBtn.disabled = disablePromptActions;
  groceryBtn.addEventListener('click', () => {
    seedCookbookPrompt('Make me a grocery list from our cookbook recipe "' + entry.title + '".');
  });
  cookbookDetailActions.appendChild(groceryBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'cookbook-detail-button cookbook-card-menu-btn cookbook-card-menu-btn--danger cookbook-detail-button--danger';
  deleteBtn.textContent = 'Delete';
  deleteBtn.disabled = readOnlyNow() || cookbookDetailEditing;
  deleteBtn.addEventListener('click', async () => {
    await deleteCookbookEntry(entry, { closeDetailOnSuccess: true });
  });
  cookbookDetailActions.appendChild(deleteBtn);
}


function useCookbookSplitLayout() {
  return !!window.matchMedia && window.matchMedia('(min-width: 980px)').matches;
}

export function syncCookbookWorkspaceLayout() {
  if (!cookbookWorkspace) return;
  const showSplit = useCookbookSplitLayout() && !!currentCookbookEntryId && !!cookbookDetailView && cookbookDetailView.style.display !== 'none';
  cookbookWorkspace.classList.toggle('cookbook-layout-split', showSplit);
  if (cookbookResultsArea) {
    cookbookResultsArea.classList.toggle('cookbook-results-area--detail-open', showSplit);
  }
}

export function parseCookbookDetailHash() {
  const match = String(window.location.hash || '').match(/^#cookbook\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function setCookbookDetailMessage(text, isError = false) {
  if (!cookbookDetailMessage) return;
  cookbookDetailMessage.textContent = text || '';
  cookbookDetailMessage.style.color = isError ? '#a33a2b' : 'var(--text-soft)';
}


function buildCookbookDetailDraft() {
  return {
    title: cookbookDetailTitle ? cookbookDetailTitle.value.trim() : '',
    category: cookbookDetailCategory ? cookbookDetailCategory.value : '',
    summary: cookbookDetailSummary ? cookbookDetailSummary.value.trim() : '',
    ingredients: splitCookbookEditorLines(cookbookDetailIngredients ? cookbookDetailIngredients.value : ''),
    instructions: splitCookbookEditorLines(cookbookDetailInstructions ? cookbookDetailInstructions.value : ''),
    notes: splitCookbookEditorLines(cookbookDetailNotes ? cookbookDetailNotes.value : ''),
    tags: String(cookbookDetailTags ? cookbookDetailTags.value : '')
      .split(',')
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean),
  };
}

function cookbookDetailIsDirty() {
  return cookbookDetailEditing && JSON.stringify(cookbookDetailDraft || {}) !== JSON.stringify(buildCookbookDetailDraft());
}

function seedCookbookPrompt(text) {
  // The cookbook does not own the composer; it asks for it to be filled.
  setActiveTab('chat');
  emit(EVENTS.COMPOSE_PROMPT, { text: String(text || '').trim() });
}

function setCookbookDetailEditing(editing) {
  cookbookDetailEditing = !!editing;
  const disabled = !cookbookDetailEditing || readOnlyNow();
  if (cookbookDetailTitle) cookbookDetailTitle.disabled = disabled;
  if (cookbookDetailCategory) cookbookDetailCategory.disabled = disabled;
  if (cookbookDetailSummary) cookbookDetailSummary.disabled = disabled;
  if (cookbookDetailIngredients) cookbookDetailIngredients.disabled = disabled;
  if (cookbookDetailInstructions) cookbookDetailInstructions.disabled = disabled;
  if (cookbookDetailNotes) cookbookDetailNotes.disabled = disabled;
  if (cookbookDetailTags) cookbookDetailTags.disabled = disabled;
  if (cookbookDetailEdit) cookbookDetailEdit.style.display = cookbookDetailEditing ? 'none' : '';
  if (cookbookDetailCancel) cookbookDetailCancel.style.display = cookbookDetailEditing ? '' : 'none';
  if (cookbookDetailSave) cookbookDetailSave.style.display = cookbookDetailEditing ? '' : 'none';
  renderCookbookDetailActions(cookbookDetailEntry);
}

function renderCookbookDetail(entry, { edit = false } = {}) {
  if (!entry || !cookbookDetailView) return;
  cookbookDetailEntry = entry;
  currentCookbookEntryId = Number(entry.id);
  if (cookbookDetailTitle) cookbookDetailTitle.value = getCookbookDisplayTitle(entry);
  if (cookbookDetailCategory) cookbookDetailCategory.value = entry.category || '';
  if (cookbookDetailSummary) cookbookDetailSummary.value = entry.summary || '';
  if (cookbookDetailIngredients) cookbookDetailIngredients.value = formatCookbookBullets(entry.ingredients).join('\n');
  if (cookbookDetailInstructions) cookbookDetailInstructions.value = formatCookbookBullets(entry.instructions).join('\n');
  if (cookbookDetailNotes) cookbookDetailNotes.value = formatCookbookBullets(Array.isArray(entry.notes) ? entry.notes : entry.notes ? [entry.notes] : []).join('\n');
  if (cookbookDetailTags) cookbookDetailTags.value = Array.isArray(entry.tags) ? entry.tags.join(', ') : '';
  if (cookbookDetailMeta) cookbookDetailMeta.textContent = getCookbookCardMetaText(entry);
  if (cookbookDetailSource) {
    cookbookDetailSource.innerHTML = '';
    appendCookbookSourceRow(cookbookDetailSource, entry);
  }
  cookbookDetailDraft = buildCookbookDetailDraft();
  setCookbookDetailMessage('');
  setCookbookDetailEditing(edit && !readOnlyNow());
  renderCookbookDetailActions(entry);
  if (cookbookDetailView) cookbookDetailView.style.display = 'flex';
  if (useCookbookSplitLayout()) {
    if (cookbookList) cookbookList.style.display = 'grid';
    if (cookbookToolbar) cookbookToolbar.style.display = '';
  } else {
    if (cookbookList) cookbookList.style.display = 'none';
    if (cookbookEmpty) cookbookEmpty.style.display = 'none';
    if (cookbookToolbar) cookbookToolbar.style.display = 'none';
  }
  syncCookbookWorkspaceLayout();
  renderCookbook();
}

export async function openCookbookDetail(id, { edit = false, pushHash = true } = {}) {
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) return;
  try {
    const response = await fetch('/cookbook/' + encodeURIComponent(numericId));
    if (!response.ok) throw new Error('Failed to load recipe');
    const data = await response.json();
    if (!data || !data.item) throw new Error('Missing recipe');
    setActiveTab('groceries');
    setKitchenView('cookbook');
    renderCookbookDetail(data.item, { edit });
    if (pushHash && window.location.hash !== cookbookDetailHash(numericId)) {
      window.location.hash = cookbookDetailHash(numericId);
    }
  } catch (e) {
    setCookbookDetailMessage('Could not open that recipe right now.', true);
  }
}

function closeCookbookDetail({ pushHash = true, force = false } = {}) {
  if (!force && cookbookDetailIsDirty() && !confirm('Discard your cookbook edits?')) return false;
  currentCookbookEntryId = null;
  cookbookDetailEntry = null;
  cookbookDetailDraft = null;
  cookbookDetailEditing = false;
  renderCookbookDetailActions(null);
  if (cookbookDetailView) cookbookDetailView.style.display = 'none';
  if (cookbookList) cookbookList.style.display = 'grid';
  if (cookbookToolbar) cookbookToolbar.style.display = '';
  syncCookbookWorkspaceLayout();
  renderCookbook();
  if (pushHash && window.location.hash) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  return true;
}

async function saveCookbookDetail() {
  if (!currentCookbookEntryId || readOnlyNow()) return;
  const payload = buildCookbookDetailDraft();
  setCookbookDetailMessage('Saving…');
  try {
    const response = await fetch('/cookbook/' + encodeURIComponent(currentCookbookEntryId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.item) {
      setCookbookDetailMessage(data.error || 'Could not save that recipe right now.', true);
      return;
    }
    cookbookCache = (Array.isArray(cookbookCache) ? cookbookCache : []).map((entry) =>
      Number(entry.id) === Number(data.item.id) ? data.item : entry
    );
    populateCookbookTagFilter(cookbookCache);
    renderCookbookDetail(data.item, { edit: false });
    renderCookbook();
    setCookbookDetailMessage('Saved.');
  } catch (e) {
    setCookbookDetailMessage('Could not save that recipe right now.', true);
  }
}

export function renderCookbook() {
  if (!cookbookList || !cookbookEmpty) return;
  cookbookList.innerHTML = '';
  cookbookList.style.gap = isMobile ? '0' : '12px';
  const detailOpen = !!cookbookDetailView && cookbookDetailView.style.display !== 'none';
  const splitLayout = useCookbookSplitLayout();
  const hasSearchQuery = tokenizeCookbookSearch(currentCookbookSearchFilter).length > 0;
  const entries = (Array.isArray(cookbookCache) ? cookbookCache : [])
    .map((entry, index) => ({
      entry,
      index,
      searchScore: hasSearchQuery ? scoreCookbookSearchMatch(entry, currentCookbookSearchFilter) : 0,
    }))
    .filter(({ entry, searchScore }) => {
      const categoryMatches =
        !currentCookbookCategoryFilter ||
        (currentCookbookCategoryFilter === 'uncategorized'
          ? !entry.category
          : String(entry.category || '') === currentCookbookCategoryFilter);
      if (!categoryMatches) return false;
      const tagMatches =
        !currentCookbookTagFilter ||
        (Array.isArray(entry.tags)
          ? entry.tags.some((tag) => String(tag || '').trim() === currentCookbookTagFilter)
          : false);
      if (!tagMatches) return false;
      if (!hasSearchQuery) return true;
      return searchScore >= 0;
    })
    .sort((a, b) => {
      if (hasSearchQuery && b.searchScore !== a.searchScore) return b.searchScore - a.searchScore;
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
  cookbookEmpty.style.display = !detailOpen || splitLayout ? (entries.length === 0 ? '' : 'none') : 'none';
  cookbookList.style.display = detailOpen && !splitLayout ? 'none' : 'grid';
  if (cookbookToolbar) cookbookToolbar.style.display = detailOpen && !splitLayout ? 'none' : '';
  for (const entry of entries) {
    const card = document.createElement('div');
    card.className = 'cookbook-card' + (isMobile ? ' cookbook-card--mobile' : '');
    if (currentCookbookEntryId && Number(entry.id) === Number(currentCookbookEntryId)) {
      card.classList.add('cookbook-card--active');
    }
    const summaryText = getCookbookCardSummary(entry);
    const actions = document.createElement('div');
    actions.className = 'cookbook-card-actions';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.textContent = 'Open';
    openBtn.className = 'cookbook-card-action-primary';
    openBtn.addEventListener('click', () => {
      openCookbookDetail(entry.id, { edit: false, pushHash: true });
    });
    actions.appendChild(openBtn);

    if (!isMobile) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = 'Edit';
      editBtn.className = 'cookbook-card-action-secondary';
      editBtn.disabled = readOnlyNow();
      editBtn.addEventListener('click', () => {
        openCookbookDetail(entry.id, { edit: true, pushHash: true });
      });
      actions.appendChild(editBtn);
    }

    const overflow = buildCookbookOverflowMenu(entry, { includeEditInline: !isMobile });
    actions.appendChild(overflow);

    if (isMobile) {
      const rowBtn = document.createElement('button');
      rowBtn.type = 'button';
      rowBtn.className = 'cookbook-card-mobile-row';
      rowBtn.appendChild(buildCookbookCardHeading(entry, { compact: true }));

      const chevron = document.createElement('span');
      chevron.className = 'cookbook-card-mobile-chevron';
      chevron.setAttribute('aria-hidden', 'true');
      chevron.textContent = '›';
      rowBtn.appendChild(chevron);

      rowBtn.addEventListener('click', () => {
        openCookbookDetail(entry.id, { edit: false, pushHash: true });
      });
      card.appendChild(rowBtn);
    } else {
      const topRow = document.createElement('div');
      topRow.className = 'cookbook-card-header';
      topRow.appendChild(buildCookbookCardHeading(entry));
      card.appendChild(topRow);

      const tagsWrap = buildCookbookCardTags(entry, {
        maxWidth: Math.max(180, Math.floor((cookbookList?.clientWidth || window.innerWidth) - 120)),
      });
      if (tagsWrap) {
        card.appendChild(tagsWrap);
      }

      if (summaryText) {
        const summary = document.createElement('div');
        summary.className = 'cookbook-card-summary';
        summary.textContent = summaryText;
        card.appendChild(summary);
      }

      card.appendChild(actions);
    }

    cookbookList.appendChild(card);
  }
}

export async function loadCookbook() {
  try {
    const response = await fetch('/cookbook');
    if (!response.ok) return;
    const data = await response.json();
    cookbookCache = Array.isArray(data.items) ? data.items : [];
    populateCookbookTagFilter(cookbookCache);
    renderCookbook();
    if (currentCookbookEntryId && cookbookDetailView && cookbookDetailView.style.display !== 'none') {
      const refreshedEntry = cookbookCache.find((entry) => Number(entry.id) === Number(currentCookbookEntryId));
      if (refreshedEntry && !cookbookDetailEditing) {
        renderCookbookDetail(refreshedEntry, { edit: false });
      }
    }
    const hashId = parseCookbookDetailHash();
    if (hashId && hashId !== currentCookbookEntryId) {
      await openCookbookDetail(hashId, { pushHash: false });
    }
  } catch (e) {
    console.error('Cookbook load failed:', e);
    cookbookCache = [];
    populateCookbookTagFilter([]);
    renderCookbook();
  }
}

function initializeCookbookUi() {
  populateCookbookCategoryControls();
  populateCookbookTagFilter(cookbookCache);
  syncCookbookWorkspaceLayout();
  if (cookbookSearchFilter) cookbookSearchFilter.value = currentCookbookSearchFilter;
  if (cookbookCategoryFilter) {
    cookbookCategoryFilter.addEventListener('change', () => {
      currentCookbookCategoryFilter = cookbookCategoryFilter.value;
      renderCookbook();
    });
  }
  if (cookbookTagFilter) {
    cookbookTagFilter.addEventListener('change', () => {
      currentCookbookTagFilter = cookbookTagFilter.value;
      renderCookbook();
    });
  }
  if (cookbookSearchFilter) {
    cookbookSearchFilter.addEventListener('input', () => {
      currentCookbookSearchFilter = cookbookSearchFilter.value || '';
      renderCookbook();
    });
  }
  if (cookbookDetailBack) {
    cookbookDetailBack.addEventListener('click', () => {
      closeCookbookDetail({ pushHash: true });
    });
  }
  if (cookbookDetailEdit) {
    cookbookDetailEdit.addEventListener('click', () => {
      setCookbookDetailEditing(true);
      setCookbookDetailMessage('');
    });
  }
  if (cookbookDetailCancel) {
    cookbookDetailCancel.addEventListener('click', () => {
      if (!cookbookDetailEntry) return;
      if (cookbookDetailIsDirty() && !confirm('Discard your cookbook edits?')) return;
      renderCookbookDetail(cookbookDetailEntry, { edit: false });
    });
  }
  if (cookbookDetailSave) {
    cookbookDetailSave.addEventListener('click', async () => {
      await saveCookbookDetail();
    });
  }
  window.addEventListener('hashchange', async () => {
    if (isCookbookHash()) {
      setActiveTab('groceries');
      setKitchenView('cookbook');
      await loadCookbook();
      return;
    }
    const hashId = parseCookbookDetailHash();
    if (!hashId) {
      const closed = closeCookbookDetail({ pushHash: false, force: false });
      if (!closed && currentCookbookEntryId) {
        window.location.hash = cookbookDetailHash(currentCookbookEntryId);
      }
      return;
    }
    if (currentUserId == null) return;
    if (Number(hashId) === Number(currentCookbookEntryId)) return;
    if (currentCookbookEntryId && Number(hashId) !== Number(currentCookbookEntryId) && cookbookDetailIsDirty()) {
      if (!confirm('Discard your cookbook edits?')) {
        window.location.hash = cookbookDetailHash(currentCookbookEntryId);
        return;
      }
    }
    await openCookbookDetail(hashId, { pushHash: false });
  });
  window.addEventListener('beforeunload', (event) => {
    if (!cookbookDetailIsDirty()) return;
    event.preventDefault();
    event.returnValue = '';
  });
  window.addEventListener('resize', () => {
    syncCookbookWorkspaceLayout();
    if (!cookbookList) return;
    renderCookbook();
  });
}

/**
 * Disable the detail editor when God Mode is impersonating read-only. Previously app.js reached
 * into these elements from its own global read-only sweep; the cookbook now owns it.
 */
function syncCookbookReadOnly() {
  const ro = readOnlyNow();
  if (cookbookDetailEdit) cookbookDetailEdit.disabled = ro;
  if (cookbookDetailSave) cookbookDetailSave.disabled = ro;
  for (const field of [
    cookbookDetailTitle, cookbookDetailCategory, cookbookDetailSummary, cookbookDetailIngredients,
    cookbookDetailInstructions, cookbookDetailNotes, cookbookDetailTags,
  ]) {
    if (field) field.disabled = ro || !cookbookDetailEditing;
  }
}

/** Drop cached recipes and any open detail — called on logout so nothing leaks between users. */
export function resetCookbook() {
  cookbookCache = [];
  currentCookbookEntryId = null;
  cookbookDetailEntry = null;
  cookbookDetailDraft = null;
  cookbookDetailEditing = false;
}

/** Bind DOM handles and wire the cookbook's own listeners. Called once at startup. */
export function initCookbook() {
  cookbookWorkspace = document.getElementById('cookbook-workspace');
  cookbookResultsArea = document.getElementById('cookbook-results-area');
  cookbookList = document.getElementById('cookbook-list');
  cookbookEmpty = document.getElementById('cookbook-empty');
  cookbookToolbar = document.getElementById('cookbook-toolbar');
  cookbookCategoryFilter = document.getElementById('cookbook-category-filter');
  cookbookTagFilter = document.getElementById('cookbook-tag-filter');
  cookbookSearchFilter = document.getElementById('cookbook-search-filter');
  cookbookDetailView = document.getElementById('cookbook-detail-view');
  cookbookDetailBack = document.getElementById('cookbook-detail-back');
  cookbookDetailMeta = document.getElementById('cookbook-detail-meta');
  cookbookDetailEdit = document.getElementById('cookbook-detail-edit');
  cookbookDetailCancel = document.getElementById('cookbook-detail-cancel');
  cookbookDetailSave = document.getElementById('cookbook-detail-save');
  cookbookDetailTitle = document.getElementById('cookbook-detail-title');
  cookbookDetailCategory = document.getElementById('cookbook-detail-category');
  cookbookDetailSummary = document.getElementById('cookbook-detail-summary');
  cookbookDetailIngredients = document.getElementById('cookbook-detail-ingredients');
  cookbookDetailInstructions = document.getElementById('cookbook-detail-instructions');
  cookbookDetailNotes = document.getElementById('cookbook-detail-notes');
  cookbookDetailTags = document.getElementById('cookbook-detail-tags');
  cookbookDetailSource = document.getElementById('cookbook-detail-source');
  cookbookDetailMessage = document.getElementById('cookbook-detail-message');
  cookbookDetailActions = document.getElementById('cookbook-detail-actions');
  initializeCookbookUi();
  // The cookbook keeps its split layout in step with the Kitchen sub-view instead of navigation
  // reaching in to call syncCookbookWorkspaceLayout() directly.
  on(EVENTS.KITCHEN_VIEW_CHANGED, () => syncCookbookWorkspaceLayout());
  on(EVENTS.READ_ONLY_CHANGED, () => syncCookbookReadOnly());
  on(EVENTS.SESSION_CHANGED, () => syncCookbookReadOnly());
}
