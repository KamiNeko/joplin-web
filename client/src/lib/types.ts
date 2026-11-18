/**
 * Notebook entity representing Joplin folders in a tree hierarchy.
 */
export interface Notebook {
  id: string;
  title: string;
  parentId: string;
  children: Notebook[];
  noteCount: number;
  /** Stored end-to-end encrypted: title and content can't be read (or changed) here */
  encrypted?: boolean;
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
  /** Stored end-to-end encrypted: title and content can't be read (or changed) here */
  encrypted?: boolean;
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
  /** Stored end-to-end encrypted: title and content can't be read (or changed) here */
  encrypted?: boolean;
  /** To-do due date in Unix ms; 0 or missing when none is set */
  todoDue?: number;
  /** First image or PDF attachment the body links to, shown as the card's thumbnail */
  thumbnail?: { resourceId: string; kind: "image" | "pdf" };
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
  /** Joplin's `markup_language`: 1 = Markdown, 2 = HTML (see `MARKUP_HTML`) */
  markupLanguage?: number;
  /** Stored end-to-end encrypted: title and content can't be read (or changed) here */
  encrypted?: boolean;
  /** To-do due date in Unix ms; 0 or missing when none is set */
  todoDue?: number;
}

/** `markupLanguage` of HTML notes, e.g. pages saved with the Joplin Web Clipper */
export const MARKUP_HTML = 2;

/**
 * Tag model associated with notes.
 */
export interface Tag {
  id: string;
  title: string;
  noteCount: number;
  /** Stored end-to-end encrypted: title and content can't be read (or changed) here */
  encrypted?: boolean;
}

/**
 * Whether Joplin Web may write to the account. Accounts with end-to-end encryption are read-only:
 * Joplin Web can't encrypt, so the server refuses every write to them.
 */
export interface WriteState {
  writable: boolean;
  /** The server's explanation when not writable */
  reason: string | null;
}

/**
 * Search result with matched highlighted snippet fields.
 */
export interface SearchResult extends NoteListItem {
  matches?: {
    inTitle: boolean;
    inBody: boolean;
    /** Set to "attachment" when the terms matched only in linked attachments' OCR text */
    matchedIn?: "attachment";
    snippet?: string;
    /** Lower-cased words and phrases the note matched (empty for filter-only queries) */
    terms?: string[];
  };
}

/**
 * Item payload inside POST /api/notes/batch.
 */
export interface BatchNoteItem {
  id: string;
  baseUpdatedTime?: number;
  parentId?: string;
  title?: string;
  addTags?: string[];
  removeTags?: string[];
}

/**
 * Request body for POST /api/notes/batch.
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
 * Per-note result returned by POST /api/notes/batch.
 */
export interface BatchNoteResult {
  id: string;
  status: "ok" | "conflict" | "error";
  updatedTime?: number;
  error?: string;
  addedTags?: string[];
}

/**
 * Available two-factor authentication methods.
 */
export type TwoFactorMethod = "passkey" | "totp" | "recovery";

export interface TwoFactorChallenge {
  required: true;
  methods: TwoFactorMethod[];
  mustEnroll: boolean;
  passkeysAvailable?: boolean;
}

/**
 * Login response payload from API. The session itself is set as an httpOnly cookie when complete,
 * or enters a server-side pending state when two-factor verification or enrollment is needed.
 */
export type LoginResponse =
  | {
      userId: string;
      twoFactor?: undefined;
    }
  | {
      twoFactor: TwoFactorChallenge;
    };

export interface TwoFactorStatus {
  persistenceEnabled: boolean;
  require2fa: boolean;
  passkeysAvailable: boolean;
  enrolled: {
    totp: boolean;
    passkeysCount: number;
    recoveryCodesRemaining: number;
  };
  methods: TwoFactorMethod[];
  stepUpValid: boolean;
  stepUpExpiresAt: number | null;
}

export interface PasskeyItem {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface TrustedDeviceItem {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  current: boolean;
}

export interface TotpSetupResponse {
  secret: string;
  otpauthUri: string;
  qrDataUrl: string;
}

export interface TwoFactorCompleteResponse {
  verified?: boolean;
  enrolled?: boolean;
  userId?: string;
  stepUpExpiresAt?: number;
  recoveryCodes?: string[];
  recoveryCodesRemaining?: number;
  passkey?: PasskeyItem;
}

export interface OrganizeStatus {
  enabled: boolean;
  model?: string;
}

export type OrganizeJobStatus = "running" | "done" | "cancelled" | "failed";
export type OrganizeItemStatus = "pending" | "running" | "done" | "failed";

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
  applyStatus?: "ok" | "conflict" | "error";
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

export interface OrganizeJobResponse {
  id: string;
  status: OrganizeJobStatus;
  error?: string;
  excludeNotebookIds: string[];
  progress: OrganizeJobProgress;
  appliedCount?: number;
  retryableFailedCount?: number;
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
