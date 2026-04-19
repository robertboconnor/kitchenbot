(function () {
  function readBootData() {
    const el = document.getElementById('kb-boot-data');
    if (!el) return {};
    try {
      return JSON.parse(el.textContent || '{}');
    } catch {
      return {};
    }
  }

  function safeTrim(value) {
    return String(value ?? '').trim();
  }

  function splitLines(value) {
    return String(value ?? '')
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeSourceBookTitle(value) {
    return safeTrim(value).replace(/\s+/g, ' ').slice(0, 160);
  }

  function sortSourceTitles(values) {
    return Array.from(new Set((Array.isArray(values) ? values : []).map(normalizeSourceBookTitle).filter(Boolean))).sort((a, b) =>
      a.localeCompare(b)
    );
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || 'Request failed');
    }
    return data;
  }

  const boot = readBootData();
  const categoryOptions = Array.isArray(boot.cookbookCategoryOptions) ? boot.cookbookCategoryOptions : [];

  const statusEl = document.getElementById('importer-status');
  const statusTitleEl = statusEl ? statusEl.querySelector('.importer-status-title') : null;
  const statusDetailEl = statusEl ? statusEl.querySelector('.importer-status-detail') : null;
  const urlInput = document.getElementById('importer-url-input');
  const urlSubmit = document.getElementById('importer-url-submit');
  const cameraBtn = document.getElementById('importer-camera-btn');
  const uploadBtn = document.getElementById('importer-upload-btn');
  const cameraInput = document.getElementById('importer-camera-input');
  const uploadInput = document.getElementById('importer-upload-input');
  const previewShell = document.getElementById('importer-preview-shell');
  const sourcePreview = document.getElementById('importer-source-preview');
  const sourceMeta = document.getElementById('importer-source-meta');
  const warningsEl = document.getElementById('importer-warnings');
  const sourceBookField = document.getElementById('importer-source-book-field');
  const sourceBookSelect = document.getElementById('importer-source-book-select');
  const sourceBookCustom = document.getElementById('importer-source-book-custom');
  const titleInput = document.getElementById('importer-title');
  const summaryInput = document.getElementById('importer-summary');
  const categoryInput = document.getElementById('importer-category');
  const tagsInput = document.getElementById('importer-tags');
  const ingredientsInput = document.getElementById('importer-ingredients');
  const instructionsInput = document.getElementById('importer-instructions');
  const notesInput = document.getElementById('importer-notes');
  const saveBtn = document.getElementById('importer-save');
  const resetBtn = document.getElementById('importer-reset');
  const primaryActions = document.getElementById('importer-primary-actions');
  const savingState = document.getElementById('importer-saving-state');
  const conflictState = document.getElementById('importer-conflict-state');
  const conflictDetail = document.getElementById('importer-conflict-detail');
  const overwriteBtn = document.getElementById('importer-overwrite');
  const keepEditingBtn = document.getElementById('importer-keep-editing');
  const saveActions = document.getElementById('importer-save-actions');
  const openCookbookLink = document.getElementById('importer-open-cookbook');
  const importAnotherBtn = document.getElementById('importer-import-another');
  const LAST_DRAFT_STORAGE_KEY = 'kb_recipe_importer_last_draft_id';

  let currentDraft = null;
  let saving = false;
  let importBusy = false;
  let knownCookbookSources = sortSourceTitles(boot.knownCookbookSources);
  let sourceBookMode = 'existing';
  let sourceBookCustomDraft = '';
  let statusTimer = null;
  let lastSavedDraftSignature = '';
  let duplicateConflict = null;

  for (const option of categoryOptions) {
    const el = document.createElement('option');
    el.value = option.value;
    el.textContent = option.label;
    categoryInput.appendChild(el);
  }

  function stopStatusAnimation() {
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
  }

  function setStatus(title, detail = '', { tone = 'default' } = {}) {
    stopStatusAnimation();
    if (!statusEl || !statusTitleEl || !statusDetailEl) return;
    statusEl.dataset.tone = tone;
    statusTitleEl.textContent = safeTrim(title);
    statusDetailEl.textContent = safeTrim(detail);
  }

  function rememberCurrentDraftId(draftId) {
    try {
      if (!draftId) {
        window.localStorage.removeItem(LAST_DRAFT_STORAGE_KEY);
        return;
      }
      window.localStorage.setItem(LAST_DRAFT_STORAGE_KEY, safeTrim(draftId));
    } catch {}
  }

  function readRememberedDraftId() {
    try {
      return safeTrim(window.localStorage.getItem(LAST_DRAFT_STORAGE_KEY));
    } catch {
      return '';
    }
  }

  function clearRememberedDraftId() {
    rememberCurrentDraftId('');
  }

  function startProgressStatus(steps, detail) {
    const items = (Array.isArray(steps) ? steps : []).map((step) => safeTrim(step)).filter(Boolean);
    if (items.length === 0) {
      setStatus('Working on it…', safeTrim(detail), { tone: 'loading' });
      return;
    }
    let index = 0;
    setStatus(items[index], detail, { tone: 'loading' });
    statusTimer = setInterval(() => {
      if (index < items.length - 1) index += 1;
      setStatus(items[index], detail, { tone: 'loading' });
      if (index >= items.length - 1) {
        clearInterval(statusTimer);
        statusTimer = null;
      }
    }, 1100);
  }

  function ensureKnownCookbookSource(title) {
    const normalized = normalizeSourceBookTitle(title);
    if (!normalized) return;
    if (!knownCookbookSources.includes(normalized)) {
      knownCookbookSources = sortSourceTitles([...knownCookbookSources, normalized]);
    }
  }

  function getSelectedSourceBookTitle() {
    if (!sourceBookSelect) return '';
    if (sourceBookMode === 'custom') return normalizeSourceBookTitle(sourceBookCustomDraft || (sourceBookCustom ? sourceBookCustom.value : ''));
    return normalizeSourceBookTitle(sourceBookSelect.value);
  }

  function renderSourceBookControl() {
    if (!sourceBookField || !sourceBookSelect || !sourceBookCustom) return;
    const shouldShow = currentDraft?.sourceType === 'image';
    sourceBookField.style.display = shouldShow ? '' : 'none';
    if (!shouldShow) {
      sourceBookSelect.value = '';
      sourceBookCustom.hidden = true;
      sourceBookCustom.value = '';
      return;
    }
    const currentValue = normalizeSourceBookTitle(currentDraft?.provenance?.sourceBookTitle);
    const hasKnownMatch = !!currentValue && knownCookbookSources.includes(currentValue);
    sourceBookSelect.innerHTML = '';

    const baseOptions = [
      { value: '', label: 'No cookbook source' },
      ...knownCookbookSources.map((title) => ({ value: title, label: title })),
      { value: '__add_new__', label: 'Add new…' },
    ];
    for (const option of baseOptions) {
      const el = document.createElement('option');
      el.value = option.value;
      el.textContent = option.label;
      sourceBookSelect.appendChild(el);
    }

    if (sourceBookMode === 'custom' || (currentValue && !hasKnownMatch)) {
      sourceBookSelect.value = '__add_new__';
      sourceBookCustom.hidden = false;
      sourceBookCustom.value = sourceBookCustomDraft || currentValue;
    } else {
      sourceBookSelect.value = hasKnownMatch ? currentValue : '';
      sourceBookCustom.hidden = true;
      sourceBookCustom.value = '';
    }
  }

  function setImportBusy(nextBusy) {
    importBusy = !!nextBusy;
    if (urlSubmit) urlSubmit.disabled = importBusy;
    if (cameraBtn) cameraBtn.disabled = importBusy;
    if (uploadBtn) uploadBtn.disabled = importBusy;
  }

  function buildLocalRecipePatch() {
    return {
      title: safeTrim(titleInput.value),
      summary: safeTrim(summaryInput.value),
      category: safeTrim(categoryInput.value),
      tags: safeTrim(tagsInput.value)
        .split(',')
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean),
      ingredients: splitLines(ingredientsInput.value),
      instructions: splitLines(instructionsInput.value),
      notes: splitLines(notesInput.value),
    };
  }

  function buildLocalProvenancePatch() {
    return {
      ...(currentDraft?.provenance || {}),
      sourceBookTitle: getSelectedSourceBookTitle(),
    };
  }

  function buildDraftSignature(draft) {
    if (!draft) return '';
    const recipe = draft.recipe || {};
    const provenance = draft.provenance || {};
    return JSON.stringify({
      title: safeTrim(recipe.title),
      summary: safeTrim(recipe.summary),
      category: safeTrim(recipe.category),
      tags: Array.isArray(recipe.tags) ? recipe.tags.map((tag) => safeTrim(tag)).filter(Boolean) : [],
      ingredients: Array.isArray(recipe.ingredients) ? recipe.ingredients.map((line) => safeTrim(line)).filter(Boolean) : [],
      instructions: Array.isArray(recipe.instructions) ? recipe.instructions.map((line) => safeTrim(line)).filter(Boolean) : [],
      notes: Array.isArray(recipe.notes) ? recipe.notes.map((line) => safeTrim(line)).filter(Boolean) : [],
      sourceBookTitle: normalizeSourceBookTitle(provenance.sourceBookTitle),
    });
  }

  function getCurrentDraftSignature() {
    return buildDraftSignature(currentDraft);
  }

  function isDirtySinceSave() {
    if (!currentDraft || currentDraft.status !== 'saved' || !lastSavedDraftSignature) return false;
    return getCurrentDraftSignature() !== lastSavedDraftSignature;
  }

  function setActionStateVisibility(element, visible) {
    if (!element) return;
    element.dataset.stateVisible = visible ? 'true' : 'false';
  }

  function renderActionBarState() {
    const actionState = saving
      ? 'saving'
      : currentDraft?.status === 'saved' && !isDirtySinceSave()
        ? 'saved'
        : duplicateConflict
          ? 'conflict'
        : 'unsaved_ready';
    setActionStateVisibility(primaryActions, actionState === 'unsaved_ready');
    setActionStateVisibility(savingState, actionState === 'saving');
    setActionStateVisibility(conflictState, actionState === 'conflict');
    setActionStateVisibility(saveActions, actionState === 'saved');
    if (conflictDetail) {
      const title = safeTrim(duplicateConflict?.existingCookbookTitle || currentDraft?.recipe?.title || 'that recipe');
      conflictDetail.textContent = duplicateConflict
        ? `A recipe named "${title}" already exists in your Cookbook. You can overwrite it or keep editing this draft.`
        : 'You can overwrite the existing cookbook entry or keep editing this draft.';
    }
    if (openCookbookLink) {
      const savedEntryId = currentDraft?.provenance?.savedCookbookEntryId;
      if (savedEntryId) {
        openCookbookLink.href = '/#cookbook/' + encodeURIComponent(String(savedEntryId));
        openCookbookLink.style.display = '';
      } else {
        openCookbookLink.removeAttribute('href');
        openCookbookLink.style.display = 'none';
      }
    }
  }

  function syncDraftFromForm() {
    if (!currentDraft) {
      duplicateConflict = null;
      renderSaveState();
      return;
    }
    duplicateConflict = null;
    currentDraft = {
      ...currentDraft,
      recipe: buildLocalRecipePatch(),
      provenance: buildLocalProvenancePatch(),
    };
    renderSourceBookControl();
    renderSaveState();
  }

  function renderWarnings() {
    if (!warningsEl) return;
    warningsEl.innerHTML = '';
    const warnings = Array.isArray(currentDraft?.warnings) ? currentDraft.warnings : [];
    if (warnings.length === 0) {
      warningsEl.style.display = 'none';
      return;
    }
    warningsEl.style.display = '';
    warningsEl.innerHTML = warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('');
  }

  function renderSourcePreview() {
    if (!sourcePreview || !sourceMeta) return;
    if (!currentDraft) {
      sourceMeta.textContent = 'No draft yet.';
      sourcePreview.textContent = 'Paste a URL, import images, or type a recipe manually to create a draft.';
      if (previewShell) previewShell.open = false;
      return;
    }
    const provenance = currentDraft.provenance || {};
    const metaBits = [
      currentDraft.sourceType === 'url' ? 'URL import' : 'Image import',
      safeTrim(provenance.fetchProvider || ''),
      safeTrim(provenance.parser || ''),
      safeTrim(currentDraft.extractionStatus || ''),
    ].filter(Boolean);
    sourceMeta.textContent = metaBits.join(' • ');
    sourcePreview.textContent =
      safeTrim(currentDraft.sourceMarkdown || currentDraft.sourceText || currentDraft.sourceTitle || '') ||
      'This recipe started in the editor, so there is no extracted source preview for it.';
  }

  function renderEditor() {
    const recipe = currentDraft?.recipe || {};
    titleInput.value = safeTrim(recipe.title);
    summaryInput.value = safeTrim(recipe.summary);
    categoryInput.value = safeTrim(recipe.category);
    tagsInput.value = Array.isArray(recipe.tags) ? recipe.tags.join(', ') : '';
    ingredientsInput.value = Array.isArray(recipe.ingredients) ? recipe.ingredients.join('\n') : '';
    instructionsInput.value = Array.isArray(recipe.instructions) ? recipe.instructions.join('\n') : '';
    notesInput.value = Array.isArray(recipe.notes) ? recipe.notes.join('\n') : '';
    renderSourceBookControl();
  }

  function renderSaveState() {
    const recipe = currentDraft?.recipe || buildLocalRecipePatch();
    const saveable =
      !!safeTrim(recipe.title) &&
      Array.isArray(recipe.ingredients) &&
      recipe.ingredients.length > 0 &&
      Array.isArray(recipe.instructions) &&
      recipe.instructions.length > 0;
    saveBtn.disabled = saving || !saveable;
    renderActionBarState();
  }

  function setDraft(draft) {
    currentDraft = draft || null;
    lastSavedDraftSignature = currentDraft?.status === 'saved' ? buildDraftSignature(currentDraft) : '';
    duplicateConflict = null;
    ensureKnownCookbookSource(currentDraft?.provenance?.sourceBookTitle);
    const currentValue = normalizeSourceBookTitle(currentDraft?.provenance?.sourceBookTitle);
    sourceBookMode = currentValue && !knownCookbookSources.includes(currentValue) ? 'custom' : 'existing';
    sourceBookCustomDraft = sourceBookMode === 'custom' ? safeTrim(currentDraft?.provenance?.sourceBookTitle) : '';
    renderSourcePreview();
    renderWarnings();
    renderEditor();
    renderSaveState();
    if (currentDraft?.id) {
      rememberCurrentDraftId(currentDraft.id);
      const url = new URL(window.location.href);
      url.searchParams.set('draft', currentDraft.id);
      history.replaceState(null, '', url.toString());
    }
  }

  async function loadDraftFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const queryDraftId = safeTrim(params.get('draft'));
    const rememberedDraftId = queryDraftId ? '' : readRememberedDraftId();
    const draftId = queryDraftId || rememberedDraftId;
    if (!draftId) return;
    try {
      setStatus('Loading draft…', 'Pulling your last import back into view.');
      const data = await fetchJson('/recipe-importer/drafts/' + encodeURIComponent(draftId));
      setDraft(data.draft);
      setStatus(queryDraftId ? 'Draft loaded.' : 'Draft restored.', 'You can keep editing before you save.');
    } catch (error) {
      if (!queryDraftId && rememberedDraftId) {
        clearRememberedDraftId();
        setStatus('Ready for a recipe.', 'Paste a URL or add photos and I’ll turn it into an editable recipe draft, or add one manually.');
        return;
      }
      setStatus(error.message || 'Could not load that draft.', 'Try another import or refresh the page.', { tone: 'error' });
    }
  }

  async function requestSaveToCookbook(draftId, overwriteExisting = false) {
    const response = await fetch('/recipe-importer/drafts/' + encodeURIComponent(draftId) + '/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overwriteExisting }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 409 && data.code === 'duplicate_recipe_title') {
      return { ok: false, conflict: data.conflict || {}, error: data.error || 'That recipe already exists in your Cookbook.' };
    }
    if (!response.ok) {
      throw new Error(data.error || 'Could not save that recipe right now.');
    }
    return { ok: true, item: data.item };
  }

  async function importUrl() {
    const url = safeTrim(urlInput.value);
    if (!url) {
      setStatus('Paste a recipe URL first.', 'Once there’s a URL here, I can grab it and turn it into a draft.', { tone: 'error' });
      return;
    }
    setImportBusy(true);
    startProgressStatus(
      ['Grabbing the recipe…', 'Cleaning it up for you…', 'Building your draft…'],
      'Web imports can take a few beats, especially when the page is noisy.'
    );
    try {
      const data = await fetchJson('/recipe-importer/import-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      setDraft(data.draft);
      setStatus('Draft created.', 'Review it, repair anything you want, then save it into Cookbook.');
    } catch (error) {
      setStatus(error.message || 'Could not import that URL right now.', 'Nothing was saved. You can try again or switch sources.', { tone: 'error' });
    } finally {
      setImportBusy(false);
    }
  }

  async function importFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    setImportBusy(true);
    startProgressStatus(
      ['Reading the image…', 'Pulling the text together…', 'Cleaning it up for you…', 'Building your draft…'],
      "Hang tight - I'm extracting and formatting the text from your image."
    );
    const formData = new FormData();
    for (const file of files) formData.append('images', file);
    try {
      const response = await fetch('/recipe-importer/import-images', {
        method: 'POST',
        body: formData,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not import those images.');
      setDraft(data.draft);
      setStatus('Draft created.', 'Review it, repair anything you want, then save it into Cookbook.');
    } catch (error) {
      setStatus(error.message || 'Could not import those images.', 'Nothing was saved. You can try again with another photo.', { tone: 'error' });
    } finally {
      cameraInput.value = '';
      uploadInput.value = '';
      setImportBusy(false);
    }
  }

  async function saveDraft({ overwriteExisting = false } = {}) {
    if (saving) return;
    if (currentDraft) syncDraftFromForm();
    const pendingRecipe = currentDraft?.recipe || buildLocalRecipePatch();
    const pendingProvenance = currentDraft?.provenance || buildLocalProvenancePatch();
    saving = true;
    renderSaveState();
    setStatus('Saving to Cookbook…', 'Committing the edited draft into your saved recipes.', { tone: 'loading' });
    try {
      if (!currentDraft) {
        const createData = await fetchJson('/recipe-importer/drafts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipe: pendingRecipe,
            provenance: pendingProvenance,
          }),
        });
        setDraft(createData.draft);
      }
      await fetchJson('/recipe-importer/drafts/' + encodeURIComponent(currentDraft.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipe: pendingRecipe,
          provenance: pendingProvenance,
        }),
      });
      currentDraft = {
        ...currentDraft,
        recipe: pendingRecipe,
        provenance: pendingProvenance,
      };
      const saveData = await requestSaveToCookbook(currentDraft.id, overwriteExisting);
      if (!saveData.ok) {
        duplicateConflict = saveData.conflict || {};
        renderSaveState();
        setStatus(
          'That recipe already exists.',
          saveData.error || `A recipe named "${safeTrim(pendingRecipe.title || 'that recipe')}" already exists in your Cookbook. You can overwrite it or keep editing this draft.`,
          { tone: 'error' }
        );
        return;
      }
      duplicateConflict = null;
      currentDraft = {
        ...currentDraft,
        status: 'saved',
        provenance: {
          ...(currentDraft.provenance || {}),
          savedCookbookEntryId: saveData.item?.id,
        },
      };
      lastSavedDraftSignature = getCurrentDraftSignature();
      ensureKnownCookbookSource(currentDraft?.provenance?.sourceBookTitle);
      renderSourceBookControl();
      renderSaveState();
      setStatus('Saved to Cookbook.', 'Your cleaned-up draft is now a real cookbook entry.');
    } catch (error) {
      setStatus(error.message || 'Could not save that recipe right now.', 'The draft is still here, so you can try again.', { tone: 'error' });
    } finally {
      saving = false;
      renderSaveState();
    }
  }

  function resetImporter() {
    currentDraft = null;
    lastSavedDraftSignature = '';
    duplicateConflict = null;
    sourceBookMode = 'existing';
    sourceBookCustomDraft = '';
    urlInput.value = '';
    if (sourceBookCustom) sourceBookCustom.value = '';
    clearRememberedDraftId();
    renderSourcePreview();
    renderWarnings();
    renderEditor();
    renderSaveState();
    const url = new URL(window.location.href);
    url.searchParams.delete('draft');
    history.replaceState(null, '', url.toString());
    setStatus('Ready for another recipe.', 'Paste a URL or add photos and I’ll turn it into an editable recipe draft, or add one manually.');
  }

  function handleSourceBookSelectionChange() {
    if (!sourceBookSelect || !sourceBookCustom) return;
    if (sourceBookSelect.value === '__add_new__') {
      sourceBookMode = 'custom';
      sourceBookCustomDraft = safeTrim(currentDraft?.provenance?.sourceBookTitle);
      sourceBookCustom.hidden = false;
      sourceBookCustom.focus();
    } else {
      sourceBookMode = 'existing';
      sourceBookCustomDraft = '';
      sourceBookCustom.hidden = true;
      sourceBookCustom.value = '';
    }
    syncDraftFromForm();
  }

  function keepEditingDraft() {
    duplicateConflict = null;
    renderSaveState();
    setStatus('Keep editing your draft.', 'Rename it or make any changes you want, then save again.');
  }

  urlSubmit.addEventListener('click', importUrl);
  urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      importUrl();
    }
  });
  cameraBtn.addEventListener('click', () => cameraInput.click());
  uploadBtn.addEventListener('click', () => uploadInput.click());
  cameraInput.addEventListener('change', () => importFiles(cameraInput.files));
  uploadInput.addEventListener('change', () => importFiles(uploadInput.files));
  sourceBookSelect.addEventListener('change', handleSourceBookSelectionChange);
  sourceBookCustom.addEventListener('input', () => {
    sourceBookCustomDraft = sourceBookCustom.value;
    syncDraftFromForm();
  });
  [titleInput, summaryInput, categoryInput, tagsInput, ingredientsInput, instructionsInput, notesInput].forEach((input) => {
    input.addEventListener('input', syncDraftFromForm);
  });
  saveBtn.addEventListener('click', () => saveDraft());
  resetBtn.addEventListener('click', resetImporter);
  importAnotherBtn.addEventListener('click', resetImporter);
  overwriteBtn.addEventListener('click', () => saveDraft({ overwriteExisting: true }));
  keepEditingBtn.addEventListener('click', keepEditingDraft);

  renderSourceBookControl();
  renderSourcePreview();
  renderSaveState();
  setStatus('Ready for a recipe.', 'Paste a URL or add photos and I’ll turn it into an editable recipe draft, or add one manually.');
  loadDraftFromUrl();
})();
