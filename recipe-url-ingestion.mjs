import { load } from 'cheerio';
import { safeFetch, SsrfError } from './safe-fetch.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
}

function normalizeUrl(raw) {
  const text = safeTrim(raw).slice(0, 1000);
  return /^https?:\/\//i.test(text) ? text : '';
}

function normalizeList(values, limit = 40, maxLength = 320) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = safeTrim(value)
      .replace(/\s+/g, ' ')
      .replace(/^[\u2022*\-]+\s*/, '')
      .replace(/^\d+\.\s*/, '')
      .slice(0, maxLength);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function extractTextFromHtml(html = '') {
  const $ = load(html);
  $('script, style, noscript, svg').remove();
  return $('body').text().replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function looksLikeBotBlockPage({ html = '', text = '', pageTitle = '', headers = {}, status = 0 } = {}) {
  const bodyPreview = `${safeTrim(pageTitle)}\n${safeTrim(text)}\n${safeTrim(html).slice(0, 5000)}`.toLowerCase();
  const serverHeader = safeTrim(headers.server || '').toLowerCase();
  const setCookie = safeTrim(headers['set-cookie'] || '').toLowerCase();
  const cfMitigated = safeTrim(headers['cf-mitigated'] || '').toLowerCase();
  const hasCloudflareHeader = serverHeader.includes('cloudflare') || !!safeTrim(headers['cf-ray']);
  const hasCloudflareCookie = setCookie.includes('__cf_bm') || setCookie.includes('cf_clearance');
  const challengeMarkers = [
    'just a moment',
    'attention required',
    'enable javascript and cookies',
    'verify you are human',
    'checking your browser',
    'captcha',
    'security check',
    'access denied',
    'blocked',
  ];
  const markerMatch = challengeMarkers.some((marker) => bodyPreview.includes(marker));

  if ((status === 403 || status === 429) && cfMitigated === 'challenge') {
    return { blocked: true, blockerKind: 'cloudflare' };
  }
  if ((status === 403 || status === 429) && (hasCloudflareHeader || hasCloudflareCookie) && markerMatch) {
    return { blocked: true, blockerKind: 'cloudflare' };
  }
  if ((status === 403 || status === 429) && hasCloudflareHeader) {
    return { blocked: true, blockerKind: 'cloudflare' };
  }
  if ((status === 403 || status === 429) && bodyPreview.includes('captcha')) {
    return { blocked: true, blockerKind: 'captcha' };
  }
  if ((status === 403 || status === 429) && markerMatch) {
    return { blocked: true, blockerKind: 'generic_interstitial' };
  }
  return { blocked: false, blockerKind: '' };
}

function collectResponseHeaders(headers) {
  const out = {};
  if (!headers || typeof headers.forEach !== 'function') return out;
  headers.forEach((value, key) => {
    out[String(key || '').toLowerCase()] = safeTrim(value);
  });
  return out;
}

function parseJsonLdBlocks(html = '') {
  const $ = load(html);
  const parsed = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).html() || '';
    const text = safeTrim(raw);
    if (!text) return;
    try {
      parsed.push(JSON.parse(text));
    } catch {}
  });
  return parsed;
}

function flattenJsonLdRecipes(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const item of node) flattenJsonLdRecipes(item, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  const typeValue = node['@type'];
  const types = Array.isArray(typeValue) ? typeValue.map((v) => safeTrim(v).toLowerCase()) : [safeTrim(typeValue).toLowerCase()];
  if (types.includes('recipe')) out.push(node);
  if (Array.isArray(node['@graph'])) flattenJsonLdRecipes(node['@graph'], out);
  return out;
}

function normalizeHowToStep(step) {
  if (typeof step === 'string') return step;
  if (!step || typeof step !== 'object') return '';
  return safeTrim(step.text || step.name || step.item || '');
}

function normalizeRecipeInstructions(value) {
  if (typeof value === 'string') {
    return normalizeList(
      value
        .split(/\n+|\.\s+(?=[A-Z])/)
        .map((item) => safeTrim(item))
        .filter(Boolean),
      32,
      320
    );
  }
  if (Array.isArray(value)) {
    const steps = [];
    for (const item of value) {
      if (item && typeof item === 'object' && Array.isArray(item.itemListElement)) {
        steps.push(...item.itemListElement.map(normalizeHowToStep));
      } else {
        steps.push(normalizeHowToStep(item));
      }
    }
    return normalizeList(steps, 32, 320);
  }
  if (value && typeof value === 'object' && Array.isArray(value.itemListElement)) {
    return normalizeList(value.itemListElement.map(normalizeHowToStep), 32, 320);
  }
  return [];
}

