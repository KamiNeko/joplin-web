import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { MARKUP_HTML, Note, Notebook } from "@/lib/types";
import { flattenNotebooks } from "@/lib/notebooks";
import { setTaskChecked, type TaskLocation } from "@/lib/tasks";
import { getConflictNote } from "@/lib/api";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { ConfirmDialog } from "@/components/common/Dialogs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Calendar,
  Clock,
  Folder,
  FolderInput,
  CheckCircle2,
  Circle,
  AlertCircle,
  FileCode,
  FileText,
  GitCompareArrows,
  History,
  Link,
  Lock,
  MoreHorizontal,
  PencilLine,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { formatRelativeTime, noteDisplayTitle } from "@/lib/format";
import { TagEditor } from "@/components/tags/TagEditor";
import { TodoDueDate } from "./TodoDueDate";
import { Button } from "@/components/ui/button";
import { useDeleteNote, useRestoreNote, useUpdateNote } from "@/hooks/use-mutations";
import { useNoteSaver } from "@/hooks/use-note-saver";
import { cn } from "@/lib/utils";
import { QueryError, StaleDataHint } from "@/components/common/QueryError";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { copyText } from "@/lib/clipboard";
import { noteMarkdownLink } from "@/lib/markdown-format";
import { clearDraft, findRestorableDraft, restoreStoredDraft, StoredDraft } from "@/lib/drafts";

// The editor brings CodeMirror and its language data, so it is a separate chunk
const loadNoteEditor = () => import("./NoteEditor");
const lazyNoteEditor = () => lazy(() => loadNoteEditor().then((m) => ({ default: m.NoteEditor })));
// React.lazy keeps a failed import for good, so Retry replaces it with a fresh one
let NoteEditor = lazyNoteEditor();

interface NoteViewerProps {
  note?: Note | null;
  isLoading?: boolean;
  error?: Error | null;
  /** A refetch failed while the note loaded earlier is still shown */
  isStale?: boolean;
  onRetry?: () => void;
  isRetrying?: boolean;
  notebooks?: Notebook[];
  /** The account can't be written (end-to-end encryption): no editing, tags, to-do or trash actions */
  readOnly?: boolean;
  /** Open the note directly in the editor (e.g. right after creating it) */
  startInEdit?: boolean;
  onTagClick?: (tagId: string) => void;
  onNotebookClick?: (notebookId: string) => void;
  /** Opens another note, e.g. the original of a conflict copy */
  onOpenNote?: (noteId: string) => void;
  onClose?: () => void;
  /** Called after the note was moved to the trash or deleted permanently */
  onRemoved?: () => void;
}

// A note usually arrives within a few hundred milliseconds; showing the skeleton only after this
// keeps a quick first open from flashing it
const SKELETON_DELAY_MS = 300;

/** Placeholder while a note loads; stays blank for quick loads. */
function NoteSkeleton() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), SKELETON_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return <div className="h-full bg-background" aria-busy="true" />;
  return (
    <div className="flex flex-col h-full bg-background p-6 lg:p-8 space-y-6 animate-in fade-in duration-300" aria-busy="true">
      <div className="space-y-3">
        <Skeleton className="h-9 w-3/4" />
        <div className="flex gap-3">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-5 w-32" />
        </div>
      </div>
      <div className="space-y-4 pt-4">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    </div>
  );
}

