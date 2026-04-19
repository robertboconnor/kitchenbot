import {
  buildCookbookRecordForStorage,
  COOKBOOK_CATEGORY_OPTIONS,
  parseCookbookRecipeText,
} from './cookbook-store.mjs';
import { createLoggedAnthropicMessage } from './anthropic-usage.mjs';
import { resolveAnthropicModelForCallPurpose } from './anthropic-model-policy.mjs';
import {
  createRecipeImportDraft,
  deleteRecipeImportDraft,
  getCookbookEntryById,
  getCookbookEntryByNormalizedTitle,
  getRecipeImportDraftById,
  saveCookbookEntry,
  updateRecipeImportDraft as updateRecipeImportDraftRow,
} from './db.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

function normalizeUrl(raw) {
  const text = safeTrim(raw).slice(0, 1000);
  return /^https?:\/\//i.test(text) ? text : '';
}

function normalizeStringList(values, limit = 40, maxLength = 320) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = safeTrim(value)
      .replace(/\r/g, '')
      .replace(/^\s*[\u2022*\-]+\s*/, '')
      .replace(/^\s*\d+\.\s*/, '')
      .replace(/\s+/g, ' ')
      .slice(0, maxLength);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeNotesList(values) {
  if (Array.isArray(values)) return normalizeStringList(values, 20, 220);
  const text = safeTrim(values);
  if (!text) return [];
  return normalizeStringList(text.split(/\n+|\s+\|\s+/), 20, 220);
}

function normalizeTags(values) {
  return normalizeStringList(values, 12, 60).map((tag) => tag.toLowerCase());
}

function normalizeCategory(raw) {
  const value = safeTrim(raw).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return COOKBOOK_CATEGORY_OPTIONS.some((option) => option.value === value) ? value : '';
}

function buildImportSummary(title = '', sourceType = '') {
  const sourceLabel = sourceType === 'url' ? 'web source' : sourceType === 'image' ? 'image import' : 'import';
  return safeTrim(`Imported ${title ? `"${title}"` : 'recipe'} from a ${sourceLabel} and reviewed in Recipe Importer.`).slice(0, 600);
}

function normalizeRecipeDraft(raw = {}, { sourceTitle = '' } = {}) {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const title = safeTrim(record.title || sourceTitle).slice(0, 160);
  return {
    title,
    summary: safeTrim(record.summary).slice(0, 600),
    ingredients: normalizeStringList(record.ingredients, 48, 240),
    instructions: normalizeStringList(record.instructions, 32, 320),
    notes: normalizeNotesList(record.notes),
    tags: normalizeTags(record.tags),
    category: normalizeCategory(record.category),
  };
}

function getDraftWarnings(recipe = {}, { sourceType = '', hadWeakExtraction = false } = {}) {
  const warnings = [];
  const ingredientCount = Array.isArray(recipe.ingredients) ? recipe.ingredients.length : 0;
  const instructionCount = Array.isArray(recipe.instructions) ? recipe.instructions.length : 0;
  if (hadWeakExtraction) warnings.push('This source did not expose a clean recipe structure, so the draft may need repair.');
  if (sourceType === 'image') warnings.push('OCR can be noisy. Double-check ingredients, amounts, and numbered steps.');
  if (ingredientCount > 0 && instructionCount === 0) warnings.push('I found ingredients but not clean instructions yet.');
  if (instructionCount > 0 && ingredientCount === 0) warnings.push('I found steps but not a reliable ingredient list yet.');
  if (ingredientCount === 0 && instructionCount === 0) warnings.push('I could not detect a clean recipe automatically yet. You can still repair the draft manually.');
  return normalizeStringList(warnings, 8, 220);
}

function buildDraftPayload({
  sourceType = '',
  sourceUrl = '',
  sourceTitle = '',
  sourceMarkdown = '',
  sourceText = '',
  extractionStatus = 'draft_ready',
  warnings = [],
  recipe = {},
  provenance = {},
  status = 'draft',
} = {}) {
  return {
    sourceType,
    sourceUrl,
    sourceTitle,
    sourceMarkdown,
    sourceText,
    extractionStatus,
    warnings: normalizeStringList(warnings, 10, 220),
    recipe: normalizeRecipeDraft(recipe, { sourceTitle }),
    provenance: {
      importMethod: safeTrim(provenance.importMethod || sourceType),
      fetchProvider: safeTrim(provenance.fetchProvider),
      parser: safeTrim(provenance.parser || 'cookbook_store_parser'),
      imageCount: Number.isFinite(Number(provenance.imageCount)) ? Number(provenance.imageCount) : 0,
      sourceBookTitle: safeTrim(provenance.sourceBookTitle).slice(0, 160),
      createdAt: safeTrim(provenance.createdAt) || new Date().toISOString(),
    },
    status,
  };
}

