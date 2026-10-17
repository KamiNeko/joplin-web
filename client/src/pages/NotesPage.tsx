import { useState, useMemo, useEffect, useRef } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
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

export function NotesPage() {
  const params = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Route parameters can come from /notes/:id, /notebooks/:notebookId, etc.
  // On /notebooks/:id the id is a notebook; on /notebooks/:notebookId/notes/:id it is a note
  const routeNoteId =
    params.id && (params.notebookId || !window.location.pathname.startsWith("/notebooks/")) ? params.id : undefined;
  const routeNotebookId = params.notebookId || (window.location.pathname.startsWith("/notebooks/") ? params.id : undefined);
  const tagParam = searchParams.get("tag") || undefined;
  const isTrashRoute = window.location.pathname.startsWith("/trash");

  const [isTrashSelected, setIsTrashSelected] = useState<boolean>(isTrashRoute);
  const [selectedNotebookId, setSelectedNotebookId] = useState<string | null>(routeNotebookId || null);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(tagParam || null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(routeNoteId || null);
  const [searchQuery, setSearchQuery] = useState<string>("");
  // Note that should open in the editor (set right after creating it)
  const [editIntentNoteId, setEditIntentNoteId] = useState<string | null>(null);
  const createNote = useCreateNote();
  const updateNote = useUpdateNote();

  // Sync internal state when URL parameters change
  useEffect(() => {
    setIsTrashSelected(window.location.pathname.startsWith("/trash"));
  }, [params]);

  useEffect(() => {
    if (routeNoteId) {
      setSelectedNoteId(routeNoteId);
    }
  }, [routeNoteId]);

  useEffect(() => {
    if (routeNotebookId) {
      setSelectedNotebookId(routeNotebookId);
      setSelectedTagId(null);
      setIsTrashSelected(false);
    }
  }, [routeNotebookId]);

  useEffect(() => {
    if (tagParam) {
      setSelectedTagId(tagParam);
      setSelectedNotebookId(null);
      setIsTrashSelected(false);
    }
  }, [tagParam]);

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

  // When the page is opened on a note URL, show that note's notebook in the list (first load only,
  // so picking a note from "All Notes" or the trash doesn't switch the list)
  const openedViaNoteUrl = useRef(Boolean(routeNoteId) && !isTrashRoute);
  useEffect(() => {
    if (!openedViaNoteUrl.current || !fullNote) return;
    openedViaNoteUrl.current = false;
    if (!selectedNotebookId && !selectedTagId && !fullNote.deletedTime) {
      setSelectedNotebookId(fullNote.notebookId);
    }
  }, [fullNote, selectedNotebookId, selectedTagId]);

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

  // Handlers
  const handleSelectNotebook = (id: string) => {
    setSelectedNotebookId(id);
    setSelectedTagId(null);
    setIsTrashSelected(false);
    setSearchQuery("");
    navigate(`/notebooks/${id}`);
  };

  const handleSelectTag = (tagId: string) => {
    setSelectedTagId(tagId);
    setSelectedNotebookId(null);
    setIsTrashSelected(false);
    setSearchQuery("");
    setSearchParams({ tag: tagId });
  };

  const handleSelectAllNotes = () => {
    setSelectedNotebookId(null);
    setSelectedTagId(null);
    setIsTrashSelected(false);
    setSearchQuery("");
    navigate("/notes");
  };

  const handleSelectTrash = () => {
    setSelectedNotebookId(null);
    setSelectedTagId(null);
    setIsTrashSelected(true);
    setSearchQuery("");
    navigate("/trash");
  };

  const handleSelectNote = (id: string) => {
    setSelectedNoteId(id);
    setEditIntentNoteId(null);
    if (isTrashSelected) {
      navigate(`/trash/${id}`);
    } else {
      navigate(`/notes/${id}`);
    }
  };

  const handleCloseNoteViewer = () => {
    setSelectedNoteId(null);
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
          setSelectedNoteId(note.id);
          navigate(`/notes/${note.id}`);
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

  const handleNoteRemoved = () => {
    setSelectedNoteId(null);
    setEditIntentNoteId(null);
    if (isTrashSelected) navigate("/trash");
    else if (selectedNotebookId) navigate(`/notebooks/${selectedNotebookId}`);
    else navigate("/notes");
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
