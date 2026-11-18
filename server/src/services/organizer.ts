import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import type {
  BatchNoteItem,
  OrganizeApplyItemInput,
  OrganizeApplyResponse,
  OrganizeDeleteResponse,
  OrganizeJobItem,
  OrganizeJobResponse,
  OrganizeJobStatus,
  OrganizeJobSummary,
  OrganizeRetryResponse,
  OrganizeStatus,
  OrganizeSuggestion,
  OrganizeUndoRecord,
  OrganizeUndoResponse,
  OrganizeUsage,
  RawJoplinItem,
} from '../types/index.js';
import { CacheEntry, isConflictNote, noteCache } from './note-cache.js';
import { assertValidId, MAX_BATCH_SIZE, noteWriter, WriteValidationError } from './note-writer.js';
import { extractLinkedResourceIds } from './search-query.js';
import { markupLanguageOf } from './serializer.js';

/** Fixed document-type tag vocabulary allowed for Auto-organize suggestions. */
export const ORGANIZE_DOCUMENT_TYPE_TAGS = [
  'statement',
  'invoice',
  'receipt',
  'bill',
  'letter',
  'contract',
  'policy',
  'payslip',
  'tax',
  'certificate',
  'id-document',
  'manual',
  'warranty',
  'booking',
  'ticket',
  'quote',
  'report',
  'form',
  'medical',
  'other',
] as const;

const ORGANIZE_DOCUMENT_TYPE_TAG_SET = new Set<string>(ORGANIZE_DOCUMENT_TYPE_TAGS);

/** Verbatim system prompt instructions template kept byte-identical across every request in a job. */
export const ORGANIZE_SYSTEM_INSTRUCTIONS = `You organize personal notes and scanned document notes into a user's existing Joplin taxonomy.
Return ONLY a valid JSON object matching this exact schema:
{
  "title": string,
  "notebookId": string,
  "tags": string[],
  "confidence": number,
  "documentDate": string | null,
  "reason": string
}

Rules:
- "title": ALWAYS write titles in English, formatted as "YYYY-MM-DD Issuer – Document type" (using an en-dash " – "), where the date is the document's own date (from the document text, OCR, or filename) or else the note's created date. Keep titles concise (max ~80 characters) and NEVER include a file extension (.pdf, .png, .jpg, etc.). When the note's current title is already meaningful and descriptive, keep the current title unchanged (return it verbatim).
- "notebookId": MUST be one of the allowed target notebook IDs listed below. NEVER suggest an excluded notebook ID.
- "tags": At most 2 lowercase-hyphenated tags: first, exactly one document type from [${ORGANIZE_DOCUMENT_TYPE_TAGS.join(', ')}]; plus optionally one issuer tag (lowercase, hyphenated, e.g. "hsbc", "hang-seng", "john-lewis"). Existing account tags listed below may still be used when they clearly fit.
- "confidence": Number from 0 to 1 reflecting your certainty (use < 0.7 when ambiguous or uncertain).
- "documentDate": Document date formatted as "YYYY-MM-DD", or null if none is found.
- "reason": One short English sentence explaining the suggestion.`;

const MAX_BODY_CHARS = 2000;
const MAX_OCR_CHARS = 6000;
const MIN_INDEX_OCR_CHARS = 150;
const MAX_SIMILAR_NOTES = 5;
const SIMILARITY_THRESHOLD = 0.05;
const SIMILARITY_TOKEN_SOURCE = '[a-z]{3,}|\\d{4,}|[\\u4e00-\\u9fff]{2}';
const MAX_EXAMPLES_PER_NOTEBOOK = 8;
const MAX_SYSTEM_TAGS = 300;
const MAX_TITLE_CHARS = 80;
const MAX_REASON_CHARS = 240;
const REQUEST_TIMEOUT_MS = 60_000;
const PERSIST_DEBOUNCE_MS = 300;
export const MAX_RETAINED_JOBS = 20;
export const MAX_ORGANIZE_NOTES = 25_000;
export const MAX_EXCLUDED_NOTEBOOKS = 5_000;
const ORGANIZE_INDEX_FILE = 'index.json';
const OWNER_KEY_RE = /^[A-Za-z0-9_-]+$/;
const SAFE_JOB_ID_RE = /^[0-9a-f]{32}$|^[0-9a-f-]{16,64}$/i;
const NON_RETRYABLE_ERROR_RE =
  /\bskipped\b|\btrashed\b|duplicate copy|^note not found$|^encrypted notes cannot|^conflict copies cannot/i;
const DOC_EXTENSION_RE = /\.(pdf|png|jpe?g|tiff?|bmp|webp|heic|heif|gif)$/i;
const SCANNER_TITLE_PATTERNS: RegExp[] = [
  DOC_EXTENSION_RE,
  /^(img|dsc|scan|scanned|doc|document|image|photo|camscanner|screenshot|untitled)([_\-\s]*\d*)?$/i,
  /^(img|dsc|scan|camscanner|screenshot)[_\-\s]+\S+$/i,
  /^[\d_\-.:/ T]+$/,
  /^\d{4}[_-]\d{2}[_-]\d{2}(?:[_T\- ]\d{2}){1,4}(?:_\d+)?$/,
];

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCompletionResult {
  content: string;
  usage?: Partial<OrganizeUsage>;
}

export type LlmCompletionFn = (messages: LlmMessage[], signal: AbortSignal) => Promise<LlmCompletionResult>;

export interface OrganizerDeps {
  aiBaseUrl?: string | null;
  aiApiKey?: string | null;
  aiModel?: string | null;
  aiConcurrency?: number;
  aiFake?: boolean;
  aiFakeDelayMs?: number;
  cacheDir?: string | null;
  completionFn?: LlmCompletionFn;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  retryBaseDelayMs?: number;
  maxRetries?: number;
}

interface InternalJobItem extends OrganizeJobItem {
  systemRetryCount?: number;
}

interface InternalOrganizeJob {
  id: string;
  ownerKey: string;
  status: OrganizeJobStatus;
  error?: string;
  excludeNotebookIds: string[];
  allowedNotebookIds: string[];
  systemPrompt: string;
  items: InternalJobItem[];
  usage: OrganizeUsage;
  lastUndo: OrganizeUndoRecord | null;
  createdAt: number;
  updatedAt: number;
}

interface PersistedJobFileV1 {
  version: 1;
  job: InternalOrganizeJob;
}

interface PersistedJobFileV2 {
  version: 2;
  job: InternalOrganizeJob;
}

interface PersistedLegacyJobsV2 {
  version: 2;
  jobs: InternalOrganizeJob[];
}

interface PersistedOrganizeIndexFile {
  version: 2;
  jobs: OrganizeJobSummary[];
}

interface OwnerJobState {
  summaries: OrganizeJobSummary[];
  loadedJobs: Map<string, InternalOrganizeJob>;
  lastViewedFinishedJobId: string | null;
}

interface PersistTimerEntry {
  ownerKey: string;
  jobId: string;
  timer: NodeJS.Timeout;
}

interface ParsedNotebookSpec {
  id: string;
  path: string;
  examples: string[];
}

export class OrganizeValidationError extends WriteValidationError {
  constructor(message: string, status = 400, details?: unknown) {
    super(message, status, details);
    this.name = 'OrganizeValidationError';
  }
}

/**
 * Returns true when a title looks like a raw scanner/camera filename or placeholder rather than
 * a human-written note title.
 */
export function isScannerStyleTitle(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed) return true;
  return SCANNER_TITLE_PATTERNS.some((re) => re.test(trimmed));
}

