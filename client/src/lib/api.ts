import {
  AiFeatureStatus,
  AskNotesResponse,
  BatchNoteRequest,
  BatchNoteResult,
  ClipResponse,
  EmailIngestResponse,
  HygieneReport,
  Notebook,
  NoteAssistAction,
  NoteAssistResponse,
  NoteAttachment,
  NoteListItem,
  Note,
  NoteRevisionDetail,
  NoteRevisionMeta,
  OrganizeApplyItemInput,
  OrganizeApplyResponse,
  OrganizeDeleteResponse,
  OrganizeJobResponse,
  OrganizeJobStatus,
  OrganizeJobSummary,
  OrganizeRetryResponse,
  OrganizeStatus,
  OrganizeUndoResponse,
  RecentNotesResponse,
  SavedSearch,
  Tag,
  TasksResponse,
  SearchResult,
  LoginResponse,
  TrashedNotebook,
  UserPreferences,
  WriteState,
  TwoFactorStatus,
  PasskeyItem,
  TrustedDeviceItem,
  TotpSetupResponse,
  TwoFactorCompleteResponse,
  TwoFactorMethod,
} from "./types";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/browser";
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

// ---------------------------------------------------------------------------
// Two-Factor Authentication
// ---------------------------------------------------------------------------

export function isStepUpRequiredError(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status === 403 &&
    Boolean((error.data as { stepUpRequired?: unknown } | undefined)?.stepUpRequired)
  );
}

export function getStepUpMethodsFromError(error: unknown): TwoFactorMethod[] {
  if (!(error instanceof ApiError)) return [];
  const methods = (error.data as { methods?: unknown } | undefined)?.methods;
  return Array.isArray(methods) ? (methods as TwoFactorMethod[]) : [];
}

export function isPendingExpiredError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 401 &&
    Boolean((error.data as { expired?: unknown } | undefined)?.expired)
  );
}

export async function verifyTotpLogin(code: string, trustDevice: boolean): Promise<TwoFactorCompleteResponse> {
  return request<TwoFactorCompleteResponse>("/api/auth/2fa/totp/verify", {
    method: "POST",
    body: JSON.stringify({ code, trustDevice }),
    skipAuthRedirect: true,
  });
}

export async function getPasskeyAuthOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return request<PublicKeyCredentialRequestOptionsJSON>("/api/auth/2fa/passkey/auth/options", {
    method: "POST",
    body: JSON.stringify({}),
    skipAuthRedirect: true,
  });
}

export async function verifyPasskeyLogin(
  response: AuthenticationResponseJSON,
  trustDevice: boolean
): Promise<TwoFactorCompleteResponse> {
  return request<TwoFactorCompleteResponse>("/api/auth/2fa/passkey/auth/verify", {
    method: "POST",
    body: JSON.stringify({ response, trustDevice }),
    skipAuthRedirect: true,
  });
}

export async function verifyRecoveryLogin(code: string, trustDevice: boolean): Promise<TwoFactorCompleteResponse> {
  return request<TwoFactorCompleteResponse>("/api/auth/2fa/recovery/verify", {
    method: "POST",
    body: JSON.stringify({ code, trustDevice }),
    skipAuthRedirect: true,
  });
}

export async function setupTotp(skipAuthRedirect = false): Promise<TotpSetupResponse> {
  return request<TotpSetupResponse>("/api/auth/2fa/totp/setup", {
    method: "POST",
    body: JSON.stringify({}),
    skipAuthRedirect,
  });
}

export async function confirmTotp(
  code: string,
  options: { trustDevice?: boolean; skipAuthRedirect?: boolean } = {}
): Promise<TwoFactorCompleteResponse> {
  return request<TwoFactorCompleteResponse>("/api/auth/2fa/totp/confirm", {
    method: "POST",
    body: JSON.stringify({ code, ...(options.trustDevice !== undefined ? { trustDevice: options.trustDevice } : {}) }),
    skipAuthRedirect: options.skipAuthRedirect,
  });
}

export async function getPasskeyRegisterOptions(
  skipAuthRedirect = false
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return request<PublicKeyCredentialCreationOptionsJSON>("/api/auth/2fa/passkey/register/options", {
    method: "POST",
    body: JSON.stringify({}),
    skipAuthRedirect,
  });
}

