import { useMutation, useQueryClient, QueryClient } from "@tanstack/react-query";
import {
  createNote,
  updateNote,
  deleteNote,
  restoreNote,
  createNotebook,
  updateNotebook,
  deleteNotebook,
  addTagToNote,
  removeTagFromNote,
  renameTag,
  deleteTag,
  NoteUpdate,
} from "@/lib/api";
import { Note } from "@/lib/types";
import { NOTES_QUERY_KEY } from "./use-notes";
import { NOTEBOOKS_QUERY_KEY } from "./use-notebooks";
import { TAGS_QUERY_KEY } from "./use-tags";

/**
 * Refreshes every list that can change after a write.
 */
export function invalidateLists(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: NOTES_QUERY_KEY });
  queryClient.invalidateQueries({ queryKey: NOTEBOOKS_QUERY_KEY });
  queryClient.invalidateQueries({ queryKey: TAGS_QUERY_KEY });
  queryClient.invalidateQueries({ queryKey: ["search"] });
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
