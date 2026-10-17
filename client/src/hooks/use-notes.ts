import { useQuery } from "@tanstack/react-query";
import { getNotes, getNote } from "@/lib/api";
import { NoteListItem, Note } from "@/lib/types";

export const NOTES_QUERY_KEY = ["notes"] as const;

/**
 * Hook to retrieve notes list, optionally filtered by notebook, tag, or trash status.
 */
export function useNotes(notebookId?: string, tagId?: string, isTrash?: boolean) {
  return useQuery<NoteListItem[], Error>({
    queryKey: [...NOTES_QUERY_KEY, { notebookId, tagId, isTrash }],
    queryFn: () => getNotes({ notebookId, tagId, isTrash }),
    staleTime: 15 * 1000, // 15 seconds
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
