import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { JoplinApiError, JoplinNotFoundError, joplinApi } from './joplin-api.js';
import { deserialize, markupLanguageOf, notePreview } from './serializer.js';
import {
  buildOcrSnippet,
  extractLinkedResourceIds,
  isEmptySearchQuery,
  matchesDateFilters,
  matchesNamePattern,
  normalizeOcrText,
  parseSearchQuery,
} from './search-query.js';
import { extractInlineTasks } from './inline-tasks.js';
import { reconstructRevisionContent, RevisionDiffRecord } from './revision-patch.js';
import { trashedTogether } from './trash.js';
import {
  DuplicateCluster,
  FavoriteNotebookSummary,
  HydratedPreferences,
  HygieneNoteItem,
  HygieneReport,
  InlineTaskItem,
  JoplinDeltaChange,
  JoplinItemType,
  Notebook,
  NotebookBreadcrumb,
  NoteAttachment,
  NoteAttachmentKind,
  NoteBacklink,
  NoteDetail,
  NoteListItem,
  NoteRevisionDetail,
  NoteRevisionMeta,
  NoteTagLink,
  RawJoplinItem,
  RecentNotesResponse,
  RecentReadEntry,
  RecentReadNote,
  ResourceMetadata,
  SearchResult,
  TagItem,
  TasksResponse,
  TodoTaskItem,
  TrashedNotebook,
  UserPreferences,
} from '../types/index.js';

/**
 * Items written by Joplin Web are recorded with a negative timestamp (minus the write time).
 * It never matches a server timestamp, so the next refresh re-reads the item, and it keeps the
 * item in the removal check, so an item deleted on the server afterwards does not stay as a ghost.
 */
const localWriteMarker = (now = Date.now()): number => -now;

/**
 * Cache entries not used for this long are dropped. Sessions that expire on Joplin Server or are
 * simply abandoned never log out, so without this their copy of the account would stay forever.
 * Dropping an entry only costs a full listing if the session comes back.
 */
export const IDLE_CACHE_TTL_MS = 2 * 60 * 60 * 1000;

/** Idle entries are looked for at most this often */
const IDLE_SWEEP_INTERVAL_MS = 60 * 1000;

/** Delta feed change type of a deleted item */
const DELTA_DELETED = 3;

/** The delta cursor expired (Joplin Server prunes old changes) or the server has no delta feed */
const needsRelisting = (err: unknown): boolean =>
  err instanceof JoplinNotFoundError ||
  (err instanceof JoplinApiError && (err.details as { code?: string } | undefined)?.code === 'resyncRequired');

/** Session ids are bearer tokens, so only their hashes are written to disk */
const hashSession = (sessionId: string): string => createHash('sha256').update(sessionId).digest('hex');

/** Cache key of a Joplin user's shared entry; session ids never contain ':' */
const userKey = (userId: string): string => `user:${userId}`;

const SESSIONS_FILE = 'sessions.json';
const entryFile = (key: string): string => `${key.replace(':', '-')}.json`;

