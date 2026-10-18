import { randomUUID } from 'crypto';
import { JoplinApiError, JoplinNotFoundError, joplinApi } from './joplin-api.js';
import { noteCache } from './note-cache.js';
import { deserialize, serialize } from './serializer.js';
import {
  defaultFolderProperties,
  defaultNoteProperties,
  defaultNoteTagProperties,
  defaultResourceProperties,
  defaultTagProperties,
} from './item-defaults.js';
import { JoplinItemType, NoteDetail, RawJoplinItem } from '../types/index.js';

/**
 * Thrown when an item changed on Joplin Server since the client loaded it
 */
export class ConflictError extends JoplinApiError {
  public current: NoteDetail | null;

  constructor(current: NoteDetail | null) {
    super('The note was changed elsewhere since you opened it', 409, { conflict: true, current });
    this.name = 'ConflictError';
    this.current = current;
  }
}

/**
 * Thrown for invalid write requests (bad ids, encrypted items, wrong item type, ...)
 */
export class WriteValidationError extends JoplinApiError {
  constructor(message: string, status = 400) {
    super(message, status);
    this.name = 'WriteValidationError';
  }
}

const ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Validates a Joplin item id, so it can be safely used in Joplin Server item paths
 */
export function assertValidId(id: string | undefined, label = 'id'): string {
  if (!id || !ID_PATTERN.test(id)) {
    throw new WriteValidationError(`Invalid ${label}: expected 32 lowercase hex characters`);
  }
  return id;
}

/** Refuses to modify an item that is end-to-end encrypted */
function assertNotEncrypted(item: RawJoplinItem): void {
  if (item.properties.encryption_applied === '1') {
    throw new WriteValidationError('This item is end-to-end encrypted and cannot be edited here', 422);
  }
}

const TYPE_NAMES: Partial<Record<JoplinItemType, string>> = {
  [JoplinItemType.Note]: 'note',
  [JoplinItemType.Folder]: 'notebook',
  [JoplinItemType.Tag]: 'tag',
  [JoplinItemType.Resource]: 'resource',
};

/** Refuses an item of another type than expected (e.g. a notebook id passed as a note id) */
function assertType(item: RawJoplinItem, type: JoplinItemType): void {
  if (item.type_ !== type) {
    throw new WriteValidationError(`Item ${item.id} is not a ${TYPE_NAMES[type] ?? 'supported item'}`, 404);
  }
}

/** How long a successful E2EE check of info.json is reused while its `updated_time` is unchanged */
const WRITABLE_CHECK_TTL_MS = 60_000;

/** Parallel Joplin Server reads when collecting a notebook subtree (same as the cache refresh) */
const SUBTREE_READ_CONCURRENCY = 10;

/** Maps items with at most `limit` calls of `fn` in flight, keeping the input order */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Generates a Joplin-style id (uuid v4 without dashes) */
function newId(): string {
  return randomUUID().replace(/-/g, '');
}

function sanitizeTitle(title: string | undefined): string {
  return (title ?? '').replace(/[\r\n]+/g, ' ').trim();
}

/** Marks properties as modified now, the way Joplin desktop does on save */
function touch(props: Record<string, string>): void {
  const now = new Date().toISOString();
  props.updated_time = now;
  props.user_updated_time = now;
}

/**
 * Write operations against Joplin Server. Every write re-reads the item from the server first,
 * keeps its original properties, and updates the in-memory cache afterwards.
 */
export class NoteWriterService {
  /** Successful info.json checks per session, see `assertWritable` */
  private writableChecks = new Map<string, { checkedAt: number; infoUpdatedTime: number | null; infoMissing: boolean }>();

