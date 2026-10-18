import {
  Notebook,
  NoteListItem,
  Note,
  Tag,
  SearchResult,
  LoginResponse,
  TrashedNotebook,
  WriteState,
} from "./types";
import { changePendingWrites, recordNetworkError, recordResponse } from "./connection";

/**
 * The session token lives in an httpOnly cookie set by the backend: scripts can't read it. Only the
 * email address is kept in localStorage, for display.
 */
const EMAIL_KEY = "joplin_user_email";
/** Keys used by older versions, which stored the token itself */
const LEGACY_KEYS = ["joplin_session_id", "joplin_user_id"];

// Base URL defaults to empty string in browser so Vite proxy handles /api,
// or uses VITE_API_BASE_URL if configured.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";

/**
 * Options for every API request: send the session cookie, and send the Origin header the backend's
 * CSRF check needs (the page's Referrer-Policy is no-referrer, which would turn it into "null").
 */
const SESSION_FETCH_OPTIONS: RequestInit = {
  credentials: "include",
  referrerPolicy: "same-origin",
};

function removeStorageKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // storage unavailable
  }
}

/**
 * Remembers the email address the current session was opened with (display only).
 */
export function setStoredEmail(email: string): void {
  try {
    localStorage.setItem(EMAIL_KEY, email);
  } catch {
    // storage unavailable
  }
}

/**
 * Retrieves the email address the current session was opened with.
 */
export function getStoredEmail(): string | null {
  try {
    return localStorage.getItem(EMAIL_KEY);
  } catch {
    return null;
  }
}

/**
 * Clears stored client-side session data, including tokens stored by older versions.
 */
export function clearStoredSession(): void {
  removeStorageKey(EMAIL_KEY);
  LEGACY_KEYS.forEach(removeStorageKey);
}

/**
 * Custom API Error containing status code and response payload.
 */
export class ApiError extends Error {
  status: number;
  data?: unknown;
  /** How long the server asked to wait before trying again (Retry-After), in ms */
  retryAfterMs?: number;

  constructor(status: number, message: string, data?: unknown, retryAfterMs?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Parses a Retry-After header (seconds or an HTTP date) into milliseconds from `now`. Returns
 * undefined when the header is missing or unreadable.
 */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Writes (POST/PUT/DELETE) that haven't finished yet; logout waits for them */
const pendingWrites = new Set<Promise<unknown>>();

/**
 * Resolves once all writes started so far have finished (successfully or not), or after the timeout.
 */
export async function waitForPendingWrites(timeoutMs = 10000): Promise<void> {
  if (pendingWrites.size === 0) return;
  await Promise.race([
    Promise.allSettled([...pendingWrites]),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

interface RequestOptions extends RequestInit {
  /** Don't treat a 401 as an expired session (login and the startup session check) */
  skipAuthRedirect?: boolean;
  /** A POST that only reads (cache refresh): not a pending write, counts as a refresh */
  isRead?: boolean;
}

async function readErrorMessage(response: Response): Promise<{ message: string; data: unknown }> {
  let message = `Request failed with status ${response.status}`;
  let data: unknown;
  try {
    data = await response.json();
    if (typeof data === "object" && data !== null) {
      if ("error" in data && typeof (data as { error: unknown }).error === "string") {
        message = (data as { error: string }).error;
      } else if ("message" in data && typeof (data as { message: unknown }).message === "string") {
        message = (data as { message: string }).message;
      }
    }
  } catch {
    // response wasn't JSON
  }
  return { message, data };
}

/**
 * Internal request wrapper handling headers, auth, and error conditions.
 */
async function request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  const { skipAuthRedirect, isRead: readOnly, ...init } = options;
  const method = (init.method ?? "GET").toUpperCase();
  const isRead = Boolean(readOnly) || method === "GET" || method === "HEAD";
  const pending = send<T>(endpoint, init, Boolean(skipAuthRedirect), isRead);
  if (!isRead) {
    pendingWrites.add(pending);
    changePendingWrites(1);
    void pending
      .catch(() => undefined)
      .finally(() => {
        pendingWrites.delete(pending);
        changePendingWrites(-1);
      });
  }
  return pending;
}

async function send<T>(endpoint: string, init: RequestInit, skipAuthRedirect: boolean, isRead: boolean): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(init.headers as Record<string, string>),
  };

  if (!(init.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...SESSION_FETCH_OPTIONS,
      ...init,
      headers,
    });
  } catch {
    // fetch only rejects when no response arrived (offline, DNS, connection refused)
    const message = "Can't reach the server";
    recordNetworkError(message);
    throw new ApiError(0, message);
  }

  if (!response.ok) {
    const { message, data } = await readErrorMessage(response);
    // Login and the startup check handle their own errors and don't feed the connection status
    if (!skipAuthRedirect) recordResponse(response.status, isRead, message);
    if (response.status === 401 && !skipAuthRedirect) {
      // The session-expired dialog asks the user to sign in again; unsaved drafts stay on this device
      throw new ApiError(401, "Your session has expired. Please sign in again.", data);
    }
    throw new ApiError(response.status, message, data, parseRetryAfter(response.headers.get("Retry-After")));
  }
  if (!skipAuthRedirect) recordResponse(response.status, isRead, "");

  if (response.status === 204) {
    return {} as T;
  }

  return response.json();
}

/**
 * Authenticates user with email and password. The backend sets the session cookie.
 */
export async function login(email: string, password: string): Promise<LoginResponse> {
  return request<LoginResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
    skipAuthRedirect: true,
  });
}

