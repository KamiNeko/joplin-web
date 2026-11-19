import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  askNotes,
  clipUrl,
  getAiStatus,
  getHygieneReport,
  getNoteAttachments,
  getNoteRevisionDetail,
  getNoteRevisions,
  getTasks,
  ingestEmail,
  noteAssist,
  restoreNoteRevision,
  toggleInlineTask,
} from "@/lib/api";
import {
  AiFeatureStatus,
  HygieneReport,
  NoteAssistAction,
  NoteAttachment,
  NoteRevisionDetail,
  NoteRevisionMeta,
  TasksResponse,
} from "@/lib/types";
import { invalidateLists, invalidateOtherNotes } from "./use-mutations";

export const TASKS_QUERY_KEY = ["tasks"] as const;
export const HYGIENE_QUERY_KEY = ["hygiene"] as const;
export const AI_STATUS_QUERY_KEY = ["ai", "status"] as const;

export function useTasks(enabled = true) {
  return useQuery<TasksResponse, Error>({
    queryKey: TASKS_QUERY_KEY,
    queryFn: getTasks,
    staleTime: 15 * 1000,
    enabled,
  });
}

export function useToggleInlineTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      noteId: string;
      line: number;
      column: number;
      checked: boolean;
      baseUpdatedTime?: number;
    }) => toggleInlineTask(payload),
    onSuccess: (updatedNote) => {
      queryClient.setQueryData(["note", updatedNote.id], updatedNote);
      queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY });
      invalidateOtherNotes(queryClient, updatedNote.id);
      invalidateLists(queryClient);
    },
    onError: (_err, vars) => {
      queryClient.invalidateQueries({ queryKey: ["note", vars.noteId] });
      queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY });
    },
  });
}

export function useHygieneReport(enabled = true) {
  return useQuery<HygieneReport, Error>({
    queryKey: HYGIENE_QUERY_KEY,
    queryFn: getHygieneReport,
    staleTime: 30 * 1000,
    enabled,
  });
}

export function useAiStatus() {
  return useQuery<AiFeatureStatus, Error>({
    queryKey: AI_STATUS_QUERY_KEY,
    queryFn: getAiStatus,
    staleTime: 60 * 1000,
  });
}

export function useNoteAttachments(noteId?: string | null, enabled = false) {
  return useQuery<NoteAttachment[], Error>({
    queryKey: ["note-attachments", noteId],
    queryFn: () => getNoteAttachments(noteId!),
    enabled: Boolean(noteId && enabled),
    staleTime: 15 * 1000,
  });
}

export function useNoteRevisions(noteId?: string | null, enabled = false) {
  return useQuery<NoteRevisionMeta[], Error>({
    queryKey: ["note-revisions", noteId],
    queryFn: () => getNoteRevisions(noteId!),
    enabled: Boolean(noteId && enabled),
    staleTime: 15 * 1000,
  });
}

export function useNoteRevisionDetail(noteId?: string | null, revId?: string | null) {
  return useQuery<NoteRevisionDetail, Error>({
    queryKey: ["note-revision", noteId, revId],
    queryFn: () => getNoteRevisionDetail(noteId!, revId!),
    enabled: Boolean(noteId && revId),
    staleTime: 60 * 1000,
  });
}

export function useRestoreNoteRevision() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ noteId, revId }: { noteId: string; revId: string }) => restoreNoteRevision(noteId, revId),
    onSuccess: (restored, { noteId }) => {
      queryClient.setQueryData(["note", noteId], restored);
      queryClient.invalidateQueries({ queryKey: ["note-revisions", noteId] });
      invalidateOtherNotes(queryClient, noteId);
      invalidateLists(queryClient);
    },
  });
}

export function useAskNotes() {
  return useMutation({
    mutationFn: (payload: { question: string; scopeNotebookId?: string; scopeTagId?: string }) => askNotes(payload),
  });
}

export function useNoteAssist() {
  return useMutation({
    mutationFn: (payload: { noteId: string; action: NoteAssistAction }) => noteAssist(payload),
  });
}

export function useClipUrl() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { url: string; parentId?: string; tags?: string[]; includeSourceBanner?: boolean }) =>
      clipUrl(payload),
    onSuccess: ({ note }) => {
      queryClient.setQueryData(["note", note.id], note);
      invalidateOtherNotes(queryClient, note.id);
      invalidateLists(queryClient);
    },
  });
}

export function useIngestEmail() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      raw?: string;
      subject?: string;
      from?: string;
      text?: string;
      html?: string;
      parentId?: string;
      tags?: string[];
    }) => ingestEmail(payload),
    onSuccess: ({ note }) => {
      queryClient.setQueryData(["note", note.id], note);
      invalidateOtherNotes(queryClient, note.id);
      invalidateLists(queryClient);
    },
  });
}
