import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  CheckSquare,
  Circle,
  ExternalLink,
  ListChecks,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { AppLayout } from "@/components/layout/AppLayout";
import { Sidebar } from "@/components/layout/Sidebar";
import { QueryError } from "@/components/common/QueryError";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useConflictNotes } from "@/hooks/use-notes";
import { useUpdateNote } from "@/hooks/use-mutations";
import { useOrganizeJobs, useOrganizeStatus } from "@/hooks/use-organize";
import { TASKS_QUERY_KEY, useTasks, useToggleInlineTask } from "@/hooks/use-workspace";
import { useWriteState } from "@/hooks/use-write-state";
import { ApiError } from "@/lib/api";
import { formatDueDate, isOverdue } from "@/lib/due";
import { noteDisplayTitle } from "@/lib/format";
import type { InlineTaskItem, TodoTaskItem } from "@/lib/types";
import { cn } from "@/lib/utils";

type TaskFilter = "open" | "overdue" | "completed" | "inline" | "todos";

type UnifiedTask =
  | {
      kind: "todo";
      key: string;
      noteId: string;
      title: string;
      noteTitle: string;
      notebookTitle: string;
      completed: boolean;
      dueMs: number;
      overdue: boolean;
      updatedTime: number;
      raw: TodoTaskItem;
    }
  | {
      kind: "inline";
      key: string;
      noteId: string;
      title: string;
      noteTitle: string;
      notebookTitle: string;
      completed: boolean;
      dueMs: number;
      overdue: boolean;
      updatedTime: number;
      raw: InlineTaskItem;
    };

