import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NoteListItem as NoteListItemType, Notebook } from "@/lib/types";
import { NoteListItem } from "./NoteListItem";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowDownUp,
  CheckSquare,
  FileQuestion,
  FileText,
  FolderInput,
  ListChecks,
  Loader2,
  Plus,
  Search,
  Sparkles,
  Tag as TagIcon,
  Trash2,
} from "lucide-react";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { QueryError, StaleDataHint } from "@/components/common/QueryError";
import { NotebookPicker } from "@/components/notebooks/NotebookPicker";
import { TagAutocompleteInput } from "@/components/tags/TagAutocompleteInput";
import { NoteSelection, SelectionModifiers, useNoteSelection } from "@/hooks/use-note-selection";
import { BulkUpdateProgress } from "@/hooks/use-mutations";

export const NOTE_LIST_PAGE_SIZE = 100;

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
  /** Notebooks shown in the bulk "Move to…" picker */
  notebooks?: Notebook[];
  /** Multi-selection controller owned by NotesPage (falls back to local state when omitted) */
  selection?: NoteSelection;
  /** Enables selection mode toggle in the header (disabled in Trash / read-only) */
  canSelect?: boolean;
  /** Enables "Add tag…" in the bulk bar (disabled on Conflicts where tags are read-only) */
  canBulkTag?: boolean;
  /** Enables "Auto-organize" in the bulk bar when server AI config is enabled */
  canAutoOrganize?: boolean;
  onBulkMove?: (notes: NoteListItemType[], notebookId: string, notebookTitle: string) => void;
  onBulkAddTag?: (notes: NoteListItemType[], tagTitle: string) => void;
  onBulkTrash?: (notes: NoteListItemType[]) => void;
  onAutoOrganize?: (notes: NoteListItemType[], defaultExcludedNotebookId: string | null) => void;
  isBulkPending?: boolean;
  bulkProgress?: BulkUpdateProgress | null;
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
  notebooks = [],
  selection: selectionProp,
  canSelect = true,
  canBulkTag = true,
  canAutoOrganize = false,
  onBulkMove,
  onBulkAddTag,
  onBulkTrash,
  onAutoOrganize,
  isBulkPending = false,
  bulkProgress = null,
}: NoteListProps) {
  const [filterText, setFilterText] = useState("");
  const [sort, setSort] = useState<SortChoice>(loadSort);
  const { field: sortField, order: sortOrder } = sort;
  const [renderLimit, setRenderLimit] = useState(NOTE_LIST_PAGE_SIZE);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveFilter, setMoveFilter] = useState("");
  const [tagOpen, setTagOpen] = useState(false);
  const [tagValue, setTagValue] = useState("");

  const localSelection = useNoteSelection();
  const activeSelection = selectionProp ?? localSelection;
  const { isSelecting, selectedIds, toggleSelectionMode, selectAll, exitSelectionMode, handleItemAction } =
    activeSelection;

  // Reset the progressive slice when the local filter changes (synchronously during render)
  const [prevFilterText, setPrevFilterText] = useState(filterText);
  if (filterText !== prevFilterText) {
    setPrevFilterText(filterText);
    if (renderLimit !== NOTE_LIST_PAGE_SIZE) {
      setRenderLimit(NOTE_LIST_PAGE_SIZE);
    }
  }

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

  const orderedIds = useMemo(() => filteredAndSortedNotes.map((n) => n.id), [filteredAndSortedNotes]);
  const orderedIdsRef = useRef<string[]>(orderedIds);
  useEffect(() => {
    orderedIdsRef.current = orderedIds;
  }, [orderedIds]);

  const activeIndex = selectedNoteId
    ? filteredAndSortedNotes.findIndex((n) => n.id === selectedNoteId)
    : -1;
  const visibleCount = Math.min(
    filteredAndSortedNotes.length,
    Math.max(renderLimit, activeIndex >= 0 ? activeIndex + 1 : 0)
  );
  const visibleNotes = useMemo(
    () => filteredAndSortedNotes.slice(0, visibleCount),
    [filteredAndSortedNotes, visibleCount]
  );

  const selectedNotes = useMemo(
    () => notes.filter((n) => selectedIds.has(n.id)),
    [notes, selectedIds]
  );
  const selectedCount = selectedNotes.length;

  // Close popovers automatically when nothing is selected or selection mode ends
  const [prevShowBar, setPrevShowBar] = useState(selectedCount > 0);
  const showBar = isSelecting && selectedCount > 0;
  if (showBar !== prevShowBar) {
    setPrevShowBar(showBar);
    if (!showBar) {
      if (moveOpen) setMoveOpen(false);
      if (moveFilter) setMoveFilter("");
      if (tagOpen) setTagOpen(false);
      if (tagValue) setTagValue("");
    }
  }

  // Esc exits selection mode once any open action popover has closed
  useEffect(() => {
    if (!isSelecting) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || isBulkPending || moveOpen || tagOpen) return;
      const target = e.target;
      if (target instanceof Element) {
        if (
          target.closest("[role='dialog'], [role='alertdialog'], [role='menu'], .cm-editor, textarea, [contenteditable='true']")
        ) {
          return;
        }
        if (target.tagName === "INPUT" && target.getAttribute("aria-label") !== "Filter this list") {
          return;
        }
      }
      e.preventDefault();
      exitSelectionMode();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isSelecting, isBulkPending, moveOpen, tagOpen, exitSelectionMode]);

  const handleActivateItem = useCallback(
    (id: string, modifiers: SelectionModifiers) => {
      if (!canSelect) {
        onSelectNote(id);
        return;
      }
      const outcome = handleItemAction(id, modifiers, orderedIdsRef.current);
      if (outcome === "open") {
        onSelectNote(id);
      }
    },
    [canSelect, handleItemAction, onSelectNote]
  );

  const handleToggleTodoById = useCallback(
    (id: string, completed: boolean) => {
      onToggleTodo?.(id, completed);
    },
    [onToggleTodo]
  );

  const uniformCurrentNotebookId = useMemo(() => {
    if (selectedNotes.length === 0) return null;
    if (selectedNotes.some((n) => n.isConflict)) return null;
    const first = selectedNotes[0].parentId || selectedNotes[0].notebookId;
    if (!first) return null;
    return selectedNotes.every((n) => (n.parentId || n.notebookId) === first) ? first : null;
  }, [selectedNotes]);

  const commonTagIds = useMemo<ReadonlySet<string> | undefined>(() => {
    if (selectedNotes.length === 0) return undefined;
    const getTagIds = (item: NoteListItemType) =>
      (item as NoteListItemType & { tags?: ReadonlyArray<{ id: string }> }).tags;
    const firstTags = getTagIds(selectedNotes[0]);
    if (!firstTags || firstTags.length === 0) return undefined;
    const intersection = new Set<string>(firstTags.map((t) => t.id));
    for (let i = 1; i < selectedNotes.length; i++) {
      const nextTags = getTagIds(selectedNotes[i]);
      if (!nextTags || nextTags.length === 0) return undefined;
      const nextIds = new Set(nextTags.map((t) => t.id));
      for (const id of intersection) {
        if (!nextIds.has(id)) intersection.delete(id);
      }
      if (intersection.size === 0) return undefined;
    }
    return intersection;
  }, [selectedNotes]);

  const submitTag = (rawTitle: string) => {
    const trimmed = rawTitle.trim();
    if (!trimmed) return;
    setTagOpen(false);
    setTagValue("");
    onBulkAddTag?.(selectedNotes, trimmed);
  };

  const changeSortField = (field: SortField) => {
    if (field === sortField) return;
    // Titles read naturally A-Z, dates newest first
    updateSort({ field, order: field === "title" ? "asc" : "desc" });
  };

  const sortDescription = `${SORT_FIELD_LABELS[sortField]}, ${orderLabel(sortField, sortOrder)}`;
  const isFiltering = filterText.trim().length > 0;
  const showSelectToggle = canSelect && !isLoading && !error && (notes.length > 0 || isSelecting);

  return (
    <div className="flex flex-col h-full bg-background border-r border-border">
      {/* Top bar with Title, Select toggle, Sort & New */}
      <div className="px-4 py-3.5 border-b border-border space-y-2.5 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-foreground truncate">{title}</h2>
            {subtitle && (
              <p className="text-xs text-muted-foreground truncate">{subtitle}</p>
            )}
          </div>

          <div className="flex items-center gap-1 ml-auto shrink-0">
            {!isLoading && !error && (
              <span className="text-xs text-muted-foreground font-mono mr-0.5">
                {filteredAndSortedNotes.length} {filteredAndSortedNotes.length === 1 ? "note" : "notes"}
              </span>
            )}

            {showSelectToggle && (
              <Button
                type="button"
                variant={isSelecting ? "secondary" : "ghost"}
                size="sm"
                onClick={toggleSelectionMode}
                aria-pressed={isSelecting}
                disabled={isBulkPending}
                className="h-7 px-2 text-xs gap-1"
              >
                <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />
                Select
              </Button>
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

        {isSelecting && (
          <div className="flex items-center justify-between gap-2 pt-0.5" role="region" aria-label="Selection controls">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs"
              disabled={filteredAndSortedNotes.length === 0 || isBulkPending}
              onClick={() => selectAll(orderedIds)}
            >
              Select all ({filteredAndSortedNotes.length})
            </Button>
            {selectedCount === 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                disabled={isBulkPending}
                onClick={exitSelectionMode}
              >
                Cancel
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Content Area */}
      <ScrollArea
        className="flex-1 min-h-0 p-3 [&>[data-radix-scroll-area-viewport]>div]:block!"
        onScrollCapture={(e) => {
          const el = e.target as HTMLElement;
          if (
            visibleCount < filteredAndSortedNotes.length &&
            el.scrollHeight - el.scrollTop - el.clientHeight < 200
          ) {
            setRenderLimit((prev) => Math.max(prev, visibleCount) + NOTE_LIST_PAGE_SIZE);
          }
        }}
      >
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
            {visibleNotes.map((note) => (
              <NoteListItem
                key={note.id}
                note={note}
                isActive={!isSelecting && selectedNoteId === note.id}
                selectionMode={isSelecting}
                isSelected={isSelecting && selectedIds.has(note.id)}
                onActivate={handleActivateItem}
                onToggleTodoById={onToggleTodo ? handleToggleTodoById : undefined}
              />
            ))}
            {visibleCount < filteredAndSortedNotes.length && (
              <div className="pt-2 text-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setRenderLimit((prev) => Math.max(prev, visibleCount) + NOTE_LIST_PAGE_SIZE)}
                >
                  Show more ({filteredAndSortedNotes.length - visibleCount} remaining)
                </Button>
              </div>
            )}
          </div>
        )}
      </ScrollArea>

      {/* Sticky Bulk Action Bar */}
      {showBar && (
        <div
          role="region"
          aria-label="Bulk actions"
          className="sticky bottom-0 z-10 shrink-0 border-t border-border bg-card/95 backdrop-blur-xs px-3 py-2.5 shadow-sm"
        >
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xs font-semibold text-foreground whitespace-nowrap">
                {selectedCount} selected
              </span>
              {isBulkPending && (
                <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground font-mono truncate">
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
                  {bulkProgress && bulkProgress.total > 0
                    ? `${bulkProgress.completed} / ${bulkProgress.total}`
                    : "Working…"}
                </span>
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground shrink-0"
              disabled={isBulkPending}
              onClick={exitSelectionMode}
            >
              Cancel
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Popover
              open={moveOpen}
              onOpenChange={(open) => {
                setMoveOpen(open);
                if (!open) setMoveFilter("");
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isBulkPending}
                  className="h-8 gap-1.5 px-2.5 text-xs flex-1 min-w-[5.25rem]"
                >
                  <FolderInput className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  Move to…
                </Button>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                align="start"
                sideOffset={8}
                collisionPadding={12}
                onCloseAutoFocus={(e) => {
                  if (document.activeElement?.closest("[role='dialog']")) {
                    e.preventDefault();
                  }
                }}
                className="w-72 max-w-[calc(100vw-1.5rem)] p-3"
              >
                <p className="mb-2 text-xs font-medium text-muted-foreground">
                  Move {selectedCount} {selectedCount === 1 ? "note" : "notes"} to
                </p>
                <NotebookPicker
                  notebooks={notebooks}
                  currentId={uniformCurrentNotebookId}
                  filter={moveFilter}
                  onFilterChange={setMoveFilter}
                  autoFocusFilter
                  listClassName="max-h-52"
                  disabled={isBulkPending}
                  onSelect={(notebookId, notebookTitle) => {
                    setMoveOpen(false);
                    setMoveFilter("");
                    onBulkMove?.(selectedNotes, notebookId, notebookTitle);
                  }}
                />
              </PopoverContent>
            </Popover>

            {canBulkTag && (
              <Popover
                open={tagOpen}
                onOpenChange={(open) => {
                  setTagOpen(open);
                  if (!open) setTagValue("");
                }}
              >
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isBulkPending}
                    className="h-8 gap-1.5 px-2.5 text-xs flex-1 min-w-[5.25rem]"
                  >
                    <TagIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    Add tag…
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  side="top"
                  align="center"
                  sideOffset={8}
                  collisionPadding={12}
                  onCloseAutoFocus={(e) => {
                    if (document.activeElement?.closest("[role='dialog']")) {
                      e.preventDefault();
                    }
                  }}
                  className="w-72 max-w-[calc(100vw-1.5rem)] p-3"
                >
                  <p className="mb-2 text-xs font-medium text-muted-foreground">
                    Add tag to {selectedCount} {selectedCount === 1 ? "note" : "notes"}
                  </p>
                  <div className="flex items-start gap-1.5">
                    <div className="flex-1 min-w-0">
                      <TagAutocompleteInput
                        excludeTagIds={commonTagIds}
                        value={tagValue}
                        onValueChange={setTagValue}
                        onSubmit={submitTag}
                        onCancel={() => {
                          setTagOpen(false);
                          setTagValue("");
                        }}
                        isPending={isBulkPending}
                        inlineList
                        autoFocus
                        inputClassName="h-8 w-full rounded-md border-input px-2.5 text-sm"
                      />
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      className="h-8 px-2.5 text-xs shrink-0"
                      disabled={isBulkPending || !tagValue.trim()}
                      onClick={() => submitTag(tagValue)}
                    >
                      Add
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
            )}

            {canAutoOrganize && onAutoOrganize && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isBulkPending}
                onClick={() => onAutoOrganize(selectedNotes, uniformCurrentNotebookId)}
                className="h-8 gap-1.5 px-2.5 text-xs flex-1 min-w-[6.75rem]"
              >
                <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                Auto-organize
              </Button>
            )}

            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isBulkPending}
              onClick={() => onBulkTrash?.(selectedNotes)}
              className="h-8 gap-1.5 px-2.5 text-xs text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive flex-1 min-w-[6.5rem]"
            >
              <Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Move to trash
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
