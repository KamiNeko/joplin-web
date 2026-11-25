/**
 * Parser for the search syntax (a subset of Joplin desktop's):
 *
 * - `shopping list`: every word must appear in the title, body or linked attachments' OCR text (any order, case-insensitive)
 * - `"shopping list"`: an exact phrase
 * - `-word`, `-"some phrase"`: the note (including linked attachment OCR) must not contain it
 * - `tag:name`, `tag:"two words"`: the note has this tag (several `tag:` filters must all match)
 * - `notebook:name`: the note is in a notebook with this title or in one of its sub-notebooks
 *   (several `notebook:` filters match any of them)
 * - `type:todo` / `type:note`, `iscompleted:1` / `iscompleted:0` (to-dos only)
 * - `-tag:`/`-notebook:` exclude; `*` in a tag or notebook name is a wildcard
 * - `has:attachment` / `-has:attachment`, `has:ocr` / `-has:ocr`, `tag:none` / `-tag:none`
 * - `sourceurl:<pattern>` / `-sourceurl:<pattern>`
 * - `created:<spec>` / `-created:<spec>`, `updated:<spec>` / `-updated:<spec>` (e.g. `today`, `7d`, `week`, `month`, `2026-05`, `>=2026-01-01`)
 *
 * Unknown filters (`foo:bar`) and invalid values (`type:x`) are searched as plain words.
 */

export interface DateFilterClause {
  negated: boolean;
  start: number;
  end: number;
}

/** A parsed search query; all text values are lower-cased */
export interface ParsedSearchQuery {
  /** Words and phrases that must all appear in the title, body or linked attachments' OCR text */
  terms: string[];
  /** Words and phrases that must not appear in the title, body or linked attachments' OCR text */
  excludedTerms: string[];
  /** Tag title patterns that must all be present */
  tags: string[];
  /** Tag title patterns that must not be present */
  excludedTags: string[];
  /** Set by `tag:none` (true = untagged only) or `-tag:none` (false = must have at least one tag) */
  tagNone?: boolean;
  /** Notebook title patterns; the note must be inside one of them */
  notebooks: string[];
  /** Notebook title patterns the note must not be inside */
  excludedNotebooks: string[];
  type?: 'todo' | 'note';
  /** Set by `iscompleted:`; implies to-dos */
  completed?: boolean;
  /** Set by `has:attachment` / `-has:attachment` */
  hasAttachment?: boolean;
  /** Set by `has:ocr` / `-has:ocr` */
  hasOcr?: boolean;
  /** `source_url` patterns that must match (wildcard or substring) */
  sourceUrls: string[];
  /** `source_url` patterns that must not match */
  excludedSourceUrls: string[];
  /** `createdTime` constraints */
  createdFilters: DateFilterClause[];
  /** `updatedTime` constraints */
  updatedFilters: DateFilterClause[];
}

interface Token {
  text: string;
  negated: boolean;
  /** Filter name when the token was `name:value` with a known filter name */
  filter?: string;
  /** Whether the text (or the filter value) was quoted */
  quoted: boolean;
}

const FILTERS = new Set([
  'tag',
  'notebook',
  'type',
  'iscompleted',
  'has',
  'sourceurl',
  'created',
  'updated',
]);

function parseDayBounds(yyyyMmDd: string): { start: number; end: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyyMmDd);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }
  return {
    start: Date.UTC(year, month - 1, day, 0, 0, 0, 0),
    end: Date.UTC(year, month - 1, day, 23, 59, 59, 999),
  };
}

function parseMonthBounds(yyyyMm: string): { start: number; end: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(yyyyMm);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return {
    start: Date.UTC(year, month - 1, 1, 0, 0, 0, 0),
    end: Date.UTC(year, month, 0, 23, 59, 59, 999),
  };
}

function parseYearBounds(yyyy: string): { start: number; end: number } | null {
  if (!/^\d{4}$/.test(yyyy)) return null;
  const year = Number(yyyy);
  if (year < 1970 || year > 2999) return null;
  return {
    start: Date.UTC(year, 0, 1, 0, 0, 0, 0),
    end: Date.UTC(year, 11, 31, 23, 59, 59, 999),
  };
}

