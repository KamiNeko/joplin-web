/**
 * Local safety net for editor text that hasn't reached the server yet (save pending or failing,
 * tab closed, session expired). One draft per note in localStorage, together with the
 * updatedTime of the version it was based on, so a restored draft still goes through conflict
 * detection. Drafts are removed after a successful save and on logout.
 */

const PREFIX = "joplin-draft:";

export interface StoredDraft {
  title: string;
  body: string;
  /** updatedTime of the server version the draft was based on */
  baseUpdatedTime: number;
  /** When the draft was written (ms) */
  savedAt: number;
}

function isStoredDraft(value: unknown): value is StoredDraft {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.title === "string" &&
    typeof v.body === "string" &&
    typeof v.baseUpdatedTime === "number" &&
    typeof v.savedAt === "number"
  );
}

/** Stores (replaces) the unsaved draft of a note. */
export function saveDraft(noteId: string, draft: Omit<StoredDraft, "savedAt">, now = Date.now()): void {
  try {
    localStorage.setItem(PREFIX + noteId, JSON.stringify({ ...draft, savedAt: now }));
  } catch {
    // storage unavailable or full: the editor still holds the text
  }
}

/** Returns the stored draft of a note, or null when there is none (or it is unreadable). */
export function loadDraft(noteId: string): StoredDraft | null {
  try {
    const raw = localStorage.getItem(PREFIX + noteId);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isStoredDraft(parsed) ? parsed : null;
  } catch {
    return null;
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

/** Removes every stored draft (logout). */
export function clearAllDrafts(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    keys.forEach((key) => localStorage.removeItem(key));
  } catch {
    // storage unavailable
  }
}

/**
 * Returns the draft worth offering for restore: one that differs from what the server has now.
 * A draft identical to the server text is stale (its save went through) and is removed.
 */
export function findRestorableDraft(note: { id: string; title: string; body: string }): StoredDraft | null {
  const draft = loadDraft(note.id);
  if (!draft) return null;
  if (draft.title === note.title && draft.body === note.body) {
    clearDraft(note.id);
    return null;
  }
  return draft;
}
