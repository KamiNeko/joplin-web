/**
 * Local safety net for editor text that hasn't reached the server yet (save pending or failing,
 * tab closed, session expired). One draft per note in localStorage, together with the
 * updatedTime of the version it was based on, so a restored draft still goes through conflict
 * detection.
 *
 * Drafts are plain text on the device, so they are tied to an owner (account + Joplin Server):
 * drafts of another owner are dropped on login and never offered, and every draft expires after
 * DRAFT_MAX_AGE_MS. They are also removed after a successful save and on logout.
 */

const PREFIX = "joplin-draft:";

/** Drafts older than this are dropped instead of offered */
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface StoredDraft {
  title: string;
  body: string;
  /** updatedTime of the server version the draft was based on */
  baseUpdatedTime: number;
  /** When the draft was written (ms) */
  savedAt: number;
  /** Who wrote it, see draftOwner() */
  owner: string;
}

let currentOwner: string | null = null;

/** Identifies the signed-in account on a Joplin Server, e.g. "me@example.com|notes.example.com". */
export function draftOwner(email: string | null, serverHost: string | null): string {
  return `${(email ?? "").trim().toLowerCase()}|${serverHost ?? ""}`;
}

/**
 * Sets the owner new drafts are written for (on login and session restore) and drops drafts that
 * belong to someone else or have expired.
 */
export function setDraftOwner(owner: string | null, now = Date.now()): void {
  currentOwner = owner;
  forEachDraftKey((key) => {
    const draft = parse(localStorage.getItem(key));
    if (!draft || draft.owner !== owner || isExpired(draft, now)) localStorage.removeItem(key);
  });
}

function isExpired(draft: StoredDraft, now: number): boolean {
  return now - draft.savedAt > DRAFT_MAX_AGE_MS;
}

function parse(raw: string | null): StoredDraft | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return null;
    const d = v as Record<string, unknown>;
    return typeof d.title === "string" &&
      typeof d.body === "string" &&
      typeof d.baseUpdatedTime === "number" &&
      typeof d.savedAt === "number" &&
      typeof d.owner === "string"
      ? (d as unknown as StoredDraft)
      : null;
  } catch {
    return null;
  }
}

function forEachDraftKey(fn: (key: string) => void): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    keys.forEach(fn);
  } catch {
    // storage unavailable
  }
}

/** Stores (replaces) the unsaved draft of a note for the current owner. */
export function saveDraft(
  noteId: string,
  draft: Pick<StoredDraft, "title" | "body" | "baseUpdatedTime">,
  now = Date.now()
): void {
  if (currentOwner === null) return;
  const stored: StoredDraft = {
    title: draft.title,
    body: draft.body,
    baseUpdatedTime: draft.baseUpdatedTime,
    savedAt: now,
    owner: currentOwner,
  };
  try {
    localStorage.setItem(PREFIX + noteId, JSON.stringify(stored));
  } catch {
    // storage unavailable or full: the editor still holds the text
  }
}

/**
 * Returns the current owner's draft of a note, or null when there is none. Unreadable, expired
 * and foreign drafts count as none.
 */
export function loadDraft(noteId: string, now = Date.now()): StoredDraft | null {
  let draft: StoredDraft | null;
  try {
    draft = parse(localStorage.getItem(PREFIX + noteId));
  } catch {
    return null;
  }
  if (!draft || currentOwner === null || draft.owner !== currentOwner) return null;
  if (isExpired(draft, now)) {
    clearDraft(noteId);
    return null;
  }
  return draft;
}

/** Puts a draft back exactly as it was (undo of a discard). */
export function restoreStoredDraft(noteId: string, draft: StoredDraft): void {
  try {
    localStorage.setItem(PREFIX + noteId, JSON.stringify(draft));
  } catch {
    // storage unavailable
  }
}

/** Removes the draft of a note. */
export function clearDraft(noteId: string): void {
  try {
    localStorage.removeItem(PREFIX + noteId);
  } catch {
    // storage unavailable
  }
}

/** Removes every stored draft (logout, "Sign out and discard"). */
export function clearAllDrafts(): void {
  forEachDraftKey((key) => localStorage.removeItem(key));
}

/**
 * Returns the draft worth offering for restore: one that differs from what the server has now.
 * A draft identical to the server text is stale (its save went through) and is removed.
 */
export function findRestorableDraft(
  note: { id: string; title: string; body: string },
  now = Date.now()
): StoredDraft | null {
  const draft = loadDraft(note.id, now);
  if (!draft) return null;
  if (draft.title === note.title && draft.body === note.body) {
    clearDraft(note.id);
    return null;
  }
  return draft;
}
