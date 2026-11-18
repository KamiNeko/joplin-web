import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ExternalLink,
  Folder,
  History,
  Loader2,
  Plus,
  RotateCcw,
  Sparkles,
  Tag as TagIcon,
  Trash2,
  Undo2,
  X,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { AppLayout } from "@/components/layout/AppLayout";
import { Sidebar } from "@/components/layout/Sidebar";
import { NotebookPicker } from "@/components/notebooks/NotebookPicker";
import { TagAutocompleteInput } from "@/components/tags/TagAutocompleteInput";
import { ConfirmDialog } from "@/components/common/Dialogs";
import { QueryError } from "@/components/common/QueryError";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { useConflictNotes } from "@/hooks/use-notes";
import { useNotebooks } from "@/hooks/use-notebooks";
import { useTags } from "@/hooks/use-tags";
import { useWriteState } from "@/hooks/use-write-state";
import {
  ORGANIZE_PAGE_SIZE,
  useApplyOrganizeJob,
  useCancelOrganizeJob,
  useDeleteOrganizeJob,
  useOrganizeJob,
  useOrganizeJobs,
  useRetryOrganizeJob,
  useUndoOrganizeJob,
} from "@/hooks/use-organize";
import { formatRelativeTime } from "@/lib/format";
import { buildNotebookPathMap } from "@/lib/notebooks";
import { OrganizeApplyItemInput, OrganizeJobItem, OrganizeJobSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

type OrganizeFilter = "all" | "very-high" | "high" | "moves";

const VERY_HIGH_CONFIDENCE_THRESHOLD = 0.85;
const HIGH_CONFIDENCE_THRESHOLD = 0.7;

interface RowEdit {
  title?: string;
  notebookId?: string;
  tags?: string[];
}

function noteUrlForItem(item: OrganizeJobItem): string {
  return item.currentNotebookId
    ? `/notebooks/${item.currentNotebookId}/notes/${item.noteId}`
    : `/notes/${item.noteId}`;
}

function subscribeDesktopMedia(callback: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mq = window.matchMedia("(min-width: 768px)");
  mq.addEventListener("change", callback);
  return () => mq.removeEventListener("change", callback);
}

function getIsDesktopSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(min-width: 768px)").matches;
}

function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribeDesktopMedia, getIsDesktopSnapshot, () => true);
}

export function OrganizePage() {
  const { jobId } = useParams<{ jobId: string }>();
  return <OrganizePageContent key={jobId ?? "list"} jobId={jobId} />;
}

