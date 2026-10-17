import { useState, useMemo, useEffect } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { Sidebar } from "@/components/layout/Sidebar";
import { NoteList } from "@/components/notes/NoteList";
import { NoteViewer } from "@/components/notes/NoteViewer";
import { SearchResults } from "@/components/search/SearchResults";
import { useNotebooks } from "@/hooks/use-notebooks";
import { useNotes, useNote } from "@/hooks/use-notes";
import { useSearch } from "@/hooks/use-search";
import { Notebook } from "@/lib/types";

/**
 * Recursively locates a notebook by ID in the tree.
 */
function findNotebookById(notebooks: Notebook[] | undefined, id: string | null): Notebook | null {
  if (!notebooks || !id) return null;
  for (const nb of notebooks) {
    if (nb.id === id) return nb;
    if (nb.children && nb.children.length > 0) {
      const found = findNotebookById(nb.children, id);
      if (found) return found;
    }
  }
  return null;
}

export function NotesPage() {
  const params = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Route parameters can come from /notes/:id, /notebooks/:notebookId, etc.
  const routeNoteId = params.id && !window.location.pathname.startsWith("/notebooks/") ? params.id : undefined;
  const routeNotebookId = params.notebookId || (window.location.pathname.startsWith("/notebooks/") ? params.id : undefined);
  const tagParam = searchParams.get("tag") || undefined;
  const isTrashRoute = window.location.pathname.startsWith("/trash");

  const [isTrashSelected, setIsTrashSelected] = useState<boolean>(isTrashRoute);
  const [selectedNotebookId, setSelectedNotebookId] = useState<string | null>(routeNotebookId || null);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(tagParam || null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(routeNoteId || null);
  const [searchQuery, setSearchQuery] = useState<string>("");

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

  // If viewing a note directly, ensure selectedNotebookId matches note's notebook
  useEffect(() => {
    if (fullNote && !selectedNotebookId && !selectedTagId) {
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
    if (selectedTagId) return `Tag #${selectedTagId}`;
    if (currentNotebook) return currentNotebook.title;
    return undefined;
  }, [currentNotebook, selectedTagId, isTrashSelected]);

  const noteTitle = fullNote?.title || undefined;

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
    if (isTrashSelected) {
      navigate(`/trash/${id}`);
    } else {
      navigate(`/notes/${id}`);
    }
  };

  const handleCloseNoteViewer = () => {
    setSelectedNoteId(null);
  };

  const isSearchActive = debouncedQuery.length >= 2;

  return (
    <AppLayout
      notebookTitle={notebookTitle}
      noteTitle={noteTitle}
      onOpenSearch={() => {
        // Focus search input or trigger search mode
        const input = document.querySelector<HTMLInputElement>("input[placeholder*='Search notes']");
        input?.focus();
      }}
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
            note={fullNote}
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
