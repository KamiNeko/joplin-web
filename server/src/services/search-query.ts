/**
 * Parser for the search syntax (a subset of Joplin desktop's):
 *
 * - `shopping list`: every word must appear in the title or body (any order, case-insensitive)
 * - `"shopping list"`: an exact phrase
 * - `-word`, `-"some phrase"`: the note must not contain it
 * - `tag:name`, `tag:"two words"`: the note has this tag (several `tag:` filters must all match)
 * - `notebook:name`: the note is in a notebook with this title or in one of its sub-notebooks
 *   (several `notebook:` filters match any of them)
 * - `type:todo` / `type:note`, `iscompleted:1` / `iscompleted:0` (to-dos only)
 * - `-tag:`/`-notebook:` exclude; `*` in a tag or notebook name is a wildcard
 *
 * Unknown filters (`foo:bar`) and invalid values (`type:x`) are searched as plain words.
 */

/** A parsed search query; all text values are lower-cased */
export interface ParsedSearchQuery {
  /** Words and phrases that must all appear in the title or body */
  terms: string[];
  /** Words and phrases that must not appear in the title or body */
  excludedTerms: string[];
  /** Tag title patterns that must all be present */
  tags: string[];
  /** Tag title patterns that must not be present */
  excludedTags: string[];
  /** Notebook title patterns; the note must be inside one of them */
  notebooks: string[];
  /** Notebook title patterns the note must not be inside */
  excludedNotebooks: string[];
  type?: 'todo' | 'note';
  /** Set by `iscompleted:`; implies to-dos */
  completed?: boolean;
}

interface Token {
  text: string;
  negated: boolean;
  /** Filter name when the token was `name:value` with a known filter name */
  filter?: string;
  /** Whether the text (or the filter value) was quoted */
  quoted: boolean;
}

const FILTERS = new Set(['tag', 'notebook', 'type', 'iscompleted']);

/** Splits a query into tokens, honouring double quotes (an unclosed quote runs to the end) */
function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = query.length;

  while (i < n) {
    while (i < n && /\s/.test(query[i])) i++;
    if (i >= n) break;

    let negated = false;
    if (query[i] === '-' && i + 1 < n && !/\s/.test(query[i + 1])) {
      negated = true;
      i++;
    }

    let filter: string | undefined;
    const filterMatch = /^([a-z]+):(?=\S)/i.exec(query.slice(i));
    if (filterMatch && FILTERS.has(filterMatch[1].toLowerCase())) {
      filter = filterMatch[1].toLowerCase();
      i += filterMatch[0].length;
    }

    let text = '';
    let quoted = false;
    if (query[i] === '"') {
      quoted = true;
      const close = query.indexOf('"', i + 1);
      const end = close === -1 ? n : close;
      text = query.slice(i + 1, end);
      i = close === -1 ? n : close + 1;
    } else {
      const start = i;
      while (i < n && !/\s/.test(query[i])) i++;
      text = query.slice(start, i);
    }

    // Collapse inner whitespace so a phrase matches regardless of how it was typed
    text = text.trim().replace(/\s+/g, ' ');
    // A lone "-" (e.g. "a - b") is punctuation, not a term
    if (!quoted && !filter && text === '-') continue;
    if (text) tokens.push({ text, negated, filter, quoted });
  }

  return tokens;
}

/**
 * Parses a search query into terms and filters (see the module comment for the syntax).
 *
 * @param query Raw query as typed by the user
 * @returns The parsed query; `isEmptySearchQuery` tells whether it has nothing to search for
 */
export function parseSearchQuery(query: string): ParsedSearchQuery {
  const parsed: ParsedSearchQuery = {
    terms: [],
    excludedTerms: [],
    tags: [],
    excludedTags: [],
    notebooks: [],
    excludedNotebooks: [],
  };

  const addTerm = (token: Token, text: string) => {
    (token.negated ? parsed.excludedTerms : parsed.terms).push(text);
  };

  for (const token of tokenize(query)) {
    const value = token.text.toLowerCase();
    switch (token.filter) {
      case 'tag':
        (token.negated ? parsed.excludedTags : parsed.tags).push(value);
        break;
      case 'notebook':
        (token.negated ? parsed.excludedNotebooks : parsed.notebooks).push(value);
        break;
      case 'type':
        if (!token.negated && (value === 'todo' || value === 'note')) parsed.type = value;
        else addTerm(token, `type:${value}`);
        break;
      case 'iscompleted':
        if (!token.negated && (value === '1' || value === '0')) parsed.completed = value === '1';
        else addTerm(token, `iscompleted:${value}`);
        break;
      default:
        addTerm(token, value);
    }
  }

  return parsed;
}

/** Whether a parsed query has no terms and no filters (searching it would match everything) */
export function isEmptySearchQuery(q: ParsedSearchQuery): boolean {
  return (
    q.terms.length === 0 &&
    q.excludedTerms.length === 0 &&
    q.tags.length === 0 &&
    q.excludedTags.length === 0 &&
    q.notebooks.length === 0 &&
    q.excludedNotebooks.length === 0 &&
    q.type === undefined &&
    q.completed === undefined
  );
}

/**
 * Whether a title matches a lower-cased `tag:`/`notebook:` pattern: case-insensitive and whole,
 * with `*` matching any run of characters.
 */
export function matchesNamePattern(title: string, pattern: string): boolean {
  const lower = title.toLowerCase();
  if (!pattern.includes('*')) return lower === pattern;
  const regex = new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
    's'
  );
  return regex.test(lower);
}