  /**
   * Refuses every write when the account uses end-to-end encryption. Joplin Web cannot encrypt,
   * so anything it wrote would be stored and synced in plaintext.
   *
   * A successful check is reused for up to a minute while the cache listing shows the same
   * info.json `updated_time`, so autosaves do not re-read info.json each time. Without an
   * info.json (sync targets from before sync version 3), master key items or encrypted items in
   * the cache are taken as a sign of E2EE and also make the account read-only.
   */
  private async assertWritable(sessionId: string): Promise<void> {
    const entry = await noteCache.getEntry(sessionId);
    const now = Date.now();
    const cached = this.writableChecks.get(sessionId);
    let infoMissing: boolean;
    if (cached && now - cached.checkedAt < WRITABLE_CHECK_TTL_MS && cached.infoUpdatedTime === entry.syncInfoUpdatedTime) {
      infoMissing = cached.infoMissing;
    } else {
      this.writableChecks.delete(sessionId);
      infoMissing = await this.checkSyncTargetInfo(sessionId);
      for (const [id, check] of this.writableChecks) {
        if (now - check.checkedAt >= WRITABLE_CHECK_TTL_MS) this.writableChecks.delete(id);
      }
      this.writableChecks.set(sessionId, { checkedAt: now, infoUpdatedTime: entry.syncInfoUpdatedTime, infoMissing });
    }
    // An item that could not be read might be a master key, so it counts as one (fail safe)
    const encryptedData =
      entry.masterKeyIds.size > 0 || entry.encryptedItemIds.size > 0 || entry.unreadableItems.size > 0;
    if (infoMissing && encryptedData) {
      throw new WriteValidationError(
        'This account has end-to-end encrypted data. Joplin Web cannot encrypt data, so it is read-only here',
        422
      );
    }
  }

  /**
   * Reads info.json and throws when E2EE is enabled. Mirrors Joplin's SyncTargetInfo: E2EE is on
   * when `info.json` has `e2ee.value === true`. An unreadable info.json fails closed, as Joplin
   * desktop also refuses to sync with it.
   *
   * @returns true when the sync target has no info.json
   */
  private async checkSyncTargetInfo(sessionId: string): Promise<boolean> {
    const raw = await joplinApi.getSyncTargetInfo(sessionId);
    if (raw === null || raw.trim() === '') return true;
    let e2ee: unknown;
    try {
      const info = JSON.parse(raw) as { e2ee?: unknown };
      e2ee = info.e2ee;
    } catch {
      throw new WriteValidationError(
        'Cannot read the sync target info (info.json), so Joplin Web does not write to this account',
        422
      );
    }
    const enabled = e2ee === true || (typeof e2ee === 'object' && e2ee !== null && (e2ee as { value?: unknown }).value === true);
    if (enabled) {
      throw new WriteValidationError(
        'This account uses end-to-end encryption. Joplin Web cannot encrypt data, so it is read-only here',
        422
      );
    }
    return false;
  }

  /** Reads the current server version of an item (bypassing the cache), or null if it is gone */
  private async readFresh(sessionId: string, id: string): Promise<RawJoplinItem | null> {
    try {
      const raw = await joplinApi.getItemContent(sessionId, `${id}.md`);
      return deserialize(raw, `${id}.md`);
    } catch (err) {
      if (err instanceof JoplinNotFoundError) return null;
      throw err;
    }
  }

  /** Reads the current server version of an item (bypassing the cache) */
  private async fetchFresh(sessionId: string, id: string): Promise<RawJoplinItem> {
    const raw = await joplinApi.getItemContent(sessionId, `${id}.md`);
    const item = deserialize(raw, `${id}.md`);
    assertNotEncrypted(item);
    return item;
  }

  private async fetchFreshOfType(sessionId: string, id: string, type: JoplinItemType): Promise<RawJoplinItem> {
    const item = await this.fetchFresh(sessionId, id);
    assertType(item, type);
    return item;
  }

  /** Serializes and uploads an item, then mirrors it into the cache */
  private async write(
    sessionId: string,
    item: { type_: number; title?: string; body: string; properties: Record<string, string> }
  ): Promise<RawJoplinItem> {
    const content = serialize(item);
    const id = item.properties.id;
    await joplinApi.createOrUpdateItem(sessionId, `${id}.md`, content);
    const written = deserialize(content, `${id}.md`);
    noteCache.upsertItem(sessionId, written);
    return written;
  }

