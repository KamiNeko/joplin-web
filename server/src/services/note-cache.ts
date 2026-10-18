import { config } from '../config.js';
import { joplinApi } from './joplin-api.js';
import { deserialize, markupLanguageOf, notePreview } from './serializer.js';
import { isEmptySearchQuery, matchesNamePattern, parseSearchQuery } from './search-query.js';
import { trashedTogether } from './trash.js';
import {
  JoplinItemType,
  Notebook,
  NoteDetail,
  NoteListItem,
  NoteTagLink,
  RawJoplinItem,
  ResourceMetadata,
  SearchResult,
  TagItem,
  TrashedNotebook,
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
  itemTimestamps: Map<string, number>;
  /** `updated_time` of the sync target's info.json in the last listing, null when it has none */
  syncInfoUpdatedTime: number | null;
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

/**
 * In-memory note cache service.
 * Maintains session-isolated caches of deserialized Joplin items with TTL auto-refreshing.
 */
export class NoteCacheService {
  private caches: Map<string, CacheEntry> = new Map();
  private lastIdleSweep = 0;

  /**
   * Retrieves or initializes the cache entry for a given session
   */
  private getOrCreateEntry(sessionId: string): CacheEntry {
    const now = Date.now();
    if (now - this.lastIdleSweep >= IDLE_SWEEP_INTERVAL_MS) this.evictIdleCaches(now);
    let entry = this.caches.get(sessionId);
    if (!entry) {
      entry = {
        lastFetched: 0,
        lastAccessed: now,
        fetchPromise: null,
        lastRefreshFailed: false,
        notebooks: new Map(),
        notes: new Map(),
        tags: new Map(),
        noteTags: [],
        resources: new Map(),
        itemTimestamps: new Map(),
        syncInfoUpdatedTime: null,
        encryptedItemIds: new Set(),
        masterKeyIds: new Set(),
        unreadableItems: new Set(),
        localChanges: new Map(),
      };
      this.caches.set(sessionId, entry);
    }
    entry.lastAccessed = now;
    return entry;
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
    return this.caches.has(sessionId);
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
    const pending = this.caches.get(sessionId)?.fetchPromise;
    if (pending) await pending.catch(() => undefined);
  }

  /**
   * Internal routine to synchronize items with Joplin Server
   */
  private async refreshCacheInternal(sessionId: string, entry: CacheEntry): Promise<void> {
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
      const writtenDuringListing = timestamp < 0 && -timestamp > listingStartedAt;
      if (!currentItemNames.has(name) && !writtenDuringListing) {
        this.forgetItem(entry, name.replace(/\.md$/i, ''));
      }
    }

    // 2. Fetch new or updated items in batches of 10 concurrent requests
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
                entry.resources.set(parsed.id, {
                  id: parsed.id,
                  title: parsed.title,
                  mime: parsed.properties.mime || 'application/octet-stream',
                  filename: parsed.properties.filename || '',
                  fileExtension: parsed.properties.file_extension || '',
                  size: Number(parsed.properties.size || 0),
                  updatedTime: parsed.updatedTime,
                });
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

    for (const [name, time] of entry.localChanges) {
      if (time < listingStartedAt) entry.localChanges.delete(name);
    }

    entry.lastFetched = Date.now();
    console.log(
      `[NoteCache] Synced session in ${Date.now() - startTime}ms. ` +
        `Notebooks: ${entry.notebooks.size}, Notes: ${entry.notes.size}, Tags: ${entry.tags.size}`
    );
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
      entry.resources.set(item.id, {
        id: item.id,
        title: item.title,
        mime: item.properties.mime || 'application/octet-stream',
        filename: item.properties.filename || '',
        fileExtension: item.properties.file_extension || '',
        size: Number(item.properties.size || 0),
        updatedTime: item.updatedTime,
      });
    } else if (item.type_ === JoplinItemType.NoteTag) {
      const noteId = item.properties.note_id || '';
      const tagId = item.properties.tag_id || '';
      entry.noteTags = entry.noteTags.filter((link) => link.id !== item.id);
      if (noteId && tagId) entry.noteTags.push({ id: item.id, noteId, tagId });
    }
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

    // Map to NoteListItem
    return matchingNotes.map((n) => ({
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
    }));
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
   * `parseSearchQuery`: all words/phrases must appear in the title or body, plus optional
   * `tag:`, `notebook:` (including sub-notebooks), `type:` and `iscompleted:` filters.
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

    const needsTags = parsed.tags.length > 0 || parsed.excludedTags.length > 0;
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

      const parentId = note.parentId || '';
      if (notebookFilter && !notebookFilter.has(parentId)) continue;
      if (excludedNotebookIds && excludedNotebookIds.has(parentId)) continue;

      if (needsTags) {
        const noteTagTitles = tagTitlesByNote.get(note.id) ?? [];
        const hasTag = (pattern: string) => noteTagTitles.some((title) => matchesNamePattern(title, pattern));
        if (!parsed.tags.every(hasTag) || parsed.excludedTags.some(hasTag)) continue;
      }

      const title = note.title || '';
      const body = note.body || '';
      const titleLower = title.toLowerCase();
      const bodyLower = body.toLowerCase();

      const contains = (term: string) => titleLower.includes(term) || bodyLower.includes(term);
      if (!parsed.terms.every(contains) || parsed.excludedTerms.some(contains)) continue;

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
      if (inBody) {
        const start = Math.max(0, matchIdx - 60);
        const end = Math.min(body.length, matchIdx + matchLength + 60);
        const rawSnippet = body.substring(start, end);
        snippet = `${start > 0 ? '...' : ''}${notePreview(rawSnippet, markupLanguageOf(note.properties), 150)}${
          end < body.length ? '...' : ''
        }`;
      }

      // Title matches receive higher priority
      const bodyHits = parsed.terms.filter((term) => bodyLower.includes(term)).length;
      const relevanceScore = titleHits * 100 + bodyHits * 10;

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
        encrypted: isEncrypted(note),
        matches: {
          inTitle,
          inBody,
          snippet,
          terms: parsed.terms,
        },
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
}

// Export singleton instance
export const noteCache = new NoteCacheService();
