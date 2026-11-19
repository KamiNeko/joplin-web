import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NoteListItem as NoteListItemType, Notebook, Tag } from "@/lib/types";
import { NoteListItem } from "./NoteListItem";
import { getResourceUrl } from "@/lib/api";
import { formatRelativeTime, noteDisplayTitle } from "@/lib/format";
import { NOTE_LIST_BOARD_GROUP_STORAGE_KEY, NOTE_LIST_VIEW_STORAGE_KEY } from "@/lib/ui-constants";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowDownUp,
  Check,
  CheckSquare,
  Columns3,
  FileQuestion,
  FileText,
  FolderInput,
  LayoutGrid,
  LayoutList,
  ListChecks,
  Loader2,
  Plus,
  Search,
  Sparkles,
  Square,
  Star,
  Table2,
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
import { useTags } from "@/hooks/use-tags";

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
  /** Called once with the top note when the list first loads with no note open (opens it, like Evernote) */
  onOpenFirst?: (id: string) => void;
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
  /** Tags used to label lanes in Board view when grouped by tags */
  tags?: Tag[];
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
  favoriteNoteIds?: ReadonlySet<string>;
}

type SortField = "updated" | "created" | "title";
type SortOrder = "asc" | "desc";
type CollectionViewMode = "list" | "gallery" | "table" | "board";
type BoardGrouping = "status" | "tags";

function loadViewMode(): CollectionViewMode {
  try {
    const raw = localStorage.getItem(NOTE_LIST_VIEW_STORAGE_KEY);
    if (raw === "list" || raw === "gallery" || raw === "table" || raw === "board") return raw;
  } catch {
    // storage unavailable
  }
  return "list";
}

function saveViewMode(mode: CollectionViewMode) {
  try {
    localStorage.setItem(NOTE_LIST_VIEW_STORAGE_KEY, mode);
  } catch {
    // storage unavailable
  }
}

function loadBoardGrouping(): BoardGrouping {
  try {
    const raw = localStorage.getItem(NOTE_LIST_BOARD_GROUP_STORAGE_KEY);
    if (raw === "status" || raw === "tags") return raw;
  } catch {
    // storage unavailable
  }
  return "status";
}