function sanitizeLine(raw: string): string {
  return raw.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatIsoDate(ts: number): string {
  const date = new Date(Number.isFinite(ts) && ts > 0 ? ts : 0);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 1970) {
    return new Date().toISOString().slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Removes URLs, HTML tags/links, and Joplin resource links (`:/id`) from a note body while preserving
 * human-readable link text, capped to `maxChars`.
 */
export function stripLinksFromBody(body: string, markupLanguage = 1, maxChars = MAX_BODY_CHARS): string {
  if (!body) return '';
  let text = body;
  if (markupLanguage === 2) {
    text = text
      .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1')
      .replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"');
  } else {
    text = text
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  }
  text = text
    .replace(/:\/[0-9a-fA-F]{32}/g, ' ')
    .replace(/https?:\/\/[^\s)>"']+/gi, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars - 1).trimEnd()}…`;
  }
  return text;
}

/** Computes `Path / Child` for all active non-encrypted notebooks in `entry`. */
function buildNotebookPaths(entry: CacheEntry): {
  pathById: Map<string, string>;
  activeNonEncryptedIds: Set<string>;
} {
  const deletedIds = new Set<string>();
  const activeMap = new Map<string, RawJoplinItem>();
  for (const nb of entry.notebooks.values()) {
    if (nb.deletedTime && nb.deletedTime > 0) {
      deletedIds.add(nb.id);
    } else {
      activeMap.set(nb.id, nb);
    }
  }

  // Mark sub-notebooks whose ancestors are trashed or encrypted cleanly
  const isDeletedOrCycle = (id: string): boolean => {
    const seen = new Set<string>();
    let cur = id;
    while (cur && !seen.has(cur)) {
      if (deletedIds.has(cur)) return true;
      seen.add(cur);
      const nb = activeMap.get(cur);
      if (!nb) break;
      cur = nb.parentId;
    }
    return false;
  };

  const pathById = new Map<string, string>();
  const activeNonEncryptedIds = new Set<string>();

  for (const nb of activeMap.values()) {
    if (isDeletedOrCycle(nb.id)) continue;
    const segments: string[] = [];
    const seen = new Set<string>();
    let cur: RawJoplinItem | undefined = nb;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      const label =
        cur.properties.encryption_applied === '1'
          ? 'Encrypted notebook'
          : sanitizeLine(cur.title) || 'Untitled Notebook';
      segments.unshift(label);
      cur = cur.parentId ? activeMap.get(cur.parentId) : undefined;
    }
    pathById.set(nb.id, segments.join(' / '));
    if (nb.properties.encryption_applied !== '1') {
      activeNonEncryptedIds.add(nb.id);
    }
  }

  return { pathById, activeNonEncryptedIds };
}

function isNotebookTrashed(entry: CacheEntry, notebookId: string): boolean {
  const seen = new Set<string>();
  let curId = notebookId;
  while (curId && !seen.has(curId)) {
    seen.add(curId);
    const nb = entry.notebooks.get(curId);
    if (!nb) return false;
    if (nb.deletedTime && nb.deletedTime > 0) return true;
    curId = nb.parentId;
  }
  return false;
}

function resolveNotebookPath(entry: CacheEntry, notebookId: string, pathById: Map<string, string>): string {
  if (!notebookId) return '';
  const direct = pathById.get(notebookId);
  if (direct) return direct;
  const nb = entry.notebooks.get(notebookId);
  if (!nb) return '';
  if (nb.deletedTime > 0 || isNotebookTrashed(entry, notebookId)) {
    return `${sanitizeLine(nb.title) || 'Trashed Notebook'} (Trashed)`;
  }
  return nb.properties.encryption_applied === '1' ? 'Encrypted notebook' : sanitizeLine(nb.title);
}

function classifyRetryability(
  item: InternalJobItem,
  entry: CacheEntry | null
): { retryable: boolean; reason?: string; liveNote?: RawJoplinItem } {
  if (item.skipped) {
    return { retryable: false, reason: item.error || 'Skipped note' };
  }
  if (item.error && NON_RETRYABLE_ERROR_RE.test(item.error)) {
    return { retryable: false, reason: item.error };
  }
  if (entry) {
    const liveNote = entry.notes.get(item.noteId);
    if (!liveNote) {
      return { retryable: false, reason: 'Note not found' };
    }
    if (liveNote.properties.encryption_applied === '1') {
      return { retryable: false, reason: 'Encrypted notes cannot be read or organized' };
    }
    if (isConflictNote(liveNote)) {
      return { retryable: false, reason: 'Conflict copies cannot be auto-organized here' };
    }
    if (liveNote.deletedTime > 0 || (liveNote.parentId && isNotebookTrashed(entry, liveNote.parentId))) {
      return { retryable: false, reason: 'Trashed notes cannot be organized' };
    }
    return { retryable: true, liveNote };
  }
  return { retryable: true };
}

function computeJobSummary(job: InternalOrganizeJob): OrganizeJobSummary {
  let done = 0;
  let failed = 0;
  let appliedCount = 0;
  for (const item of job.items) {
    if (item.status === 'done') done++;
    else if (item.status === 'failed') failed++;
    if (item.applied) appliedCount++;
  }
  return {
    id: job.id,
    status: job.status,
    ...(job.error ? { error: job.error } : {}),
    progress: {
      total: job.items.length,
      done,
      failed,
    },
    appliedCount,
    usage: {
      promptTokens: job.usage?.promptTokens ?? 0,
      completionTokens: job.usage?.completionTokens ?? 0,
      totalTokens: job.usage?.totalTokens ?? 0,
    },
    canUndo: Boolean(job.lastUndo && job.lastUndo.items.length > 0),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function sortSummariesNewestFirst(summaries: OrganizeJobSummary[]): void {
  summaries.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
}

function normalizeLoadedJob(raw: InternalOrganizeJob): InternalOrganizeJob {
  for (const item of raw.items) {
    if (item.status === 'running') {
      item.status = 'pending';
    }
  }
  if (!raw.usage) {
    raw.usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
  if (!Array.isArray(raw.excludeNotebookIds)) {
    raw.excludeNotebookIds = [];
  }
  if (!Array.isArray(raw.allowedNotebookIds)) {
    raw.allowedNotebookIds = [];
  }
  if (raw.lastUndo === undefined) {
    raw.lastUndo = null;
  }
  return raw;
}

/**
 * Builds the deterministic system prompt from the current account taxonomy (notebook tree + up to 8
 * non-scanner example titles per notebook + existing tags). Stored once per job so every API request
 * in the job uses the byte-identical system prompt for provider prompt caching.
 */
export function buildOrganizeSystemPrompt(
  entry: CacheEntry,
  excludeNotebookIds: ReadonlySet<string>
): { systemPrompt: string; allowedNotebookIds: string[]; pathById: Map<string, string> } {
  const { pathById, activeNonEncryptedIds } = buildNotebookPaths(entry);

  // Collect up to 8 non-scanner example titles per allowed notebook (sorted deterministically)
  const notesByNotebook = new Map<string, RawJoplinItem[]>();
  for (const note of entry.notes.values()) {
    if (note.deletedTime > 0 || isConflictNote(note) || note.properties.encryption_applied === '1') {
      continue;
    }
    if (!note.parentId || !activeNonEncryptedIds.has(note.parentId)) continue;
    const list = notesByNotebook.get(note.parentId) ?? [];
    list.push(note);
    notesByNotebook.set(note.parentId, list);
  }

  const allowedSpecs: ParsedNotebookSpec[] = [];
  const excludedLines: string[] = [];

  const sortedNotebookIds = [...activeNonEncryptedIds].sort((a, b) => {
    const pa = pathById.get(a) ?? '';
    const pb = pathById.get(b) ?? '';
    return pa.localeCompare(pb) || a.localeCompare(b);
  });

  for (const nbId of sortedNotebookIds) {
    const path = pathById.get(nbId) ?? nbId;
    if (excludeNotebookIds.has(nbId)) {
      excludedLines.push(`- ${nbId} | ${path}`);
      continue;
    }
    const candidates = (notesByNotebook.get(nbId) ?? []).sort(
      (a, b) => b.updatedTime - a.updatedTime || a.id.localeCompare(b.id)
    );
    const examples: string[] = [];
    const seenTitles = new Set<string>();
    for (const n of candidates) {
      const clean = sanitizeLine(n.title);
      if (!clean || isScannerStyleTitle(clean)) continue;
      const key = clean.toLowerCase();
      if (seenTitles.has(key)) continue;
      seenTitles.add(key);
      examples.push(clean.length > 80 ? `${clean.slice(0, 79)}…` : clean);
      if (examples.length >= MAX_EXAMPLES_PER_NOTEBOOK) break;
    }
    allowedSpecs.push({ id: nbId, path, examples });
  }

  const tagTitles: string[] = [];
  const seenTags = new Set<string>();
  const sortedTags = [...entry.tags.values()]
    .filter((t) => t.properties.encryption_applied !== '1' && t.deletedTime === 0)
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  for (const tag of sortedTags) {
    const clean = sanitizeLine(tag.title).toLowerCase();
    if (!clean || seenTags.has(clean)) continue;
    seenTags.add(clean);
    tagTitles.push(clean);
    if (tagTitles.length >= MAX_SYSTEM_TAGS) break;
  }

  const allowedSection =
    allowedSpecs.length > 0
      ? allowedSpecs
          .map((spec) =>
            spec.examples.length > 0
              ? `- ${spec.id} | ${spec.path} | examples: ${spec.examples.map((ex) => JSON.stringify(ex)).join(', ')}`
              : `- ${spec.id} | ${spec.path}`
          )
          .join('\n')
      : '- (none — keep current notebook)';

  const sections: string[] = [
    ORGANIZE_SYSTEM_INSTRUCTIONS,
    '',
    'Allowed target notebooks (id | Path | example titles):',
    allowedSection,
  ];

  if (excludedLines.length > 0) {
    sections.push('', 'Excluded target notebooks (NEVER choose these notebookId values):', ...excludedLines);
  }

  sections.push('', 'Existing tags:', tagTitles.length > 0 ? tagTitles.join(', ') : '(none)');

  return {
    systemPrompt: sections.join('\n'),
    allowedNotebookIds: allowedSpecs.map((s) => s.id),
    pathById,
  };
}

export interface SimilarNoteHint {
  noteId: string;
  notebookId: string;
  notebookPath: string;
  title: string;
  similarity: number;
}

export interface NoteSimilarityIndex {
  readonly size: number;
  findSimilar(ocrText: string, limit?: number): SimilarNoteHint[];
}

function detachTokenString(token: string): string {
  // Break V8 SlicedString references >= 13 chars so vocabulary maps never retain 6 KB OCR buffers
  return token.length >= 13 ? Buffer.from(token, 'utf8').toString('utf8') : token;
}

/**
 * Builds an in-memory TF-IDF cosine-similarity index over already-filed notes that have at least
 * 150 characters of attachment OCR text. Uses flat typed arrays for inverted postings so indexing
 * ~3,000 notes fits comfortably inside the container's 768 MB memory budget.
 */
export function buildNoteSimilarityIndex(
  entry: CacheEntry,
  options: {
    excludeNotebookIds?: ReadonlySet<string>;
    excludeNoteIds?: ReadonlySet<string>;
  } = {}
): NoteSimilarityIndex {
  const excludeNotebookIds = options.excludeNotebookIds ?? new Set<string>();
  const excludeNoteIds = options.excludeNoteIds ?? new Set<string>();
  const { pathById, activeNonEncryptedIds } = buildNotebookPaths(entry);

  const docNoteIds: string[] = [];
  const docNotebookIds: string[] = [];
  const docTitles: string[] = [];
  const rawDf = new Map<string, number>();

  for (const note of entry.notes.values()) {
    if (note.deletedTime > 0 || isConflictNote(note) || note.properties.encryption_applied === '1') {
      continue;
    }
    if (!note.parentId || !activeNonEncryptedIds.has(note.parentId)) continue;
    if (excludeNotebookIds.has(note.parentId) || excludeNoteIds.has(note.id)) continue;

    const ocr = noteCache.getAttachmentTextFromEntry(entry, note.id, { maxChars: MAX_OCR_CHARS });
    if (ocr.length < MIN_INDEX_OCR_CHARS) continue;

    docNoteIds.push(note.id);
    docNotebookIds.push(note.parentId);
    const cleanTitle = sanitizeLine(note.title) || '(untitled)';
    docTitles.push(cleanTitle.length > MAX_TITLE_CHARS ? `${cleanTitle.slice(0, MAX_TITLE_CHARS - 1)}…` : cleanTitle);

    const lower = ocr.toLowerCase();
    const re = new RegExp(SIMILARITY_TOKEN_SOURCE, 'g');
    const seen = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = re.exec(lower)) !== null) {
      seen.add(match[0]);
    }
    for (const token of seen) {
      const prev = rawDf.get(token);
      if (prev === undefined) {
        rawDf.set(detachTokenString(token), 1);
      } else {
        rawDf.set(token, prev + 1);
      }
    }
  }

  const N = docNoteIds.length;
  const termToId = new Map<string, number>();
  const dfList: number[] = [];
  for (const [token, df] of rawDf) {
    if (df < 2 || df >= N) continue;
    termToId.set(token, dfList.length);
    dfList.push(df);
  }
  rawDf.clear();

  const V = dfList.length;
  if (N < 2 || V === 0) {
    return {
      size: N,
      findSimilar: () => [],
    };
  }

  const idf = new Float64Array(V);
  const termOffsets = new Uint32Array(V + 1);
  let nnz = 0;
  for (let t = 0; t < V; t++) {
    const df = dfList[t];
    idf[t] = Math.log(N / df);
    termOffsets[t] = nnz;
    nnz += df;
  }
  termOffsets[V] = nnz;

  const cursor = new Uint32Array(termOffsets);
  const postingDocIds = new Uint32Array(nnz);
  const postingWeights = new Float64Array(nnz);
  const docNorms = new Float64Array(N);

  const tfMap = new Map<number, number>();
  for (let docIdx = 0; docIdx < N; docIdx++) {
    const ocr = noteCache.getAttachmentTextFromEntry(entry, docNoteIds[docIdx], { maxChars: MAX_OCR_CHARS });
    const lower = ocr.toLowerCase();
    const re = new RegExp(SIMILARITY_TOKEN_SOURCE, 'g');
    tfMap.clear();
    let match: RegExpExecArray | null;
    while ((match = re.exec(lower)) !== null) {
      const termId = termToId.get(match[0]);
      if (termId !== undefined) {
        tfMap.set(termId, (tfMap.get(termId) ?? 0) + 1);
      }
    }

    let sumSq = 0;
    for (const [termId, tf] of tfMap) {
      const weight = (1 + Math.log(tf)) * idf[termId];
      sumSq += weight * weight;
      const pos = cursor[termId]++;
      postingDocIds[pos] = docIdx;
      postingWeights[pos] = weight;
    }
    docNorms[docIdx] = Math.sqrt(sumSq) || 1;
  }

  return {
    size: N,
    findSimilar(ocrText: string, limit = MAX_SIMILAR_NOTES): SimilarNoteHint[] {
      if (!ocrText || limit <= 0) return [];
      const lower = ocrText.toLowerCase();
      const re = new RegExp(SIMILARITY_TOKEN_SOURCE, 'g');
      const qTf = new Map<number, number>();
      let match: RegExpExecArray | null;
      while ((match = re.exec(lower)) !== null) {
        const termId = termToId.get(match[0]);
        if (termId !== undefined) {
          qTf.set(termId, (qTf.get(termId) ?? 0) + 1);
        }
      }
      if (qTf.size === 0) return [];

      let qNormSq = 0;
      const dots = new Float64Array(N);
      for (const [termId, tf] of qTf) {
        const qw = (1 + Math.log(tf)) * idf[termId];
        qNormSq += qw * qw;
        const start = termOffsets[termId];
        const end = termOffsets[termId + 1];
        for (let p = start; p < end; p++) {
          dots[postingDocIds[p]] += qw * postingWeights[p];
        }
      }
      const qNorm = Math.sqrt(qNormSq) || 1;

      const candidates: Array<{ docIdx: number; similarity: number }> = [];
      for (let docIdx = 0; docIdx < N; docIdx++) {
        const dot = dots[docIdx];
        if (dot <= 0) continue;
        const similarity = dot / (qNorm * docNorms[docIdx]);
        if (similarity > SIMILARITY_THRESHOLD) {
          candidates.push({ docIdx, similarity });
        }
      }
      candidates.sort(
        (a, b) => b.similarity - a.similarity || docNoteIds[a.docIdx].localeCompare(docNoteIds[b.docIdx])
      );

      return candidates.slice(0, limit).map(({ docIdx, similarity }) => {
        const notebookId = docNotebookIds[docIdx];
        return {
          noteId: docNoteIds[docIdx],
          notebookId,
          notebookPath: pathById.get(notebookId) ?? notebookId,
          title: docTitles[docIdx],
          similarity,
        };
      });
    },
  };
}

/**
 * Builds the per-note user message with current title, notebook path, created date, stripped body,
 * attachment filenames, OCR text, and optional similar filed notes.
 */
export function buildOrganizeUserPrompt(input: {
  currentTitle: string;
  currentNotebookId: string;
  currentNotebookPath: string;
  createdDate: string;
  bodyText: string;
  attachmentFilenames: string[];
  ocrText: string;
  similarNotes?: SimilarNoteHint[];
}): string {
  const lines = [
    `Current title: ${sanitizeLine(input.currentTitle) || '(untitled)'}`,
    `Current notebook: ${input.currentNotebookPath || '(none)'} (id: ${input.currentNotebookId || 'none'})`,
    `Created date: ${input.createdDate}`,
    'Body text:',
    input.bodyText || '(empty)',
    'Attachment filenames:',
    input.attachmentFilenames.length > 0 ? input.attachmentFilenames.join(', ') : '(none)',
    'Attachment OCR text:',
    input.ocrText || '(none)',
  ];

  const neighbours = input.ocrText.trim()
    ? (input.similarNotes ?? []).filter((n) => n.similarity > SIMILARITY_THRESHOLD).slice(0, MAX_SIMILAR_NOTES)
    : [];

  if (neighbours.length > 0) {
    lines.push(
      '',
      'Similar notes already filed by the user (by attachment text; usually the same issuer belongs in the same notebook):',
      ...neighbours.map((n) => {
        const cleanTitle = sanitizeLine(n.title) || '(untitled)';
        const shortTitle =
          cleanTitle.length > MAX_TITLE_CHARS ? `${cleanTitle.slice(0, MAX_TITLE_CHARS - 1)}…` : cleanTitle;
        return `- ${n.notebookPath} (id: ${n.notebookId}) | "${shortTitle}" | similarity ${n.similarity.toFixed(2)}`;
      })
    );
  }

  return lines.join('\n');
}

function unwrapJsonContent(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

function normalizeSuggestedTitle(rawTitle: string, currentTitle: string): string {
  const singleLine = sanitizeLine(rawTitle);
  const currentSingle = sanitizeLine(currentTitle);
  if (currentSingle && singleLine === currentSingle) {
    return currentSingle;
  }
  const withoutExt = singleLine.replace(DOC_EXTENSION_RE, '').trim();
  const finalTitle = withoutExt || singleLine;
  if (finalTitle.length <= MAX_TITLE_CHARS) return finalTitle;
  const sliced = finalTitle.slice(0, MAX_TITLE_CHARS);
  const lastSpace = sliced.lastIndexOf(' ');
  return (lastSpace >= 50 ? sliced.slice(0, lastSpace) : sliced).trim();
}

export interface ValidationOutcome {
  ok: true;
  suggestion: OrganizeSuggestion;
}

export interface ValidationFailure {
  ok: false;
  error: string;
}

/**
 * Normalizes a suggested tag to lowercase-hyphenated form (`"John Lewis"` -> `"john-lewis"`).
 */
export function normalizeOrganizeTag(raw: string): string {
  return sanitizeLine(raw)
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/[\s_/]+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** An issuer tag is only suggested once that issuer appears in this many of a job's notes */
export const MIN_ISSUER_TAG_NOTES = 3;

/**
 * Returns a predicate for the tags a job shows: document-type tags and tags that already exist in
 * the account always, any other (issuer) tag only when it occurs in at least `minCount` of the job's
 * suggestions, so a large backlog doesn't create one tag per one-off issuer. Counts grow while a job
 * runs, so an issuer can appear once it recurs.
 */
export function recurringTagFilter(
  items: ReadonlyArray<{ suggestion?: { tags: string[] } | null }>,
  existingTags: ReadonlySet<string>,
  minCount = MIN_ISSUER_TAG_NOTES
): (tag: string) => boolean {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const tag of new Set(item.suggestion?.tags ?? [])) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return (tag) => ORGANIZE_DOCUMENT_TYPE_TAG_SET.has(tag) || existingTags.has(tag) || (counts.get(tag) ?? 0) >= minCount;
}

/**
 * Strictly validates and normalizes a model's JSON output. Unknown or excluded `notebookId`
 * values fall back to `currentNotebookId` with `confidence = 0`.
 * Tags are normalized to lowercase-hyphenated and capped to at most one document type from
 * `ORGANIZE_DOCUMENT_TYPE_TAGS` plus at most one other (issuer/existing) tag.
 */
export function parseAndValidateSuggestion(
  rawContent: string,
  context: {
    currentTitle: string;
    currentNotebookId: string;
    allowedNotebookIds: ReadonlySet<string>;
  }
): ValidationOutcome | ValidationFailure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapJsonContent(rawContent));
  } catch {
    return { ok: false, error: 'Output is not valid JSON' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'JSON root must be an object' };
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.title !== 'string' || !sanitizeLine(obj.title)) {
    return { ok: false, error: '"title" must be a non-empty string' };
  }
  if (typeof obj.notebookId !== 'string' || !obj.notebookId.trim()) {
    return { ok: false, error: '"notebookId" must be a non-empty string' };
  }
  if (!Array.isArray(obj.tags) || !obj.tags.every((t) => typeof t === 'string')) {
    return { ok: false, error: '"tags" must be an array of strings' };
  }
  if (typeof obj.confidence !== 'number' || !Number.isFinite(obj.confidence) || obj.confidence < 0 || obj.confidence > 1) {
    return { ok: false, error: '"confidence" must be a finite number between 0 and 1' };
  }
  if (
    obj.documentDate !== null &&
    (typeof obj.documentDate !== 'string' || !isValidIsoDate(obj.documentDate))
  ) {
    return { ok: false, error: '"documentDate" must be YYYY-MM-DD or null' };
  }
  if (typeof obj.reason !== 'string' || !sanitizeLine(obj.reason)) {
    return { ok: false, error: '"reason" must be a non-empty string' };
  }

  const rawNotebookId = obj.notebookId.trim();
  const validNotebook = context.allowedNotebookIds.has(rawNotebookId);
  const notebookId = validNotebook ? rawNotebookId : context.currentNotebookId;
  const confidence = validNotebook ? Math.round(obj.confidence * 100) / 100 : 0;

  let typeTag: string | null = null;
  let otherTag: string | null = null;
  for (const rawTag of obj.tags) {
    const clean = normalizeOrganizeTag(rawTag);
    if (!clean) continue;
    if (ORGANIZE_DOCUMENT_TYPE_TAG_SET.has(clean)) {
      if (!typeTag) typeTag = clean;
    } else if (!otherTag) {
      otherTag = clean;
    }
    if (typeTag && otherTag) break;
  }
  const tags: string[] = [];
  if (typeTag) tags.push(typeTag);
  if (otherTag) tags.push(otherTag);

  const title = normalizeSuggestedTitle(obj.title, context.currentTitle);
  const rawReason = sanitizeLine(obj.reason);
  const reason = rawReason.length > MAX_REASON_CHARS ? `${rawReason.slice(0, MAX_REASON_CHARS - 1).trimEnd()}…` : rawReason;

  return {
    ok: true,
    suggestion: {
      title,
      notebookId,
      tags,
      confidence,
      documentDate: obj.documentDate,
      reason: validNotebook ? reason : `${reason} (Kept current notebook: suggested destination unavailable.)`.slice(0, MAX_REASON_CHARS),
    },
  };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseRetryAfterHeader(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.min(30_000, parseInt(trimmed, 10) * 1000);
  }
  const ts = Date.parse(trimmed);
  if (!Number.isNaN(ts)) {
    return Math.max(0, Math.min(30_000, ts - Date.now()));
  }
  return null;
}

