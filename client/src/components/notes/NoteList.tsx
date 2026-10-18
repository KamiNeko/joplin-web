import { useState, useMemo } from "react";
import { NoteListItem as NoteListItemType } from "@/lib/types";
import { NoteListItem } from "./NoteListItem";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowDownUp, CheckSquare, FileQuestion, FileText, Loader2, Plus, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { QueryError, StaleDataHint } from "@/components/common/QueryError";

interface NoteListProps {
  notes?: NoteListItemType[];
  isLoading?: boolean;
  /** Set when the list failed to load; shows an error with Retry instead of an empty list */
  error?: Error | null;
  /** A refetch failed while the earlier list is still shown */
  isStale?: boolean;
  onRetry?: () => void;
  isRetrying?: boolean;
  selectedNoteId?: string | null;
  onSelectNote: (id: string) => void;
  title?: string;
  subtitle?: string;
  /** Empty-state text for this list (e.g. "Trash is empty") */
  emptyTitle?: string;
  emptyDescription?: string;
  /** Shows the "New" menu when provided */
  onCreateNote?: (isTodo: boolean) => void;
  isCreating?: boolean;
  onToggleTodo?: (id: string, completed: boolean) => void;
  /** Content above the notes (e.g. trashed notebooks), given the current filter text */
  renderLeading?: (filterText: string) => React.ReactNode;
}

type SortField = "updated" | "created" | "title";
type SortOrder = "asc" | "desc";

const SORT_FIELD_LABELS: Record<SortField, string> = {
  updated: "Updated date",
  created: "Created date",
  title: "Title",
};

const SORT_STORAGE_KEY = "joplin-note-sort";

interface SortChoice {
  field: SortField;
  order: SortOrder;
}

/** The remembered sort, so it survives switching lists (the list remounts) and reloads */
function loadSort(): SortChoice {
  try {
    const stored = JSON.parse(localStorage.getItem(SORT_STORAGE_KEY) ?? "null");
    if (
      stored &&
      (stored.field === "updated" || stored.field === "created" || stored.field === "title") &&
      (stored.order === "asc" || stored.order === "desc")
    ) {
      return stored;
    }
  } catch {
    // storage unavailable or invalid
  }
  return { field: "updated", order: "desc" };
}

function saveSort(sort: SortChoice) {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sort));
  } catch {
    // storage unavailable
  }
}

/** Direction labels that fit the field: A-Z for titles, newest/oldest for dates */
function orderLabel(field: SortField, order: SortOrder): string {
  if (field === "title") return order === "asc" ? "A–Z" : "Z–A";
  return order === "desc" ? "Newest first" : "Oldest first";
}

/**
 * Middle column: the notes of the selected notebook, tag, trash or all notes, with a local
 * filter and sort. Remount it (via `key`) when the list changes so the filter doesn't carry over;
 * the sort choice is remembered in localStorage and stays.
 */
