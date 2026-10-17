import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Check, Columns2, Eye, Loader2, Paperclip, PencilLine } from "lucide-react";
import { Note } from "@/lib/types";
import { ApiError, getConflictNote, updateNote } from "@/lib/api";
import { invalidateLists } from "@/hooks/use-mutations";
import { setTaskChecked } from "@/lib/tasks";
import { MarkdownEditor, MarkdownEditorHandle, UPLOAD_PLACEHOLDER } from "./MarkdownEditor";
import { TagEditor } from "@/components/tags/TagEditor";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const AUTOSAVE_DELAY_MS = 1500;
const MODE_STORAGE_KEY = "joplin-editor-mode";

type EditorMode = "edit" | "split" | "preview";
type SaveStatus = "saved" | "dirty" | "saving" | "error" | "conflict";

interface Draft {
  title: string;
  body: string;
}

function sameDraft(a: Draft, b: Draft) {
  return a.title === b.title && a.body === b.body;
}

function loadMode(): EditorMode {
  try {
    const stored = localStorage.getItem(MODE_STORAGE_KEY);
    if (stored === "edit" || stored === "split" || stored === "preview") return stored;
  } catch {
    // storage unavailable
  }
  return "split";
}

interface NoteEditorProps {
  note: Note;
  /** Focus the title instead of the body (used for freshly created notes) */
  focusTitle?: boolean;
  onDone: () => void;
}

/**
 * Markdown note editor with debounced autosave, Ctrl+S, and conflict detection.
 * Initialised once from `note`; later updates to the prop are ignored so typing is never reset.
 */
