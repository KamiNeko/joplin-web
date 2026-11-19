import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Clock, FilePlus2, Search, Star, X } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Sidebar } from "@/components/layout/Sidebar";
import { NoteViewer } from "@/components/notes/NoteViewer";
import { QueryError } from "@/components/common/QueryError";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useConflictNotes, useNote } from "@/hooks/use-notes";
import { useNotebooks } from "@/hooks/use-notebooks";
import { useOrganizeJobs, useOrganizeStatus } from "@/hooks/use-organize";
import { usePreferences, useRecentNotes, useRecordRecentRead } from "@/hooks/use-preferences";
import { useWriteState } from "@/hooks/use-write-state";
import { formatRelativeTime, noteDisplayTitle } from "@/lib/format";
import { cn } from "@/lib/utils";

type RecentTab = "read" | "created";

export function RecentPage() {
  const { id: selectedNoteId = null } = useParams<{ id?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const tab: RecentTab = searchParams.get("tab") === "created" ? "created" : "read";
  const [headerSearchQuery, setHeaderSearchQuery] = useState("");
  const [filterText, setFilterText] = useState("");

  const { readOnly, reason: readOnlyReason } = useWriteState();
  const { data: notebooks } = useNotebooks();
  const { data: conflictNotes } = useConflictNotes();
  const { data: organizeStatus } = useOrganizeStatus();
  const { data: organizeJobsData } = useOrganizeJobs(Boolean(organizeStatus?.enabled));
  const { data: preferences } = usePreferences(!readOnly);
  const recentQuery = useRecentNotes(true);
  const noteQuery = useNote(selectedNoteId);
  const recordRecentRead = useRecordRecentRead();

  const organizeJobs = organizeJobsData?.jobs ?? [];
  const hasRunningJob = organizeJobs.some((j) => j.status === "running");

  const favoriteNoteIds = useMemo(
    () => new Set(preferences?.favoriteNoteIds ?? []),
    [preferences?.favoriteNoteIds]
  );

  // Record note view after settling for 500ms
  const lastRecordedRef = useRef<string | null>(null);
  const recordReadMutateRef = useRef(recordRecentRead.mutate);
  useEffect(() => {
    recordReadMutateRef.current = recordRecentRead.mutate;
  }, [recordRecentRead.mutate]);

  useEffect(() => {
    if (!selectedNoteId || readOnly) return;
    if (lastRecordedRef.current === selectedNoteId) return;
    const timer = window.setTimeout(() => {
      lastRecordedRef.current = selectedNoteId;
      recordReadMutateRef.current(selectedNoteId);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [selectedNoteId, readOnly]);

  const items = useMemo(() => {
    const raw =
      tab === "created"
        ? (recentQuery.data?.recentCreated ?? []).map((n) => ({ ...n, timestamp: n.createdTime }))
        : (recentQuery.data?.recentRead ?? []).map((n) => ({ ...n, timestamp: n.readAt }));
    const q = filterText.trim().toLowerCase();
    if (!q) return raw;
    return raw.filter(
      (n) =>
        (n.title || "").toLowerCase().includes(q) ||
        (n.preview || "").toLowerCase().includes(q)
    );
  }, [tab, recentQuery.data, filterText]);

  const setTab = (nextTab: RecentTab) => {
    const next = new URLSearchParams(searchParams);
    if (nextTab === "created") next.set("tab", "created");
    else next.delete("tab");
    setSearchParams(next, { replace: true });
  };

  const openNote = (noteId: string) => {
    const suffix = tab === "created" ? "?tab=created" : "";
    navigate(`/recent/${noteId}${suffix}`);
  };

  return (
    <AppLayout
      notebookTitle="Recent Notes"
      noteTitle={noteQuery.data?.title}
      searchQuery={headerSearchQuery}
      onSearchChange={(q) => {
        setHeaderSearchQuery(q);
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
          activeView="recent"
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
          searchQuery={headerSearchQuery}
          onSearchChange={(q) => {
            setHeaderSearchQuery(q);
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
      <div className="flex h-full w-full overflow-hidden">
        {/* Left pane: Recent List */}
        <div
          className={cn(
            "w-full md:w-80 lg:w-96 shrink-0 h-full border-r border-border flex flex-col bg-card/30",
            selectedNoteId ? "hidden md:flex" : "flex"
          )}
        >
          <div className="p-4 border-b border-border/60 space-y-3 shrink-0">
            <div>
              <h2 className="text-base font-bold tracking-tight text-foreground">Recent Notes</h2>
              <p className="text-xs text-muted-foreground">Jump back into recently read or newly created notes</p>
            </div>

            <div role="tablist" aria-label="Recent note categories" className="grid grid-cols-2 rounded-lg bg-muted p-0.5">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "read"}
                onClick={() => setTab("read")}
                className={cn(
                  "flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors",
                  tab === "read"
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                Recently Read
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "created"}
                onClick={() => setTab("created")}
                className={cn(
                  "flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors",
                  tab === "created"
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <FilePlus2 className="h-3.5 w-3.5" aria-hidden="true" />
                Recently Created
              </button>
            </div>

            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                placeholder="Filter recent notes…"
                aria-label="Filter recent notes"
                className="h-8 pl-8 pr-8 text-xs"
              />
              {filterText && (
                <button
                  type="button"
                  onClick={() => setFilterText("")}
                  aria-label="Clear filter"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto">
            {recentQuery.isLoading ? (
              <div className="p-4 space-y-3">
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
              </div>
            ) : recentQuery.error ? (
              <div className="p-4">
                <QueryError
                  compact
                  message="Couldn't load recent notes"
                  error={recentQuery.error}
                  onRetry={() => void recentQuery.refetch()}
                  isRetrying={recentQuery.isFetching}
                />
              </div>
            ) : items.length === 0 ? (
              <div className="px-4 py-12 text-center space-y-1">
                <p className="text-sm font-medium text-foreground">
                  {filterText
                    ? "No matching recent notes"
                    : tab === "read"
                    ? "No reading history yet"
                    : "No recently created notes"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {tab === "read"
                    ? "Open any note to record it in your reading history."
                    : "New notes you create will appear here."}
                </p>
              </div>
            ) : (
              <div className="divide-y divide-border/50">
                {items.map((item) => {
                  const selected = selectedNoteId === item.id;
                  const starred = favoriteNoteIds.has(item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => openNote(item.id)}
                      className={cn(
                        "w-full text-left px-4 py-3 transition-colors hover:bg-muted/50 space-y-1",
                        selected && "bg-primary/10"
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 min-w-0 font-semibold text-sm text-foreground">
                          {starred && <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-500" aria-hidden="true" />}
                          <span className="truncate">{noteDisplayTitle(item)}</span>
                        </span>
                        <span className="shrink-0 text-[11px] font-mono text-muted-foreground">
                          {formatRelativeTime(item.timestamp)}
                        </span>
                      </div>
                      {item.preview && (
                        <p className="text-xs text-muted-foreground line-clamp-2">{item.preview}</p>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right pane: Note Viewer */}
        <div
          className={cn(
            "flex-1 h-full min-w-0",
            !selectedNoteId ? "hidden md:flex flex-col" : "flex flex-col"
          )}
        >
          <NoteViewer
            key={selectedNoteId ?? "none"}
            note={selectedNoteId ? noteQuery.data : null}
            notebooks={notebooks}
            readOnly={readOnly}
            isLoading={Boolean(selectedNoteId && noteQuery.isLoading)}
            error={noteQuery.data ? null : noteQuery.error}
            isStale={Boolean(noteQuery.data && noteQuery.isError)}
            onRetry={() => void noteQuery.refetch()}
            isRetrying={noteQuery.isFetching}
            onTagClick={(tagId) => navigate(`/notes?tag=${encodeURIComponent(tagId)}`)}
            onNotebookClick={(nbId) => navigate(`/notebooks/${nbId}`)}
            onOpenNote={openNote}
            onClose={() => navigate(tab === "created" ? "/recent?tab=created" : "/recent")}
            onRemoved={() => navigate(tab === "created" ? "/recent?tab=created" : "/recent")}
          />
        </div>
      </div>
    </AppLayout>
  );
}
