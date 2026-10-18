import { useState } from "react";
import { toast } from "sonner";
import { Folder, Lock, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/common/Dialogs";
import { QueryError } from "@/components/common/QueryError";
import { useTrashedNotebooks } from "@/hooks/use-notebooks";
import { usePurgeNotebook, useRestoreNotebook } from "@/hooks/use-mutations";
import { TrashedNotebook } from "@/lib/types";
import { notebookContentsLabel } from "@/lib/notebooks";

/** What was trashed with the notebook (what Restore brings back), e.g. "3 notes, 1 sub-notebook" */
const contentsLabel = (nb: TrashedNotebook) => notebookContentsLabel(nb.noteCount, nb.notebookCount);

const headingClass = "px-1 pb-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider";

/**
 * Trashed notebooks at the top of the trash list, each with Restore and Delete permanently.
 * `filterText` is the note list's filter, applied to notebook titles as well. With
 * `notesHeading`, a "Notes" heading follows the notebooks so the two groups read apart. On a
 * read-only account, and for encrypted notebooks, Restore and Delete are not offered.
 */
export function TrashedNotebooks({
  filterText = "",
  notesHeading = false,
  readOnly = false,
}: {
  filterText?: string;
  notesHeading?: boolean;
  readOnly?: boolean;
}) {
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
      <h3 id="trashed-notebooks-heading" className={headingClass}>
        Notebooks
      </h3>
      <ul className="space-y-2">
        {notebooks.map((nb) => {
          const busy = (restore.isPending && restore.variables === nb.id) || (purge.isPending && purge.variables === nb.id);
          const canChange = !readOnly && !nb.encrypted;
          const Icon = nb.encrypted ? Lock : Folder;
          return (
            <li
              key={nb.id}
              className="flex items-center gap-2.5 p-3 rounded-xl border border-border/40 bg-card/20"
            >
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-medium text-foreground truncate${nb.encrypted ? " italic" : ""}`}>{nb.title}</p>
                <p className="text-xs text-muted-foreground truncate first-letter:uppercase">{contentsLabel(nb)}</p>
              </div>
              {canChange && (
                <>
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
                </>
              )}
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
            ? `"${confirmPurge.title}" and everything in it (${contentsLabel(confirmPurge)}${
                confirmPurge.earlierNoteCount > 0
                  ? `, plus ${confirmPurge.earlierNoteCount} ${confirmPurge.earlierNoteCount === 1 ? "note" : "notes"} trashed earlier`
                  : ""
              }) will be deleted from the server. This can't be undone.`
            : undefined
        }
        confirmLabel="Delete permanently"
        destructive
        isPending={purge.isPending}
        onConfirm={handlePurge}
      />
      {notesHeading && <h3 className={`${headingClass} pt-3`}>Notes</h3>}
    </section>
  );
}
