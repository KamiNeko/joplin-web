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
  /** First image or PDF attachment the body links to, shown as the note's thumbnail in lists */
  thumbnail?: { resourceId: string; kind: 'image' | 'pdf' };
}

export interface NotebookBreadcrumb {
  id: string;
  title: string;
}

export interface NoteBacklink {
  id: string;
  title: string;
  parentId: string;
  updatedTime: number;
  snippet: string;
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
  /** Clickable ancestor chain from root notebook down to parent notebook */
  notebookPath?: NotebookBreadcrumb[];
  /** Active notes containing a `:/<id>` link pointing to this note */
  backlinks?: NoteBacklink[];
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
  /** Extracted OCR text (`ocr_text`), kept only when `ocr_status` is 2 (done) */
  ocrText: string;
}

/**
 * Item entry in Joplin Server /api/items/root:/:/children
 */
export interface JoplinChildItem {
  id: string;
  name: string;
  updated_time: number;
}

/** One entry of Joplin Server's delta feed (GET /api/items/root/delta) */
export interface JoplinDeltaChange {
  item_name: string;
  /** 1 created, 2 updated, 3 deleted */
  type: number;
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
    /** Set to `'attachment'` when terms matched only inside linked attachments' OCR text */
    matchedIn?: 'attachment';
    snippet?: string;
    /** Lower-cased words and phrases the note matched, for highlighting (empty for filter-only queries) */
    terms: string[];
  };
}

/**
 * Item payload inside POST /api/notes/batch
 */
export interface BatchNoteItem {
  id: string;
  /** updatedTime the client based its change on; mismatched timestamps report status "conflict" */
  baseUpdatedTime?: number;
  /** Optional per-item destination notebook id (overrides top-level parentId; used by undo & auto-organize) */
  parentId?: string;
  /** Optional per-item title update (used by undo & auto-organize) */
  title?: string;
  /** Optional per-item tag titles to add (combined with top-level addTags; used by auto-organize) */
  addTags?: string[];
  /** Optional per-item tag titles to remove (combined with top-level removeTags; used by undo) */
  removeTags?: string[];
}

/**
 * Request body for POST /api/notes/batch
 */
export interface BatchNoteRequest {
  items: BatchNoteItem[];
  parentId?: string;
  addTags?: string[];
  removeTags?: string[];
  trash?: boolean;
  restore?: boolean;
}

/**
 * Per-note outcome returned by POST /api/notes/batch
 */
export interface BatchNoteResult {
  id: string;
  status: 'ok' | 'conflict' | 'error';
  updatedTime?: number;
  error?: string;
  /** Tag titles newly linked to this note during addTags (omits tags the note already had) */
  addedTags?: string[];
}

/**
 * Session verification response
 */
export interface SessionInfo {
  sessionId: string;
  userId: string;
}

export interface OrganizeStatus {
  enabled: boolean;
  model?: string;
}

export type OrganizeJobStatus = 'running' | 'done' | 'cancelled' | 'failed';
export type OrganizeItemStatus = 'pending' | 'running' | 'done' | 'failed';

export interface OrganizeSuggestion {
  title: string;
  notebookId: string;
  tags: string[];
  confidence: number;
  documentDate: string | null;
  reason: string;
}

export interface OrganizeJobItem {
  noteId: string;
  currentTitle: string;
  currentNotebookId: string;
  currentNotebookPath: string;
  updatedTime: number;
  status: OrganizeItemStatus;
  error?: string;
  skipped?: boolean;
  suggestion?: OrganizeSuggestion;
  applied?: boolean;
  applyStatus?: 'ok' | 'conflict' | 'error';
  applyError?: string;
}

export interface OrganizeUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface OrganizeJobProgress {
  total: number;
  done: number;
  failed: number;
}

export interface OrganizeJobSummary {
  id: string;
  status: OrganizeJobStatus;
  error?: string;
  progress: OrganizeJobProgress;
  appliedCount: number;
  usage: OrganizeUsage;
  canUndo: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface OrganizeUndoItem {
  noteId: string;
  baseUpdatedTime: number;
  previousTitle: string;
  previousNotebookId: string;
  addedTags: string[];
}

export interface OrganizeUndoRecord {
  appliedAt: number;
  items: OrganizeUndoItem[];
}

export interface OrganizeJobResponse {
  id: string;
  status: OrganizeJobStatus;
  error?: string;
  excludeNotebookIds: string[];
  progress: OrganizeJobProgress;
  appliedCount: number;
  retryableFailedCount: number;
  usage: OrganizeUsage;
  offset: number;
  limit: number;
  totalItems: number;
  canUndo: boolean;
  createdAt: number;
  updatedAt: number;
  items: OrganizeJobItem[];
}

export interface OrganizeRetryResponse {
  id: string;
  status: OrganizeJobStatus;
  requeuedCount: number;
}

export interface OrganizeDeleteResponse {
  id: string;
  deleted: boolean;
}

export interface OrganizeApplyItemInput {
  noteId: string;
  title?: string;
  notebookId?: string;
  addTags?: string[];
  baseUpdatedTime?: number;
}

export interface OrganizeApplyResponse {
  results: BatchNoteResult[];
  appliedCount: number;
  conflictCount: number;
  errorCount: number;
  canUndo: boolean;
}

export interface OrganizeUndoResponse {
  results: BatchNoteResult[];
  revertedCount: number;
  conflictCount: number;
  errorCount: number;
  canUndo: boolean;
}

export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  createdAt: number;
}