  /**
   * Ensures a notebook exists on Joplin Server, is not in the trash and is not encrypted
   * (a cleartext note inside an encrypted notebook would defeat E2EE). Reads it fresh, so a
   * notebook trashed or deleted by another client since the last cache refresh is refused.
   */
  private async assertActiveNotebook(sessionId: string, notebookId: string): Promise<void> {
    assertValidId(notebookId, 'notebook id');
    const notebook = await this.readFresh(sessionId, notebookId);
    if (!notebook || notebook.type_ !== JoplinItemType.Folder || notebook.deletedTime > 0) {
      throw new WriteValidationError(`Notebook not found: ${notebookId}`, 404);
    }
    if (notebook.properties.encryption_applied === '1') {
      throw new WriteValidationError('This notebook is end-to-end encrypted, so nothing can be added to it here', 422);
    }
  }

  private async noteDetail(sessionId: string, id: string): Promise<NoteDetail> {
    const detail = await noteCache.getNote(sessionId, id);
    if (!detail) {
      throw new WriteValidationError(`Note not found: ${id}`, 404);
    }
    return detail;
  }

  // ---------------------------------------------------------------------------
  // Notes
  // ---------------------------------------------------------------------------

  public async createNote(
    sessionId: string,
    input: { title?: string; body?: string; parentId: string; isTodo?: boolean }
  ): Promise<NoteDetail> {
    assertValidId(input.parentId, 'notebook id');
    await this.assertWritable(sessionId);
    await this.assertActiveNotebook(sessionId, input.parentId);
    const id = newId();
    await this.write(sessionId, {
      type_: JoplinItemType.Note,
      title: sanitizeTitle(input.title),
      body: input.body ?? '',
      properties: defaultNoteProperties(id, input.parentId, Boolean(input.isTodo)),
    });
    return this.noteDetail(sessionId, id);
  }

  public async updateNote(
    sessionId: string,
    id: string,
    changes: {
      title?: string;
      body?: string;
      parentId?: string;
      todoCompleted?: boolean;
      baseUpdatedTime?: number;
      force?: boolean;
    }
  ): Promise<NoteDetail> {
    assertValidId(id, 'note id');
    await this.assertWritable(sessionId);
    const current = await this.fetchFreshOfType(sessionId, id, JoplinItemType.Note);

    if (!changes.force && changes.baseUpdatedTime !== undefined && current.updatedTime !== changes.baseUpdatedTime) {
      // Refresh the cache with the server version so the client can show it
      noteCache.upsertItem(sessionId, current);
      throw new ConflictError(await noteCache.getNote(sessionId, id));
    }

    const props = { ...current.properties };
    if (changes.parentId !== undefined && changes.parentId !== current.parentId) {
      await this.assertActiveNotebook(sessionId, changes.parentId);
      props.parent_id = changes.parentId;
    }
    if (changes.todoCompleted !== undefined) {
      props.todo_completed = changes.todoCompleted ? String(Date.now()) : '0';
    }
    touch(props);

    await this.write(sessionId, {
      type_: JoplinItemType.Note,
      title: changes.title !== undefined ? sanitizeTitle(changes.title) : current.title,
      body: changes.body !== undefined ? changes.body : current.body,
      properties: props,
    });
    return this.noteDetail(sessionId, id);
  }

  /** Moves a note to the trash (soft delete, syncs to Joplin's trash) */
  public async trashNote(sessionId: string, id: string): Promise<void> {
    assertValidId(id, 'note id');
    await this.assertWritable(sessionId);
    const current = await this.fetchFreshOfType(sessionId, id, JoplinItemType.Note);
    if (current.deletedTime > 0) return;
    const props = { ...current.properties, deleted_time: String(Date.now()) };
    touch(props);
    await this.write(sessionId, { type_: JoplinItemType.Note, title: current.title, body: current.body, properties: props });
  }