function extractRecipeFromJsonLd(html = '', sourceUrl = '') {
  const blocks = parseJsonLdBlocks(html);
  const recipes = flattenJsonLdRecipes(blocks, []);
  for (const recipe of recipes) {
    const ingredients = normalizeList(recipe.recipeIngredient || recipe.ingredients, 48, 240);
    const instructions = normalizeRecipeInstructions(recipe.recipeInstructions);
    if (ingredients.length < 3 || instructions.length < 2) continue;
    const notes = normalizeList(
      [
        recipe.recipeYield,
        recipe.prepTime,
        recipe.cookTime,
        recipe.totalTime,
        recipe.description,
      ],
      12,
      220
    );
    return {
      status: 'extracted',
      sourceTitle: safeTrim(recipe.name || recipe.headline || ''),
      sourceUrl: normalizeUrl(sourceUrl),
      recipeText: '',
      recipe: {
        title: safeTrim(recipe.name || recipe.headline || ''),
        summary: safeTrim(recipe.description || ''),
        recipeType: 'web_recipe',
        ingredients,
        instructions,
        notes,
        tags: normalizeList(recipe.keywords || [], 12, 60).map((item) => item.toLowerCase()),
        sourceTitle: safeTrim(recipe.name || recipe.headline || ''),
        sourceUrl: normalizeUrl(sourceUrl),
      },
    };
  }
  return null;
}

function collectSiblingSection($, headerEl) {
  const lines = [];
  let current = $(headerEl).next();
  while (current && current.length > 0) {
    const tag = safeTrim(current.get(0)?.tagName || '').toLowerCase();
    const text = safeTrim(current.text());
    if (/^h[1-6]$/.test(tag)) break;
    if (tag === 'ul' || tag === 'ol') {
      current.find('li').each((_, li) => {
        const line = safeTrim($(li).text());
        if (line) lines.push(line);
      });
    } else if (text) {
      if (tag === 'p' || tag === 'div') lines.push(...text.split('\n').map((line) => safeTrim(line)).filter(Boolean));
    }
    current = current.next();
  }
  return normalizeList(lines, 48, 320);
}

function extractRecipeFromSemanticHtml(html = '', sourceUrl = '') {
  const $ = load(html);
  const title =
    safeTrim($('h1').first().text()) ||
    safeTrim($('meta[property="og:title"]').attr('content')) ||
    safeTrim($('title').text());
  let ingredients = [];
  let instructions = [];
  let notes = [];
  $('h1,h2,h3,h4').each((_, el) => {
    const heading = safeTrim($(el).text()).toLowerCase();
    if (!ingredients.length && /^ingredients?$/.test(heading)) {
      ingredients = collectSiblingSection($, el);
    } else if (!instructions.length && /^(instructions?|directions?|method)$/.test(heading)) {
      instructions = collectSiblingSection($, el);
    } else if (!notes.length && /^(notes?|special equipment|tips)$/.test(heading)) {
      notes = collectSiblingSection($, el);
    }
  });
  if (ingredients.length < 3 || instructions.length < 2) return null;
  return {
    status: 'extracted',
    sourceTitle: title,
    sourceUrl: normalizeUrl(sourceUrl),
    recipeText: '',
    recipe: {
      title,
      summary: '',
      recipeType: 'web_recipe',
      ingredients,
      instructions,
      notes: normalizeList(notes, 16, 220),
      tags: normalizeList(
        title
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((item) => item.length >= 4),
        8,
        60
      ),
      sourceTitle: title,
      sourceUrl: normalizeUrl(sourceUrl),
    },
  };
}