function parseDateSpecBounds(rawValue: string, now: number): { start: number; end: number } | null {
  const val = rawValue.trim().toLowerCase();
  if (!val) return null;

  if (val === 'today') {
    const dt = new Date(now);
    const start = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), 0, 0, 0, 0);
    return { start, end: Number.POSITIVE_INFINITY };
  }
  if (val === 'week') {
    return { start: now - 7 * 86_400_000, end: Number.POSITIVE_INFINITY };
  }
  if (val === 'month') {
    return { start: now - 30 * 86_400_000, end: Number.POSITIVE_INFINITY };
  }
  const relMatch = /^(\d+)([dh])$/.exec(val);
  if (relMatch) {
    const amount = Number(relMatch[1]);
    if (amount >= 1 && amount <= 87_600) {
      const unitMs = relMatch[2] === 'h' ? 3_600_000 : 86_400_000;
      return { start: now - amount * unitMs, end: Number.POSITIVE_INFINITY };
    }
    return null;
  }
  const unitOffsetMatch = /^(day|week|month|year)-(\d+)$/.exec(val);
  if (unitOffsetMatch) {
    const unit = unitOffsetMatch[1];
    const count = Number(unitOffsetMatch[2]);
    if (count >= 0 && count <= 500) {
      const unitDays = unit === 'day' ? 1 : unit === 'week' ? 7 : unit === 'month' ? 30 : 365;
      return { start: now - count * unitDays * 86_400_000, end: Number.POSITIVE_INFINITY };
    }
    return null;
  }

  const cmpMatch = /^(>=|<=|>|<)(.+)$/.exec(val);
  if (cmpMatch) {
    const op = cmpMatch[1];
    const target = cmpMatch[2];
    const bounds = parseDayBounds(target) ?? parseMonthBounds(target) ?? parseYearBounds(target);
    if (!bounds) return null;
    if (op === '>=') return { start: bounds.start, end: Number.POSITIVE_INFINITY };
    if (op === '>') return { start: bounds.end + 1, end: Number.POSITIVE_INFINITY };
    if (op === '<=') return { start: 0, end: bounds.end };
    return { start: 0, end: bounds.start - 1 };
  }

  return parseDayBounds(val) ?? parseMonthBounds(val) ?? parseYearBounds(val);
}