function OrganizePageContent({ jobId }: { jobId: string | undefined }) {
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  const isListView = !jobId;

  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState<OrganizeFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [edits, setEdits] = useState<Record<string, RowEdit>>({});
  const [selectionOverrides, setSelectionOverrides] = useState<Record<string, boolean>>({});
  const [openNotebookRow, setOpenNotebookRow] = useState<string | null>(null);
  const [openTagRow, setOpenTagRow] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const [jobToDelete, setJobToDelete] = useState<OrganizeJobSummary | null>(null);

  const { readOnly, reason: readOnlyReason } = useWriteState();
  const { data: notebooks } = useNotebooks();
  const { data: allTags } = useTags();
  const { data: conflictNotes } = useConflictNotes();

  const jobsQuery = useOrganizeJobs(true);
  const organizeJobs = jobsQuery.data?.jobs ?? [];
  const hasRunningJob = organizeJobs.some((j) => j.status === "running");

  const jobQuery = useOrganizeJob(jobId, { offset, limit: ORGANIZE_PAGE_SIZE });
  const { data: job, isLoading, error } = jobQuery;

  const cancelMutation = useCancelOrganizeJob(jobId);
  const deleteMutation = useDeleteOrganizeJob();
  const retryMutation = useRetryOrganizeJob(jobId);
  const applyMutation = useApplyOrganizeJob(jobId);
  const undoMutation = useUndoOrganizeJob(jobId);

  const notebookPathById = useMemo(() => buildNotebookPathMap(notebooks), [notebooks]);
  const excludedNotebookSet = useMemo(
    () => new Set(job?.excludeNotebookIds ?? []),
    [job?.excludeNotebookIds]
  );

  const tagIdByLowerTitle = useMemo(() => {
    const map = new Map<string, string>();
    for (const tag of allTags ?? []) {
      map.set(tag.title.trim().toLowerCase(), tag.id);
    }
    return map;
  }, [allTags]);

  const effectiveRow = (item: OrganizeJobItem) => {
    const edit = edits[item.noteId];
    return {
      title: edit?.title ?? item.suggestion?.title ?? item.currentTitle,
      notebookId: edit?.notebookId ?? item.suggestion?.notebookId ?? item.currentNotebookId,
      tags: edit?.tags ?? item.suggestion?.tags ?? [],
    };
  };

  const isRowChecked = useCallback(
    (item: OrganizeJobItem): boolean => {
      if (item.status !== "done" || !item.suggestion) return false;
      if (Object.prototype.hasOwnProperty.call(selectionOverrides, item.noteId)) {
        return Boolean(selectionOverrides[item.noteId]);
      }
      if (item.applied) return false;
      return item.suggestion.confidence >= HIGH_CONFIDENCE_THRESHOLD;
    },
    [selectionOverrides]
  );

  const items = useMemo(() => job?.items ?? [], [job?.items]);

  const counts = useMemo(() => {
    let veryHigh = 0;
    let high = 0;
    let moves = 0;
    for (const item of items) {
      if (item.status !== "done" || !item.suggestion) continue;
      if (item.suggestion.confidence >= VERY_HIGH_CONFIDENCE_THRESHOLD) veryHigh++;
      if (item.suggestion.confidence >= HIGH_CONFIDENCE_THRESHOLD) high++;
      const targetNb = edits[item.noteId]?.notebookId ?? item.suggestion.notebookId;
      if (targetNb && targetNb !== item.currentNotebookId) moves++;
    }
    return { all: items.length, veryHigh, high, moves };
  }, [items, edits]);

  const retryableFailedCount =
    typeof job?.retryableFailedCount === "number"
      ? job.retryableFailedCount
      : items.filter((item) => item.status === "failed" && !item.skipped).length;

  const filteredItems = useMemo(() => {
    if (filter === "all") return items;
    if (filter === "very-high") {
      return items.filter(
        (item) => item.status === "done" && (item.suggestion?.confidence ?? 0) >= VERY_HIGH_CONFIDENCE_THRESHOLD
      );
    }
    if (filter === "high") {
      return items.filter(
        (item) => item.status === "done" && (item.suggestion?.confidence ?? 0) >= HIGH_CONFIDENCE_THRESHOLD
      );
    }
    return items.filter((item) => {
      if (item.status !== "done" || !item.suggestion) return false;
      const targetNb = edits[item.noteId]?.notebookId ?? item.suggestion.notebookId;
      return Boolean(targetNb && targetNb !== item.currentNotebookId);
    });
  }, [items, filter, edits]);

  const selectedItems = useMemo(
    () => items.filter((item) => isRowChecked(item)),
    [items, isRowChecked]
  );

  const toggleRow = (noteId: string, nextValue: boolean) => {
    setSelectionOverrides((prev) => ({ ...prev, [noteId]: nextValue }));
  };

  const selectAllVeryHigh = () => {
    setSelectionOverrides((prev) => {
      const next = { ...prev };
      for (const item of items) {
        if (item.status !== "done" || item.applied) continue;
        next[item.noteId] = (item.suggestion?.confidence ?? 0) >= VERY_HIGH_CONFIDENCE_THRESHOLD;
      }
      return next;
    });
  };

  const selectAllHighConfidence = () => {
    setSelectionOverrides((prev) => {
      const next = { ...prev };
      for (const item of items) {
        if (
          item.status === "done" &&
          !item.applied &&
          (item.suggestion?.confidence ?? 0) >= HIGH_CONFIDENCE_THRESHOLD
        ) {
          next[item.noteId] = true;
        }
      }
      return next;
    });
  };

  const clearAllSelections = () => {
    setSelectionOverrides((prev) => {
      const next = { ...prev };
      for (const item of items) {
        if (item.status === "done") {
          next[item.noteId] = false;
        }
      }
      return next;
    });
  };

  const updateRowEdit = (noteId: string, patch: Partial<RowEdit>) => {
    setEdits((prev) => ({
      ...prev,
      [noteId]: {
        ...prev[noteId],
        ...patch,
      },
    }));
  };

  const removeRowTag = (item: OrganizeJobItem, tagToRemove: string) => {
    const currentTags = effectiveRow(item).tags;
    updateRowEdit(item.noteId, {
      tags: currentTags.filter((t) => t.toLowerCase() !== tagToRemove.toLowerCase()),
    });
  };

  const addRowTag = (item: OrganizeJobItem, rawTag: string) => {
    const clean = rawTag.trim().toLowerCase();
    if (!clean) return;
    const currentTags = effectiveRow(item).tags;
    if (currentTags.some((t) => t.toLowerCase() === clean)) {
      setOpenTagRow(null);
      setTagDraft("");
      return;
    }
    updateRowEdit(item.noteId, { tags: [...currentTags, clean] });
    setOpenTagRow(null);
    setTagDraft("");
  };

  const handleUndo = async () => {
    try {
      const res = await undoMutation.mutateAsync();
      const revertedIds = new Set(res.results.filter((r) => r.status === "ok").map((r) => r.id));
      if (revertedIds.size > 0) {
        setSelectionOverrides((prev) => {
          const next = { ...prev };
          for (const id of revertedIds) delete next[id];
          return next;
        });
      }
      const parts: string[] = [];
      if (res.conflictCount > 0) parts.push(`${res.conflictCount} skipped: changed elsewhere`);
      if (res.errorCount > 0) parts.push(`${res.errorCount} failed`);
      const suffix = parts.length > 0 ? `, ${parts.join(", ")}` : "";
      const noun = res.revertedCount === 1 ? "note" : "notes";
      if (res.revertedCount > 0) {
        const notify = res.conflictCount > 0 || res.errorCount > 0 ? toast.warning : toast.success;
        notify(`Reverted ${res.revertedCount} ${noun}${suffix}`);
      } else if (res.conflictCount > 0 && res.errorCount === 0) {
        toast.warning(`Nothing undone, ${res.conflictCount} skipped: changed elsewhere`);
      } else {
        toast.error(`Could not undo changes${suffix}`);
      }
    } catch (err) {
      toast.error("Could not undo changes", { description: err instanceof Error ? err.message : undefined });
    }
  };

  const handleApplySelected = async () => {
    if (selectedItems.length === 0) return;
    const payload: OrganizeApplyItemInput[] = selectedItems.map((item) => {
      const { title, notebookId, tags } = effectiveRow(item);
      return {
        noteId: item.noteId,
        title,
        notebookId,
        addTags: tags,
        baseUpdatedTime: item.updatedTime,
      };
    });

    try {
      const res = await applyMutation.mutateAsync(payload);
      const okIds = new Set(res.results.filter((r) => r.status === "ok").map((r) => r.id));
      if (okIds.size > 0) {
        setSelectionOverrides((prev) => {
          const next = { ...prev };
          for (const id of okIds) next[id] = false;
          return next;
        });
      }

      const skips: string[] = [];
      if (res.conflictCount > 0) skips.push(`${res.conflictCount} conflict`);
      if (res.errorCount > 0) skips.push(`${res.errorCount} failed`);
      const skipSuffix = skips.length > 0 ? ` (${skips.join(", ")})` : "";

      if (res.appliedCount > 0) {
        const noun = res.appliedCount === 1 ? "note" : "notes";
        const notify = res.conflictCount > 0 || res.errorCount > 0 ? toast.warning : toast.success;
        notify(`Applied changes to ${res.appliedCount} ${noun}${skipSuffix}`, {
          action: res.canUndo
            ? {
                label: "Undo",
                onClick: () => void handleUndo(),
              }
            : undefined,
        });
      } else if (res.conflictCount > 0 && res.errorCount === 0) {
        toast.warning(`No changes applied: ${res.conflictCount} note(s) changed elsewhere`);
      } else {
        toast.error(`Could not apply selected changes${skipSuffix}`);
      }
    } catch (err) {
      toast.error("Could not apply suggestions", { description: err instanceof Error ? err.message : undefined });
    }
  };

  const handleCancelJob = async (targetJobId?: string) => {
    try {
      await cancelMutation.mutateAsync(targetJobId);
      toast.info("Auto-organize cancelled");
    } catch (err) {
      toast.error("Could not cancel job", { description: err instanceof Error ? err.message : undefined });
    }
  };

  const handleDeleteJob = async () => {
    if (!jobToDelete) return;
    try {
      await deleteMutation.mutateAsync(jobToDelete.id);
      setJobToDelete(null);
      toast.success("Auto-organize job deleted");
    } catch (err) {
      toast.error("Could not delete job", { description: err instanceof Error ? err.message : undefined });
    }
  };

  const handleRetryFailed = async () => {
    try {
      const res = await retryMutation.mutateAsync();
      toast.success(
        `Retrying ${res.requeuedCount} failed ${res.requeuedCount === 1 ? "note" : "notes"}`
      );
    } catch (err) {
      toast.error("Could not retry failed items", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const processedCount = (job?.progress.done ?? 0) + (job?.progress.failed ?? 0);
  const totalCount = job?.progress.total ?? 0;
  const percent = totalCount > 0 ? Math.min(100, Math.round((processedCount / totalCount) * 100)) : 0;
  const totalPages = job ? Math.max(1, Math.ceil(job.totalItems / ORGANIZE_PAGE_SIZE)) : 1;
  const currentPage = Math.floor(offset / ORGANIZE_PAGE_SIZE) + 1;

  const targetNotebookDisplay = (notebookId: string, fallbackPath: string): string =>
    notebookPathById.get(notebookId) ?? (fallbackPath || "Keep current");

  const excludeTagIdsFor = (tags: string[]): Set<string> => {
    const ids = new Set<string>();
    for (const tagTitle of tags) {
      const id = tagIdByLowerTitle.get(tagTitle.trim().toLowerCase());
      if (id) ids.add(id);
    }
    return ids;
  };

  const renderConfidenceBadge = (item: OrganizeJobItem) => {
    if (item.status === "pending" || item.status === "running") {
      return (
        <Badge variant="outline" className="text-[11px] font-normal gap-1 text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Analysing
        </Badge>
      );
    }
    if (item.status === "failed") {
      if (item.skipped) {
        return (
          <Badge variant="outline" className="text-[11px] border-border bg-muted/60 text-muted-foreground gap-1">
            <XCircle className="h-3 w-3" />
            Skipped
          </Badge>
        );
      }
      return (
        <Badge variant="outline" className="text-[11px] border-destructive/40 bg-destructive/10 text-destructive gap-1">
          <XCircle className="h-3 w-3" />
          Failed
        </Badge>
      );
    }
    const conf = item.suggestion?.confidence ?? 0;
    const pct = Math.round(conf * 100);
    const isVeryHigh = conf >= VERY_HIGH_CONFIDENCE_THRESHOLD;
    const isHigh = conf >= HIGH_CONFIDENCE_THRESHOLD;
    return (
      <Badge
        variant="outline"
        className={cn(
          "text-[11px] font-mono",
          isVeryHigh || isHigh
            ? "border-success/35 bg-success/10 text-success"
            : "border-warning/40 bg-warning/10 text-warning"
        )}
      >
        {isVeryHigh ? "Very high" : isHigh ? "High" : "Low"} {pct}%
      </Badge>
    );
  };

  const renderApplyBadge = (item: OrganizeJobItem) => {
    if (item.applyStatus === "ok" && item.applied) {
      return (
        <Badge variant="outline" className="text-[10px] border-success/35 bg-success/10 text-success gap-0.5">
          <Check className="h-2.5 w-2.5" />
          Applied
        </Badge>
      );
    }
    if (item.applyStatus === "conflict") {
      return (
        <Badge variant="outline" className="text-[10px] border-warning/40 bg-warning/10 text-warning gap-0.5">
          <AlertTriangle className="h-2.5 w-2.5" />
          Conflict
        </Badge>
      );
    }
    if (item.applyStatus === "error") {
      return (
        <Badge variant="outline" className="text-[10px] border-destructive/40 bg-destructive/10 text-destructive">
          Error
        </Badge>
      );
    }
    return null;
  };

  const renderNotebookSelector = (item: OrganizeJobItem) => {
    const { notebookId } = effectiveRow(item);
    const label = targetNotebookDisplay(notebookId, item.currentNotebookPath);
    const rowOpen = openNotebookRow === item.noteId;

    return (
      <Popover open={rowOpen} onOpenChange={(open) => setOpenNotebookRow(open ? item.noteId : null)}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={item.status !== "done" || applyMutation.isPending}
            aria-label={`Target notebook for ${item.currentTitle || item.noteId}`}
            className="h-8 w-full justify-start gap-1.5 text-left text-xs font-normal min-w-0"
          >
            <Folder className="h-3.5 w-3.5 text-primary shrink-0" aria-hidden="true" />
            <span className="truncate">{label}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={6} collisionPadding={12} className="w-72 max-w-[calc(100vw-1.5rem)] p-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Choose destination notebook</p>
          <NotebookPicker
            notebooks={notebooks ?? []}
            selectedId={notebookId}
            blockedIds={excludedNotebookSet}
            listClassName="max-h-52"
            autoFocusFilter
            onSelect={(nextNotebookId) => {
              updateRowEdit(item.noteId, { notebookId: nextNotebookId });
              setOpenNotebookRow(null);
            }}
          />
        </PopoverContent>
      </Popover>
    );
  };

  const renderTagsCell = (item: OrganizeJobItem) => {
    const { tags } = effectiveRow(item);
    const isAdding = openTagRow === item.noteId;
    return (
      <div className="flex flex-wrap items-center gap-1 min-w-0">
        {tags.map((tagTitle) => (
          <span
            key={tagTitle}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[11px] text-foreground max-w-full"
          >
            <TagIcon className="h-2.5 w-2.5 text-muted-foreground shrink-0" aria-hidden="true" />
            <span className="truncate">#{tagTitle}</span>
            <button
              type="button"
              onClick={() => removeRowTag(item, tagTitle)}
              aria-label={`Remove tag ${tagTitle} from ${item.currentTitle || item.noteId}`}
              className="rounded-full p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
        {item.status === "done" &&
          (isAdding ? (
            <div className="w-full max-w-[180px]">
              <TagAutocompleteInput
                excludeTagIds={excludeTagIdsFor(tags)}
                value={tagDraft}
                onValueChange={setTagDraft}
                onSubmit={(title) => addRowTag(item, title)}
                onCancel={() => {
                  setOpenTagRow(null);
                  setTagDraft("");
                }}
                inlineList
                closeOnBlur
                autoFocus
                inputClassName="h-6 w-full text-[11px]"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setTagDraft("");
                setOpenTagRow(item.noteId);
              }}
              aria-label={`Add tag to ${item.currentTitle || item.noteId}`}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:border-primary/50"
            >
              <Plus className="h-2.5 w-2.5" />
              Add
            </button>
          ))}
      </div>
    );
  };

  return (
    <AppLayout
      notebookTitle="Auto-organize"
      searchQuery={searchQuery}
      onSearchChange={(q) => {
        setSearchQuery(q);
        if (q.trim().length >= 2) {
          navigate("/notes");
        }
      }}
      readOnly={readOnly}
      readOnlyReason={readOnlyReason}
      sidebar={({ onCloseMobile }) => (
        <Sidebar
          selectedNotebookId={null}
          selectedTagId={null}
          isAllNotesSelected={false}
          isTrashSelected={false}
          isConflictsSelected={false}
          isOrganizeSelected
          conflictCount={conflictNotes?.length ?? 0}
          organizeJobCount={organizeJobs.length}
          runningOrganizeJob={hasRunningJob}
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
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onCloseMobile={onCloseMobile}
          readOnly={readOnly}
        />
      )}
    >
      {isListView ? (
        <div className="flex h-full w-full flex-col overflow-hidden bg-background">
          <div className="shrink-0 border-b border-border bg-card/40 px-4 py-3 sm:px-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate("/notes")}
                  className="h-8 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back
                </Button>
                <div className="flex items-center gap-2 min-w-0">
                  <Sparkles className="h-4 w-4 text-primary shrink-0" aria-hidden="true" />
                  <h1 className="text-base sm:text-lg font-bold text-foreground truncate">
                    Auto-organize jobs
                  </h1>
                </div>
              </div>
              {organizeJobs.length > 0 && (
                <span className="text-xs font-mono text-muted-foreground">
                  {organizeJobs.length} {organizeJobs.length === 1 ? "job" : "jobs"}
                </span>
              )}
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 sm:px-6">
            {jobsQuery.isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="rounded-xl border border-border p-4 space-y-2">
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-3 w-2/3" />
                  </div>
                ))}
              </div>
            ) : jobsQuery.error ? (
              <QueryError
                message="Couldn't load Auto-organize jobs"
                error={jobsQuery.error}
                onRetry={() => void jobsQuery.refetch()}
                isRetrying={jobsQuery.isFetching}
              />
            ) : organizeJobs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center space-y-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted/50 text-muted-foreground">
                  <Sparkles className="h-6 w-6" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium text-foreground">No Auto-organize jobs yet</p>
                  <p className="text-xs text-muted-foreground max-w-sm">
                    Select notes in any notebook and choose Auto-organize from the bulk bar to get title, notebook, and tag suggestions.
                  </p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => navigate("/notes")}>
                  Browse notes
                </Button>
              </div>
            ) : (
              <div className="space-y-3 max-w-4xl">
                {organizeJobs.map((summary) => {
                  const processed = summary.progress.done + summary.progress.failed;
                  const total = summary.progress.total;
                  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;

                  return (
                    <article
                      key={summary.id}
                      className="rounded-xl border border-border bg-card/50 p-4 space-y-3"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <Link
                              to={`/organize/${summary.id}`}
                              className="text-sm font-semibold text-foreground hover:text-primary hover:underline font-mono"
                            >
                              Job {summary.id.slice(0, 8)}
                            </Link>
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[11px] capitalize",
                                summary.status === "running" && "border-primary/40 bg-primary/10 text-primary",
                                summary.status === "done" && "border-success/35 bg-success/10 text-success",
                                summary.status === "cancelled" && "border-warning/40 bg-warning/10 text-warning",
                                summary.status === "failed" && "border-destructive/40 bg-destructive/10 text-destructive"
                              )}
                            >
                              {summary.status}
                            </Badge>
                            {summary.createdAt > 0 && (
                              <span className="text-xs text-muted-foreground">
                                {formatRelativeTime(summary.createdAt)}
                              </span>
                            )}
                          </div>
                          <p className="text-xs font-mono text-muted-foreground">
                            Analysed {processed} / {total}
                            {summary.progress.failed > 0 ? ` (${summary.progress.failed} failed)` : ""}
                            {summary.appliedCount > 0 ? ` · ${summary.appliedCount} applied` : ""}
                            {summary.usage.totalTokens > 0
                              ? ` · ${summary.usage.totalTokens.toLocaleString()} tokens`
                              : ""}
                            {summary.canUndo ? " · Undo available" : ""}
                          </p>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <Button
                            asChild
                            type="button"
                            size="sm"
                            variant={summary.status === "running" ? "outline" : "default"}
                            className="h-8 px-3 text-xs"
                          >
                            <Link to={`/organize/${summary.id}`}>
                              {summary.status === "running" ? "View progress" : "Review"}
                            </Link>
                          </Button>
                          {summary.status === "running" ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={cancelMutation.isPending}
                              onClick={() => void handleCancelJob(summary.id)}
                              className="h-8 px-2.5 text-xs"
                            >
                              Cancel
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              disabled={deleteMutation.isPending}
                              onClick={() => setJobToDelete(summary)}
                              className="h-8 px-2.5 text-xs text-muted-foreground hover:text-destructive gap-1"
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                              Delete
                            </Button>
                          )}
                        </div>
                      </div>

                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn(
                            "h-full transition-all duration-300",
                            summary.status === "failed" ? "bg-destructive" : "bg-primary"
                          )}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>

          <ConfirmDialog
            open={Boolean(jobToDelete)}
            onOpenChange={(open) => {
              if (!open && !deleteMutation.isPending) setJobToDelete(null);
            }}
            title="Delete Auto-organize job?"
            description="All saved suggestions and undo history for this job will be removed. Your notes are not changed."
            confirmLabel="Delete job"
            destructive
            isPending={deleteMutation.isPending}
            onConfirm={() => void handleDeleteJob()}
          />
        </div>
      ) : (
      <div className="flex h-full w-full flex-col overflow-hidden bg-background">
        {/* Top Header & Progress */}
        <div className="shrink-0 border-b border-border bg-card/40 px-4 py-3 sm:px-6 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (typeof window !== "undefined" && (window.history.state?.idx ?? 0) > 0) {
                    navigate(-1);
                  } else {
                    navigate("/notes");
                  }
                }}
                className="h-8 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back
              </Button>
              <Button
                asChild
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
              >
                <Link to="/organize">
                  <History className="h-3.5 w-3.5" aria-hidden="true" />
                  All jobs
                </Link>
              </Button>
              <div className="flex items-center gap-2 min-w-0">
                <Sparkles className="h-4 w-4 text-primary shrink-0" aria-hidden="true" />
                <h1 className="text-base sm:text-lg font-bold text-foreground truncate">Auto-organize</h1>
              </div>
              {job && (
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[11px] capitalize",
                    job.status === "running" && "border-primary/40 bg-primary/10 text-primary",
                    job.status === "done" && "border-success/35 bg-success/10 text-success",
                    job.status === "cancelled" && "border-warning/40 bg-warning/10 text-warning",
                    job.status === "failed" && "border-destructive/40 bg-destructive/10 text-destructive"
                  )}
                >
                  {job.status}
                </Badge>
              )}
            </div>

            {job && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-mono text-muted-foreground">
                  Analysed {processedCount} / {totalCount}
                  {job.progress.failed > 0 ? ` (${job.progress.failed} failed)` : ""}
                </span>
                {job.usage.totalTokens > 0 && (
                  <span className="text-[11px] font-mono text-muted-foreground/80 hidden sm:inline">
                    · {job.usage.totalTokens.toLocaleString()} tokens
                  </span>
                )}
                {job.status !== "running" && retryableFailedCount > 0 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={retryMutation.isPending || readOnly}
                    onClick={() => void handleRetryFailed()}
                    className="h-7 px-2.5 text-xs gap-1"
                  >
                    {retryMutation.isPending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3 w-3" />
                    )}
                    Retry failed ({retryableFailedCount})
                  </Button>
                )}
                {job.status === "running" && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={cancelMutation.isPending}
                    onClick={() => void handleCancelJob()}
                    className="h-7 px-2.5 text-xs gap-1"
                  >
                    {cancelMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                    Cancel
                  </Button>
                )}
              </div>
            )}
          </div>

          {job && (
            <div
              role="progressbar"
              aria-label="Analysis progress"
              aria-valuemin={0}
              aria-valuemax={totalCount}
              aria-valuenow={processedCount}
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            >
              <div
                className={cn(
                  "h-full transition-all duration-300",
                  job.status === "failed" ? "bg-destructive" : "bg-primary"
                )}
                style={{ width: `${percent}%` }}
              />
            </div>
          )}

          {/* Filters and Batch Actions */}
          {job && (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter suggestions">
                <Button
                  type="button"
                  size="sm"
                  variant={filter === "all" ? "secondary" : "ghost"}
                  aria-pressed={filter === "all"}
                  onClick={() => setFilter("all")}
                  className="h-7 px-2.5 text-xs"
                >
                  All ({counts.all})
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={filter === "very-high" ? "secondary" : "ghost"}
                  aria-pressed={filter === "very-high"}
                  onClick={() => setFilter("very-high")}
                  className="h-7 px-2.5 text-xs"
                >
                  Very high (&gt;= 0.85) ({counts.veryHigh})
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={filter === "high" ? "secondary" : "ghost"}
                  aria-pressed={filter === "high"}
                  onClick={() => setFilter("high")}
                  className="h-7 px-2.5 text-xs"
                >
                  High confidence ({counts.high})
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={filter === "moves" ? "secondary" : "ghost"}
                  aria-pressed={filter === "moves"}
                  onClick={() => setFilter("moves")}
                  className="h-7 px-2.5 text-xs"
                >
                  Changes notebook ({counts.moves})
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={counts.veryHigh === 0 || applyMutation.isPending}
                  onClick={selectAllVeryHigh}
                  className="h-8 px-2.5 text-xs"
                >
                  Select all very-high
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={counts.high === 0 || applyMutation.isPending}
                  onClick={selectAllHighConfidence}
                  className="h-8 px-2.5 text-xs"
                >
                  Select all high-confidence
                </Button>
                {selectedItems.length > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={applyMutation.isPending}
                    onClick={clearAllSelections}
                    className="h-8 px-2 text-xs text-muted-foreground"
                  >
                    Clear
                  </Button>
                )}
                {job.canUndo && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={undoMutation.isPending || readOnly}
                    onClick={() => void handleUndo()}
                    className="h-8 px-2.5 text-xs gap-1.5"
                  >
                    {undoMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Undo2 className="h-3.5 w-3.5" />
                    )}
                    Undo last apply
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  disabled={selectedItems.length === 0 || applyMutation.isPending || readOnly}
                  onClick={() => void handleApplySelected()}
                  className="h-8 px-3 text-xs gap-1.5"
                >
                  {applyMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                  Apply selected ({selectedItems.length})
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 sm:px-6">
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="rounded-xl border border-border p-4 space-y-2">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ))}
            </div>
          ) : error ? (
            <QueryError
              message="Couldn't load Auto-organize job"
              error={error}
              onRetry={() => void jobQuery.refetch()}
              isRetrying={jobQuery.isFetching}
            />
          ) : !job || filteredItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <p className="text-sm font-medium text-foreground">
                {items.length === 0 ? "No notes in this job" : "No suggestions match this filter"}
              </p>
              {filter !== "all" && (
                <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => setFilter("all")}>
                  Show all ({counts.all})
                </Button>
              )}
            </div>
          ) : (
            <>
              {isDesktop ? (
              <div className="overflow-x-auto rounded-xl border border-border bg-card/30">
                <table aria-label="Organize suggestions" className="w-full min-w-[780px] table-fixed border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-xs font-medium text-muted-foreground">
                      <th className="w-10 px-2.5 py-2.5 text-center">
                        <span className="sr-only">Select</span>
                      </th>
                      <th className="w-[30%] px-3 py-2.5">Title</th>
                      <th className="w-[23%] px-3 py-2.5">Notebook</th>
                      <th className="w-[21%] px-3 py-2.5">Tags</th>
                      <th className="w-[22%] px-3 py-2.5">Confidence &amp; reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filteredItems.map((item) => {
                      const checked = isRowChecked(item);
                      const { title: suggestedTitle, notebookId } = effectiveRow(item);
                      const targetPath = targetNotebookDisplay(notebookId, item.currentNotebookPath);
                      const notebookChanged = Boolean(notebookId && notebookId !== item.currentNotebookId);
                      const href = noteUrlForItem(item);

                      return (
                        <tr
                          key={item.noteId}
                          className={cn(
                            "align-top transition-colors",
                            checked ? "bg-primary/5" : "hover:bg-muted/20"
                          )}
                        >
                          <td className="px-2.5 py-3 text-center">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={item.status !== "done" || applyMutation.isPending}
                              aria-label={`Select ${item.currentTitle || item.noteId}`}
                              onChange={(e) => toggleRow(item.noteId, e.target.checked)}
                              className="mt-1 h-4 w-4 rounded border-input accent-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                            />
                          </td>

                          <td className="px-3 py-3 space-y-1.5">
                            <div className="flex items-center justify-between gap-2 min-w-0 text-xs text-muted-foreground">
                              <span className="truncate min-w-0 flex-1" title={item.currentTitle || "Untitled note"}>
                                Current: <strong className="font-medium text-foreground/80">{item.currentTitle || "Untitled note"}</strong>
                              </span>
                              <Link
                                to={href}
                                aria-label={`Open note ${item.currentTitle || item.noteId}`}
                                className="inline-flex items-center gap-1 shrink-0 text-primary hover:underline"
                              >
                                Open
                                <ExternalLink className="h-3 w-3" />
                              </Link>
                            </div>
                            {item.status === "done" ? (
                              <Input
                                value={suggestedTitle}
                                disabled={applyMutation.isPending}
                                aria-label={`Suggested title for ${item.currentTitle || item.noteId}`}
                                onChange={(e) => updateRowEdit(item.noteId, { title: e.target.value })}
                                className="h-8 text-xs font-medium"
                              />
                            ) : item.status === "failed" ? (
                              <p className={cn("text-xs", item.skipped ? "text-muted-foreground" : "text-destructive")}>
                                {item.error || "Analysis failed"}
                              </p>
                            ) : (
                              <Skeleton className="h-8 w-full" />
                            )}
                          </td>

                          <td className="px-3 py-3 space-y-1.5">
                            <div className="flex items-center gap-1 min-w-0 text-xs text-muted-foreground">
                              <span className="truncate min-w-0" title={item.currentNotebookPath || "Unknown"}>
                                {item.currentNotebookPath || "Unknown"}
                              </span>
                              {item.status === "done" && (
                                <>
                                  <ArrowRight className="h-3 w-3 shrink-0" aria-hidden="true" />
                                  <span
                                    className={cn("truncate min-w-0", notebookChanged && "font-medium text-primary")}
                                    title={targetPath}
                                  >
                                    {targetPath}
                                  </span>
                                </>
                              )}
                            </div>
                            {item.status === "done" ? (
                              renderNotebookSelector(item)
                            ) : item.status === "failed" ? null : (
                              <Skeleton className="h-8 w-full" />
                            )}
                          </td>

                          <td className="px-3 py-3">{renderTagsCell(item)}</td>

                          <td className="px-3 py-3 space-y-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              {renderConfidenceBadge(item)}
                              {item.suggestion?.documentDate && (
                                <Badge variant="outline" className="text-[10px] font-mono text-muted-foreground">
                                  {item.suggestion.documentDate}
                                </Badge>
                              )}
                              {renderApplyBadge(item)}
                            </div>
                            {item.suggestion?.reason && (
                              <p className="text-xs text-muted-foreground leading-snug break-words">{item.suggestion.reason}</p>
                            )}
                            {item.applyError && (
                              <p className="text-xs text-warning leading-snug break-words">{item.applyError}</p>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              ) : (
              <div className="space-y-3">
                {filteredItems.map((item) => {
                  const checked = isRowChecked(item);
                  const { title: suggestedTitle, notebookId } = effectiveRow(item);
                  const href = noteUrlForItem(item);

                  return (
                    <article
                      key={item.noteId}
                      className={cn(
                        "rounded-xl border border-border bg-card p-3.5 space-y-3 transition-colors",
                        checked && "border-primary/40 bg-primary/5"
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <label className="flex items-start gap-2.5 min-w-0 flex-1 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={item.status !== "done" || applyMutation.isPending}
                            aria-label={`Select ${item.currentTitle || item.noteId}`}
                            onChange={(e) => toggleRow(item.noteId, e.target.checked)}
                            className="mt-0.5 h-4 w-4 rounded border-input accent-primary shrink-0"
                          />
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-foreground truncate">
                              {item.currentTitle || "Untitled note"}
                            </p>
                            <p className="text-[11px] text-muted-foreground truncate">
                              {item.currentNotebookPath || "Unknown notebook"}
                            </p>
                          </div>
                        </label>

                        <Link
                          to={href}
                          aria-label={`Open note ${item.currentTitle || item.noteId}`}
                          className="inline-flex items-center gap-1 shrink-0 text-xs text-primary hover:underline"
                        >
                          Open
                          <ExternalLink className="h-3 w-3" />
                        </Link>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        {renderConfidenceBadge(item)}
                        {item.suggestion?.documentDate && (
                          <Badge variant="outline" className="text-[10px] font-mono text-muted-foreground">
                            {item.suggestion.documentDate}
                          </Badge>
                        )}
                        {renderApplyBadge(item)}
                      </div>

                      {item.status === "done" ? (
                        <div className="space-y-2.5">
                          <div className="space-y-1">
                            <span className="text-[11px] text-muted-foreground">Suggested title</span>
                            <Input
                              value={suggestedTitle}
                              disabled={applyMutation.isPending}
                              aria-label={`Suggested title for ${item.currentTitle || item.noteId}`}
                              onChange={(e) => updateRowEdit(item.noteId, { title: e.target.value })}
                              className="h-8 text-xs font-medium"
                            />
                          </div>

                          <div className="space-y-1">
                            <span className="text-[11px] text-muted-foreground">
                              Destination notebook{" "}
                              {notebookId !== item.currentNotebookId ? `(from ${item.currentNotebookPath})` : ""}
                            </span>
                            {renderNotebookSelector(item)}
                          </div>

                          <div className="space-y-1">
                            <span className="text-[11px] text-muted-foreground">Tags</span>
                            {renderTagsCell(item)}
                          </div>

                          {item.suggestion?.reason && (
                            <p className="text-xs text-muted-foreground leading-snug">{item.suggestion.reason}</p>
                          )}
                          {item.applyError && <p className="text-xs text-warning">{item.applyError}</p>}
                        </div>
                      ) : item.status === "failed" ? (
                        <p className={cn("text-xs", item.skipped ? "text-muted-foreground" : "text-destructive")}>
                          {item.error || "Analysis failed"}
                        </p>
                      ) : (
                        <Skeleton className="h-16 w-full" />
                      )}
                    </article>
                  );
                })}
              </div>
              )}

              {/* Pagination Controls for jobs with hundreds/thousands of notes */}
              {totalPages > 1 && (
                <div className="mt-4 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    Page {currentPage} of {totalPages} ({job.totalItems} notes)
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={offset === 0}
                      onClick={() => setOffset((prev) => Math.max(0, prev - ORGANIZE_PAGE_SIZE))}
                      className="h-7 px-2.5 text-xs"
                    >
                      Previous
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={offset + ORGANIZE_PAGE_SIZE >= job.totalItems}
                      onClick={() => setOffset((prev) => prev + ORGANIZE_PAGE_SIZE)}
                      className="h-7 px-2.5 text-xs"
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      )}
    </AppLayout>
  );
}
