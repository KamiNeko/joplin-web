import { NoteListItem as NoteListItemType, Tag } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { CheckSquare, Square, FileText } from "lucide-react";

interface NoteListItemProps {
  note: NoteListItemType & {
    tags?: Tag[];
    isTodo?: boolean;
    todoCompleted?: boolean;
  };
  isActive?: boolean;
  onClick?: () => void;
  /** Toggles a to-do's completion; the checkbox is read-only when omitted */
  onToggleTodo?: () => void;
}

/**
 * Formats epoch timestamp or date string into human-friendly relative time.
 */
export function formatRelativeTime(timestamp: number | string | undefined): string {
  if (!timestamp) return "";

  let ms: number;
  if (typeof timestamp === "string") {
    ms = new Date(timestamp).getTime();
  } else if (timestamp < 10000000000) {
    // timestamp in seconds
    ms = timestamp * 1000;
  } else {
    // timestamp in milliseconds
    ms = timestamp;
  }

  if (isNaN(ms)) return "";

  const now = Date.now();
  const diffSec = Math.floor((now - ms) / 1000);

  if (diffSec < 45) return "just now";
  if (diffSec < 90) return "1 min ago";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} mins ago`;
  if (diffSec < 7200) return "1 hour ago";
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} hours ago`;
  if (diffSec < 172800) return "yesterday";
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)} days ago`;

  const date = new Date(ms);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
}

export function NoteListItem({ note, isActive, onClick, onToggleTodo }: NoteListItemProps) {
  const relativeTime = formatRelativeTime(note.updatedTime || note.createdTime);

  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
      className={cn(
        "group relative flex flex-col gap-1.5 p-3.5 rounded-xl border text-left transition-all duration-150 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary",
        isActive
          ? "bg-card border-primary/40 shadow-sm"
          : "bg-transparent border-transparent hover:bg-muted/60"
      )}
    >
      {/* Active accent pill indicator */}
      {isActive && (
        <span className="absolute left-0 top-3 bottom-3 w-1 bg-primary rounded-r-full" />
      )}

      {/* Header: Title and Time */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {note.isTodo ? (
            <button
              type="button"
              disabled={!onToggleTodo}
              onClick={(e) => {
                e.stopPropagation();
                onToggleTodo?.();
              }}
              onKeyDown={(e) => e.stopPropagation()}
              aria-label={note.todoCompleted ? "Mark as not done" : "Mark as done"}
              className="shrink-0 mt-0.5 rounded-sm enabled:hover:scale-110 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {note.todoCompleted ? (
                <CheckSquare className="h-4 w-4 text-emerald-500" />
              ) : (
                <Square className="h-4 w-4 text-amber-500" />
              )}
            </button>
          ) : (
            <FileText
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
              note.isTodo && note.todoCompleted && "line-through text-muted-foreground"
            )}
          >
            {note.title || "Untitled Note"}
          </h3>
        </div>

        {relativeTime && (
          <span className="text-[11px] shrink-0 text-muted-foreground font-mono">
            {relativeTime}
          </span>
        )}
      </div>

      {/* Preview Snippet */}
      {note.preview ? (
        <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
          {note.preview}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground/50 italic">Empty note</p>
      )}

      {/* Tags if present */}
      {note.tags && note.tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 pt-1">
          {note.tags.slice(0, 3).map((tag) => (
            <Badge
              key={tag.id}
              variant="outline"
              className="text-[10px] px-1.5 py-0 h-4 bg-muted/30 border-border/40 text-muted-foreground"
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
}
