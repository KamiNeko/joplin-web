import { useEffect, useId, useState } from "react";
import { FileText, Loader2, Search } from "lucide-react";
import { useSearch } from "@/hooks/use-search";
import { QueryError } from "@/components/common/QueryError";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface NoteLinkPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (note: { id: string; title: string }) => void;
  /** The note being edited, left out of the results */
  excludeId?: string;
  /** Called when the dialog has closed, instead of returning focus to the button that opened it */
  onCloseAutoFocus?: () => void;
}

/**
 * Dialog that searches notes (same search as the header) and returns the one picked, for
 * inserting a link to it. Arrow keys move through the results, Enter picks.
 */
export function NoteLinkPicker({ open, onOpenChange, onSelect, excludeId, onCloseAutoFocus }: NoteLinkPickerProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const search = useSearch(query);
  const optionId = (i: number) => `${listId}-${i}`;
  const tooShort = query.trim().length < 2;
  const results = tooShort ? [] : (search.data ?? []).filter((n) => n.id !== excludeId);
  const pending = !tooShort && (search.debouncedQuery !== query.trim() || search.isLoading);
  const current = Math.min(active, results.length - 1);

  useEffect(() => {
    if (current >= 0) document.getElementById(optionId(current))?.scrollIntoView?.({ block: "nearest" });
  });

  const changeOpen = (next: boolean) => {
    // Start with an empty search the next time
    if (!next) {
      setQuery("");
      setActive(0);
    }
    onOpenChange(next);
  };

  const pick = (index: number) => {
    const note = results[index];
    if (!note) return;
    onSelect({ id: note.id, title: note.title });
    changeOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" && results.length > 0) {
      e.preventDefault();
      setActive((current + 1) % results.length);
    } else if (e.key === "ArrowUp" && results.length > 0) {
      e.preventDefault();
      setActive((current - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!pending) pick(current);
    }
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        className="top-[15%] translate-y-0 gap-3 sm:top-[20%]"
        onCloseAutoFocus={(e) => {
          if (!onCloseAutoFocus) return;
          e.preventDefault();
          onCloseAutoFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Link to note</DialogTitle>
          <DialogDescription>Search for a note to insert a link to it.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search notes…"
            aria-label="Search notes"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls={listId}
            aria-activedescendant={current >= 0 ? optionId(current) : undefined}
            aria-autocomplete="list"
            className="pl-9"
          />
        </div>

        <div className="max-h-[min(20rem,50vh)] min-h-24 overflow-y-auto -mx-1 px-1">
          {tooShort ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Type at least 2 characters.</p>
          ) : search.error && !pending ? (
            <QueryError
              message="Search failed"
              error={search.error}
              onRetry={() => void search.refetch()}
              isRetrying={search.isFetching}
              compact
            />
          ) : pending && results.length === 0 ? (
            <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Searching…
            </p>
          ) : results.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No notes found.</p>
          ) : (
            <ul id={listId} role="listbox" aria-label="Notes" className={cn("space-y-0.5", pending && "opacity-60")}>
              {results.map((note, i) => (
                <li
                  key={note.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === current}
                  onMouseMove={() => setActive(i)}
                  // Keep focus in the search field
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(i)}
                  className={cn(
                    "flex cursor-pointer items-start gap-2 rounded-md px-2.5 py-2 text-sm",
                    i === current ? "bg-accent text-accent-foreground" : "text-foreground"
                  )}
                >
                  <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{note.title || "Untitled"}</span>
                    {(note.matches?.snippet || note.preview) && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {note.matches?.snippet || note.preview}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
