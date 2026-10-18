import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlarmClock } from "lucide-react";
import { Note } from "@/lib/types";
import { getConflictNote } from "@/lib/api";
import { dueTime, formatDueDate, fromDateTimeLocal, isOverdue, toDateTimeLocal } from "@/lib/due";
import { useUpdateNote } from "@/hooks/use-mutations";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface TodoDueDateProps {
  note: Note;
  /** Shows the due date without the editor (e.g. for notes in the trash) */
  readOnly?: boolean;
}

/**
 * Due date of a to-do in the note header: shows it (highlighted when overdue) and lets the
 * user set, change or clear it in a popover with a native date and time input.
 */
export function TodoDueDate({ note, readOnly = false }: TodoDueDateProps) {
  const queryClient = useQueryClient();
  const updateNote = useUpdateNote();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");

  const due = dueTime(note);
  const overdue = isOverdue(note);
  if (!note.isTodo || (readOnly && !due)) return null;

  const label = due ? `${overdue ? "Overdue" : "Due"} ${formatDueDate(due)}` : "Set due date";
  const parsed = fromDateTimeLocal(value);

  const save = (todoDue: number) => {
    updateNote.mutate(
      { id: note.id, changes: { todoDue, baseUpdatedTime: note.updatedTime } },
      {
        onSuccess: () => {
          setOpen(false);
          toast.success(todoDue ? "Due date set" : "Due date cleared");
        },
        onError: (err) => {
          const current = getConflictNote(err);
          if (current) {
            queryClient.setQueryData(["note", note.id], current);
            toast.error("This note was changed elsewhere", {
              description: "The due date was not saved. The latest version is shown now.",
            });
          } else {
            toast.error("Could not update due date", { description: err.message });
          }
        },
      }
    );
  };

  const className = cn(
    "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors",
    overdue
      ? "bg-destructive/10 text-destructive border-destructive/30"
      : due
        ? "bg-secondary text-secondary-foreground border-border/40"
        : "border-dashed border-border text-muted-foreground",
    !readOnly && (overdue ? "hover:bg-destructive/20" : "hover:bg-secondary/80 hover:text-foreground")
  );

  if (readOnly) {
    return (
      <span className={className}>
        <AlarmClock className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </span>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setValue(due ? toDateTimeLocal(due) : "");
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button type="button" className={className} aria-label={due ? `${label}: change due date` : label}>
          <AlarmClock className="h-3.5 w-3.5" aria-hidden="true" />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(18rem,calc(100vw-2rem))]">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (parsed !== null) save(parsed);
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor={inputId}>Due date</Label>
            <Input
              id={inputId}
              type="datetime-local"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="dark:[color-scheme:dark]"
              required
            />
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {due > 0 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="mr-auto text-destructive hover:text-destructive hover:bg-destructive/10"
                disabled={updateNote.isPending}
                onClick={() => save(0)}
              >
                Clear
              </Button>
            )}
            <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={parsed === null || parsed === due || updateNote.isPending}>
              Save
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
