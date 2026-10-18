import { useMemo, useState } from "react";
import { Folder, FolderTree, Loader2, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { flattenNotebooks } from "@/lib/notebooks";
import { Notebook } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Value of the "top level" choice (no parent notebook) */
const TOP_LEVEL = "";

interface MoveNotebookDialogProps {
  /** The notebook to move; the dialog is open while it is set */
  notebook: Notebook | null;
  notebooks: Notebook[];
  isPending?: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new parent id, or "" for the top level */
  onMove: (parentId: string) => void;
}

/**
 * Picks a new parent for a notebook. The notebook itself, its sub-notebooks and its current
 * parent can't be chosen.
 */
export function MoveNotebookDialog({ notebook, notebooks, isPending = false, onOpenChange, onMove }: MoveNotebookDialogProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  // Start fresh for every notebook (adjusted while rendering, not in an effect)
  const [shownFor, setShownFor] = useState(notebook);
  if (notebook !== shownFor) {
    setShownFor(notebook);
    if (notebook) {
      setSelected(null);
      setFilter("");
    }
  }

  const blockedIds = useMemo(
    () => new Set(notebook ? flattenNotebooks([notebook]).map((nb) => nb.id) : []),
    [notebook]
  );

  const query = filter.trim().toLowerCase();
  const choices = useMemo(() => {
    const flat = flattenNotebooks(notebooks).filter((nb) => !blockedIds.has(nb.id));
    return query ? flat.filter((nb) => nb.title.toLowerCase().includes(query)) : flat;
  }, [notebooks, blockedIds, query]);

  const currentParent = notebook?.parentId ?? TOP_LEVEL;
  const canMove = selected !== null && selected !== currentParent && !isPending;

  const option = (id: string, label: string, depth: number, icon: React.ReactNode) => {
    const isCurrent = id === currentParent;
    const isSelected = id === selected;
    return (
      <li key={id || "top-level"}>
        <button
          type="button"
          disabled={isCurrent}
          aria-pressed={isSelected}
          onClick={() => setSelected(id)}
          onDoubleClick={() => !isCurrent && !isPending && onMove(id)}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          className={cn(
            "w-full flex items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
            isSelected ? "bg-primary/15 text-foreground font-medium" : "text-foreground hover:bg-muted",
            isCurrent && "opacity-50 cursor-not-allowed hover:bg-transparent"
          )}
        >
          {icon}
          <span className="truncate">{label}</span>
          {isCurrent && <span className="ml-auto shrink-0 text-xs text-muted-foreground">Current</span>}
        </button>
      </li>
    );
  };

  return (
    <Dialog open={notebook !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-4 min-w-0"
          onSubmit={(e) => {
            e.preventDefault();
            if (canMove && selected !== null) onMove(selected);
          }}
        >
          <DialogHeader>
            <DialogTitle>Move notebook</DialogTitle>
            <DialogDescription className="wrap-break-word">
              Choose where to move "{notebook?.title}" and everything in it.
            </DialogDescription>
          </DialogHeader>

          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter notebooks..."
              aria-label="Filter notebooks"
              className="h-8 pl-8 text-sm"
            />
          </div>

          <ul
            aria-label="Destination"
            className="max-h-64 overflow-y-auto rounded-md border border-border p-1 space-y-0.5"
          >
            {!query && option(TOP_LEVEL, "Top level", 0, <FolderTree className="h-4 w-4 shrink-0 text-muted-foreground" />)}
            {choices.map((nb) =>
              option(nb.id, nb.title || "Untitled Folder", query ? 0 : nb.depth + 1, <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />)
            )}
            {query && choices.length === 0 && (
              <li className="px-2 py-3 text-center text-xs text-muted-foreground">No matching notebooks</li>
            )}
          </ul>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canMove}>
              {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Move
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