/**
 * Ends the session on the server (and on Joplin Server) and clears client-side session data.
 */
export async function logout(): Promise<void> {
  try {
    await request("/api/auth/logout", { method: "POST", skipAuthRedirect: true });
  } catch {
    // The session cookie is cleared by the response; a failed request still logs out locally
  } finally {
    clearStoredSession();
    clearResourceCache();
  }
}

export interface SessionInfo {
  /** Host of the Joplin Server the backend talks to, for display */
  serverHost: string | null;
}

/**
 * Asks the server whether the session cookie is valid. Resolves null for an expired or missing
 * session; other failures (server unreachable) are thrown.
 */
export async function checkSession(): Promise<SessionInfo | null> {
  try {
    const data = await request<{ serverHost?: unknown }>("/api/auth/check", { skipAuthRedirect: true });
    return { serverHost: typeof data.serverHost === "string" ? data.serverHost : null };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

/**
 * Asks whether the account accepts writes. Anything but an explicit `writable: false` counts as
 * writable: the server still refuses each write it can't take, so a missing answer only means the
 * UI doesn't hide editing up front.
 */
export async function getWriteState(): Promise<WriteState> {
  const data = await request<{ writable?: unknown; reason?: unknown } | null>("/api/account/write-state");
  const writable = data?.writable !== false;
  return { writable, reason: !writable && typeof data?.reason === "string" ? data.reason : null };
}

/**
 * True when the server refused a write because the account or item can't be changed from Joplin
 * Web (HTTP 422, e.g. end-to-end encryption). Retrying won't help; the error message says why.
 */
export function isReadOnlyError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 422;
}

/**
 * Makes the backend reload everything from Joplin Server, picking up changes from other devices.
 */
export async function refreshServerCache(): Promise<void> {
  await request("/api/notebooks/refresh", { method: "POST", isRead: true });
}

/**
 * Fetches the hierarchical notebook list.
 */
export async function getNotebooks(): Promise<Notebook[]> {
  return request<Notebook[]>("/api/notebooks");
}

/**
 * Fetches list of notes, optionally filtered by notebookId, tagId, or trash status.
 */
export async function getNotes(params?: {
  notebookId?: string;
  tagId?: string;
  isTrash?: boolean;
  /** Only conflict copies (Joplin's "Conflicts" folder); the other filters are ignored then */
  isConflict?: boolean;
}): Promise<NoteListItem[]> {
  const query = new URLSearchParams();
  if (params?.notebookId) {
    query.set("notebookId", params.notebookId);
  }
  if (params?.tagId) {
    query.set("tagId", params.tagId);
  }
  if (params?.isTrash) {
    query.set("is_trash", "true");
  }
  if (params?.isConflict) {
    query.set("is_conflict", "true");
  }

  const endpoint = `/api/notes${query.toString() ? `?${query.toString()}` : ""}`;
  return request<NoteListItem[]>(endpoint);
}

/**
 * Fetches a single note with full body content and metadata.
 */
export async function getNote(id: string): Promise<Note> {
  return request<Note>(`/api/notes/${id}`);
}

/**
 * Fetches all tags with note count.
 */
export async function getTags(): Promise<Tag[]> {
  return request<Tag[]>("/api/tags");
}

/**
 * Searches notes by query string.
 */
export async function searchNotes(query: string): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }
  const urlQuery = new URLSearchParams({ q: trimmed });
  return request<SearchResult[]>(`/api/search?${urlQuery.toString()}`);
}