export async function fetchRecipePage({
  url = '',
  deps = {},
}) {
  const sourceUrl = normalizeUrl(url);
  if (!sourceUrl) {
    return {
      status: 'invalid',
      error: 'I need a valid recipe URL before I can read it.',
      fetchPerformed: false,
      fetchSucceeded: false,
      sourceUrl: '',
      sourceKind: 'server_fetch',
    };
  }

  const fetchImpl = deps.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return {
      status: 'unavailable',
      error: 'I could not fetch recipe pages on the server right now.',
      fetchPerformed: false,
      fetchSucceeded: false,
      sourceUrl,
      sourceKind: 'server_fetch',
      failureReason: 'Server-side fetching is unavailable.',
    };
  }

  let fetchResult;
  try {
    fetchResult = await safeFetch(sourceUrl, {
      fetchImpl,
      lookup: deps.lookup,
      headers: {
        'user-agent': 'KitchenBot/1.0 (+recipe import)',
        accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
      },
      maxBytes: deps.maxFetchBytes || undefined,
      timeoutMs: deps.fetchTimeoutMs || undefined,
    });
  } catch (guardError) {
    // We refused before (or during) the network call because the URL resolved to a
    // private/internal address, used a bad scheme, or redirected somewhere it shouldn't.
    if (guardError instanceof SsrfError || guardError?.code === 'ssrf_blocked') {
      const refusedBeforeFetch = guardError.reason !== 'too_many_redirects';
      return {
        status: 'unavailable',
        error: 'That recipe link points to a private or internal network address, so I did not fetch it.',
        fetchPerformed: !refusedBeforeFetch,
        fetchSucceeded: false,
        fetchBlocked: false,
        blockerKind: '',
        failureKind: 'refused',
        sourceUrl,
        sourceKind: 'server_fetch',
        failureReason: safeTrim(guardError.message) || 'Refused to fetch a private or internal address.',
      };
    }
    // Any other error (timeout / DNS / socket) falls through to the generic handler below.
    return {
      status: 'unavailable',
      error: 'I could not fetch that linked recipe right now.',
      fetchPerformed: true,
      fetchSucceeded: false,
      fetchBlocked: false,
      blockerKind: '',
      failureKind: 'fetch_failed',
      sourceUrl,
      sourceKind: 'server_fetch',
      failureReason: safeTrim(guardError?.message) || 'The server-side fetch failed.',
    };
  }

  try {
    const { response, bodyText, finalUrl: resolvedFinalUrl } = fetchResult;
    const contentType = safeTrim(response.headers?.get?.('content-type') || '');
    const responseHeaders = collectResponseHeaders(response.headers);
    const finalUrl = normalizeUrl(resolvedFinalUrl || response.url || sourceUrl) || sourceUrl;
    const pageTitle = /html|xml/i.test(contentType)
      ? safeTrim(load(bodyText)('title').first().text()) || safeTrim(load(bodyText)('meta[property="og:title"]').attr('content'))
      : '';
    const textPreview = /html|xml/i.test(contentType) ? extractTextFromHtml(bodyText).slice(0, 120000) : bodyText.trim().slice(0, 120000);
    const blockClassification = looksLikeBotBlockPage({
      html: /html|xml/i.test(contentType) ? bodyText : '',
      text: textPreview,
      pageTitle,
      headers: responseHeaders,
      status: Number(response.status) || 0,
    });
    if (!response.ok) {
      const blockedFailureReason = blockClassification.blocked
        ? `The site blocked automated page access from our server${Number(response.status) ? ` with HTTP ${Number(response.status)}` : ''}.`
        : `The server fetch returned HTTP ${Number(response.status) || 0}.`;
      return {
        status: blockClassification.blocked ? 'blocked' : 'unavailable',
        error: 'I could not fetch that linked recipe right now.',
        fetchPerformed: true,
        fetchSucceeded: false,
        fetchBlocked: blockClassification.blocked,
        blockerKind: blockClassification.blockerKind,
        failureKind: blockClassification.blocked ? 'blocked' : 'fetch_failed',
        sourceUrl: finalUrl,
        finalUrl,
        httpStatus: Number(response.status) || 0,
        contentType,
        pageTitle,
        sourceKind: 'server_fetch',
        failureReason: blockedFailureReason,
      };
    }
    const pageText = textPreview;
    return {
      status: 'fetched',
      fetchPerformed: true,
      fetchSucceeded: true,
      fetchBlocked: false,
      blockerKind: '',
      failureKind: '',
      sourceUrl: finalUrl,
      finalUrl,
      fetchedExactUrl: finalUrl === sourceUrl,
      httpStatus: Number(response.status) || 200,
      contentType,
      pageTitle,
      html: /html|xml/i.test(contentType) ? bodyText.slice(0, 500000) : '',
      text: pageText.slice(0, 120000),
      sourceKind: 'server_fetch',
    };
  } catch (error) {
    return {
      status: 'unavailable',
      error: 'I could not fetch that linked recipe right now.',
      fetchPerformed: true,
      fetchSucceeded: false,
      fetchBlocked: false,
      blockerKind: '',
      failureKind: 'fetch_failed',
      sourceUrl,
      sourceKind: 'server_fetch',
      failureReason: safeTrim(error?.message) || 'The server-side fetch failed.',
    };
  }
}

export function extractRecipeFromPageContent({ sourceUrl = '', html = '', text = '' } = {}) {
  const normalizedUrl = normalizeUrl(sourceUrl);
  const jsonLdRecipe = html ? extractRecipeFromJsonLd(html, normalizedUrl) : null;
  if (jsonLdRecipe) return { ...jsonLdRecipe, extractionMethod: 'json_ld' };

  const semanticRecipe = html ? extractRecipeFromSemanticHtml(html, normalizedUrl) : null;
  if (semanticRecipe) return { ...semanticRecipe, extractionMethod: 'semantic_html' };

  const pageText = safeTrim(text);
  return {
    status: pageText ? 'needs_normalization' : 'not_recipe',
    sourceTitle: '',
    sourceUrl: normalizedUrl,
    recipeText: pageText,
    recipe: null,
    extractionMethod: pageText ? 'text_region' : 'none',
  };
}
