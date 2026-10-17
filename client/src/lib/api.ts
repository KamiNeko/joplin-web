import {
  Notebook,
  NoteListItem,
  Note,
  Tag,
  SearchResult,
  LoginResponse,
} from "./types";

const SESSION_KEY = "joplin_session_id";
const USER_KEY = "joplin_user_id";

// Base URL defaults to empty string in browser so Vite proxy handles /api,
// or uses VITE_API_BASE_URL if configured.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";

/**
 * Retrieves the stored session token.
 */
export function getStoredSessionId(): string | null {
  return localStorage.getItem(SESSION_KEY);
}

/**
 * Persists session token to local storage.
 */
export function setStoredSession(sessionId: string, userId?: string): void {
  localStorage.setItem(SESSION_KEY, sessionId);
  if (userId) {
    localStorage.setItem(USER_KEY, userId);
  }
}

/**
 * Clears stored authentication data.
 */
export function clearStoredSession(): void {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(USER_KEY);
}

/**
 * Custom API Error containing status code and response payload.
 */
export class ApiError extends Error {
  status: number;
  data?: unknown;

  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

/**
 * Internal request wrapper handling headers, auth, and error conditions.
 */
async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;
  const sessionId = getStoredSessionId();

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(options.headers as Record<string, string>),
  };

  if (!(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  if (sessionId) {
    headers["Authorization"] = `Bearer ${sessionId}`;
    // Joplin server also commonly looks for X-API-AUTH
    headers["X-API-AUTH"] = sessionId;
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    clearStoredSession();
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      window.location.href = "/login";
    }
    throw new ApiError(401, "Unauthorized session. Please sign in again.");
  }

  if (!response.ok) {
    let errorMessage = `Request failed with status ${response.status}`;
    let errorData: unknown;
    try {
      errorData = await response.json();
      if (typeof errorData === "object" && errorData !== null) {
        if ("error" in errorData && typeof (errorData as { error: unknown }).error === "string") {
          errorMessage = (errorData as { error: string }).error;
        } else if ("message" in errorData && typeof (errorData as { message: unknown }).message === "string") {
          errorMessage = (errorData as { message: string }).message;
        }
      }
    } catch {
      // response wasn't JSON
    }
    throw new ApiError(response.status, errorMessage, errorData);
  }

  if (response.status === 204) {
    return {} as T;
  }

  return response.json();
}

/**
 * Authenticates user with email and password.
 */
export async function login(email: string, password: string): Promise<LoginResponse> {
  // Try /api/login or /api/auth/login
  try {
    const data = await request<LoginResponse>("/api/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (data.sessionId) {
      setStoredSession(data.sessionId, data.userId);
    }
    return data;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      const data = await request<LoginResponse>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      if (data.sessionId) {
        setStoredSession(data.sessionId, data.userId);
      }
      return data;
    }
    throw err;
  }
}

/**
 * Terminates the active session.
 */
export async function logout(): Promise<void> {
  try {
    await request("/api/logout", { method: "POST" });
  } catch {
    // Ignore server error on logout
  } finally {
    clearStoredSession();
  }
}

/**
 * Checks whether the client has an active stored session.
 */
export function checkAuth(): boolean {
  return Boolean(getStoredSessionId());
}

/**
 * Fetches the hierarchical notebook list.
 */
export async function getNotebooks(): Promise<Notebook[]> {
  const data = await request<Notebook[] | { items: Notebook[]; notebooks: Notebook[] }>("/api/notebooks");
  if (Array.isArray(data)) {
    return data;
  }
  return data.notebooks || data.items || [];
}

/**
 * Fetches list of notes, optionally filtered by notebookId or tagId.
 */
export async function getNotes(params?: {
  notebookId?: string;
  tagId?: string;
}): Promise<NoteListItem[]> {
  const query = new URLSearchParams();
  if (params?.notebookId) {
    query.set("notebookId", params.notebookId);
  }
  if (params?.tagId) {
    query.set("tagId", params.tagId);
  }

  const endpoint = `/api/notes${query.toString() ? `?${query.toString()}` : ""}`;
  const data = await request<NoteListItem[] | { items: NoteListItem[]; notes: NoteListItem[] }>(endpoint);

  if (Array.isArray(data)) {
    return data;
  }
  return data.notes || data.items || [];
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
  const data = await request<Tag[] | { items: Tag[]; tags: Tag[] }>("/api/tags");
  if (Array.isArray(data)) {
    return data;
  }
  return data.tags || data.items || [];
}

/**
 * Searches notes by query string.
 */
export async function searchNotes(query: string): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }
  const urlQuery = new URLSearchParams({ query: trimmed });
  const data = await request<SearchResult[] | { items: SearchResult[]; results: SearchResult[] }>(
    `/api/notes/search?${urlQuery.toString()}`
  ).catch(async (err) => {
    // Fallback to /api/search
    if (err instanceof ApiError && err.status === 404) {
      return request<SearchResult[] | { items: SearchResult[]; results: SearchResult[] }>(
        `/api/search?${urlQuery.toString()}`
      );
    }
    throw err;
  });

  if (Array.isArray(data)) {
    return data;
  }
  return data.results || data.items || [];
}

/**
 * Generates the URL for accessing a Joplin resource (images, attachments).
 */
export function getResourceUrl(resourceId: string): string {
  if (!resourceId) return "";
  const cleaned = resourceId.replace(/^:\/?/, "");
  return `${API_BASE_URL}/api/resources/${cleaned}`;
}