/** Tests whether a timestamp matches all parsed date filter clauses. */
export function matchesDateFilters(timestamp: number, clauses: DateFilterClause[]): boolean {
  if (clauses.length === 0) return true;
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return clauses.every((c) => c.negated);
  }
  return clauses.every((clause) => {
    const inRange = timestamp >= clause.start && timestamp <= clause.end;
    return clause.negated ? !inRange : inRange;
  });
}

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
export function parseSearchQuery(query: string, now = Date.now()): ParsedSearchQuery {
  const parsed: ParsedSearchQuery = {
    terms: [],
    excludedTerms: [],
    tags: [],
    excludedTags: [],
    notebooks: [],
    excludedNotebooks: [],
    sourceUrls: [],
    excludedSourceUrls: [],
    createdFilters: [],
    updatedFilters: [],
  };

  const addTerm = (token: Token, text: string) => {
    (token.negated ? parsed.excludedTerms : parsed.terms).push(text);
  };

  for (const token of tokenize(query)) {
    const value = token.text.toLowerCase();
    switch (token.filter) {
      case 'tag':
        if (value === 'none') parsed.tagNone = !token.negated;
        else (token.negated ? parsed.excludedTags : parsed.tags).push(value);
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
      case 'has':
        if (value === 'attachment' || value === 'attachments') {
          parsed.hasAttachment = !token.negated;
        } else if (value === 'ocr') {
          parsed.hasOcr = !token.negated;
        } else {
          addTerm(token, `has:${value}`);
        }
        break;
      case 'sourceurl':
        if (value) {
          (token.negated ? parsed.excludedSourceUrls : parsed.sourceUrls).push(value);
        } else {
          addTerm(token, 'sourceurl:');
        }
        break;
      case 'created': {
        const bounds = parseDateSpecBounds(value, now);
        if (bounds) parsed.createdFilters.push({ negated: token.negated, ...bounds });
        else addTerm(token, `created:${value}`);
        break;
      }
      case 'updated': {
        const bounds = parseDateSpecBounds(value, now);
        if (bounds) parsed.updatedFilters.push({ negated: token.negated, ...bounds });
        else addTerm(token, `updated:${value}`);
        break;
      }
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
    q.tagNone === undefined &&
    q.notebooks.length === 0 &&
    q.excludedNotebooks.length === 0 &&
    q.type === undefined &&
    q.completed === undefined &&
    q.hasAttachment === undefined &&
    q.hasOcr === undefined &&
    q.sourceUrls.length === 0 &&
    q.excludedSourceUrls.length === 0 &&
    q.createdFilters.length === 0 &&
    q.updatedFilters.length === 0
  );
}

/**
 * Whether a title matches a lower-cased `tag:`/`notebook:` pattern: case-insensitive and whole,
 * with `*` matching any run of characters (iterative matcher, free of regex backtracking).
 */
export function matchesNamePattern(title: string, pattern: string): boolean {
  const lower = title.toLowerCase();
  if (!pattern.includes('*')) return lower === pattern;

  let ti = 0;
  let pi = 0;
  let starIdx = -1;
  let matchIdx = 0;

  while (ti < lower.length) {
    if (pi < pattern.length && pattern[pi] === lower[ti]) {
      ti++;
      pi++;
    } else if (pi < pattern.length && pattern[pi] === '*') {
      starIdx = pi;
      matchIdx = ti;
      pi++;
    } else if (starIdx !== -1) {
      pi = starIdx + 1;
      matchIdx++;
      ti = matchIdx;
    } else {
      return false;
    }
  }

  while (pi < pattern.length && pattern[pi] === '*') {
    pi++;
  }
  return pi === pattern.length;
}

const RESOURCE_LINK_RE = /(?:^|[\s("'<=]):\/([0-9a-fA-F]{32})(?![0-9a-fA-F])/g;

/**
 * Extracts linked Joplin item IDs (`:/<32-hex>`) from a Markdown or HTML note body in link
 * order, without duplicates. Callers resolve IDs against cached resources so note-to-note links
 * are ignored.
 */
export function extractLinkedResourceIds(body: string): string[] {
  if (!body || !body.includes(':/')) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(RESOURCE_LINK_RE)) {
    const id = match[1].toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Collapses whitespace in OCR text so wrapped lines match phrase queries and form clean snippets.
 */
export function normalizeOcrText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Cuts a short single-line snippet from normalized OCR text centered around the earliest matching
 * term, snapping to word boundaries when possible without clipping the match. Returns null when no
 * term appears in `normalizedOcr`.
 */
export function buildOcrSnippet(normalizedOcr: string, terms: string[]): string | null {
  if (!normalizedOcr || terms.length === 0) return null;
  const lower = normalizedOcr.toLowerCase();
  let matchIdx = -1;
  let matchLength = 0;

  if (lower.length === normalizedOcr.length) {
    for (const term of terms) {
      if (!term) continue;
      const idx = lower.indexOf(term);
      if (idx !== -1 && (matchIdx === -1 || idx < matchIdx)) {
        matchIdx = idx;
        matchLength = term.length;
      }
    }
  } else {
    for (const term of terms) {
      if (!term) continue;
      const m = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').exec(normalizedOcr);
      if (m && (matchIdx === -1 || m.index < matchIdx)) {
        matchIdx = m.index;
        matchLength = m[0].length;
      }
    }
  }
  if (matchIdx === -1) return null;

  let start = Math.max(0, matchIdx - 60);
  if (start > 0 && normalizedOcr[start - 1] !== ' ') {
    const nextSpace = normalizedOcr.indexOf(' ', start);
    if (nextSpace !== -1 && nextSpace < matchIdx) start = nextSpace + 1;
  }

  let end = Math.min(normalizedOcr.length, matchIdx + matchLength + 60);
  if (end < normalizedOcr.length && normalizedOcr[end] !== ' ') {
    const prevSpace = normalizedOcr.lastIndexOf(' ', end);
    if (prevSpace >= matchIdx + matchLength) end = prevSpace;
  }

  return `${start > 0 ? '...' : ''}${normalizedOcr.slice(start, end)}${end < normalizedOcr.length ? '...' : ''}`;
}
