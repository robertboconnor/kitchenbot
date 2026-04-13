import { getMessages } from './db.mjs';
import {
  createLoggedAnthropicMessage,
  detectAnthropicWebFetchUsage,
  detectAnthropicWebSearchUsage,
} from './anthropic-usage.mjs';
import { resolveAnthropicModelForCallPurpose } from './anthropic-model-policy.mjs';
import { buildKbContextSystemText, formatKbRecentConversation } from './kb-prompt-context.mjs';

function safeTrim(text) {
  return String(text ?? '').trim();
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

function normalizeSource(source) {
  if (!source || typeof source !== 'object') return null;
  const title = safeTrim(source.title).slice(0, 240);
  const url = safeTrim(source.url).slice(0, 800);
  const pageAge = safeTrim(source.page_age || source.pageAge).slice(0, 120);
  if (!title && !url) return null;
  return {
    title: title || url,
    url: url || '',
    pageAge: pageAge || '',
  };
}

function extractWebSearchSources(response) {
  const sources = [];
  for (const block of Array.isArray(response?.content) ? response.content : []) {
    if (String(block?.type ?? '').trim() !== 'web_search_tool_result') continue;
    const content = Array.isArray(block?.content) ? block.content : [];
    for (const entry of content) {
      const normalized = normalizeSource(entry);
      if (normalized) sources.push(normalized);
    }
  }
  return sources.slice(0, 8);
}

function extractWebSearchQuery(response, fallbackQuery = '') {
  for (const block of Array.isArray(response?.content) ? response.content : []) {
    if (String(block?.type ?? '').trim() !== 'server_tool_use') continue;
    if (String(block?.name ?? '').trim() !== 'web_search') continue;
    const query = safeTrim(block?.input?.query || block?.input?.search_query);
    if (query) return query;
  }
  return safeTrim(fallbackQuery);
}

function extractWebFetchUrl(response, fallbackUrl = '') {
  for (const block of Array.isArray(response?.content) ? response.content : []) {
    if (String(block?.type ?? '').trim() !== 'server_tool_use') continue;
    if (String(block?.name ?? '').trim() !== 'web_fetch') continue;
    const url = safeTrim(block?.input?.url);
    if (url) return url;
  }
  return safeTrim(fallbackUrl);
}

function normalizeRecipeItemList(values, limit = 24, maxLength = 220) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = safeTrim(
      typeof value === 'string'
        ? value
        : value && typeof value === 'object'
          ? value.text || value.name || value.step || value.summary
          : ''
    )
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

function normalizeRecipeTagList(values, limit = 12, maxLength = 60) {
  return normalizeRecipeItemList(values, limit, maxLength).map((value) => value.toLowerCase());
}

function extractWebFetchPageText(response) {
  const lines = [];
  for (const block of Array.isArray(response?.content) ? response.content : []) {
    if (String(block?.type ?? '').trim() !== 'web_fetch_tool_result') continue;
    for (const entry of Array.isArray(block?.content) ? block.content : []) {
      const content = safeTrim(entry?.content || entry?.text || entry?.markdown || entry?.body);
      if (content) lines.push(content);
    }
  }
  return lines.join('\n\n').trim();
}

function normalizeFetchedPagePayload(raw, sourceUrl = '') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const sourceTitle = safeTrim(raw.sourceTitle || raw.title).replace(/\s+/g, ' ').slice(0, 160);
  const pageText = safeTrim(raw.pageText || raw.content || raw.pageContent).slice(0, 24000);
  const normalizedSourceUrl = /^https?:\/\//i.test(safeTrim(raw.sourceUrl || sourceUrl)) ? safeTrim(raw.sourceUrl || sourceUrl).slice(0, 1000) : '';
  if (!pageText) return null;
  return {
    sourceTitle,
    sourceUrl: normalizedSourceUrl,
    pageText,
  };
}

