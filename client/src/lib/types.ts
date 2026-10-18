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
}

/**
 * Full Joplin note model including Markdown body and metadata.
 */
export interface Note {
  id: string;
  title: string;
  body: string;
  updatedTime: number;
  createdTime: number;
  deletedTime?: number;
  parentId: string;
  notebookId: string;
  notebookTitle: string;
  tags: Tag[];
  isTodo: boolean;
  todoCompleted: boolean;
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
