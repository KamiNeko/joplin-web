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
  createdTime?: number;
  updatedTime?: number;
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
  preview: string;
  isTodo: boolean;
  todoCompleted: boolean;
  todoDue: number;
}

/**
 * Full detail of a note including parent notebook and linked tags
 */
export interface NoteDetail {
  id: string;
  title: string;
  body: string;
  parentId: string;
  notebook: { id: string; title: string } | null;
  tags: Array<{ id: string; title: string }>;
  createdTime: number;
  updatedTime: number;
  isTodo: boolean;
  todoCompleted: boolean;
  todoDue: number;
  properties: Record<string, string>;
}

/**
 * Tag with note count
 */
export interface TagItem {
  id: string;
  title: string;
  noteCount: number;
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