export async function executeWebSearch(runtimeAction, context) {
  const {
    req,
    chatId,
    turnId = '',
    prompt,
    anthropic,
    memoryContext = null,
    deps = {},
  } = context;

  const webSearchEnabled =
    !!memoryContext?.capabilities?.webSearchEnabled ||
    !!context?.webSearchEnabled ||
    !!req?.kbCapabilities?.webSearchEnabled;

  if (!webSearchEnabled) {
    return {
      capability: 'web.search',
      status: 'disabled',
      query: safeTrim(runtimeAction?.input?.query || prompt),
      error: 'Live web search is not enabled for this household.',
    };
  }

  if (!anthropic) {
    return {
      capability: 'web.search',
      status: 'unavailable',
      query: safeTrim(runtimeAction?.input?.query || prompt),
      error: 'I could not access live web search right now.',
    };
  }

  const requestedQuery = safeTrim(runtimeAction?.input?.query || prompt);
  if (!requestedQuery) {
    return {
      capability: 'web.search',
      status: 'invalid',
      error: 'I need a search topic before I can look something up.',
    };
  }

  const conversation = await getMessages(chatId, req.householdId);
  const recentConversation =
    formatKbRecentConversation(conversation, deps, {
      limit: 10,
      assistantPersona: memoryContext?.assistantPersona,
    }) || '(none)';

  try {
    const response = await createLoggedAnthropicMessage(
      anthropic,
      {
        model: resolveAnthropicModelForCallPurpose('web_search'),
        max_tokens: 500,
        system: `${buildKbContextSystemText(memoryContext)}

You are KitchenBot's live web research helper.

Rules:
- Use the web search tool for this request unless the tool is unavailable.
- After searching, return ONLY JSON.
- Shape:
  {"status":"searched|no_results|unavailable","summary":"...","howToUse":"..."}
- summary should be a concise factual summary of what the search found.
- howToUse should say how the findings matter for the user's actual request when that is useful.
- Do not output raw tool syntax.
- Do not claim you searched if the tool was unavailable.`,
        tools: [
          {
            name: 'web_search',
            type: 'web_search_20260209',
            max_uses: 3,
          },
        ],
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              latestUserPrompt: prompt,
              searchRequest: requestedQuery,
              recentConversation,
            }),
          },
        ],
      },
      {
        householdId: req.householdId,
        chatId,
        turnId,
        prompt,
        actionCapability: 'web.search',
        actionQuery: requestedQuery,
        runtimeEnabled: true,
        callSurface: 'kb_action',
        callPurpose: 'web_search',
        webSearchEnabledAtCall: true,
      }
    );

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    const parsed = parseJsonObject(text);
    const usedWebSearchTool = detectAnthropicWebSearchUsage(response);
    const query = extractWebSearchQuery(response, requestedQuery);
    const sources = extractWebSearchSources(response);

    if (!usedWebSearchTool) {
      return {
        capability: 'web.search',
        status: 'unavailable',
        query,
        error: 'I could not complete a live web search right now.',
      };
    }

    const status = safeTrim(parsed?.status) || (sources.length > 0 ? 'searched' : 'no_results');
    const summary = safeTrim(parsed?.summary || text).slice(0, 2000);
    const howToUse = safeTrim(parsed?.howToUse || parsed?.suggestedUse).slice(0, 1200);

    return {
      capability: 'web.search',
      status: status === 'unavailable' ? 'unavailable' : status === 'no_results' ? 'no_results' : 'searched',
      query,
      summary,
      howToUse,
      sources,
      usedWebSearchTool,
    };
  } catch (error) {
    console.error('Web search execution failed:', error?.message || error);
    return {
      capability: 'web.search',
      status: 'unavailable',
      query: requestedQuery,
      error: 'I could not complete a live web search right now.',
    };
  }
}