function buildCanonicalRecipeText({ title = '', markdown = '', text = '' } = {}) {
  const sources = [safeTrim(markdown), safeTrim(text)].filter(Boolean);
  const bestSource = sources.find((value) => /ingredients|instructions|directions|steps?/i.test(value)) || sources[0] || '';
  if (!bestSource) return '';
  if (/\bingredients\b/i.test(bestSource) && /\b(instructions|directions|steps?)\b/i.test(bestSource)) return bestSource;
  const lines = bestSource
    .split(/\n+/)
    .map((line) => safeTrim(line))
    .filter(Boolean);
  const ingredientLines = [];
  const instructionLines = [];
  let mode = '';
  for (const line of lines) {
    if (/^ingredients?[:]?$/i.test(line)) {
      mode = 'ingredients';
      continue;
    }
    if (/^(instructions?|directions?|steps?|method)[:]?$/i.test(line)) {
      mode = 'instructions';
      continue;
    }
    if (mode === 'ingredients') ingredientLines.push(line);
    else if (mode === 'instructions') instructionLines.push(line);
  }
  if (ingredientLines.length === 0 && instructionLines.length === 0) return bestSource;
  return [
    title,
    '',
    'Ingredients',
    ...ingredientLines,
    '',
    'Instructions',
    ...instructionLines,
  ]
    .filter(Boolean)
    .join('\n');
}

function normalizeRecognitionResult(raw, { fallbackTitle = '' } = {}) {
  if (typeof raw === 'string') {
    return {
      title: '',
      text: raw,
      markdown: '',
      warnings: [],
    };
  }
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    title: safeTrim(value.title || fallbackTitle).slice(0, 160),
    text: String(value.text ?? ''),
    markdown: String(value.markdown ?? ''),
    warnings: normalizeStringList(value.warnings, 10, 220),
  };
}

function parseJsonObject(raw) {
  let text = safeTrim(raw);
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)```$/im);
  if (fenced) text = safeTrim(fenced[1]);
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function stripPageFurnitureLine(line = '') {
  const text = safeTrim(line);
  if (!text) return true;
  if (/^\d+$/.test(text)) return true;
  if (/^(page\s+\d+|p\.\s*\d+)$/i.test(text)) return true;
  if (/^[*†‡]\s/.test(text)) return true;
  return false;
}

function cleanupImageOcrText(raw = '') {
  const joinedHyphenation = String(raw ?? '').replace(/([A-Za-z])-\n([A-Za-z])/g, '$1$2');
  const lines = joinedHyphenation.split('\n');
  const out = [];
  for (const original of lines) {
    const line = safeTrim(original).replace(/[ \t]+/g, ' ');
    if (stripPageFurnitureLine(line)) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function cleanupUrlExtractionText({ markdown = '', text = '' } = {}) {
  const source = safeTrim(markdown) || safeTrim(text);
  if (!source) return '';
  const normalized = String(source)
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\u00ad/g, '')
    .replace(/\n{3,}/g, '\n\n');
  const lines = normalized.split('\n');
  const out = [];
  let blankRun = 0;
  let previousNormalized = '';
  for (const original of lines) {
    const line = safeTrim(original);
    if (stripPageFurnitureLine(line)) continue;
    if (!line) {
      blankRun += 1;
      if (blankRun <= 1 && out.length > 0) out.push('');
      continue;
    }
    blankRun = 0;
    const debracketed = line.replace(/\[[^\]]+\]\([^)]+\)/g, (match) => match.replace(/\s+/g, ' '));
    const comparable = debracketed.toLowerCase();
    if (comparable === previousNormalized && !/[.!?]$/.test(debracketed)) continue;
    out.push(debracketed);
    previousNormalized = comparable;
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function estimateStructuredRecipeConfidence(recipe = {}) {
  const ingredientCount = Array.isArray(recipe.ingredients) ? recipe.ingredients.length : 0;
  const instructionCount = Array.isArray(recipe.instructions) ? recipe.instructions.length : 0;
  if (ingredientCount >= 3 && instructionCount >= 2) return 'high';
  if (ingredientCount > 0 || instructionCount > 0) return 'medium';
  return 'low';
}

function buildImageRecipeStructuringSystemPrompt({ retry = false } = {}) {
  return `You convert OCR text from photographed cookbook pages into one KitchenBot recipe draft.

Return ONLY JSON:
{"title":"...","summary":"...","ingredients":["..."],"instructions":["..."],"notes":["..."],"tags":["..."],"category":"soups|sauces|pasta|lunch_dishes|fish|poultry|meat|vegetables|dessert_cakes|","warnings":["..."],"confidence":"high|medium|low"}

Rules:
- OCR text may be out of order because cookbook pages can have multiple columns, grouped ingredient lists, sidebars, footnotes, and decorative text.
- Ingredient and instruction fragments may be interleaved or split apart.
- You may reorder fragments only when the intended recipe structure is strongly supported by the text.
- It is allowed to merge grouped ingredient sections like PRODUCE, DAIRY, PANTRY into one flat ingredient list.
- It is allowed to restore instruction order when numbering or obvious recipe flow makes it clear.
- Ignore obvious page furniture like page numbers, running headers, footnotes, and decorative text.
- Do not invent missing ingredients, quantities, or steps.
- If uncertain, keep partial output and add warnings instead of guessing.
- Preserve the source title when it is clearly the recipe title.
- Keep ingredient lines concise and faithful to the source.
- Keep instructions as short readable step lines, in recipe order when confidently recoverable.
- Keep summary to at most 2 sentences.
- Keep notes short.
- Keep the full JSON compact and concise.
- Use no more than 16 instruction lines.
${retry ? '- Your prior response was truncated. Be especially concise so the JSON completes fully.' : ''}`;
}

function buildUrlRecipeStructuringSystemPrompt({ retry = false } = {}) {
  return `You convert noisy web page recipe extraction into one KitchenBot recipe draft.