export function NoteViewer({
  note,
  isLoading = false,
  error = null,
  isStale = false,
  onRetry,
  isRetrying = false,
  notebooks,
  readOnly = false,
  startInEdit = false,
  onTagClick,
  onNotebookClick,
  onOpenNote,
  onClose,
  onRemoved,
}: NoteViewerProps) {
  const [isEditing, setIsEditing] = useState(startInEdit);
  // Unsaved text left on this device by an earlier session (failed save, closed tab, expired login)
  // Checked during the first render, so an editor opened right away (startInEdit) waits for the decision
  const [restorable, setRestorable] = useState<StoredDraft | null>(() => (note ? findRestorableDraft(note) : null));
  const [restoredDraft, setRestoredDraft] = useState<StoredDraft | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  // Bumped by Retry after the editor chunk failed to load
  const [editorAttempt, setEditorAttempt] = useState(0);
  const loadedNoteId = note?.id;
  const draftCheckedRef = useRef<string | null>(note?.id ?? null);
  useEffect(() => {
    if (!note || draftCheckedRef.current === note.id) return;
    draftCheckedRef.current = note.id;
    setRestorable(findRestorableDraft(note));
    // Only once per note: later refetches must not bring back a dismissed offer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedNoteId]);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const updateNote = useUpdateNote();
  const deleteNote = useDeleteNote();
  const restoreNote = useRestoreNote();
  const toggleTask = useTaskToggle(note?.id);
  // Fetch the editor chunk while the note is read, so Edit opens without a wait (and works offline)
  useEffect(() => {
    if (loadedNoteId) void loadNoteEditor().catch(() => undefined);
  }, [loadedNoteId]);

  if (isLoading) {
    return <NoteSkeleton />;
  }

  if (error) {
    return (
      <div className="flex flex-col h-full">
        {onClose && (
          <div className="md:hidden px-4 py-3 border-b border-border/40">
            <Button variant="ghost" size="sm" className="h-8" onClick={onClose}>
              <X className="h-3.5 w-3.5" />
              Close
            </Button>
          </div>
        )}
        <QueryError
          className="flex-1 h-auto"
          message="Couldn't load note"
          error={error}
          onRetry={onRetry}
          isRetrying={isRetrying}
        />
      </div>
    );
  }

  if (!note) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center select-none bg-background">
        <div className="h-16 w-16 rounded-2xl bg-muted/40 border border-border/50 flex items-center justify-center text-muted-foreground mb-4 shadow-xs">
          <FileText className="h-8 w-8 opacity-40" />
        </div>
        <h3 className="text-lg font-semibold text-foreground">No note selected</h3>
        <p className="text-xs text-muted-foreground mt-1 max-w-xs leading-relaxed">
          Select a note from the list or create a new one.
        </p>
      </div>
    );
  }

  const isTrashed = Boolean(note.deletedTime && note.deletedTime > 0);
  // A copy Joplin kept after a sync conflict; it is listed only under Conflicts
  const isConflict = Boolean(note.isConflict);
  const conflictOriginalId =
    isConflict && note.conflictOriginalId && /^[0-9a-f]{32}$/.test(note.conflictOriginalId) ? note.conflictOriginalId : null;
  const isEncrypted = Boolean(note.encrypted);
  // Nothing can be written: the account is read-only or the note itself is encrypted
  const locked = readOnly || isEncrypted;
  const canEdit = !isTrashed && !locked;
  // Editing would overwrite the stored draft, so the user decides about it first
  const editing = isEditing && canEdit && !restorable;
  const title = noteDisplayTitle(note);
  const updatedRelative = formatRelativeTime(note.updatedTime);
  const createdDate = note.createdTime
    ? new Date(
        note.createdTime < 10000000000 ? note.createdTime * 1000 : note.createdTime
      ).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null;
  const flatNotebooks = flattenNotebooks(notebooks);

  const handleToggleTodo = () => {
    updateNote.mutate(
      { id: note.id, changes: { todoCompleted: !note.todoCompleted } },
      { onError: (err) => toast.error("Could not update to-do", { description: err.message }) }
    );
  };

  const handleMove = (notebookId: string, title: string) => {
    updateNote.mutate(
      { id: note.id, changes: { parentId: notebookId } },
      {
        onSuccess: () => toast.success(`Moved to "${title}"`),
        onError: (err) => toast.error("Could not move note", { description: err.message }),
      }
    );
  };

  const handleCopyLink = async () => {
    const link = noteMarkdownLink(note);
    if (await copyText(link)) toast.success("Markdown link copied");
    else toast.error("Could not copy the link", { description: link });
  };

  const handleTrash = () => {
    const noteId = note.id;
    deleteNote.mutate(
      { id: noteId },
      {
        onSuccess: () => {
          toast.success("Note moved to trash", {
            action: { label: "Undo", onClick: () => restoreNote.mutate(noteId) },
          });
          onRemoved?.();
        },
        onError: (err) => toast.error("Could not move note to trash", { description: err.message }),
      }
    );
  };

  const handleRestore = () => {
    restoreNote.mutate(note.id, {
      onSuccess: () => toast.success("Note restored"),
      onError: (err) => toast.error("Could not restore note", { description: err.message }),
    });
  };

  const handlePurge = () => {
    deleteNote.mutate(
      { id: note.id, permanent: true },
      {
        onSuccess: () => {
          setConfirmPurge(false);
          toast.success("Note deleted permanently");
          onRemoved?.();
        },
        onError: (err) => toast.error("Could not delete note", { description: err.message }),
      }
    );
  };

  const handleRestoreDraft = () => {
    if (!restorable) return;
    setRestoredDraft(restorable);
    setRestorable(null);
    // Remount an open editor so it starts from the draft
    setEditorKey((k) => k + 1);
    setIsEditing(true);
  };

  const retryEditor = () => {
    // Failing again after a fresh import usually means the chunk is gone (new deployment): reload
    if (editorAttempt > 0) {
      window.location.reload();
      return;
    }
    NoteEditor = lazyNoteEditor();
    setEditorAttempt((n) => n + 1);
  };

  const closeBrokenEditor = () => {
    // A restored draft is still stored on this device; offer it again
    if (restoredDraft) setRestorable(restoredDraft);
    setRestoredDraft(null);
    setIsEditing(false);
  };

  const handleDiscardDraft = () => {
    const draft = restorable;
    if (!draft) return;
    clearDraft(note.id);
    setRestorable(null);
    toast("Unsaved changes discarded", {
      action: {
        label: "Undo",
        onClick: () => {
          restoreStoredDraft(note.id, draft);
          setRestorable(draft);
        },
      },
    });
  };

  return (
    <div className="flex flex-col h-full bg-background relative overflow-hidden">
      {/* Header bar */}
      <div className="px-4 sm:px-6 py-3 border-b border-border/40 flex items-center justify-between gap-3 bg-background/80 backdrop-blur-xs z-10">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          {note.notebookTitle && (
            <button
              type="button"
              onClick={() => onNotebookClick?.(note.notebookId)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors border border-border/40"
            >
              <Folder className="h-3.5 w-3.5 text-primary" />
              <span className="truncate max-w-[160px]">{note.notebookTitle}</span>
            </button>
          )}

          {note.isTodo && (
            <button
              type="button"
              onClick={handleToggleTodo}
              disabled={!canEdit || updateNote.isPending}
              aria-pressed={Boolean(note.todoCompleted)}
              aria-label={note.todoCompleted ? "Done: mark as not done" : "To do: mark as done"}
              title={note.todoCompleted ? "Mark as not done" : "Mark as done"}
              className={cn(
                "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-60",
                note.todoCompleted
                  ? "bg-success/10 text-success border-success/30 hover:bg-success/20"
                  : "bg-warning/10 text-warning border-warning/30 hover:bg-warning/20"
              )}
            >
              {note.todoCompleted ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
              {note.todoCompleted ? "Done" : "To do"}
            </button>
          )}

          {isConflict && (
            <Badge variant="outline" className="text-xs gap-1 bg-warning/10 text-warning border-warning/30">
              <GitCompareArrows className="h-3 w-3" />
              Conflict
            </Badge>
          )}
          <TodoDueDate note={note} readOnly={!canEdit} />

          {isTrashed && (
            <Badge
              variant="destructive"
              className="text-xs gap-1 bg-destructive/15 text-destructive border-destructive/30"
            >
              <AlertCircle className="h-3 w-3" />
              In Trash
            </Badge>
          )}

          {isEncrypted && (
            <Badge variant="outline" className="text-xs gap-1 border-primary/30 bg-primary/10 text-foreground">
              <Lock className="h-3 w-3 text-primary" />
              Encrypted
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {locked ? null : isTrashed ? (
            <>
              <Button size="sm" variant="outline" className="h-8" onClick={handleRestore} disabled={restoreNote.isPending}>
                <RotateCcw className="h-3.5 w-3.5" />
                Restore
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={() => setConfirmPurge(true)}
                aria-label="Delete permanently"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Delete permanently</span>
              </Button>
            </>
          ) : (
            <>
              {!editing && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  onClick={() => setIsEditing(true)}
                  disabled={Boolean(restorable)}
                  title={restorable ? "Restore or discard the unsaved changes first" : undefined}
                >
                  <PencilLine className="h-3.5 w-3.5" />
                  Edit
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-foreground"
                    aria-label="More note actions"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger className="gap-2">
                      <FolderInput className="h-4 w-4" />
                      Move to notebook
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="max-h-80 overflow-y-auto w-56">
                      {flatNotebooks.map((nb) => (
                        <DropdownMenuItem
                          key={nb.id}
                          // Moving a conflict copy turns it into a regular note, its own notebook included;
                          // an encrypted notebook can't take a cleartext note
                          disabled={(nb.id === note.notebookId && !isConflict) || nb.encrypted}
                          onClick={() => handleMove(nb.id, nb.title)}
                          style={{ paddingLeft: `${8 + nb.depth * 12}px` }}
                        >
                          <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="truncate">{nb.title}</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  {note.isTodo && (
                    <DropdownMenuItem onClick={handleToggleTodo}>
                      {note.todoCompleted ? <Circle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                      {note.todoCompleted ? "Mark as not done" : "Mark as done"}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => void handleCopyLink()}>
                    <Link className="h-4 w-4" />
                    Copy Markdown link
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={handleTrash}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                    Move to trash
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}

          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-8 w-8 md:hidden text-muted-foreground hover:text-foreground"
              aria-label="Close note view"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {isStale && <StaleDataHint className="px-4 sm:px-6 pt-2" onRetry={onRetry} isRetrying={isRetrying} />}

      {restorable && canEdit && (
        <div
          role="status"
          className="mx-4 sm:mx-6 mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-foreground"
        >
          <History className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
          <span className="flex-1 min-w-48">
            Unsaved changes from{" "}
            {new Date(restorable.savedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} are
            stored on this device.
          </span>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={handleRestoreDraft}>
              Restore
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2.5 text-xs" onClick={handleDiscardDraft}>
              Discard
            </Button>
          </div>
        </div>
      )}

      {editing ? (
        <ErrorBoundary
          key={editorAttempt}
          fallback={() => (
            <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <AlertCircle className="h-6 w-6 text-destructive" aria-hidden="true" />
              <p className="text-sm font-medium text-foreground">Editor could not be loaded</p>
              <p className="max-w-xs text-xs text-muted-foreground">Check your connection and try again.</p>
              <div className="flex gap-2">
                <Button size="sm" onClick={retryEditor}>
                  Retry
                </Button>
                <Button size="sm" variant="ghost" onClick={closeBrokenEditor}>
                  Back to reading
                </Button>
              </div>
            </div>
          )}
        >
          <Suspense fallback={<div className="flex-1" aria-busy="true" />}>
            <NoteEditor
              key={editorKey}
              note={note}
              focusTitle={startInEdit && !note.title}
              initialDraft={restoredDraft}
              onDone={() => {
                setRestoredDraft(null);
                setIsEditing(false);
              }}
            />
          </Suspense>
        </ErrorBoundary>
      ) : (
        <ScrollArea className="flex-1 px-6 sm:px-10 lg:px-12 py-8">
          <div className="max-w-4xl mx-auto space-y-6 pb-20">
            {isConflict && !isTrashed && (
              <div
                role="note"
                className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3.5 rounded-xl bg-warning/10 border border-warning/30 text-foreground text-xs"
              >
                <GitCompareArrows className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                <span className="flex-1 min-w-48 leading-relaxed">
                  <strong>Conflict copy.</strong> Joplin kept this version because the note was changed on two
                  devices at once. Compare it with the original and copy what you need, then move it to the
                  trash. Moving it to a notebook keeps it as a regular note.
                </span>
                {conflictOriginalId && onOpenNote && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2.5 text-xs"
                    onClick={() => onOpenNote(conflictOriginalId)}
                  >
                    Open original
                  </Button>
                )}
              </div>
            )}

            {isTrashed && (
              <div className="flex items-center gap-2.5 p-3.5 rounded-xl bg-destructive/10 border border-destructive/25 text-destructive text-xs">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>
                  <strong>This note is in the trash.</strong>
                  {!locked && " Restore it to edit it again, or delete it permanently."}
                </span>
              </div>
            )}

            <div className="space-y-3">
              <h1
                className="text-2xl/tight sm:text-3xl/9 lg:text-4xl/10 font-bold tracking-tight text-foreground"
                onDoubleClick={() => canEdit && setIsEditing(true)}
              >
                {title}
              </h1>

              <div className="flex flex-wrap items-center gap-y-2 gap-x-4 text-xs text-muted-foreground pt-1 border-b border-border/40 pb-4">
                {updatedRelative && (
                  <div className="flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5" />
                    <span>Updated {updatedRelative}</span>
                  </div>
                )}

                {createdDate && (
                  <div className="flex items-center gap-1.5">
                    <Calendar className="h-3.5 w-3.5" />
                    <span>Created {createdDate}</span>
                  </div>
                )}

                {note.markupLanguage === MARKUP_HTML && (
                  <div className="flex items-center gap-1.5" title="This note is stored as HTML, e.g. saved with the Joplin Web Clipper">
                    <FileCode className="h-3.5 w-3.5" />
                    <span>HTML note</span>
                  </div>
                )}

                <TagEditor
                  noteId={note.id}
                  tags={note.tags ?? []}
                  // Tags of conflict copies are not counted or listed anywhere, so don't add any
                  readOnly={!canEdit || isConflict}
                  onTagClick={onTagClick}
                />
              </div>
            </div>

            <div className="pt-2">
              {isEncrypted ? (
                <div className="flex items-start gap-2.5 p-3.5 rounded-xl bg-primary/10 border border-primary/25 text-foreground text-xs">
                  <Lock className="h-4 w-4 shrink-0 text-primary" />
                  <span>
                    <strong>This note is end-to-end encrypted.</strong> Joplin Web can't decrypt it, so its title and
                    content can't be shown or changed here. Open it in the Joplin desktop or mobile app.
                  </span>
                </div>
              ) : note.body.trim() ? (
                <MarkdownRenderer
                  content={note.body}
                  html={note.markupLanguage === MARKUP_HTML}
                  onToggleTask={canEdit ? toggleTask : undefined}
                />
              ) : canEdit ? (
                <button
                  type="button"
                  onClick={() => setIsEditing(true)}
                  className="text-sm text-muted-foreground italic hover:text-foreground"
                >
                  This note is empty. Click to start writing.
                </button>
              ) : (
                <p className="text-sm text-muted-foreground italic">This note is empty.</p>
              )}
            </div>
          </div>
        </ScrollArea>
      )}

      <ConfirmDialog
        open={confirmPurge}
        onOpenChange={setConfirmPurge}
        title="Delete note permanently?"
        description={
          <>
            "{title}" will be removed from your Joplin server and all synced devices.
            This cannot be undone.
          </>
        }
        confirmLabel="Delete permanently"
        destructive
        isPending={deleteNote.isPending}
        onConfirm={handlePurge}
      />
    </div>
  );
}

const TASK_SAVE_DELAY_MS = 600;

/**
 * Checkbox toggling in read mode: updates the cached note immediately and saves the body
 * shortly after (one save at a time, so quick successive clicks don't conflict with each other).
 */
function useTaskToggle(noteId: string | undefined) {
  const queryClient = useQueryClient();
  const saver = useNoteSaver(noteId);
  const timerRef = useRef<number | null>(null);

  // Flush a pending save when the note is closed instead of dropping it
  const saveRef = useRef<(() => Promise<void>) | undefined>(undefined);
  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        void saveRef.current?.();
      }
    },
    []
  );

  const save = async () => {
    timerRef.current = null;
    if (!noteId || !saver) return;
    if (saver.inflight) {
      timerRef.current = window.setTimeout(() => void save(), TASK_SAVE_DELAY_MS);
      return;
    }
    const cached = queryClient.getQueryData<Note>(["note", noteId]);
    if (!cached) return;

    // The new body is built from the cached note, so that is the version it is based on. The cache
    // also holds what the editor saved, so a save there never makes this one a false conflict.
    saver.rebase(cached.updatedTime);
    await saver.send(
      { body: cached.body },
      {
        // Keep any newer optimistic body (more clicks while saving); its save is already scheduled
        toCache: (saved) => ({ ...saved, body: queryClient.getQueryData<Note>(["note", noteId])?.body ?? saved.body }),
        onError: (err) => {
          if (timerRef.current !== null) window.clearTimeout(timerRef.current);
          timerRef.current = null;
          const current = getConflictNote(err);
          if (current) {
            queryClient.setQueryData(["note", noteId], current);
            toast.error("This note was changed elsewhere", {
              description: "Your checkbox change was not saved. The latest version is shown now.",
            });
          } else {
            queryClient.invalidateQueries({ queryKey: ["note", noteId] });
            toast.error("Could not update checkbox", {
              description: err instanceof Error ? err.message : undefined,
            });
          }
        },
      }
    );
  };

  useEffect(() => {
    saveRef.current = save;
  });

  return (location: TaskLocation, checked: boolean) => {
    if (!noteId) return;
    const cached = queryClient.getQueryData<Note>(["note", noteId]);
    if (!cached) return;
    const body = setTaskChecked(cached.body, location, checked);
    if (body === null) return;
    queryClient.setQueryData<Note>(["note", noteId], { ...cached, body });
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void save(), TASK_SAVE_DELAY_MS);
  };
}