export async function fetchRecipeFromUrl({
  anthropic,
  householdId,
  chatId,
  turnId = '',
  prompt = '',
  url = '',
  preferredTitle = '',
  memoryContext = null,
  deps = {},
}) {
  const sourceUrl = safeTrim(url);
  if (!/^https?:\/\//i.test(sourceUrl)) {
    return {
      status: 'invalid',
      error: 'I need a valid recipe URL before I can read it.',
      sourceUrl: sourceUrl || '',
      fetchPerformed: false,
    };
  }

  const webSearchEnabled = !!memoryContext?.capabilities?.webSearchEnabled;
  if (!webSearchEnabled) {
    return {
      status: 'disabled',
      error: 'I could not read that linked recipe because live web search is disabled for this household.',
      sourceUrl,
      fetchPerformed: false,
    };
  }

  if (!anthropic) {
    return {
      status: 'unavailable',
      error: 'I could not access live web search right now.',
      sourceUrl,
      fetchPerformed: false,
    };
  }

  const conversation = chatId && householdId
    ? await getMessages(chatId, householdId)
    : [];
  const recentConversation =
    formatKbRecentConversation(conversation, deps, {
      limit: 10,
      assistantPersona: memoryContext?.assistantPersona,
    }) || '(none)';

  try {
    const response = await createLoggedAnthropicMessage(
      anthropic,
      {
        model: resolveAnthropicModelForCallPurpose('web_search'),
        max_tokens: 800,
        system: `${buildKbContextSystemText(memoryContext)}

You are KitchenBot's linked recipe reader.

Rules:
- Use the web fetch tool to read the exact recipe URL the user linked.
- Return ONLY JSON.
- Shape:
  {"status":"fetched|no_results|unavailable","sourceTitle":"...","sourceUrl":"...","pageText":"..."}
- sourceTitle should be the fetched recipe/page title when available.
- sourceUrl should be the linked recipe URL.
- pageText should be the most relevant fetched page content for recipe extraction, as plain text or markdown.
- Do not try to fully normalize the recipe into ingredients/instructions here.
- If you cannot actually read enough page content, return status no_results or unavailable instead of inventing content.
- Never use general recipe knowledge or search snippets as a substitute for the linked page.
- Never claim you fetched the page unless the web fetch tool actually ran on the linked URL.`,
        tools: [
          {
            name: 'web_fetch',
            type: 'web_fetch_20250910',
            max_uses: 2,
          },
        ],
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              latestUserPrompt: prompt,
              recipeUrl: sourceUrl,
              preferredSavedTitle: safeTrim(preferredTitle),
              recentConversation,
            }),
          },
        ],
      },
      {
        householdId,
        chatId,
        turnId,
        prompt,
        actionCapability: 'cookbook.save',
        actionQuery: sourceUrl,
        runtimeEnabled: true,
        callSurface: 'kb_action',
        callPurpose: 'web_fetch',
        webSearchEnabledAtCall: true,
      }
    );

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    const parsed = parseJsonObject(text);
    const fetchPerformed = detectAnthropicWebFetchUsage(response);
    const fetchedUrl = extractWebFetchUrl(response, sourceUrl);
    if (!fetchPerformed) {
      return {
        status: 'unavailable',
        error: 'I could not read that linked recipe right now.',
        sourceUrl,
        fetchPerformed: false,
        fetchedExactUrl: false,
        sourceKind: 'web_fetch',
        failureReason: 'The exact linked page was not fetched.',
      };
    }

    const normalized = normalizeFetchedPagePayload(parsed, sourceUrl) || {
      sourceTitle: safeTrim(parsed?.sourceTitle || parsed?.title),
      sourceUrl,
      pageText: extractWebFetchPageText(response),
    };
    if (!safeTrim(normalized.pageText)) {
      return {
        status: safeTrim(parsed?.status) === 'no_results' ? 'no_results' : 'unavailable',
        error: 'I fetched the link, but I could not recover enough page content from it.',
        sourceUrl,
        fetchPerformed: true,
        fetchedExactUrl: fetchedUrl === sourceUrl,
        sourceKind: 'web_fetch',
        fetchSucceeded: true,
        failureReason: 'The linked page was fetched, but it did not yield enough page content for recipe extraction.',
      };
    }

    return {
      status: 'fetched',
      sourceTitle: normalized.sourceTitle,
      sourceUrl: normalized.sourceUrl || sourceUrl,
      pageText: normalized.pageText,
      fetchPerformed: true,
      fetchedExactUrl: fetchedUrl === sourceUrl,
      fetchSucceeded: true,
      sourceKind: 'web_fetch',
    };
  } catch (error) {
    console.error('Recipe fetch failed:', error?.message || error);
    return {
      status: 'unavailable',
      error: 'I could not read that linked recipe right now.',
      sourceUrl,
      fetchPerformed: false,
      fetchedExactUrl: false,
      fetchSucceeded: false,
      sourceKind: 'web_fetch',
      failureReason: 'The exact linked page could not be fetched.',
    };
  }
}
