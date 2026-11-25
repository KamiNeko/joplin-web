import { useState, useMemo, useEffect, useRef } from "react";
import { useLocation, useParams, useNavigate, useSearchParams } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { Sidebar } from "@/components/layout/Sidebar";
import { NoteList } from "@/components/notes/NoteList";
import { NoteViewer } from "@/components/notes/NoteViewer";
import { SearchResults } from "@/components/search/SearchResults";
import { useNotebooks, useTrashedNotebooks } from "@/hooks/use-notebooks";
import { TrashedNotebooks } from "@/components/notebooks/TrashedNotebooks";
import { useTags } from "@/hooks/use-tags";
import { useNotes, useNote, useConflictNotes } from "@/hooks/use-notes";
import { useSearch } from "@/hooks/use-search";
import { BulkUpdateProgress, useBulkUpdateNotes, useCreateNote, useUpdateNote } from "@/hooks/use-mutations";
import { useCreateSavedSearch, usePreferences, useRecordRecentRead } from "@/hooks/use-preferences";
import { useNoteSelection } from "@/hooks/use-note-selection";
import { findNotebookAncestors, findNotebookById, flattenNotebooks } from "@/lib/notebooks";
import { BatchNoteItem, BatchNoteResult, NoteListItem, NotebookBreadcrumb } from "@/lib/types";
import { toast } from "sonner";
import { noteDisplayTitle } from "@/lib/format";
import { useWriteState } from "@/hooks/use-write-state";
import {
  useCancelOrganizeJob,
  useCreateOrganizeJob,
  useOrganizeJobs,
  useOrganizeStatus,
} from "@/hooks/use-organize";
import { getOrganizeRunningJobId } from "@/lib/api";
import { StartOrganizeDialog } from "@/components/organize/StartOrganizeDialog";

/** The list shown in the middle column: everything, one notebook, one tag, the conflicts or the trash */
type ListScope =
  | { kind: "all" }
  | { kind: "notebook"; notebookId: string }
  | { kind: "tag"; tagId: string }
  | { kind: "conflicts" }
  | { kind: "trash" };

/** URL of a list, optionally with a note open in it */
function scopeUrl(scope: ListScope, noteId?: string | null): string {
  const note = noteId ? `/${noteId}` : "";
  switch (scope.kind) {
    case "trash":
      return `/trash${note}`;
    case "conflicts":
      return `/conflicts${note}`;
    case "notebook":
      return `/notebooks/${scope.notebookId}${noteId ? `/notes/${noteId}` : ""}`;
    case "tag":
      return `/notes${note}?tag=${encodeURIComponent(scope.tagId)}`;
    default:
      return `/notes${note}`;
  }
}

function summarizeBulkResults(results: BatchNoteResult[]) {
  const ok: BatchNoteResult[] = [];
  const conflicts: BatchNoteResult[] = [];
  const errors: BatchNoteResult[] = [];
  for (const r of results) {
    if (r.status === "ok") ok.push(r);
    else if (r.status === "conflict") conflicts.push(r);
    else errors.push(r);
  }
  return { ok, conflicts, errors };
}

function formatBulkSkips(conflictsCount: number, errorsCount: number): string {
  const parts: string[] = [];
  if (conflictsCount > 0) parts.push(`${conflictsCount} skipped: changed elsewhere`);
  if (errorsCount > 0) parts.push(`${errorsCount} failed`);
  return parts.length > 0 ? `, ${parts.join(", ")}` : "";
}

/**
 * Notes page. The URL is the source of truth for the selected list and note, so browser
 * Back/Forward (and the swipe-back gesture on phones) move between them:
 * `/notes[/:noteId][?tag=:tagId]`, `/notebooks/:notebookId[/notes/:noteId]`, `/conflicts[/:noteId]`,
 * `/trash[/:noteId]`.
 */
