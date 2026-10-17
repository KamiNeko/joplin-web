import { v4 as uuidv4 } from 'uuid';
import { JoplinApiError, joplinApi } from './joplin-api.js';
import { noteCache } from './note-cache.js';
import { deserialize, serialize } from './serializer.js';
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

/** Generates a Joplin-style id (uuid v4 without dashes) */
function newId(): string {
  return uuidv4().replace(/-/g, '');
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

/** Default property set Joplin desktop writes for a new note */
function defaultNoteProperties(id: string, parentId: string, isTodo: boolean): Record<string, string> {
  const now = new Date().toISOString();
  return {
    id,
    parent_id: parentId,
    created_time: now,
    updated_time: now,
    is_conflict: '0',
    latitude: '0.00000000',
    longitude: '0.00000000',
    altitude: '0.0000',
    author: '',
    source_url: '',
    is_todo: isTodo ? '1' : '0',
    todo_due: '0',
    todo_completed: '0',
    source: 'joplin-web',
    source_application: 'net.cozic.joplin-web',
    application_data: '',
    order: '0',
    user_created_time: now,
    user_updated_time: now,
    encryption_cipher_text: '',
    encryption_applied: '0',
    markup_language: '1',
    is_shared: '0',
    share_id: '',
    conflict_original_id: '',
    master_key_id: '',
    user_data: '',
    deleted_time: '0',
  };
}

/** Default property set Joplin desktop writes for a new notebook */
function defaultFolderProperties(id: string, parentId: string): Record<string, string> {
  const now = new Date().toISOString();
  return {
    id,
    created_time: now,
    updated_time: now,
    user_created_time: now,
    user_updated_time: now,
    encryption_cipher_text: '',
    encryption_applied: '0',
    parent_id: parentId,
    is_shared: '0',
    share_id: '',
    master_key_id: '',
    icon: '',
    user_data: '',
    deleted_time: '0',
  };
}

/** Default property set Joplin desktop writes for a new tag */
function defaultTagProperties(id: string): Record<string, string> {
  const now = new Date().toISOString();
  return {
    id,
    created_time: now,
    updated_time: now,
    user_created_time: now,
    user_updated_time: now,
    encryption_cipher_text: '',
    encryption_applied: '0',
    is_shared: '0',
    parent_id: '',
    user_data: '',
  };
}

/** Default property set Joplin desktop writes for a note-tag link */
function defaultNoteTagProperties(id: string, noteId: string, tagId: string): Record<string, string> {
  const now = new Date().toISOString();
  return {
    id,
    note_id: noteId,
    tag_id: tagId,
    created_time: now,
    updated_time: now,
    user_created_time: now,
    user_updated_time: now,
    encryption_cipher_text: '',
    encryption_applied: '0',
    is_shared: '0',
  };
}

/**
 * Write operations against Joplin Server. Every write re-reads the item from the server first,
 * keeps its original properties, and updates the in-memory cache afterwards.
 */
export class NoteWriterService {
  /** Reads the current server version of an item (bypassing the cache) */
  private async fetchFresh(sessionId: string, id: string): Promise<RawJoplinItem> {
    const raw = await joplinApi.getItemContent(sessionId, `${id}.md`);
    const item = deserialize(raw, `${id}.md`);
    if (item.properties.encryption_applied === '1') {
      throw new WriteValidationError('This item is end-to-end encrypted and cannot be edited here', 422);
    }
    return item;
  }

  private async fetchFreshOfType(sessionId: string, id: string, type: JoplinItemType): Promise<RawJoplinItem> {
    const item = await this.fetchFresh(sessionId, id);
    if (item.type_ !== type) {
      const names: Partial<Record<JoplinItemType, string>> = {
        [JoplinItemType.Note]: 'note',
        [JoplinItemType.Folder]: 'notebook',
        [JoplinItemType.Tag]: 'tag',
      };
      throw new WriteValidationError(`Item ${id} is not a ${names[type] ?? 'supported item'}`, 404);
    }
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

  /** Ensures a notebook exists and is not in the trash */
  private async assertActiveNotebook(sessionId: string, notebookId: string): Promise<void> {
    assertValidId(notebookId, 'notebook id');
    const entry = await noteCache.getEntry(sessionId);
    const notebook = entry.notebooks.get(notebookId);
    if (!notebook || notebook.deletedTime > 0) {
      throw new WriteValidationError(`Notebook not found: ${notebookId}`, 404);
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
    const current = await this.fetchFreshOfType(sessionId, id, JoplinItemType.Note);
    if (current.deletedTime > 0) return;
    const props = { ...current.properties, deleted_time: String(Date.now()) };
    touch(props);
    await this.write(sessionId, { type_: JoplinItemType.Note, title: current.title, body: current.body, properties: props });
  }

  /** Restores a note from the trash, including any trashed parent notebooks */
  public async restoreNote(sessionId: string, id: string): Promise<NoteDetail> {
    assertValidId(id, 'note id');
    const current = await this.fetchFreshOfType(sessionId, id, JoplinItemType.Note);
    const entry = await noteCache.getEntry(sessionId);

    // Walk up the notebook chain and restore trashed ancestors first
    const visited = new Set<string>();
    let parentId = current.parentId;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const folder = entry.notebooks.get(parentId);
      if (!folder) break;
      if (folder.deletedTime > 0) {
        const fresh = await this.fetchFreshOfType(sessionId, folder.id, JoplinItemType.Folder);
        const folderProps = { ...fresh.properties, deleted_time: '0' };
        touch(folderProps);
        await this.write(sessionId, { type_: JoplinItemType.Folder, title: fresh.title, body: '', properties: folderProps });
      }
      parentId = folder.parentId;
    }

    if (current.deletedTime > 0) {
      const props = { ...current.properties, deleted_time: '0' };
      touch(props);
      await this.write(sessionId, { type_: JoplinItemType.Note, title: current.title, body: current.body, properties: props });
    }
    return this.noteDetail(sessionId, id);
  }

  /** Permanently deletes a note and its note-tag links from Joplin Server */
  public async purgeNote(sessionId: string, id: string): Promise<void> {
    assertValidId(id, 'note id');
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
   * Moves a notebook, its sub-notebooks and all their notes to the trash,
   * matching Joplin desktop's trash behaviour.
   */
  public async trashNotebook(sessionId: string, id: string): Promise<{ notebooks: number; notes: number }> {
    assertValidId(id, 'notebook id');
    await this.fetchFreshOfType(sessionId, id, JoplinItemType.Folder);
    const entry = await noteCache.getEntry(sessionId);

    // Collect the notebook subtree
    const folderIds: string[] = [id];
    for (let i = 0; i < folderIds.length; i++) {
      for (const nb of entry.notebooks.values()) {
        if (nb.parentId === folderIds[i] && !folderIds.includes(nb.id)) folderIds.push(nb.id);
      }
    }
    const folderSet = new Set(folderIds);
    const noteIds = Array.from(entry.notes.values())
      .filter((n) => folderSet.has(n.parentId) && !(n.deletedTime > 0))
      .map((n) => n.id);

    const deletedTime = String(Date.now());
    const trash = async (itemId: string, type: JoplinItemType) => {
      const fresh = await this.fetchFreshOfType(sessionId, itemId, type);
      if (fresh.deletedTime > 0) return;
      const props = { ...fresh.properties, deleted_time: deletedTime };
      touch(props);
      await this.write(sessionId, { type_: type, title: fresh.title, body: fresh.body, properties: props });
    };

    // Notes first, so an interrupted operation never leaves visible notes under a trashed notebook
    for (const noteId of noteIds) await trash(noteId, JoplinItemType.Note);
    for (const folderId of folderIds.reverse()) await trash(folderId, JoplinItemType.Folder);

    return { notebooks: folderIds.length, notes: noteIds.length };
  }

  /**
   * Permanently deletes a trashed notebook with its sub-notebooks and their notes.
   * Only notebooks that are already in the trash can be purged.
   */
  public async purgeNotebook(sessionId: string, id: string): Promise<{ notebooks: number; notes: number }> {
    assertValidId(id, 'notebook id');
    const root = await this.fetchFreshOfType(sessionId, id, JoplinItemType.Folder);
    if (!(root.deletedTime > 0)) {
      throw new WriteValidationError('Only notebooks in the trash can be deleted permanently', 409);
    }
    const entry = await noteCache.getEntry(sessionId);

    const folderIds: string[] = [id];
    for (let i = 0; i < folderIds.length; i++) {
      for (const nb of entry.notebooks.values()) {
        if (nb.parentId === folderIds[i] && !folderIds.includes(nb.id)) folderIds.push(nb.id);
      }
    }
    const folderSet = new Set(folderIds);
    const noteIds = Array.from(entry.notes.values())
      .filter((n) => folderSet.has(n.parentId))
      .map((n) => n.id);

    for (const noteId of noteIds) await this.purgeNote(sessionId, noteId);
    for (const folderId of folderIds.reverse()) {
      await joplinApi.deleteItem(sessionId, `${folderId}.md`);
      noteCache.removeItem(sessionId, folderId);
    }
    return { notebooks: folderIds.length, notes: noteIds.length };
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
    await this.fetchFreshOfType(sessionId, noteId, JoplinItemType.Note);

    const entry = await noteCache.getEntry(sessionId);
    let tag = Array.from(entry.tags.values()).find(
      (t) => t.title.trim().toLowerCase() === tagTitle.toLowerCase()
    );
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

