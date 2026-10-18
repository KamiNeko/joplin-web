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
import { useCreateNote, useUpdateNote } from "@/hooks/use-mutations";
import { findNotebookById, flattenNotebooks } from "@/lib/notebooks";
import { toast } from "sonner";
import { noteDisplayTitle } from "@/lib/format";
import { useWriteState } from "@/hooks/use-write-state";

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
  const [searchParams] = useSearchParams();

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

  const [searchQuery, setSearchQuery] = useState<string>("");
  // Note that should open in the editor (set right after creating it)
  const [editIntentNoteId, setEditIntentNoteId] = useState<string | null>(null);
  const createNote = useCreateNote();
  const updateNote = useUpdateNote();
  // An account with end-to-end encryption is read-only: no editing, creating, tagging or uploads
  const { readOnly, reason: readOnlyReason } = useWriteState();

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

  const noteTitle = fullNote ? noteDisplayTitle(fullNote) : undefined;

  // Handlers only navigate; the selection follows from the URL
  const showList = (next: ListScope) => {
    setSearchQuery("");
    // Side by side (md and up) the open note stays open; on phones the list replaces it
    const keepNote =
      next.kind !== "trash" && next.kind !== "conflicts" && window.matchMedia?.("(min-width: 768px)").matches;
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

  const isSearchActive = debouncedQuery.length >= 2;
  // Remount the list per scope so its filter doesn't carry over to another notebook or tag
  // (the sort choice is stored separately and stays)
  const listKey =
    selectedNotebookId ??
    (selectedTagId ? `tag:${selectedTagId}` : isTrashSelected ? "trash" : isConflictsSelected ? "conflicts" : "all");

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
      noteTitle={noteTitle}
      isSearchActive={isSearchActive}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      readOnly={readOnly}
      readOnlyReason={readOnlyReason}
      sidebar={({ onCloseMobile }) => (
        <Sidebar
          selectedNotebookId={selectedNotebookId}
          selectedTagId={selectedTagId}
          isAllNotesSelected={!selectedNotebookId && !selectedTagId && !isTrashSelected && !isConflictsSelected}
          isTrashSelected={isTrashSelected}
          isConflictsSelected={isConflictsSelected}
          conflictCount={conflictNotesQuery.data?.length ?? 0}
          onSelectConflicts={() => {
            handleSelectConflicts();
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
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
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
              onClearQuery={() => setSearchQuery("")}
            />
          ) : (
            <NoteList
              key={listKey}
              notes={notes || []}
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
    </AppLayout>
  );
}