export interface RecentReadEntry {
  noteId: string;
  readAt: number;
}

export interface UserPreferences {
  version: 1;
  favoriteNoteIds: string[];
  favoriteNotebookIds: string[];
  savedSearches: SavedSearch[];
  recentReads: RecentReadEntry[];
  scratchpad: string;
}

export interface FavoriteNotebookSummary {
  id: string;
  title: string;
  parentId: string;
  noteCount: number;
  encrypted: boolean;
}

export interface HydratedPreferences {
  favoriteNoteIds: string[];
  favoriteNotebookIds: string[];
  savedSearches: SavedSearch[];
  recentReads: RecentReadEntry[];
  scratchpad: string;
  favoriteNotes: NoteListItem[];
  favoriteNotebooks: FavoriteNotebookSummary[];
}

export interface RecentReadNote extends NoteListItem {
  readAt: number;
}

export interface RecentNotesResponse {
  recentRead: RecentReadNote[];
  recentCreated: NoteListItem[];
}

export type NoteAttachmentKind = 'image' | 'pdf' | 'audio' | 'video' | 'file';

export interface NoteAttachment {
  id: string;
  title: string;
  mime: string;
  filename: string;
  fileExtension: string;
  size: number;
  updatedTime: number;
  ocrText: string;
  kind: NoteAttachmentKind;
}

export interface NoteRevisionMeta {
  id: string;
  itemId: string;
  titleUpdatedTime: number;
  updatedTime: number;
  createdTime: number;
}

export interface NoteRevisionDetail {
  id: string;
  itemId: string;
  title: string;
  body: string;
  updatedTime: number;
  createdTime: number;
}

export interface TodoTaskItem extends NoteListItem {
  notebookTitle: string;
}

export interface InlineTaskItem {
  noteId: string;
  noteTitle: string;
  parentId: string;
  notebookTitle: string;
  line: number;
  column: number;
  text: string;
  checked: boolean;
  updatedTime: number;
}

export interface TasksResponse {
  todoNotes: TodoTaskItem[];
  inlineTasks: InlineTaskItem[];
}

export interface HygieneNoteItem extends NoteListItem {
  notebookTitle: string;
  previewLength?: number;
}

export interface DuplicateCluster {
  id: string;
  reason: 'exact-title' | 'similar-content';
  score: number;
  notes: HygieneNoteItem[];
}

export interface HygieneReport {
  duplicateClusters: DuplicateCluster[];
  emptyNotes: HygieneNoteItem[];
  untaggedNotes: HygieneNoteItem[];
}

export interface AiFeatureStatus {
  enabled: boolean;
  model?: string;
}

export interface AskNotesCitation {
  id: string;
  title: string;
  notebookTitle: string;
  updatedTime: number;
  excerpt: string;
}

export interface AskNotesResponse {
  answer: string;
  citations: AskNotesCitation[];
  usage?: OrganizeUsage;
}

export type NoteAssistAction = 'summarize' | 'action-items' | 'suggest-tags' | 'cleanup';

export interface NoteAssistResponse {
  result: string;
  tags?: string[];
  usage?: OrganizeUsage;
}

export interface ClipResponse {
  note: NoteDetail;
  extractedTitle: string;
  siteName?: string;
}

export interface EmailIngestResponse {
  note: NoteDetail;
}

import type { AppConfig } from '../config.js';
import type { PreferencesStore } from '../services/preferences-store.js';
import type { TwoFactorStore } from '../services/two-factor-store.js';

export interface AppAuthState {
  validationCache: Map<string, { isValid: boolean; validatedAt: number }>;
}

/**
 * Express Request extension to include session and 2FA context
 */
declare global {
  namespace Express {
    interface Request {
      sessionId?: string;
      userId?: string;
      userEmail?: string;
      appConfig?: AppConfig;
      twoFactorStore?: TwoFactorStore;
      preferencesStore?: PreferencesStore;
      authState?: AppAuthState;
    }
  }
}
