import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  CopyCheck,
  ExternalLink,
  FileWarning,
  Loader2,
  ScanSearch,
  Sparkles,
  Tag,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { AppLayout } from "@/components/layout/AppLayout";
import { Sidebar } from "@/components/layout/Sidebar";
import { QueryError } from "@/components/common/QueryError";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useConflictNotes } from "@/hooks/use-notes";
import { useBulkUpdateNotes, useDeleteNote, useRestoreNote } from "@/hooks/use-mutations";
import { useCreateOrganizeJob, useOrganizeJobs, useOrganizeStatus } from "@/hooks/use-organize";
import { HYGIENE_QUERY_KEY, useHygieneReport } from "@/hooks/use-workspace";
import { useWriteState } from "@/hooks/use-write-state";
import { formatRelativeTime, noteDisplayTitle } from "@/lib/format";

export function HygienePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [headerSearch, setHeaderSearch] = useState("");
  const [busyNoteId, setBusyNoteId] = useState<string | null>(null);

  const { readOnly, reason: readOnlyReason } = useWriteState();
  const { data: conflictNotes } = useConflictNotes();
  const { data: organizeStatus } = useOrganizeStatus();
  const { data: organizeJobsData } = useOrganizeJobs(Boolean(organizeStatus?.enabled));
  const hygieneQuery = useHygieneReport(true);
  const deleteNote = useDeleteNote();
  const restoreNote = useRestoreNote();
  const bulkUpdate = useBulkUpdateNotes();
  const createOrganizeJob = useCreateOrganizeJob();

  const organizeJobs = organizeJobsData?.jobs ?? [];
  const hasRunningJob = organizeJobs.some((j) => j.status === "running");

  const handleTrashNote = async (noteId: string, title: string) => {
    setBusyNoteId(noteId);
    try {
      await deleteNote.mutateAsync({ id: noteId });
      await queryClient.invalidateQueries({ queryKey: HYGIENE_QUERY_KEY });
      toast.success(`Moved "${title}" to trash`, {
        action: {
          label: "Undo",
          onClick: () => {
            void restoreNote.mutateAsync(noteId).then(() => {
              void queryClient.invalidateQueries({ queryKey: HYGIENE_QUERY_KEY });
              toast.success("Note restored");
            });
          },
        },
      });
    } catch (err) {
      toast.error("Could not move note to trash", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusyNoteId(null);
    }
  };

  const handleTrashAllEmpty = async () => {
    const empty = hygieneQuery.data?.emptyNotes ?? [];
    if (empty.length === 0) return;
    try {
      await bulkUpdate.mutateAsync({
        items: empty.map((n) => ({ id: n.id })),
        trash: true,
      });
      await queryClient.invalidateQueries({ queryKey: HYGIENE_QUERY_KEY });
      toast.success(`Moved ${empty.length} empty ${empty.length === 1 ? "note" : "notes"} to trash`);
    } catch (err) {
      toast.error("Could not trash empty notes", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const handleOrganizeUntagged = async () => {
    const untagged = hygieneQuery.data?.untaggedNotes ?? [];
    if (untagged.length === 0) return;
    try {
      const { jobId } = await createOrganizeJob.mutateAsync({
        noteIds: untagged.map((n) => n.id),
      });
      navigate(`/organize/${jobId}`);
    } catch (err) {
      toast.error("Could not start Auto-organize", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const clusters = hygieneQuery.data?.duplicateClusters ?? [];
  const emptyNotes = hygieneQuery.data?.emptyNotes ?? [];
  const untaggedNotes = hygieneQuery.data?.untaggedNotes ?? [];

  return (
    <AppLayout
      notebookTitle="Hygiene & Duplicates"
      searchQuery={headerSearch}
      onSearchChange={(q) => {
        setHeaderSearch(q);
        if (q.trim().length >= 2) {
          navigate(`/notes?q=${encodeURIComponent(q.trim())}`);
        }
      }}
      readOnly={readOnly}
      readOnlyReason={readOnlyReason}
      sidebar={({ onCloseMobile, aiEnabled, onOpenAskAi }) => (
        <Sidebar
          selectedNotebookId={null}
          selectedTagId={null}
          activeView="hygiene"
          conflictCount={conflictNotes?.length ?? 0}
          organizeJobCount={organizeJobs.length}
          runningOrganizeJob={hasRunningJob}
          aiEnabled={aiEnabled}
          onOpenAskAi={onOpenAskAi}
          onSelectConflicts={() => {
            navigate("/conflicts");
            onCloseMobile?.();
          }}
          onSelectOrganize={() => {
            navigate("/organize");
            onCloseMobile?.();
          }}
          onSelectAllNotes={() => {
            navigate("/notes");
            onCloseMobile?.();
          }}
          onSelectTrash={() => {
            navigate("/trash");
            onCloseMobile?.();
          }}
          onSelectNotebook={(id) => {
            navigate(`/notebooks/${id}`);
            onCloseMobile?.();
          }}
          onSelectTag={(id) => {
            navigate(`/notes?tag=${encodeURIComponent(id)}`);
            onCloseMobile?.();
          }}
          searchQuery={headerSearch}
          onSearchChange={(q) => {
            setHeaderSearch(q);
            if (q.trim().length >= 2) {
              navigate(`/notes?q=${encodeURIComponent(q.trim())}`);
              onCloseMobile?.();
            }
          }}
          onCloseMobile={onCloseMobile}
          readOnly={readOnly}
        />
      )}
    >
      <div className="h-full overflow-y-auto px-4 py-5 sm:px-8 sm:py-6">
        <div className="mx-auto max-w-5xl space-y-6">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
              <ScanSearch className="h-5 w-5 text-primary" aria-hidden="true" />
              Workspace Hygiene & Duplicates
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Compare possible duplicate notes side by side, clean up empty drafts, and spot untagged notes.
            </p>
          </div>

          {hygieneQuery.isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : hygieneQuery.error ? (
            <QueryError
              message="Couldn't compute hygiene report"
              error={hygieneQuery.error}
              onRetry={() => void hygieneQuery.refetch()}
              isRetrying={hygieneQuery.isFetching}
            />
          ) : (
            <>
              {/* Summary Strip */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="rounded-xl border border-border bg-card/50 p-4">
                  <div className="text-xs text-muted-foreground">Duplicate clusters</div>
                  <div className="mt-1 text-2xl font-bold font-mono text-foreground">{clusters.length}</div>
                </div>
                <div className="rounded-xl border border-border bg-card/50 p-4">
                  <div className="text-xs text-muted-foreground">Empty notes</div>
                  <div className="mt-1 text-2xl font-bold font-mono text-foreground">{emptyNotes.length}</div>
                </div>
                <div className="rounded-xl border border-border bg-card/50 p-4">
                  <div className="text-xs text-muted-foreground">Untagged notes</div>
                  <div className="mt-1 text-2xl font-bold font-mono text-foreground">{untaggedNotes.length}</div>
                </div>
              </div>

              {/* Duplicate Clusters */}
              <section className="space-y-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <CopyCheck className="h-4 w-4 text-primary" aria-hidden="true" />
                  Possible Duplicates ({clusters.length})
                </h2>

                {clusters.length === 0 ? (
                  <p className="rounded-xl border border-border bg-card/30 px-4 py-6 text-xs text-muted-foreground text-center">
                    No duplicate note clusters detected.
                  </p>
                ) : (
                  <div className="space-y-4">
                    {clusters.map((cluster) => (
                      <div key={cluster.id} className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-[11px]">
                            {cluster.reason === "exact-title" ? "Same title" : "Similar content"}
                          </Badge>
                          <span className="text-xs font-mono text-muted-foreground">
                            {Math.round(cluster.score * 100)}% match · {cluster.notes.length} notes
                          </span>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          {cluster.notes.map((n) => (
                            <div
                              key={n.id}
                              className="rounded-lg border border-border bg-background p-3 flex flex-col justify-between gap-2"
                            >
                              <div className="space-y-1">
                                <div className="flex items-start justify-between gap-2">
                                  <div className="font-semibold text-sm text-foreground truncate">
                                    {noteDisplayTitle(n)}
                                  </div>
                                  <span className="shrink-0 text-[11px] font-mono text-muted-foreground">
                                    {formatRelativeTime(n.updatedTime)}
                                  </span>
                                </div>
                                <div className="text-[11px] font-mono text-muted-foreground">
                                  {n.notebookTitle}
                                  {typeof n.previewLength === "number" ? ` · ${n.previewLength} chars` : ""}
                                </div>
                                <p className="text-xs text-muted-foreground line-clamp-3">
                                  {n.preview || "(Empty preview)"}
                                </p>
                              </div>
                              <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/50">
                                <Button asChild type="button" variant="outline" size="sm" className="h-7 text-xs gap-1">
                                  <Link to={`/notes/${n.id}`}>
                                    <ExternalLink className="h-3 w-3" /> Open
                                  </Link>
                                </Button>
                                {!readOnly && (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    disabled={busyNoteId === n.id}
                                    onClick={() => void handleTrashNote(n.id, noteDisplayTitle(n))}
                                    className="h-7 text-xs text-destructive hover:text-destructive gap-1"
                                  >
                                    {busyNoteId === n.id ? (
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                    ) : (
                                      <Trash2 className="h-3 w-3" />
                                    )}
                                    Move to trash
                                  </Button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Empty Notes */}
              <section className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <FileWarning className="h-4 w-4 text-primary" aria-hidden="true" />
                    Empty Notes ({emptyNotes.length})
                  </h2>
                  {!readOnly && emptyNotes.length > 0 && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={bulkUpdate.isPending}
                      onClick={() => void handleTrashAllEmpty()}
                      className="h-7 text-xs gap-1 text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" />
                      Trash all empty ({emptyNotes.length})
                    </Button>
                  )}
                </div>

                {emptyNotes.length === 0 ? (
                  <p className="rounded-xl border border-border bg-card/30 px-4 py-6 text-xs text-muted-foreground text-center">
                    No empty notes found.
                  </p>
                ) : (
                  <div className="divide-y divide-border rounded-xl border border-border bg-card/50">
                    {emptyNotes.map((n) => (
                      <div key={n.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                        <div className="min-w-0">
                          <Link
                            to={`/notes/${n.id}`}
                            className="text-sm font-medium text-foreground hover:text-primary hover:underline truncate block"
                          >
                            {noteDisplayTitle(n)}
                          </Link>
                          <div className="text-[11px] font-mono text-muted-foreground">
                            {n.notebookTitle} · Updated {formatRelativeTime(n.updatedTime)}
                          </div>
                        </div>
                        {!readOnly && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={busyNoteId === n.id}
                            onClick={() => void handleTrashNote(n.id, noteDisplayTitle(n))}
                            aria-label={`Move ${noteDisplayTitle(n)} to trash`}
                            className="h-7 text-xs text-destructive hover:text-destructive gap-1 shrink-0"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Trash
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Untagged Notes */}
              <section className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Tag className="h-4 w-4 text-primary" aria-hidden="true" />
                    Untagged Notes ({untaggedNotes.length})
                  </h2>
                  {!readOnly && organizeStatus?.enabled && untaggedNotes.length > 0 && (
                    <Button
                      type="button"
                      size="sm"
                      disabled={createOrganizeJob.isPending}
                      onClick={() => void handleOrganizeUntagged()}
                      className="h-7 text-xs gap-1"
                    >
                      {createOrganizeJob.isPending ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Sparkles className="h-3 w-3" />
                      )}
                      Auto-organize untagged
                    </Button>
                  )}
                </div>

                {untaggedNotes.length === 0 ? (
                  <p className="rounded-xl border border-border bg-card/30 px-4 py-6 text-xs text-muted-foreground text-center">
                    Every note has at least one tag.
                  </p>
                ) : (
                  <div className="divide-y divide-border rounded-xl border border-border bg-card/50">
                    {untaggedNotes.slice(0, 50).map((n) => (
                      <div key={n.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                        <div className="min-w-0">
                          <Link
                            to={`/notes/${n.id}`}
                            className="text-sm font-medium text-foreground hover:text-primary hover:underline truncate block"
                          >
                            {noteDisplayTitle(n)}
                          </Link>
                          <div className="text-[11px] font-mono text-muted-foreground">
                            {n.notebookTitle} · Updated {formatRelativeTime(n.updatedTime)}
                          </div>
                        </div>
                        <Button asChild type="button" variant="outline" size="sm" className="h-7 text-xs shrink-0">
                          <Link to={`/notes/${n.id}`}>Review</Link>
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