function createOpenAiCompletionClient(opts: {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  retryBaseDelayMs: number;
  maxRetries: number;
}): LlmCompletionFn {
  const endpoint = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return async (messages, signal) => {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
      if (signal.aborted) {
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (opts.apiKey) {
        headers.Authorization = `Bearer ${opts.apiKey}`;
      }

      const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const combinedSignal = AbortSignal.any([signal, timeoutSignal]);

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: opts.model,
            messages,
            response_format: { type: 'json_object' },
            temperature: 0.2,
          }),
          signal: combinedSignal,
        });
      } catch (err) {
        if (signal.aborted) throw err;
        lastError = new Error('AI provider request failed');
        if (attempt < opts.maxRetries) {
          const delay = opts.retryBaseDelayMs * 2 ** attempt;
          await opts.sleep(delay, signal);
          continue;
        }
        throw lastError;
      }

      if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
        const headerDelay = parseRetryAfterHeader(response.headers.get('Retry-After'));
        lastError = new Error(`AI provider returned HTTP ${response.status}`);
        if (attempt < opts.maxRetries) {
          const delay = headerDelay ?? opts.retryBaseDelayMs * 2 ** attempt;
          await opts.sleep(delay, signal);
          continue;
        }
        throw lastError;
      }

      if (!response.ok) {
        throw new Error(`AI provider returned HTTP ${response.status}`);
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error('AI provider response did not include message content');
      }
      const promptTokens = typeof data.usage?.prompt_tokens === 'number' ? data.usage.prompt_tokens : 0;
      const completionTokens = typeof data.usage?.completion_tokens === 'number' ? data.usage.completion_tokens : 0;
      const totalTokens =
        typeof data.usage?.total_tokens === 'number' ? data.usage.total_tokens : promptTokens + completionTokens;

      return {
        content,
        usage: { promptTokens, completionTokens, totalTokens },
      };
    }
    throw lastError ?? new Error('AI provider request failed');
  };
}

/** Parses allowed notebooks from the system prompt so the fake organizer follows identical contracts. */
function parsePromptContext(systemPrompt: string): {
  allowed: Array<{ id: string; path: string }>;
  existingTags: string[];
} {
  const allowed: Array<{ id: string; path: string }> = [];
  const lines = systemPrompt.split('\n');
  let mode: 'none' | 'allowed' | 'excluded' | 'tags' = 'none';
  let tagLine = '';

  for (const line of lines) {
    if (line.startsWith('Allowed target notebooks')) {
      mode = 'allowed';
      continue;
    }
    if (line.startsWith('Excluded target notebooks')) {
      mode = 'excluded';
      continue;
    }
    if (line === 'Existing tags:') {
      mode = 'tags';
      continue;
    }
    if (mode === 'allowed' && line.startsWith('- ')) {
      const m = /^- ([0-9a-f]{32})\s+\|\s+(.*?)(?:\s+\|\s+examples:.*)?$/i.exec(line);
      if (m) {
        allowed.push({ id: m[1], path: m[2].trim() });
      }
    } else if (mode === 'tags' && line.trim() && line.trim() !== '(none)') {
      tagLine = line.trim();
    }
  }

  const existingTags = tagLine
    ? tagLine.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
    : [];
  return { allowed, existingTags };
}

const MONTH_NAMES: Record<string, string> = {
  january: '01', jan: '01',
  february: '02', feb: '02',
  march: '03', mar: '03',
  april: '04', apr: '04',
  may: '05',
  june: '06', jun: '06',
  july: '07', jul: '07',
  august: '08', aug: '08',
  september: '09', sep: '09', sept: '09',
  october: '10', oct: '10',
  november: '11', nov: '11',
  december: '12', dec: '12',
};

function extractDocumentDate(text: string): string | null {
  const iso = /\b(20\d{2}|19\d{2})[-_/](0[1-9]|1[0-2])[-_/](0[1-9]|[12]\d|3[01])\b/.exec(text);
  if (iso) {
    const candidate = `${iso[1]}-${iso[2]}-${iso[3]}`;
    if (isValidIsoDate(candidate)) return candidate;
  }
  const named = /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)\s+(\d{1,2}),?\s+(20\d{2}|19\d{2})\b/i.exec(
    text
  );
  if (named) {
    const month = MONTH_NAMES[named[1].toLowerCase()];
    const day = String(parseInt(named[2], 10)).padStart(2, '0');
    const candidate = `${named[3]}-${month}-${day}`;
    if (isValidIsoDate(candidate)) return candidate;
  }
  return null;
}