export function TasksPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [headerSearch, setHeaderSearch] = useState("");
  const [filterText, setFilterText] = useState("");
  const [tab, setTab] = useState<TaskFilter>("open");
  const [mountTime] = useState(() => Date.now());

  const { readOnly, reason: readOnlyReason } = useWriteState();
  const { data: conflictNotes } = useConflictNotes();
  const { data: organizeStatus } = useOrganizeStatus();
  const { data: organizeJobsData } = useOrganizeJobs(Boolean(organizeStatus?.enabled));
  const tasksQuery = useTasks(true);
  const updateNote = useUpdateNote();
  const toggleInline = useToggleInlineTask();

  const organizeJobs = organizeJobsData?.jobs ?? [];
  const hasRunningJob = organizeJobs.some((j) => j.status === "running");

  const allTasks = useMemo<UnifiedTask[]>(() => {
    const todoList: UnifiedTask[] = (tasksQuery.data?.todoNotes ?? []).map((t) => ({
      kind: "todo",
      key: `todo-${t.id}`,
      noteId: t.id,
      title: noteDisplayTitle(t),
      noteTitle: noteDisplayTitle(t),
      notebookTitle: t.notebookTitle || "Notebook",
      completed: Boolean(t.todoCompleted),
      dueMs: t.todoDue ?? 0,
      overdue: isOverdue({ isTodo: true, todoDue: t.todoDue, todoCompleted: t.todoCompleted }, mountTime),
      updatedTime: t.updatedTime,
      raw: t,
    }));

    const inlineList: UnifiedTask[] = (tasksQuery.data?.inlineTasks ?? []).map((t) => ({
      kind: "inline",
      key: `inline-${t.noteId}-${t.line}-${t.column}`,
      noteId: t.noteId,
      title: t.text,
      noteTitle: t.noteTitle || "Untitled Note",
      notebookTitle: t.notebookTitle || "Notebook",
      completed: t.checked,
      dueMs: 0,
      overdue: false,
      updatedTime: t.updatedTime,
      raw: t,
    }));

    return [...todoList, ...inlineList].sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      if (a.dueMs && b.dueMs && a.dueMs !== b.dueMs) return a.dueMs - b.dueMs;
      return b.updatedTime - a.updatedTime;
    });
  }, [tasksQuery.data, mountTime]);

  const counts = useMemo(() => {
    let open = 0;
    let overdue = 0;
    let completed = 0;
    let inline = 0;
    let todos = 0;
    for (const item of allTasks) {
      if (item.completed) completed++;
      else open++;
      if (item.overdue) overdue++;
      if (item.kind === "inline") inline++;
      else todos++;
    }
    return { open, overdue, completed, inline, todos };
  }, [allTasks]);

  const filteredTasks = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    return allTasks.filter((item) => {
      if (tab === "open" && item.completed) return false;
      if (tab === "overdue" && !item.overdue) return false;
      if (tab === "completed" && !item.completed) return false;
      if (tab === "inline" && item.kind !== "inline") return false;
      if (tab === "todos" && item.kind !== "todo") return false;
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        item.noteTitle.toLowerCase().includes(q) ||
        item.notebookTitle.toLowerCase().includes(q)
      );
    });
  }, [allTasks, tab, filterText]);

  const handleToggle = async (task: UnifiedTask) => {
    if (readOnly) return;
    if (task.kind === "todo") {
      try {
        await updateNote.mutateAsync({
          id: task.noteId,
          changes: { todoCompleted: !task.completed },
        });
        await queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY });
      } catch (err) {
        toast.error("Could not update to-do", {
          description: err instanceof Error ? err.message : undefined,
        });
      }
      return;
    }

    try {
      await toggleInline.mutateAsync({
        noteId: task.noteId,
        line: task.raw.line,
        column: task.raw.column,
        checked: !task.completed,
        baseUpdatedTime: task.updatedTime,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.warning("Checklist moved since this list loaded; refreshed.");
      } else {
        toast.error("Could not toggle checklist item", {
          description: err instanceof Error ? err.message : undefined,
        });
      }
    }
  };

  return (
    <AppLayout
      notebookTitle="Tasks"
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
          activeView="tasks"
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
      <div className="flex flex-col h-full bg-background overflow-hidden">
        <div className="shrink-0 border-b border-border bg-card/40 px-4 py-4 sm:px-8 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="flex items-center gap-2 text-xl font-bold text-foreground">
                <CheckSquare className="h-5 w-5 text-primary" aria-hidden="true" />
                Tasks Hub
              </h1>
              <p className="text-xs text-muted-foreground">
                To-do notes and interactive `- [ ]` checkboxes aggregated across your notes.
              </p>
            </div>
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                placeholder="Filter tasks…"
                aria-label="Filter tasks"
                className="h-8 pl-8 text-xs"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                { id: "open", label: `Open (${counts.open})` },
                { id: "overdue", label: `Overdue (${counts.overdue})` },
                { id: "completed", label: `Completed (${counts.completed})` },
                { id: "todos", label: `To-do Notes (${counts.todos})` },
                { id: "inline", label: `Checklists (${counts.inline})` },
              ] as const
            ).map((opt) => (
              <Button
                key={opt.id}
                type="button"
                size="sm"
                variant={tab === opt.id ? "default" : "outline"}
                onClick={() => setTab(opt.id)}
                className="h-7 px-2.5 text-xs"
              >
                {opt.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 sm:px-8">
          <div className="mx-auto max-w-4xl">
            {tasksQuery.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : tasksQuery.error ? (
              <QueryError
                message="Couldn't load tasks"
                error={tasksQuery.error}
                onRetry={() => void tasksQuery.refetch()}
                isRetrying={tasksQuery.isFetching}
              />
            ) : filteredTasks.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center space-y-2">
                <ListChecks className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm font-medium text-foreground">No tasks in this view</p>
                <p className="text-xs text-muted-foreground max-w-sm">
                  Create a Joplin to-do note or add `- [ ]` checkboxes inside any Markdown note.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {filteredTasks.map((task) => {
                  const busy = updateNote.isPending || toggleInline.isPending;
                  return (
                    <div
                      key={task.key}
                      className={cn(
                        "flex items-start gap-3 rounded-xl border border-border bg-card/50 px-3.5 py-2.5 transition-colors hover:bg-card",
                        task.completed && "opacity-70"
                      )}
                    >
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={task.completed}
                        aria-label={`Toggle "${task.title}"`}
                        disabled={readOnly || busy}
                        onClick={() => void handleToggle(task)}
                        className="mt-0.5 shrink-0 text-primary disabled:opacity-50"
                      >
                        {task.completed ? (
                          <CheckCircle2 className="h-4 w-4 text-success" />
                        ) : (
                          <Circle className="h-4 w-4 text-muted-foreground hover:text-primary" />
                        )}
                      </button>

                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          {task.kind === "todo" ? (
                            <Link
                              to={`/notes/${task.noteId}`}
                              className={cn(
                                "inline-flex items-center gap-1 text-sm font-medium text-foreground hover:text-primary hover:underline",
                                task.completed && "line-through text-muted-foreground"
                              )}
                            >
                              <span>{task.title}</span>
                              <ExternalLink className="h-3 w-3 shrink-0 opacity-70" />
                            </Link>
                          ) : (
                            <span
                              className={cn(
                                "text-sm font-medium text-foreground",
                                task.completed && "line-through text-muted-foreground"
                              )}
                            >
                              {task.title}
                            </span>
                          )}
                          <Badge variant="outline" className="text-[10px] font-normal">
                            {task.kind === "todo" ? "To-do" : "Checklist"}
                          </Badge>
                          {task.dueMs > 0 && (
                            <span
                              className={cn(
                                "inline-flex items-center gap-1 text-[11px] font-mono",
                                task.overdue ? "text-destructive font-semibold" : "text-muted-foreground"
                              )}
                            >
                              {task.overdue ? (
                                <AlertCircle className="h-3 w-3" />
                              ) : (
                                <Calendar className="h-3 w-3" />
                              )}
                              {formatDueDate(task.dueMs)}
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          {task.kind === "inline" && (
                            <>
                              <Link
                                to={`/notes/${task.noteId}`}
                                className="inline-flex items-center gap-1 hover:text-primary hover:underline truncate"
                              >
                                <span>{task.noteTitle}</span>
                                <ExternalLink className="h-3 w-3 shrink-0" />
                              </Link>
                              <span aria-hidden="true">·</span>
                            </>
                          )}
                          <span className="truncate font-mono text-[11px]">{task.notebookTitle}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
