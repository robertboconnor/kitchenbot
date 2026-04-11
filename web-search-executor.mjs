import { getMessages } from './db.mjs';
import { createLoggedAnthropicMessage, detectAnthropicWebSearchUsage } from './anthropic-usage.mjs';
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

export async function executeWebSearch(runtimeAction, context) {
  const {
    req,
    chatId,
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
        tool_choice: {
          type: 'tool',
          name: 'web_search',
          disable_parallel_tool_use: true,
        },
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
