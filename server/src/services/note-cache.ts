import { config } from '../config.js';
import { joplinApi } from './joplin-api.js';
import { deserialize, stripMarkdown } from './serializer.js';
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
} from '../types/index.js';

export interface CacheEntry {
  lastFetched: number;
  fetchPromise: Promise<void> | null;
  notebooks: Map<string, RawJoplinItem>;
  notes: Map<string, RawJoplinItem>;
  tags: Map<string, RawJoplinItem>;
  noteTags: NoteTagLink[];
  resources: Map<string, ResourceMetadata>;
  itemTimestamps: Map<string, number>;
}

/**
 * In-memory note cache service.
 * Maintains session-isolated caches of deserialized Joplin items with TTL auto-refreshing.
 */
export class NoteCacheService {
  private caches: Map<string, CacheEntry> = new Map();

  /**
   * Retrieves or initializes the cache entry for a given session
   */
  private getOrCreateEntry(sessionId: string): CacheEntry {
    let entry = this.caches.get(sessionId);
    if (!entry) {
      entry = {
        lastFetched: 0,
        fetchPromise: null,
        notebooks: new Map(),
        notes: new Map(),
        tags: new Map(),
        noteTags: [],
        resources: new Map(),
        itemTimestamps: new Map(),
      };
      this.caches.set(sessionId, entry);
    }
    return entry;
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
    const childItems = await joplinApi.listAllItems(sessionId);
    const currentItemNames = new Set<string>();

    // Identify which items need fetching/updating
    const itemsToFetch: Array<{ name: string; updated_time: number }> = [];

    for (const item of childItems) {
      currentItemNames.add(item.name);
      // Only process markdown item files for metadata
      if (item.name.endsWith('.md')) {
        const lastKnownTime = entry.itemTimestamps.get(item.name);
        if (lastKnownTime !== item.updated_time) {
          itemsToFetch.push({ name: item.name, updated_time: item.updated_time });
        }
      }
    }

    // Remove deleted items from the local cache
    for (const [name] of entry.itemTimestamps) {
      if (!currentItemNames.has(name)) {
        const id = name.replace(/\.md$/i, '');
        entry.itemTimestamps.delete(name);
        entry.notebooks.delete(id);
        entry.notes.delete(id);
        entry.tags.delete(id);
        entry.resources.delete(id);
        entry.noteTags = entry.noteTags.filter((link) => link.id !== id);
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

            // Record timestamp
            entry.itemTimestamps.set(item.name, item.updated_time);

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
            console.error(`[NoteCache] Error parsing item ${item.name}:`, err);
          }
        })
      );
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
   * Clears the cache for a session (e.g. upon logout)
   */
  public clearCache(sessionId: string): void {
    this.caches.delete(sessionId);
    console.log(`[NoteCache] Cleared cache for session ${sessionId.substring(0, 8)}...`);
  }

  /**
   * Returns the (fresh) cache entry for direct read access by the write service
   */
  public async getEntry(sessionId: string): Promise<CacheEntry> {
    return this.ensureFresh(sessionId);
  }

  /**
   * Inserts or replaces an item after it was written to Joplin Server, so reads reflect
   * the change immediately. The stored sync timestamp is dropped so the next refresh
   * re-reads the item from the server.
   */
  public upsertItem(sessionId: string, item: RawJoplinItem): void {
    const entry = this.getOrCreateEntry(sessionId);
    entry.itemTimestamps.delete(`${item.id}.md`);
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
    entry.itemTimestamps.delete(`${id}.md`);
    entry.notebooks.delete(id);
    entry.notes.delete(id);
    entry.tags.delete(id);
    entry.resources.delete(id);
    entry.noteTags = entry.noteTags.filter((link) => link.id !== id);
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