export function NoteList({
  notes = [],
  isLoading = false,
  error = null,
  isStale = false,
  onRetry,
  isRetrying = false,
  selectedNoteId,
  onSelectNote,
  title = "Notes",
  subtitle,
  emptyTitle = "No notes yet",
  emptyDescription,
  onCreateNote,
  isCreating = false,
  onToggleTodo,
  renderLeading,
}: NoteListProps) {
  const [filterText, setFilterText] = useState("");
  const [sort, setSort] = useState<SortChoice>(loadSort);
  const { field: sortField, order: sortOrder } = sort;

  const updateSort = (next: SortChoice) => {
    setSort(next);
    saveSort(next);
  };

  const filteredAndSortedNotes = useMemo(() => {
    let result = [...notes];

    if (filterText.trim()) {
      const q = filterText.toLowerCase();
      result = result.filter(
        (n) =>
          n.title.toLowerCase().includes(q) ||
          (n.preview && n.preview.toLowerCase().includes(q))
      );
    }

    result.sort((a, b) => {
      if (sortField === "title") {
        const comp = a.title.localeCompare(b.title);
        return sortOrder === "asc" ? comp : -comp;
      }
      const timeA = (sortField === "created" ? a.createdTime : a.updatedTime) || 0;
      const timeB = (sortField === "created" ? b.createdTime : b.updatedTime) || 0;
      return sortOrder === "asc" ? timeA - timeB : timeB - timeA;
    });

    return result;
  }, [notes, filterText, sortField, sortOrder]);

  const changeSortField = (field: SortField) => {
    if (field === sortField) return;
    // Titles read naturally A-Z, dates newest first
    updateSort({ field, order: field === "title" ? "asc" : "desc" });
  };

  const sortDescription = `${SORT_FIELD_LABELS[sortField]}, ${orderLabel(sortField, sortOrder)}`;
  const isFiltering = filterText.trim().length > 0;

  return (
    <div className="flex flex-col h-full bg-background border-r border-border/50">
      {/* Top bar with Title & Sort */}
      <div className="p-3.5 border-b border-border/40 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-foreground truncate">{title}</h2>
            {subtitle && (
              <p className="text-xs text-muted-foreground truncate">{subtitle}</p>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {!isLoading && !error && (
              <span className="text-xs text-muted-foreground font-mono">
                {filteredAndSortedNotes.length} {filteredAndSortedNotes.length === 1 ? "note" : "notes"}
              </span>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  aria-label={`Sort notes (${sortDescription})`}
                  title={`Sorted by ${sortDescription}`}
                >
                  <ArrowDownUp className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44 text-xs">
                <DropdownMenuLabel className="text-xs text-muted-foreground font-medium">Sort by</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={sortField} onValueChange={(v) => changeSortField(v as SortField)}>
                  {(Object.keys(SORT_FIELD_LABELS) as SortField[]).map((field) => (
                    <DropdownMenuRadioItem key={field} value={field}>
                      {SORT_FIELD_LABELS[field]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup value={sortOrder} onValueChange={(v) => updateSort({ field: sortField, order: v as SortOrder })}>
                  {(sortField === "title" ? (["asc", "desc"] as const) : (["desc", "asc"] as const)).map((order) => (
                    <DropdownMenuRadioItem key={order} value={order}>
                      {orderLabel(sortField, order)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            {onCreateNote && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" className="h-7 gap-1 px-2.5" disabled={isCreating} aria-label="Create new note">
                    {isCreating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                    New
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuItem onClick={() => onCreateNote(false)}>
                    <FileText className="h-4 w-4" />
                    Note
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onCreateNote(true)}>
                    <CheckSquare className="h-4 w-4" />
                    To-do
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>

        {/* Filter input (only narrows this list; the header search covers all notes) */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Filter this list..."
            aria-label="Filter this list"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && filterText) {
                e.stopPropagation();
                setFilterText("");
              }
            }}
            className="h-8 pl-8 text-xs bg-muted/40 border-border/40 focus-visible:ring-primary/70"
          />
        </div>
      </div>

      {/* Content Area */}
      <ScrollArea className="flex-1 p-3">
        {isStale && !isLoading && !error && (
          <StaleDataHint className="px-1 pb-2" onRetry={onRetry} isRetrying={isRetrying} />
        )}
        {renderLeading?.(filterText)}
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="p-3.5 rounded-xl border border-border/40 bg-card/20 space-y-2.5"
              >
                <div className="flex justify-between items-center">
                  <Skeleton className="h-4 w-3/5" />
                  <Skeleton className="h-3 w-12" />
                </div>
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            ))}
          </div>
        ) : error ? (
          <QueryError message="Couldn't load notes" error={error} onRetry={onRetry} isRetrying={isRetrying} />
        ) : filteredAndSortedNotes.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-center px-4">
            <div className="h-12 w-12 rounded-full bg-muted/50 flex items-center justify-center text-muted-foreground mb-3">
              <FileQuestion className="h-6 w-6" />
            </div>
            <h4 className="text-sm font-semibold text-foreground">{isFiltering ? "No matches" : emptyTitle}</h4>
            {(isFiltering || emptyDescription) && (
              <p className="text-xs text-muted-foreground mt-1 max-w-[220px] wrap-break-word">
                {isFiltering ? `No notes in this list match "${filterText.trim()}".` : emptyDescription}
              </p>
            )}
            {isFiltering ? (
              <Button variant="outline" size="sm" className="h-8 mt-3" onClick={() => setFilterText("")}>
                Clear filter
              </Button>
            ) : (
              onCreateNote && (
                <Button size="sm" className="h-8 mt-3 gap-1" onClick={() => onCreateNote(false)} disabled={isCreating}>
                  {isCreating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  New note
                </Button>
              )
            )}
          </div>
        ) : (
          <div className="space-y-2 pb-6">
            {filteredAndSortedNotes.map((note) => (
              <NoteListItem
                key={note.id}
                note={note}
                isActive={selectedNoteId === note.id}
                onClick={() => onSelectNote(note.id)}
                onToggleTodo={onToggleTodo ? () => onToggleTodo(note.id, !note.todoCompleted) : undefined}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