/**
 * Deterministic fake organizer for demo and offline testing. Reads only the prompt messages so it
 * honors exclusions, OCR extraction, meaningful-title preservation, and token reporting end-to-end.
 */
export function createFakeCompletionClient(
  delayMs = 0,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void> = defaultSleep
): LlmCompletionFn {
  return async (messages, signal) => {
    if (delayMs > 0) {
      await sleep(delayMs, signal);
    }

    const systemMsg = messages.find((m) => m.role === 'system')?.content ?? '';
    const userMsg = messages.find((m) => m.role === 'user')?.content ?? '';
    const { allowed, existingTags } = parsePromptContext(systemMsg);

    const titleMatch = /^Current title:\s*(.+)$/m.exec(userMsg);
    const nbMatch = /^Current notebook:\s*(.*?)\s*\(id:\s*([^)]+)\)$/m.exec(userMsg);
    const createdMatch = /^Created date:\s*(\d{4}-\d{2}-\d{2})$/m.exec(userMsg);
    const bodyMatch = /Body text:\n([\s\S]*?)\nAttachment filenames:/m.exec(userMsg);
    const ocrMatch =
      /Attachment OCR text:\n([\s\S]*?)(?=\n+Similar notes already filed by the user \(by attachment text;|$)/.exec(
        userMsg
      );

    const currentTitle = titleMatch?.[1]?.trim() === '(untitled)' ? '' : titleMatch?.[1]?.trim() ?? '';
    const currentNotebookId = nbMatch?.[2]?.trim() === 'none' ? '' : nbMatch?.[2]?.trim() ?? '';
    const createdDate = createdMatch?.[1] ?? '2026-01-01';
    const bodyText = bodyMatch?.[1]?.trim() === '(empty)' ? '' : bodyMatch?.[1]?.trim() ?? '';
    const ocrText = ocrMatch?.[1]?.trim() === '(none)' ? '' : ocrMatch?.[1]?.trim() ?? '';

    const combined = `${currentTitle}\n${bodyText}\n${ocrText}`;
    const combinedLower = combined.toLowerCase();
    const documentDate = extractDocumentDate(`${ocrText}\n${bodyText}\n${currentTitle}`);
    const datePrefix = documentDate ?? createdDate;

    // Pick destination notebook from allowed list based on keywords
    const pickNotebook = (patterns: RegExp[], avoidCurrent = true): string => {
      for (const re of patterns) {
        const match = allowed.find((nb) => re.test(nb.path) && (!avoidCurrent || nb.id !== currentNotebookId));
        if (match) return match.id;
      }
      const sameAllowed = allowed.find((nb) => nb.id === currentNotebookId);
      if (!avoidCurrent && sameAllowed) return sameAllowed.id;
      return allowed.find((nb) => nb.id !== currentNotebookId)?.id ?? allowed[0]?.id ?? currentNotebookId;
    };

    const pickTags = (candidates: string[]): string[] => {
      let typeTag: string | null = null;
      let otherTag: string | null = null;
      for (const c of candidates) {
        const clean = normalizeOrganizeTag(c);
        if (!clean) continue;
        if (ORGANIZE_DOCUMENT_TYPE_TAG_SET.has(clean)) {
          if (!typeTag) typeTag = clean;
        } else if (!otherTag) {
          otherTag = clean;
        }
        if (typeTag && otherTag) break;
      }
      return [...(typeTag ? [typeTag] : []), ...(otherTag ? [otherTag] : [])];
    };

    let suggestion: OrganizeSuggestion;

    if (/acme cloud services|dedicated backup storage/i.test(combined)) {
      suggestion = {
        title: `${datePrefix} Acme Cloud Services – Dedicated Backup Storage Invoice`,
        notebookId: pickNotebook([/invoice|finance|bill/i, /projects/i, /personal/i, /work/i]),
        tags: pickTags(['invoice', 'acme-cloud']),
        confidence: 0.94,
        documentDate,
        reason: 'Extracted issuer, invoice date, and backup storage renewal details from attachment OCR.',
      };
    } else if (/electricity bill|utility|statement/i.test(combined)) {
      suggestion = {
        title: isScannerStyleTitle(currentTitle) ? `${datePrefix} Utility Provider – Electricity Bill` : currentTitle,
        notebookId: pickNotebook([/bill|finance|personal/i, /reading|work/i], false),
        tags: pickTags(['bill', existingTags.includes('important') ? 'important' : 'utility-provider']),
        confidence: 0.88,
        documentDate,
        reason: 'Matched utility bill content and kept the descriptive note title.',
      };
    } else if (/markdown extras|math, diagrams/i.test(combined)) {
      suggestion = {
        title: currentTitle,
        notebookId: pickNotebook([/projects/i, /ideas|reading/i]),
        tags: pickTags(['other', existingTags.includes('ideas') ? 'ideas' : 'reference']),
        confidence: 0.58,
        documentDate: null,
        reason: 'Reference note spans work and general syntax examples; please confirm destination.',
      };
    } else if (isScannerStyleTitle(currentTitle)) {
      const firstMeaningfulLine =
        sanitizeLine(
          (ocrText || bodyText)
            .split('\n')
            .map((l) => l.trim())
            .find((l) => l.length >= 3) ?? ''
        ) || 'Scanned Document';
      const shortSubject = firstMeaningfulLine.slice(0, 48).replace(DOC_EXTENSION_RE, '').trim();
      const lowerHint = combinedLower;
      const notebookPatterns =
        /recipe|cooking|ramen|sourdough/.test(lowerHint)
          ? [/recipe|personal/i]
          : /travel|flight|hotel|train|lisbon|porto/.test(lowerHint)
          ? [/travel|personal/i]
          : /meeting|sync|agenda/.test(lowerHint)
          ? [/meeting|work/i]
          : [/projects|work|personal|reading/i];

      suggestion = {
        title: `${datePrefix} ${shortSubject} – Document`,
        notebookId: pickNotebook(notebookPatterns),
        tags: pickTags([
          'other',
          existingTags.find((t) => lowerHint.includes(t)) ?? 'scanned',
        ]),
        confidence: ocrText ? 0.86 : 0.62,
        documentDate,
        reason: ocrText
          ? 'Generated standardized English title from scanned attachment OCR text.'
          : 'Replaced scanner filename using note creation date and content.',
      };
    } else {
      const lowerHint = combinedLower;
      const matchedTag = existingTags.find((t) => lowerHint.includes(t));
      const notebookPatterns =
        /recipe|miso|ramen|sourdough|cooking/.test(lowerHint)
          ? [/recipes/i, /personal/i]
          : /travel|train|lisbon|porto|passport/.test(lowerHint)
          ? [/travel/i, /personal/i]
          : /book|read|deep work/.test(lowerHint)
          ? [/reading/i]
          : /meeting|sync|attendees/.test(lowerHint)
          ? [/meeting/i, /work/i]
          : /roadmap|api|design|project/.test(lowerHint)
          ? [/projects/i, /work/i]
          : [/work|personal|reading/i];

      const candidateNb = pickNotebook(notebookPatterns, false);
      const highCertainty = Boolean(matchedTag || bodyText.length >= 25);

      suggestion = {
        title: currentTitle,
        notebookId: candidateNb,
        tags: pickTags(['other', matchedTag ?? (existingTags.includes('planning') && /roadmap|sync|plan/.test(lowerHint) ? 'planning' : '')].filter(Boolean)),
        confidence: highCertainty ? 0.85 : 0.61,
        documentDate,
        reason: highCertainty
          ? 'Kept meaningful title and matched notebook and tags from note content.'
          : 'Kept existing title; sparse content gives lower categorization confidence.',
      };
    }

    const promptTokens = Math.max(120, Math.round((systemMsg.length + userMsg.length) / 4));
    const content = JSON.stringify(suggestion);
    const completionTokens = Math.max(35, Math.round(content.length / 4));

    return {
      content,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
    };
  };
}

export class OrganizerService {
  private deps: OrganizerDeps;
  private owners = new Map<string, OwnerJobState>();
  private activeControllers = new Map<string, AbortController>();
  private activeLoops = new Map<string, Promise<void>>();
  private activeRunningJobIds = new Map<string, string>();
  private activeIndexes = new Map<string, NoteSimilarityIndex>();
  private activeSessions = new Map<string, string>();
  private persistTimers = new Map<string, PersistTimerEntry>();
  private initializedFromDisk = false;

  constructor(deps: OrganizerDeps = {}) {
    this.deps = deps;
  }

  /** Whether an in-memory similarity index is currently held for this user's active job. */
  public hasSimilarityIndex(sessionId: string): boolean {
    const ownerKey = noteCache.getOwnerKey(sessionId);
    return this.activeIndexes.has(ownerKey);
  }

  /** Whether a specific job's full item list is currently retained in RAM (helper for tests). */
  public isJobLoadedInMemory(sessionId: string, jobId: string): boolean {
    const ownerKey = noteCache.getOwnerKey(sessionId);
    return Boolean(this.owners.get(ownerKey)?.loadedJobs.has(jobId));
  }

  private resolveConfig() {
    const aiBaseUrl = this.deps.aiBaseUrl !== undefined ? this.deps.aiBaseUrl : config.aiBaseUrl;
    const aiApiKey = this.deps.aiApiKey !== undefined ? this.deps.aiApiKey : config.aiApiKey;
    const aiModel = this.deps.aiModel !== undefined ? this.deps.aiModel : config.aiModel;
    const aiConcurrency = this.deps.aiConcurrency !== undefined ? this.deps.aiConcurrency : config.aiConcurrency;
    const aiFake = this.deps.aiFake !== undefined ? this.deps.aiFake : config.aiFake;
    const aiFakeDelayMs = this.deps.aiFakeDelayMs !== undefined ? this.deps.aiFakeDelayMs : config.aiFakeDelayMs;
    const cacheDir = this.deps.cacheDir !== undefined ? this.deps.cacheDir : config.cacheDir;
    const sleep = this.deps.sleep ?? defaultSleep;
    const retryBaseDelayMs = this.deps.retryBaseDelayMs ?? 500;
    const maxRetries = this.deps.maxRetries ?? 3;
    return {
      aiBaseUrl,
      aiApiKey,
      aiModel,
      aiConcurrency,
      aiFake,
      aiFakeDelayMs,
      cacheDir,
      sleep,
      retryBaseDelayMs,
      maxRetries,
    };
  }

  public isEnabled(): boolean {
    const cfg = this.resolveConfig();
    return Boolean(cfg.aiBaseUrl && cfg.aiModel);
  }

  public getStatus(sessionId?: string): OrganizeStatus {
    if (sessionId) {
      this.attachSession(sessionId);
    } else {
      this.ensureLoadedFromDisk();
    }
    const cfg = this.resolveConfig();
    if (!cfg.aiBaseUrl || !cfg.aiModel) {
      return { enabled: false };
    }
    return {
      enabled: true,
      model: cfg.aiModel,
    };
  }

  private jobsDir(): string | null {
    const { cacheDir } = this.resolveConfig();
    return cacheDir ? join(cacheDir, 'organize') : null;
  }

  private ownerJobsDir(ownerKey: string): string | null {
    const dir = this.jobsDir();
    if (!dir || !OWNER_KEY_RE.test(ownerKey)) return null;
    return join(dir, ownerKey);
  }

  private legacyJobFilePath(ownerKey: string): string | null {
    const dir = this.jobsDir();
    if (!dir || !OWNER_KEY_RE.test(ownerKey)) return null;
    return join(dir, `${ownerKey}.json`);
  }

  private indexFilePath(ownerKey: string): string | null {
    const ownerDir = this.ownerJobsDir(ownerKey);
    return ownerDir ? join(ownerDir, ORGANIZE_INDEX_FILE) : null;
  }