  /** Restores a note from the trash, including any trashed parent notebooks */
  public async restoreNote(sessionId: string, id: string): Promise<NoteDetail> {
    assertValidId(id, 'note id');
    await this.assertWritable(sessionId);
    const current = await this.fetchFreshOfType(sessionId, id, JoplinItemType.Note);

    // Read the whole notebook chain first, so an encrypted ancestor stops the restore
    // before anything is written
    const trashedAncestors: RawJoplinItem[] = [];
    for (const folder of await this.freshAncestors(sessionId, current.parentId)) {
      if (folder.deletedTime > 0) {
        assertNotEncrypted(folder);
        trashedAncestors.push(folder);
      }
    }
    for (const folder of trashedAncestors) {
      const folderProps = { ...folder.properties, deleted_time: '0' };
      touch(folderProps);
      await this.write(sessionId, { type_: JoplinItemType.Folder, title: folder.title, body: '', properties: folderProps });
    }

    if (current.deletedTime > 0) {
      const props = { ...current.properties, deleted_time: '0' };
      touch(props);
      await this.write(sessionId, { type_: JoplinItemType.Note, title: current.title, body: current.body, properties: props });
    }
    return this.noteDetail(sessionId, id);
  }

  /**
   * Permanently deletes a note and its note-tag links from Joplin Server. Like Joplin's
   * "Delete permanently", this only applies to notes in the trash: the note itself is trashed
   * or one of its notebooks is. The note is re-read first, so other item types, encrypted
   * notes and notes restored or moved elsewhere by another client are refused.
   */
  public async purgeNote(sessionId: string, id: string): Promise<void> {
    assertValidId(id, 'note id');
    await this.assertWritable(sessionId);
    const current = await this.readFresh(sessionId, id);
    if (!current) {
      // Already deleted on the server (e.g. the trash was emptied on another device)
      await this.deleteNoteAndLinks(sessionId, id);
      return;
    }
    assertType(current, JoplinItemType.Note);
    assertNotEncrypted(current);

    if (!(current.deletedTime > 0)) {
      const ancestors = await this.freshAncestors(sessionId, current.parentId);
      if (!ancestors.some((folder) => folder.deletedTime > 0)) {
        throw new WriteValidationError('Only notes in the trash can be deleted permanently', 409);
      }
    }
    await this.deleteNoteAndLinks(sessionId, id);
  }

  /**
   * Reads the notebook chain above an item from Joplin Server, nearest parent first.
   * Stops at the root, at a missing notebook or at a cycle.
   */
  private async freshAncestors(sessionId: string, parentId: string): Promise<RawJoplinItem[]> {
    const chain: RawJoplinItem[] = [];
    const visited = new Set<string>();
    let cursor = parentId;
    while (cursor && ID_PATTERN.test(cursor) && !visited.has(cursor)) {
      visited.add(cursor);
      const folder = await this.readFresh(sessionId, cursor);
      if (!folder || folder.type_ !== JoplinItemType.Folder) break;
      chain.push(folder);
      cursor = folder.parentId;
    }
    return chain;
  }

  /** Deletes a note item and its note-tag links (callers have checked that it may be purged) */
  private async deleteNoteAndLinks(sessionId: string, id: string): Promise<void> {
    const entry = await noteCache.getEntry(sessionId);
    const linkIds = entry.noteTags.filter((link) => link.noteId === id).map((link) => link.id);

    await joplinApi.deleteItem(sessionId, `${id}.md`);
    noteCache.removeItem(sessionId, id);

    for (const linkId of linkIds) {
      if (!ID_PATTERN.test(linkId)) continue;
      await joplinApi.deleteItem(sessionId, `${linkId}.md`);
      noteCache.removeItem(sessionId, linkId);
    }
  }

  // ---------------------------------------------------------------------------
  // Notebooks
  // ---------------------------------------------------------------------------

  public async createNotebook(
    sessionId: string,
    input: { title: string; parentId?: string }
  ): Promise<{ id: string; title: string; parentId: string }> {
    const title = sanitizeTitle(input.title);
    if (!title) throw new WriteValidationError('Notebook title is required');
    const parentId = input.parentId || '';
    if (parentId) assertValidId(parentId, 'notebook id');
    await this.assertWritable(sessionId);
    if (parentId) await this.assertActiveNotebook(sessionId, parentId);

    const id = newId();
    await this.write(sessionId, {
      type_: JoplinItemType.Folder,
      title,
      body: '',
      properties: defaultFolderProperties(id, parentId),
    });
    return { id, title, parentId };
  }

