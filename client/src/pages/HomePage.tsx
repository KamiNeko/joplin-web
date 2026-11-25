import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Bookmark,
  CheckSquare,
  Clock,
  FilePlus2,
  FileText,
  Folder,
  Globe,
  Home,
  Loader2,
  Mic,
  NotebookPen,
  Save,
  Sparkles,
  SquareCheck,
  Star,
} from "lucide-react";
import { toast } from "sonner";
import { AppLayout } from "@/components/layout/AppLayout";
import { Sidebar } from "@/components/layout/Sidebar";
import { VoiceNoteModal, type VoiceUploadResult } from "@/components/notes/VoiceNoteModal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/common/QueryError";
import { useConflictNotes } from "@/hooks/use-notes";
import { useNotebooks } from "@/hooks/use-notebooks";
import { useCreateNote } from "@/hooks/use-mutations";
import { useOrganizeJobs, useOrganizeStatus } from "@/hooks/use-organize";
import { usePreferences, useRecentNotes, useSaveScratchpad } from "@/hooks/use-preferences";
import { useTasks } from "@/hooks/use-workspace";
import { useWriteState } from "@/hooks/use-write-state";
import { flattenNotebooks } from "@/lib/notebooks";
import { formatRelativeTime, noteDisplayTitle } from "@/lib/format";

