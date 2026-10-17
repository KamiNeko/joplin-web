import { Note } from "@/lib/types";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Calendar,
  Clock,
  Folder,
  Tag as TagIcon,
  CheckCircle2,
  AlertCircle,
  FileText,
  X,
} from "lucide-react";
import { formatRelativeTime } from "./NoteListItem";
import { Button } from "@/components/ui/button";

interface NoteViewerProps {
  note?: Note | null;
  isLoading?: boolean;
  error?: Error | null;
  onTagClick?: (tagId: string) => void;
  onNotebookClick?: (notebookId: string) => void;
  onClose?: () => void;
}

export function NoteViewer({
  note,
  isLoading = false,
  error = null,
  onTagClick,
  onNotebookClick,
  onClose,
}: NoteViewerProps) {
  if (isLoading) {
    return (
      <div className="flex flex-col h-full bg-background p-6 lg:p-8 space-y-6">
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

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center">
        <div className="h-12 w-12 rounded-full bg-destructive/10 text-destructive flex items-center justify-center mb-3">
          <AlertCircle className="h-6 w-6" />
        </div>
        <h3 className="text-base font-semibold text-foreground">Failed to load note</h3>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">
          {error.message || "An error occurred while fetching note contents."}
        </p>
      </div>
    );
  }

  if (!note) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center select-none bg-background">
        <div className="h-16 w-16 rounded-2xl bg-muted/40 border border-border/50 flex items-center justify-center text-muted-foreground mb-4 shadow-sm">
          <FileText className="h-8 w-8 opacity-40" />
        </div>
        <h3 className="text-lg font-semibold text-foreground">No note selected</h3>
        <p className="text-xs text-muted-foreground mt-1 max-w-xs leading-relaxed">
          Select a note from the list on the left to read its contents or switch notebooks.
        </p>
      </div>
    );
  }

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

  return (
    <div className="flex flex-col h-full bg-background relative overflow-hidden">
      {/* Top Mobile/Header Bar */}
      <div className="px-6 py-4 border-b border-border/40 flex items-center justify-between gap-3 bg-background/80 backdrop-blur-sm z-10">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          {/* Notebook badge */}
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

          {/* Todo status badge if applicable */}
          {note.isTodo && (
            <Badge
              variant={note.todoCompleted ? "secondary" : "outline"}
              className={`text-xs gap-1 ${
                note.todoCompleted
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                  : "bg-amber-500/10 text-amber-400 border-amber-500/30"
              }`}
            >
              <CheckCircle2 className="h-3 w-3" />
              {note.todoCompleted ? "Completed Task" : "Pending Task"}
            </Badge>
          )}

          {/* In Trash badge if soft-deleted */}
          {Boolean(note.deletedTime && note.deletedTime > 0) && (
            <Badge
              variant="destructive"
              className="text-xs gap-1 bg-destructive/15 text-destructive border-destructive/30"
            >
              <AlertCircle className="h-3 w-3" />
              In Trash
            </Badge>
          )}
        </div>

        {/* Close button for responsive mobile view */}
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

      {/* Main Note Scroll Area */}
      <ScrollArea className="flex-1 px-6 sm:px-10 lg:px-12 py-8">
        <div className="max-w-4xl mx-auto space-y-6 pb-20">
          {/* Trashed Banner */}
          {Boolean(note.deletedTime && note.deletedTime > 0) && (
            <div className="flex items-center gap-2.5 p-3.5 rounded-xl bg-destructive/10 border border-destructive/25 text-destructive text-xs">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>
                <strong>This note is in the trash.</strong> It was moved to trash in Joplin and is excluded from active notebooks.
              </span>
            </div>
          )}

          {/* Note Title */}
          <div className="space-y-3">
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold tracking-tight text-foreground leading-tight">
              {note.title || "Untitled Note"}
            </h1>

            {/* Note Metadata Bar */}
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

              {/* Tags */}
              {note.tags && note.tags.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <TagIcon className="h-3.5 w-3.5" />
                  {note.tags.map((tag) => (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => onTagClick?.(tag.id)}
                      className="inline-flex items-center rounded-full bg-muted/60 hover:bg-muted text-muted-foreground hover:text-foreground px-2 py-0.5 text-[11px] font-medium transition-colors"
                    >
                      #{tag.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Markdown Content */}
          <div className="pt-2">
            <MarkdownRenderer content={note.body} />
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