  public async updateNotebook(
    sessionId: string,
    id: string,
    changes: { title?: string; parentId?: string }
  ): Promise<{ id: string; title: string; parentId: string }> {
    assertValidId(id, 'notebook id');
    await this.assertWritable(sessionId);
    const current = await this.fetchFreshOfType(sessionId, id, JoplinItemType.Folder);
    const props = { ...current.properties };

    let title = current.title;
    if (changes.title !== undefined) {
      title = sanitizeTitle(changes.title);
      if (!title) throw new WriteValidationError('Notebook title is required');
    }

    if (changes.parentId !== undefined && changes.parentId !== current.parentId) {
      if (changes.parentId) {
        await this.assertActiveNotebook(sessionId, changes.parentId);
        // Prevent moving a notebook into itself or one of its descendants
        const entry = await noteCache.getEntry(sessionId);
        let cursor: string | undefined = changes.parentId;
        const seen = new Set<string>();
        while (cursor && !seen.has(cursor)) {
          if (cursor === id) throw new WriteValidationError('Cannot move a notebook into itself');
          seen.add(cursor);
          cursor = entry.notebooks.get(cursor)?.parentId;
        }
      }
      props.parent_id = changes.parentId;
    }

    touch(props);
    await this.write(sessionId, { type_: JoplinItemType.Folder, title, body: '', properties: props });
    return { id, title, parentId: props.parent_id || '' };
  }

  /**
   * Reads a notebook subtree fresh from Joplin Server: the root, its sub-notebooks and their
   * notes. The candidates come from the cache; each one is re-read and kept only if it still
   * belongs to the subtree, so items moved elsewhere by another client are never touched.
   * Every item is checked before the caller writes anything, so an encrypted item stops the
   * whole operation up front instead of leaving it half done.
   */
  private async freshSubtree(
    sessionId: string,
    root: RawJoplinItem
  ): Promise<{ folders: RawJoplinItem[]; notes: RawJoplinItem[] }> {
    const entry = await noteCache.getEntry(sessionId);
    const folders: RawJoplinItem[] = [root];
    const folderIds = new Set([root.id]);

    // Breadth-first, one level at a time, so a parent is always verified before its children
    let level: RawJoplinItem[] = [root];
    while (level.length > 0) {
      const parentIds = new Set(level.map((folder) => folder.id));
      const candidates = [...entry.notebooks.values()].filter(
        (cached) => parentIds.has(cached.parentId) && !folderIds.has(cached.id) && ID_PATTERN.test(cached.id)
      );
      const fresh = await mapLimit(candidates, SUBTREE_READ_CONCURRENCY, (cached) => this.readFresh(sessionId, cached.id));
      level = [];
      for (const [index, folder] of fresh.entries()) {
        if (!folder || folder.type_ !== JoplinItemType.Folder || folder.parentId !== candidates[index].parentId) continue;
        if (folderIds.has(folder.id)) continue;
        assertNotEncrypted(folder);
        folders.push(folder);
        folderIds.add(folder.id);
        level.push(folder);
      }
    }

    const candidates = [...entry.notes.values()].filter(
      (cached) => folderIds.has(cached.parentId) && ID_PATTERN.test(cached.id)
    );
    const fresh = await mapLimit(candidates, SUBTREE_READ_CONCURRENCY, (cached) => this.readFresh(sessionId, cached.id));
    const notes: RawJoplinItem[] = [];
    for (const note of fresh) {
      if (!note || note.type_ !== JoplinItemType.Note || !folderIds.has(note.parentId)) continue;
      assertNotEncrypted(note);
      notes.push(note);
    }
    return { folders, notes };
  }

