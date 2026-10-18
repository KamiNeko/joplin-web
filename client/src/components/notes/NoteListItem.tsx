import { NoteListItem as NoteListItemType, Tag } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatRelativeTime, noteDisplayTitle } from "@/lib/format";
import { dueTime, formatDueDate, isOverdue } from "@/lib/due";
import { AlarmClock, CheckSquare, Square, FileText, Lock } from "lucide-react";

interface NoteListItemProps {
  note: NoteListItemType & {
    tags?: Tag[];
    isTodo?: boolean;
    todoCompleted?: boolean;
    todoDue?: number;
  };
  isActive?: boolean;
  onClick?: () => void;
  /** Toggles a to-do's completion; the checkbox is read-only when omitted */
  onToggleTodo?: () => void;
}

export function NoteListItem({ note, isActive, onClick, onToggleTodo }: NoteListItemProps) {
  const relativeTime = formatRelativeTime(note.updatedTime || note.createdTime);
  const title = noteDisplayTitle(note);
  const NoteIcon = note.encrypted ? Lock : FileText;
  const due = dueTime(note);
  const overdue = isOverdue(note);

  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-current={isActive ? "true" : undefined}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
      className={cn(
        "group relative flex flex-col gap-1.5 p-3.5 rounded-xl border text-left transition-all duration-150 cursor-pointer outline-hidden focus-visible:ring-2 focus-visible:ring-primary",
        isActive
          ? "bg-card border-primary/40 shadow-xs"
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
        </div>

        {relativeTime && (
          <span className="text-[11px] shrink-0 text-muted-foreground font-mono">
            {relativeTime}
          </span>
        )}
      </div>

      {/* Preview Snippet */}
      {note.encrypted ? (
        <p className="text-xs text-muted-foreground italic">End-to-end encrypted, can't be shown here</p>
      ) : note.preview ? (
        <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
          {note.preview}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground italic">Empty note</p>
      )}

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