export function HomePage() {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");
  const [captureTitle, setCaptureTitle] = useState("");
  const [captureBody, setCaptureBody] = useState("");
  const [selectedNotebookOverride, setSelectedNotebookOverride] = useState<string>("");
  const [scratchpadDraft, setScratchpadDraft] = useState<string | null>(null);
  const [voiceModalOpen, setVoiceModalOpen] = useState(false);

  const { readOnly, reason: readOnlyReason } = useWriteState();
  const { data: notebooks } = useNotebooks();
  const { data: conflictNotes } = useConflictNotes();
  const { data: organizeStatus } = useOrganizeStatus();
  const { data: organizeJobsData } = useOrganizeJobs(Boolean(organizeStatus?.enabled));
  const prefsQuery = usePreferences(!readOnly);
  const recentQuery = useRecentNotes(true);
  const tasksQuery = useTasks(true);
  const createNote = useCreateNote();
  const saveScratchpad = useSaveScratchpad();

  const organizeJobs = organizeJobsData?.jobs ?? [];
  const hasRunningJob = organizeJobs.some((j) => j.status === "running");

  const writableNotebooks = useMemo(
    () => flattenNotebooks(notebooks).filter((nb) => !nb.encrypted),
    [notebooks]
  );

  const defaultNotebookId = useMemo(() => {
    const lower = (s: string) => s.trim().toLowerCase();
    const inbox =
      writableNotebooks.find((nb) => lower(nb.title) === "inbox") ??
      writableNotebooks.find((nb) => lower(nb.title) === "pending to sort");
    return inbox?.id ?? writableNotebooks[0]?.id ?? "";
  }, [writableNotebooks]);

  const targetNotebookId = selectedNotebookOverride || defaultNotebookId;
  const scratchpadValue = scratchpadDraft ?? prefsQuery.data?.scratchpad ?? "";
  const isScratchpadDirty =
    scratchpadDraft !== null && scratchpadDraft !== (prefsQuery.data?.scratchpad ?? "");

  const scratchpadTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (scratchpadTimerRef.current !== null) window.clearTimeout(scratchpadTimerRef.current);
    };
  }, []);

  const persistScratchpad = async (text: string) => {
    if (scratchpadTimerRef.current !== null) {
      window.clearTimeout(scratchpadTimerRef.current);
      scratchpadTimerRef.current = null;
    }
    try {
      await saveScratchpad.mutateAsync(text);
      setScratchpadDraft(null);
    } catch (err) {
      toast.error("Could not save scratchpad", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const handleScratchpadChange = (next: string) => {
    setScratchpadDraft(next);
    if (scratchpadTimerRef.current !== null) window.clearTimeout(scratchpadTimerRef.current);
    scratchpadTimerRef.current = window.setTimeout(() => {
      void persistScratchpad(next);
    }, 1200);
  };

  const handleQuickCreate = async (isTodo: boolean) => {
    if (!targetNotebookId) {
      toast.error("Create a non-encrypted notebook before capturing notes");
      return;
    }
    try {
      const created = await createNote.mutateAsync({
        parentId: targetNotebookId,
        title: captureTitle.trim() || (isTodo ? "Untitled To-Do" : "Quick Note"),
        body: captureBody,
        isTodo,
      });
      setCaptureTitle("");
      setCaptureBody("");
      toast.success(isTodo ? "To-do created" : "Note created", {
        action: {
          label: "Open",
          onClick: () => navigate(`/notes/${created.id}`),
        },
      });
    } catch (err) {
      toast.error("Could not create note", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const handlePromoteScratchpad = async () => {
    const raw = scratchpadValue.trim();
    if (!raw || !targetNotebookId) return;
    const lines = raw.split(/\r?\n/);
    const firstLine = lines[0]?.replace(/^#+\s*/, "").trim() || "Scratchpad Note";
    const body = lines.length > 1 ? lines.slice(1).join("\n").trim() : raw;
    try {
      const created = await createNote.mutateAsync({
        parentId: targetNotebookId,
        title: firstLine.slice(0, 120),
        body: body || raw,
      });
      await persistScratchpad("");
      toast.success("Scratchpad promoted to note");
      navigate(`/notes/${created.id}`);
    } catch (err) {
      toast.error("Could not promote scratchpad", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const handleVoiceUploaded = async (resource: VoiceUploadResult) => {
    if (!targetNotebookId) return;
    const safeTitle = resource.title.replace(/[[\]]/g, (c) => (c === "[" ? "(" : ")"));
    const transcript = resource.transcript?.trim();
    const body = transcript
      ? `[${safeTitle}](:/${resource.id})\n\n${transcript
          .split(/\r?\n/)
          .map((line) => `> ${line}`)
          .join("\n")}\n`
      : `[${safeTitle}](:/${resource.id})\n`;
    try {
      const created = await createNote.mutateAsync({
        parentId: targetNotebookId,
        title: resource.title || "Voice note",
        body,
      });
      navigate(`/notes/${created.id}`);
    } catch (err) {
      toast.error("Recording uploaded, but failed to create note", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const openTodoNotes = (tasksQuery.data?.todoNotes ?? []).filter((n) => !n.todoCompleted);
  const openInlineTasks = (tasksQuery.data?.inlineTasks ?? []).filter((t) => !t.checked);
  const openTasksCount = openTodoNotes.length + openInlineTasks.length;

  const favoriteNotes = prefsQuery.data?.favoriteNotes ?? [];
  const favoriteNotebooks = prefsQuery.data?.favoriteNotebooks ?? [];
  const savedSearches = prefsQuery.data?.savedSearches ?? [];
  const hasAnyShortcut = favoriteNotes.length + favoriteNotebooks.length + savedSearches.length > 0;

  return (
    <AppLayout
      notebookTitle="Home"
      searchQuery={searchQuery}
      onSearchChange={(q) => {
        setSearchQuery(q);
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
          activeView="home"
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
          searchQuery={searchQuery}
          onSearchChange={(q) => {
            setSearchQuery(q);
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
        <div className="mx-auto max-w-6xl space-y-6">
          {/* Top Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-foreground">
                <Home className="h-5 w-5 text-primary" aria-hidden="true" />
                Workspace Home
              </h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                Quick capture, pinned shortcuts, recent notes, and open tasks in one place.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild variant="outline" size="sm" className="gap-1.5">
                <Link to="/clip">
                  <Globe className="h-3.5 w-3.5" />
                  Web Clipper
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm" className="gap-1.5">
                <Link to="/tasks">
                  <CheckSquare className="h-3.5 w-3.5" />
                  Tasks ({openTasksCount})
                </Link>
              </Button>
              <Button asChild size="sm" className="gap-1.5">
                <Link to="/notes">
                  <FileText className="h-3.5 w-3.5" />
                  All Notes
                </Link>
              </Button>
            </div>
          </div>

          {/* Row 1: Quick Capture + Scratchpad */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <section className="rounded-xl border border-border bg-card/60 p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <FilePlus2 className="h-4 w-4 text-primary" aria-hidden="true" />
                  Quick Capture
                </h2>
                {!readOnly && writableNotebooks.length > 0 && (
                  <select
                    aria-label="Capture target notebook"
                    value={targetNotebookId}
                    onChange={(e) => setSelectedNotebookOverride(e.target.value)}
                    className="h-7 max-w-[12rem] rounded-md border border-input bg-background px-2 text-xs text-foreground"
                  >
                    {writableNotebooks.map((nb) => (
                      <option key={nb.id} value={nb.id}>
                        {"— ".repeat(nb.depth)}
                        {nb.title}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {readOnly ? (
                <p className="text-xs text-muted-foreground py-6 text-center">
                  Quick capture is disabled while the account is read-only.
                </p>
              ) : (
                <>
                  <Input
                    value={captureTitle}
                    onChange={(e) => setCaptureTitle(e.target.value)}
                    placeholder="Title (optional)…"
                    aria-label="Quick capture title"
                  />
                  <textarea
                    value={captureBody}
                    onChange={(e) => setCaptureBody(e.target.value)}
                    rows={4}
                    placeholder="Jot down a thought, checklist (`- [ ]`), or link…"
                    aria-label="Quick capture body"
                    className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setVoiceModalOpen(true)}
                      disabled={!targetNotebookId || createNote.isPending}
                      className="gap-1.5 text-muted-foreground hover:text-foreground"
                    >
                      <Mic className="h-3.5 w-3.5" />
                      Voice note
                    </Button>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={createNote.isPending || !targetNotebookId}
                        onClick={() => void handleQuickCreate(true)}
                        className="gap-1.5"
                      >
                        <SquareCheck className="h-3.5 w-3.5" />
                        Save as To-do
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={createNote.isPending || !targetNotebookId}
                        onClick={() => void handleQuickCreate(false)}
                        className="gap-1.5"
                      >
                        {createNote.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        Save Note
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </section>

            {/* Persistent Scratchpad */}
            <section className="rounded-xl border border-border bg-card/60 p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <NotebookPen className="h-4 w-4 text-primary" aria-hidden="true" />
                  Scratchpad
                </h2>
                <span className="text-[11px] font-mono text-muted-foreground">
                  {saveScratchpad.isPending
                    ? "Saving…"
                    : isScratchpadDirty
                    ? "Unsaved"
                    : "Synced"}
                </span>
              </div>
              <textarea
                value={scratchpadValue}
                onChange={(e) => handleScratchpadChange(e.target.value)}
                readOnly={readOnly}
                rows={6}
                placeholder="Persistent scratchpad synced across your sessions…"
                aria-label="Scratchpad"
                className="flex-1 min-h-[8.5rem] w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
              {!readOnly && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!scratchpadValue.trim() || !targetNotebookId || createNote.isPending}
                    onClick={() => void handlePromoteScratchpad()}
                    className="gap-1.5"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    Promote to Note
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!isScratchpadDirty || saveScratchpad.isPending}
                    onClick={() => void persistScratchpad(scratchpadValue)}
                    className="gap-1.5"
                  >
                    <Save className="h-3.5 w-3.5" />
                    Save now
                  </Button>
                </div>
              )}
            </section>
          </div>

          {/* Row 2: Shortcuts */}
          <section className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Star className="h-4 w-4 text-amber-500" aria-hidden="true" />
                Shortcuts
              </h2>
              <span className="text-[11px] text-muted-foreground">
                Favorite notes, pinned notebooks & saved searches
              </span>
            </div>

            {prefsQuery.isLoading ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : !hasAnyShortcut ? (
              <p className="text-xs text-muted-foreground py-3">
                No shortcuts pinned yet. Star a note from the viewer, pin a notebook from the sidebar menu, or save a search query.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {favoriteNotes.map((note) => (
                  <Link
                    key={`fav-note-${note.id}`}
                    to={`/notes/${note.id}`}
                    className="flex items-center gap-2.5 rounded-lg border border-border/70 bg-background px-3 py-2 text-sm hover:border-primary/50 hover:bg-accent/40 transition-colors min-w-0"
                  >
                    <FileText className="h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-xs sm:text-sm">{noteDisplayTitle(note)}</div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {formatRelativeTime(note.updatedTime)}
                      </div>
                    </div>
                  </Link>
                ))}
                {favoriteNotebooks.map((nb) => (
                  <Link
                    key={`fav-nb-${nb.id}`}
                    to={`/notebooks/${nb.id}`}
                    className="flex items-center gap-2.5 rounded-lg border border-border/70 bg-background px-3 py-2 text-sm hover:border-primary/50 hover:bg-accent/40 transition-colors min-w-0"
                  >
                    <Folder className="h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-xs sm:text-sm">{nb.title}</div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {nb.noteCount} {nb.noteCount === 1 ? "note" : "notes"}
                      </div>
                    </div>
                  </Link>
                ))}
                {savedSearches.map((saved) => (
                  <Link
                    key={`saved-${saved.id}`}
                    to={`/notes?q=${encodeURIComponent(saved.query)}`}
                    className="flex items-center gap-2.5 rounded-lg border border-border/70 bg-background px-3 py-2 text-sm hover:border-primary/50 hover:bg-accent/40 transition-colors min-w-0"
                  >
                    <Bookmark className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-xs sm:text-sm">{saved.name}</div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">{saved.query}</div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </section>

          {/* Row 3: Recently Read & Recently Created */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <section className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Clock className="h-4 w-4 text-primary" aria-hidden="true" />
                  Recently Read
                </h2>
                <Link to="/recent" className="text-xs text-primary hover:underline">
                  View all
                </Link>
              </div>
              {recentQuery.isLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : recentQuery.error ? (
                <QueryError
                  compact
                  message="Couldn't load recent notes"
                  error={recentQuery.error}
                  onRetry={() => void recentQuery.refetch()}
                  isRetrying={recentQuery.isFetching}
                />
              ) : (recentQuery.data?.recentRead ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground py-3">
                  Open notes to see your recent reading history here.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {(recentQuery.data?.recentRead ?? []).slice(0, 6).map((note) => (
                    <Link
                      key={note.id}
                      to={`/notes/${note.id}`}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/70 px-3 py-2 hover:bg-accent/50 transition-colors"
                    >
                      <span className="truncate text-xs sm:text-sm font-medium text-foreground">
                        {noteDisplayTitle(note)}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {formatRelativeTime(note.readAt)}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <FilePlus2 className="h-4 w-4 text-primary" aria-hidden="true" />
                  Recently Created
                </h2>
                <Link to="/recent?tab=created" className="text-xs text-primary hover:underline">
                  View all
                </Link>
              </div>
              {recentQuery.isLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : recentQuery.error ? (
                <QueryError
                  compact
                  message="Couldn't load created notes"
                  error={recentQuery.error}
                  onRetry={() => void recentQuery.refetch()}
                  isRetrying={recentQuery.isFetching}
                />
              ) : (recentQuery.data?.recentCreated ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground py-3">No recently created notes yet.</p>
              ) : (
                <div className="space-y-1.5">
                  {(recentQuery.data?.recentCreated ?? []).slice(0, 6).map((note) => (
                    <Link
                      key={note.id}
                      to={`/notes/${note.id}`}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/70 px-3 py-2 hover:bg-accent/50 transition-colors"
                    >
                      <span className="truncate text-xs sm:text-sm font-medium text-foreground">
                        {noteDisplayTitle(note)}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {formatRelativeTime(note.createdTime)}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </section>
          </div>

          {/* Row 4: Open Tasks Summary */}
          <section className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <CheckSquare className="h-4 w-4 text-primary" aria-hidden="true" />
                Open Tasks ({openTasksCount})
              </h2>
              <Link to="/tasks" className="text-xs text-primary hover:underline">
                Open Tasks Hub
              </Link>
            </div>
            {tasksQuery.isLoading ? (
              <Skeleton className="h-12 w-full" />
            ) : openTasksCount === 0 ? (
              <p className="text-xs text-muted-foreground py-2">All caught up! No open to-dos or checklists.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {openTodoNotes.slice(0, 4).map((todo) => (
                  <Link
                    key={`todo-${todo.id}`}
                    to={`/notes/${todo.id}`}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-background px-3 py-2 text-xs hover:bg-accent/40 transition-colors"
                  >
                    <span className="truncate font-medium text-foreground">{noteDisplayTitle(todo)}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{todo.notebookTitle}</span>
                  </Link>
                ))}
                {openInlineTasks.slice(0, Math.max(0, 6 - Math.min(4, openTodoNotes.length))).map((item) => (
                  <Link
                    key={`inline-${item.noteId}-${item.line}-${item.column}`}
                    to={`/notes/${item.noteId}`}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-background px-3 py-2 text-xs hover:bg-accent/40 transition-colors"
                  >
                    <span className="truncate text-foreground">{item.text}</span>
                    <span className="shrink-0 truncate max-w-[8rem] text-[10px] text-muted-foreground">
                      {item.noteTitle || "Untitled"}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      <VoiceNoteModal
        open={voiceModalOpen}
        onOpenChange={setVoiceModalOpen}
        onUploaded={(res) => void handleVoiceUploaded(res)}
      />
    </AppLayout>
  );
}