  /**
   * Moves a notebook, its sub-notebooks and all their notes to the trash,
   * matching Joplin desktop's trash behaviour. All items are checked before the first write.
   */
  public async trashNotebook(sessionId: string, id: string): Promise<{ notebooks: number; notes: number }> {
    assertValidId(id, 'notebook id');
    await this.assertWritable(sessionId);
    const root = await this.fetchFreshOfType(sessionId, id, JoplinItemType.Folder);
    const { folders, notes } = await this.freshSubtree(sessionId, root);
    const activeNotes = notes.filter((note) => !(note.deletedTime > 0));

    const deletedTime = String(Date.now());
    const trash = async (item: RawJoplinItem) => {
      if (item.deletedTime > 0) return;
      const props = { ...item.properties, deleted_time: deletedTime };
      touch(props);
      await this.write(sessionId, { type_: item.type_, title: item.title, body: item.body, properties: props });
    };

    // Notes first, so an interrupted operation never leaves visible notes under a trashed notebook
    for (const note of activeNotes) await trash(note);
    for (const folder of [...folders].reverse()) await trash(folder);

    return { notebooks: folders.length, notes: activeNotes.length };
  }

  /**
   * Permanently deletes a trashed notebook with its sub-notebooks and their notes.
   * Only notebooks that are already in the trash can be purged. The cache is refreshed and
   * every item re-read first, so notes restored or moved out by another client survive.
   */
  public async purgeNotebook(sessionId: string, id: string): Promise<{ notebooks: number; notes: number }> {
    assertValidId(id, 'notebook id');
    await this.assertWritable(sessionId);
    const root = await this.fetchFreshOfType(sessionId, id, JoplinItemType.Folder);
    if (!(root.deletedTime > 0)) {
      throw new WriteValidationError('Only notebooks in the trash can be deleted permanently', 409);
    }
    // Pick up notes moved into or out of the notebook elsewhere since the last refresh
    await noteCache.refreshCache(sessionId);
    const { folders, notes } = await this.freshSubtree(sessionId, root);

    for (const note of notes) await this.deleteNoteAndLinks(sessionId, note.id);
    for (const folder of [...folders].reverse()) {
      await joplinApi.deleteItem(sessionId, `${folder.id}.md`);
      noteCache.removeItem(sessionId, folder.id);
    }
    return { notebooks: folders.length, notes: notes.length };
  }

  // ---------------------------------------------------------------------------
  // Resources (attachments)
  // ---------------------------------------------------------------------------

  /**
   * Stores an attachment: uploads the file first, then the resource metadata item (type 4),
   * so clients never see metadata without its file.
   */
  public async createResource(
    sessionId: string,
    file: { name: string; mime: string; data: Buffer }
  ): Promise<{ id: string; title: string; mime: string; size: number }> {
    if (file.data.length === 0) throw new WriteValidationError('The file is empty');
    const title = sanitizeTitle(file.name) || 'file';
    const dot = title.lastIndexOf('.');
    const extension = dot > 0 ? title.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) : '';
    await this.assertWritable(sessionId);

