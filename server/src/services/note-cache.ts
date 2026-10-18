import { config } from '../config.js';
import { joplinApi } from './joplin-api.js';
import { deserialize, stripMarkdown } from './serializer.js';
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

export interface CacheEntry {
  lastFetched: number;
  /** Last time the session read or wrote through the cache, for idle eviction */
  lastAccessed: number;
  fetchPromise: Promise<void> | null;
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
   * Ensures the session cache is fresh, triggering background synchronization if expired
   */
  public async ensureFresh(sessionId: string, force = false): Promise<CacheEntry> {
    const entry = this.getOrCreateEntry(sessionId);
    const now = Date.now();
    const isExpired = now - entry.lastFetched > config.cacheTtlMs;

    if (!force && !isExpired && entry.lastFetched > 0) {
      return entry;
    }

    // If already refreshing, wait for the existing promise to resolve
    if (entry.fetchPromise) {
      await entry.fetchPromise;
      return entry;
    }

    // Launch refresh
    entry.fetchPromise = this.refreshCacheInternal(sessionId, entry);
    try {
      await entry.fetchPromise;
    } finally {
      entry.fetchPromise = null;
    }

    return entry;
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
    await this.ensureFresh(sessionId, true);
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
   * Returns the (fresh) cache entry for direct read access by the write service
   */
  public async getEntry(sessionId: string): Promise<CacheEntry> {
    return this.ensureFresh(sessionId);
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

    // Map each raw folder into a Notebook object
    const nodeMap = new Map<string, Notebook>();

    for (const nb of activeNotebooks) {
      // Calculate note count for direct active notes belonging to this notebook
      const directNoteCount = Array.from(entry.notes.values()).filter(
        (note) => note.parentId === nb.id && (!note.deletedTime || note.deletedTime === 0)
      ).length;

      nodeMap.set(nb.id, {
        id: nb.id,
        title: nb.title || 'Untitled Notebook',
        parentId: nb.parentId || '',
        children: [],
        noteCount: directNoteCount,
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
          title: root.title || 'Untitled Notebook',
          parentId: root.parentId || '',
          deletedTime: root.deletedTime,
          noteCount,
          notebookCount,
          earlierNoteCount,
        };
      })
      .sort((a, b) => b.deletedTime - a.deletedTime);
  }

  /**
   * Retrieves notes with optional filtering by notebook or tag
   *
   * @param sessionId Active session ID
   * @param filters Optional filter criteria (notebookId, tagId)
   * @returns List of matching NoteListItems, sorted by updatedTime descending
   */
  /**
   * Retrieves notes with optional filtering by notebook or tag
   * By default, returns only active (non-deleted) notes whose parent notebook is also not deleted.
   *
   * @param sessionId Active session ID
   * @param filters Optional filter criteria (notebookId, tagId, isTrash)
   * @returns List of matching NoteListItems, sorted by updatedTime descending
   */
  public async getNotes(
    sessionId: string,
    filters?: { notebookId?: string; tagId?: string; isTrash?: boolean }
  ): Promise<NoteListItem[]> {
    const entry = await this.ensureFresh(sessionId);

    // Identify deleted notebooks
    const deletedNotebookIds = new Set(
      Array.from(entry.notebooks.values())
        .filter((nb) => nb.deletedTime && nb.deletedTime > 0)
        .map((nb) => nb.id)
    );

    let matchingNotes = Array.from(entry.notes.values());

    if (filters?.isTrash) {
      // In Trash: note itself has deletedTime > 0, OR its parent notebook is deleted
      matchingNotes = matchingNotes.filter(
        (n) => (n.deletedTime && n.deletedTime > 0) || (n.parentId && deletedNotebookIds.has(n.parentId))
      );
    } else {
      // Active notes: note itself has no deletedTime AND parent notebook is not deleted
      matchingNotes = matchingNotes.filter(
        (n) => (!n.deletedTime || n.deletedTime === 0) && (!n.parentId || !deletedNotebookIds.has(n.parentId))
      );
    }

    // Filter by notebook if specified
    if (filters?.notebookId) {
      matchingNotes = matchingNotes.filter((n) => n.parentId === filters.notebookId);
    }

    // Filter by tag if specified
    if (filters?.tagId) {
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
      preview: stripMarkdown(n.body, 150),
      isTodo: n.isTodo,
      todoCompleted: Boolean(n.todoCompleted),
      todoDue: n.todoDue,
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
      ? { id: notebookItem.id, title: notebookItem.title || 'Untitled Notebook' }
      : null;

    // Check if parent notebook is deleted
    const isParentDeleted = notebookItem ? Boolean(notebookItem.deletedTime && notebookItem.deletedTime > 0) : false;
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
      .map((t) => ({ id: t.id, title: t.title || 'Untitled Tag' }));

    return {
      id: note.id,
      title: note.title,
      body: note.body,
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

    const tagsList: TagItem[] = [];

    for (const tag of entry.tags.values()) {
      // Count distinct active notes linked to this tag
      const noteIds = new Set<string>();
      for (const link of entry.noteTags) {
        if (link.tagId === tag.id) {
          const note = entry.notes.get(link.noteId);
          if (
            note &&
            (!note.deletedTime || note.deletedTime === 0) &&
            (!note.parentId || !deletedNotebookIds.has(note.parentId))
          ) {
            noteIds.add(link.noteId);
          }
        }
      }

      tagsList.push({
        id: tag.id,
        title: tag.title || 'Untitled Tag',
        noteCount: noteIds.size,
      });
    }

    // Sort alphabetically by tag title
    tagsList.sort((a, b) => a.title.localeCompare(b.title));
    return tagsList;
  }

  /**
   * Searches notes across titles and body contents (excludes trashed notes by default)
   *
   * @param sessionId Active session ID
   * @param query Search query string
   * @returns Matching SearchResults sorted by relevance and updatedTime
   */
  public async searchNotes(sessionId: string, query: string): Promise<SearchResult[]> {
    const entry = await this.ensureFresh(sessionId);
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      return [];
    }

    const deletedNotebookIds = new Set(
      Array.from(entry.notebooks.values())
        .filter((nb) => nb.deletedTime && nb.deletedTime > 0)
        .map((nb) => nb.id)
    );

    const results: Array<SearchResult & { relevanceScore: number }> = [];

    for (const note of entry.notes.values()) {
      // Exclude trashed notes from search
      if (
        (note.deletedTime && note.deletedTime > 0) ||
        (note.parentId && deletedNotebookIds.has(note.parentId))
      ) {
        continue;
      }
      const title = note.title || '';
      const body = note.body || '';
      const titleLower = title.toLowerCase();
      const bodyLower = body.toLowerCase();

      const inTitle = titleLower.includes(trimmed);
      const inBody = bodyLower.includes(trimmed);

      if (inTitle || inBody) {
        let snippet = '';
        if (inBody) {
          const matchIdx = bodyLower.indexOf(trimmed);
          const start = Math.max(0, matchIdx - 60);
          const end = Math.min(body.length, matchIdx + trimmed.length + 60);
          const rawSnippet = body.substring(start, end);
          snippet = `${start > 0 ? '...' : ''}${stripMarkdown(rawSnippet, 150)}${
            end < body.length ? '...' : ''
          }`;
        }

        // Title matches receive higher priority
        const relevanceScore = (inTitle ? 100 : 0) + (inBody ? 10 : 0);

        results.push({
          id: note.id,
          title,
          parentId: note.parentId || '',
          createdTime: note.createdTime,
          updatedTime: note.updatedTime,
          deletedTime: note.deletedTime || 0,
          preview: stripMarkdown(note.body, 150),
          isTodo: note.isTodo,
          todoCompleted: Boolean(note.todoCompleted),
          todoDue: note.todoDue,
          matches: {
            inTitle,
            inBody,
            snippet,
          },
          relevanceScore,
        });
      }
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
