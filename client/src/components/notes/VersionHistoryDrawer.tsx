import { useMemo, useState } from "react";
import { History, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { QueryError } from "@/components/common/QueryError";
import { useNoteRevisionDetail, useNoteRevisions, useRestoreNoteRevision } from "@/hooks/use-workspace";
import { cn } from "@/lib/utils";

interface VersionHistoryDrawerProps {
  noteId: string;
  currentBody: string;
  readOnly?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface DiffLine {
  kind: "same" | "added" | "removed";
  text: string;
}

function computeSimpleLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const result: DiffLine[] = [];

  for (const line of oldLines) {
    result.push({ kind: newSet.has(line) ? "same" : "removed", text: line });
  }
  for (const line of newLines) {
    if (!oldSet.has(line)) result.push({ kind: "added", text: line });
  }
  return result.slice(0, 200);
}

function formatRevTime(ts: number): string {
  if (!ts) return "Unknown date";
  const ms = ts < 10_000_000_000 ? ts * 1000 : ts;
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function VersionHistoryDrawer({
  noteId,
  currentBody,
  readOnly = false,
  open,
  onOpenChange,
}: VersionHistoryDrawerProps) {
  const revisionsQuery = useNoteRevisions(noteId, open);
  const revisions = useMemo(() => revisionsQuery.data ?? [], [revisionsQuery.data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const effectiveSelectedId =
    selectedId && revisions.some((r) => r.id === selectedId) ? selectedId : (revisions[0]?.id ?? null);
  const detailQuery = useNoteRevisionDetail(noteId, open ? effectiveSelectedId : null);
  const restoreMutation = useRestoreNoteRevision();

  const diffLines = useMemo(() => {
    if (!detailQuery.data) return [];
    return computeSimpleLineDiff(detailQuery.data.body ?? "", currentBody);
  }, [detailQuery.data, currentBody]);

  const handleRestore = async () => {
    if (!effectiveSelectedId) return;
    try {
      await restoreMutation.mutateAsync({ noteId, revId: effectiveSelectedId });
      toast.success("Note restored to selected revision");
      onOpenChange(false);
    } catch (err) {
      toast.error("Could not restore revision", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl flex flex-col p-0">
        <SheetHeader className="px-6 py-4 border-b border-border shrink-0 text-left">
          <SheetTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4 text-primary" />
            Version History
          </SheetTitle>
          <SheetDescription className="text-xs">
            Inspect Joplin revisions and restore a previous snapshot of this note.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 flex flex-col sm:flex-row overflow-hidden">
          <div className="sm:w-52 shrink-0 border-b sm:border-b-0 sm:border-r border-border overflow-y-auto p-3 space-y-1 max-h-48 sm:max-h-none">
            {revisionsQuery.isLoading ? (
              <div className="flex items-center gap-2 py-6 justify-center text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading...
              </div>
            ) : revisionsQuery.error ? (
              <QueryError
                compact
                message="Couldn't load versions"
                error={revisionsQuery.error}
                onRetry={() => void revisionsQuery.refetch()}
                isRetrying={revisionsQuery.isFetching}
              />
            ) : revisions.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">No saved revisions yet for this note.</p>
            ) : (
              revisions.map((rev) => (
                <button
                  key={rev.id}
                  type="button"
                  onClick={() => setSelectedId(rev.id)}
                  className={cn(
                    "w-full text-left rounded-lg px-2.5 py-2 text-xs transition-colors",
                    effectiveSelectedId === rev.id
                      ? "bg-primary/10 text-foreground font-semibold border border-primary/30"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  )}
                >
                  <div>{formatRevTime(rev.updatedTime || rev.createdTime)}</div>
                  <div className="text-[10px] font-mono opacity-75 truncate">{rev.id.slice(0, 8)}</div>
                </button>
              ))
            )}
          </div>

          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {effectiveSelectedId ? (
              detailQuery.isLoading ? (
                <div className="flex-1 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading revision...
                </div>
              ) : detailQuery.error ? (
                <div className="p-4">
                  <QueryError
                    message="Couldn't load revision"
                    error={detailQuery.error}
                    onRetry={() => void detailQuery.refetch()}
                    isRetrying={detailQuery.isFetching}
                  />
                </div>
              ) : detailQuery.data ? (
                <>
                  <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-2 bg-muted/20 shrink-0">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-foreground truncate">
                        {detailQuery.data.title || "Untitled Note"}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {formatRevTime(detailQuery.data.updatedTime || detailQuery.data.createdTime)}
                      </p>
                    </div>
                    {!readOnly && (
                      <Button
                        type="button"
                        size="sm"
                        disabled={restoreMutation.isPending}
                        onClick={() => void handleRestore()}
                        className="h-8 gap-1.5 px-2.5 text-xs shrink-0"
                      >
                        {restoreMutation.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5" />
                        )}
                        Restore
                      </Button>
                    )}
                  </div>

                  <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                        Changes vs current note
                      </p>
                      <div className="rounded-lg border border-border bg-muted/20 p-2 font-mono text-[11px] space-y-0.5 overflow-x-auto">
                        {diffLines.map((d, idx) => (
                          <div
                            key={idx}
                            className={cn(
                              "px-1.5 py-0.5 rounded whitespace-pre-wrap",
                              d.kind === "removed" && "bg-success/15 text-success",
                              d.kind === "added" && "bg-destructive/15 text-destructive",
                              d.kind === "same" && "text-muted-foreground"
                            )}
                          >
                            {d.kind === "removed" ? "+ rev: " : d.kind === "added" ? "- now: " : "  "}
                            {d.text || " "}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </>
              ) : null
            ) : (
              <div className="flex-1 flex items-center justify-center p-6 text-xs text-muted-foreground text-center">
                Select a revision on the left to inspect its contents and diff.
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