export function NotesPage() {
  const params = useParams();
  const { pathname, hash } = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const isTrashSelected = pathname.startsWith("/trash");
  const isConflictsSelected = pathname.startsWith("/conflicts");
  const isNotebookRoute = pathname.startsWith("/notebooks/");
  // On /notebooks/:id the id is a notebook; on /notebooks/:notebookId/notes/:id it is a note
  const selectedNotebookId = isNotebookRoute ? params.notebookId ?? params.id ?? null : null;
  const selectedNoteId = (isNotebookRoute ? (params.notebookId ? params.id : undefined) : params.id) ?? null;
  // A tag filter only applies to the /notes routes, so it never combines with a notebook or the trash
  const selectedTagId =
    !isTrashSelected && !isConflictsSelected && !isNotebookRoute ? searchParams.get("tag") || null : null;

  const scope: ListScope = isTrashSelected
    ? { kind: "trash" }
    : isConflictsSelected
    ? { kind: "conflicts" }
    : selectedNotebookId
    ? { kind: "notebook", notebookId: selectedNotebookId }
    : selectedTagId
    ? { kind: "tag", tagId: selectedTagId }
    : { kind: "all" };

  const urlQueryParam = searchParams.get("q") ?? "";
  const [prevUrlQuery, setPrevUrlQuery] = useState<string>(urlQueryParam);
  const [searchQuery, setSearchQuery] = useState<string>(urlQueryParam);
  if (urlQueryParam !== prevUrlQuery) {
    setPrevUrlQuery(urlQueryParam);
    setSearchQuery(urlQueryParam);
  }
  const handleSearchChange = (q: string) => {
    setSearchQuery(q);
    if (!q && searchParams.has("q")) {
      const next = new URLSearchParams(searchParams);
      next.delete("q");
      setSearchParams(next, { replace: true });
    }
  };
  // Note that should open in the editor (set right after creating it)
  const [editIntentNoteId, setEditIntentNoteId] = useState<string | null>(null);
  const [bulkProgress, setBulkProgress] = useState<BulkUpdateProgress | null>(null);
  const [organizeTargets, setOrganizeTargets] = useState<{
    notes: NoteListItem[];
    defaultExcludedNotebookId: string | null;
  } | null>(null);
  const [organizeConflict, setOrganizeConflict] = useState<{
    runningJobId: string;
    message: string;
  } | null>(null);
  const createNote = useCreateNote();
  const updateNote = useUpdateNote();
  const bulkUpdate = useBulkUpdateNotes();
  const { data: organizeStatus } = useOrganizeStatus();
  const { data: organizeJobsData, refetch: refetchOrganizeJobs } = useOrganizeJobs(
    Boolean(organizeStatus?.enabled)
  );
  const createOrganizeJob = useCreateOrganizeJob();
  const cancelOrganizeJob = useCancelOrganizeJob();
  const createSavedSearch = useCreateSavedSearch();
  const recordRecentRead = useRecordRecentRead();
  // An account with end-to-end encryption is read-only: no editing, creating, tagging or uploads
  const { readOnly, reason: readOnlyReason } = useWriteState();
  const { data: preferences } = usePreferences(!readOnly);
  const favoriteNoteIds = useMemo(
    () => new Set(preferences?.favoriteNoteIds ?? []),
    [preferences?.favoriteNoteIds]
  );

  // TanStack queries
  const { data: notebooks } = useNotebooks();
  const { data: trashedNotebooks } = useTrashedNotebooks(isTrashSelected);
  const { data: tags } = useTags();
  const regularNotesQuery = useNotes(
    selectedNotebookId || undefined,
    selectedTagId || undefined,
    isTrashSelected,
    !isConflictsSelected
  );
  // Also feeds the sidebar's Conflicts entry (same query)
  const conflictNotesQuery = useConflictNotes();
  const notesQuery = isConflictsSelected ? conflictNotesQuery : regularNotesQuery;
  const { data: notes, isLoading: isLoadingNotes } = notesQuery;
  const noteQuery = useNote(selectedNoteId);
  const { data: fullNote, isLoading: isLoadingNote, error: noteError } = noteQuery;
  const searchQueryResult = useSearch(searchQuery);
  const { data: searchResults, isLoading: isLoadingSearch, debouncedQuery } = searchQueryResult;

  // Record note opens in recent-reads after a brief dwell (never blocks UI or triggers before fast list auto-opens)
  const lastRecordedReadRef = useRef<string | null>(null);
  const recordReadMutateRef = useRef(recordRecentRead.mutate);
  useEffect(() => {
    recordReadMutateRef.current = recordRecentRead.mutate;
  }, [recordRecentRead.mutate]);
  useEffect(() => {
    const id = fullNote?.id;
    if (!id || readOnly || fullNote.deletedTime || fullNote.encrypted) return;
    if (lastRecordedReadRef.current === id) return;
    const timer = window.setTimeout(() => {
      lastRecordedReadRef.current = id;
      recordReadMutateRef.current(id);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [fullNote?.id, fullNote?.deletedTime, fullNote?.encrypted, readOnly]);

  const isSearchActive = debouncedQuery.length >= 2;
  // Remount the list per scope so its filter doesn't carry over to another notebook or tag
  // (the sort choice is stored separately and stays)
  const listKey =
    selectedNotebookId ??
    (selectedTagId ? `tag:${selectedTagId}` : isTrashSelected ? "trash" : isConflictsSelected ? "conflicts" : "all");
  const selection = useNoteSelection({ scopeKey: `${listKey}:${isSearchActive ? "search" : "list"}` });

  // When the page is opened on a plain /notes/:id URL, show that note's notebook in the list
  // (first load only, so picking a note from "All Notes" doesn't switch the list)
  const openedViaNoteUrl = useRef(scope.kind === "all" && Boolean(selectedNoteId));
  useEffect(() => {
    if (!openedViaNoteUrl.current || !fullNote) return;
    openedViaNoteUrl.current = false;
    if (scope.kind === "all" && fullNote.id === selectedNoteId && !fullNote.deletedTime) {
      // Conflict copies are not listed in their notebook, only under Conflicts
      const target: ListScope = fullNote.isConflict
        ? { kind: "conflicts" }
        : { kind: "notebook", notebookId: fullNote.notebookId };
      // Keep a "#heading" fragment from a link to a heading in this note
      navigate(scopeUrl(target, fullNote.id) + hash, { replace: true });
    }
  }, [fullNote, scope.kind, selectedNoteId, navigate, hash]);

  // Notebook title lookup
  const currentNotebook = useMemo(
    () => findNotebookById(notebooks, selectedNotebookId),
    [notebooks, selectedNotebookId]
  );

  const notebookTitle = useMemo(() => {
    if (isTrashSelected) return "Trash";
    if (isConflictsSelected) return "Conflicts";
    if (selectedTagId) return `#${tags?.find((t) => t.id === selectedTagId)?.title ?? "Tag"}`;
    if (currentNotebook) return currentNotebook.title;
    return undefined;
  }, [currentNotebook, selectedTagId, isTrashSelected, isConflictsSelected, tags]);

  // The header names the list being shown (All Notes, a tag, a notebook with its parents), never the
  // open note's own notebook: the note viewer shows that one
  const notebookPath = useMemo<NotebookBreadcrumb[] | undefined>(() => {
    if (!currentNotebook) return undefined;
    return [...findNotebookAncestors(notebooks, currentNotebook.id), currentNotebook.id]
      .map((nbId) => findNotebookById(notebooks, nbId))
      .filter((nb): nb is NonNullable<typeof nb> => nb !== null)
      .map((nb) => ({ id: nb.id, title: nb.title }));
  }, [notebooks, currentNotebook]);

  const noteTitle = fullNote ? noteDisplayTitle(fullNote) : undefined;

  // Side by side (md and up) a list opens its top note; on phones the list replaces the note
  const isSideBySide = Boolean(window.matchMedia?.("(min-width: 768px)").matches);

  // Handlers only navigate; the selection follows from the URL
  const showList = (next: ListScope) => {
    setSearchQuery("");
    // Picking the list that is already shown keeps its open note
    const keepNote = isSideBySide && scopeUrl(next) === scopeUrl(scope);
    navigate(scopeUrl(next, keepNote ? selectedNoteId : null));
  };

  const handleSelectNotebook = (id: string) => showList({ kind: "notebook", notebookId: id });
  const handleSelectTag = (tagId: string) => showList({ kind: "tag", tagId });
  const handleSelectAllNotes = () => showList({ kind: "all" });
  const handleSelectTrash = () => showList({ kind: "trash" });
  const handleSelectConflicts = () => showList({ kind: "conflicts" });

  const handleSelectNote = (id: string) => {
    setEditIntentNoteId(null);
    if (id !== selectedNoteId) navigate(scopeUrl(scope, id));
  };

  const handleCloseNoteViewer = () => {
    setEditIntentNoteId(null);
    navigate(scopeUrl(scope));
  };

  // New notes go into the selected notebook, else the open note's notebook, else the first notebook
  // (never an encrypted one: the server refuses cleartext notes in it)
  const targetNotebookId = useMemo(() => {
    const usable = (id: string | null | undefined) => {
      const nb = findNotebookById(notebooks, id);
      return Boolean(nb && !nb.encrypted);
    };
    if (usable(selectedNotebookId)) return selectedNotebookId;
    if (usable(fullNote?.notebookId)) return fullNote!.notebookId;
    return flattenNotebooks(notebooks).find((nb) => !nb.encrypted)?.id ?? null;
  }, [selectedNotebookId, fullNote, notebooks]);

  const handleCreateNote = (isTodo: boolean) => {
    if (!targetNotebookId) {
      toast.error("Create a notebook first", { description: "Notes in Joplin always belong to a notebook." });
      return;
    }
    createNote.mutate(
      { parentId: targetNotebookId, title: "", body: "", isTodo },
      {
        onSuccess: (note) => {
          setSearchQuery("");
          setEditIntentNoteId(note.id);
          // Open it in the list it was created from; from the trash or a tag, show its notebook
          navigate(
            scopeUrl(
              scope.kind === "all" || scope.kind === "notebook" ? scope : { kind: "notebook", notebookId: note.notebookId },
              note.id
            )
          );
        },
        onError: (err) => toast.error("Could not create note", { description: err.message }),
      }
    );
  };

  const handleToggleTodo = (id: string, completed: boolean) => {
    updateNote.mutate(
      { id, changes: { todoCompleted: completed } },
      { onError: (err) => toast.error("Could not update to-do", { description: err.message }) }
    );
  };

  // The note is gone, so its URL should not stay in the history
  const handleNoteRemoved = () => {
    setEditIntentNoteId(null);
    navigate(scopeUrl(scope), { replace: true });
  };

  const runUndoBatch = async (
    payload: { items: BatchNoteItem[]; removeTags?: string[]; restore?: boolean },
    successVerb: (count: number, noun: string) => string
  ) => {
    try {
      const results = await bulkUpdate.mutateAsync({ ...payload, onProgress: setBulkProgress });
      const { ok, conflicts, errors } = summarizeBulkResults(results);
      const skips = formatBulkSkips(conflicts.length, errors.length);
      if (ok.length > 0) {
        const noun = ok.length === 1 ? "note" : "notes";
        const notify = conflicts.length > 0 || errors.length > 0 ? toast.warning : toast.success;
        notify(`${successVerb(ok.length, noun)}${skips}`);
      } else if (conflicts.length > 0 && errors.length === 0) {
        toast.warning(`Nothing undone, ${conflicts.length} skipped: changed elsewhere`);
      } else {
        toast.error(`Could not undo action${skips}`, { description: errors[0]?.error });
      }
    } catch (err) {
      toast.error("Could not undo action", { description: err instanceof Error ? err.message : undefined });
    } finally {
      setBulkProgress(null);
    }
  };

  const handleBulkMove = async (targetNotes: NoteListItem[], notebookId: string, notebookTitle: string) => {
    const previousParents = new Map<string, string>(
      targetNotes.map((n) => [n.id, n.parentId || n.notebookId || ""])
    );
    try {
      const results = await bulkUpdate.mutateAsync({
        items: targetNotes.map((n) => ({ id: n.id, baseUpdatedTime: n.updatedTime })),
        parentId: notebookId,
        onProgress: setBulkProgress,
      });
      const { ok, conflicts, errors } = summarizeBulkResults(results);
      const skips = formatBulkSkips(conflicts.length, errors.length);
      if (ok.length > 0) {
        selection.exitSelectionMode();
        if (isConflictsSelected && selectedNoteId && ok.some((r) => r.id === selectedNoteId)) {
          handleNoteRemoved();
        }
        const undoItems: BatchNoteItem[] = [];
        for (const r of ok) {
          const prevParent = previousParents.get(r.id);
          if (!prevParent) continue;
          undoItems.push({
            id: r.id,
            ...(r.updatedTime !== undefined ? { baseUpdatedTime: r.updatedTime } : {}),
            parentId: prevParent,
          });
        }
        const noun = ok.length === 1 ? "note" : "notes";
        const notify = conflicts.length > 0 || errors.length > 0 ? toast.warning : toast.success;
        notify(`Moved ${ok.length} ${noun}${skips}`, {
          description: `to "${notebookTitle}"`,
          action:
            undoItems.length > 0
              ? {
                  label: "Undo",
                  onClick: () =>
                    void runUndoBatch({ items: undoItems }, (count, n) => `Moved back ${count} ${n}`),
                }
              : undefined,
        });
      } else if (conflicts.length > 0 && errors.length === 0) {
        toast.warning(`No notes moved, ${conflicts.length} skipped: changed elsewhere`);
      } else {
        toast.error(`Could not move notes${skips}`, { description: errors[0]?.error });
      }
    } catch (err) {
      toast.error("Could not move notes", { description: err instanceof Error ? err.message : undefined });
    } finally {
      setBulkProgress(null);
    }
  };

  const handleBulkAddTag = async (targetNotes: NoteListItem[], tagTitle: string) => {
    try {
      const results = await bulkUpdate.mutateAsync({
        items: targetNotes.map((n) => ({ id: n.id, baseUpdatedTime: n.updatedTime })),
        addTags: [tagTitle],
        onProgress: setBulkProgress,
      });
      const { ok, conflicts, errors } = summarizeBulkResults(results);
      const skips = formatBulkSkips(conflicts.length, errors.length);
      if (ok.length > 0) {
        selection.exitSelectionMode();
        const newlyTagged = ok.filter((r) => (r.addedTags?.length ?? 0) > 0);
        const canonicalTag = newlyTagged[0]?.addedTags?.[0] ?? tagTitle;
        const alreadyTaggedCount = ok.length - newlyTagged.length;
        const notify = conflicts.length > 0 || errors.length > 0 ? toast.warning : toast.success;
        if (newlyTagged.length > 0) {
          const noun = newlyTagged.length === 1 ? "note" : "notes";
          const undoItems: BatchNoteItem[] = newlyTagged.map((r) => ({
            id: r.id,
            ...(r.updatedTime !== undefined ? { baseUpdatedTime: r.updatedTime } : {}),
          }));
          notify(`Added #${canonicalTag} to ${newlyTagged.length} ${noun}${skips}`, {
            description:
              alreadyTaggedCount > 0 ? `${alreadyTaggedCount} already had #${canonicalTag}` : undefined,
            action: {
              label: "Undo",
              onClick: () =>
                void runUndoBatch(
                  { items: undoItems, removeTags: [canonicalTag] },
                  (count, n) => `Removed #${canonicalTag} from ${count} ${n}`
                ),
            },
          });
        } else {
          const noun = ok.length === 1 ? "note" : "notes";
          notify(`#${tagTitle} is already on ${ok.length} ${noun}${skips}`);
        }
      } else if (conflicts.length > 0 && errors.length === 0) {
        toast.warning(`No notes tagged, ${conflicts.length} skipped: changed elsewhere`);
      } else {
        toast.error(`Could not tag notes${skips}`, { description: errors[0]?.error });
      }
    } catch (err) {
      toast.error("Could not tag notes", { description: err instanceof Error ? err.message : undefined });
    } finally {
      setBulkProgress(null);
    }
  };

  const handleBulkTrash = async (targetNotes: NoteListItem[]) => {
    try {
      const results = await bulkUpdate.mutateAsync({
        items: targetNotes.map((n) => ({ id: n.id, baseUpdatedTime: n.updatedTime })),
        trash: true,
        onProgress: setBulkProgress,
      });
      const { ok, conflicts, errors } = summarizeBulkResults(results);
      const skips = formatBulkSkips(conflicts.length, errors.length);
      if (ok.length > 0) {
        selection.exitSelectionMode();
        if (selectedNoteId && ok.some((r) => r.id === selectedNoteId)) {
          handleNoteRemoved();
        }
        const undoItems: BatchNoteItem[] = ok.map((r) => ({
          id: r.id,
          ...(r.updatedTime !== undefined ? { baseUpdatedTime: r.updatedTime } : {}),
        }));
        const noun = ok.length === 1 ? "note" : "notes";
        const notify = conflicts.length > 0 || errors.length > 0 ? toast.warning : toast.success;
        notify(`Moved ${ok.length} ${noun} to trash${skips}`, {
          action: {
            label: "Undo",
            onClick: () =>
              void runUndoBatch(
                { items: undoItems, restore: true },
                (count, n) => `Restored ${count} ${n} from trash`
              ),
          },
        });
      } else if (conflicts.length > 0 && errors.length === 0) {
        toast.warning(`No notes moved to trash, ${conflicts.length} skipped: changed elsewhere`);
      } else {
        toast.error(`Could not move notes to trash${skips}`, { description: errors[0]?.error });
      }
    } catch (err) {
      toast.error("Could not move notes to trash", { description: err instanceof Error ? err.message : undefined });
    } finally {
      setBulkProgress(null);
    }
  };

  const handleStartOrganize = async (excludeNotebookIds: string[]) => {
    if (!organizeTargets || organizeTargets.notes.length === 0) return;
    setOrganizeConflict(null);
    try {
      const { jobId } = await createOrganizeJob.mutateAsync({
        noteIds: organizeTargets.notes.map((n) => n.id),
        excludeNotebookIds,
      });
      setOrganizeTargets(null);
      setOrganizeConflict(null);
      selection.exitSelectionMode();
      navigate(`/organize/${jobId}`);
    } catch (err) {
      const runningJobId = getOrganizeRunningJobId(err);
      if (runningJobId) {
        setOrganizeConflict({
          runningJobId,
          message: err instanceof Error ? err.message : "Another Auto-organize job is currently running.",
        });
        void refetchOrganizeJobs();
        return;
      }
      toast.error("Could not start Auto-organize", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const handleCancelAndStartOrganize = async (runningJobId: string, excludeNotebookIds: string[]) => {
    if (!organizeTargets || organizeTargets.notes.length === 0) return;
    try {
      await cancelOrganizeJob.mutateAsync(runningJobId);
      setOrganizeConflict(null);
      await handleStartOrganize(excludeNotebookIds);
    } catch (err) {
      toast.error("Could not replace running Auto-organize job", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const organizeJobs = organizeJobsData?.jobs ?? [];
  const runningOrganizeJob = organizeJobs.find((j) => j.status === "running") ?? null;

  const canAutoOrganize = Boolean(
    organizeStatus?.enabled && !readOnly && !isTrashSelected && !isConflictsSelected
  );

  const openNoteSummary = useMemo(() => {
    if (!selectedNoteId) return undefined;
    return notes?.find((n) => n.id === selectedNoteId) ?? searchResults?.find((n) => n.id === selectedNoteId);
  }, [selectedNoteId, notes, searchResults]);
  const openNoteNotebookId =
    selectedNoteId && !isTrashSelected && !isConflictsSelected
      ? fullNote && !fullNote.deletedTime && !fullNote.isConflict
        ? fullNote.notebookId
        : openNoteSummary && !openNoteSummary.deletedTime && !openNoteSummary.isConflict
        ? openNoteSummary.notebookId ?? openNoteSummary.parentId ?? null
        : null
      : null;

  const emptyState = isTrashSelected
    ? trashedNotebooks?.length
      ? { title: "No notes in the trash", description: undefined }
      : { title: "Trash is empty", description: "Deleted notes and notebooks appear here." }
    : isConflictsSelected
    ? { title: "No conflicts", description: "Copies Joplin keeps after a sync conflict appear here." }
    : selectedTagId
    ? { title: "No notes with this tag", description: "Add the tag to a note to see it here." }
    : selectedNotebookId
    ? { title: "This notebook is empty", description: "Create a note to get started." }
    : { title: "No notes yet", description: "Create your first note to get started." };

  return (
    <AppLayout
      notebookTitle={notebookTitle}
      notebookPath={notebookPath}
      noteTitle={noteTitle}
      onSelectNotebook={handleSelectNotebook}
      defaultAiNotebookId={selectedNotebookId}
      defaultAiTagId={selectedTagId}
      isSearchActive={isSearchActive}
      searchQuery={searchQuery}
      onSearchChange={handleSearchChange}
      readOnly={readOnly}
      readOnlyReason={readOnlyReason}
      sidebar={({ onCloseMobile, aiEnabled, onOpenAskAi }) => (
        <Sidebar
          selectedNotebookId={selectedNotebookId}
          openNoteNotebookId={openNoteNotebookId}
          selectedTagId={selectedTagId}
          activeView={isTrashSelected ? "trash" : isConflictsSelected ? "conflicts" : "notes"}
          isAllNotesSelected={!selectedNotebookId && !selectedTagId && !isTrashSelected && !isConflictsSelected}
          isTrashSelected={isTrashSelected}
          isConflictsSelected={isConflictsSelected}
          conflictCount={conflictNotesQuery.data?.length ?? 0}
          organizeJobCount={organizeJobs.length}
          runningOrganizeJob={Boolean(runningOrganizeJob)}
          aiEnabled={aiEnabled}
          onOpenAskAi={onOpenAskAi}
          onSelectConflicts={() => {
            handleSelectConflicts();
            onCloseMobile?.();
          }}
          onSelectOrganize={() => {
            setSearchQuery("");
            navigate("/organize");
            onCloseMobile?.();
          }}
          onSelectAllNotes={() => {
            handleSelectAllNotes();
            onCloseMobile?.();
          }}
          onSelectTrash={() => {
            handleSelectTrash();
            onCloseMobile?.();
          }}
          onSelectNotebook={(id) => {
            handleSelectNotebook(id);
            onCloseMobile?.();
          }}
          onSelectTag={(id) => {
            handleSelectTag(id);
            onCloseMobile?.();
          }}
          onOpenNote={(id) => {
            handleSearchChange("");
            navigate(`/notes/${id}`);
          }}
          onApplySavedSearch={(savedQuery) => {
            setSearchQuery(savedQuery);
            if (!pathname.startsWith("/notes")) {
              navigate(`/notes?q=${encodeURIComponent(savedQuery)}`);
            }
          }}
          searchQuery={searchQuery}
          onSearchChange={handleSearchChange}
          onCloseMobile={onCloseMobile}
          readOnly={readOnly}
        />
      )}
    >
      <div className="flex h-full w-full overflow-hidden">
        {/* Middle Column: Note List or Search Results */}
        <div
          className={`h-full w-full md:w-80 lg:w-96 shrink-0 ${
            selectedNoteId ? "hidden md:flex flex-col" : "flex flex-col"
          }`}
        >
          {isSearchActive ? (
            <SearchResults
              query={debouncedQuery}
              results={searchResults || []}
              isLoading={isLoadingSearch}
              error={searchQueryResult.error}
              onRetry={() => void searchQueryResult.refetch()}
              isRetrying={searchQueryResult.isFetching}
              selectedNoteId={selectedNoteId}
              onSelectNote={handleSelectNote}
              onClearQuery={() => handleSearchChange("")}
              onSaveSearch={
                readOnly
                  ? undefined
                  : async (name, queryText) => {
                      try {
                        await createSavedSearch.mutateAsync({ name, query: queryText });
                        toast.success(`Saved search "${name}"`);
                      } catch (err) {
                        toast.error("Could not save search", {
                          description: err instanceof Error ? err.message : undefined,
                        });
                      }
                    }
              }
              isSavingSearch={createSavedSearch.isPending}
            />
          ) : (
            <NoteList
              key={listKey}
              notes={notes || []}
              notebooks={notebooks}
              tags={tags}
              favoriteNoteIds={favoriteNoteIds}
              selection={selection}
              canSelect={!readOnly && !isTrashSelected}
              canBulkTag={!isConflictsSelected}
              canAutoOrganize={canAutoOrganize}
              onBulkMove={handleBulkMove}
              onBulkAddTag={handleBulkAddTag}
              onBulkTrash={handleBulkTrash}
              onAutoOrganize={(selected, defaultExcludedNotebookId) =>
                setOrganizeTargets({ notes: selected, defaultExcludedNotebookId })
              }
              isBulkPending={bulkUpdate.isPending}
              bulkProgress={bulkProgress}
              isLoading={isLoadingNotes}
              // Keep showing a list that loaded before; only a list that never loaded is an error
              error={notes ? null : notesQuery.error}
              isStale={Boolean(notes && notesQuery.isError)}
              onRetry={() => void notesQuery.refetch()}
              isRetrying={notesQuery.isFetching}
              emptyTitle={emptyState.title}
              emptyDescription={emptyState.description}
              selectedNoteId={selectedNoteId}
              onSelectNote={handleSelectNote}
              // Replace, so Back goes straight to the previous list and note
              onOpenFirst={isSideBySide ? (id) => navigate(scopeUrl(scope, id), { replace: true }) : undefined}
              title={notebookTitle || "All Notes"}
              onCreateNote={
                isTrashSelected || isConflictsSelected || readOnly || currentNotebook?.encrypted ? undefined : handleCreateNote
              }
              isCreating={createNote.isPending}
              onToggleTodo={isTrashSelected || isConflictsSelected || readOnly ? undefined : handleToggleTodo}
              renderLeading={
                isTrashSelected
                  ? (filter) => (
                      <TrashedNotebooks filterText={filter} notesHeading={(notes?.length ?? 0) > 0} readOnly={readOnly} />
                    )
                  : undefined
              }
              subtitle={
                isTrashSelected
                  ? "Deleted notes and notebooks"
                  : isConflictsSelected
                  ? "Copies kept after sync conflicts"
                  : selectedTagId
                  ? "Notes with tag"
                  : selectedNotebookId
                  ? "Notebook notes"
                  : "Every note in your collection"
              }
            />
          )}
        </div>

        {/* Right Column: Full Note Viewer */}
        <div
          className={`flex-1 h-full min-w-0 ${
            !selectedNoteId ? "hidden md:flex flex-col" : "flex flex-col"
          }`}
        >
          <NoteViewer
            key={selectedNoteId ?? "none"}
            note={selectedNoteId ? fullNote : null}
            notebooks={notebooks}
            readOnly={readOnly}
            startInEdit={editIntentNoteId !== null && editIntentNoteId === selectedNoteId}
            onRemoved={handleNoteRemoved}
            isLoading={isLoadingNote}
            // A note that loaded before stays on screen (and in an open editor) when a refetch fails
            error={fullNote ? null : noteError}
            isStale={Boolean(fullNote && noteQuery.isError)}
            onRetry={() => void noteQuery.refetch()}
            isRetrying={noteQuery.isFetching}
            onTagClick={handleSelectTag}
            onNotebookClick={handleSelectNotebook}
            onOpenNote={(id) => navigate(scopeUrl({ kind: "all" }, id))}
            onClose={handleCloseNoteViewer}
          />
        </div>
      </div>
      <StartOrganizeDialog
        open={Boolean(organizeTargets)}
        onOpenChange={(open) => {
          if (!open && !createOrganizeJob.isPending && !cancelOrganizeJob.isPending) {
            setOrganizeTargets(null);
            setOrganizeConflict(null);
          }
        }}
        selectedCount={organizeTargets?.notes.length ?? 0}
        notebooks={notebooks ?? []}
        defaultExcludedNotebookId={organizeTargets?.defaultExcludedNotebookId ?? null}
        isPending={createOrganizeJob.isPending || cancelOrganizeJob.isPending}
        previousJobsCount={organizeJobs.length}
        onViewJobs={() => {
          setOrganizeTargets(null);
          setOrganizeConflict(null);
          selection.exitSelectionMode();
          navigate("/organize");
        }}
        runningJob={runningOrganizeJob}
        conflictRunningJobId={organizeConflict?.runningJobId ?? null}
        conflictMessage={organizeConflict?.message ?? null}
        onViewRunningJob={(runningJobId) => {
          setOrganizeTargets(null);
          setOrganizeConflict(null);
          selection.exitSelectionMode();
          navigate(`/organize/${runningJobId}`);
        }}
        onCancelAndStart={(runningJobId, excludeIds) => void handleCancelAndStartOrganize(runningJobId, excludeIds)}
        onConfirm={(excludeIds) => void handleStartOrganize(excludeIds)}
      />
    </AppLayout>
  );
}