export async function verifyPasskeyRegistration(
  input: { response: RegistrationResponseJSON; name: string; trustDevice?: boolean },
  skipAuthRedirect = false
): Promise<TwoFactorCompleteResponse> {
  return request<TwoFactorCompleteResponse>("/api/auth/2fa/passkey/register/verify", {
    method: "POST",
    body: JSON.stringify(input),
    skipAuthRedirect,
  });
}

export async function getTwoFactorStatus(): Promise<TwoFactorStatus> {
  return request<TwoFactorStatus>("/api/auth/2fa/status");
}

export async function getPasskeys(): Promise<PasskeyItem[]> {
  const res = await request<{ passkeys: PasskeyItem[] }>("/api/auth/2fa/passkeys");
  return res.passkeys;
}

export async function renamePasskey(id: string, name: string): Promise<PasskeyItem> {
  const res = await request<{ passkey: PasskeyItem }>(`/api/auth/2fa/passkeys/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ name }),
  });
  return res.passkey;
}

export async function deletePasskey(id: string): Promise<void> {
  await request(`/api/auth/2fa/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function removeTotp(): Promise<void> {
  await request("/api/auth/2fa/totp", { method: "DELETE" });
}

export async function regenerateRecoveryCodes(): Promise<string[]> {
  const res = await request<{ recoveryCodes: string[] }>("/api/auth/2fa/recovery/regenerate", {
    method: "POST",
    body: JSON.stringify({}),
  });
  return res.recoveryCodes;
}

export async function getTrustedDevices(): Promise<TrustedDeviceItem[]> {
  const res = await request<{ devices: TrustedDeviceItem[] }>("/api/auth/2fa/trusted-devices");
  return res.devices;
}

export async function revokeAllTrustedDevices(): Promise<void> {
  await request("/api/auth/2fa/trusted-devices", { method: "DELETE" });
}

export async function revokeTrustedDevice(id: string): Promise<void> {
  await request(`/api/auth/2fa/trusted-devices/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function stepUpWithTotp(code: string): Promise<{ verified: boolean; stepUpExpiresAt: number }> {
  return request<{ verified: boolean; stepUpExpiresAt: number }>("/api/auth/2fa/step-up/totp", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

export async function getStepUpPasskeyOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return request<PublicKeyCredentialRequestOptionsJSON>("/api/auth/2fa/step-up/passkey/options", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function stepUpWithPasskey(
  response: AuthenticationResponseJSON
): Promise<{ verified: boolean; stepUpExpiresAt: number }> {
  return request<{ verified: boolean; stepUpExpiresAt: number }>("/api/auth/2fa/step-up/passkey/verify", {
    method: "POST",
    body: JSON.stringify({ response }),
  });
}

export async function stepUpWithRecovery(
  code: string
): Promise<{ verified: boolean; stepUpExpiresAt: number; recoveryCodesRemaining: number }> {
  return request<{ verified: boolean; stepUpExpiresAt: number; recoveryCodesRemaining: number }>(
    "/api/auth/2fa/step-up/recovery",
    {
      method: "POST",
      body: JSON.stringify({ code }),
    }
  );
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
  sourceUrl?: string;
  author?: string;
}): Promise<Note> {
  return request<Note>("/api/notes", { method: "POST", body: JSON.stringify(input) });
}

export interface NoteUpdate {
  title?: string;
  body?: string;
  parentId?: string;
  todoCompleted?: boolean;
  /** To-do due date in Unix ms; 0 or null clears it */
  todoDue?: number | null;
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

/** Maximum items sent in one POST /api/notes/batch request (matches server cap). */
export const BATCH_CHUNK_SIZE = 1000;

/**
 * Applies a bulk update to up to 1000 notes; returns one outcome entry per item.
 */
export async function batchUpdateNotes(payload: BatchNoteRequest): Promise<BatchNoteResult[]> {
  return request<BatchNoteResult[]>("/api/notes/batch", {
    method: "POST",
    body: JSON.stringify(payload),
  });
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
const resourceCacheClearers = new Set<() => void>();

/**
 * Registers a cache-cleanup callback to run alongside `clearResourceCache()` (e.g. on logout).
 */
export function onClearResourceCache(clearer: () => void): () => void {
  resourceCacheClearers.add(clearer);
  return () => {
    resourceCacheClearers.delete(clearer);
  };
}

/**
 * Fetches a resource response with the session cookie.
 */
async function fetchResource(resourceId: string, query = ""): Promise<Response> {
  const response = await fetch(`${API_BASE_URL}/api/resources/${resourceId}${query}`, SESSION_FETCH_OPTIONS);
  if (!response.ok) {
    throw new ApiError(response.status, `Could not load resource (HTTP ${response.status})`);
  }
  return response;
}

/**
 * Downloads a resource as a Blob with the session cookie.
 */
async function fetchResourceBlob(resourceId: string): Promise<Blob> {
  return (await fetchResource(resourceId)).blob();
}

/**
 * Fetches a resource's raw bytes with the session cookie. An optional query string (such as
 * `"?view=pdf"`) lets callers share the browser cache key of an inline view.
 */
export async function fetchResourceBytes(resourceId: string, query = ""): Promise<Uint8Array> {
  return new Uint8Array(await (await fetchResource(resourceId, query)).arrayBuffer());
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
  for (const clearer of resourceCacheClearers) {
    clearer();
  }
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

// ---------------------------------------------------------------------------
// Auto-organize
// ---------------------------------------------------------------------------

/**
 * Checks whether Auto-organize is configured and enabled on the server.
 */
export async function getOrganizeStatus(): Promise<OrganizeStatus> {
  const data = await request<{ enabled?: unknown; model?: unknown } | null>("/api/organize/status");
  const enabled = data?.enabled === true;
  return {
    enabled,
    ...(enabled && typeof data?.model === "string" ? { model: data.model } : {}),
  };
}

/**
 * Lists the user's persisted and active Auto-organize jobs, newest first.
 */
export async function listOrganizeJobs(): Promise<{ jobs: OrganizeJobSummary[] }> {
  const data = await request<{ jobs?: unknown } | OrganizeJobSummary[] | null>("/api/organize/jobs");
  if (Array.isArray(data)) {
    return { jobs: data };
  }
  return {
    jobs: Array.isArray(data?.jobs) ? (data.jobs as OrganizeJobSummary[]) : [],
  };
}

/**
 * Extracts `runningJobId` from a 409 response when starting or retrying while another job runs.
 */
export function getOrganizeRunningJobId(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const details = (error.data as { details?: { runningJobId?: unknown } } | undefined)?.details;
  return typeof details?.runningJobId === "string" ? details.runningJobId : null;
}

/**
 * Starts a server-side Auto-organize job for the selected note IDs.
 */
export async function createOrganizeJob(payload: {
  noteIds: string[];
  excludeNotebookIds?: string[];
}): Promise<{ jobId: string }> {
  return request<{ jobId: string }>("/api/organize/jobs", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/**
 * Fetches job status, progress, token usage, and a page of note suggestions.
 */
export async function getOrganizeJob(
  jobId: string,
  params?: { offset?: number; limit?: number }
): Promise<OrganizeJobResponse> {
  const query = new URLSearchParams();
  if (params?.offset !== undefined) query.set("offset", String(params.offset));
  if (params?.limit !== undefined) query.set("limit", String(params.limit));
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return request<OrganizeJobResponse>(`/api/organize/jobs/${encodeURIComponent(jobId)}${suffix}`);
}

/**
 * Cancels an in-progress Auto-organize job.
 */
export async function cancelOrganizeJob(jobId: string): Promise<{ id: string; status: OrganizeJobStatus }> {
  return request<{ id: string; status: OrganizeJobStatus }>(`/api/organize/jobs/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });
}

/**
 * Deletes a finished or cancelled Auto-organize job from disk and history.
 */
export async function deleteOrganizeJob(jobId: string): Promise<OrganizeDeleteResponse> {
  return request<OrganizeDeleteResponse>(`/api/organize/jobs/${encodeURIComponent(jobId)}?remove=1`, {
    method: "DELETE",
  });
}

/**
 * Re-queues retryable failed items on a job using the current notebook tree and resumes analysis.
 */
export async function retryOrganizeJob(jobId: string): Promise<OrganizeRetryResponse> {
  return request<OrganizeRetryResponse>(`/api/organize/jobs/${encodeURIComponent(jobId)}/retry`, {
    method: "POST",
  });
}

/**
 * Applies selected/edited suggestions from an organize job in bulk.
 */
export async function applyOrganizeJob(
  jobId: string,
  items: OrganizeApplyItemInput[]
): Promise<OrganizeApplyResponse> {
  return request<OrganizeApplyResponse>(`/api/organize/jobs/${encodeURIComponent(jobId)}/apply`, {
    method: "POST",
    body: JSON.stringify({ items }),
  });
}

/**
 * Reverts the last apply performed on this organize job (skipping notes changed since).
 */
export async function undoOrganizeJob(jobId: string): Promise<OrganizeUndoResponse> {
  return request<OrganizeUndoResponse>(`/api/organize/jobs/${encodeURIComponent(jobId)}/undo`, {
    method: "POST",
  });
}

// ---------------------------------------------------------------------------
// Workspace Preferences (Shortcuts, Saved Searches, Recent Reads, Scratchpad)
// ---------------------------------------------------------------------------

export const EMPTY_USER_PREFERENCES: UserPreferences = {
  favoriteNoteIds: [],
  favoriteNotebookIds: [],
  savedSearches: [],
  recentReads: [],
  scratchpad: "",
  favoriteNotes: [],
  favoriteNotebooks: [],
};

function normalizePreferences(data: unknown): UserPreferences {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return EMPTY_USER_PREFERENCES;
  }
  const obj = data as Partial<UserPreferences>;
  return {
    favoriteNoteIds: Array.isArray(obj.favoriteNoteIds) ? obj.favoriteNoteIds : [],
    favoriteNotebookIds: Array.isArray(obj.favoriteNotebookIds) ? obj.favoriteNotebookIds : [],
    savedSearches: Array.isArray(obj.savedSearches) ? obj.savedSearches : [],
    recentReads: Array.isArray(obj.recentReads) ? obj.recentReads : [],
    scratchpad: typeof obj.scratchpad === "string" ? obj.scratchpad : "",
    favoriteNotes: Array.isArray(obj.favoriteNotes) ? obj.favoriteNotes : [],
    favoriteNotebooks: Array.isArray(obj.favoriteNotebooks) ? obj.favoriteNotebooks : [],
  };
}