export function NoteEditor({ note, focusTitle = false, onDone }: NoteEditorProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>({ title: note.title, body: note.body });
  // Preview-only would leave nothing to type into for an empty note, so start in split view then
  const [mode, setMode] = useState<EditorMode>(() => {
    const stored = loadMode();
    return stored === "preview" && !note.body.trim() ? "split" : stored;
  });
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Note | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [uploadCount, setUploadCount] = useState(0);
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadsRef = useRef(0);

  const draftRef = useRef(draft);
  const savedRef = useRef<Draft>({ title: note.title, body: note.body });
  const baseUpdatedTimeRef = useRef(note.updatedTime);
  const savingRef = useRef(false);
  const queuedRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const conflictRef = useRef(false);

  const deferredBody = useDeferredValue(draft.body);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const save = useCallback(
    async (force = false): Promise<boolean> => {
      clearTimer();
      if (conflictRef.current && !force) return false;
      if (uploadsRef.current > 0) {
        timerRef.current = window.setTimeout(() => void save(force), AUTOSAVE_DELAY_MS);
        return false;
      }
      if (savingRef.current) {
        queuedRef.current = true;
        return false;
      }
      const toSave = draftRef.current;
      if (!force && sameDraft(toSave, savedRef.current)) {
        setStatus("saved");
        return true;
      }

      savingRef.current = true;
      setStatus("saving");
      setErrorMessage(null);
      try {
        const saved = await updateNote(note.id, {
          title: toSave.title,
          body: toSave.body,
          baseUpdatedTime: baseUpdatedTimeRef.current,
          force,
        });
        baseUpdatedTimeRef.current = saved.updatedTime;
        savedRef.current = toSave;
        conflictRef.current = false;
        queryClient.setQueryData(["note", note.id], saved);
        invalidateLists(queryClient);
        setStatus(sameDraft(draftRef.current, toSave) ? "saved" : "dirty");
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          conflictRef.current = true;
          setConflict(getConflictNote(err));
          setStatus("conflict");
        } else {
          setStatus("error");
          setErrorMessage(err instanceof Error ? err.message : "Save failed");
        }
        return false;
      } finally {
        savingRef.current = false;
        if (queuedRef.current) {
          queuedRef.current = false;
          if (!conflictRef.current && !sameDraft(draftRef.current, savedRef.current)) {
            void save();
          }
        }
      }
    },
    [note.id, queryClient]
  );

  const updateDraft = (changes: Partial<Draft>) => {
    const next = { ...draftRef.current, ...changes };
    draftRef.current = next;
    setDraft(next);
    if (conflictRef.current) return;
    setStatus(sameDraft(next, savedRef.current) ? "saved" : "dirty");
    clearTimer();
    timerRef.current = window.setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
  };

  // Metadata-only updates (to-do toggle, move) bump updatedTime without touching the text.
  // Adopt them as the new base so the next save isn't reported as a conflict.
  useEffect(() => {
    if (
      note.updatedTime > baseUpdatedTimeRef.current &&
      !savingRef.current &&
      sameDraft({ title: note.title, body: note.body }, savedRef.current)
    ) {
      baseUpdatedTimeRef.current = note.updatedTime;
    }
  }, [note.updatedTime, note.title, note.body]);

  // Ctrl+S / Cmd+S saves immediately
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [save]);

  // Warn before closing the tab with unsaved changes
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (savingRef.current || uploadsRef.current > 0 || !sameDraft(draftRef.current, savedRef.current)) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // Flush pending changes when the editor closes (switching notes, Done, ...)
  useEffect(() => {
    return () => {
      clearTimer();
      const pending = { ...draftRef.current, body: draftRef.current.body.replace(UPLOAD_PLACEHOLDER, "") };
      if (conflictRef.current || sameDraft(pending, savedRef.current)) return;
      updateNote(note.id, {
        title: pending.title,
        body: pending.body,
        baseUpdatedTime: baseUpdatedTimeRef.current,
      })
        .then((saved) => {
          queryClient.setQueryData(["note", note.id], saved);
          invalidateLists(queryClient);
        })
        .catch(() => {
          toast.error(`Could not save "${pending.title || "Untitled"}"`, {
            description: "Your last changes were not saved.",
            action: {
              label: "Copy text",
              onClick: () => void navigator.clipboard?.writeText(pending.body),
            },
            duration: 15000,
          });
        });
    };
  }, [note.id, queryClient]);

  const changeMode = (next: EditorMode) => {
    setMode(next);
    try {
      localStorage.setItem(MODE_STORAGE_KEY, next);
    } catch {
      // storage unavailable
    }
  };

  const handleUploadsChange = (pending: number) => {
    uploadsRef.current = pending;
    setUploadCount(pending);
  };

  const handleDone = async () => {
    if (status === "conflict" || uploadsRef.current > 0) return;
    if (await save()) onDone();
  };

  const resolveOverwrite = async () => {
    setConflict(null);
    conflictRef.current = false;
    await save(true);
  };

  const resolveLoadTheirs = async () => {
    const mine = draftRef.current;
    try {
      await navigator.clipboard?.writeText(mine.title ? `# ${mine.title}\n\n${mine.body}` : mine.body);
      toast.success("Your version was copied to the clipboard");
    } catch {
      toast.warning("Could not copy your version to the clipboard");
    }
    const theirs = conflict;
    if (theirs) {
      const next = { title: theirs.title, body: theirs.body };
      draftRef.current = next;
      savedRef.current = next;
      baseUpdatedTimeRef.current = theirs.updatedTime;
      setDraft(next);
      setEditorKey((k) => k + 1);
      queryClient.setQueryData(["note", note.id], theirs);
    }
    conflictRef.current = false;
    setConflict(null);
    setStatus("saved");
    invalidateLists(queryClient);
  };

  const showEditor = mode === "edit" || mode === "split";
  const showPreview = mode === "preview" || mode === "split";

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Editor toolbar */}
      <div className="flex items-center justify-between gap-2 px-4 sm:px-6 py-2 border-b border-border/40">
        <div className="flex items-center rounded-lg bg-muted p-0.5" role="tablist" aria-label="Editor layout">
          {(
            [
              { id: "edit", label: "Edit", icon: PencilLine },
              { id: "split", label: "Split", icon: Columns2 },
              { id: "preview", label: "Preview", icon: Eye },
            ] as const
          ).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={mode === id}
              onClick={() => changeMode(id)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                id === "split" && "hidden md:flex",
                mode === id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          {showEditor && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-muted-foreground hover:text-foreground"
                onClick={() => fileInputRef.current?.click()}
                title="Attach images or files (or drop / paste them into the text)"
              >
                <Paperclip className="h-3.5 w-3.5" />
                <span className="hidden lg:inline">Attach</span>
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  editorRef.current?.insertFiles(files);
                }}
              />
            </>
          )}
          {uploadCount > 0 ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Uploading {uploadCount} {uploadCount === 1 ? "file" : "files"}…
            </span>
          ) : (
            <SaveIndicator status={status} errorMessage={errorMessage} onRetry={() => void save()} />
          )}
          <Button
            size="sm"
            className="h-8"
            onClick={() => void handleDone()}
            disabled={status === "conflict" || uploadCount > 0}
          >
            Done
          </Button>
        </div>
      </div>

      {/* Title */}
      <div className="px-4 sm:px-10 lg:px-12 pt-6 pb-2">
        <input
          value={draft.title}
          onChange={(e) => updateDraft({ title: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              // In preview-only mode there is no editor to jump to, so open the split view first
              if (mode === "preview") setMode("split");
              window.setTimeout(() => (document.querySelector(".cm-content") as HTMLElement | null)?.focus(), 0);
            }
          }}
          autoFocus={focusTitle}
          placeholder="Untitled"
          aria-label="Note title"
          className={cn(
            "w-full block bg-transparent text-2xl sm:text-3xl font-bold tracking-tight text-foreground placeholder:text-muted-foreground/50 outline-none",
            mode !== "split" && "max-w-4xl mx-auto"
          )}
        />
        <div className={cn("pt-2 text-xs text-muted-foreground", mode !== "split" && "max-w-4xl mx-auto")}>
          <TagEditor noteId={note.id} tags={note.tags ?? []} />
        </div>
      </div>

      {/* Body */}
      <div
        className={cn(
          "flex-1 min-h-0 grid",
          mode === "split" ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1"
        )}
      >
        {showEditor && (
          <div
            className={cn(
              "min-h-0 overflow-hidden px-4 sm:px-10 lg:px-12 pt-2",
              mode === "split" && "md:border-r border-border/40 md:pr-6 lg:pr-8"
            )}
          >
            <div className={cn("h-full", mode === "edit" && "max-w-4xl mx-auto")}>
              <MarkdownEditor
                ref={editorRef}
                key={editorKey}
                onUploadsChange={handleUploadsChange}
                value={draft.body}
                onChange={(body) => updateDraft({ body })}
                autoFocus={!focusTitle}
                className="h-full"
              />
            </div>
          </div>
        )}
        {showPreview && (
          <div
            className={cn(
              "min-h-0 overflow-y-auto px-4 sm:px-10 lg:px-12 pt-2 pb-20",
              mode === "split" && "hidden md:block md:pl-6 lg:pl-8"
            )}
          >
            <div className="max-w-4xl mx-auto">
              {deferredBody.trim() ? (
                <MarkdownRenderer
                  content={deferredBody}
                  onToggleTask={(location, checked) => {
                    // The location refers to the rendered text; ignore clicks on a preview that
                    // hasn't caught up with the latest typing yet
                    if (deferredBody !== draftRef.current.body) return;
                    const body = setTaskChecked(draftRef.current.body, location, checked);
                    if (body !== null) updateDraft({ body });
                  }}
                />
              ) : (
                <p className="text-sm text-muted-foreground italic">Nothing to preview yet.</p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Conflict resolution */}
      <Dialog open={status === "conflict"} onOpenChange={() => undefined}>
        <DialogContent
          onEscapeKeyDown={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          className="[&>button:last-child]:hidden"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-primary" />
              This note was changed elsewhere
            </DialogTitle>
            <DialogDescription>
              Someone (or another device) saved a newer version of this note while you were editing.
              Choose which version to keep.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => void resolveLoadTheirs()}>
              Load their version
            </Button>
            <Button onClick={() => void resolveOverwrite()}>Keep mine (overwrite)</Button>
          </DialogFooter>
          <p className="text-xs text-muted-foreground -mt-1">
            "Load their version" copies your text to the clipboard first.
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SaveIndicator({
  status,
  errorMessage,
  onRetry,
}: {
  status: SaveStatus;
  errorMessage: string | null;
  onRetry: () => void;
}) {
  if (status === "saving") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
      </span>
    );
  }
  if (status === "dirty") {
    return <span className="text-xs text-muted-foreground">Unsaved changes</span>;
  }
  if (status === "error") {
    return (
      <button
        type="button"
        onClick={onRetry}
        title={errorMessage ?? undefined}
        className="flex items-center gap-1.5 text-xs text-destructive hover:underline"
      >
        <AlertTriangle className="h-3.5 w-3.5" /> Save failed, retry
      </button>
    );
  }
  if (status === "conflict") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-primary">
        <AlertTriangle className="h-3.5 w-3.5" /> Conflict
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Check className="h-3.5 w-3.5" /> Saved
    </span>
  );
}
