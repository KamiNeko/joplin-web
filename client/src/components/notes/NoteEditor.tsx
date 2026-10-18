import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Check, Circle, Columns2, Eye, Loader2, Paperclip, PencilLine } from "lucide-react";
import { Note } from "@/lib/types";
import { ApiError, getConflictNote } from "@/lib/api";
import { invalidateLists } from "@/hooks/use-mutations";
import { useNoteSaver } from "@/hooks/use-note-saver";
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
import { useIsMobile } from "@/hooks/use-mobile";
import { getConnectionSnapshot, isConnectionFailure, setNoteUnsaved } from "@/lib/connection";
import { createRetryScheduler, RetryScheduler } from "@/lib/retry";
import { clearDraft, saveDraft, StoredDraft } from "@/lib/drafts";

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
  /** Start from a draft restored from this device instead of the server text */
  initialDraft?: StoredDraft | null;
  onDone: () => void;
}

const isSessionExpired = (err: unknown) => err instanceof ApiError && err.status === 401;

/**
 * Markdown note editor with debounced autosave, Ctrl+S, and conflict detection.
 * Initialised once from `note`; later updates to the prop are ignored so typing is never reset.
 * Unsaved text is mirrored to localStorage (see lib/drafts) until the server has it.
 */
export function NoteEditor({ note, focusTitle = false, initialDraft = null, onDone }: NoteEditorProps) {
  const queryClient = useQueryClient();
  // Split view needs the width of the lg breakpoint; below it (phones, three panes on tablets) it acts as Edit
  const noRoomForSplit = useIsMobile(1024);
  const [draft, setDraft] = useState<Draft>(
    initialDraft ? { title: initialDraft.title, body: initialDraft.body } : { title: note.title, body: note.body }
  );
  // Preview-only would leave nothing to type into for an empty note, so start in split view then
  const [mode, setMode] = useState<EditorMode>(() => {
    const stored = loadMode();
    return stored === "preview" && !note.body.trim() ? "split" : stored;
  });
  const [status, setStatus] = useState<SaveStatus>(initialDraft ? "dirty" : "saved");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Note | null>(null);
  // A newer version arrived through a refresh while the editor is open
  const [remoteChange, setRemoteChange] = useState<Note | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [uploadCount, setUploadCount] = useState(0);
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadsRef = useRef(0);

  const draftRef = useRef(draft);
  const savedRef = useRef<Draft>({ title: note.title, body: note.body });
  // Saves run one at a time; later ones chain onto the one in flight so each starts from the
  // baseUpdatedTime the previous one returned. A restored draft keeps the base it was written
  // against, so a newer server version conflicts.
  const saver = useNoteSaver(note.id, initialDraft?.baseUpdatedTime ?? note.updatedTime)!;
  const restoredRef = useRef(Boolean(initialDraft));
  // Set when the editor closes: no more saves, retries or toasts from this instance
  const unmountedRef = useRef(false);
  const retryRef = useRef<RetryScheduler | null>(null);
  const timerRef = useRef<number | null>(null);
  const conflictRef = useRef(false);

  const deferredBody = useDeferredValue(draft.body);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  /**
   * Saves the current draft. While another save is in flight, waits for it and then saves
   * whatever is still unsaved, so the returned promise tells whether the draft is now stored.
   */
  const save = useCallback(
    function save(force = false): Promise<boolean> {
      clearTimer();
      if (unmountedRef.current) return Promise.resolve(false);
      if (conflictRef.current && !force) return Promise.resolve(false);
      if (uploadsRef.current > 0) {
        timerRef.current = window.setTimeout(() => void save(force), AUTOSAVE_DELAY_MS);
        return Promise.resolve(false);
      }
      const inflight = saver.inflight;
      if (inflight) return inflight.then(() => save(force));

      const toSave = draftRef.current;
      if (!force && sameDraft(toSave, savedRef.current)) {
        setStatus("saved");
        return Promise.resolve(true);
      }

      setStatus("saving");
      setErrorMessage(null);
      return saver.send(
        { title: toSave.title, body: toSave.body, force },
        {
          onSaved: (saved) => {
            savedRef.current = toSave;
            conflictRef.current = false;
            restoredRef.current = false;
            retryRef.current?.reset();
            const upToDate = sameDraft(draftRef.current, toSave);
            if (upToDate) clearDraft(note.id);
            else saveDraft(note.id, { ...draftRef.current, baseUpdatedTime: saved.updatedTime });
            setStatus(upToDate ? "saved" : "dirty");
            // An earlier failure is resolved now
            toast.dismiss(`save-error-${note.id}`);
          },
          onError: (err) => {
            if (err instanceof ApiError && err.status === 409) {
              conflictRef.current = true;
              setConflict(getConflictNote(err));
              setStatus("conflict");
              return;
            }
            const message = err instanceof Error ? err.message : "Save failed";
            setStatus("error");
            setErrorMessage(message);
            // A closed editor reports through its flush; an expired session through its dialog
            if (unmountedRef.current || isSessionExpired(err)) return;
            // The indicator only shows "Save failed"; the toast carries the reason (one per note,
            // so repeated autosave failures replace it instead of stacking)
            toast.error("Could not save note", { id: `save-error-${note.id}`, description: message });
            // Server unreachable: try again with backoff (and right away when the browser is back online)
            if (err instanceof ApiError && isConnectionFailure(err.status) && navigator.onLine) {
              retryRef.current?.schedule();
            }
          },
        }
      );
    },
    [note.id, saver]
  );

  const updateDraft = (changes: Partial<Draft>) => {
    const next = { ...draftRef.current, ...changes };
    draftRef.current = next;
    setDraft(next);
    // Safety net until the server has the text (tab closed, connection or session lost)
    if (sameDraft(next, savedRef.current) && !restoredRef.current) clearDraft(note.id);
    else saveDraft(note.id, { ...next, baseUpdatedTime: saver.baseUpdatedTime ?? note.updatedTime });
    if (conflictRef.current) return;
    setStatus(sameDraft(next, savedRef.current) ? "saved" : "dirty");
    clearTimer();
    timerRef.current = window.setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
  };

  // A restored draft is saved like any other edit (and conflicts if the note changed since)
  useEffect(() => {
    if (!restoredRef.current) return;
    timerRef.current = window.setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
    return clearTimer;
  }, [save]);

  // Retries of failed saves belong to this editor and stop when it closes (or on logout, which
  // closes it), so a leftover timer can never write text the user has discarded since
  useEffect(() => {
    unmountedRef.current = false;
    const retry = createRetryScheduler(() => void save());
    retryRef.current = retry;
    return () => {
      unmountedRef.current = true;
      retry.dispose();
    };
  }, [save]);

  // Saves that failed while offline go out as soon as the connection is back
  useEffect(() => {
    const onOnline = () => {
      retryRef.current?.reset();
      void save();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [save]);

  // Refreshes skip notes with unsaved edits, so typing never races a refetch
  useEffect(() => {
    setNoteUnsaved(note.id, status !== "saved");
  }, [note.id, status]);
  useEffect(() => () => setNoteUnsaved(note.id, false), [note.id]);

  // Metadata-only updates (to-do toggle, move) bump updatedTime without touching the text.
  // Adopt them as the new base so the next save isn't reported as a conflict. A newer text from
  // another device replaces the text when there are no local edits; with local edits a banner lets
  // the user choose instead of waiting for the 409 at save time.
  useEffect(() => {
    if (note.updatedTime <= (saver.baseUpdatedTime ?? 0) || saver.inflight || restoredRef.current) return;
    const theirs = { title: note.title, body: note.body };
    if (sameDraft(theirs, savedRef.current)) {
      saver.rebase(note.updatedTime);
    } else if (conflictRef.current) {
      return;
    } else if (sameDraft(draftRef.current, savedRef.current) && uploadsRef.current === 0) {
      draftRef.current = theirs;
      savedRef.current = theirs;
      saver.rebase(note.updatedTime);
      setDraft(theirs);
      setEditorKey((k) => k + 1);
      setRemoteChange(null);
    } else {
      setRemoteChange(note);
    }
  }, [note, saver]);

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
      if (saver.inflight || uploadsRef.current > 0 || !sameDraft(draftRef.current, savedRef.current)) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [saver]);

  // Flush pending changes when the editor closes (switching notes, Done, ...). The flush waits for
  // any save still in flight, so it compares against (and builds on) that save's result.
  useEffect(() => {
    return () => {
      clearTimer();
      const pending = { ...draftRef.current, body: draftRef.current.body.replace(UPLOAD_PLACEHOLDER, "") };
      const reportLost = () => {
        toast.error(`Could not save "${pending.title || "Untitled"}"`, {
          description: "Your changes are kept on this device. Open the note again to restore them.",
          action: {
            label: "Copy text",
            onClick: () => void navigator.clipboard?.writeText(pending.body),
          },
          duration: 15000,
        });
      };
      const flush = (): void => {
        const inflight = saver.inflight;
        if (inflight) {
          void inflight.then(flush);
          return;
        }
        if (sameDraft(pending, savedRef.current)) return;
        // The session-expired dialog already says the draft is kept on this device
        if (getConnectionSnapshot().sessionExpired) return;
        if (conflictRef.current) {
          reportLost();
          return;
        }
        void saver.send(
          { title: pending.title, body: pending.body },
          {
            onSaved: () => {
              savedRef.current = pending;
              clearDraft(note.id);
            },
            onError: (err) => {
              if (!isSessionExpired(err)) reportLost();
            },
          }
        );
      };
      flush();
    };
  }, [note.id, saver]);

  // What the live region announces: uploads, failures and conflicts, and "Saved" only once a
  // failure or conflict is resolved (routine autosaves stay silent)
  const [announcement, setAnnouncement] = useState("");
  const hadProblemRef = useRef(false);
  useEffect(() => {
    if (uploadCount > 0) {
      setAnnouncement(`Uploading ${uploadCount} ${uploadCount === 1 ? "file" : "files"}`);
    } else if (status === "error") {
      hadProblemRef.current = true;
      setAnnouncement(errorMessage ? `Save failed: ${errorMessage}` : "Save failed");
    } else if (status === "conflict") {
      hadProblemRef.current = true;
      setAnnouncement("Conflict: this note was changed elsewhere");
    } else if (status === "saved" && hadProblemRef.current) {
      hadProblemRef.current = false;
      setAnnouncement("Saved");
    } else {
      setAnnouncement("");
    }
  }, [uploadCount, status, errorMessage]);

  const changeMode = (next: EditorMode) => {
    setMode(next);
    // On narrow screens, split already shows as Edit, so picking Edit keeps a stored split preference
    // for the next time the editor opens on a wider screen
    if (noRoomForSplit && next === "edit" && loadMode() === "split") return;
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

  /** Replaces the editor text with the server's version; unsaved text goes to the clipboard first */
  const loadVersion = async (theirs: Note | null) => {
    const mine = draftRef.current;
    if (!sameDraft(mine, savedRef.current)) {
      try {
        await navigator.clipboard?.writeText(mine.title ? `# ${mine.title}\n\n${mine.body}` : mine.body);
        toast.success("Your version was copied to the clipboard");
      } catch {
        toast.warning("Could not copy your version to the clipboard");
      }
    }
    clearTimer();
    if (theirs) {
      const next = { title: theirs.title, body: theirs.body };
      draftRef.current = next;
      savedRef.current = next;
      saver.rebase(theirs.updatedTime);
      setDraft(next);
      setEditorKey((k) => k + 1);
      queryClient.setQueryData(["note", note.id], theirs);
    }
    clearDraft(note.id);
    restoredRef.current = false;
    conflictRef.current = false;
    setConflict(null);
    setRemoteChange(null);
    setStatus("saved");
    invalidateLists(queryClient);
  };

  const resolveLoadTheirs = () => loadVersion(conflict);

  /** Keeps the editor text and makes it overwrite the version from the other device */
  const keepMine = () => {
    if (!remoteChange) return;
    saver.rebase(remoteChange.updatedTime);
    savedRef.current = { title: remoteChange.title, body: remoteChange.body };
    setRemoteChange(null);
    if (!sameDraft(draftRef.current, savedRef.current)) {
      setStatus("dirty");
      void save();
    }
  };

  // Narrow screens have no room for split view (its tab is hidden there), so it behaves like Edit
  const effectiveMode: EditorMode = noRoomForSplit && mode === "split" ? "edit" : mode;
  const showEditor = effectiveMode === "edit" || effectiveMode === "split";
  const showPreview = effectiveMode === "preview" || effectiveMode === "split";

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Editor toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 sm:px-6 py-2 border-b border-border/40">
        <div className="flex items-center rounded-lg bg-muted p-0.5" role="group" aria-label="Editor layout">
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
              aria-pressed={effectiveMode === id}
              title={label}
              onClick={() => changeMode(id)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                id === "split" && "hidden lg:flex",
                effectiveMode === id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="md:sr-only xl:not-sr-only">{label}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          {showEditor && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-muted-foreground hover:text-foreground"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Attach files"
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
          {/* Below sm only the icon is visible to keep Done in view. Screen readers get the
              visually hidden live region instead of every Unsaved/Saving/Saved change. */}
          <span role="status" aria-live="polite" className="sr-only">
            {announcement}
          </span>
          <div className="flex items-center">
            {uploadCount > 0 ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span className="sr-only sm:not-sr-only md:sr-only xl:not-sr-only">
                  Uploading {uploadCount} {uploadCount === 1 ? "file" : "files"}…
                </span>
              </span>
            ) : (
              <SaveIndicator status={status} errorMessage={errorMessage} onRetry={() => void save()} />
            )}
          </div>
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

      {remoteChange && status !== "conflict" && (
        <div
          role="status"
          className="mx-4 sm:mx-6 mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-foreground"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
          <span className="flex-1 min-w-[12rem]">This note was changed on another device.</span>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={() => void loadVersion(remoteChange)}>
              Load latest
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2.5 text-xs" onClick={keepMine}>
              Keep mine
            </Button>
          </div>
        </div>
      )}

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
            "w-full block bg-transparent text-2xl sm:text-3xl font-bold tracking-tight text-foreground placeholder:text-muted-foreground outline-none",
            effectiveMode !== "split" && "max-w-4xl mx-auto"
          )}
        />
        <div className={cn("pt-2 text-xs text-muted-foreground", effectiveMode !== "split" && "max-w-4xl mx-auto")}>
          <TagEditor noteId={note.id} tags={note.tags ?? []} />
        </div>
      </div>

      {/* Body */}
      <div
        className={cn(
          "flex-1 min-h-0 grid",
          effectiveMode === "split" ? "grid-cols-1 lg:grid-cols-2" : "grid-cols-1"
        )}
      >
        {showEditor && (
          <div
            className={cn(
              "min-h-0 overflow-hidden px-4 sm:px-10 lg:px-12 pt-2",
              effectiveMode === "split" && "lg:border-r border-border/40 lg:pr-8"
            )}
          >
            <div className={cn("h-full", effectiveMode === "edit" && "max-w-4xl mx-auto")}>
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
              effectiveMode === "split" && "hidden lg:block lg:pl-8"
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
  // Below sm only the icon is visible; the text stays available to screen readers
  const label = (text: string) => <span className="sr-only sm:not-sr-only md:sr-only xl:not-sr-only">{text}</span>;
  if (status === "saving") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> {label("Saving…")}
      </span>
    );
  }
  if (status === "dirty") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Circle className="h-2.5 w-2.5 fill-current" /> {label("Unsaved changes")}
      </span>
    );
  }
  if (status === "error") {
    return (
      <button
        type="button"
        onClick={onRetry}
        title={errorMessage ?? undefined}
        className="flex items-center gap-1.5 rounded text-xs text-destructive hover:underline outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <AlertTriangle className="h-3.5 w-3.5" /> {label("Save failed, retry")}
      </button>
    );
  }
  if (status === "conflict") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-primary">
        <AlertTriangle className="h-3.5 w-3.5" /> {label("Conflict")}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Check className="h-3.5 w-3.5" /> {label("Saved")}
    </span>
  );
}