Return ONLY JSON:
{"title":"...","summary":"...","ingredients":["..."],"instructions":["..."],"notes":["..."],"tags":["..."],"category":"soups|sauces|pasta|lunch_dishes|fish|poultry|meat|vegetables|dessert_cakes|","warnings":["..."],"confidence":"high|medium|low"}

Rules:
- The extracted page may contain navigation, search UI, taxonomy links, related-article links, author/image-credit debris, affiliate text, or markdown link residue.
- Drop obvious page furniture like "Skip to Content", menus, search labels, category indexes, site chrome, and unrelated article links.
- Preserve genuine recipe content even if the extraction is messy or incomplete.
- Keep ingredient lines faithful to the source. Do not invent missing ingredients, quantities, or steps.
- If the recipe is partial, return partial fields and warnings instead of guessing.
- Keep instructions concise and in cooking order when the order is strongly supported by the text.
- Notes should only contain real recipe notes or useful residual context, not page chrome.
- Summary should be at most 2 sentences and describe the actual recipe.
- Tags should be short recipe tags, not site UI words.
- Pick the closest category from the allowed set, or leave it empty if unclear.
- Keep the full JSON compact and concise.
${retry ? '- Your prior response was truncated. Be especially concise so the JSON completes fully.' : ''}`;
}

async function callImageRecipeStructurer({
  anthropic,
  householdId,
  sourceTitle,
  imageCount,
  ocrWarnings,
  ocrText,
  maxTokens = 900,
  retry = false,
} = {}) {
  const response = await createLoggedAnthropicMessage(
    anthropic,
    {
      model: resolveAnthropicModelForCallPurpose('recipe_import_image_structure'),
      max_tokens: maxTokens,
      system: buildImageRecipeStructuringSystemPrompt({ retry }),
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            sourceTitle: safeTrim(sourceTitle),
            imageCount: Number.isFinite(Number(imageCount)) ? Number(imageCount) : 0,
            ocrWarnings: normalizeStringList(ocrWarnings, 10, 220),
            ocrText,
          }),
        },
      ],
    },
    {
      householdId,
      chatId: null,
      runtimeEnabled: true,
      callSurface: 'recipe_importer',
      callPurpose: 'recipe_import_image_structure',
      webSearchEnabledAtCall: false,
      usedWebSearchTool: false,
    }
  );
  const text = (Array.isArray(response?.content) ? response.content : [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
  return { response, text };
}

async function callUrlRecipeStructurer({
  anthropic,
  householdId,
  sourceUrl,
  sourceTitle,
  sourceMarkdown,
  sourceText,
  maxTokens = 1200,
  retry = false,
} = {}) {
  const response = await createLoggedAnthropicMessage(
    anthropic,
    {
      model: resolveAnthropicModelForCallPurpose('recipe_import_url_structure'),
      max_tokens: maxTokens,
      system: buildUrlRecipeStructuringSystemPrompt({ retry }),
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            sourceUrl: normalizeUrl(sourceUrl),
            sourceTitle: safeTrim(sourceTitle),
            sourceMarkdown: cleanupUrlExtractionText({ markdown: sourceMarkdown }),
            sourceText: cleanupUrlExtractionText({ text: sourceText }),
          }),
        },
      ],
    },
    {
      householdId,
      chatId: null,
      runtimeEnabled: true,
      callSurface: 'recipe_importer',
      callPurpose: 'recipe_import_url_structure',
      webSearchEnabledAtCall: false,
      usedWebSearchTool: false,
    }
  );
  const text = (Array.isArray(response?.content) ? response.content : [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
  return { response, text };
}

export async function structureImportedImageRecipe({
  anthropic = null,
  householdId = null,
  sourceText = '',
  sourceTitle = '',
  imageCount = 0,
  ocrWarnings = [],
} = {}) {
  if (!anthropic) return null;
  const cleanedSourceText = cleanupImageOcrText(sourceText);
  if (!cleanedSourceText) return null;

  try {
    let { response, text } = await callImageRecipeStructurer({
      anthropic,
      householdId,
      sourceTitle,
      imageCount,
      ocrWarnings,
      ocrText: cleanedSourceText,
      maxTokens: 900,
      retry: false,
    });
    let structured = parseJsonObject(text);
    if (!structured && safeTrim(response?.stop_reason) === 'max_tokens') {
      const retryResult = await callImageRecipeStructurer({
        anthropic,
        householdId,
        sourceTitle,
        imageCount,
        ocrWarnings,
        ocrText: cleanedSourceText,
        maxTokens: 1600,
        retry: true,
      });
      response = retryResult.response;
      text = retryResult.text;
      structured = parseJsonObject(text);
    }
    if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return null;

    const recipe = normalizeRecipeDraft(
      {
        title: safeTrim(structured.title || sourceTitle),
        summary: safeTrim(structured.summary),
        ingredients: Array.isArray(structured.ingredients) ? structured.ingredients : [],
        instructions: Array.isArray(structured.instructions) ? structured.instructions : [],
        notes: Array.isArray(structured.notes) ? structured.notes : [],
        tags: Array.isArray(structured.tags) ? structured.tags : [],
        category: safeTrim(structured.category),
      },
      { sourceTitle }
    );
    const modelWarnings = normalizeStringList(Array.isArray(structured.warnings) ? structured.warnings : [], 10, 220);
    const confidence = ['high', 'medium', 'low'].includes(safeTrim(structured.confidence))
      ? safeTrim(structured.confidence)
      : estimateStructuredRecipeConfidence(recipe);
    return { recipe, warnings: modelWarnings, confidence };
  } catch (error) {
    console.error('Image recipe structuring failed:', error?.message || error);
    return null;
  }
}

export async function structureImportedUrlRecipe({
  anthropic = null,
  householdId = null,
  sourceUrl = '',
  sourceTitle = '',
  sourceMarkdown = '',
  sourceText = '',
} = {}) {
  if (!anthropic) return null;
  const cleanedMarkdown = cleanupUrlExtractionText({ markdown: sourceMarkdown });
  const cleanedText = cleanupUrlExtractionText({ text: sourceText });
  if (!cleanedMarkdown && !cleanedText) return null;

  try {
    let { response, text } = await callUrlRecipeStructurer({
      anthropic,
      householdId,
      sourceUrl,
      sourceTitle,
      sourceMarkdown: cleanedMarkdown,
      sourceText: cleanedText,
      maxTokens: 1200,
      retry: false,
    });
    let structured = parseJsonObject(text);
    if (!structured && safeTrim(response?.stop_reason) === 'max_tokens') {
      const retryResult = await callUrlRecipeStructurer({
        anthropic,
        householdId,
        sourceUrl,
        sourceTitle,
        sourceMarkdown: cleanedMarkdown,
        sourceText: cleanedText,
        maxTokens: 2200,
        retry: true,
      });
      response = retryResult.response;
      text = retryResult.text;
      structured = parseJsonObject(text);
    }
    if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return null;

    const recipe = normalizeRecipeDraft(
      {
        title: safeTrim(structured.title || sourceTitle),
        summary: safeTrim(structured.summary),
        ingredients: Array.isArray(structured.ingredients) ? structured.ingredients : [],
        instructions: Array.isArray(structured.instructions) ? structured.instructions : [],
        notes: Array.isArray(structured.notes) ? structured.notes : [],
        tags: Array.isArray(structured.tags) ? structured.tags : [],
        category: safeTrim(structured.category),
      },
      { sourceTitle }
    );
    const modelWarnings = normalizeStringList(Array.isArray(structured.warnings) ? structured.warnings : [], 10, 220);
    const confidence = ['high', 'medium', 'low'].includes(safeTrim(structured.confidence))
      ? safeTrim(structured.confidence)
      : estimateStructuredRecipeConfidence(recipe);
    return { recipe, warnings: modelWarnings, confidence };
  } catch (error) {
    console.error('URL recipe structuring failed:', error?.message || error);
    return null;
  }
}

export function parseImportedRecipe({ sourceType = '', markdown = '', text = '', metadata = {} } = {}) {
  const sourceTitle = safeTrim(metadata.sourceTitle);
  const canonicalText = buildCanonicalRecipeText({ title: sourceTitle, markdown, text });
  const parsed =
    parseCookbookRecipeText(canonicalText || markdown || text, {
      preferredTitle: '',
      sourceUrl: safeTrim(metadata.sourceUrl),
      sourceTitle,
    }) ||
    null;
  if (parsed) {
    const recipe = normalizeRecipeDraft(
      {
        ...parsed,
        title: safeTrim(parsed.title || sourceTitle),
      },
      { sourceTitle }
    );
    return {
      recipe,
      warnings: getDraftWarnings(recipe, { sourceType, hadWeakExtraction: false }),
      confidence: recipe.ingredients.length >= 3 && recipe.instructions.length >= 2 ? 'high' : 'medium',
    };
  }

  const fallback = normalizeRecipeDraft(
    {
      title: sourceTitle || 'Imported recipe draft',
      summary: '',
      ingredients: [],
      instructions: [],
      notes: [],
      tags: [],
      category: '',
    },
    { sourceTitle }
  );
  return {
    recipe: fallback,
    warnings: getDraftWarnings(fallback, { sourceType, hadWeakExtraction: true }),
    confidence: 'low',
  };
}

function extractRiveterPayload(payload = {}) {
  const candidates = [
    payload,
    payload?.data,
    payload?.result,
    payload?.output,
    payload?.document,
  ].filter((value) => value && typeof value === 'object' && !Array.isArray(value));
  for (const candidate of candidates) {
    const markdown =
      safeTrim(candidate.markdown) ||
      safeTrim(candidate.content_markdown) ||
      safeTrim(candidate.main_markdown) ||
      safeTrim(candidate.content?.markdown);
    const text =
      safeTrim(candidate.text) ||
      safeTrim(candidate.content_text) ||
      safeTrim(candidate.main_text) ||
      safeTrim(candidate.content?.text);
    const title =
      safeTrim(candidate.title) ||
      safeTrim(candidate.source_title) ||
      safeTrim(candidate.metadata?.title);
    const url = normalizeUrl(candidate.url || candidate.source_url || payload.url);
    if (markdown || text || title) {
      return { markdown, text, title, url };
    }
  }
  return {
    markdown: '',
    text: '',
    title: '',
    url: normalizeUrl(payload?.url),
  };
}

export async function fetchRecipeSourceWithRiveter(url, { fetchImpl = fetch } = {}) {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl) throw new Error('invalid_url');
  const apiKey = safeTrim(process.env.RIVETER_API_KEY);
  if (!apiKey) throw new Error('riveter_unconfigured');
  const apiUrl = safeTrim(process.env.RIVETER_API_URL) || 'https://api.riveterhq.com/v1/scrape';
  const headers = { 'Content-Type': 'application/json' };
  headers.Authorization = `Bearer ${apiKey}`;
  const body = {
    url: normalizedUrl,
  };
  const proxyCountryCode = safeTrim(process.env.RIVETER_PROXY_COUNTRY_CODE).toLowerCase();
  if (/^[a-z]{2}$/.test(proxyCountryCode)) body.proxy_country_code = proxyCountryCode;
  if (String(process.env.RIVETER_SKIP_CACHE ?? '').trim() === '1') body.skip_cache = true;
  const response = await fetchImpl(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = safeTrim(data?.error || data?.message || response.statusText) || 'riveter_request_failed';
    throw new Error(message);
  }
  const normalized = extractRiveterPayload({
    ...data,
    data: {
      ...(data?.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : {}),
      text: safeTrim(data?.data?.text),
      url: normalizeUrl(data?.data?.url || normalizedUrl),
    },
    url: normalizeUrl(data?.data?.url || normalizedUrl),
  });
  if (!normalized.markdown && !normalized.text) throw new Error('riveter_empty_result');
  return normalized;
}

function normalizeImageMimeType(file = {}) {
  const mimeType = safeTrim(file?.mimetype).toLowerCase();
  if (['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff'].includes(mimeType)) {
    return mimeType;
  }
  const name = safeTrim(file?.originalname).toLowerCase();
  if (/\.(jpe?g)$/.test(name)) return 'image/jpeg';
  if (/\.png$/.test(name)) return 'image/png';
  if (/\.webp$/.test(name)) return 'image/webp';
  if (/\.gif$/.test(name)) return 'image/gif';
  if (/\.bmp$/.test(name)) return 'image/bmp';
  if (/\.(tif|tiff)$/.test(name)) return 'image/tiff';
  return 'image/jpeg';
}

function extractDocumentAiText(document = {}, textAnchor = null) {
  const sourceText = String(document?.text ?? '');
  const segments = Array.isArray(textAnchor?.textSegments) ? textAnchor.textSegments : [];
  if (!sourceText || segments.length === 0) return '';
  const out = [];
  for (const segment of segments) {
    const start = Number.isFinite(Number(segment?.startIndex)) ? Number(segment.startIndex) : 0;
    const end = Number.isFinite(Number(segment?.endIndex)) ? Number(segment.endIndex) : start;
    if (end <= start) continue;
    out.push(sourceText.slice(start, end));
  }
  return out.join('');
}

function normalizeOcrBlockText(raw) {
  return String(raw ?? '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\u00ad/g, '')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildDocumentAiParagraphText(document = {}) {
  const pages = Array.isArray(document?.pages) ? document.pages : [];
  const blocks = [];
  for (const page of pages) {
    for (const paragraph of Array.isArray(page?.paragraphs) ? page.paragraphs : []) {
      const text = normalizeOcrBlockText(extractDocumentAiText(document, paragraph?.layout?.textAnchor));
      if (!text) continue;
      if (/^\d+$/.test(text)) continue;
      blocks.push(text);
    }
  }
  if (blocks.length > 0) return blocks.join('\n\n');

  const lines = [];
  for (const page of pages) {
    for (const line of Array.isArray(page?.lines) ? page.lines : []) {
      const text = normalizeOcrBlockText(extractDocumentAiText(document, line?.layout?.textAnchor));
      if (!text) continue;
      if (/^\d+$/.test(text)) continue;
      lines.push(text);
    }
  }
  if (lines.length > 0) return lines.join('\n');
  return normalizeOcrBlockText(document?.text);
}

function inferDocumentAiTitle(document = {}, fallbackTitle = '') {
  const pages = Array.isArray(document?.pages) ? document.pages : [];
  const lineTexts = [];
  for (const page of pages) {
    for (const line of Array.isArray(page?.lines) ? page.lines : []) {
      const text = normalizeOcrBlockText(extractDocumentAiText(document, line?.layout?.textAnchor));
      if (!text || /^\d+$/.test(text)) continue;
      lineTexts.push(text);
      if (lineTexts.length >= 8) break;
    }
    if (lineTexts.length >= 8) break;
  }
  const titleParts = [];
  for (const line of lineTexts) {
    const lowered = line.toLowerCase();
    if (/^(ingredients?|instructions?|directions?|steps?|method|makes|serves)\b/.test(lowered)) break;
    if (/^\d+[\d\s/.-]*(cups?|cup|tablespoons?|tbsp|teaspoons?|tsp|ounces?|oz|pounds?|lb)\b/i.test(line)) break;
    if (/[.!?]$/.test(line) && line.length > 36) break;
    const words = line.split(/\s+/).filter(Boolean);
    if (titleParts.length === 0) {
      if (words.length <= 8 && line.length <= 60) {
        titleParts.push(line);
        if (words.length >= 4) break;
        continue;
      }
      break;
    }
    if (words.length <= 5 && line.length <= 40) {
      titleParts.push(line);
      if (titleParts.length >= 3) break;
      continue;
    }
    break;
  }
  const inferred = safeTrim(titleParts.join(' ')).slice(0, 160);
  return inferred || safeTrim(fallbackTitle).slice(0, 160);
}

function detectDocumentAiWarnings(document = {}) {
  const warnings = [];
  const pages = Array.isArray(document?.pages) ? document.pages : [];
  for (const page of pages) {
    const scores = Array.isArray(page?.imageQualityScores?.detectedDefects) ? page.imageQualityScores.detectedDefects : [];
    for (const defect of scores) {
      const type = safeTrim(defect?.type || defect?.defectType).toLowerCase();
      if (!type) continue;
      if (type.includes('blurred') || type.includes('noise') || type.includes('cutoff') || type.includes('dark') || type.includes('faint')) {
        warnings.push('The image quality looks a little rough, so double-check the OCR before saving.');
        break;
      }
    }
    if (warnings.length > 0) break;
  }
  return normalizeStringList(warnings, 4, 220);
}

function getGoogleDocumentAiConfig() {
  const projectId = safeTrim(process.env.GOOGLE_DOCUMENT_AI_PROJECT_ID);
  const location = safeTrim(process.env.GOOGLE_DOCUMENT_AI_LOCATION || 'us').toLowerCase();
  const processorId = safeTrim(process.env.GOOGLE_DOCUMENT_AI_PROCESSOR_ID);
  if (!projectId || !location || !processorId) throw new Error('google_document_ai_unconfigured');
  return {
    projectId,
    location,
    processorId,
  };
}

export async function recognizeImagesWithGoogleDocumentAi(files = []) {
  const inputs = Array.isArray(files) ? files : [];
  if (inputs.length === 0) throw new Error('no_images');
  const { projectId, location, processorId } = getGoogleDocumentAiConfig();
  const { v1 } = await import('@google-cloud/documentai');
  const client = new v1.DocumentProcessorServiceClient({
    apiEndpoint: `${location}-documentai.googleapis.com`,
  });
  const name = `projects/${projectId}/locations/${location}/processors/${processorId}`;
  try {
    const pageTexts = [];
    const pageWarnings = [];
    let inferredTitle = '';
    for (const file of inputs) {
      const buffer = file?.buffer || file;
      const mimeType = normalizeImageMimeType(file);
      const [result] = await client.processDocument({
        name,
        rawDocument: {
          content: buffer,
          mimeType,
        },
        processOptions: {
          ocrConfig: {
            enableImageQualityScores: true,
          },
        },
      });
      const document = result?.document || {};
      const pageText = buildDocumentAiParagraphText(document);
      if (pageText) pageTexts.push(pageText);
      pageWarnings.push(...detectDocumentAiWarnings(document));
      if (!inferredTitle) inferredTitle = inferDocumentAiTitle(document, '');
    }
    const combinedText = pageTexts.filter(Boolean).join('\n\n');
    if (!combinedText) throw new Error('google_document_ai_empty_result');
    return {
      title: inferredTitle,
      text: combinedText,
      markdown: combinedText,
      warnings: normalizeStringList(pageWarnings, 6, 220),
    };
  } catch (error) {
    const message = safeTrim(error?.message);
    if (message === 'google_document_ai_unconfigured' || message === 'google_document_ai_empty_result') throw error;
    if (/Could not load the default credentials|Could not load default credentials|Could not refresh access token|Could not read json file/i.test(message)) {
      throw new Error('google_document_ai_auth_failed');
    }
    throw new Error(message || 'google_document_ai_request_failed');
  } finally {
    await client.close().catch(() => {});
  }
}

export async function importRecipeFromUrl({
  url,
  householdId,
  userId,
  anthropic = null,
  fetchImpl = fetch,
} = {}) {
  const source = await fetchRecipeSourceWithRiveter(url, { fetchImpl });
  const structured = await structureImportedUrlRecipe({
    anthropic,
    householdId,
    sourceUrl: source.url || url,
    sourceTitle: source.title,
    sourceMarkdown: source.markdown,
    sourceText: source.text,
  });
  const fallbackParsed = parseImportedRecipe({
    sourceType: 'url',
    markdown: source.markdown,
    text: source.text,
    metadata: {
      sourceTitle: source.title,
      sourceUrl: source.url || url,
    },
  });
  const structuredUsable =
    structured &&
    ((Array.isArray(structured.recipe?.ingredients) && structured.recipe.ingredients.length > 0) ||
      (Array.isArray(structured.recipe?.instructions) && structured.recipe.instructions.length > 0));
  const parsed = structuredUsable
    ? {
        recipe: structured.recipe,
        warnings: normalizeStringList(
          [
            ...(structured.warnings || []),
            ...getDraftWarnings(structured.recipe, { sourceType: 'url', hadWeakExtraction: false }),
          ],
          10,
          220
        ),
        confidence: structured.confidence || estimateStructuredRecipeConfidence(structured.recipe),
        parser: 'anthropic_url_recipe_structurer',
      }
    : {
        ...fallbackParsed,
        warnings: normalizeStringList(
          [
            ...((anthropic && !structuredUsable)
              ? ['I could not confidently isolate the recipe from the web page extraction alone, so this draft may need manual repair.']
              : []),
            ...(fallbackParsed.warnings || []),
          ],
          10,
          220
        ),
        parser: 'cookbook_store_parser_fallback',
      };
  const draft = buildDraftPayload({
    sourceType: 'url',
    sourceUrl: source.url || normalizeUrl(url),
    sourceTitle: source.title,
    sourceMarkdown: source.markdown,
    sourceText: source.text,
    extractionStatus: parsed.confidence === 'high' ? 'draft_ready' : 'draft_needs_review',
    warnings: parsed.warnings,
    recipe: parsed.recipe,
    provenance: {
      importMethod: 'url',
      fetchProvider: 'riveter',
      parser: parsed.parser,
      imageCount: 0,
    },
    status: 'draft',
  });
  return await createRecipeImportDraft(householdId, userId, draft);
}

export async function importRecipeFromImages({
  files,
  householdId,
  userId,
  anthropic = null,
  recognizeImages = recognizeImagesWithGoogleDocumentAi,
} = {}) {
  const normalizedFiles = (Array.isArray(files) ? files : []).filter((file) => file && (file.buffer || file));
  if (normalizedFiles.length === 0) throw new Error('no_images');
  const recognition = normalizeRecognitionResult(await recognizeImages(normalizedFiles));
  const fallbackSourceTitle =
    normalizedFiles
      .map((file) => safeTrim(file?.originalname).replace(/\.[a-z0-9]+$/i, ''))
      .find(Boolean) || 'Imported recipe draft';
  const sourceTitle = recognition.title || fallbackSourceTitle;
  const sourceText = recognition.text;
  const sourceMarkdown = recognition.markdown;
  const structured = await structureImportedImageRecipe({
    anthropic,
    householdId,
    sourceText,
    sourceTitle,
    imageCount: normalizedFiles.length,
    ocrWarnings: recognition.warnings,
  });
  const fallbackParsed = parseImportedRecipe({
    sourceType: 'image',
    markdown: sourceMarkdown,
    text: sourceText,
    metadata: { sourceTitle },
  });
  const structuredUsable =
    structured &&
    ((Array.isArray(structured.recipe?.ingredients) && structured.recipe.ingredients.length > 0) ||
      (Array.isArray(structured.recipe?.instructions) && structured.recipe.instructions.length > 0));
  const parsed = structuredUsable
    ? {
        recipe: structured.recipe,
        warnings: normalizeStringList(
          [
            ...(recognition.warnings || []),
            ...(structured.warnings || []),
            ...getDraftWarnings(structured.recipe, { sourceType: 'image', hadWeakExtraction: false }),
          ],
          10,
          220
        ),
        confidence: structured.confidence || estimateStructuredRecipeConfidence(structured.recipe),
        parser: 'anthropic_image_recipe_structurer',
      }
    : {
        ...fallbackParsed,
        warnings: normalizeStringList(
          [
            ...(recognition.warnings || []),
            ...(structured && !structuredUsable
              ? ['I could not confidently reconstruct the recipe from OCR alone, so this draft may need manual repair.']
              : []),
            ...(fallbackParsed.warnings || []),
          ],
          10,
          220
        ),
        parser: 'cookbook_store_parser_fallback',
      };
  const warnings = parsed.warnings;
  const draft = buildDraftPayload({
    sourceType: 'image',
    sourceTitle,
    sourceMarkdown,
    sourceText,
    extractionStatus: parsed.confidence === 'high' ? 'draft_ready' : 'draft_needs_review',
    warnings,
    recipe: parsed.recipe,
    provenance: {
      importMethod: 'image',
      fetchProvider: 'google_document_ai',
      parser: parsed.parser,
      imageCount: normalizedFiles.length,
    },
    status: 'draft',
  });
  return await createRecipeImportDraft(householdId, userId, draft);
}

export async function createManualRecipeImportDraft({ householdId, userId, recipe = {}, provenance = {} } = {}) {
  const normalizedRecipe = normalizeRecipeDraft(recipe, { sourceTitle: safeTrim(recipe?.title) });
  const draft = buildDraftPayload({
    sourceType: 'manual',
    sourceTitle: normalizedRecipe.title,
    sourceMarkdown: '',
    sourceText: '',
    extractionStatus: 'manual_draft',
    warnings: [],
    recipe: normalizedRecipe,
    provenance: {
      importMethod: 'manual',
      fetchProvider: '',
      parser: 'manual_editor',
      imageCount: 0,
      sourceBookTitle: safeTrim(provenance?.sourceBookTitle),
    },
    status: 'draft',
  });
  return await createRecipeImportDraft(householdId, userId, draft);
}

export async function getRecipeImportDraft({ draftId, householdId, userId } = {}) {
  return await getRecipeImportDraftById(householdId, userId, draftId);
}

export async function updateRecipeImportDraft({ draftId, householdId, userId, patch = {} } = {}) {
  const existing = await getRecipeImportDraftById(householdId, userId, draftId);
  if (!existing) return null;
  const nextRecipe = normalizeRecipeDraft(
    patch?.recipe && typeof patch.recipe === 'object' && !Array.isArray(patch.recipe)
      ? { ...existing.recipe, ...patch.recipe }
      : existing.recipe,
    { sourceTitle: safeTrim(patch?.sourceTitle || existing.sourceTitle) }
  );
  const nextWarnings =
    Array.isArray(patch?.warnings) && patch.warnings.length > 0
      ? normalizeStringList(patch.warnings, 10, 220)
      : existing.warnings;
  const next = {
    sourceType: safeTrim(patch?.sourceType || existing.sourceType) || existing.sourceType,
    sourceUrl: normalizeUrl(patch?.sourceUrl || existing.sourceUrl),
    sourceTitle: safeTrim(patch?.sourceTitle || existing.sourceTitle),
    sourceMarkdown: patch?.sourceMarkdown === undefined ? existing.sourceMarkdown : String(patch.sourceMarkdown ?? ''),
    sourceText: patch?.sourceText === undefined ? existing.sourceText : String(patch.sourceText ?? ''),
    extractionStatus: safeTrim(patch?.extractionStatus || existing.extractionStatus) || existing.extractionStatus,
    warnings: nextWarnings,
    recipe: nextRecipe,
    provenance:
      patch?.provenance && typeof patch.provenance === 'object' && !Array.isArray(patch.provenance)
        ? { ...existing.provenance, ...patch.provenance }
        : existing.provenance,
    status: safeTrim(patch?.status || existing.status) || existing.status,
  };
  return await updateRecipeImportDraftRow(householdId, userId, draftId, next);
}

function validateDraftForSave(draft) {
  const recipe = normalizeRecipeDraft(draft?.recipe, { sourceTitle: draft?.sourceTitle });
  if (!recipe.title) return 'Add a recipe title before saving.';
  if (recipe.ingredients.length === 0) return 'Add at least one ingredient before saving.';
  if (recipe.instructions.length === 0) return 'Add at least one instruction step before saving.';
  return '';
}

function normalizeSavedCookbookEntryId(raw) {
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? Math.trunc(id) : 0;
}

function buildDuplicateRecipeTitleError({ existingItem, attemptedTitle } = {}) {
  const title = safeTrim(existingItem?.title || attemptedTitle || 'that recipe');
  const error = new Error(`A recipe named "${title}" already exists in your Cookbook.`);
  error.code = 'duplicate_recipe_title';
  error.conflict = {
    existingCookbookEntryId: Number(existingItem?.id) || 0,
    existingCookbookTitle: title,
  };
  return error;
}

export async function saveRecipeImportDraftToCookbook({ draftId, householdId, userId, overwriteExisting = false } = {}) {
  const draft = await getRecipeImportDraftById(householdId, userId, draftId);
  if (!draft) throw new Error('draft_not_found');
  const validationError = validateDraftForSave(draft);
  if (validationError) throw new Error(validationError);

  const recipe = normalizeRecipeDraft(draft.recipe, { sourceTitle: draft.sourceTitle });
  const record = buildCookbookRecordForStorage({
    title: recipe.title,
    summary: recipe.summary || buildImportSummary(recipe.title, draft.sourceType),
    category: recipe.category,
    recipeType: 'saved_recipe',
    ingredients: recipe.ingredients,
    instructions: recipe.instructions,
    notes: recipe.notes,
    tags: recipe.tags,
    sourceBookTitle: safeTrim(draft?.provenance?.sourceBookTitle),
    sourceTitle: draft.sourceTitle || recipe.title,
    sourceUrl: draft.sourceUrl,
    sourceKind: draft.sourceType === 'url' && draft.sourceUrl ? 'web_fetch' : 'manual',
  });
  if (!record) throw new Error('invalid_recipe_record');

  const existingByTitle = record.normalizedTitle ? await getCookbookEntryByNormalizedTitle(householdId, record.normalizedTitle) : null;
  const draftSavedCookbookEntryId = normalizeSavedCookbookEntryId(draft?.provenance?.savedCookbookEntryId);
  let targetCookbookEntryId = draftSavedCookbookEntryId;
  if (existingByTitle && Number(existingByTitle.id) !== draftSavedCookbookEntryId) {
    if (!overwriteExisting) {
      throw buildDuplicateRecipeTitleError({ existingItem: existingByTitle, attemptedTitle: record.title });
    }
    targetCookbookEntryId = Number(existingByTitle.id) || 0;
  }

  let savedId = 0;
  try {
    savedId = await saveCookbookEntry(householdId, record, targetCookbookEntryId ? { id: targetCookbookEntryId } : {});
  } catch (error) {
    if (/UNIQUE constraint failed: cookbook_entries\.household_id, cookbook_entries\.normalized_title/i.test(safeTrim(error?.message))) {
      const conflictingEntry = record.normalizedTitle ? await getCookbookEntryByNormalizedTitle(householdId, record.normalizedTitle) : null;
      if (conflictingEntry && overwriteExisting) {
        savedId = await saveCookbookEntry(householdId, record, { id: Number(conflictingEntry.id) });
      } else {
        throw buildDuplicateRecipeTitleError({ existingItem: conflictingEntry, attemptedTitle: record.title });
      }
    } else {
      throw error;
    }
  }
  const savedItem = await getCookbookEntryById(householdId, savedId);
  await updateRecipeImportDraftRow(householdId, userId, draftId, {
    status: 'saved',
    provenance: {
      ...draft.provenance,
      savedCookbookEntryId: savedId,
    },
  });
  return savedItem;
}

export async function discardRecipeImportDraft({ draftId, householdId, userId } = {}) {
  return await deleteRecipeImportDraft(householdId, userId, draftId);
}
