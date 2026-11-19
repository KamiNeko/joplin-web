import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildOcrSnippet,
  extractLinkedResourceIds,
  isEmptySearchQuery,
  matchesDateFilters,
  matchesNamePattern,
  normalizeOcrText,
  parseSearchQuery,
} from '../src/services/search-query.js';

/**
 * Offline tests for the search query parser.
 */

describe('parseSearchQuery', () => {
  test('splits words and lower-cases them', () => {
    const q = parseSearchQuery('  Shopping   LIST ');
    assert.deepEqual(q.terms, ['shopping', 'list']);
    assert.deepEqual(q.excludedTerms, []);
  });

  test('keeps quoted phrases together and normalises their whitespace', () => {
    assert.deepEqual(parseSearchQuery('"shopping  list" milk').terms, ['shopping list', 'milk']);
  });

  test('an unclosed quote runs to the end of the query', () => {
    assert.deepEqual(parseSearchQuery('milk "shopping list').terms, ['milk', 'shopping list']);
  });

  test('negated words and phrases', () => {
    const q = parseSearchQuery('milk -bread -"sour dough"');
    assert.deepEqual(q.terms, ['milk']);
    assert.deepEqual(q.excludedTerms, ['bread', 'sour dough']);
  });

  test('a lone dash and empty quotes are ignored; hyphenated words stay words', () => {
    assert.deepEqual(parseSearchQuery('a - b ""').terms, ['a', 'b']);
    assert.deepEqual(parseSearchQuery('e-mail').terms, ['e-mail']);
  });

  test('tag and notebook filters, with quoted values and case-insensitive names', () => {
    const q = parseSearchQuery('TAG:Work tag:"Two  Words" Notebook:"Reading List" -notebook:Archive -tag:old');
    assert.deepEqual(q.tags, ['work', 'two words']);
    assert.deepEqual(q.excludedTags, ['old']);
    assert.deepEqual(q.notebooks, ['reading list']);
    assert.deepEqual(q.excludedNotebooks, ['archive']);
    assert.deepEqual(q.terms, []);
  });

  test('type and iscompleted filters', () => {
    assert.equal(parseSearchQuery('type:todo').type, 'todo');
    assert.equal(parseSearchQuery('type:NOTE').type, 'note');
    assert.equal(parseSearchQuery('iscompleted:1').completed, true);
    assert.equal(parseSearchQuery('iscompleted:0').completed, false);
  });

  test('invalid filter values and unknown filters are plain words', () => {
    const q = parseSearchQuery('type:x iscompleted:yes foo:bar https://example.com tag:');
    assert.equal(q.type, undefined);
    assert.equal(q.completed, undefined);
    assert.deepEqual(q.terms, ['type:x', 'iscompleted:yes', 'foo:bar', 'https://example.com', 'tag:']);
  });

  test('a query of only filters is not empty; whitespace is', () => {
    assert.equal(isEmptySearchQuery(parseSearchQuery('tag:work')), false);
    assert.equal(isEmptySearchQuery(parseSearchQuery('iscompleted:0')), false);
    assert.equal(isEmptySearchQuery(parseSearchQuery('   ')), true);
    assert.equal(isEmptySearchQuery(parseSearchQuery('"" -')), true);
  });
});

describe('matchesNamePattern', () => {
  test('matches whole names case-insensitively', () => {
    assert.equal(matchesNamePattern('Reading List', 'reading list'), true);
    assert.equal(matchesNamePattern('Reading List', 'reading'), false);
  });

  test('supports * wildcards and escapes regex characters', () => {
    assert.equal(matchesNamePattern('Project Alpha', 'project*'), true);
    assert.equal(matchesNamePattern('a.b', 'a.b'), true);
    assert.equal(matchesNamePattern('axb', 'a.b'), false);
    assert.equal(matchesNamePattern('C++ (notes)', 'c++*'), true);
    assert.equal(matchesNamePattern('afoobbarc', 'a***b*c'), true);
    assert.equal(matchesNamePattern('abc', '*abc*'), true);
    assert.equal(matchesNamePattern('ab', 'abc*'), false);
  });

  test('handles repeated wildcards on mismatched long titles without backtracking (no ReDoS)', () => {
    const startedAt = Date.now();
    const result = matchesNamePattern(`${'a'.repeat(500)}c`, `${'a*'.repeat(60)}b`);
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result, false);
    assert.ok(elapsedMs < 200, `Expected linear/polynomial wildcard match, took ${elapsedMs}ms`);
  });
});

