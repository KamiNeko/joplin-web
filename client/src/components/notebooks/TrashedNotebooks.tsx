import { useState } from "react";
import { toast } from "sonner";
import { Folder, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/common/Dialogs";
import { QueryError } from "@/components/common/QueryError";
import { useTrashedNotebooks } from "@/hooks/use-notebooks";
import { usePurgeNotebook, useRestoreNotebook } from "@/hooks/use-mutations";
import { TrashedNotebook } from "@/lib/types";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "3 notes, 1 sub-notebook" or "Empty" */
function contentsLabel(nb: TrashedNotebook): string {
  const parts = [plural(nb.noteCount, "note")];
  if (nb.notebookCount > 0) parts.push(plural(nb.notebookCount, "sub-notebook"));
  return nb.noteCount === 0 && nb.notebookCount === 0 ? "Empty" : parts.join(", ");
}

/**
 * Trashed notebooks at the top of the trash list, each with Restore and Delete permanently.
 * `filterText` is the note list's filter, applied to notebook titles as well.
 */
export function TrashedNotebooks({ filterText = "" }: { filterText?: string }) {
  const query = useTrashedNotebooks();
  const restore = useRestoreNotebook();
  const purge = usePurgeNotebook();
  const [confirmPurge, setConfirmPurge] = useState<TrashedNotebook | null>(null);

  const q = filterText.trim().toLowerCase();
  const notebooks = (query.data ?? []).filter((nb) => !q || nb.title.toLowerCase().includes(q));

  const handleRestore = (nb: TrashedNotebook) => {
    restore.mutate(nb.id, {
      onSuccess: () => toast.success(`"${nb.title}" restored`),
      onError: (err) => toast.error("Could not restore notebook", { description: err.message }),
    });
  };

  const handlePurge = () => {
    if (!confirmPurge) return;
    const target = confirmPurge;
    purge.mutate(target.id, {
      onSuccess: () => {
        setConfirmPurge(null);
        toast.success(`"${target.title}" deleted permanently`);
      },
      onError: (err) => toast.error("Could not delete notebook", { description: err.message }),
    });
  };

  if (query.isLoading) {
    return (
      <div className="pb-3">
        <Skeleton className="h-12 w-full rounded-xl" />
      </div>
    );
  }
  if (query.isError && !query.data) {
    return (
      <div className="pb-3">
        <QueryError
          compact
          message="Couldn't load trashed notebooks"
          onRetry={() => void query.refetch()}
          isRetrying={query.isFetching}
        />
      </div>
    );
  }
  if (notebooks.length === 0) return null;

  return (
    <section aria-labelledby="trashed-notebooks-heading" className="pb-3">
      <h3
        id="trashed-notebooks-heading"
        className="px-1 pb-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider"
      >
        Notebooks
      </h3>
      <ul className="space-y-2">
        {notebooks.map((nb) => {
          const busy = (restore.isPending && restore.variables === nb.id) || (purge.isPending && purge.variables === nb.id);
          return (
            <li
              key={nb.id}
              className="flex items-center gap-2.5 p-3 rounded-xl border border-border/40 bg-card/20"
            >
              <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground truncate">{nb.title}</p>
                <p className="text-xs text-muted-foreground truncate">{contentsLabel(nb)}</p>
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => handleRestore(nb)}
                disabled={busy}
                aria-label={`Restore ${nb.title}`}
                title="Restore"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={() => setConfirmPurge(nb)}
                disabled={busy}
                aria-label={`Delete ${nb.title} permanently`}
                title="Delete permanently"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={confirmPurge !== null}
        onOpenChange={(open) => !open && setConfirmPurge(null)}
        title="Delete notebook permanently?"
        description={
          confirmPurge
            ? `"${confirmPurge.title}" and everything in it (${contentsLabel(confirmPurge).toLowerCase()}) will be deleted from the server. This can't be undone.`
            : undefined
        }
        confirmLabel="Delete permanently"
        destructive
        isPending={purge.isPending}
        onConfirm={handlePurge}
      />
    </section>
  );
}
