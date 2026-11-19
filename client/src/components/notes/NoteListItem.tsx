import { memo, useEffect, useRef, useState } from "react";
import { NoteListItem as NoteListItemType, Tag } from "@/lib/types";
import { getResourceUrl } from "@/lib/api";
import { getCachedPdfThumbnail, getPdfThumbnail } from "@/lib/pdf-thumbnail";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatRelativeTime, noteDisplayTitle } from "@/lib/format";
import { dueTime, formatDueDate, isOverdue } from "@/lib/due";
import type { SelectionModifiers } from "@/hooks/use-note-selection";
import { AlarmClock, Check, CheckSquare, FileText, Lock, Square, Star } from "lucide-react";

interface NoteListItemProps {
  note: NoteListItemType & {
    tags?: Tag[];
    isTodo?: boolean;
    todoCompleted?: boolean;
    todoDue?: number;
  };
  isActive?: boolean;
  isFavorite?: boolean;
  selectionMode?: boolean;
  isSelected?: boolean;
  onClick?: () => void;
  /** Modifier-aware click handler used by NoteList (kept stable for memoization) */
  onActivate?: (id: string, modifiers: SelectionModifiers) => void;
  /** Toggles a to-do's completion; the checkbox is read-only when omitted */
  onToggleTodo?: () => void;
  /** Stable to-do toggle callback used by NoteList for memoization */
  onToggleTodoById?: (id: string, completed: boolean) => void;
}

/**
 * Evernote-style card thumbnail: an image as is (the browser lazy-loads it), a PDF as its first page,
 * rendered once the card comes near the viewport. Hidden when it can't be loaded.
 */
function NoteThumbnail({ resourceId, kind }: NonNullable<NoteListItemType["thumbnail"]>) {
  const ref = useRef<HTMLSpanElement>(null);
  // Load result for one resource; a null url means it failed
  const [result, setResult] = useState<{ resourceId: string; url: string | null } | null>(null);
  const own = result?.resourceId === resourceId ? result : null;
  const url = own
    ? own.url
    : kind === "image"
      ? getResourceUrl(resourceId)
      : getCachedPdfThumbnail(resourceId)?.url;

  useEffect(() => {
    if (kind !== "pdf" || getCachedPdfThumbnail(resourceId)) return;
    let cancelled = false;
    const load = () =>
      getPdfThumbnail(resourceId)
        .then((thumb) => thumb.url, () => null)
        .then((thumbUrl) => !cancelled && setResult({ resourceId, url: thumbUrl }));
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      void load();
      return () => {
        cancelled = true;
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          void load();
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(element);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [kind, resourceId]);

  if (url === null) return null;
  return (
    <span ref={ref} className="block h-16 w-14 shrink-0 overflow-hidden rounded-md border border-border/60 bg-white">
      {url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setResult({ resourceId, url: null })}
          className="block h-full w-full object-cover object-top"
        />
      ) : (
        <span className="block h-full w-full animate-pulse bg-muted" />
      )}
    </span>
  );
}

