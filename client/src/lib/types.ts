/**
 * Notebook entity representing Joplin folders in a tree hierarchy.
 */
export interface Notebook {
  id: string;
  title: string;
  parentId: string;
  children: Notebook[];
  noteCount: number;
}

/**
 * A trashed notebook as listed in the trash (only the top of a trashed subtree).
 */
export interface TrashedNotebook {
  id: string;
  title: string;
  parentId: string;
  deletedTime: number;
  /** Notes trashed together with the notebook (restored with it), at any depth */
  noteCount: number;
  /** Sub-notebooks trashed together with the notebook, at any depth */
  notebookCount: number;
  /** Notes inside that were trashed on their own earlier: not restored, but deleted with it */
  earlierNoteCount: number;
}

/**
 * Note summary for lists and search results.
 */
export interface NoteListItem {
  id: string;
  title: string;
  updatedTime: number;
  createdTime: number;
  deletedTime?: number;
  preview: string;
  notebookId?: string;
  parentId?: string;
  isTodo?: boolean;
  todoCompleted?: boolean;
  /** A conflict copy Joplin kept after a sync conflict (listed only under Conflicts) */
  isConflict?: boolean;
}

/**
 * Full Joplin note model including Markdown body and metadata.
 */
export interface Note {
  id: string;
  title: string;
  body: string;
  /** Plain-text preview of the body, as in note lists (built by the server) */
  preview?: string;
  updatedTime: number;
  createdTime: number;
  deletedTime?: number;
  parentId: string;
  notebookId: string;
  notebookTitle: string;
  tags: Tag[];
  isTodo: boolean;
  todoCompleted: boolean;
  /** A conflict copy Joplin kept after a sync conflict (`is_conflict: 1`) */
  isConflict?: boolean;
  /** Id of the note the conflict copy was made from, empty when unknown */
  conflictOriginalId?: string;
}

/**
 * Tag model associated with notes.
 */
export interface Tag {
  id: string;
  title: string;
  noteCount: number;
}

/**
 * Search result with matched highlighted snippet fields.
 */
export interface SearchResult extends NoteListItem {
  matches?: { inTitle: boolean; inBody: boolean; snippet?: string };
}

/**
 * Login response payload from API. The session itself is set as an httpOnly cookie.
 */
export interface LoginResponse {
  userId: string;
}