/**
 * Generates the URL for accessing a Joplin resource (images, attachments).
 */
export function getResourceUrl(resourceId: string): string {
  if (!resourceId) return "";
  const cleaned = resourceId.replace(/^:\/?/, "");
  return `${API_BASE_URL}/api/resources/${cleaned}`;
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Returns the server's current version of a note when a save hit a conflict (HTTP 409).
 */
export function getConflictNote(error: unknown): Note | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const details = (error.data as { details?: { current?: Note | null } } | undefined)?.details;
  return details?.current ?? null;
}

/**
 * Creates a note or to-do in the given notebook.
 */
export async function createNote(input: {
  parentId: string;
  title?: string;
  body?: string;
  isTodo?: boolean;
}): Promise<Note> {
  return request<Note>("/api/notes", { method: "POST", body: JSON.stringify(input) });
}

export interface NoteUpdate {
  title?: string;
  body?: string;
  parentId?: string;
  todoCompleted?: boolean;
  /** updatedTime of the version the change is based on; enables conflict detection */
  baseUpdatedTime?: number;
  /** Overwrite even if the note changed on the server */
  force?: boolean;
}

/**
 * Updates a note. Throws ApiError 409 (see getConflictNote) when the note changed elsewhere.
 */
export async function updateNote(id: string, changes: NoteUpdate): Promise<Note> {
  return request<Note>(`/api/notes/${id}`, { method: "PUT", body: JSON.stringify(changes) });
}

/**
 * Moves a note to the trash, or deletes it from the server when permanent is true.
 */
export async function deleteNote(id: string, permanent = false): Promise<void> {
  await request(`/api/notes/${id}${permanent ? "?permanent=true" : ""}`, { method: "DELETE" });
}

/**
 * Restores a note (and its trashed parent notebooks) from the trash.
 */
export async function restoreNote(id: string): Promise<Note> {
  return request<Note>(`/api/notes/${id}/restore`, { method: "POST" });
}

/**
 * Creates a notebook, optionally as a sub-notebook.
 */
export async function createNotebook(input: { title: string; parentId?: string }): Promise<Notebook> {
  return request<Notebook>("/api/notebooks", { method: "POST", body: JSON.stringify(input) });
}

/**
 * Renames or re-parents a notebook.
 */
export async function updateNotebook(id: string, changes: { title?: string; parentId?: string }): Promise<Notebook> {
  return request<Notebook>(`/api/notebooks/${id}`, { method: "PUT", body: JSON.stringify(changes) });
}

/**
 * Moves a notebook with its sub-notebooks and notes to the trash.
 */
export async function deleteNotebook(id: string): Promise<void> {
  await request(`/api/notebooks/${id}`, { method: "DELETE" });
}

/**
 * Lists trashed notebooks (the top of each trashed subtree) for the trash view.
 */
export async function getTrashedNotebooks(): Promise<TrashedNotebook[]> {
  return request<TrashedNotebook[]>("/api/notebooks/trash");
}

/**
 * Restores a trashed notebook with its sub-notebooks and notes.
 */
export async function restoreNotebook(id: string): Promise<void> {
  await request(`/api/notebooks/${id}/restore`, { method: "POST" });
}

/**
 * Permanently deletes a trashed notebook with everything in it from the server.
 */
export async function purgeNotebook(id: string): Promise<void> {
  await request(`/api/notebooks/${id}?permanent=true`, { method: "DELETE" });
}