  private jobFilePath(ownerKey: string, jobId: string): string | null {
    const ownerDir = this.ownerJobsDir(ownerKey);
    if (!ownerDir || !SAFE_JOB_ID_RE.test(jobId)) return null;
    return join(ownerDir, `${jobId}.json`);
  }

  private persistKey(ownerKey: string, jobId: string): string {
    return `${ownerKey}:${jobId}`;
  }

  private hasPendingPersistTimer(ownerKey: string, jobId: string): boolean {
    return this.persistTimers.has(this.persistKey(ownerKey, jobId));
  }

  private writeJobFileSync(ownerKey: string, job: InternalOrganizeJob): boolean {
    const ownerDir = this.ownerJobsDir(ownerKey);
    const filePath = this.jobFilePath(ownerKey, job.id);
    if (!ownerDir || !filePath) return false;
    try {
      mkdirSync(ownerDir, { recursive: true, mode: 0o700 });
      const payload: PersistedJobFileV2 = { version: 2, job };
      writeFileSync(`${filePath}.tmp`, JSON.stringify(payload), { mode: 0o600 });
      renameSync(`${filePath}.tmp`, filePath);
      return true;
    } catch (err) {
      console.error(`[Organizer] Failed to persist job ${job.id} for ${ownerKey}:`, err);
      return false;
    }
  }

  private writeIndexFileSync(ownerKey: string, summaries: OrganizeJobSummary[]): boolean {
    const ownerDir = this.ownerJobsDir(ownerKey);
    const indexPath = this.indexFilePath(ownerKey);
    if (!ownerDir || !indexPath) return false;
    try {
      mkdirSync(ownerDir, { recursive: true, mode: 0o700 });
      const payload: PersistedOrganizeIndexFile = { version: 2, jobs: summaries };
      writeFileSync(`${indexPath}.tmp`, JSON.stringify(payload), { mode: 0o600 });
      renameSync(`${indexPath}.tmp`, indexPath);
      return true;
    } catch (err) {
      console.error(`[Organizer] Failed to persist job index for ${ownerKey}:`, err);
      return false;
    }
  }

  private upsertSummary(state: OwnerJobState, job: InternalOrganizeJob): void {
    const summary = computeJobSummary(job);
    const idx = state.summaries.findIndex((s) => s.id === job.id);
    if (idx >= 0) {
      state.summaries[idx] = summary;
    } else {
      state.summaries.unshift(summary);
    }
    sortSummariesNewestFirst(state.summaries);
  }

  private enforceRetentionCap(ownerKey: string, state: OwnerJobState): boolean {
    let removedAny = false;
    while (state.summaries.length > MAX_RETAINED_JOBS) {
      let dropIndex = -1;
      for (let i = state.summaries.length - 1; i >= 0; i--) {
        const candidate = state.summaries[i];
        if (candidate.status !== 'running' && this.activeRunningJobIds.get(ownerKey) !== candidate.id) {
          dropIndex = i;
          break;
        }
      }
      if (dropIndex === -1) {
        dropIndex = state.summaries.length - 1;
      }
      const [removed] = state.summaries.splice(dropIndex, 1);
      removedAny = true;
      const pKey = this.persistKey(ownerKey, removed.id);
      const pending = this.persistTimers.get(pKey);
      if (pending) {
        clearTimeout(pending.timer);
        this.persistTimers.delete(pKey);
      }
      state.loadedJobs.delete(removed.id);
      if (state.lastViewedFinishedJobId === removed.id) {
        state.lastViewedFinishedJobId = null;
      }
      const jobFile = this.jobFilePath(ownerKey, removed.id);
      if (jobFile && existsSync(jobFile)) {
        try {
          unlinkSync(jobFile);
        } catch (err) {
          console.error(`[Organizer] Failed to delete evicted job file ${jobFile}:`, err);
        }
      }
    }
    return removedAny;
  }

  /**
   * When disk persistence is enabled, keep only running jobs plus at most one recently viewed
   * finished job in RAM so large backlogs never hold thousands of notes in memory simultaneously.
   */
  private markJobAccessed(ownerKey: string, state: OwnerJobState, job: InternalOrganizeJob): void {
    if (!this.jobsDir() || job.status === 'running') return;
    state.lastViewedFinishedJobId = job.id;
    for (const [loadedId, loadedJob] of state.loadedJobs) {
      if (loadedJob.status === 'running') continue;
      if (loadedId === state.lastViewedFinishedJobId) continue;
      if (this.hasPendingPersistTimer(ownerKey, loadedId)) continue;
      state.loadedJobs.delete(loadedId);
    }
  }

  private saveJobNow(ownerKey: string, jobId: string): void {
    const pKey = this.persistKey(ownerKey, jobId);
    const pendingTimer = this.persistTimers.get(pKey);
    if (pendingTimer) {
      clearTimeout(pendingTimer.timer);
      this.persistTimers.delete(pKey);
    }
    const state = this.owners.get(ownerKey);
    const job = state?.loadedJobs.get(jobId);
    if (!state || !job) return;

    this.upsertSummary(state, job);
    this.enforceRetentionCap(ownerKey, state);

    if (!this.jobsDir()) return;
    this.writeJobFileSync(ownerKey, job);
    this.writeIndexFileSync(ownerKey, state.summaries);
  }

  private scheduleSave(ownerKey: string, jobId: string): void {
    const pKey = this.persistKey(ownerKey, jobId);
    if (!this.jobsDir() || this.persistTimers.has(pKey)) return;
    const timer = setTimeout(() => {
      this.persistTimers.delete(pKey);
      this.saveJobNow(ownerKey, jobId);
    }, PERSIST_DEBOUNCE_MS);
    timer.unref?.();
    this.persistTimers.set(pKey, { ownerKey, jobId, timer });
  }

