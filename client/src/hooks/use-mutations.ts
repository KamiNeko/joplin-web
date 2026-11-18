import { useMutation, useQueryClient, QueryClient } from "@tanstack/react-query";
import {
  BATCH_CHUNK_SIZE,
  batchUpdateNotes,
  createNote,
  updateNote,
  deleteNote,
  restoreNote,
  createNotebook,
  updateNotebook,
  deleteNotebook,
  restoreNotebook,
  purgeNotebook,
  addTagToNote,
  removeTagFromNote,
  renameTag,
  deleteTag,
  NoteUpdate,
} from "@/lib/api";
import { BatchNoteRequest, BatchNoteResult, Note, NoteListItem, SearchResult } from "@/lib/types";
import { NOTES_QUERY_KEY } from "./use-notes";
import { NOTEBOOKS_QUERY_KEY } from "./use-notebooks";
import { TAGS_QUERY_KEY } from "./use-tags";
import { announceWrite } from "@/lib/cross-tab";

/**
 * Refreshes every list that can change after a write and alerts other tabs.
 */
export function invalidateLists(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: NOTES_QUERY_KEY });
  queryClient.invalidateQueries({ queryKey: NOTEBOOKS_QUERY_KEY });
  queryClient.invalidateQueries({ queryKey: TAGS_QUERY_KEY });
  queryClient.invalidateQueries({ queryKey: ["search"] });
  announceWrite();
}

/**
 * Brings the note's entry in the cached note lists and search results up to date after a change
 * of its title or body only, without refetching anything: notebook counts, tags and list
 * membership stay the same. Lists keep the server's order (newest change first). Search results
 * are only marked stale, as their matches and snippets may have changed; they reload the next
 * time a search is shown.
 */
export function updateNoteInLists(queryClient: QueryClient, saved: Note) {
  const { preview } = saved;
  if (preview === undefined) {
    // A server that doesn't send the preview: let the lists build it
    queryClient.invalidateQueries({ queryKey: NOTES_QUERY_KEY });
    queryClient.invalidateQueries({ queryKey: ["search"] });
    return;
  }
  const patch = <T extends NoteListItem>(items: T[] | undefined, resort: boolean): T[] | undefined => {
    if (!items?.some((item) => item.id === saved.id)) return items;
    const next = items.map((item) =>
      item.id === saved.id ? { ...item, title: saved.title, preview, updatedTime: saved.updatedTime } : item
    );
    return resort ? next.sort((a, b) => b.updatedTime - a.updatedTime) : next;
  };
  queryClient.setQueriesData<NoteListItem[]>({ queryKey: NOTES_QUERY_KEY }, (items) => patch(items, true));
  queryClient.setQueriesData<SearchResult[]>({ queryKey: ["search"] }, (items) => patch(items, false));
  queryClient.invalidateQueries({ queryKey: ["search"], refetchType: "none" });
}

export function useCreateNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createNote,
    onSuccess: (note) => {
      queryClient.setQueryData(["note", note.id], note);
      invalidateLists(queryClient);
    },
  });
}

/**
 * Note update used for metadata changes (move, to-do toggle). The editor saves through
 * updateNote directly so it can handle conflicts itself.
 */
export function useUpdateNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, changes }: { id: string; changes: NoteUpdate }) => updateNote(id, changes),
    onSuccess: (note) => {
      queryClient.setQueryData<Note>(["note", note.id], note);
      invalidateLists(queryClient);
    },
  });
}

export function useDeleteNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, permanent = false }: { id: string; permanent?: boolean }) => deleteNote(id, permanent),
    onSuccess: (_data, { id, permanent }) => {
      if (permanent) {
        queryClient.removeQueries({ queryKey: ["note", id] });
      } else {
        queryClient.invalidateQueries({ queryKey: ["note", id] });
      }
      invalidateLists(queryClient);
    },
  });
}

export function useRestoreNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restoreNote(id),
    onSuccess: (note) => {
      queryClient.setQueryData(["note", note.id], note);
      invalidateLists(queryClient);
    },
  });
}

export function useCreateNotebook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createNotebook,
    onSuccess: () => invalidateLists(queryClient),
  });
}

export function useUpdateNotebook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, changes }: { id: string; changes: { title?: string; parentId?: string } }) =>
      updateNotebook(id, changes),
    onSuccess: () => {
      invalidateLists(queryClient);
      queryClient.invalidateQueries({ queryKey: ["note"] });
    },
  });
}

export function useDeleteNotebook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteNotebook(id),
    onSuccess: () => {
      invalidateLists(queryClient);
      queryClient.invalidateQueries({ queryKey: ["note"] });
    },
  });
}

/** Restores a trashed notebook with its contents */
export function useRestoreNotebook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restoreNotebook(id),
    onSuccess: () => {
      invalidateLists(queryClient);
      queryClient.invalidateQueries({ queryKey: ["note"] });
    },
  });
}

/** Permanently deletes a trashed notebook with its contents */
export function usePurgeNotebook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => purgeNotebook(id),
    onSuccess: () => {
      invalidateLists(queryClient);
      queryClient.invalidateQueries({ queryKey: ["note"] });
    },
  });
}

export function useAddTag() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ noteId, title }: { noteId: string; title: string }) => addTagToNote(noteId, title),
    onSuccess: (note) => {
      queryClient.setQueryData(["note", note.id], note);
      invalidateLists(queryClient);
    },
  });
}

export function useRemoveTag() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ noteId, tagId }: { noteId: string; tagId: string }) => removeTagFromNote(noteId, tagId),
    onSuccess: (note) => {
      queryClient.setQueryData(["note", note.id], note);
      invalidateLists(queryClient);
    },
  });
}

export function useRenameTag() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => renameTag(id, title),
    onSuccess: () => {
      invalidateLists(queryClient);
      queryClient.invalidateQueries({ queryKey: ["note"] });
    },
  });
}

export function useDeleteTag() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteTag(id),
    onSuccess: () => {
      invalidateLists(queryClient);
      queryClient.invalidateQueries({ queryKey: ["note"] });
    },
  });
}

export interface BulkUpdateProgress {
  completed: number;
  total: number;
}

export interface BulkUpdateVariables extends BatchNoteRequest {
  onProgress?: (progress: BulkUpdateProgress) => void;
}

/**
 * Applies a bulk note operation in chunks of up to 1000 items, reporting progress and
 * invalidating affected lists and open notes once per batch.
 */
export function useBulkUpdateNotes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ onProgress, ...request }: BulkUpdateVariables): Promise<BatchNoteResult[]> => {
      const total = request.items.length;
      const results: BatchNoteResult[] = [];
      let completedChunks = 0;
      onProgress?.({ completed: 0, total });
      try {
        for (let offset = 0; offset < total; offset += BATCH_CHUNK_SIZE) {
          const chunk = request.items.slice(offset, offset + BATCH_CHUNK_SIZE);
          const chunkResults = await batchUpdateNotes({ ...request, items: chunk });
          completedChunks++;
          results.push(...chunkResults);
          onProgress?.({ completed: results.length, total });
        }
        return results;
      } finally {
        if (completedChunks > 0) {
          invalidateLists(queryClient);
          queryClient.invalidateQueries({ queryKey: ["note"] });
        }
      }
    },
  });
}
