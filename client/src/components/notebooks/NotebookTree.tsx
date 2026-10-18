import React, { useState } from "react";
import { Notebook } from "@/lib/types";
import { ChevronRight, Folder, FolderInput, FolderOpen, FolderPlus, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ROW_ACTION_VISIBILITY } from "@/lib/ui-constants";

export type NotebookAction = "create-child" | "rename" | "move" | "delete";

interface NotebookTreeProps {
  notebooks: Notebook[];
  selectedNotebookId?: string | null;
  onSelectNotebook: (id: string) => void;
  /** Enables the per-notebook actions menu */
  onNotebookAction?: (action: NotebookAction, notebook: Notebook) => void;
  depth?: number;
}

interface NotebookItemProps {
  notebook: Notebook;
  selectedNotebookId?: string | null;
  onSelectNotebook: (id: string) => void;
  onNotebookAction?: (action: NotebookAction, notebook: Notebook) => void;
  depth: number;
}

function NotebookItem({
  notebook,
  selectedNotebookId,
  onSelectNotebook,
  onNotebookAction,
  depth,
}: NotebookItemProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const hasChildren = Boolean(notebook.children && notebook.children.length > 0);
  const isSelected = selectedNotebookId === notebook.id;
  const [isOpen, setIsOpen] = useState<boolean>(true);

  const toggleOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen((prev) => !prev);
  };

  const handleSelect = () => {
    onSelectNotebook(notebook.id);
  };

  const title = notebook.title || "Untitled Folder";
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
            className="p-0.5 mr-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-transform shrink-0"
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
          {isOpen && hasChildren ? (
            <FolderOpen
              className={cn(
                "h-4 w-4 shrink-0 transition-colors",
                isSelected ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
              )}
            />
          ) : (
            <Folder
              className={cn(
                "h-4 w-4 shrink-0 transition-colors",
                isSelected ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
              )}
            />
          )}
          <span className="truncate">{title}</span>
          {hasCount && (
            <span className="sr-only">
              , {notebook.noteCount} {notebook.noteCount === 1 ? "note" : "notes"}
            </span>
          )}
        </button>

        {onNotebookAction && (
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
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onNotebookAction("delete", notebook)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
                Move to trash
              </DropdownMenuItem>
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
            {notebook.noteCount}
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
              onSelectNotebook={onSelectNotebook}
              onNotebookAction={onNotebookAction}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function NotebookTree({
  notebooks,
  selectedNotebookId,
  onSelectNotebook,
  onNotebookAction,
  depth = 0,
}: NotebookTreeProps) {
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
          onSelectNotebook={onSelectNotebook}
          onNotebookAction={onNotebookAction}
          depth={depth}
        />
      ))}
    </div>
  );
}
