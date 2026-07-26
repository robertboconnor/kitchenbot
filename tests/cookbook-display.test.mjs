// The cookbook display + search helpers were unreachable by tests while they lived inside a
// 4,600-line global-scope app.js — nothing could import them. Extracting them into
// public/modules/cookbook-display.js makes their BEHAVIOUR testable for the first time (the old
// tests could only regex the source text for "function X(" and hope).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCookbookSearchFields,
  getCookbookDisplayProvenance,
  getCookbookDisplaySource,
  getCookbookDisplayTitle,
  normalizeCookbookSearchText,
  sanitizeCookbookDisplayTitle,
  scoreCookbookSearchMatch,
  splitCookbookEditorLines,
  tokenizeCookbookSearch,
} from '../public/modules/cookbook-display.js';

test('cookbook titles strip assistant framing and markdown wrappers', () => {
  assert.equal(getCookbookDisplayTitle({ title: 'Toum' }), 'Toum');
  // The brain sometimes saves a title carrying its own conversational preamble.
  assert.equal(sanitizeCookbookDisplayTitle("Here's the full recipe for Toum"), 'Toum');
  assert.equal(sanitizeCookbookDisplayTitle('Recipe for Cacio e Pepe'), 'Cacio e Pepe');
  assert.equal(sanitizeCookbookDisplayTitle('**Bolognese**'), 'Bolognese');
});

test('a blank or placeholder title falls back rather than rendering empty', () => {
  const title = getCookbookDisplayTitle({ title: '' });
  assert.ok(title && title.trim().length > 0, 'must not render an empty card title');
});

test('search tokenizing and normalization are case/punctuation insensitive', () => {
  assert.equal(normalizeCookbookSearchText('Cacio e PEPE!'), normalizeCookbookSearchText('cacio e pepe'));
  const tokens = tokenizeCookbookSearch('  garlic   TOUM  ');
  assert.deepEqual(tokens, ['garlic', 'toum']);
  assert.deepEqual(tokenizeCookbookSearch(''), []);
});

test('search ranks a title match above an incidental ingredient match', () => {
  // Signature is (entry, rawQueryString) — it tokenizes and builds the field set internally.
  const titleMatch = {
    title: 'Garlic Toum',
    summary: 'A fluffy Lebanese garlic sauce.',
    ingredients: ['garlic', 'lemon juice'],
    tags: ['sauce'],
  };
  const ingredientOnly = {
    title: 'Roast Chicken',
    summary: 'Weeknight bird.',
    ingredients: ['chicken', 'garlic'],
    tags: [],
  };
  const strong = scoreCookbookSearchMatch(titleMatch, 'garlic');
  const weak = scoreCookbookSearchMatch(ingredientOnly, 'garlic');
  assert.ok(strong > 0, 'the title match should score');
  assert.ok(weak > 0, 'the ingredient match should still score');
  assert.ok(strong > weak, `a title hit (${strong}) must outrank an ingredient-only hit (${weak})`);
});

test('a non-matching query returns the -1 exclude sentinel, and an empty query scores 0', () => {
  // -1 (not 0) is the "drop this row" signal callers filter on; 0 means "no query, keep all".
  const entry = { title: 'Toum', ingredients: ['garlic'], tags: [] };
  assert.equal(scoreCookbookSearchMatch(entry, 'tiramisu'), -1);
  assert.equal(scoreCookbookSearchMatch(entry, ''), 0);
  // ALL tokens must be present — a partial match is still excluded.
  assert.equal(scoreCookbookSearchMatch(entry, 'garlic tiramisu'), -1);
});

test('buildCookbookSearchFields tolerates missing collections', () => {
  const fields = buildCookbookSearchFields({ title: 'Toum' });
  assert.ok(Array.isArray(fields.tags) && Array.isArray(fields.ingredients));
  assert.deepEqual(buildCookbookSearchFields({}).tags, []);
});

test('editor line splitting drops blanks and tolerates mixed newlines', () => {
  assert.deepEqual(splitCookbookEditorLines('a\n\nb\r\nc\n  \n'), ['a', 'b', 'c']);
  assert.deepEqual(splitCookbookEditorLines(''), []);
});

test('display helpers never throw on malformed or partial records', () => {
  // These render user-facing cards; a missing field must degrade, not crash the whole list.
  for (const entry of [{}, { title: null }, { sourceUrl: 'not a url' }, { tags: null }]) {
    assert.doesNotThrow(() => getCookbookDisplayTitle(entry));
    assert.doesNotThrow(() => getCookbookDisplaySource(entry));
    assert.doesNotThrow(() => getCookbookDisplayProvenance(entry));
  }
});