const RESOURCE_ID_IN_URL = /(?:^:\/?|\/api\/resources\/)([0-9a-fA-F]{32})(?:[?#].*)?$/;

/**
 * Extracts the Joplin resource id from ":/<id>" or ".../api/resources/<id>" URLs.
 */
export function getResourceIdFromUrl(src: string | undefined): string | null {
  if (!src) return null;
  const match = RESOURCE_ID_IN_URL.exec(src);
  return match ? match[1].toLowerCase() : null;
}

// Resources are immutable, so each one is downloaded once per session
const resourceObjectUrls = new Map<string, Promise<string>>();

/**
 * Downloads a resource with the session cookie.
 */
async function fetchResourceBlob(resourceId: string): Promise<Blob> {
  const response = await fetch(`${API_BASE_URL}/api/resources/${resourceId}`, SESSION_FETCH_OPTIONS);
  if (!response.ok) {
    throw new ApiError(response.status, `Could not load resource (HTTP ${response.status})`);
  }
  return response.blob();
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Loads a resource for display and returns a URL for <img src>. SVG becomes a data: URL instead of a
 * blob: URL: a blob: URL opened directly ("Open image in new tab") would run the SVG's scripts in
 * this origin, while browsers refuse to open data: URLs as top-level documents.
 */
export function getResourceObjectUrl(resourceId: string): Promise<string> {
  let pending = resourceObjectUrls.get(resourceId);
  if (!pending) {
    pending = (async () => {
      const blob = await fetchResourceBlob(resourceId);
      const type = blob.type.split(";")[0].trim().toLowerCase();
      if (type === "image/svg+xml") {
        return readAsDataUrl(blob);
      }
      // Only images keep their type; anything else can't become a renderable document
      return URL.createObjectURL(
        type.startsWith("image/") ? blob : new Blob([blob], { type: "application/octet-stream" })
      );
    })();
    // Allow a retry later if this attempt failed
    pending.catch(() => resourceObjectUrls.delete(resourceId));
    resourceObjectUrls.set(resourceId, pending);
  }
  return pending;
}

/**
 * Revokes and forgets all loaded resource URLs (on logout, so the next user can't reach them).
 */
export function clearResourceCache(): void {
  for (const pending of resourceObjectUrls.values()) {
    pending
      .then((url) => {
        if (url.startsWith("blob:")) URL.revokeObjectURL(url);
      })
      .catch(() => undefined);
  }
  resourceObjectUrls.clear();
}

/**
 * Adds a tag to a note by title; an existing tag with the same title is reused.
 */
export async function addTagToNote(noteId: string, title: string): Promise<Note> {
  return request<Note>(`/api/notes/${noteId}/tags`, { method: "POST", body: JSON.stringify({ title }) });
}

/**
 * Removes a tag from a note (the tag itself is kept).
 */
export async function removeTagFromNote(noteId: string, tagId: string): Promise<Note> {
  return request<Note>(`/api/notes/${noteId}/tags/${tagId}`, { method: "DELETE" });
}

/**
 * Renames a tag.
 */
export async function renameTag(id: string, title: string): Promise<Tag> {
  return request<Tag>(`/api/tags/${id}`, { method: "PUT", body: JSON.stringify({ title }) });
}

/**
 * Deletes a tag and removes it from all notes.
 */
export async function deleteTag(id: string): Promise<void> {
  await request(`/api/tags/${id}`, { method: "DELETE" });
}

export interface UploadedResource {
  id: string;
  title: string;
  mime: string;
  size: number;
}

/**
 * Uploads a file as a Joplin resource; link it from a note as ":/<id>".
 */
export async function uploadResource(file: File): Promise<UploadedResource> {
  return request<UploadedResource>("/api/resources", {
    method: "POST",
    body: file,
    headers: {
      // Always octet-stream so no JSON/form body parser touches the file on the server
      "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name || "file"),
      "X-File-Type": file.type || "",
    },
  });
}

/**
 * Downloads a resource (attachment) with the session and saves it under the given name.
 */
export async function downloadResource(resourceId: string, fileName: string): Promise<void> {
  // Always octet-stream: the blob: URL is only a download, never a document the browser renders
  const blob = await fetchResourceBlob(resourceId);
  const url = URL.createObjectURL(new Blob([blob], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