function saveBoardGrouping(group: BoardGrouping) {
  try {
    localStorage.setItem(NOTE_LIST_BOARD_GROUP_STORAGE_KEY, group);
  } catch {
    // storage unavailable
  }
}

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
  onOpenFirst,
  title = "Notes",
  subtitle,
  emptyTitle = "No notes yet",
  emptyDescription,
  onCreateNote,
  isCreating = false,
  onToggleTodo,
  renderLeading,
  notebooks = [],
  tags: tagsProp,
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
  favoriteNoteIds,
}: NoteListProps) {
  const [filterText, setFilterText] = useState("");
  const [sort, setSort] = useState<SortChoice>(loadSort);
  const [viewMode, setViewMode] = useState<CollectionViewMode>(loadViewMode);
  const [boardGrouping, setBoardGrouping] = useState<BoardGrouping>(loadBoardGrouping);
  const { field: sortField, order: sortOrder } = sort;
  const [renderLimit, setRenderLimit] = useState(NOTE_LIST_PAGE_SIZE);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveFilter, setMoveFilter] = useState("");
  const [tagOpen, setTagOpen] = useState(false);
  const [tagValue, setTagValue] = useState("");

  const { data: fetchedTags } = useTags(tagsProp === undefined && viewMode === "board");
  const availableTags = useMemo(() => tagsProp ?? fetchedTags ?? [], [tagsProp, fetchedTags]);

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

  const updateViewMode = (next: CollectionViewMode) => {
    setViewMode(next);
    saveViewMode(next);
  };

  const updateBoardGrouping = (next: BoardGrouping) => {
    setBoardGrouping(next);
    saveBoardGrouping(next);
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

  // Once per list (it remounts per notebook/tag), so closing the note doesn't reopen one
  const openedFirst = useRef(false);
  useEffect(() => {
    if (openedFirst.current || isLoading || !onOpenFirst) return;
    openedFirst.current = true;
    if (!selectedNoteId && filteredAndSortedNotes[0]) onOpenFirst(filteredAndSortedNotes[0].id);
  }, [isLoading, onOpenFirst, selectedNoteId, filteredAndSortedNotes]);

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

  const boardLanes = useMemo(() => {
    if (viewMode !== "board") return [];
    if (boardGrouping === "status") {
      return [
        { key: "status:open", label: "Open To-dos", items: visibleNotes.filter((n) => n.isTodo && !n.todoCompleted) },
        { key: "status:done", label: "Completed", items: visibleNotes.filter((n) => n.isTodo && n.todoCompleted) },
        { key: "status:notes", label: "Notes", items: visibleNotes.filter((n) => !n.isTodo) },
      ].filter((lane) => lane.items.length > 0);
    }

    const titleById = new Map<string, string>();
    for (const t of availableTags) {
      titleById.set(t.id, t.title);
    }
    for (const note of visibleNotes) {
      const embedded = (note as NoteListItemType & { tags?: ReadonlyArray<{ id: string; title?: string }> }).tags;
      if (embedded) {
        for (const t of embedded) {
          if (t.title && !titleById.has(t.id)) titleById.set(t.id, t.title);
        }
      }
    }

    const byTag = new Map<string, { title: string; items: NoteListItemType[] }>();
    const untagged: NoteListItemType[] = [];

    for (const note of visibleNotes) {
      const embedded = (note as NoteListItemType & { tags?: ReadonlyArray<{ id: string }> }).tags;
      const rawIds = note.tagIds && note.tagIds.length > 0 ? note.tagIds : embedded?.map((t) => t.id) ?? [];
      const uniqueIds = Array.from(new Set(rawIds));
      if (uniqueIds.length === 0) {
        untagged.push(note);
        continue;
      }
      for (const tid of uniqueIds) {
        const tagTitle = titleById.get(tid) ?? tid.slice(0, 8);
        let group = byTag.get(tid);
        if (!group) {
          group = { title: tagTitle, items: [] };
          byTag.set(tid, group);
        }
        group.items.push(note);
      }
    }

    const lanes = Array.from(byTag.entries())
      .sort((a, b) => a[1].title.localeCompare(b[1].title, undefined, { sensitivity: "base" }))
      .map(([tid, group]) => ({
        key: `tag:${tid}`,
        label: `#${group.title}`,
        items: group.items,
      }));

    if (untagged.length > 0) {
      lanes.push({ key: "tag:untagged", label: "Untagged", items: untagged });
    }
    return lanes;
  }, [viewMode, boardGrouping, visibleNotes, availableTags]);

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
      item.tagIds && item.tagIds.length > 0
        ? item.tagIds
        : (item as NoteListItemType & { tags?: ReadonlyArray<{ id: string }> }).tags?.map((t) => t.id);
    const firstTags = getTagIds(selectedNotes[0]);
    if (!firstTags || firstTags.length === 0) return undefined;
    const intersection = new Set<string>(firstTags);
    for (let i = 1; i < selectedNotes.length; i++) {
      const nextTags = getTagIds(selectedNotes[i]);
      if (!nextTags || nextTags.length === 0) return undefined;
      const nextIds = new Set(nextTags);
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

        {/* Filter input & collection view switcher */}
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1 min-w-0">
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

          <div
            role="group"
            aria-label="Collection view mode"
            className="inline-flex h-8 shrink-0 items-center rounded-md border border-border/50 bg-muted/30 p-0.5"
          >
            {(
              [
                { mode: "list", label: "List view", icon: LayoutList },
                { mode: "gallery", label: "Gallery view", icon: LayoutGrid },
                { mode: "table", label: "Table view", icon: Table2 },
                { mode: "board", label: "Board view", icon: Columns3 },
              ] as const
            ).map(({ mode, label, icon: Icon }) => (
              <button
                key={mode}
                type="button"
                onClick={() => updateViewMode(mode)}
                aria-label={label}
                aria-pressed={viewMode === mode}
                title={label}
                className={cn(
                  "h-7 w-7 inline-flex items-center justify-center rounded-sm transition-colors",
                  viewMode === mode
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ))}
          </div>
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
            {viewMode === "list" &&
              visibleNotes.map((note) => (
                <NoteListItem
                  key={note.id}
                  note={note}
                  isActive={!isSelecting && selectedNoteId === note.id}
                  isFavorite={Boolean(favoriteNoteIds?.has(note.id))}
                  selectionMode={isSelecting}
                  isSelected={isSelecting && selectedIds.has(note.id)}
                  onActivate={handleActivateItem}
                  onToggleTodoById={onToggleTodo ? handleToggleTodoById : undefined}
                />
              ))}

            {viewMode === "gallery" && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {visibleNotes.map((note) => {
                  const itemTitle = noteDisplayTitle(note);
                  const active = !isSelecting && selectedNoteId === note.id;
                  const selected = isSelecting && selectedIds.has(note.id);
                  return (
                    <div
                      key={note.id}
                      role="button"
                      tabIndex={0}
                      aria-current={active ? "true" : undefined}
                      onClick={(e) => {
                        if (e.ctrlKey || e.metaKey || (isSelecting && e.shiftKey)) e.preventDefault();
                        handleActivateItem(note.id, { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          handleActivateItem(note.id, { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
                        }
                      }}
                      className={cn(
                        "group flex flex-col justify-between rounded-xl border p-3 text-left cursor-pointer transition-colors overflow-hidden",
                        selected
                          ? "bg-primary/10 border-primary/50"
                          : active
                            ? "bg-card border-primary"
                            : "bg-card/40 border-border/60 hover:bg-muted/60"
                      )}
                    >
                      <div className="space-y-2">
                        {note.thumbnail?.kind === "image" && !note.encrypted ? (
                          <div className="h-24 w-full overflow-hidden rounded-lg border border-border/40 bg-muted">
                            <img
                              src={getResourceUrl(note.thumbnail.resourceId)}
                              alt=""
                              loading="lazy"
                              className="h-full w-full object-cover"
                            />
                          </div>
                        ) : null}
                        <div className="flex items-start gap-1.5 min-w-0">
                          {isSelecting && (
                            <button
                              type="button"
                              role="checkbox"
                              aria-checked={selected}
                              aria-label={`Select ${itemTitle}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleActivateItem(note.id, { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
                              }}
                              className={cn(
                                "shrink-0 mt-0.5 flex h-4 w-4 items-center justify-center rounded-sm border",
                                selected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/50"
                              )}
                            >
                              {selected && <Check className="h-3 w-3 stroke-[3]" />}
                            </button>
                          )}
                          <h3 className="font-semibold text-xs text-foreground line-clamp-2 flex-1">{itemTitle}</h3>
                          {favoriteNoteIds?.has(note.id) && (
                            <Star className="h-3.5 w-3.5 fill-amber-500 text-amber-500 shrink-0" aria-hidden="true" />
                          )}
                        </div>
                        <p className="text-[11px] text-muted-foreground line-clamp-2">
                          {note.encrypted ? "End-to-end encrypted" : note.preview || "Empty note"}
                        </p>
                      </div>
                      <div className="mt-2 pt-1.5 border-t border-border/40 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                        <span className="font-mono">{formatRelativeTime(note.updatedTime || note.createdTime)}</span>
                        {note.isTodo && (
                          <span className={cn("font-medium", note.todoCompleted ? "text-success" : "text-warning")}>
                            {note.todoCompleted ? "Done" : "To-do"}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {viewMode === "table" && (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted/50 text-muted-foreground font-medium border-b border-border">
                    <tr>
                      {isSelecting && <th className="w-7 px-2 py-2" />}
                      <th className="px-2.5 py-2">Title</th>
                      <th className="px-2 py-2">Type</th>
                      <th className="px-2 py-2 text-right">Updated</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {visibleNotes.map((note) => {
                      const itemTitle = noteDisplayTitle(note);
                      const active = !isSelecting && selectedNoteId === note.id;
                      const selected = isSelecting && selectedIds.has(note.id);
                      return (
                        <tr
                          key={note.id}
                          onClick={(e) => {
                            if (e.ctrlKey || e.metaKey || (isSelecting && e.shiftKey)) e.preventDefault();
                            handleActivateItem(note.id, { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
                          }}
                          className={cn(
                            "cursor-pointer transition-colors",
                            selected ? "bg-primary/10" : active ? "bg-card font-medium" : "hover:bg-muted/40"
                          )}
                        >
                          {isSelecting && (
                            <td className="px-2 py-2">
                              <input
                                type="checkbox"
                                checked={selected}
                                aria-label={`Select ${itemTitle}`}
                                onChange={() => undefined}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleActivateItem(note.id, { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
                                }}
                              />
                            </td>
                          )}
                          <td className="px-2.5 py-2 max-w-[160px]">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleActivateItem(note.id, { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
                              }}
                              className="flex items-center gap-1.5 text-left w-full font-medium text-foreground truncate"
                            >
                              {favoriteNoteIds?.has(note.id) && (
                                <Star className="h-3 w-3 fill-amber-500 text-amber-500 shrink-0" aria-hidden="true" />
                              )}
                              <span className="truncate">{itemTitle}</span>
                            </button>
                          </td>
                          <td className="px-2 py-2 whitespace-nowrap">
                            {note.isTodo ? (
                              <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0", note.todoCompleted ? "text-success border-success/30" : "text-warning border-warning/30")}>
                                {note.todoCompleted ? "Done" : "To-do"}
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground">Note</span>
                            )}
                          </td>
                          <td className="px-2 py-2 text-right font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                            {formatRelativeTime(note.updatedTime || note.createdTime)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {viewMode === "board" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-2 px-0.5">
                  <span className="text-[11px] font-medium text-muted-foreground">Group by</span>
                  <div
                    role="group"
                    aria-label="Board grouping"
                    className="inline-flex items-center rounded-md border border-border/50 bg-muted/30 p-0.5"
                  >
                    {(
                      [
                        { id: "status", label: "Status" },
                        { id: "tags", label: "Tags" },
                      ] as const
                    ).map(({ id, label }) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => updateBoardGrouping(id)}
                        aria-pressed={boardGrouping === id}
                        className={cn(
                          "rounded-sm px-2 py-0.5 text-[11px] font-medium transition-colors",
                          boardGrouping === id
                            ? "bg-background text-foreground shadow-xs"
                            : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {boardLanes.map((lane) => (
                  <section key={lane.key} className="rounded-xl border border-border/70 bg-muted/20 p-2.5 space-y-2">
                    <div className="flex items-center justify-between px-1">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        {lane.label}
                      </h4>
                      <Badge variant="secondary" className="text-[10px] font-mono h-4 px-1.5">
                        {lane.items.length}
                      </Badge>
                    </div>
                    <div className="space-y-1.5">
                      {lane.items.map((note) => {
                        const itemTitle = noteDisplayTitle(note);
                        const active = !isSelecting && selectedNoteId === note.id;
                        const selected = isSelecting && selectedIds.has(note.id);
                        return (
                          <div
                            key={`${lane.key}:${note.id}`}
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                              handleActivateItem(note.id, { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                handleActivateItem(note.id, { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
                              }
                            }}
                            className={cn(
                              "flex items-start gap-2 rounded-lg border p-2.5 bg-background cursor-pointer transition-colors",
                              selected
                                ? "border-primary bg-primary/10"
                                : active
                                  ? "border-primary"
                                  : "border-border/50 hover:bg-muted/50"
                            )}
                          >
                            {note.isTodo && (
                              <button
                                type="button"
                                disabled={!onToggleTodo}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onToggleTodo?.(note.id, !note.todoCompleted);
                                }}
                                aria-label={`Toggle ${itemTitle}`}
                                className="mt-0.5 shrink-0"
                              >
                                {note.todoCompleted ? (
                                  <CheckSquare className="h-3.5 w-3.5 text-success" />
                                ) : (
                                  <Square className="h-3.5 w-3.5 text-warning" />
                                )}
                              </button>
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1">
                                <span className={cn("text-xs font-medium text-foreground truncate", note.todoCompleted && "line-through text-muted-foreground")}>
                                  {itemTitle}
                                </span>
                                {favoriteNoteIds?.has(note.id) && (
                                  <Star className="h-3 w-3 fill-amber-500 text-amber-500 shrink-0" aria-hidden="true" />
                                )}
                              </div>
                              {note.preview && !note.encrypted && (
                                <p className="text-[11px] text-muted-foreground truncate mt-0.5">{note.preview}</p>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            )}

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