export const NoteListItem = memo(function NoteListItem({
  note,
  isActive,
  isFavorite = false,
  selectionMode = false,
  isSelected = false,
  onClick,
  onActivate,
  onToggleTodo,
  onToggleTodoById,
}: NoteListItemProps) {
  const relativeTime = formatRelativeTime(note.updatedTime || note.createdTime);
  const title = noteDisplayTitle(note);
  const NoteIcon = note.encrypted ? Lock : FileText;
  const due = dueTime(note);
  const overdue = isOverdue(note);

  const handleActivate = (modifiers: SelectionModifiers) => {
    if (onActivate) {
      onActivate(note.id, modifiers);
    } else {
      onClick?.();
    }
  };

  const canToggleTodo = Boolean(onToggleTodo || onToggleTodoById);
  const triggerTodoToggle = () => {
    if (onToggleTodoById) {
      onToggleTodoById(note.id, !note.todoCompleted);
    } else {
      onToggleTodo?.();
    }
  };

  return (
    <div
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey || (selectionMode && e.shiftKey)) {
          e.preventDefault();
        }
        handleActivate({ shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
      }}
      role="button"
      tabIndex={0}
      aria-current={isActive ? "true" : undefined}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleActivate({ shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
        }
      }}
      className={cn(
        "group relative flex min-w-0 flex-col gap-1.5 p-3.5 rounded-xl border border-l-2 text-left transition-all duration-150 cursor-pointer outline-hidden focus-visible:ring-2 focus-visible:ring-primary",
        selectionMode && "select-none",
        selectionMode && isSelected
          ? "bg-primary/10 border-primary/40 border-l-primary"
          : isActive
            ? "bg-card border-border border-l-primary"
            : "bg-transparent border-transparent hover:bg-muted/60"
      )}
    >

      {/* Header: Title and Time */}
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {selectionMode && (
            <button
              type="button"
              role="checkbox"
              aria-checked={Boolean(isSelected)}
              aria-label={`Select ${title}`}
              onClick={(e) => {
                e.stopPropagation();
                handleActivate({ shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
              }}
              onKeyDown={(e) => {
                if (e.key !== "Escape") e.stopPropagation();
              }}
              className={cn(
                "shrink-0 mt-0.5 flex h-4 w-4 items-center justify-center rounded-sm border transition-colors outline-hidden focus-visible:ring-2 focus-visible:ring-primary",
                isSelected
                  ? "bg-primary border-primary text-primary-foreground"
                  : "border-muted-foreground/50 bg-background hover:border-primary"
              )}
            >
              {isSelected && <Check className="h-3 w-3 stroke-[3]" aria-hidden="true" />}
            </button>
          )}
          {note.isTodo ? (
            <button
              type="button"
              disabled={!canToggleTodo}
              onClick={(e) => {
                e.stopPropagation();
                triggerTodoToggle();
              }}
              onKeyDown={(e) => {
                if (e.key !== "Escape") e.stopPropagation();
              }}
              role="checkbox"
              aria-checked={Boolean(note.todoCompleted)}
              aria-label={`Done: ${title}`}
              className="shrink-0 mt-0.5 rounded-sm enabled:hover:scale-110 transition-transform focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary"
            >
              {note.todoCompleted ? (
                <CheckSquare className="h-4 w-4 text-success" />
              ) : (
                <Square className="h-4 w-4 text-warning" />
              )}
            </button>
          ) : (
            <NoteIcon
              className={cn(
                "h-4 w-4 shrink-0 mt-0.5 transition-colors",
                isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
              )}
            />
          )}
          <h3
            className={cn(
              "font-semibold text-sm leading-snug truncate",
              isActive ? "text-foreground font-bold" : "text-foreground/90 group-hover:text-foreground",
              note.isTodo && note.todoCompleted && "line-through text-muted-foreground",
              note.encrypted && "italic"
            )}
          >
            {title}
          </h3>
          {isFavorite && (
            <Star className="h-3.5 w-3.5 shrink-0 fill-amber-500 text-amber-500" aria-hidden="true" />
          )}
        </div>

        {relativeTime && (
          <span className="text-[11px] shrink-0 text-muted-foreground font-mono">
            {relativeTime}
          </span>
        )}
      </div>

      {/* Preview Snippet, with the first image or PDF beside it */}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {note.encrypted ? (
            <p className="text-xs text-muted-foreground italic">End-to-end encrypted, can't be shown here</p>
          ) : note.preview ? (
            <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed wrap-break-word">
              {note.preview}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground italic">Empty note</p>
          )}
        </div>
        {note.thumbnail && !note.encrypted && <NoteThumbnail {...note.thumbnail} />}
      </div>

      {due > 0 && (
        <p
          className={cn(
            "flex items-center gap-1 text-[11px] font-medium",
            overdue ? "text-destructive" : "text-muted-foreground"
          )}
        >
          <AlarmClock className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span>
            {overdue ? "Overdue" : "Due"} {formatDueDate(due)}
          </span>
        </p>
      )}

      {/* Tags if present */}
      {note.tags && note.tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 pt-1">
          {note.tags.slice(0, 3).map((tag) => (
            <Badge
              key={tag.id}
              variant="outline"
              className="text-[10px] px-1.5 py-0 h-4 rounded-md bg-muted border-transparent text-muted-foreground font-normal"
            >
              #{tag.title}
            </Badge>
          ))}
          {note.tags.length > 3 && (
            <span className="text-[10px] text-muted-foreground">
              +{note.tags.length - 3}
            </span>
          )}
        </div>
      )}
    </div>
  );
});
