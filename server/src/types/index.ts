/**
 * Joplin item types according to Joplin core specification
 */
export enum JoplinItemType {
  Note = 1,
  Folder = 2,
  Setting = 3,
  Resource = 4,
  Tag = 5,
  NoteTag = 6,
  Search = 7,
  Alarm = 8,
  MasterKey = 9,
  ItemChange = 10,
  NoteResource = 11,
  ResourceLocalState = 12,
  Revision = 13,
  Migration = 14,
  SmartFilter = 15,
  Command = 16,
}

/**
 * Representation of a deserialized raw Joplin item
 */
export interface RawJoplinItem {
  id: string;
  type_: number;
  title: string;
  body: string;
  parentId: string;
  createdTime: number;
  updatedTime: number;
  userCreatedTime: number;
  userUpdatedTime: number;
  deletedTime: number;
  isTodo: boolean;
  todoDue: number;
  todoCompleted: number;
  properties: Record<string, string>;
}

/**
 * Notebook tree item representation
 */
export interface Notebook {
  id: string;
  title: string;
  parentId: string;
  children: Notebook[];
  noteCount: number;
  /** Stored end-to-end encrypted (`encryption_applied: 1`): title and content are unreadable here */
  encrypted: boolean;
  createdTime?: number;
  updatedTime?: number;
  deletedTime?: number;
}

/**
 * A notebook at the top of a trashed subtree, as listed in the trash
 */
export interface TrashedNotebook {
  id: string;
  title: string;
  parentId: string;
  deletedTime: number;
  /** Notes trashed together with the notebook (they come back on restore), at any depth */
  noteCount: number;
  /** Sub-notebooks trashed together with the notebook, at any depth */
  notebookCount: number;
  /** Notes inside that were trashed on their own before; they stay trashed on restore but are deleted with the notebook */
  earlierNoteCount: number;
  /** Stored end-to-end encrypted (`encryption_applied: 1`): title and content are unreadable here */
  encrypted: boolean;
}

/**
 * Lightweight note item for lists and queries
 */
export interface NoteListItem {
  id: string;
  title: string;
  parentId: string;
  createdTime: number;
  updatedTime: number;
  deletedTime: number;
  preview: string;
  isTodo: boolean;
  todoCompleted: boolean;
  todoDue: number;
  /** A conflict copy (`is_conflict: 1`) Joplin kept after a sync conflict */
  isConflict: boolean;
  /** Stored end-to-end encrypted (`encryption_applied: 1`): title and content are unreadable here */
  encrypted: boolean;
}

/**
 * Full detail of a note including parent notebook and linked tags
 */
export interface NoteDetail {
  id: string;
  title: string;
  body: string;
  /** Plain-text preview of the body, as in note lists (lets clients update a list entry after a save) */
  preview: string;
  parentId: string;
  notebook: { id: string; title: string } | null;
  notebookId: string;
  notebookTitle: string;
  tags: Array<{ id: string; title: string }>;
  createdTime: number;
  updatedTime: number;
  deletedTime: number;
  isTodo: boolean;
  todoCompleted: boolean;
  todoDue: number;
  /** A conflict copy (`is_conflict: 1`) Joplin kept after a sync conflict */
  isConflict: boolean;
  /** Id of the note the conflict copy was made from (`conflict_original_id`), '' if unknown */
  conflictOriginalId: string;
  /** Joplin's `markup_language`: 1 = Markdown, 2 = HTML (e.g. pages saved with the Web Clipper) */
  markupLanguage: number;
  /** Stored end-to-end encrypted (`encryption_applied: 1`): title and content are unreadable here */
  encrypted: boolean;
  properties: Record<string, string>;
}

/**
 * Tag with note count
 */
export interface TagItem {
  id: string;
  title: string;
  noteCount: number;
  /** Stored end-to-end encrypted (`encryption_applied: 1`): title and content are unreadable here */
  encrypted: boolean;
}

/**
 * Whether Joplin Web may write to the account (see `NoteWriterService.getWriteState`)
 */
export interface WriteState {
  writable: boolean;
  /** Why the account is read-only, as the writer's 422 refusal words it; absent when writable */
  reason?: string;
}

/**
 * Note-Tag association
 */
export interface NoteTagLink {
  id: string;
  noteId: string;
  tagId: string;
}

/**
 * Resource item metadata
 */
export interface ResourceMetadata {
  id: string;
  title: string;
  mime: string;
  filename: string;
  fileExtension: string;
  size: number;
  updatedTime: number;
}

/**
 * Item entry in Joplin Server /api/items/root:/:/children
 */
export interface JoplinChildItem {
  id: string;
  name: string;
  updated_time: number;
}

/**
 * Joplin Server children list response
 */
export interface JoplinChildrenResponse {
  items: JoplinChildItem[];
  has_more: boolean;
  cursor: string | null;
}

/**
 * Search result item
 */
export interface SearchResult extends NoteListItem {
  matches: {
    inTitle: boolean;
    inBody: boolean;
    snippet?: string;
  };
}

/**
 * Session verification response
 */
export interface SessionInfo {
  sessionId: string;
  userId: string;
}

/**
 * Express Request extension to include sessionId
 */
declare global {
  namespace Express {
    interface Request {
      sessionId?: string;
    }
  }
}
