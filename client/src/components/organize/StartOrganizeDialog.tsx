import { useMemo, useState } from "react";
import { Folder, Info, Loader2, Search, Sparkles } from "lucide-react";
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

interface StartOrganizeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedCount: number;
  notebooks: Notebook[];
  /** Default excluded target notebook when all selected notes share one parent notebook */
  defaultExcludedNotebookId?: string | null;
  isPending?: boolean;
  onConfirm: (excludeNotebookIds: string[]) => void;
}

/**
 * Confirmation dialog shown before starting an Auto-organize LLM job.
 * Lets the user choose destination notebooks to exclude and discloses what data is sent to the AI provider.
 */
export function StartOrganizeDialog({
  open,
  onOpenChange,
  selectedCount,
  notebooks,
  defaultExcludedNotebookId = null,
  isPending = false,
  onConfirm,
}: StartOrganizeDialogProps) {
  const [excludedIds, setExcludedIds] = useState<Set<string>>(() =>
    defaultExcludedNotebookId ? new Set([defaultExcludedNotebookId]) : new Set()
  );
  const [filter, setFilter] = useState("");

  // Reset defaults whenever the dialog opens (adjusted during render, matching PromptDialog)
  const [synced, setSynced] = useState({ open, defaultExcludedNotebookId });
  if (synced.open !== open || synced.defaultExcludedNotebookId !== defaultExcludedNotebookId) {
    setSynced({ open, defaultExcludedNotebookId });
    if (open) {
      setExcludedIds(defaultExcludedNotebookId ? new Set([defaultExcludedNotebookId]) : new Set());
      setFilter("");
    }
  }

  const flatNotebooks = useMemo(
    () => flattenNotebooks(notebooks).filter((nb) => !nb.encrypted),
    [notebooks]
  );

  const query = filter.trim().toLowerCase();
  const visibleNotebooks = useMemo(
    () => (query ? flatNotebooks.filter((nb) => nb.title.toLowerCase().includes(query)) : flatNotebooks),
    [flatNotebooks, query]
  );

  const toggleExcluded = (id: string) => {
    setExcludedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const noun = selectedCount === 1 ? "note" : "notes";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary shrink-0" aria-hidden="true" />
            <span>
              Auto-organize {selectedCount} {noun}
            </span>
          </DialogTitle>
          <DialogDescription>
            Suggest cleaner English titles, destination notebooks, and tags. Nothing changes until you review and apply.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-foreground">
                Exclude target notebooks
              </span>
              <span className="text-[11px] text-muted-foreground font-mono">
                {excludedIds.size} excluded
              </span>
            </div>

            {flatNotebooks.length > 5 && (
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter notebooks..."
                  aria-label="Filter excluded notebooks"
                  className="h-8 pl-8 text-xs"
                />
              </div>
            )}

            <div
              role="group"
              aria-label="Notebooks to exclude as destinations"
              className="max-h-48 overflow-y-auto rounded-lg border border-border bg-muted/20 p-1.5 space-y-0.5"
            >
              {visibleNotebooks.map((nb) => {
                const checked = excludedIds.has(nb.id);
                return (
                  <label
                    key={nb.id}
                    style={{ paddingLeft: `${8 + (query ? 0 : nb.depth * 14)}px` }}
                    className="flex items-center gap-2 rounded-md py-1.5 pr-2 text-sm text-foreground hover:bg-muted/60 cursor-pointer select-none"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={isPending}
                      onChange={() => toggleExcluded(nb.id)}
                      className="h-4 w-4 rounded border-input accent-primary shrink-0 cursor-pointer"
                    />
                    <Folder className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
                    <span className="truncate">{nb.title || "Untitled Folder"}</span>
                    {defaultExcludedNotebookId === nb.id && (
                      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">Source</span>
                    )}
                  </label>
                );
              })}
              {visibleNotebooks.length === 0 && (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                  No matching notebooks
                </p>
              )}
            </div>
          </div>

          <div
            role="note"
            className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground leading-relaxed"
          >
            <Info className="h-4 w-4 text-primary shrink-0 mt-0.5" aria-hidden="true" />
            <p>
              <strong className="font-medium text-foreground">Sent to the configured AI provider:</strong>{" "}
              each selected note&apos;s title, plain text (links stripped), attachment file names and OCR text,
              along with your notebook names, sample titles, and tag list.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={isPending || selectedCount === 0}
            onClick={() => onConfirm([...excludedIds])}
            className="gap-1.5"
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Start organizing ({selectedCount})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
