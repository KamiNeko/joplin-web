import React, { useEffect, useMemo, useState } from "react";
import { Notebook } from "@/lib/types";
import { collectNotebookIds, findNotebookAncestors } from "@/lib/notebooks";
import { ChevronRight, Folder, FolderInput, FolderOpen, FolderPlus, Lock, MoreHorizontal, Pencil, Star, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { EXPANDED_NOTEBOOKS_STORAGE_KEY, ROW_ACTION_VISIBILITY } from "@/lib/ui-constants";

export type NotebookAction = "create-child" | "rename" | "move" | "delete";

const EMPTY_STRING_SET: ReadonlySet<string> = new Set();
const expandedListeners = new Set<() => void>();

function loadExpandedNotebooks(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_NOTEBOOKS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string" && item.length > 0));
  } catch {
    return new Set();
  }
}

function saveExpandedNotebooks(ids: ReadonlySet<string>, notify = true) {
  try {
    localStorage.setItem(EXPANDED_NOTEBOOKS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // storage unavailable
  }
  if (notify) expandedListeners.forEach((cb) => cb());
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

interface NotebookTreeProps {
  notebooks: Notebook[];
  selectedNotebookId?: string | null;
  /** Notebook containing the currently open note, so its ancestors expand even outside its folder */
  openNoteNotebookId?: string | null;
  favoriteNotebookIds?: ReadonlySet<string>;
  onSelectNotebook: (id: string) => void;
  /** Enables the per-notebook actions menu (never shown for encrypted notebooks, which can't be changed here) */
  onNotebookAction?: (action: NotebookAction, notebook: Notebook) => void;
  onToggleFavoriteNotebook?: (notebook: Notebook) => void;
  depth?: number;
}

interface NotebookItemProps {
  notebook: Notebook;
  selectedNotebookId?: string | null;
  expandedIds: ReadonlySet<string>;
  favoriteNotebookIds?: ReadonlySet<string>;
  onToggleExpand: (id: string) => void;
  onSelectNotebook: (id: string) => void;
  onNotebookAction?: (action: NotebookAction, notebook: Notebook) => void;
  onToggleFavoriteNotebook?: (notebook: Notebook) => void;
  depth: number;
}

function NotebookItem({
  notebook,
  selectedNotebookId,
  expandedIds,
  favoriteNotebookIds,
  onToggleExpand,
  onSelectNotebook,
  onNotebookAction,
  onToggleFavoriteNotebook,
  depth,
}: NotebookItemProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const hasChildren = Boolean(notebook.children && notebook.children.length > 0);
  const isSelected = selectedNotebookId === notebook.id;
  const isOpen = expandedIds.has(notebook.id);
  const isFavorite = Boolean(favoriteNotebookIds?.has(notebook.id));
  const hasMenuActions = Boolean((onNotebookAction || onToggleFavoriteNotebook) && !notebook.encrypted);

  const toggleOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleExpand(notebook.id);
  };

  const handleSelect = () => {
    onSelectNotebook(notebook.id);
  };

  const title = notebook.title || "Untitled Folder";
  const FolderIcon = notebook.encrypted ? Lock : isOpen && hasChildren ? FolderOpen : Folder;
  const hasCount = typeof notebook.noteCount === "number" && notebook.noteCount > 0;

  return (
    <div className="w-full select-none">
      {/* The row is only a container: the label, chevron and menu are sibling controls, so no
          button is nested in another. Clicking the row's padding still selects the notebook. */}
      <div
        onClick={handleSelect}
        style={{ paddingLeft: `${Math.max(depth * 14 + 8, 8)}px` }}
        className={cn(
          "group flex items-center justify-between py-1.5 pr-2.5 rounded-lg text-sm transition-all duration-150 cursor-pointer has-[.row-label:focus-visible]:ring-1 has-[.row-label:focus-visible]:ring-ring",
          isSelected
            ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
            : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
        )}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={toggleOpen}
            className="p-0.5 mr-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-transform shrink-0 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-sidebar-ring"
            aria-label={`${isOpen ? "Collapse" : "Expand"} ${title}`}
            aria-expanded={isOpen}
          >
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 shrink-0 transition-transform duration-200",
                isOpen && "rotate-90"
              )}
            />
          </button>
        ) : (
          <span className="w-4 mr-1.5 shrink-0" />
        )}

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleSelect();
          }}
          aria-current={isSelected ? "page" : undefined}
          className="row-label flex items-center gap-1.5 min-w-0 flex-1 mr-2 text-left outline-hidden"
        >
          <FolderIcon
            className={cn(
              "h-4 w-4 shrink-0 transition-colors",
              isSelected ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
            )}
          />
          <span className={cn("truncate", notebook.encrypted && "italic")}>{title}</span>
          {isFavorite && (
            <Star className="h-3 w-3 shrink-0 fill-amber-500 text-amber-500" aria-hidden="true" />
          )}
          {hasCount && (
            <span className="sr-only">
              , {notebook.noteCount} {notebook.noteCount === 1 ? "note" : "notes"}
            </span>
          )}
        </button>

        {hasMenuActions && (
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                onClick={(e) => e.stopPropagation()}
                aria-label={`Actions for ${title}`}
                className={cn(
                  "mr-1 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted shrink-0",
                  menuOpen ? "opacity-100" : ROW_ACTION_VISIBILITY
                )}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48" onClick={(e) => e.stopPropagation()}>
              {onNotebookAction && (
                <>
                  <DropdownMenuItem onClick={() => onNotebookAction("create-child", notebook)}>
                    <FolderPlus className="h-4 w-4" />
                    New sub-notebook
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onNotebookAction("rename", notebook)}>
                    <Pencil className="h-4 w-4" />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onNotebookAction("move", notebook)}>
                    <FolderInput className="h-4 w-4" />
                    Move to…
                  </DropdownMenuItem>
                </>
              )}
              {onToggleFavoriteNotebook && (
                <DropdownMenuItem onClick={() => onToggleFavoriteNotebook(notebook)}>
                  <Star className={cn("h-4 w-4", isFavorite && "fill-amber-500 text-amber-500")} />
                  {isFavorite ? "Remove from shortcuts" : "Pin to shortcuts"}
                </DropdownMenuItem>
              )}
              {onNotebookAction && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => onNotebookAction("delete", notebook)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                    Move to trash
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {hasCount && (
          <Badge
            variant="secondary"
            aria-hidden="true"
            className={cn(
              "px-1.5 py-0 text-[10px] font-mono shrink-0 h-4 min-w-[18px] flex items-center justify-center transition-colors",
              isSelected
                ? "bg-primary/15 text-foreground border-primary/30"
                : "bg-muted text-muted-foreground group-hover:bg-muted-foreground/20"
            )}
          >
            {/* Trimmed to the cap height so the digits sit in the middle of the pill */}
            <span className="[text-box:trim-both_cap_alphabetic]">{notebook.noteCount}</span>
          </Badge>
        )}
      </div>

      {hasChildren && isOpen && (
        <div className="mt-0.5 space-y-0.5">
          {notebook.children.map((child) => (
            <NotebookItem
              key={child.id}
              notebook={child}
              selectedNotebookId={selectedNotebookId}
              expandedIds={expandedIds}
              favoriteNotebookIds={favoriteNotebookIds}
              onToggleExpand={onToggleExpand}
              onSelectNotebook={onSelectNotebook}
              onNotebookAction={onNotebookAction}
              onToggleFavoriteNotebook={onToggleFavoriteNotebook}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Collapsible notebook tree: collapsed by default, auto-expands ancestors of the active
 * notebook or open note's notebook, and persists explicit toggle choices in localStorage.
 */
export function NotebookTree({
  notebooks,
  selectedNotebookId,
  openNoteNotebookId,
  favoriteNotebookIds,
  onSelectNotebook,
  onNotebookAction,
  onToggleFavoriteNotebook,
  depth = 0,
}: NotebookTreeProps) {
  const [persistedExpanded, setPersistedExpanded] = useState<Set<string>>(loadExpandedNotebooks);

  useEffect(() => {
    const sync = () => {
      const latest = loadExpandedNotebooks();
      setPersistedExpanded((prev) => (setsEqual(prev, latest) ? prev : latest));
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === EXPANDED_NOTEBOOKS_STORAGE_KEY || e.key === null) sync();
    };
    expandedListeners.add(sync);
    window.addEventListener("storage", onStorage);
    return () => {
      expandedListeners.delete(sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const validIds = useMemo(() => collectNotebookIds(notebooks), [notebooks]);

  // Drop stored ids for notebooks that no longer exist once the tree has loaded
  useEffect(() => {
    if (notebooks.length === 0) return;
    const pruned = new Set([...persistedExpanded].filter((id) => validIds.has(id)));
    if (setsEqual(pruned, persistedExpanded)) return;
    saveExpandedNotebooks(pruned, false);
  }, [notebooks.length, persistedExpanded, validIds]);

  const activeAncestors = useMemo(() => {
    const ids = new Set<string>();
    for (const id of findNotebookAncestors(notebooks, selectedNotebookId)) ids.add(id);
    for (const id of findNotebookAncestors(notebooks, openNoteNotebookId)) ids.add(id);
    return ids;
  }, [notebooks, selectedNotebookId, openNoteNotebookId]);

  const activeContextKey = useMemo(
    () => `${selectedNotebookId ?? ""}|${openNoteNotebookId ?? ""}|${[...activeAncestors].sort().join(",")}`,
    [selectedNotebookId, openNoteNotebookId, activeAncestors]
  );
  const [prevContextKey, setPrevContextKey] = useState(activeContextKey);
  const [sessionCollapsed, setSessionCollapsed] = useState<ReadonlySet<string>>(EMPTY_STRING_SET);
  if (prevContextKey !== activeContextKey) {
    setPrevContextKey(activeContextKey);
    if (sessionCollapsed.size > 0) setSessionCollapsed(EMPTY_STRING_SET);
  }

  const expandedIds = useMemo(() => {
    const next = new Set<string>();
    for (const id of persistedExpanded) {
      if (validIds.has(id)) next.add(id);
    }
    for (const id of activeAncestors) {
      if (!sessionCollapsed.has(id)) next.add(id);
    }
    return next;
  }, [persistedExpanded, validIds, activeAncestors, sessionCollapsed]);

  const handleToggleExpand = (id: string) => {
    if (expandedIds.has(id)) {
      const nextPersisted = new Set([...persistedExpanded].filter((item) => item !== id && validIds.has(item)));
      saveExpandedNotebooks(nextPersisted);
      setPersistedExpanded(nextPersisted);
      if (activeAncestors.has(id)) {
        const nextCollapsed = new Set(sessionCollapsed);
        nextCollapsed.add(id);
        setSessionCollapsed(nextCollapsed);
      }
      return;
    }

    const nextPersisted = new Set([...persistedExpanded].filter((item) => validIds.has(item)));
    nextPersisted.add(id);
    saveExpandedNotebooks(nextPersisted);
    setPersistedExpanded(nextPersisted);
    if (sessionCollapsed.has(id)) {
      const nextCollapsed = new Set(sessionCollapsed);
      nextCollapsed.delete(id);
      setSessionCollapsed(nextCollapsed);
    }
  };

  if (!notebooks || notebooks.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground italic">
        No notebooks found
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {notebooks.map((notebook) => (
        <NotebookItem
          key={notebook.id}
          notebook={notebook}
          selectedNotebookId={selectedNotebookId}
          expandedIds={expandedIds}
          favoriteNotebookIds={favoriteNotebookIds}
          onToggleExpand={handleToggleExpand}
          onSelectNotebook={onSelectNotebook}
          onNotebookAction={onNotebookAction}
          onToggleFavoriteNotebook={onToggleFavoriteNotebook}
          depth={depth}
        />
      ))}
    </div>
  );
}
