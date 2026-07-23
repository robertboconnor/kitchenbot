import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRecipePage, extractRecipeFromPageContent } from '../recipe-url-ingestion.mjs';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

test('fetchRecipePage refuses a private/internal URL without hitting the network', async () => {
  let fetchCalls = 0;
  const spyFetch = async () => {
    fetchCalls += 1;
    return { ok: true, status: 200, headers: new Headers(), text: async () => '<html></html>' };
  };
  const result = await fetchRecipePage({
    url: 'http://169.254.169.254/latest/meta-data/',
    deps: { fetch: spyFetch },
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.failureKind, 'refused');
  assert.equal(result.fetchPerformed, false);
  assert.equal(result.fetchSucceeded, false);
  assert.equal(fetchCalls, 0, 'must not perform the network fetch for a private address');
  assert.match(result.error, /private or internal/i);
});

test('fetchRecipePage refuses a link that redirects to an internal address', async () => {
  let hop = 0;
  const spyFetch = async (url) => {
    hop += 1;
    if (hop === 1) {
      return { status: 302, headers: new Headers({ location: 'http://127.0.0.1:6379/' }), text: async () => '' };
    }
    return { ok: true, status: 200, url, headers: new Headers(), text: async () => 'SHOULD NOT REACH' };
  };
  const result = await fetchRecipePage({
    url: 'https://recipes.example.com/start',
    deps: { fetch: spyFetch, lookup: publicLookup },
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.failureKind, 'refused');
  assert.equal(hop, 1, 'stops before fetching the internal redirect target');
});

test('fetchRecipePage fetches a public page and extractRecipeFromPageContent parses JSON-LD', async () => {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Recipe',
    name: 'Lemon Herb Roast Chicken',
    description: 'A bright weeknight roast.',
    recipeIngredient: ['1 whole chicken', '2 lemons', '3 sprigs thyme', 'olive oil', 'salt'],
    recipeInstructions: [
      { '@type': 'HowToStep', text: 'Heat the oven to 425F.' },
      { '@type': 'HowToStep', text: 'Season the chicken.' },
      { '@type': 'HowToStep', text: 'Roast for one hour.' },
    ],
  };
  const html = `<html><head><title>Lemon Herb Roast Chicken</title>
    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head>
    <body><h1>Lemon Herb Roast Chicken</h1></body></html>`;
  const spyFetch = async (url) => ({
    ok: true,
    status: 200,
    url,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    text: async () => html,
  });
  const result = await fetchRecipePage({
    url: 'https://recipes.example.com/lemon-herb-roast-chicken',
    deps: { fetch: spyFetch, lookup: publicLookup },
  });
  assert.equal(result.status, 'fetched');
  assert.equal(result.fetchSucceeded, true);
  assert.ok(result.html.includes('Lemon Herb Roast Chicken'));

  const extracted = extractRecipeFromPageContent({
    sourceUrl: result.finalUrl,
    html: result.html,
    text: result.text,
  });
  assert.equal(extracted.status, 'extracted');
  assert.equal(extracted.extractionMethod, 'json_ld');
  assert.equal(extracted.recipe.title, 'Lemon Herb Roast Chicken');
  assert.ok(extracted.recipe.ingredients.length >= 5);
  assert.ok(extracted.recipe.instructions.length >= 3);
});

test('fetchRecipePage rejects a non-HTTP scheme', async () => {
  const result = await fetchRecipePage({ url: 'file:///etc/passwd', deps: {} });
  // normalizeUrl strips non-http(s) up front, so this reads as an invalid URL.
  assert.equal(result.status, 'invalid');
});
