/**
 * Connection state shared by the API client and the UI: request outcomes, pending writes, session
 * expiry and notes with unsaved edits. A tiny external store, read with useSyncExternalStore.
 */

export interface ConnectionError {
  message: string;
  /** HTTP status, or 0 when the server couldn't be reached at all */
  status: number;
  at: number;
}

export interface ConnectionSnapshot {
  /** Writes (POST/PUT/DELETE) still talking to the server */
  pendingWrites: number;
  /** Time of the last successful read */
  lastUpdatedAt: number | null;
  /** Last failure that points at the connection or the server (network error or 5xx) */
  lastError: ConnectionError | null;
  /** A request was rejected with 401: the session is gone */
  sessionExpired: boolean;
}

const initialSnapshot: ConnectionSnapshot = {
  pendingWrites: 0,
  lastUpdatedAt: null,
  lastError: null,
  sessionExpired: false,
};

let snapshot: ConnectionSnapshot = initialSnapshot;
const listeners = new Set<() => void>();

function update(changes: Partial<ConnectionSnapshot>): void {
  snapshot = { ...snapshot, ...changes };
  listeners.forEach((listener) => listener());
}

/** Subscribes to connection state changes; returns the unsubscribe function. */
export function subscribeConnection(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Current connection state (a new object after every change). */
export function getConnectionSnapshot(): ConnectionSnapshot {
  return snapshot;
}

/** Resets everything, e.g. after signing in again. */
export function resetConnection(): void {
  update({ ...initialSnapshot, pendingWrites: snapshot.pendingWrites });
}

/**
 * True for failures that mean the server is unreachable or broken (network error, 5xx), as opposed
 * to a rejected request (4xx). Only these are retried and reported as connection problems.
 */
export function isConnectionFailure(status: number): boolean {
  return status === 0 || status >= 500;
}

/**
 * True for failures worth retrying later: connection failures, and 429 (rate limited), which is
 * temporary but not a connection problem.
 */
export function isTemporaryFailure(status: number): boolean {
  return status === 429 || isConnectionFailure(status);
}

/** Records the outcome of a request that got an HTTP response. */
export function recordResponse(status: number, isRead: boolean, message: string): void {
  if (status === 401) {
    if (!snapshot.sessionExpired) update({ sessionExpired: true });
  } else if (isConnectionFailure(status)) {
    update({ lastError: { message, status, at: Date.now() } });
  } else if (isRead || snapshot.lastError) {
    // Any answer below 500 proves the server is reachable again
    update({ lastError: null, ...(isRead && status < 400 ? { lastUpdatedAt: Date.now() } : {}) });
  }
}

/** Records a request that never reached the server. */
export function recordNetworkError(message: string): void {
  update({ lastError: { message, status: 0, at: Date.now() } });
}

/** Adjusts the number of writes in flight. */
export function changePendingWrites(delta: 1 | -1): void {
  update({ pendingWrites: Math.max(0, snapshot.pendingWrites + delta) });
}

// Notes open in an editor with changes that aren't on the server yet. Refreshes skip them, so a
// background refetch never competes with the user's typing.
const unsavedNotes = new Set<string>();

/** Marks whether a note has unsaved edits in an open editor. */
export function setNoteUnsaved(noteId: string, unsaved: boolean): void {
  if (unsaved) unsavedNotes.add(noteId);
  else unsavedNotes.delete(noteId);
}

/** True while an open editor holds unsaved edits for the note. */
export function hasUnsavedChanges(noteId: unknown): boolean {
  return typeof noteId === "string" && unsavedNotes.has(noteId);
}

export type ConnectionState = "offline" | "expired" | "saving" | "refreshing" | "error" | "updated" | "connected";

export interface StatusInput {
  online: boolean;
  sessionExpired: boolean;
  isFetching: boolean;
  isSaving: boolean;
  lastError: ConnectionError | null;
  lastUpdatedAt: number | null;
  now: number;
}

export interface ConnectionStatus {
  state: ConnectionState;
  /** Short text for the sidebar footer */
  label: string;
}

/**
 * Formats how long ago a timestamp was: "just now", "5 min ago", or the time of day after an hour.
 */
export function formatAgo(timestamp: number, now: number): string {
  const minutes = Math.floor((now - timestamp) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `at ${new Date(timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * Derives the one status shown in the sidebar from the raw connection state. Problems the user has
 * to act on come first, then activity, then the time of the last successful refresh.
 */
export function deriveConnectionStatus(input: StatusInput): ConnectionStatus {
  if (!input.online) return { state: "offline", label: "Offline" };
  if (input.sessionExpired) return { state: "expired", label: "Session expired" };
  if (input.isSaving) return { state: "saving", label: "Saving…" };
  if (input.isFetching) return { state: "refreshing", label: "Refreshing…" };
  if (input.lastError) {
    return {
      state: "error",
      label: input.lastError.status === 0 || input.lastError.status >= 502 ? "Can't reach server" : "Server error",
    };
  }
  if (input.lastUpdatedAt !== null) {
    return { state: "updated", label: `Updated ${formatAgo(input.lastUpdatedAt, input.now)}` };
  }
  return { state: "connected", label: "Connected" };
}