export async function getPreferences(): Promise<UserPreferences> {
  const data = await request<unknown>("/api/preferences");
  return normalizePreferences(data);
}

export async function favoriteNote(id: string): Promise<UserPreferences> {
  const data = await request<unknown>(`/api/preferences/favorites/notes/${encodeURIComponent(id)}`, {
    method: "POST",
  });
  return normalizePreferences(data);
}

export async function unfavoriteNote(id: string): Promise<UserPreferences> {
  const data = await request<unknown>(`/api/preferences/favorites/notes/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return normalizePreferences(data);
}

export async function favoriteNotebook(id: string): Promise<UserPreferences> {
  const data = await request<unknown>(`/api/preferences/favorites/notebooks/${encodeURIComponent(id)}`, {
    method: "POST",
  });
  return normalizePreferences(data);
}

export async function unfavoriteNotebook(id: string): Promise<UserPreferences> {
  const data = await request<unknown>(`/api/preferences/favorites/notebooks/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return normalizePreferences(data);
}

export async function createSavedSearch(name: string, query: string): Promise<SavedSearch> {
  return request<SavedSearch>("/api/preferences/saved-searches", {
    method: "POST",
    body: JSON.stringify({ name, query }),
  });
}

export async function deleteSavedSearch(id: string): Promise<void> {
  await request(`/api/preferences/saved-searches/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** Records a note open without triggering pendingWrites tracking or session-expired dialogs. */
export async function recordRecentRead(noteId: string): Promise<void> {
  await request(`/api/preferences/recent-reads/${encodeURIComponent(noteId)}`, {
    method: "POST",
    isRead: true,
    skipAuthRedirect: true,
  });
}

export async function saveScratchpad(scratchpad: string): Promise<{ scratchpad: string }> {
  const data = await request<{ scratchpad?: unknown } | null>("/api/preferences/scratchpad", {
    method: "PUT",
    body: JSON.stringify({ scratchpad }),
  });
  return { scratchpad: typeof data?.scratchpad === "string" ? data.scratchpad : scratchpad };
}

// ---------------------------------------------------------------------------
// Recent, Attachments, Revisions, Tasks, Hygiene, AI & Capture Pipelines
// ---------------------------------------------------------------------------

export async function getRecentNotes(): Promise<RecentNotesResponse> {
  const data = await request<Partial<RecentNotesResponse> | unknown[] | null>("/api/notes/recent");
  if (!data || Array.isArray(data)) {
    return { recentRead: [], recentCreated: [] };
  }
  return {
    recentRead: Array.isArray(data.recentRead) ? data.recentRead : [],
    recentCreated: Array.isArray(data.recentCreated) ? data.recentCreated : [],
  };
}

export async function getNoteAttachments(noteId: string): Promise<NoteAttachment[]> {
  const data = await request<unknown>(`/api/notes/${encodeURIComponent(noteId)}/attachments`);
  return Array.isArray(data) ? (data as NoteAttachment[]) : [];
}

export async function getNoteRevisions(noteId: string): Promise<NoteRevisionMeta[]> {
  const data = await request<unknown>(`/api/notes/${encodeURIComponent(noteId)}/revisions`);
  return Array.isArray(data) ? (data as NoteRevisionMeta[]) : [];
}

export async function getNoteRevisionDetail(noteId: string, revId: string): Promise<NoteRevisionDetail> {
  return request<NoteRevisionDetail>(
    `/api/notes/${encodeURIComponent(noteId)}/revisions/${encodeURIComponent(revId)}`
  );
}

export async function restoreNoteRevision(noteId: string, revId: string): Promise<Note> {
  return request<Note>(
    `/api/notes/${encodeURIComponent(noteId)}/revisions/${encodeURIComponent(revId)}/restore`,
    { method: "POST" }
  );
}

export async function getTasks(): Promise<TasksResponse> {
  const data = await request<Partial<TasksResponse> | unknown[] | null>("/api/tasks");
  if (!data || Array.isArray(data)) {
    return { todoNotes: [], inlineTasks: [] };
  }
  return {
    todoNotes: Array.isArray(data.todoNotes) ? data.todoNotes : [],
    inlineTasks: Array.isArray(data.inlineTasks) ? data.inlineTasks : [],
  };
}

export async function toggleInlineTask(payload: {
  noteId: string;
  line: number;
  column: number;
  checked: boolean;
  baseUpdatedTime?: number;
}): Promise<Note> {
  return request<Note>("/api/tasks/toggle", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function getHygieneReport(): Promise<HygieneReport> {
  const data = await request<Partial<HygieneReport> | unknown[] | null>("/api/organize/hygiene");
  if (!data || Array.isArray(data)) {
    return { duplicateClusters: [], emptyNotes: [], untaggedNotes: [] };
  }
  return {
    duplicateClusters: Array.isArray(data.duplicateClusters) ? data.duplicateClusters : [],
    emptyNotes: Array.isArray(data.emptyNotes) ? data.emptyNotes : [],
    untaggedNotes: Array.isArray(data.untaggedNotes) ? data.untaggedNotes : [],
  };
}

export async function getAiStatus(): Promise<AiFeatureStatus> {
  const data = await request<Partial<AiFeatureStatus> | unknown[] | null>("/api/ai/status");
  if (!data || Array.isArray(data)) return { enabled: false };
  const enabled = data.enabled === true;
  return {
    enabled,
    ...(enabled && typeof data.model === "string" ? { model: data.model } : {}),
  };
}

export async function askNotes(payload: {
  question: string;
  scopeNotebookId?: string;
  scopeTagId?: string;
}): Promise<AskNotesResponse> {
  return request<AskNotesResponse>("/api/ai/ask", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function noteAssist(payload: {
  noteId: string;
  action: NoteAssistAction;
}): Promise<NoteAssistResponse> {
  return request<NoteAssistResponse>("/api/ai/note-assist", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function clipUrl(payload: {
  url: string;
  parentId?: string;
  tags?: string[];
  includeSourceBanner?: boolean;
}): Promise<ClipResponse> {
  return request<ClipResponse>("/api/clip", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function ingestEmail(payload: {
  raw?: string;
  subject?: string;
  from?: string;
  text?: string;
  html?: string;
  parentId?: string;
  tags?: string[];
}): Promise<EmailIngestResponse> {
  return request<EmailIngestResponse>("/api/integrations/email", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
