import { useState, useMemo, useEffect, useRef } from "react";
import { useLocation, useParams, useNavigate, useSearchParams } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { Sidebar } from "@/components/layout/Sidebar";
import { NoteList } from "@/components/notes/NoteList";
import { NoteViewer } from "@/components/notes/NoteViewer";
import { SearchResults } from "@/components/search/SearchResults";
import { useNotebooks } from "@/hooks/use-notebooks";
import { useTags } from "@/hooks/use-tags";
import { useNotes, useNote } from "@/hooks/use-notes";
import { useSearch } from "@/hooks/use-search";
import { useCreateNote, useUpdateNote } from "@/hooks/use-mutations";
import { findNotebookById, flattenNotebooks } from "@/lib/notebooks";
import { toast } from "sonner";

/** The list shown in the middle column: everything, one notebook, one tag or the trash */
type ListScope =
  | { kind: "all" }
  | { kind: "notebook"; notebookId: string }
  | { kind: "tag"; tagId: string }
  | { kind: "trash" };

/** URL of a list, optionally with a note open in it */
function scopeUrl(scope: ListScope, noteId?: string | null): string {
  const note = noteId ? `/${noteId}` : "";
  switch (scope.kind) {
    case "trash":
      return `/trash${note}`;
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
 * `/notes[/:noteId][?tag=:tagId]`, `/notebooks/:notebookId[/notes/:noteId]`, `/trash[/:noteId]`.
 */
export function NotesPage() {
  const params = useParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const isTrashSelected = pathname.startsWith("/trash");
  const isNotebookRoute = pathname.startsWith("/notebooks/");
  // On /notebooks/:id the id is a notebook; on /notebooks/:notebookId/notes/:id it is a note
  const selectedNotebookId = isNotebookRoute ? params.notebookId ?? params.id ?? null : null;
  const selectedNoteId = (isNotebookRoute ? (params.notebookId ? params.id : undefined) : params.id) ?? null;
  // A tag filter only applies to the /notes routes, so it never combines with a notebook or the trash
  const selectedTagId = !isTrashSelected && !isNotebookRoute ? searchParams.get("tag") || null : null;

  const scope: ListScope = isTrashSelected
    ? { kind: "trash" }
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

  // TanStack queries
  const { data: notebooks } = useNotebooks();
  const { data: tags } = useTags();
  const { data: notes, isLoading: isLoadingNotes } = useNotes(
    selectedNotebookId || undefined,
    selectedTagId || undefined,
    isTrashSelected
  );
  const {
    data: fullNote,
    isLoading: isLoadingNote,
    error: noteError,
  } = useNote(selectedNoteId);
  const {
    data: searchResults,
    isLoading: isLoadingSearch,
    debouncedQuery,
  } = useSearch(searchQuery);

  // When the page is opened on a plain /notes/:id URL, show that note's notebook in the list
  // (first load only, so picking a note from "All Notes" doesn't switch the list)
  const openedViaNoteUrl = useRef(scope.kind === "all" && Boolean(selectedNoteId));
  useEffect(() => {
    if (!openedViaNoteUrl.current || !fullNote) return;
    openedViaNoteUrl.current = false;
    if (scope.kind === "all" && fullNote.id === selectedNoteId && !fullNote.deletedTime) {
      navigate(scopeUrl({ kind: "notebook", notebookId: fullNote.notebookId }, fullNote.id), { replace: true });
    }
  }, [fullNote, scope.kind, selectedNoteId, navigate]);

  // Notebook title lookup
  const currentNotebook = useMemo(
    () => findNotebookById(notebooks, selectedNotebookId),
    [notebooks, selectedNotebookId]
  );

  const notebookTitle = useMemo(() => {
    if (isTrashSelected) return "Trash";
    if (selectedTagId) return `#${tags?.find((t) => t.id === selectedTagId)?.title ?? "Tag"}`;
    if (currentNotebook) return currentNotebook.title;
    return undefined;
  }, [currentNotebook, selectedTagId, isTrashSelected, tags]);

  const noteTitle = fullNote ? fullNote.title || "Untitled Note" : undefined;

  // Handlers only navigate; the selection follows from the URL
  const showList = (next: ListScope) => {
    setSearchQuery("");
    // Side by side (md and up) the open note stays open; on phones the list replaces it
    const keepNote = next.kind !== "trash" && window.matchMedia?.("(min-width: 768px)").matches;
    navigate(scopeUrl(next, keepNote ? selectedNoteId : null));
  };

  const handleSelectNotebook = (id: string) => showList({ kind: "notebook", notebookId: id });
  const handleSelectTag = (tagId: string) => showList({ kind: "tag", tagId });
  const handleSelectAllNotes = () => showList({ kind: "all" });
  const handleSelectTrash = () => showList({ kind: "trash" });

  const handleSelectNote = (id: string) => {
    setEditIntentNoteId(null);
    if (id !== selectedNoteId) navigate(scopeUrl(scope, id));
  };

  const handleCloseNoteViewer = () => {
    setEditIntentNoteId(null);
    navigate(scopeUrl(scope));
  };

  // New notes go into the selected notebook, else the open note's notebook, else the first notebook
  const targetNotebookId = useMemo(() => {
    if (selectedNotebookId && findNotebookById(notebooks, selectedNotebookId)) return selectedNotebookId;
    if (fullNote?.notebookId && findNotebookById(notebooks, fullNote.notebookId)) return fullNote.notebookId;
    return flattenNotebooks(notebooks)[0]?.id ?? null;
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

  return (
    <AppLayout
      notebookTitle={notebookTitle}
      noteTitle={noteTitle}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      sidebar={({ onCloseMobile }) => (
        <Sidebar
          selectedNotebookId={selectedNotebookId}
          selectedTagId={selectedTagId}
          isAllNotesSelected={!selectedNotebookId && !selectedTagId && !isTrashSelected && !searchQuery}
          isTrashSelected={isTrashSelected}
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
              selectedNoteId={selectedNoteId}
              onSelectNote={handleSelectNote}
              onClearQuery={() => setSearchQuery("")}
            />
          ) : (
            <NoteList
              notes={notes || []}
              isLoading={isLoadingNotes}
              selectedNoteId={selectedNoteId}
              onSelectNote={handleSelectNote}
              title={notebookTitle || "All Notes"}
              onCreateNote={isTrashSelected ? undefined : handleCreateNote}
              isCreating={createNote.isPending}
              onToggleTodo={isTrashSelected ? undefined : handleToggleTodo}
              subtitle={
                isTrashSelected
                  ? "Deleted notes and notebooks"
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
            startInEdit={editIntentNoteId !== null && editIntentNoteId === selectedNoteId}
            onRemoved={handleNoteRemoved}
            isLoading={isLoadingNote}
            error={noteError}
            onTagClick={handleSelectTag}
            onNotebookClick={handleSelectNotebook}
            onClose={handleCloseNoteViewer}
          />
        </div>
      </div>
    </AppLayout>
  );
}