  private loadJobFromDisk(ownerKey: string, jobId: string): InternalOrganizeJob | null {
    const filePath = this.jobFilePath(ownerKey, jobId);
    if (!filePath) return null;
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<PersistedJobFileV2>;
      if (parsed?.version !== 2 || !parsed.job) return null;
      const job = parsed.job;
      if (typeof job.id !== 'string' || job.id !== jobId) return null;
      if (job.ownerKey && job.ownerKey !== ownerKey) return null;
      if (!job.ownerKey) job.ownerKey = ownerKey;
      return normalizeLoadedJob(job);
    } catch {
      return null;
    }
  }

  private readIndexSummariesFromDisk(ownerKey: string): OrganizeJobSummary[] | null {
    const indexPath = this.indexFilePath(ownerKey);
    if (!indexPath || !existsSync(indexPath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as Partial<PersistedOrganizeIndexFile>;
      if (parsed?.version !== 2 || !Array.isArray(parsed.jobs)) return null;
      const summaries = parsed.jobs.filter(
        (s): s is OrganizeJobSummary =>
          Boolean(s && typeof s.id === 'string' && SAFE_JOB_ID_RE.test(s.id) && typeof s.status === 'string')
      );
      sortSummariesNewestFirst(summaries);
      return summaries;
    } catch {
      return null;
    }
  }

  private reconstructIndexFromJobFiles(ownerKey: string): OrganizeJobSummary[] {
    const ownerDir = this.ownerJobsDir(ownerKey);
    if (!ownerDir || !existsSync(ownerDir)) return [];
    let files: string[];
    try {
      files = readdirSync(ownerDir).filter((name) => name.endsWith('.json') && name !== ORGANIZE_INDEX_FILE);
    } catch {
      return [];
    }
    const summaries: OrganizeJobSummary[] = [];
    for (const file of files) {
      const jobId = file.replace(/\.json$/, '');
      if (!SAFE_JOB_ID_RE.test(jobId)) continue;
      const job = this.loadJobFromDisk(ownerKey, jobId);
      if (!job) continue;
      summaries.push(computeJobSummary(job));
    }
    sortSummariesNewestFirst(summaries);
    return summaries;
  }

  private migrateLegacyOwnerFile(ownerKey: string, state: OwnerJobState): boolean {
    const legacyPath = this.legacyJobFilePath(ownerKey);
    if (!legacyPath || !existsSync(legacyPath)) return false;

    let legacyJobs: InternalOrganizeJob[] = [];
    try {
      const raw = JSON.parse(readFileSync(legacyPath, 'utf8')) as
        | Partial<PersistedJobFileV1>
        | Partial<PersistedLegacyJobsV2>;
      if (raw?.version === 1 && 'job' in raw && raw.job) {
        const job = raw.job;
        if (typeof job.id === 'string' && SAFE_JOB_ID_RE.test(job.id) && (!job.ownerKey || job.ownerKey === ownerKey)) {
          if (!job.ownerKey) job.ownerKey = ownerKey;
          legacyJobs = [normalizeLoadedJob(job)];
        }
      } else if (raw?.version === 2 && 'jobs' in raw && Array.isArray(raw.jobs)) {
        for (const job of raw.jobs) {
          if (
            job &&
            typeof job.id === 'string' &&
            SAFE_JOB_ID_RE.test(job.id) &&
            (!job.ownerKey || job.ownerKey === ownerKey)
          ) {
            if (!job.ownerKey) job.ownerKey = ownerKey;
            legacyJobs.push(normalizeLoadedJob(job));
          }
        }
      }
    } catch (err) {
      console.error(`[Organizer] Failed to parse legacy organize file ${legacyPath}:`, err);
      return false;
    }

    if (legacyJobs.length === 0) {
      return false;
    }

    let allWritten = true;
    for (const job of legacyJobs) {
      const existingSummary = state.summaries.find((s) => s.id === job.id);
      if (!existingSummary) {
        if (!this.writeJobFileSync(ownerKey, job)) {
          allWritten = false;
          continue;
        }
        this.upsertSummary(state, job);
      }
      if (job.status === 'running') {
        state.loadedJobs.set(job.id, job);
      }
    }

    this.enforceRetentionCap(ownerKey, state);
    if (!this.writeIndexFileSync(ownerKey, state.summaries)) {
      allWritten = false;
    }

    if (allWritten) {
      try {
        unlinkSync(legacyPath);
      } catch (err) {
        console.error(`[Organizer] Migrated ${legacyPath} to v2, but failed to remove legacy file:`, err);
      }
    }
    return true;
  }

  private getOrLoadOwnerState(ownerKey: string): OwnerJobState {
    let state = this.owners.get(ownerKey);
    const legacyPath = this.legacyJobFilePath(ownerKey);
    const hasLegacyFile = Boolean(legacyPath && existsSync(legacyPath));

    if (!state) {
      state = {
        summaries: [],
        loadedJobs: new Map(),
        lastViewedFinishedJobId: null,
      };
      this.owners.set(ownerKey, state);

      const diskSummaries = this.readIndexSummariesFromDisk(ownerKey);
      if (diskSummaries !== null) {
        state.summaries = diskSummaries;
      } else {
        const rebuilt = this.reconstructIndexFromJobFiles(ownerKey);
        if (rebuilt.length > 0) {
          state.summaries = rebuilt;
          this.writeIndexFileSync(ownerKey, state.summaries);
        }
      }

      if (hasLegacyFile) {
        this.migrateLegacyOwnerFile(ownerKey, state);
      }

      const capped = this.enforceRetentionCap(ownerKey, state);
      if (capped) {
        this.writeIndexFileSync(ownerKey, state.summaries);
      }

      // Eagerly load only running job(s); finished jobs load lazily on demand
      for (const summary of state.summaries) {
        if (summary.status !== 'running' || state.loadedJobs.has(summary.id)) continue;
        const job = this.loadJobFromDisk(ownerKey, summary.id);
        if (job) {
          state.loadedJobs.set(job.id, job);
        }
      }
      return state;
    }

    if (hasLegacyFile) {
      this.migrateLegacyOwnerFile(ownerKey, state);
      for (const summary of state.summaries) {
        if (summary.status !== 'running' || state.loadedJobs.has(summary.id)) continue;
        const job = this.loadJobFromDisk(ownerKey, summary.id);
        if (job) {
          state.loadedJobs.set(job.id, job);
        }
      }
    }
    return state;
  }

  private ensureLoadedFromDisk(): void {
    if (this.initializedFromDisk) return;
    this.initializedFromDisk = true;
    const dir = this.jobsDir();
    if (!dir || !existsSync(dir)) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const ownerKeys = new Set<string>();
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.tmp')) {
        const ownerKey = entry.name.slice(0, -5);
        if (OWNER_KEY_RE.test(ownerKey)) ownerKeys.add(ownerKey);
      } else if (entry.isDirectory() && OWNER_KEY_RE.test(entry.name)) {
        ownerKeys.add(entry.name);
      }
    }

    for (const ownerKey of ownerKeys) {
      this.getOrLoadOwnerState(ownerKey);
    }
  }

  /**
   * Loads persisted organize jobs from CACHE_DIR on startup and immediately resumes any unfinished
   * job whose user note cache exists in CACHE_DIR.
   */
  public resumeFromDiskOnStartup(): void {
    this.ensureLoadedFromDisk();
    if (!this.isEnabled()) return;
    for (const [ownerKey, state] of this.owners) {
      const runningSummary = state.summaries.find((s) => s.status === 'running');
      if (!runningSummary || this.activeLoops.has(ownerKey)) continue;
      let job = state.loadedJobs.get(runningSummary.id);
      if (!job) {
        job = this.loadJobFromDisk(ownerKey, runningSummary.id) ?? undefined;
        if (job) state.loadedJobs.set(job.id, job);
      }
      if (!job || job.status !== 'running') continue;
      const savedEntry = noteCache.loadSavedEntryByOwnerKey(ownerKey);
      if (savedEntry) {
        this.startWorkerLoop(ownerKey, job, undefined, savedEntry);
      }
    }
  }

  /**
   * Records a live authenticated `sessionId` for its owner and resumes any persisted running job
   * on first access after a server restart.
   */
  public attachSession(sessionId: string): string {
    this.ensureLoadedFromDisk();
    const ownerKey = noteCache.getOwnerKey(sessionId);
    this.activeSessions.set(ownerKey, sessionId);

    const state = this.getOrLoadOwnerState(ownerKey);
    const runningSummary = state.summaries.find((s) => s.status === 'running');
    if (runningSummary && this.isEnabled() && !this.activeLoops.has(ownerKey)) {
      let job = state.loadedJobs.get(runningSummary.id);
      if (!job) {
        job = this.loadJobFromDisk(ownerKey, runningSummary.id) ?? undefined;
        if (job) state.loadedJobs.set(job.id, job);
      }
      if (job && job.status === 'running') {
        this.startWorkerLoop(ownerKey, job, sessionId);
      }
    }
    return ownerKey;
  }

  private getCompletionClient(): LlmCompletionFn {
    if (this.deps.completionFn) return this.deps.completionFn;
    const cfg = this.resolveConfig();
    if (cfg.aiFake) {
      return createFakeCompletionClient(cfg.aiFakeDelayMs, cfg.sleep);
    }
    if (!cfg.aiBaseUrl || !cfg.aiModel) {
      throw new OrganizeValidationError('Auto-organize is not configured', 503);
    }
    return createOpenAiCompletionClient({
      baseUrl: cfg.aiBaseUrl,
      apiKey: cfg.aiApiKey,
      model: cfg.aiModel,
      sleep: cfg.sleep,
      retryBaseDelayMs: cfg.retryBaseDelayMs,
      maxRetries: cfg.maxRetries,
    });
  }

  private findRunningJobId(ownerKey: string, state: OwnerJobState, excludeJobId?: string): string | null {
    const activeId = this.activeRunningJobIds.get(ownerKey);
    if (activeId && activeId !== excludeJobId) return activeId;
    const summaryRunning = state.summaries.find((s) => s.status === 'running' && s.id !== excludeJobId);
    return summaryRunning ? summaryRunning.id : null;
  }

  public listJobs(sessionId: string): { jobs: OrganizeJobSummary[] } {
    const ownerKey = this.attachSession(sessionId);
    const state = this.getOrLoadOwnerState(ownerKey);
    for (const job of state.loadedJobs.values()) {
      this.upsertSummary(state, job);
    }
    sortSummariesNewestFirst(state.summaries);
    return {
      jobs: state.summaries.map((s) => ({
        ...s,
        progress: { ...s.progress },
        usage: { ...s.usage },
      })),
    };
  }

  /**
   * Creates and starts an Auto-organize background job for `noteIds`. Refuses with 409 when another
   * job for the same owner is already running.
   */
  public async startJob(
    sessionId: string,
    input: { noteIds?: unknown; excludeNotebookIds?: unknown }
  ): Promise<{ jobId: string }> {
    if (!this.isEnabled()) {
      throw new OrganizeValidationError('Auto-organize is not configured on this server', 503);
    }
    const ownerKey = this.attachSession(sessionId);

    if (!Array.isArray(input.noteIds) || input.noteIds.length === 0) {
      throw new OrganizeValidationError('noteIds must be a non-empty array');
    }
    if (input.noteIds.length > MAX_ORGANIZE_NOTES) {
      throw new OrganizeValidationError(`Cannot auto-organize more than ${MAX_ORGANIZE_NOTES} notes per job`);
    }
    const uniqueNoteIds: string[] = [];
    const seenNoteIds = new Set<string>();
    for (const rawId of input.noteIds) {
      if (typeof rawId !== 'string') {
        throw new OrganizeValidationError('noteIds must contain strings only');
      }
      assertValidId(rawId, 'note id');
      if (!seenNoteIds.has(rawId)) {
        seenNoteIds.add(rawId);
        uniqueNoteIds.push(rawId);
      }
    }

    const excludeSet = new Set<string>();
    if (input.excludeNotebookIds !== undefined) {
      if (!Array.isArray(input.excludeNotebookIds)) {
        throw new OrganizeValidationError('excludeNotebookIds must be an array of notebook ids');
      }
      if (input.excludeNotebookIds.length > MAX_EXCLUDED_NOTEBOOKS) {
        throw new OrganizeValidationError(`Cannot exclude more than ${MAX_EXCLUDED_NOTEBOOKS} notebooks`);
      }
      for (const rawNbId of input.excludeNotebookIds) {
        if (typeof rawNbId !== 'string') {
          throw new OrganizeValidationError('excludeNotebookIds must contain strings only');
        }
        assertValidId(rawNbId, 'notebook id');
        excludeSet.add(rawNbId);
      }
    }

    const state = this.getOrLoadOwnerState(ownerKey);
    const runningJobId = this.findRunningJobId(ownerKey, state);
    if (runningJobId) {
      throw new OrganizeValidationError(
        `Another Auto-organize job (${runningJobId}) is already running. Cancel it before starting a new job.`,
        409,
        { runningJobId }
      );
    }

    const entry = await noteCache.ensureFresh(sessionId, 'stale-ok');
    const { systemPrompt, allowedNotebookIds, pathById } = buildOrganizeSystemPrompt(entry, excludeSet);

    const items: InternalJobItem[] = uniqueNoteIds.map((noteId) => {
      const note = entry.notes.get(noteId);
      if (!note) {
        return {
          noteId,
          currentTitle: '',
          currentNotebookId: '',
          currentNotebookPath: '',
          updatedTime: 0,
          status: 'failed',
          skipped: true,
          error: 'Note not found',
        };
      }
      if (note.properties.encryption_applied === '1') {
        return {
          noteId,
          currentTitle: 'Encrypted note',
          currentNotebookId: note.parentId || '',
          currentNotebookPath: resolveNotebookPath(entry, note.parentId || '', pathById),
          updatedTime: note.updatedTime,
          status: 'failed',
          skipped: true,
          error: 'Encrypted notes cannot be read or organized',
        };
      }
      if (note.deletedTime > 0 || isConflictNote(note) || (note.parentId && isNotebookTrashed(entry, note.parentId))) {
        return {
          noteId,
          currentTitle: note.title,
          currentNotebookId: note.parentId || '',
          currentNotebookPath: resolveNotebookPath(entry, note.parentId || '', pathById),
          updatedTime: note.updatedTime,
          status: 'failed',
          skipped: true,
          error: isConflictNote(note) ? 'Conflict copies cannot be auto-organized here' : 'Trashed notes cannot be organized',
        };
      }
      return {
        noteId,
        currentTitle: note.title,
        currentNotebookId: note.parentId || '',
        currentNotebookPath: pathById.get(note.parentId || '') ?? '',
        updatedTime: note.updatedTime,
        status: 'pending',
      };
    });

    const hasPending = items.some((i) => i.status === 'pending');
    const createdAt = Math.max(Date.now(), (state.summaries[0]?.createdAt ?? 0) + 1);
    const job: InternalOrganizeJob = {
      id: randomUUID().replace(/-/g, ''),
      ownerKey,
      status: hasPending ? 'running' : 'done',
      excludeNotebookIds: [...excludeSet],
      allowedNotebookIds,
      systemPrompt,
      items,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      lastUndo: null,
      createdAt,
      updatedAt: createdAt,
    };

    state.loadedJobs.set(job.id, job);
    this.saveJobNow(ownerKey, job.id);

    if (hasPending) {
      const similarityIndex = buildNoteSimilarityIndex(entry, {
        excludeNotebookIds: excludeSet,
        excludeNoteIds: seenNoteIds,
      });
      this.startWorkerLoop(ownerKey, job, sessionId, undefined, similarityIndex);
    } else {
      this.markJobAccessed(ownerKey, state, job);
    }

    return { jobId: job.id };
  }

  private startWorkerLoop(
    ownerKey: string,
    job: InternalOrganizeJob,
    initialSessionId?: string,
    initialEntry?: CacheEntry,
    initialSimilarityIndex?: NoteSimilarityIndex
  ): void {
    if (this.activeLoops.has(ownerKey)) return;

    const controller = new AbortController();
    this.activeControllers.set(ownerKey, controller);
    this.activeRunningJobIds.set(ownerKey, job.id);

    const cfg = this.resolveConfig();
    const concurrency = Math.max(1, cfg.aiConcurrency);
    const allowedSet = new Set(job.allowedNotebookIds);
    const excludeSet = new Set(job.excludeNotebookIds);
    const jobNoteIds = new Set(job.items.map((it) => it.noteId));
    const completionFn = this.getCompletionClient();

    let similarityIndex: NoteSimilarityIndex | null = initialSimilarityIndex ?? null;
    if (similarityIndex) {
      this.activeIndexes.set(ownerKey, similarityIndex);
    }

    const ensureSimilarityIndex = (entry: CacheEntry): NoteSimilarityIndex => {
      if (!similarityIndex) {
        similarityIndex = buildNoteSimilarityIndex(entry, {
          excludeNotebookIds: excludeSet,
          excludeNoteIds: jobNoteIds,
        });
        this.activeIndexes.set(ownerKey, similarityIndex);
      }
      return similarityIndex;
    };

    let loopPromise: Promise<void> | undefined;
    loopPromise = (async () => {
      try {
        let nextIndex = 0;

        const runOne = async (): Promise<void> => {
          while (!controller.signal.aborted && job.status === 'running') {
            const idx = nextIndex++;
            if (idx >= job.items.length) return;
            const item = job.items[idx];
            if (item.status !== 'pending') continue;

            item.status = 'running';
            job.updatedAt = Date.now();

            try {
              const liveSessionId = this.activeSessions.get(ownerKey) ?? initialSessionId;
              const entry = liveSessionId
                ? await noteCache.ensureFresh(liveSessionId, 'stale-ok')
                : initialEntry ?? noteCache.loadSavedEntryByOwnerKey(ownerKey);

              if (controller.signal.aborted || job.status !== 'running') {
                if (item.status === 'running') item.status = 'pending';
                return;
              }

              if (!entry) {
                item.status = 'pending';
                controller.abort('waiting-for-session');
                return;
              }

              const note = entry.notes.get(item.noteId);
              if (!note) {
                item.status = 'failed';
                item.skipped = true;
                item.error = 'Note not found';
                job.updatedAt = Date.now();
                this.scheduleSave(ownerKey, job.id);
                continue;
              }
              if (note.properties.encryption_applied === '1') {
                item.status = 'failed';
                item.skipped = true;
                item.error = 'Encrypted notes cannot be read or organized';
                job.updatedAt = Date.now();
                this.scheduleSave(ownerKey, job.id);
                continue;
              }
              if (
                note.deletedTime > 0 ||
                isConflictNote(note) ||
                (note.parentId && isNotebookTrashed(entry, note.parentId))
              ) {
                item.status = 'failed';
                item.skipped = true;
                item.error = isConflictNote(note)
                  ? 'Conflict copies cannot be auto-organized here'
                  : 'Trashed notes cannot be organized';
                job.updatedAt = Date.now();
                this.scheduleSave(ownerKey, job.id);
                continue;
              }

              const index = ensureSimilarityIndex(entry);
              const bodyText = stripLinksFromBody(note.body, markupLanguageOf(note.properties), MAX_BODY_CHARS);
              const attachmentFilenames: string[] = [];
              const seenFilenames = new Set<string>();
              for (const resId of extractLinkedResourceIds(note.body)) {
                const res = entry.resources.get(resId);
                const filename = sanitizeLine(res?.filename || res?.title || '');
                if (filename && !seenFilenames.has(filename)) {
                  seenFilenames.add(filename);
                  attachmentFilenames.push(filename);
                }
              }

              const ocrText = liveSessionId
                ? await noteCache.getNoteAttachmentText(liveSessionId, item.noteId, { maxChars: MAX_OCR_CHARS })
                : noteCache.getAttachmentTextFromEntry(entry, item.noteId, { maxChars: MAX_OCR_CHARS });

              if (controller.signal.aborted || job.status !== 'running') {
                if (item.status === 'running') item.status = 'pending';
                return;
              }

              const similarNotes = ocrText.trim() ? index.findSimilar(ocrText, MAX_SIMILAR_NOTES) : [];
              const userPrompt = buildOrganizeUserPrompt({
                currentTitle: note.title,
                currentNotebookId: note.parentId || '',
                currentNotebookPath: item.currentNotebookPath,
                createdDate: formatIsoDate(note.createdTime || note.updatedTime),
                bodyText,
                attachmentFilenames,
                ocrText,
                similarNotes,
              });

              const messages: LlmMessage[] = [
                { role: 'system', content: job.systemPrompt },
                { role: 'user', content: userPrompt },
              ];

              const addUsage = (usage?: Partial<OrganizeUsage>) => {
                if (!usage) return;
                const p = typeof usage.promptTokens === 'number' ? usage.promptTokens : 0;
                const c = typeof usage.completionTokens === 'number' ? usage.completionTokens : 0;
                const t = typeof usage.totalTokens === 'number' ? usage.totalTokens : p + c;
                job.usage.promptTokens += p;
                job.usage.completionTokens += c;
                job.usage.totalTokens += t;
              };

              const firstResult = await completionFn(messages, controller.signal);
              addUsage(firstResult.usage);

              let validation = parseAndValidateSuggestion(firstResult.content, {
                currentTitle: note.title,
                currentNotebookId: note.parentId || '',
                allowedNotebookIds: allowedSet,
              });

              if (!validation.ok) {
                if (controller.signal.aborted || job.status !== 'running') {
                  if (item.status === 'running') item.status = 'pending';
                  return;
                }
                const repairMessages: LlmMessage[] = [
                  ...messages,
                  { role: 'assistant', content: firstResult.content },
                  {
                    role: 'user',
                    content: `Your previous response was invalid (${validation.error}). Reply ONLY with a valid JSON object matching { "title": string, "notebookId": string, "tags": string[], "confidence": number, "documentDate": "YYYY-MM-DD" | null, "reason": string }.`,
                  },
                ];
                const repairResult = await completionFn(repairMessages, controller.signal);
                addUsage(repairResult.usage);
                validation = parseAndValidateSuggestion(repairResult.content, {
                  currentTitle: note.title,
                  currentNotebookId: note.parentId || '',
                  allowedNotebookIds: allowedSet,
                });
              }

              if (!validation.ok) {
                item.status = 'failed';
                item.error = 'Model returned invalid suggestion JSON';
              } else {
                item.status = 'done';
                delete item.error;
                delete item.skipped;
                item.suggestion = validation.suggestion;
              }
            } catch (err) {
              if (controller.signal.aborted) {
                if (item.status === 'running') item.status = 'pending';
                return;
              }
              item.status = 'failed';
              item.error = err instanceof Error ? err.message : 'Failed to analyse note';
            }

            job.updatedAt = Date.now();
            this.scheduleSave(ownerKey, job.id);
          }
        };

        await Promise.all(Array.from({ length: Math.min(concurrency, job.items.length) }, runOne));

        if (!controller.signal.aborted && job.status === 'running') {
          job.status = 'done';
          job.updatedAt = Date.now();
        }
      } finally {
        if (this.activeControllers.get(ownerKey) === controller) {
          this.activeControllers.delete(ownerKey);
        }
        if (loopPromise && this.activeLoops.get(ownerKey) === loopPromise) {
          this.activeLoops.delete(ownerKey);
          this.activeRunningJobIds.delete(ownerKey);
          this.activeIndexes.delete(ownerKey);
        } else if (similarityIndex && this.activeIndexes.get(ownerKey) === similarityIndex) {
          this.activeIndexes.delete(ownerKey);
        }
        similarityIndex = null;
        initialSimilarityIndex = undefined;
        this.saveJobNow(ownerKey, job.id);
        const ownerState = this.owners.get(ownerKey);
        if (ownerState && job.status !== 'running') {
          this.markJobAccessed(ownerKey, ownerState, job);
        }
      }
    })();

    this.activeLoops.set(ownerKey, loopPromise);
  }

  private assertOwnerJob(
    sessionId: string,
    jobId: string
  ): { ownerKey: string; state: OwnerJobState; job: InternalOrganizeJob } {
    if (!SAFE_JOB_ID_RE.test(jobId)) {
      throw new OrganizeValidationError('Invalid job id');
    }
    const ownerKey = this.attachSession(sessionId);
    const state = this.getOrLoadOwnerState(ownerKey);
    const hasSummary = state.summaries.some((s) => s.id === jobId);
    let job = state.loadedJobs.get(jobId);
    if (!job && hasSummary) {
      job = this.loadJobFromDisk(ownerKey, jobId) ?? undefined;
      if (job) {
        state.loadedJobs.set(job.id, job);
      }
    }
    if (!hasSummary || !job) {
      throw new OrganizeValidationError(`Organize job not found: ${jobId}`, 404);
    }
    this.markJobAccessed(ownerKey, state, job);
    return { ownerKey, state, job };
  }

  public async getJob(
    sessionId: string,
    jobId: string,
    query: { offset?: number; limit?: number } = {}
  ): Promise<OrganizeJobResponse> {
    const { ownerKey, job } = this.assertOwnerJob(sessionId, jobId);

    const offset = Number.isFinite(query.offset) && (query.offset ?? 0) >= 0 ? Math.floor(query.offset!) : 0;
    const rawLimit = Number.isFinite(query.limit) ? Math.floor(query.limit!) : 100;
    const limit = Math.max(1, Math.min(500, rawLimit || 100));

    const entry = noteCache.peekEntry(sessionId) ?? noteCache.loadSavedEntryByOwnerKey(ownerKey);
    const pathById = entry ? buildNotebookPaths(entry).pathById : null;
    const existingTags = new Set(
      entry
        ? [...entry.tags.values()].filter((t) => !(t.deletedTime > 0)).map((t) => t.title.trim().toLowerCase())
        : []
    );
    const keepTag = recurringTagFilter(job.items, existingTags);

    let done = 0;
    let failed = 0;
    let appliedCount = 0;
    let retryableFailedCount = 0;
    for (const item of job.items) {
      if (item.status === 'done') done++;
      else if (item.status === 'failed') {
        failed++;
        if (classifyRetryability(item, entry).retryable) {
          retryableFailedCount++;
        }
      }
      if (item.applied) appliedCount++;
    }

    const slice = job.items.slice(offset, offset + limit).map((item): OrganizeJobItem => {
      const liveNote = entry?.notes.get(item.noteId);
      const currentTitle = liveNote ? liveNote.title : item.currentTitle;
      const currentNotebookId = liveNote ? liveNote.parentId || '' : item.currentNotebookId;
      const currentNotebookPath =
        (pathById && currentNotebookId ? pathById.get(currentNotebookId) : undefined) ?? item.currentNotebookPath;
      const updatedTime = liveNote ? liveNote.updatedTime : item.updatedTime;
      const isNonRetryableFailed = item.status === 'failed' && !classifyRetryability(item, entry).retryable;
      return {
        ...item,
        ...(isNonRetryableFailed ? { skipped: true } : {}),
        currentTitle,
        currentNotebookId,
        currentNotebookPath,
        updatedTime,
        ...(item.suggestion ? { suggestion: { ...item.suggestion, tags: item.suggestion.tags.filter(keepTag) } } : {}),
      };
    });

    return {
      id: job.id,
      status: job.status,
      ...(job.error ? { error: job.error } : {}),
      excludeNotebookIds: [...job.excludeNotebookIds],
      progress: {
        total: job.items.length,
        done,
        failed,
      },
      appliedCount,
      retryableFailedCount,
      usage: { ...job.usage },
      offset,
      limit,
      totalItems: job.items.length,
      canUndo: Boolean(job.lastUndo && job.lastUndo.items.length > 0),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      items: slice,
    };
  }

  public async cancelJob(sessionId: string, jobId: string): Promise<{ id: string; status: OrganizeJobStatus }> {
    const { ownerKey, state, job } = this.assertOwnerJob(sessionId, jobId);
    if (job.status === 'running') {
      job.status = 'cancelled';
      job.updatedAt = Date.now();
      if (this.activeRunningJobIds.get(ownerKey) === job.id) {
        this.activeControllers.get(ownerKey)?.abort('cancelled');
        await this.activeLoops.get(ownerKey)?.catch(() => undefined);
        this.activeIndexes.delete(ownerKey);
      }
      for (const item of job.items) {
        if (item.status === 'running') item.status = 'pending';
      }
      this.saveJobNow(ownerKey, job.id);
      this.markJobAccessed(ownerKey, state, job);
    }
    return { id: job.id, status: job.status };
  }

  public async deleteJob(sessionId: string, jobId: string): Promise<OrganizeDeleteResponse> {
    if (!SAFE_JOB_ID_RE.test(jobId)) {
      throw new OrganizeValidationError('Invalid job id');
    }
    const ownerKey = this.attachSession(sessionId);
    const state = this.getOrLoadOwnerState(ownerKey);
    const summaryIdx = state.summaries.findIndex((s) => s.id === jobId);
    if (summaryIdx < 0) {
      throw new OrganizeValidationError(`Organize job not found: ${jobId}`, 404);
    }
    const summary = state.summaries[summaryIdx];
    if (summary.status === 'running' || this.activeRunningJobIds.get(ownerKey) === jobId) {
      throw new OrganizeValidationError(
        `Cancel the running job (${jobId}) before deleting it.`,
        409,
        { runningJobId: jobId }
      );
    }

    const pKey = this.persistKey(ownerKey, jobId);
    const pending = this.persistTimers.get(pKey);
    if (pending) {
      clearTimeout(pending.timer);
      this.persistTimers.delete(pKey);
    }

    state.summaries.splice(summaryIdx, 1);
    state.loadedJobs.delete(jobId);
    if (state.lastViewedFinishedJobId === jobId) {
      state.lastViewedFinishedJobId = null;
    }

    const jobFile = this.jobFilePath(ownerKey, jobId);
    if (jobFile && existsSync(jobFile)) {
      unlinkSync(jobFile);
    }
    if (this.jobsDir()) {
      this.writeIndexFileSync(ownerKey, state.summaries);
    }

    return { id: jobId, deleted: true };
  }

  public async retryJob(sessionId: string, jobId: string): Promise<OrganizeRetryResponse> {
    if (!this.isEnabled()) {
      throw new OrganizeValidationError('Auto-organize is not configured on this server', 503);
    }
    const { ownerKey, state, job } = this.assertOwnerJob(sessionId, jobId);
    if (job.status === 'running') {
      throw new OrganizeValidationError('This Auto-organize job is already running.', 409, {
        runningJobId: job.id,
      });
    }
    const otherRunningId = this.findRunningJobId(ownerKey, state, job.id);
    if (otherRunningId) {
      throw new OrganizeValidationError(
        `Another Auto-organize job (${otherRunningId}) is already running. Cancel it before retrying this job.`,
        409,
        { runningJobId: otherRunningId }
      );
    }

    const entry = await noteCache.ensureFresh(sessionId, 'stale-ok');
    const excludeSet = new Set(job.excludeNotebookIds);
    const { systemPrompt, allowedNotebookIds, pathById } = buildOrganizeSystemPrompt(entry, excludeSet);

    const retryTargets: Array<{ item: InternalJobItem; liveNote: RawJoplinItem }> = [];
    const liveSkipUpdates: Array<{ item: InternalJobItem; reason: string }> = [];

    for (const item of job.items) {
      if (item.status !== 'failed') continue;
      const verdict = classifyRetryability(item, entry);
      if (verdict.retryable && verdict.liveNote) {
        retryTargets.push({ item, liveNote: verdict.liveNote });
      } else if (!verdict.retryable && verdict.reason && !item.skipped && !NON_RETRYABLE_ERROR_RE.test(item.error ?? '')) {
        liveSkipUpdates.push({ item, reason: verdict.reason });
      }
    }

    if (retryTargets.length === 0) {
      for (const { item, reason } of liveSkipUpdates) {
        item.skipped = true;
        item.error = reason;
      }
      if (liveSkipUpdates.length > 0) {
        job.updatedAt = Date.now();
        this.saveJobNow(ownerKey, job.id);
      }
      throw new OrganizeValidationError('No failed items can be retried for this job.', 409);
    }

    for (const { item, reason } of liveSkipUpdates) {
      item.skipped = true;
      item.error = reason;
    }

    for (const { item, liveNote } of retryTargets) {
      item.status = 'pending';
      delete item.error;
      delete item.skipped;
      delete item.systemRetryCount;
      item.currentTitle = liveNote.title;
      item.currentNotebookId = liveNote.parentId || '';
      item.currentNotebookPath = pathById.get(item.currentNotebookId) ?? '';
      item.updatedTime = liveNote.updatedTime;
    }

    job.systemPrompt = systemPrompt;
    job.allowedNotebookIds = allowedNotebookIds;
    job.status = 'running';
    delete job.error;
    job.updatedAt = Date.now();

    this.saveJobNow(ownerKey, job.id);

    const similarityIndex = buildNoteSimilarityIndex(entry, {
      excludeNotebookIds: excludeSet,
      excludeNoteIds: new Set(job.items.map((it) => it.noteId)),
    });
    this.startWorkerLoop(ownerKey, job, sessionId, undefined, similarityIndex);

    return {
      id: job.id,
      status: job.status,
      requeuedCount: retryTargets.length,
    };
  }

  public async applyJob(
    sessionId: string,
    jobId: string,
    body: { items?: unknown }
  ): Promise<OrganizeApplyResponse> {
    const { ownerKey, job } = this.assertOwnerJob(sessionId, jobId);
    if (!body || !Array.isArray(body.items) || body.items.length === 0) {
      throw new OrganizeValidationError('items must be a non-empty array');
    }

    const parsedInputs: OrganizeApplyItemInput[] = [];
    const seenNoteIds = new Set<string>();
    for (const raw of body.items) {
      if (!raw || typeof raw !== 'object') {
        throw new OrganizeValidationError('Each item must be an object');
      }
      const item = raw as Record<string, unknown>;
      const noteId = typeof item.noteId === 'string' ? item.noteId : '';
      assertValidId(noteId, 'note id');
      if (item.title !== undefined && typeof item.title !== 'string') {
        throw new OrganizeValidationError('Invalid note title');
      }
      if (item.notebookId !== undefined && typeof item.notebookId !== 'string') {
        throw new OrganizeValidationError('Invalid notebook id');
      }
      if (item.notebookId !== undefined) {
        assertValidId(item.notebookId, 'notebook id');
      }
      if (item.baseUpdatedTime !== undefined && (typeof item.baseUpdatedTime !== 'number' || !Number.isFinite(item.baseUpdatedTime))) {
        throw new OrganizeValidationError('Invalid baseUpdatedTime');
      }
      let addTags: string[] | undefined;
      if (item.addTags !== undefined) {
        if (!Array.isArray(item.addTags) || !item.addTags.every((t) => typeof t === 'string')) {
          throw new OrganizeValidationError('addTags must be an array of strings');
        }
        addTags = item.addTags.map((t) => sanitizeLine(t)).filter(Boolean);
      }
      if (seenNoteIds.has(noteId)) continue;
      seenNoteIds.add(noteId);
      parsedInputs.push({
        noteId,
        ...(item.title !== undefined ? { title: item.title } : {}),
        ...(item.notebookId !== undefined ? { notebookId: item.notebookId } : {}),
        ...(addTags !== undefined ? { addTags } : {}),
        ...(item.baseUpdatedTime !== undefined ? { baseUpdatedTime: item.baseUpdatedTime } : {}),
      });
    }

    // Snapshot pre-apply titles and parent notebooks before sending batch updates
    const entry = await noteCache.getEntry(sessionId);
    const jobItemMap = new Map(job.items.map((it) => [it.noteId, it]));
    const prevSnapshot = new Map<string, { title: string; parentId: string; updatedTime: number }>();

    const batchItems: BatchNoteItem[] = parsedInputs.map((inp) => {
      const liveNote = entry.notes.get(inp.noteId);
      const jobItem = jobItemMap.get(inp.noteId);
      const prevTitle = liveNote?.title ?? jobItem?.currentTitle ?? '';
      const prevParentId = liveNote?.parentId ?? jobItem?.currentNotebookId ?? '';
      const baseUpdated = inp.baseUpdatedTime ?? liveNote?.updatedTime ?? jobItem?.updatedTime;
      prevSnapshot.set(inp.noteId, {
        title: prevTitle,
        parentId: prevParentId,
        updatedTime: liveNote?.updatedTime ?? jobItem?.updatedTime ?? 0,
      });

      const batchItem: BatchNoteItem = {
        id: inp.noteId,
        ...(baseUpdated !== undefined ? { baseUpdatedTime: baseUpdated } : {}),
        ...(inp.title !== undefined ? { title: inp.title } : {}),
        ...(inp.notebookId !== undefined && inp.notebookId !== prevParentId ? { parentId: inp.notebookId } : {}),
        ...(inp.addTags && inp.addTags.length > 0 ? { addTags: inp.addTags } : {}),
      };
      // If caller sent unchanged notebookId, ensure batch call still has an explicit change if title/tags weren't sent
      if (
        batchItem.title === undefined &&
        batchItem.parentId === undefined &&
        batchItem.addTags === undefined &&
        inp.notebookId !== undefined
      ) {
        batchItem.parentId = inp.notebookId;
      }
      return batchItem;
    });

    const allResults = [];
    for (let offset = 0; offset < batchItems.length; offset += MAX_BATCH_SIZE) {
      const chunk = batchItems.slice(offset, offset + MAX_BATCH_SIZE);
      const chunkResults = await noteWriter.batchUpdateNotes(sessionId, { items: chunk });
      allResults.push(...chunkResults);
    }

    const undoItems: OrganizeUndoRecord['items'] = [];
    let appliedCount = 0;
    let conflictCount = 0;
    let errorCount = 0;

    for (const res of allResults) {
      const jobItem = jobItemMap.get(res.id);
      const prev = prevSnapshot.get(res.id);
      if (res.status === 'ok') {
        appliedCount++;
        if (jobItem) {
          jobItem.applied = true;
          jobItem.applyStatus = 'ok';
          delete jobItem.applyError;
          if (res.updatedTime !== undefined) jobItem.updatedTime = res.updatedTime;
        }
        if (prev) {
          undoItems.push({
            noteId: res.id,
            baseUpdatedTime: res.updatedTime ?? prev.updatedTime,
            previousTitle: prev.title,
            previousNotebookId: prev.parentId,
            addedTags: res.addedTags ?? [],
          });
        }
      } else if (res.status === 'conflict') {
        conflictCount++;
        if (jobItem) {
          jobItem.applyStatus = 'conflict';
          jobItem.applyError = res.error;
        }
      } else {
        errorCount++;
        if (jobItem) {
          jobItem.applyStatus = 'error';
          jobItem.applyError = res.error;
        }
      }
    }

    if (undoItems.length > 0) {
      job.lastUndo = {
        appliedAt: Date.now(),
        items: undoItems,
      };
    }
    job.updatedAt = Date.now();
    this.saveJobNow(ownerKey, job.id);

    return {
      results: allResults,
      appliedCount,
      conflictCount,
      errorCount,
      canUndo: Boolean(job.lastUndo && job.lastUndo.items.length > 0),
    };
  }

  public async undoJob(sessionId: string, jobId: string): Promise<OrganizeUndoResponse> {
    const { ownerKey, job } = this.assertOwnerJob(sessionId, jobId);
    const record = job.lastUndo;
    if (!record || record.items.length === 0) {
      throw new OrganizeValidationError('Nothing to undo for this job', 409);
    }

    const batchItems: BatchNoteItem[] = record.items.map((item) => ({
      id: item.noteId,
      baseUpdatedTime: item.baseUpdatedTime,
      title: item.previousTitle,
      ...(item.previousNotebookId ? { parentId: item.previousNotebookId } : {}),
      ...(item.addedTags.length > 0 ? { removeTags: item.addedTags } : {}),
    }));

    const allResults = [];
    for (let offset = 0; offset < batchItems.length; offset += MAX_BATCH_SIZE) {
      const chunk = batchItems.slice(offset, offset + MAX_BATCH_SIZE);
      const chunkResults = await noteWriter.batchUpdateNotes(sessionId, { items: chunk });
      allResults.push(...chunkResults);
    }

    const jobItemMap = new Map(job.items.map((it) => [it.noteId, it]));
    let revertedCount = 0;
    let conflictCount = 0;
    let errorCount = 0;

    for (const res of allResults) {
      const jobItem = jobItemMap.get(res.id);
      if (res.status === 'ok') {
        revertedCount++;
        if (jobItem) {
          jobItem.applied = false;
          delete jobItem.applyStatus;
          delete jobItem.applyError;
          if (res.updatedTime !== undefined) jobItem.updatedTime = res.updatedTime;
        }
      } else if (res.status === 'conflict') {
        conflictCount++;
        if (jobItem) {
          jobItem.applyStatus = 'conflict';
          jobItem.applyError = res.error;
        }
      } else {
        errorCount++;
        if (jobItem) {
          jobItem.applyStatus = 'error';
          jobItem.applyError = res.error;
        }
      }
    }

    job.lastUndo = null;
    job.updatedAt = Date.now();
    this.saveJobNow(ownerKey, job.id);

    return {
      results: allResults,
      revertedCount,
      conflictCount,
      errorCount,
      canUndo: false,
    };
  }

  /** Wait until the current running job for a session/owner finishes (helper for tests). */
  public async waitForIdle(sessionId: string): Promise<void> {
    const ownerKey = this.attachSession(sessionId);
    const loop = this.activeLoops.get(ownerKey);
    if (loop) await loop.catch(() => undefined);
  }

  /** Aborts all running worker loops and flushes persisted state (called on server shutdown). */
  public async shutdown(): Promise<void> {
    for (const controller of this.activeControllers.values()) {
      controller.abort('shutdown');
    }
    await Promise.all([...this.activeLoops.values()].map((p) => p.catch(() => undefined)));
    this.activeIndexes.clear();
    const pendingEntries = [...this.persistTimers.values()];
    for (const entry of pendingEntries) {
      this.saveJobNow(entry.ownerKey, entry.jobId);
    }
    for (const [ownerKey, state] of this.owners) {
      for (const jobId of [...state.loadedJobs.keys()]) {
        this.saveJobNow(ownerKey, jobId);
      }
    }
  }
}

export const organizerService = new OrganizerService();