describe('extractLinkedResourceIds', () => {
  const idA = '0123456789abcdef0123456789abcdef';
  const idB = 'fedcba9876543210fedcba9876543210';

  test('extracts unique ids in link order from Markdown and HTML', () => {
    const body = [
      `See [scan](:/${idA.toUpperCase()} "Scan") and <img src=":/${idB}" alt="Receipt">.`,
      `Repeated [again](:/${idA}#page=2) and <a href=':/${idB}'>link</a>.`,
    ].join('\n');
    assert.deepEqual(extractLinkedResourceIds(body), [idA, idB]);
  });

  test('ignores malformed ids, longer hex strings and regular URLs', () => {
    const body = `https://example.com/${idA} :/${idA}f :/short [x](:/${idB})`;
    assert.deepEqual(extractLinkedResourceIds(body), [idB]);
    assert.deepEqual(extractLinkedResourceIds('Plain note without resource links'), []);
  });
});

describe('OCR normalization and snippets', () => {
  test('collapses wrapped lines into single spaces', () => {
    assert.equal(normalizeOcrText('  ACME\r\n  Hardware\n\n  Total:   $42.00 \n'), 'ACME Hardware Total: $42.00');
  });

  test('cuts a clean snippet around the earliest match and snaps word boundaries', () => {
    const text = `${'prefixword '.repeat(12)}Dedicated Backup Storage Renewal ${'suffixword '.repeat(12)}`;
    const snippet = buildOcrSnippet(normalizeOcrText(text), ['renewal', 'backup']);
    assert.ok(snippet);
    assert.ok(snippet.startsWith('...'));
    assert.ok(snippet.endsWith('...'));
    assert.ok(snippet.includes('Backup Storage Renewal'));
    assert.equal(buildOcrSnippet('Nothing here', ['invoice']), null);
  });

  test('tag:none, has:attachment, has:ocr, sourceurl, created and updated filters', () => {
    const fixedNow = Date.UTC(2026, 4, 15, 12, 0, 0);
    const q = parseSearchQuery(
      'tag:none has:attachment -has:ocr sourceurl:github.com -sourceurl:gist.github.com created:>=2026-01-01 updated:today',
      fixedNow
    );
    assert.equal(q.tagNone, true);
    assert.equal(q.hasAttachment, true);
    assert.equal(q.hasOcr, false);
    assert.deepEqual(q.sourceUrls, ['github.com']);
    assert.deepEqual(q.excludedSourceUrls, ['gist.github.com']);
    assert.equal(q.createdFilters.length, 1);
    assert.equal(q.updatedFilters.length, 1);
    assert.equal(isEmptySearchQuery(q), false);

    assert.equal(matchesDateFilters(Date.UTC(2026, 4, 15, 9, 0, 0), q.updatedFilters), true);
    assert.equal(matchesDateFilters(Date.UTC(2026, 4, 14, 9, 0, 0), q.updatedFilters), false);
    assert.equal(matchesDateFilters(Date.UTC(2026, 2, 1, 0, 0, 0), q.createdFilters), true);
    assert.equal(matchesDateFilters(Date.UTC(2025, 11, 31, 23, 59, 59), q.createdFilters), false);
  });

  test('negated tag:none and week/month date specs', () => {
    const fixedNow = Date.UTC(2026, 4, 15, 12, 0, 0);
    const q = parseSearchQuery('-tag:none created:week-1 -updated:2026-04', fixedNow);
    assert.equal(q.tagNone, false);
    assert.equal(q.createdFilters.length, 1);
    assert.equal(q.updatedFilters.length, 1);
    assert.equal(q.updatedFilters[0].negated, true);
    assert.equal(matchesDateFilters(Date.UTC(2026, 4, 10, 0, 0, 0), q.createdFilters), true);
    assert.equal(matchesDateFilters(Date.UTC(2026, 3, 15, 0, 0, 0), q.updatedFilters), false);
    assert.equal(matchesDateFilters(Date.UTC(2026, 4, 15, 0, 0, 0), q.updatedFilters), true);
  });
});