    const id = newId();
    await joplinApi.uploadResourceBinary(sessionId, id, file.data);
    await this.write(sessionId, {
      type_: JoplinItemType.Resource,
      title,
      body: '',
      properties: defaultResourceProperties(id, { mime: file.mime, extension, size: file.data.length }),
    });
    return { id, title, mime: file.mime, size: file.data.length };
  }

  /** Permanently deletes an attachment: its metadata item first, then the file */
  public async deleteResource(sessionId: string, resourceId: string): Promise<void> {
    assertValidId(resourceId, 'resource id');
    await this.assertWritable(sessionId);
    await this.fetchFreshOfType(sessionId, resourceId, JoplinItemType.Resource);
    await joplinApi.deleteItem(sessionId, `${resourceId}.md`);
    noteCache.removeItem(sessionId, resourceId);
    await joplinApi.deleteResourceBinary(sessionId, resourceId);
  }

  // ---------------------------------------------------------------------------
  // Tags
  // ---------------------------------------------------------------------------

  /**
   * Tags a note. Reuses an existing tag with the same title (case-insensitive, like Joplin),
   * otherwise creates it. Tagging doesn't modify the note item itself.
   */
  public async addTagToNote(sessionId: string, noteId: string, title: string): Promise<NoteDetail> {
    assertValidId(noteId, 'note id');
    const tagTitle = sanitizeTitle(title);
    if (!tagTitle) throw new WriteValidationError('Tag title is required');
    await this.assertWritable(sessionId);
    const note = await this.fetchFreshOfType(sessionId, noteId, JoplinItemType.Note);
    // Like creating a note in a trashed notebook: a note in the trash cannot be tagged
    const inTrash =
      note.deletedTime > 0 || (await this.freshAncestors(sessionId, note.parentId)).some((f) => f.deletedTime > 0);
    if (inTrash) throw new WriteValidationError(`Note not found: ${noteId}`, 404);

    const entry = await noteCache.getEntry(sessionId);
    let tag = Array.from(entry.tags.values()).find(
      (t) => t.title.trim().toLowerCase() === tagTitle.toLowerCase()
    );
    if (tag) {
      // Never link a note to an encrypted tag, or to one deleted elsewhere since the last refresh
      const fresh = await this.readFresh(sessionId, tag.id);
      if (fresh && fresh.type_ === JoplinItemType.Tag) {
        assertNotEncrypted(fresh);
      } else {
        noteCache.removeItem(sessionId, tag.id);
        tag = undefined;
      }
    }
    if (!tag) {
      tag = await this.write(sessionId, {
        type_: JoplinItemType.Tag,
        title: tagTitle,
        body: '',
        properties: defaultTagProperties(newId()),
      });
    }

    const alreadyTagged = entry.noteTags.some((link) => link.noteId === noteId && link.tagId === tag!.id);
    if (!alreadyTagged) {
      const linkId = newId();
      await this.write(sessionId, {
        type_: JoplinItemType.NoteTag,
        body: '',
        properties: defaultNoteTagProperties(linkId, noteId, tag.id),
      });
    }
    return this.noteDetail(sessionId, noteId);
  }

  /** Removes a tag from a note (deletes the note-tag link items; the tag itself stays) */
  public async removeTagFromNote(sessionId: string, noteId: string, tagId: string): Promise<NoteDetail> {
    assertValidId(noteId, 'note id');
    assertValidId(tagId, 'tag id');
    await this.assertWritable(sessionId);
    const entry = await noteCache.getEntry(sessionId);
    const links = entry.noteTags.filter((link) => link.noteId === noteId && link.tagId === tagId);
    for (const link of links) {
      if (!ID_PATTERN.test(link.id)) continue;
      await joplinApi.deleteItem(sessionId, `${link.id}.md`);
      noteCache.removeItem(sessionId, link.id);
    }
    return this.noteDetail(sessionId, noteId);
  }

  public async renameTag(sessionId: string, tagId: string, title: string): Promise<{ id: string; title: string }> {
    assertValidId(tagId, 'tag id');
    const tagTitle = sanitizeTitle(title);
    if (!tagTitle) throw new WriteValidationError('Tag title is required');
    await this.assertWritable(sessionId);

    const entry = await noteCache.getEntry(sessionId);
    const clash = Array.from(entry.tags.values()).find(
      (t) => t.id !== tagId && t.title.trim().toLowerCase() === tagTitle.toLowerCase()
    );
    if (clash) throw new WriteValidationError(`A tag named "${clash.title}" already exists`, 409);

    const current = await this.fetchFreshOfType(sessionId, tagId, JoplinItemType.Tag);
    const props = { ...current.properties };
    touch(props);
    await this.write(sessionId, { type_: JoplinItemType.Tag, title: tagTitle, body: '', properties: props });
    return { id: tagId, title: tagTitle };
  }

  /** Deletes a tag and all its note-tag links; the notes themselves are untouched */
  public async deleteTag(sessionId: string, tagId: string): Promise<{ notes: number }> {
    assertValidId(tagId, 'tag id');
    await this.assertWritable(sessionId);
    await this.fetchFreshOfType(sessionId, tagId, JoplinItemType.Tag);
    const entry = await noteCache.getEntry(sessionId);
    const links = entry.noteTags.filter((link) => link.tagId === tagId);

    for (const link of links) {
      if (!ID_PATTERN.test(link.id)) continue;
      await joplinApi.deleteItem(sessionId, `${link.id}.md`);
      noteCache.removeItem(sessionId, link.id);
    }
    await joplinApi.deleteItem(sessionId, `${tagId}.md`);
    noteCache.removeItem(sessionId, tagId);
    return { notes: links.length };
  }
}

export const noteWriter = new NoteWriterService();