function readCacheFile<T>(name: string): T | null {
  if (!config.cacheDir) return null;
  try {
    return JSON.parse(readFileSync(join(config.cacheDir, name), 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Replaces a file in CACHE_DIR atomically. Failures are logged, never thrown: the cache then just
 * stays in memory.
 * The JSON of the whole account is built synchronously (~17 MB for ~17k items, well under a second
 * of blocking), and only after a refresh that changed something. Stream it if that ever shows.
 */
function writeCacheFile(name: string, value: unknown): void {
  if (!config.cacheDir) return;
  const file = join(config.cacheDir, name);
  try {
    mkdirSync(config.cacheDir, { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  } catch (err) {
    console.error(`[NoteCache] Could not save ${name}:`, err);
  }
}

/**
 * Whether a note is a conflict copy (`is_conflict: 1`). Joplin desktop and mobile create one when a
 * sync conflict happens and keep it in the original notebook, but list it only in their virtual
 * "Conflicts" folder: never in notebooks, "All notes", tag lists or note counts.
 */
export const isConflictNote = (note: RawJoplinItem): boolean => note.properties.is_conflict === '1';
/** True for an item stored end-to-end encrypted: its title and content are only in the cipher text */
const isEncrypted = (item: RawJoplinItem): boolean => item.properties.encryption_applied === '1';

/**
 * Display title of a notebook. An encrypted one has no readable title (Joplin only keeps ids,
 * `parent_id`, timestamps and the cipher text in clear), so it gets a fixed label.
 */
const notebookTitle = (item: RawJoplinItem): string =>
  isEncrypted(item) ? 'Encrypted notebook' : item.title || 'Untitled Notebook';

/** Display title of a tag, see `notebookTitle` */
const tagTitle = (item: RawJoplinItem): string => (isEncrypted(item) ? 'Encrypted tag' : item.title || 'Untitled Tag');

/** Image types every browser shows in an `<img>`: no SVG (sent as an attachment) or TIFF/HEIC */
const THUMBNAIL_IMAGE_MIME = /^image\/(jpeg|png|gif|webp|avif|bmp)$/;

/**
 * The first image or PDF attachment a note body links to (`:/id` in Markdown or HTML), shown as the
 * note's thumbnail in lists. Encrypted notes have no readable body, so they never get one.
 */
const noteThumbnail = (
  note: RawJoplinItem,
  resources: Map<string, ResourceMetadata>
): NoteListItem['thumbnail'] => {
  if (isEncrypted(note) || !note.body) return undefined;
  for (const [, id] of note.body.matchAll(/:\/([0-9a-fA-F]{32})/g)) {
    const mime = resources.get(id.toLowerCase())?.mime ?? '';
    if (mime === 'application/pdf') return { resourceId: id.toLowerCase(), kind: 'pdf' };
    if (THUMBNAIL_IMAGE_MIME.test(mime)) return { resourceId: id.toLowerCase(), kind: 'image' };
  }
  return undefined;
};

/**
 * Copies a string out of any V8 SlicedString backing buffer so keeping resource metadata in
 * memory never retains the full deserialized `.md` string (which can include large `ocr_details`).
 */
function detachString(value: string): string {
  return value.length === 0 ? '' : Buffer.from(value, 'utf8').toString('utf8');
}

/**
 * Extracts `ocr_text` only when OCR completed (`ocr_status: 2`) on a readable resource item.
 */
function ocrTextOf(item: RawJoplinItem): string {
  if (isEncrypted(item) || item.properties.ocr_status !== '2') return '';
  const raw = item.properties.ocr_text;
  return raw && raw.trim() ? detachString(raw) : '';
}

/** Builds a detached `ResourceMetadata` record from a deserialized resource item */
function resourceMetadataOf(item: RawJoplinItem): ResourceMetadata {
  const rawOcrStatus = Number(item.properties.ocr_status || 0);
  const ocrStatus = !isEncrypted(item) && Number.isFinite(rawOcrStatus) && rawOcrStatus > 0 ? rawOcrStatus : undefined;
  return {
    id: detachString(item.id),
    title: detachString(item.title),
    mime: detachString(item.properties.mime || 'application/octet-stream'),
    filename: detachString(item.properties.filename || ''),
    fileExtension: detachString(item.properties.file_extension || ''),
    size: Number(item.properties.size || 0),
    updatedTime: item.updatedTime,
    ocrText: ocrTextOf(item),
    ...(ocrStatus !== undefined ? { ocrStatus } : {}),
  };
}

function parsePropTimestamp(val?: string): number {
  if (!val || val === '0') return 0;
  const num = Number(val);
  if (!Number.isNaN(num) && Number.isFinite(num)) return num;
  const parsed = Date.parse(val);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function attachmentKindOf(mime: string, name: string): NoteAttachmentKind {
  const lowerMime = mime.toLowerCase();
  const lowerName = name.toLowerCase();
  if (lowerMime.startsWith('image/')) return 'image';
  if (lowerMime === 'application/pdf' || lowerName.endsWith('.pdf')) return 'pdf';
  if (lowerMime.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|flac|aac|webm)$/i.test(lowerName)) return 'audio';
  if (lowerMime.startsWith('video/') || /\.(mp4|mov|mkv)$/i.test(lowerName)) return 'video';
  return 'file';
}

/** On-disk cache format version; bumped whenever `SavedEntry` changes incompatibly so old caches rebuild */
const CACHE_FORMAT_VERSION = 2 as const;

/**
 * How a caller wants the cache refreshed, see `NoteCacheService.ensureFresh`
 */
export type RefreshMode = 'stale-ok' | 'fresh' | 'force';

/**
 * Reads serve cached data while it is refreshed in the background only up to this many TTLs old.
 * Beyond that (e.g. the first request after a long idle period) they wait for the refresh. With
 * `CACHE_TTL_MS=0` the window is empty, so every read re-syncs before it answers.
 */
export const STALE_LIMIT_FACTOR = 10;

export interface CacheEntry {
  /** Time the last successful refresh finished, 0 before the first one */
  lastFetched: number;
  /** Last time the session read or wrote through the cache, for idle eviction */
  lastAccessed: number;
  /** The refresh running for this session, if any */
  fetchPromise: Promise<void> | null;
  /**
   * Whether the last refresh failed. The next read then waits for a refresh instead of serving
   * stale data, so an expired session or an unreachable server is still reported to the client.
   */
  lastRefreshFailed: boolean;
  notebooks: Map<string, RawJoplinItem>;
  notes: Map<string, RawJoplinItem>;
  tags: Map<string, RawJoplinItem>;
  noteTags: NoteTagLink[];
  resources: Map<string, ResourceMetadata>;
  revisionsByItem?: Map<string, NoteRevisionMeta[]>;
  revisionOwners?: Map<string, string>;
  revisionsIndexed?: boolean;
  itemTimestamps: Map<string, number>;
  /** `updated_time` of the sync target's info.json in the last listing, null when it has none */
  syncInfoUpdatedTime: number | null;
  /**
   * Where the last refresh left Joplin Server's delta feed. The next refresh then only reads the
   * changes since (one request when nothing changed) instead of re-listing the whole account.
   * null until the first full listing, or when the server has no delta feed.
   */
  deltaCursor: string | null;
  /** Ids of items stored with `encryption_applied: 1` */
  encryptedItemIds: Set<string>;
  /** Ids of master key items (type 9), which exist only on accounts that used E2EE */
  masterKeyIds: Set<string>;
  /**
   * Names of listed items whose content could not be read or parsed in the last refresh. Any of
   * them could be a master key, so the writer's E2EE guard treats them like one.
   */
  unreadableItems: Set<string>;
  /**
   * Item names written or deleted by Joplin Web, with the time of the change. A refresh that
   * started before such a change must not apply the (older) content it fetched for that item.
   */
  localChanges: Map<string, number>;
}

/** A user's cache entry as written to CACHE_DIR */
interface SavedEntry {
  version: typeof CACHE_FORMAT_VERSION;
  lastFetched: number;
  notebooks: Array<[string, RawJoplinItem]>;
  notes: Array<[string, RawJoplinItem]>;
  tags: Array<[string, RawJoplinItem]>;
  noteTags: NoteTagLink[];
  resources: Array<[string, ResourceMetadata]>;
  revisionsByItem?: Array<[string, NoteRevisionMeta[]]>;
  revisionsIndexed?: boolean;
  itemTimestamps: Array<[string, number]>;
  syncInfoUpdatedTime: number | null;
  deltaCursor: string | null;
  encryptedItemIds: string[];
  masterKeyIds: string[];
  unreadableItems: string[];
}

/**
 * In-memory note cache service.
 * Maintains session-isolated caches of deserialized Joplin items with TTL auto-refreshing.
 */
export class NoteCacheService {
  private caches: Map<string, CacheEntry> = new Map();
  private lastIdleSweep = 0;
  /**
   * Joplin user of each session that logged in, by session hash. Only used with CACHE_DIR: the
   * sessions of one user then share one cache entry, which is also kept on disk, so a new login
   * or a restart does not have to read the whole account again.
   */
  private sessionUsers = new Map<string, string>(
    Object.entries(readCacheFile<Record<string, string>>(SESSIONS_FILE) ?? {})
  );

  /** Cache key of a session: its user's shared entry when known, else the session itself */
  private keyOf(sessionId: string): string {
    const userId = this.sessionUsers.get(hashSession(sessionId));
    return userId ? userKey(userId) : sessionId;
  }

  /**
   * Filesystem-safe owner key for per-user persisted state (e.g. organize jobs).
   * Resolves to `user-<userId>` when bound via login, else `session-<sha256>`. Never exposes raw tokens.
   */
  public getOwnerKey(sessionId: string): string {
    const userId = this.sessionUsers.get(hashSession(sessionId));
    return userId ? `user-${userId}` : `session-${hashSession(sessionId)}`;
  }

  /**
   * Reads a persisted user cache entry directly from CACHE_DIR without requiring an active sessionId
   * (used after server restarts to resume background work immediately when CACHE_DIR is populated).
   */
  public loadSavedEntryByOwnerKey(ownerKey: string): CacheEntry | null {
    if (!ownerKey.startsWith('user-')) return null;
    const userId = ownerKey.slice('user-'.length);
    if (!/^[A-Za-z0-9_-]+$/.test(userId)) return null;
    const key = userKey(userId);
    return this.caches.get(key) ?? this.loadEntry(key);
  }

  /**
   * Returns the current in-memory (or saved) entry for `sessionId` without forcing a remote fetch, or null.
   */
  public peekEntry(sessionId: string): CacheEntry | null {
    const key = this.keyOf(sessionId);
    return this.caches.get(key) ?? this.loadEntry(key);
  }

  /**
   * Records which Joplin user a session belongs to (at login), so it shares that user's cache.
   * Does nothing without CACHE_DIR, where every session keeps its own cache.
   */
  public bindSession(sessionId: string, userId: string): void {
    if (!config.cacheDir || !/^[A-Za-z0-9_-]+$/.test(userId)) return;
    this.sessionUsers.set(hashSession(sessionId), userId);
    writeCacheFile(SESSIONS_FILE, Object.fromEntries(this.sessionUsers));
  }

  /**
   * Retrieves or initializes the cache entry for a given session
   */
  private getOrCreateEntry(sessionId: string): CacheEntry {
    const now = Date.now();
    if (now - this.lastIdleSweep >= IDLE_SWEEP_INTERVAL_MS) this.evictIdleCaches(now);
    const key = this.keyOf(sessionId);
    let entry = this.caches.get(key);
    if (!entry) {
      entry = this.loadEntry(key) ?? {
        lastFetched: 0,
        lastAccessed: now,
        fetchPromise: null,
        lastRefreshFailed: false,
        notebooks: new Map(),
        notes: new Map(),
        tags: new Map(),
        noteTags: [],
        resources: new Map(),
        revisionsByItem: new Map(),
        revisionOwners: new Map(),
        revisionsIndexed: false,
        itemTimestamps: new Map(),
        syncInfoUpdatedTime: null,
        deltaCursor: null,
        encryptedItemIds: new Set(),
        masterKeyIds: new Set(),
        unreadableItems: new Set(),
        localChanges: new Map(),
      };
      this.caches.set(key, entry);
    }
    entry.lastAccessed = now;
    return entry;
  }

  /** Reads a user's entry saved by `saveEntry`, null when there is none */
  private loadEntry(key: string): CacheEntry | null {
    if (!key.startsWith('user:')) return null;
    const saved = readCacheFile<SavedEntry>(entryFile(key));
    if (saved?.version !== CACHE_FORMAT_VERSION) return null;
    console.log(`[NoteCache] Loaded saved cache: ${saved.notes.length} notes`);
    const revisionsByItem = new Map<string, NoteRevisionMeta[]>(saved.revisionsByItem ?? []);
    const revisionOwners = new Map<string, string>();
    for (const [itemId, list] of revisionsByItem) {
      for (const rev of list) revisionOwners.set(rev.id, itemId);
    }
    return {
      lastFetched: saved.lastFetched,
      lastAccessed: Date.now(),
      fetchPromise: null,
      lastRefreshFailed: false,
      notebooks: new Map(saved.notebooks),
      notes: new Map(saved.notes),
      tags: new Map(saved.tags),
      noteTags: saved.noteTags,
      resources: new Map(saved.resources),
      revisionsByItem,
      revisionOwners,
      revisionsIndexed: Boolean(saved.revisionsIndexed),
      itemTimestamps: new Map(saved.itemTimestamps),
      syncInfoUpdatedTime: saved.syncInfoUpdatedTime,
      deltaCursor: saved.deltaCursor,
      encryptedItemIds: new Set(saved.encryptedItemIds),
      masterKeyIds: new Set(saved.masterKeyIds),
      unreadableItems: new Set(saved.unreadableItems),
      localChanges: new Map(),
    };
  }

  /** Writes a user's entry to CACHE_DIR; per-session entries are never saved */
  private saveEntry(sessionId: string, entry: CacheEntry): void {
    const key = this.keyOf(sessionId);
    if (!key.startsWith('user:')) return;
    const saved: SavedEntry = {
      version: CACHE_FORMAT_VERSION,
      lastFetched: entry.lastFetched,
      notebooks: [...entry.notebooks],
      notes: [...entry.notes],
      tags: [...entry.tags],
      noteTags: entry.noteTags,
      resources: [...entry.resources],
      revisionsByItem: entry.revisionsByItem ? [...entry.revisionsByItem] : [],
      revisionsIndexed: entry.revisionsIndexed,
      itemTimestamps: [...entry.itemTimestamps],
      syncInfoUpdatedTime: entry.syncInfoUpdatedTime,
      deltaCursor: entry.deltaCursor,
      encryptedItemIds: [...entry.encryptedItemIds],
      masterKeyIds: [...entry.masterKeyIds],
      unreadableItems: [...entry.unreadableItems],
    };
    writeCacheFile(entryFile(key), saved);
  }

  /**
   * Drops the caches of sessions that have not used them for `IDLE_CACHE_TTL_MS` (runs on access,
   * at most once a minute). Entries with a refresh in flight are kept.
   *
   * @returns The number of dropped entries
   */
  public evictIdleCaches(now = Date.now()): number {
    this.lastIdleSweep = now;
    let evicted = 0;
    for (const [sessionId, entry] of this.caches) {
      if (entry.fetchPromise || now - entry.lastAccessed < IDLE_CACHE_TTL_MS) continue;
      this.caches.delete(sessionId);
      evicted++;
    }
    if (evicted > 0) console.log(`[NoteCache] Dropped ${evicted} idle session cache(s)`);
    return evicted;
  }

  /** Whether a session currently has a cache entry (for tests and diagnostics) */
  public hasCache(sessionId: string): boolean {
    return this.caches.has(this.keyOf(sessionId));
  }

  /**
   * Returns the session's cache entry, refreshed from Joplin Server as `mode` requires:
   *
   * - `stale-ok` (reads): within `CACHE_TTL_MS` the entry is returned as is. After that, data up to
   *   `STALE_LIMIT_FACTOR` TTLs old is returned right away while a refresh runs in the background
   *   (stale-while-revalidate). Older data, the first load, and the first read after a failed
   *   refresh wait for a refresh instead, so errors (expired session, server down) reach the client.
   * - `fresh` (writes): an expired entry is always refreshed before it is returned.
   * - `force` (Refresh button, purge): always refreshes, joining a refresh that is already running.
   */
  public async ensureFresh(sessionId: string, mode: RefreshMode = 'stale-ok'): Promise<CacheEntry> {
    const entry = this.getOrCreateEntry(sessionId);
    const age = Date.now() - entry.lastFetched;
    const ttl = config.cacheTtlMs;
    const loaded = entry.lastFetched > 0;

    if (mode !== 'force' && loaded && age <= ttl) {
      return entry;
    }

    if (mode === 'stale-ok' && loaded && !entry.lastRefreshFailed && age <= ttl * STALE_LIMIT_FACTOR) {
      if (!entry.fetchPromise) this.startRefresh(sessionId, entry);
      return entry;
    }

    // Join a refresh that is already running (a background one too) instead of starting another
    await (entry.fetchPromise ?? this.startRefresh(sessionId, entry));
    return entry;
  }

  /**
   * Starts a refresh and records it on the entry until it settles. The returned promise rejects
   * when the refresh fails; the failure is also handled here (logged and recorded on the entry), so
   * a background refresh nobody awaits never becomes an unhandled rejection.
   */
  private startRefresh(sessionId: string, entry: CacheEntry): Promise<void> {
    const refresh = this.refreshCacheInternal(sessionId, entry);
    entry.fetchPromise = refresh;
    refresh.then(
      () => {
        entry.lastRefreshFailed = false;
        if (entry.fetchPromise === refresh) entry.fetchPromise = null;
      },
      (err: unknown) => {
        entry.lastRefreshFailed = true;
        if (entry.fetchPromise === refresh) entry.fetchPromise = null;
        console.error(`[NoteCache] Refresh failed for session ${sessionId.substring(0, 8)}...:`, err);
      }
    );
    return refresh;
  }

  /**
   * Resolves once the session's running refresh (if any) has settled, successfully or not.
   * Never rejects. Lets callers and tests wait for a background refresh.
   */
  public async whenIdle(sessionId: string): Promise<void> {
    const pending = this.caches.get(this.keyOf(sessionId))?.fetchPromise;
    if (pending) await pending.catch(() => undefined);
  }

  /**
   * Internal routine to synchronize items with Joplin Server
   */
  private async refreshCacheInternal(sessionId: string, entry: CacheEntry): Promise<void> {
    if (entry.deltaCursor !== null) {
      try {
        await this.refreshFromDelta(sessionId, entry);
        return;
      } catch (err) {
        if (!needsRelisting(err)) throw err;
        console.log('[NoteCache] Delta cursor no longer valid, listing all items');
        entry.deltaCursor = null;
      }
    }

    // Where the delta feed stands before the listing, so the next refresh replays whatever changes
    // while it runs. Stays null when the server has no delta feed: every refresh then re-lists.
    let deltaCursor: string | null = null;
    try {
      deltaCursor = (await joplinApi.getDelta(sessionId, '')).cursor;
    } catch (err) {
      if (!(err instanceof JoplinNotFoundError)) throw err;
    }

    console.log(`[NoteCache] Synchronizing cache for session ${sessionId.substring(0, 8)}...`);
    const startTime = Date.now();

    // 1. Fetch listing of all items from Joplin Server
    const listingStartedAt = Date.now();
    const childItems = await joplinApi.listAllItems(sessionId);
    const currentItemNames = new Set<string>();

    // Identify which items need fetching/updating
    const itemsToFetch: Array<{ name: string; updated_time: number }> = [];
    let syncInfoUpdatedTime: number | null = null;

    for (const item of childItems) {
      currentItemNames.add(item.name);
      if (item.name === 'info.json') syncInfoUpdatedTime = item.updated_time;
      // Only process markdown item files for metadata
      if (item.name.endsWith('.md')) {
        const lastKnownTime = entry.itemTimestamps.get(item.name);
        if (lastKnownTime !== item.updated_time) {
          itemsToFetch.push({ name: item.name, updated_time: item.updated_time });
        }
      }
    }

    entry.syncInfoUpdatedTime = syncInfoUpdatedTime;
    for (const name of entry.unreadableItems) {
      if (!currentItemNames.has(name)) entry.unreadableItems.delete(name);
    }

    // Remove deleted items from the local cache
    for (const [name, timestamp] of entry.itemTimestamps) {
      // Written by Joplin Web while the listing was loading, so it may be missing from it
      const writtenDuringListing = timestamp < 0 && -timestamp >= listingStartedAt;
      if (!currentItemNames.has(name) && !writtenDuringListing) {
        this.forgetItem(entry, name.replace(/\.md$/i, ''));
      }
    }

    await this.fetchItems(sessionId, entry, itemsToFetch, listingStartedAt);

    for (const [name, time] of entry.localChanges) {
      if (time < listingStartedAt) entry.localChanges.delete(name);
    }

    entry.revisionsIndexed = true;
    entry.lastFetched = Date.now();
    entry.deltaCursor = deltaCursor;
    this.saveEntry(sessionId, entry);
    console.log(
      `[NoteCache] Synced session in ${Date.now() - startTime}ms. ` +
        `Notebooks: ${entry.notebooks.size}, Notes: ${entry.notes.size}, Tags: ${entry.tags.size}`
    );
  }

  /**
   * Reads and applies the given items, 10 requests at a time. Content written or deleted by Joplin
   * Web after `listingStartedAt` is kept over what was fetched.
   */
  private async fetchItems(
    sessionId: string,
    entry: CacheEntry,
    itemsToFetch: Array<{ name: string; updated_time: number }>,
    listingStartedAt: number
  ): Promise<void> {
    const batchSize = 10;
    for (let i = 0; i < itemsToFetch.length; i += batchSize) {
      const batch = itemsToFetch.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (item) => {
          try {
            const rawContent = await joplinApi.getItemContent(sessionId, item.name);
            const parsed = deserialize(rawContent, item.name);
            entry.unreadableItems.delete(item.name);

            // Joplin Web wrote or deleted the item since this refresh started, so the fetched
            // content may predate that change: keep the local state, the next refresh re-reads it
            const localChange = entry.localChanges.get(item.name);
            if (localChange !== undefined && localChange >= listingStartedAt) return;

            // Record timestamp
            entry.itemTimestamps.set(item.name, item.updated_time);
            this.trackEncryption(entry, parsed);

            // Categorize by type_
            switch (parsed.type_) {
              case JoplinItemType.Folder: // 2 = Folder / Notebook
                entry.notebooks.set(parsed.id, parsed);
                break;

              case JoplinItemType.Note: // 1 = Note
                entry.notes.set(parsed.id, parsed);
                break;

              case JoplinItemType.Tag: // 5 = Tag
                entry.tags.set(parsed.id, parsed);
                break;

              case JoplinItemType.NoteTag: { // 6 = NoteTag link
                const noteId = parsed.properties.note_id || '';
                const tagId = parsed.properties.tag_id || '';
                // Remove existing link with this ID if updating
                entry.noteTags = entry.noteTags.filter((link) => link.id !== parsed.id);
                if (noteId && tagId) {
                  entry.noteTags.push({ id: parsed.id, noteId, tagId });
                }
                break;
              }

              case JoplinItemType.Resource: { // 4 = Resource metadata
                const resource = resourceMetadataOf(parsed);
                entry.resources.set(resource.id, resource);
                break;
              }

              case JoplinItemType.Revision: { // 13 = Revision metadata
                const itemId = detachString(parsed.properties.item_id || '');
                const itemType = Number(parsed.properties.item_type || 0);
                if (itemId && itemType === JoplinItemType.Note && !(parsed.deletedTime > 0)) {
                  const titleUpdatedTime =
                    parsePropTimestamp(parsed.properties.item_updated_time) || parsed.updatedTime;
                  this.upsertRevisionMeta(entry, {
                    id: detachString(parsed.id),
                    itemId,
                    titleUpdatedTime,
                    updatedTime: parsed.updatedTime,
                    createdTime: parsed.createdTime,
                  });
                } else {
                  this.removeRevisionMeta(entry, parsed.id);
                }
                break;
              }

              default:
                // Ignore other internal types (Setting, Search, etc.)
                break;
            }
          } catch (err) {
            entry.unreadableItems.add(item.name);
            console.error(`[NoteCache] Error parsing item ${item.name}:`, err);
          }
        })
      );
    }

  }

  /**
   * Applies the changes since the last refresh from Joplin Server's delta feed: one request when
   * nothing changed, instead of re-listing every item of the account.
   */
  private async refreshFromDelta(sessionId: string, entry: CacheEntry): Promise<void> {
    const startedAt = Date.now();
    const { changes, cursor } = await joplinApi.getDelta(sessionId, entry.deltaCursor ?? '');
    const latest = new Map<string, JoplinDeltaChange>();
    for (const change of changes) latest.set(change.item_name, change);

    const itemsToFetch: Array<{ name: string; updated_time: number }> = [];
    for (const [name, change] of latest) {
      const deleted = change.type === DELTA_DELETED;
      if (name === 'info.json') entry.syncInfoUpdatedTime = deleted ? null : change.updated_time;
      if (!name.endsWith('.md')) continue;
      if (!deleted) {
        itemsToFetch.push({ name, updated_time: change.updated_time });
        continue;
      }
      // Joplin Web wrote the item again after this refresh started: keep it
      const localChange = entry.localChanges.get(name);
      if (localChange === undefined || localChange < startedAt) this.forgetItem(entry, name.replace(/\.md$/i, ''));
    }
    await this.fetchItems(sessionId, entry, itemsToFetch, startedAt);

    for (const [name, time] of entry.localChanges) {
      if (time < startedAt) entry.localChanges.delete(name);
    }
    entry.deltaCursor = cursor;
    entry.lastFetched = Date.now();
    if (latest.size > 0) {
      console.log(`[NoteCache] Applied ${latest.size} change(s) in ${Date.now() - startedAt}ms`);
      this.saveEntry(sessionId, entry);
    }
  }

  /**
   * Forces a cache refresh for the given session
   */
  public async refreshCache(sessionId: string): Promise<void> {
    await this.ensureFresh(sessionId, 'force');
  }

  /**
   * Clears the cache for a session (on logout, or when the session turned out to be invalid)
   */
  public clearCache(sessionId: string): void {
    // A shared entry belongs to the user and stays for their other sessions; only this link goes
    if (this.sessionUsers.delete(hashSession(sessionId))) {
      writeCacheFile(SESSIONS_FILE, Object.fromEntries(this.sessionUsers));
      return;
    }
    if (this.caches.delete(sessionId)) {
      console.log(`[NoteCache] Cleared cache for session ${sessionId.substring(0, 8)}...`);
    }
  }

  /**
   * Returns the cache entry for the write service. Unlike reads it never serves data older than
   * `CACHE_TTL_MS`: writes check E2EE state, note-tag links and tag names against it.
   */
  public async getEntry(sessionId: string): Promise<CacheEntry> {
    return this.ensureFresh(sessionId, 'fresh');
  }

  /**
   * Inserts or replaces an item after it was written to Joplin Server, so reads reflect
   * the change immediately. The stored sync timestamp is replaced by a local-write marker
   * (see `localWriteMarker`): the next refresh re-reads the item, and still removes it if it was
   * deleted on the server in the meantime.
   */
  public upsertItem(sessionId: string, item: RawJoplinItem): void {
    const entry = this.getOrCreateEntry(sessionId);
    const now = Date.now();
    entry.itemTimestamps.set(`${item.id}.md`, localWriteMarker(now));
    entry.localChanges.set(`${item.id}.md`, now);
    this.trackEncryption(entry, item);
    if (item.type_ === JoplinItemType.Note) {
      entry.notes.set(item.id, item);
    } else if (item.type_ === JoplinItemType.Folder) {
      entry.notebooks.set(item.id, item);
    } else if (item.type_ === JoplinItemType.Tag) {
      entry.tags.set(item.id, item);
    } else if (item.type_ === JoplinItemType.Resource) {
      const resource = resourceMetadataOf(item);
      entry.resources.set(resource.id, resource);
    } else if (item.type_ === JoplinItemType.NoteTag) {
      const noteId = item.properties.note_id || '';
      const tagId = item.properties.tag_id || '';
      entry.noteTags = entry.noteTags.filter((link) => link.id !== item.id);
      if (noteId && tagId) entry.noteTags.push({ id: item.id, noteId, tagId });
    } else if (item.type_ === JoplinItemType.Revision) {
      const itemId = detachString(item.properties.item_id || '');
      const itemType = Number(item.properties.item_type || 0);
      if (itemId && itemType === JoplinItemType.Note && !(item.deletedTime > 0)) {
        const titleUpdatedTime =
          parsePropTimestamp(item.properties.item_updated_time) || item.updatedTime;
        this.upsertRevisionMeta(entry, {
          id: detachString(item.id),
          itemId,
          titleUpdatedTime,
          updatedTime: item.updatedTime,
          createdTime: item.createdTime,
        });
      }
    }
  }

  private upsertRevisionMeta(entry: CacheEntry, meta: NoteRevisionMeta): void {
    const owners = (entry.revisionOwners ??= new Map<string, string>());
    const byItem = (entry.revisionsByItem ??= new Map<string, NoteRevisionMeta[]>());
    const prevOwner = owners.get(meta.id);
    if (prevOwner && prevOwner !== meta.itemId) {
      this.removeRevisionMeta(entry, meta.id);
    }
    owners.set(meta.id, meta.itemId);
    const list = (byItem.get(meta.itemId) ?? []).filter((r) => r.id !== meta.id);
    list.push(meta);
    byItem.set(meta.itemId, list);
  }

  private removeRevisionMeta(entry: CacheEntry, revId: string): void {
    const owner = entry.revisionOwners?.get(revId);
    if (!owner) return;
    entry.revisionOwners?.delete(revId);
    const list = entry.revisionsByItem?.get(owner);
    if (!list) return;
    const next = list.filter((r) => r.id !== revId);
    if (next.length === 0) entry.revisionsByItem?.delete(owner);
    else entry.revisionsByItem?.set(owner, next);
  }

  /**
   * Removes an item that was permanently deleted from Joplin Server
   */
  public removeItem(sessionId: string, id: string): void {
    const entry = this.getOrCreateEntry(sessionId);
    entry.localChanges.set(`${id}.md`, Date.now());
    this.forgetItem(entry, id);
  }

  /** Drops an item from every map of a cache entry */
  private forgetItem(entry: CacheEntry, id: string): void {
    entry.itemTimestamps.delete(`${id}.md`);
    entry.notebooks.delete(id);
    entry.notes.delete(id);
    entry.tags.delete(id);
    entry.resources.delete(id);
    this.removeRevisionMeta(entry, id);
    entry.noteTags = entry.noteTags.filter((link) => link.id !== id);
    entry.encryptedItemIds.delete(id);
    entry.masterKeyIds.delete(id);
    entry.unreadableItems.delete(`${id}.md`);
  }

  /** Records whether an item is encrypted or a master key, for the writer's E2EE guard */
  private trackEncryption(entry: CacheEntry, item: RawJoplinItem): void {
    if (item.properties.encryption_applied === '1') entry.encryptedItemIds.add(item.id);
    else entry.encryptedItemIds.delete(item.id);
    if (item.type_ === JoplinItemType.MasterKey) entry.masterKeyIds.add(item.id);
  }

  /**
   * Builds and returns the nested notebook tree (excluding deleted notebooks)
   */
  public async getNotebooks(sessionId: string): Promise<Notebook[]> {
    const entry = await this.ensureFresh(sessionId);

    // Filter out deleted notebooks
    const activeNotebooks = Array.from(entry.notebooks.values()).filter(
      (nb) => !nb.deletedTime || nb.deletedTime === 0
    );

    // Direct active notes per notebook, counted in one pass over all notes
    const noteCounts = new Map<string, number>();
    for (const note of entry.notes.values()) {
      if ((note.deletedTime && note.deletedTime > 0) || isConflictNote(note)) continue;
      noteCounts.set(note.parentId, (noteCounts.get(note.parentId) ?? 0) + 1);
    }

    // Map each raw folder into a Notebook object
    const nodeMap = new Map<string, Notebook>();

    for (const nb of activeNotebooks) {
      const directNoteCount = noteCounts.get(nb.id) ?? 0;

      nodeMap.set(nb.id, {
        id: nb.id,
        title: notebookTitle(nb),
        parentId: nb.parentId || '',
        children: [],
        noteCount: directNoteCount,
        encrypted: isEncrypted(nb),
        createdTime: nb.createdTime,
        updatedTime: nb.updatedTime,
        deletedTime: nb.deletedTime,
      });
    }

    // Build hierarchical tree
    const rootNodes: Notebook[] = [];

    for (const node of nodeMap.values()) {
      if (node.parentId && nodeMap.has(node.parentId)) {
        const parent = nodeMap.get(node.parentId)!;
        parent.children.push(node);
      } else {
        rootNodes.push(node);
      }
    }

    // Sort recursively by title
    const sortNodes = (nodes: Notebook[]) => {
      nodes.sort((a, b) => a.title.localeCompare(b.title));
      for (const node of nodes) {
        if (node.children.length > 0) {
          sortNodes(node.children);
        }
      }
    };

    sortNodes(rootNodes);
    return rootNodes;
  }

  /**
   * Lists the trashed notebooks a user can restore or purge: those whose parent is not trashed
   * (sub-notebooks trashed with a notebook come back with it). Newest deletion first.
   */
  public async getTrashedNotebooks(sessionId: string): Promise<TrashedNotebook[]> {
    const entry = await this.ensureFresh(sessionId);
    const isTrashed = (id: string) => (entry.notebooks.get(id)?.deletedTime ?? 0) > 0;

    const childrenOf = new Map<string, RawJoplinItem[]>();
    for (const nb of entry.notebooks.values()) {
      const siblings = childrenOf.get(nb.parentId) ?? [];
      siblings.push(nb);
      childrenOf.set(nb.parentId, siblings);
    }
    const notesPerFolder = new Map<string, RawJoplinItem[]>();
    for (const note of entry.notes.values()) {
      // Conflict copies are not trashed with their notebook (they stay in "Conflicts")
      if (isConflictNote(note) && !(note.deletedTime > 0)) continue;
      const siblings = notesPerFolder.get(note.parentId) ?? [];
      siblings.push(note);
      notesPerFolder.set(note.parentId, siblings);
    }

    const roots = [...entry.notebooks.values()].filter((nb) => nb.deletedTime > 0 && !isTrashed(nb.parentId));
    return roots
      .map((root) => {
        // Same rule as noteWriter.restoreNotebook: what comes back on restore is counted as the
        // notebook's contents; anything else in the subtree was trashed earlier on its own
        const comesBack = (item: RawJoplinItem) => !(item.deletedTime > 0) || trashedTogether(item, root.deletedTime);
        let noteCount = 0;
        let notebookCount = 0;
        let earlierNoteCount = 0;
        const visited = new Set<string>();
        const stack: Array<{ folder: RawJoplinItem; restored: boolean }> = [{ folder: root, restored: true }];
        while (stack.length > 0) {
          const { folder, restored } = stack.pop()!;
          if (visited.has(folder.id)) continue;
          visited.add(folder.id);
          if (folder !== root && restored) notebookCount++;
          for (const note of notesPerFolder.get(folder.id) ?? []) {
            if (restored && comesBack(note)) noteCount++;
            else earlierNoteCount++;
          }
          for (const child of childrenOf.get(folder.id) ?? []) {
            stack.push({ folder: child, restored: restored && comesBack(child) });
          }
        }
        return {
          id: root.id,
          title: notebookTitle(root),
          parentId: root.parentId || '',
          deletedTime: root.deletedTime,
          noteCount,
          notebookCount,
          earlierNoteCount,
          encrypted: isEncrypted(root),
        };
      })
      .sort((a, b) => b.deletedTime - a.deletedTime);
  }

  /**
   * Retrieves notes with optional filtering by notebook or tag
   * By default, returns only active (non-deleted) notes whose parent notebook is also not deleted,
   * without conflict copies.
   *
   * With `isConflict`, returns the conflict copies that are not trashed themselves, wherever they
   * are (like Joplin's "Conflicts" folder, which ignores the notebook); the notebook and tag
   * filters do not apply to them. The trash lists trashed
   * conflict copies too, but not untrashed ones in a trashed notebook: those stay in "Conflicts".
   *
   * @param sessionId Active session ID
   * @param filters Optional filter criteria (notebookId, tagId, isTrash, isConflict)
   * @returns List of matching NoteListItems, sorted by updatedTime descending
   */
  public async getNotes(
    sessionId: string,
    filters?: { notebookId?: string; tagId?: string; isTrash?: boolean; isConflict?: boolean }
  ): Promise<NoteListItem[]> {
    const entry = await this.ensureFresh(sessionId);

    // Identify deleted notebooks
    const deletedNotebookIds = new Set(
      Array.from(entry.notebooks.values())
        .filter((nb) => nb.deletedTime && nb.deletedTime > 0)
        .map((nb) => nb.id)
    );

    let matchingNotes = Array.from(entry.notes.values());

    if (filters?.isConflict) {
      // Like Joplin's Conflicts folder: `is_conflict = 1 AND deleted_time = 0`
      matchingNotes = matchingNotes.filter((n) => isConflictNote(n) && !(n.deletedTime > 0));
    } else if (filters?.isTrash) {
      // In Trash: note itself has deletedTime > 0, OR its parent notebook is deleted
      matchingNotes = matchingNotes.filter(
        (n) =>
          (n.deletedTime && n.deletedTime > 0) ||
          (n.parentId && deletedNotebookIds.has(n.parentId) && !isConflictNote(n))
      );
    } else {
      // Active notes: note itself has no deletedTime AND parent notebook is not deleted
      matchingNotes = matchingNotes.filter(
        (n) =>
          (!n.deletedTime || n.deletedTime === 0) &&
          (!n.parentId || !deletedNotebookIds.has(n.parentId)) &&
          !isConflictNote(n)
      );
    }

    // Filter by notebook if specified
    if (filters?.notebookId && !filters.isConflict) {
      matchingNotes = matchingNotes.filter((n) => n.parentId === filters.notebookId);
    }

    // Filter by tag if specified
    if (filters?.tagId && !filters.isConflict) {
      const taggedNoteIds = new Set(
        entry.noteTags.filter((link) => link.tagId === filters.tagId).map((link) => link.noteId)
      );
      matchingNotes = matchingNotes.filter((n) => taggedNoteIds.has(n.id));
    }

    // Sort by updatedTime descending
    matchingNotes.sort((a, b) => b.updatedTime - a.updatedTime);

    const tagIdsByNote = this.tagIdsByNoteOf(entry);

    // Map to NoteListItem
    return matchingNotes.map((n) => {
      const tagIds = tagIdsByNote.get(n.id);
      return {
        id: n.id,
        title: n.title,
        parentId: n.parentId || '',
        createdTime: n.createdTime,
        updatedTime: n.updatedTime,
        deletedTime: n.deletedTime || 0,
        preview: notePreview(n.body, markupLanguageOf(n.properties), 150),
        isTodo: n.isTodo,
        todoCompleted: Boolean(n.todoCompleted),
        todoDue: n.todoDue,
        isConflict: isConflictNote(n),
        encrypted: isEncrypted(n),
        thumbnail: noteThumbnail(n, entry.resources),
        ...(tagIds && tagIds.length > 0 ? { tagIds } : {}),
      };
    });
  }

  /**
   * Retrieves full note details including parent notebook info and linked tags
   *
   * @param sessionId Active session ID
   * @param noteId Note ID
   * @returns NoteDetail or null if note not found
   */
  public async getNote(sessionId: string, noteId: string): Promise<NoteDetail | null> {
    const entry = await this.ensureFresh(sessionId);
    const note = entry.notes.get(noteId);
    if (!note) {
      return null;
    }

    // Resolve parent notebook
    const notebookItem = note.parentId ? entry.notebooks.get(note.parentId) : null;
    const notebook = notebookItem
      ? { id: notebookItem.id, title: notebookTitle(notebookItem) }
      : null;

    // Check if parent notebook is deleted. A conflict copy is not in the trash with its notebook:
    // Joplin keeps it in "Conflicts" until it is trashed itself.
    const isConflict = isConflictNote(note);
    const isParentDeleted =
      notebookItem && !isConflict ? Boolean(notebookItem.deletedTime && notebookItem.deletedTime > 0) : false;
    const effectiveDeletedTime = (note.deletedTime && note.deletedTime > 0)
      ? note.deletedTime
      : (isParentDeleted ? (notebookItem?.deletedTime || 1) : 0);

    // Resolve linked tags
    const linkedTagIds = entry.noteTags
      .filter((link) => link.noteId === noteId)
      .map((link) => link.tagId);

    const tags = linkedTagIds
      .map((tagId) => entry.tags.get(tagId))
      .filter((t): t is RawJoplinItem => Boolean(t))
      .map((t) => ({ id: t.id, title: tagTitle(t) }));

    const notebookPath = this.notebookPathOf(entry, note.parentId);
    const backlinks = this.backlinksToNote(entry, noteId);

    return {
      id: note.id,
      title: note.title,
      body: note.body,
      preview: notePreview(note.body, markupLanguageOf(note.properties), 150),
      parentId: note.parentId || '',
      notebook,
      tags,
      createdTime: note.createdTime,
      updatedTime: note.updatedTime,
      deletedTime: effectiveDeletedTime,
      notebookId: note.parentId || '',
      notebookTitle: notebook?.title || '',
      notebookPath,
      backlinks,
      isTodo: note.isTodo,
      todoCompleted: Boolean(note.todoCompleted),
      todoDue: note.todoDue,
      isConflict,
      conflictOriginalId: isConflict ? note.properties.conflict_original_id || '' : '',
      markupLanguage: markupLanguageOf(note.properties),
      encrypted: isEncrypted(note),
      properties: note.properties,
    };
  }

  /**
   * Retrieves all tags along with their note counts (only counting active notes)
   */
  public async getTags(sessionId: string): Promise<TagItem[]> {
    const entry = await this.ensureFresh(sessionId);

    const deletedNotebookIds = new Set(
      Array.from(entry.notebooks.values())
        .filter((nb) => nb.deletedTime && nb.deletedTime > 0)
        .map((nb) => nb.id)
    );

    // Distinct active notes per tag, collected in one pass over the links
    const notesPerTag = new Map<string, Set<string>>();
    for (const link of entry.noteTags) {
      const note = entry.notes.get(link.noteId);
      if (
        !note ||
        isConflictNote(note) ||
        (note.deletedTime && note.deletedTime > 0) ||
        (note.parentId && deletedNotebookIds.has(note.parentId))
      ) {
        continue;
      }
      let noteIds = notesPerTag.get(link.tagId);
      if (!noteIds) {
        noteIds = new Set();
        notesPerTag.set(link.tagId, noteIds);
      }
      noteIds.add(link.noteId);
    }

    const tagsList: TagItem[] = [];
    for (const tag of entry.tags.values()) {
      tagsList.push({
        id: tag.id,
        title: tagTitle(tag),
        noteCount: notesPerTag.get(tag.id)?.size ?? 0,
        encrypted: isEncrypted(tag),
      });
    }

    // Sort alphabetically by tag title
    tagsList.sort((a, b) => a.title.localeCompare(b.title));
    return tagsList;
  }

  /**
   * Searches active notes (trashed ones are excluded). The query syntax is parsed by
   * `parseSearchQuery`: all words/phrases must appear in the title, body or linked attachments' OCR
   * text (`ocr_status: 2`), plus optional `tag:`, `notebook:` (including sub-notebooks), `type:` and
   * `iscompleted:` filters.
   *
   * @param sessionId Active session ID
   * @param query Search query string
   * @returns Matching SearchResults sorted by relevance and updatedTime
   */
  public async searchNotes(sessionId: string, query: string): Promise<SearchResult[]> {
    const parsed = parseSearchQuery(query);
    if (isEmptySearchQuery(parsed)) {
      return [];
    }
    const entry = await this.ensureFresh(sessionId);

    const deletedNotebookIds = new Set(
      Array.from(entry.notebooks.values())
        .filter((nb) => nb.deletedTime && nb.deletedTime > 0)
        .map((nb) => nb.id)
    );

    const notebookFilter = parsed.notebooks.length > 0 ? this.notebooksMatching(entry, parsed.notebooks) : null;
    const excludedNotebookIds =
      parsed.excludedNotebooks.length > 0 ? this.notebooksMatching(entry, parsed.excludedNotebooks) : null;

    const needsTags =
      parsed.tags.length > 0 || parsed.excludedTags.length > 0 || parsed.tagNone !== undefined;
    const tagTitlesByNote = new Map<string, string[]>();
    if (needsTags) {
      for (const link of entry.noteTags) {
        const tag = entry.tags.get(link.tagId);
        if (!tag) continue;
        const titles = tagTitlesByNote.get(link.noteId) ?? [];
        titles.push(tag.title || '');
        tagTitlesByNote.set(link.noteId, titles);
      }
    }

    const tagIdsByNote = this.tagIdsByNoteOf(entry);

    const results: Array<SearchResult & { relevanceScore: number }> = [];

    for (const note of entry.notes.values()) {
      // Exclude trashed notes and conflict copies from search
      if (
        isConflictNote(note) ||
        (note.deletedTime && note.deletedTime > 0) ||
        (note.parentId && deletedNotebookIds.has(note.parentId))
      ) {
        continue;
      }

      const isTodo = Boolean(note.isTodo);
      if (parsed.type === 'todo' && !isTodo) continue;
      if (parsed.type === 'note' && isTodo) continue;
      if (parsed.completed !== undefined && (!isTodo || Boolean(note.todoCompleted) !== parsed.completed)) continue;

      if (!matchesDateFilters(note.createdTime, parsed.createdFilters)) continue;
      if (!matchesDateFilters(note.updatedTime, parsed.updatedFilters)) continue;

      if (parsed.sourceUrls.length > 0 || parsed.excludedSourceUrls.length > 0) {
        const sourceUrlLower = (note.properties.source_url || '').toLowerCase();
        const matchesSource = (pat: string) =>
          pat.includes('*') ? matchesNamePattern(sourceUrlLower, pat) : sourceUrlLower.includes(pat);
        if (parsed.sourceUrls.length > 0 && (!sourceUrlLower || !parsed.sourceUrls.every(matchesSource))) {
          continue;
        }
        if (parsed.excludedSourceUrls.length > 0 && sourceUrlLower && parsed.excludedSourceUrls.some(matchesSource)) {
          continue;
        }
      }

      const parentId = note.parentId || '';
      if (notebookFilter && !notebookFilter.has(parentId)) continue;
      if (excludedNotebookIds && excludedNotebookIds.has(parentId)) continue;

      if (needsTags) {
        const noteTagTitles = tagTitlesByNote.get(note.id) ?? [];
        if (parsed.tagNone === true && noteTagTitles.length > 0) continue;
        if (parsed.tagNone === false && noteTagTitles.length === 0) continue;
        const hasTag = (pattern: string) => noteTagTitles.some((title) => matchesNamePattern(title, pattern));
        if (!parsed.tags.every(hasTag) || parsed.excludedTags.some(hasTag)) continue;
      }

      const encrypted = isEncrypted(note);
      const title = note.title || '';
      const body = note.body || '';
      const titleLower = title.toLowerCase();
      const bodyLower = body.toLowerCase();

      const linkedResourceIds =
        !encrypted &&
        (parsed.hasAttachment !== undefined ||
          parsed.hasOcr !== undefined ||
          parsed.excludedTerms.length > 0 ||
          parsed.terms.length > 0)
          ? extractLinkedResourceIds(body)
          : [];

      if (parsed.hasAttachment !== undefined) {
        const hasAtt = !encrypted && linkedResourceIds.some((id) => entry.resources.has(id));
        if (parsed.hasAttachment !== hasAtt) continue;
      }
      if (parsed.hasOcr !== undefined) {
        const hasOcrText =
          !encrypted && linkedResourceIds.some((id) => Boolean(entry.resources.get(id)?.ocrText));
        if (parsed.hasOcr !== hasOcrText) continue;
      }

      if (parsed.excludedTerms.some((term) => titleLower.includes(term) || bodyLower.includes(term))) {
        continue;
      }

      const unmatchedTerms = parsed.terms.filter((term) => !titleLower.includes(term) && !bodyLower.includes(term));
      if (encrypted && unmatchedTerms.length > 0) {
        continue;
      }

      let excludedByAttachment = false;
      const attachmentOcrs: Array<{ normalized: string; lower: string }> = [];
      if (!encrypted && (unmatchedTerms.length > 0 || parsed.excludedTerms.length > 0)) {
        for (const resId of linkedResourceIds) {
          const ocrText = entry.resources.get(resId)?.ocrText;
          if (!ocrText) continue;
          const normalized = normalizeOcrText(ocrText);
          if (!normalized) continue;
          const lower = normalized.toLowerCase();
          if (parsed.excludedTerms.some((term) => lower.includes(term))) {
            excludedByAttachment = true;
            break;
          }
          attachmentOcrs.push({ normalized, lower });
        }
      }
      if (excludedByAttachment) continue;

      if (
        unmatchedTerms.length > 0 &&
        (attachmentOcrs.length === 0 ||
          !unmatchedTerms.every((term) => attachmentOcrs.some(({ lower }) => lower.includes(term))))
      ) {
        continue;
      }

      const titleHits = parsed.terms.filter((term) => titleLower.includes(term)).length;
      // Earliest occurrence of any term in the body, for the snippet
      let matchIdx = -1;
      let matchLength = 0;
      for (const term of parsed.terms) {
        const idx = bodyLower.indexOf(term);
        if (idx !== -1 && (matchIdx === -1 || idx < matchIdx)) {
          matchIdx = idx;
          matchLength = term.length;
        }
      }
      const inTitle = titleHits > 0;
      const inBody = matchIdx !== -1;

      let snippet = '';
      let matchedIn: 'attachment' | undefined;
      if (inBody) {
        const start = Math.max(0, matchIdx - 60);
        const end = Math.min(body.length, matchIdx + matchLength + 60);
        const rawSnippet = body.substring(start, end);
        snippet = `${start > 0 ? '...' : ''}${notePreview(rawSnippet, markupLanguageOf(note.properties), 150)}${
          end < body.length ? '...' : ''
        }`;
      } else if (!inTitle && parsed.terms.length > 0) {
        for (const { normalized } of attachmentOcrs) {
          const ocrSnippet = buildOcrSnippet(normalized, parsed.terms);
          if (ocrSnippet) {
            snippet = ocrSnippet;
            matchedIn = 'attachment';
            break;
          }
        }
      }

      // Title matches receive highest priority, followed by body, then attachment OCR
      const bodyHits = parsed.terms.filter((term) => bodyLower.includes(term)).length;
      const attachmentHits =
        attachmentOcrs.length > 0
          ? parsed.terms.filter((term) => attachmentOcrs.some(({ lower }) => lower.includes(term))).length
          : 0;
      const relevanceScore = titleHits * 100 + bodyHits * 10 + attachmentHits;

      const matches: SearchResult['matches'] = {
        inTitle,
        inBody,
        ...(matchedIn ? { matchedIn } : {}),
        snippet,
        terms: parsed.terms,
      };

      const tagIds = tagIdsByNote.get(note.id);
      results.push({
        id: note.id,
        title,
        parentId,
        createdTime: note.createdTime,
        updatedTime: note.updatedTime,
        deletedTime: note.deletedTime || 0,
        preview: notePreview(note.body, markupLanguageOf(note.properties), 150),
        isTodo: note.isTodo,
        todoCompleted: Boolean(note.todoCompleted),
        todoDue: note.todoDue,
        isConflict: false,
        encrypted,
        ...(tagIds && tagIds.length > 0 ? { tagIds } : {}),
        matches,
        relevanceScore,
      });
    }

    // Sort by relevance score descending, then by updatedTime descending
    results.sort((a, b) => {
      if (b.relevanceScore !== a.relevanceScore) {
        return b.relevanceScore - a.relevanceScore;
      }
      return b.updatedTime - a.updatedTime;
    });

    return results.map(({ relevanceScore, ...item }) => item);
  }

  /**
   * Returns the concatenated OCR text (`ocr_status: 2`) of attachments linked from a note (`:/id`),
   * in link order and joined by blank lines, given an already-loaded `CacheEntry`.
   */
  public getAttachmentTextFromEntry(
    entry: CacheEntry,
    noteId: string,
    options: { maxChars?: number } = {}
  ): string {
    const maxChars = options.maxChars;
    if (maxChars !== undefined && (Number.isNaN(maxChars) || maxChars <= 0)) {
      return '';
    }
    const note = entry.notes.get(noteId);
    if (!note || isEncrypted(note) || !note.body) return '';

    const parts: string[] = [];
    let total = 0;
    for (const resId of extractLinkedResourceIds(note.body)) {
      const ocr = entry.resources.get(resId)?.ocrText?.trim();
      if (!ocr) continue;
      if (maxChars === undefined) {
        parts.push(ocr);
        continue;
      }
      const sep = parts.length > 0 ? '\n\n' : '';
      const remaining = maxChars - total - sep.length;
      if (remaining <= 0) break;
      const slice = ocr.slice(0, remaining);
      if (!slice) break;
      parts.push(slice);
      total += sep.length + slice.length;
      if (total >= maxChars) break;
    }
    return parts.join('\n\n');
  }

  /**
   * Returns the concatenated OCR text (`ocr_status: 2`) of attachments linked from a note (`:/id`),
   * in link order and joined by blank lines. Returns an empty string when the note is missing,
   * encrypted, or has no OCR text.
   *
   * @param sessionId Active session ID
   * @param noteId Note ID
   * @param options Optional cap `maxChars` on total returned characters
   */
  public async getNoteAttachmentText(
    sessionId: string,
    noteId: string,
    options: { maxChars?: number } = {}
  ): Promise<string> {
    const entry = await this.ensureFresh(sessionId);
    return this.getAttachmentTextFromEntry(entry, noteId, options);
  }

  /**
   * Ids of the notebooks whose title matches one of the patterns, plus all their sub-notebooks
   */
  private notebooksMatching(entry: CacheEntry, patterns: string[]): Set<string> {
    const childrenOf = new Map<string, string[]>();
    for (const nb of entry.notebooks.values()) {
      const parent = nb.parentId || '';
      const siblings = childrenOf.get(parent) ?? [];
      siblings.push(nb.id);
      childrenOf.set(parent, siblings);
    }

    const ids = new Set<string>();
    const stack = Array.from(entry.notebooks.values())
      .filter((nb) => patterns.some((pattern) => matchesNamePattern(nb.title || '', pattern)))
      .map((nb) => nb.id);
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (ids.has(id)) continue; // guards against parent cycles in corrupt data
      ids.add(id);
      stack.push(...(childrenOf.get(id) ?? []));
    }
    return ids;
  }

  /**
   * Gets cached metadata for a resource if present
   */
  public async getResourceMetadata(
    sessionId: string,
    resourceId: string
  ): Promise<ResourceMetadata | null> {
    const entry = await this.ensureFresh(sessionId);
    const cleanId = resourceId.replace(/\.md$/i, '');
    return entry.resources.get(cleanId) || null;
  }

  private deletedNotebookIdsOf(entry: CacheEntry): Set<string> {
    const ids = new Set<string>();
    for (const nb of entry.notebooks.values()) {
      if (nb.deletedTime && nb.deletedTime > 0) ids.add(nb.id);
    }
    return ids;
  }

  private isNoteActive(note: RawJoplinItem, deletedNotebookIds: Set<string>): boolean {
    return (
      !isConflictNote(note) &&
      !(note.deletedTime && note.deletedTime > 0) &&
      (!note.parentId || !deletedNotebookIds.has(note.parentId))
    );
  }

  private tagIdsByNoteOf(entry: CacheEntry): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const link of entry.noteTags) {
      const existing = map.get(link.noteId);
      if (existing) {
        if (!existing.includes(link.tagId)) existing.push(link.tagId);
      } else {
        map.set(link.noteId, [link.tagId]);
      }
    }
    return map;
  }

  private toNoteListItem(
    entry: CacheEntry,
    n: RawJoplinItem,
    tagIdsByNote?: Map<string, string[]>
  ): NoteListItem {
    const tagIds = tagIdsByNote?.get(n.id);
    return {
      id: n.id,
      title: n.title,
      parentId: n.parentId || '',
      createdTime: n.createdTime,
      updatedTime: n.updatedTime,
      deletedTime: n.deletedTime || 0,
      preview: notePreview(n.body, markupLanguageOf(n.properties), 150),
      isTodo: n.isTodo,
      todoCompleted: Boolean(n.todoCompleted),
      todoDue: n.todoDue,
      isConflict: isConflictNote(n),
      encrypted: isEncrypted(n),
      thumbnail: noteThumbnail(n, entry.resources),
      ...(tagIds && tagIds.length > 0 ? { tagIds } : {}),
    };
  }

  private notebookPathOf(entry: CacheEntry, parentId: string): NotebookBreadcrumb[] {
    if (!parentId) return [];
    const chain: NotebookBreadcrumb[] = [];
    const seen = new Set<string>();
    let curId = parentId;
    while (curId && !seen.has(curId)) {
      seen.add(curId);
      const nb = entry.notebooks.get(curId);
      if (!nb) break;
      chain.push({ id: nb.id, title: notebookTitle(nb) });
      curId = nb.parentId || '';
    }
    chain.reverse();
    return chain;
  }

  private backlinksToNote(entry: CacheEntry, targetNoteId: string): NoteBacklink[] {
    const deletedNotebookIds = this.deletedNotebookIdsOf(entry);
    const targetLower = targetNoteId.toLowerCase();
    const links: NoteBacklink[] = [];

    for (const other of entry.notes.values()) {
      if (other.id === targetNoteId || isEncrypted(other) || !this.isNoteActive(other, deletedNotebookIds)) {
        continue;
      }
      if (!other.body || !other.body.includes(':/')) continue;
      if (!extractLinkedResourceIds(other.body).includes(targetLower)) continue;

      const idx = other.body.toLowerCase().indexOf(`:/${targetLower}`);
      const start = Math.max(0, idx - 60);
      const end = Math.min(other.body.length, idx + 120);
      const slice = other.body.slice(start, end);
      const snippet = `${start > 0 ? '...' : ''}${notePreview(slice, markupLanguageOf(other.properties), 140)}${
        end < other.body.length ? '...' : ''
      }`;

      links.push({
        id: other.id,
        title: other.title || 'Untitled Note',
        parentId: other.parentId || '',
        updatedTime: other.updatedTime,
        snippet,
      });
    }

    links.sort((a, b) => b.updatedTime - a.updatedTime);
    return links;
  }

  public async hydratePreferences(sessionId: string, prefs: UserPreferences): Promise<HydratedPreferences> {
    const entry = await this.ensureFresh(sessionId);
    const deletedNotebookIds = this.deletedNotebookIdsOf(entry);
    const tagIdsByNote = this.tagIdsByNoteOf(entry);

    const favoriteNotes: NoteListItem[] = [];
    for (const noteId of prefs.favoriteNoteIds) {
      const note = entry.notes.get(noteId);
      if (note && this.isNoteActive(note, deletedNotebookIds)) {
        favoriteNotes.push(this.toNoteListItem(entry, note, tagIdsByNote));
      }
    }

    const noteCounts = new Map<string, number>();
    if (prefs.favoriteNotebookIds.length > 0) {
      for (const note of entry.notes.values()) {
        if (this.isNoteActive(note, deletedNotebookIds)) {
          noteCounts.set(note.parentId, (noteCounts.get(note.parentId) ?? 0) + 1);
        }
      }
    }

    const favoriteNotebooks: FavoriteNotebookSummary[] = [];
    for (const nbId of prefs.favoriteNotebookIds) {
      const nb = entry.notebooks.get(nbId);
      if (nb && !(nb.deletedTime && nb.deletedTime > 0)) {
        favoriteNotebooks.push({
          id: nb.id,
          title: notebookTitle(nb),
          parentId: nb.parentId || '',
          noteCount: noteCounts.get(nb.id) ?? 0,
          encrypted: isEncrypted(nb),
        });
      }
    }

    return {
      favoriteNoteIds: prefs.favoriteNoteIds,
      favoriteNotebookIds: prefs.favoriteNotebookIds,
      savedSearches: prefs.savedSearches,
      recentReads: prefs.recentReads,
      scratchpad: prefs.scratchpad,
      favoriteNotes,
      favoriteNotebooks,
    };
  }

  public async getRecentNotes(
    sessionId: string,
    recentReads: RecentReadEntry[],
    limit = 50
  ): Promise<RecentNotesResponse> {
    const entry = await this.ensureFresh(sessionId);
    const deletedNotebookIds = this.deletedNotebookIdsOf(entry);
    const tagIdsByNote = this.tagIdsByNoteOf(entry);
    const capped = Math.min(Math.max(1, limit), 100);

    const recentRead: RecentReadNote[] = [];
    for (const r of recentReads) {
      if (recentRead.length >= capped) break;
      const note = entry.notes.get(r.noteId);
      if (note && this.isNoteActive(note, deletedNotebookIds)) {
        recentRead.push({
          ...this.toNoteListItem(entry, note, tagIdsByNote),
          readAt: r.readAt,
        });
      }
    }

    const activeNotes: RawJoplinItem[] = [];
    for (const note of entry.notes.values()) {
      if (this.isNoteActive(note, deletedNotebookIds)) activeNotes.push(note);
    }
    activeNotes.sort((a, b) => b.createdTime - a.createdTime || b.updatedTime - a.updatedTime);

    const recentCreated = activeNotes
      .slice(0, capped)
      .map((n) => this.toNoteListItem(entry, n, tagIdsByNote));
    return { recentRead, recentCreated };
  }

  public async getNoteAttachments(sessionId: string, noteId: string): Promise<NoteAttachment[] | null> {
    const entry = await this.ensureFresh(sessionId);
    const note = entry.notes.get(noteId);
    if (!note) return null;
    if (isEncrypted(note) || !note.body) return [];

    const attachments: NoteAttachment[] = [];
    for (const resId of extractLinkedResourceIds(note.body)) {
      const res = entry.resources.get(resId);
      if (!res) continue;
      const ocrStatus =
        res.ocrText || res.ocrStatus === 2
          ? ('done' as const)
          : res.ocrStatus === 3
            ? ('failed' as const)
            : undefined;
      attachments.push({
        id: res.id,
        title: res.title,
        mime: res.mime,
        filename: res.filename,
        fileExtension: res.fileExtension,
        size: res.size,
        updatedTime: res.updatedTime,
        ocrText: res.ocrText,
        ...(ocrStatus ? { ocrStatus } : {}),
        kind: attachmentKindOf(res.mime, res.filename || res.title),
      });
    }
    return attachments;
  }

  private async ensureRevisionsIndexed(sessionId: string, entry: CacheEntry): Promise<void> {
    if (entry.revisionsIndexed) return;
    const owners = (entry.revisionOwners ??= new Map<string, string>());
    entry.revisionsByItem ??= new Map<string, NoteRevisionMeta[]>();

    const knownNoteTagIds = new Set(entry.noteTags.map((l) => l.id));
    const unknownItemNames: string[] = [];
    for (const name of entry.itemTimestamps.keys()) {
      if (!name.endsWith('.md')) continue;
      const id = name.replace(/\.md$/i, '');
      if (
        entry.notes.has(id) ||
        entry.notebooks.has(id) ||
        entry.tags.has(id) ||
        entry.resources.has(id) ||
        entry.masterKeyIds.has(id) ||
        entry.encryptedItemIds.has(id) ||
        knownNoteTagIds.has(id) ||
        owners.has(id)
      ) {
        continue;
      }
      unknownItemNames.push(name);
    }

    const batchSize = 10;
    for (let i = 0; i < unknownItemNames.length; i += batchSize) {
      const batch = unknownItemNames.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (itemName) => {
          try {
            const raw = await joplinApi.getItemContent(sessionId, itemName);
            const parsed = deserialize(raw, itemName);
            if (parsed.type_ === JoplinItemType.Revision) {
              const itemId = detachString(parsed.properties.item_id || '');
              const itemType = Number(parsed.properties.item_type || 0);
              if (itemId && itemType === JoplinItemType.Note && !(parsed.deletedTime > 0)) {
                const titleUpdatedTime =
                  parsePropTimestamp(parsed.properties.item_updated_time) || parsed.updatedTime;
                this.upsertRevisionMeta(entry, {
                  id: detachString(parsed.id),
                  itemId,
                  titleUpdatedTime,
                  updatedTime: parsed.updatedTime,
                  createdTime: parsed.createdTime,
                });
              }
            }
          } catch {
            // Skip unreadable internal items
          }
        })
      );
    }

    entry.revisionsIndexed = true;
    this.saveEntry(sessionId, entry);
  }

  public async getNoteRevisions(sessionId: string, noteId: string): Promise<NoteRevisionMeta[] | null> {
    const entry = await this.ensureFresh(sessionId);
    if (!entry.notes.has(noteId)) return null;
    await this.ensureRevisionsIndexed(sessionId, entry);
    const list = entry.revisionsByItem?.get(noteId) ?? [];
    return [...list].sort(
      (a, b) => b.titleUpdatedTime - a.titleUpdatedTime || b.updatedTime - a.updatedTime
    );
  }

  public async getNoteRevisionDetail(
    sessionId: string,
    noteId: string,
    revId: string
  ): Promise<NoteRevisionDetail | null> {
    const entry = await this.ensureFresh(sessionId);
    const note = entry.notes.get(noteId);
    if (!note || isEncrypted(note)) return null;
    await this.ensureRevisionsIndexed(sessionId, entry);
    const metas = entry.revisionsByItem?.get(noteId) ?? [];
    const targetMeta = metas.find((m) => m.id === revId);
    if (!targetMeta) return null;

    const ordered = [...metas].sort(
      (a, b) => a.titleUpdatedTime - b.titleUpdatedTime || a.updatedTime - b.updatedTime || a.id.localeCompare(b.id)
    );
    const targetIdx = ordered.findIndex((m) => m.id === revId);
    const relevant = ordered.slice(0, targetIdx + 1);

    const records: RevisionDiffRecord[] = [];
    const batchSize = 10;
    for (let i = 0; i < relevant.length; i += batchSize) {
      const batch = relevant.slice(i, i + batchSize);
      const parsedBatch = await Promise.all(
        batch.map(async (meta) => {
          const raw = await joplinApi.getItemContent(sessionId, `${meta.id}.md`);
          const parsed = deserialize(raw, `${meta.id}.md`);
          if (parsed.properties.encryption_applied === '1') {
            return null;
          }
          return {
            id: parsed.id,
            parentId: parsed.parentId || '',
            updatedTime: parsed.updatedTime,
            titleUpdatedTime:
              parsePropTimestamp(parsed.properties.item_updated_time) || parsed.updatedTime,
            titleDiff: parsed.properties.title_diff || '',
            bodyDiff: parsed.properties.body_diff || '',
          };
        })
      );
      for (const rec of parsedBatch) {
        if (rec) records.push(rec);
      }
    }

    const reconstructed = reconstructRevisionContent(records, revId);
    if (!reconstructed) return null;

    return {
      id: targetMeta.id,
      itemId: noteId,
      title: reconstructed.title,
      body: reconstructed.body,
      updatedTime: targetMeta.updatedTime,
      createdTime: targetMeta.createdTime,
    };
  }

  public async getAllTasks(sessionId: string): Promise<TasksResponse> {
    const entry = await this.ensureFresh(sessionId);
    const deletedNotebookIds = this.deletedNotebookIdsOf(entry);
    const tagIdsByNote = this.tagIdsByNoteOf(entry);

    const todoNotes: TodoTaskItem[] = [];
    const inlineTasks: InlineTaskItem[] = [];

    for (const note of entry.notes.values()) {
      if (!this.isNoteActive(note, deletedNotebookIds)) continue;
      const nb = note.parentId ? entry.notebooks.get(note.parentId) : null;
      const nbTitle = nb ? notebookTitle(nb) : '';

      if (note.isTodo) {
        todoNotes.push({
          ...this.toNoteListItem(entry, note, tagIdsByNote),
          notebookTitle: nbTitle,
        });
      }

      if (!isEncrypted(note) && markupLanguageOf(note.properties) !== 2 && note.body) {
        for (const t of extractInlineTasks(note.body)) {
          inlineTasks.push({
            noteId: note.id,
            noteTitle: note.title || 'Untitled Note',
            parentId: note.parentId || '',
            notebookTitle: nbTitle,
            line: t.line,
            column: t.column,
            text: t.text,
            checked: t.checked,
            updatedTime: note.updatedTime,
          });
        }
      }
    }

    todoNotes.sort((a, b) => {
      if (Boolean(a.todoCompleted) !== Boolean(b.todoCompleted)) return a.todoCompleted ? 1 : -1;
      if (!a.todoCompleted && a.todoDue && b.todoDue) return a.todoDue - b.todoDue;
      if (!a.todoCompleted && Boolean(a.todoDue) !== Boolean(b.todoDue)) return a.todoDue ? -1 : 1;
      return b.updatedTime - a.updatedTime;
    });
    inlineTasks.sort((a, b) => {
      if (a.checked !== b.checked) return a.checked ? 1 : -1;
      return b.updatedTime - a.updatedTime || a.line - b.line;
    });

    return { todoNotes, inlineTasks };
  }

  public async getHygieneReport(sessionId: string): Promise<HygieneReport> {
    const entry = await this.ensureFresh(sessionId);
    const deletedNotebookIds = this.deletedNotebookIdsOf(entry);
    const tagIdsByNote = this.tagIdsByNoteOf(entry);

    const taggedNoteIds = new Set<string>();
    for (const link of entry.noteTags) taggedNoteIds.add(link.noteId);

    const activeNotes: RawJoplinItem[] = [];
    for (const note of entry.notes.values()) {
      if (this.isNoteActive(note, deletedNotebookIds)) activeNotes.push(note);
    }

    const hygieneItem = (n: RawJoplinItem): HygieneNoteItem => {
      const nb = n.parentId ? entry.notebooks.get(n.parentId) : null;
      const preview = notePreview(n.body, markupLanguageOf(n.properties), 150);
      return {
        ...this.toNoteListItem(entry, n, tagIdsByNote),
        notebookTitle: nb ? notebookTitle(nb) : '',
        previewLength: n.body.trim().length || preview.length,
      };
    };

    // 1. Empty notes (no body text & unencrypted)
    const emptyNotes = activeNotes
      .filter((n) => !isEncrypted(n) && !n.body.trim())
      .sort((a, b) => b.updatedTime - a.updatedTime)
      .slice(0, 200)
      .map(hygieneItem);

    // 2. Untagged notes
    const untaggedNotes = activeNotes
      .filter((n) => !taggedNoteIds.has(n.id))
      .sort((a, b) => b.updatedTime - a.updatedTime)
      .slice(0, 300)
      .map(hygieneItem);

    // 3. Duplicate clusters (exact normalized title + similar non-empty body)
    const duplicateClusters: DuplicateCluster[] = [];
    const clusteredNoteIds = new Set<string>();

    const byNormalizedTitle = new Map<string, RawJoplinItem[]>();
    for (const n of activeNotes) {
      if (isEncrypted(n)) continue;
      const norm = n.title.trim().toLowerCase().replace(/\s+/g, ' ');
      if (norm.length < 2 || norm === 'untitled' || norm === 'untitled note') continue;
      const group = byNormalizedTitle.get(norm) ?? [];
      group.push(n);
      byNormalizedTitle.set(norm, group);
    }

    for (const [normTitle, group] of byNormalizedTitle) {
      if (group.length < 2) continue;
      group.sort((a, b) => b.updatedTime - a.updatedTime);
      for (const n of group) clusteredNoteIds.add(n.id);
      duplicateClusters.push({
        id: `title-${group[0].id}`,
        reason: 'exact-title',
        score: 1,
        notes: group.map(hygieneItem),
      });
      void normTitle;
    }

    // Near-duplicate content using inverted token index on up to 1500 non-empty notes
    const candidates = activeNotes
      .filter((n) => !isEncrypted(n) && !clusteredNoteIds.has(n.id) && n.body.trim().length >= 80)
      .sort((a, b) => b.updatedTime - a.updatedTime)
      .slice(0, 1500);

    const tokenSets: Array<Set<string>> = [];
    const inverted = new Map<string, number[]>();

    for (let idx = 0; idx < candidates.length; idx++) {
      const plain = notePreview(candidates[idx].body, markupLanguageOf(candidates[idx].properties), 1200).toLowerCase();
      const rawTokens = plain.match(/[a-z0-9]{3,}|[\u4e00-\u9fff]{2}/g) ?? [];
      const unique = new Set(rawTokens.slice(0, 120));
      tokenSets.push(unique);
      if (unique.size < 8) continue;
      for (const tok of unique) {
        const list = inverted.get(tok);
        if (list) list.push(idx);
        else inverted.set(tok, [idx]);
      }
    }

    const parent = candidates.map((_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const unite = (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    };
    const maxScoreByRoot = new Map<number, number>();

    const overlapCounts = new Map<number, number>();
    for (let i = 0; i < candidates.length; i++) {
      const setA = tokenSets[i];
      if (setA.size < 8) continue;
      overlapCounts.clear();
      for (const tok of setA) {
        const postings = inverted.get(tok);
        if (!postings || postings.length > Math.max(50, candidates.length * 0.25)) continue;
        for (const j of postings) {
          if (j <= i) continue;
          overlapCounts.set(j, (overlapCounts.get(j) ?? 0) + 1);
        }
      }
      for (const [j, overlap] of overlapCounts) {
        const setB = tokenSets[j];
        const union = setA.size + setB.size - overlap;
        const jaccard = union > 0 ? overlap / union : 0;
        if (jaccard >= 0.72) {
          unite(i, j);
          const root = find(i);
          maxScoreByRoot.set(root, Math.max(maxScoreByRoot.get(root) ?? 0, jaccard));
        }
      }
    }

    const nearGroups = new Map<number, RawJoplinItem[]>();
    for (let i = 0; i < candidates.length; i++) {
      const root = find(i);
      const arr = nearGroups.get(root) ?? [];
      arr.push(candidates[i]);
      nearGroups.set(root, arr);
    }

    for (const [root, group] of nearGroups) {
      if (group.length < 2) continue;
      group.sort((a, b) => b.updatedTime - a.updatedTime);
      duplicateClusters.push({
        id: `content-${group[0].id}`,
        reason: 'similar-content',
        score: Math.round((maxScoreByRoot.get(root) ?? 0.75) * 100) / 100,
        notes: group.map(hygieneItem),
      });
    }

    duplicateClusters.sort((a, b) => b.notes.length - a.notes.length || b.score - a.score);
    return {
      duplicateClusters: duplicateClusters.slice(0, 50),
      emptyNotes,
      untaggedNotes,
    };
  }
}

// Export singleton instance
export const noteCache = new NoteCacheService();
