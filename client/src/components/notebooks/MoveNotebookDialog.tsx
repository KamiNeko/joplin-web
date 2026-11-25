import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { flattenNotebooks } from "@/lib/notebooks";
import { Notebook } from "@/lib/types";
import { NotebookPicker, TOP_LEVEL } from "./NotebookPicker";

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

  const currentParent = notebook?.parentId ?? TOP_LEVEL;
  const canMove = selected !== null && selected !== currentParent && !isPending;

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

          <NotebookPicker
            notebooks={notebooks}
            selectedId={selected}
            currentId={currentParent}
            blockedIds={blockedIds}
            includeTopLevel
            filter={filter}
            onFilterChange={setFilter}
            onSelect={(id) => setSelected(id)}
            onDoubleClick={(id) => !isPending && onMove(id)}
          />

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
