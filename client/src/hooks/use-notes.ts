import { useQuery } from "@tanstack/react-query";
import { getNotes, getNote } from "@/lib/api";
import { NoteListItem, Note } from "@/lib/types";

export const NOTES_QUERY_KEY = ["notes"] as const;

/**
 * Hook to retrieve notes list, optionally filtered by notebook, tag, or trash status.
 * Conflict copies are never part of it (see `useConflictNotes`).
 */
export function useNotes(notebookId?: string, tagId?: string, isTrash?: boolean, enabled = true) {
  return useQuery<NoteListItem[], Error>({
    queryKey: [...NOTES_QUERY_KEY, { notebookId, tagId, isTrash }],
    queryFn: () => getNotes({ notebookId, tagId, isTrash }),
    staleTime: 15 * 1000, // 15 seconds
    enabled,
  });
}

/**
 * Hook to retrieve the conflict copies Joplin kept after sync conflicts (not trashed ones), like
 * Joplin desktop's "Conflicts" folder. Nested under the notes key, so every write refreshes it.
 */
export function useConflictNotes() {
  return useQuery<NoteListItem[], Error>({
    queryKey: [...NOTES_QUERY_KEY, { isConflict: true }],
    queryFn: () => getNotes({ isConflict: true }),
    staleTime: 15 * 1000,
  });
}

/**
 * Hook to retrieve a single full note by ID.
 */
export function useNote(id?: string | null) {
  return useQuery<Note, Error>({
    queryKey: ["note", id],
    queryFn: () => {
      if (!id) {
        throw new Error("Note ID is required");
      }
      return getNote(id);
    },
    enabled: Boolean(id),
    staleTime: 15 * 1000, // 15 seconds
  });
}
