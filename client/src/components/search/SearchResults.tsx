import React from "react";
import { SearchResult } from "@/lib/types";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, FileText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/components/notes/NoteListItem";

interface SearchResultsProps {
  query: string;
  results: SearchResult[];
  isLoading?: boolean;
  selectedNoteId?: string | null;
  onSelectNote: (id: string) => void;
  onClearQuery?: () => void;
}

/**
 * Helper to highlight matched query characters or substrings.
 */
function HighlightedText({
  text,
  query,
  className,
}: {
  text: string;
  query: string;
  className?: string;
}) {
  if (!text) return null;
  if (!query || query.trim().length < 2) {
    return <span className={className}>{text}</span>;
  }

  const trimmed = query.trim();
  // Safe regex escaping
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escaped})`, "gi");
  const parts = text.split(regex);

  return (
    <span className={className}>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <mark
            key={i}
            className="bg-primary/25 text-primary font-semibold rounded-sm px-0.5"
          >
            {part}
          </mark>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        )
      )}
    </span>
  );
}

export function SearchResults({
  query,
  results,
  isLoading = false,
  selectedNoteId,
  onSelectNote,
  onClearQuery,
}: SearchResultsProps) {
  return (
    <div className="flex flex-col h-full bg-background border-r border-border/50">
      {/* Header bar */}
      <div className="p-3.5 border-b border-border/40 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Search className="h-4 w-4 text-primary shrink-0" />
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-foreground truncate">Search Results</h3>
            <p className="text-[11px] text-muted-foreground truncate">
              for &ldquo;<span className="text-foreground font-medium">{query}</span>&rdquo;
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground font-mono">
            {results.length} found
          </span>
          {onClearQuery && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onClearQuery}
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Results content */}
      <ScrollArea className="flex-1 p-3">
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="p-3.5 rounded-xl border border-border/40 bg-card/20 space-y-2.5"
              >
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            ))}
          </div>
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-center px-4">
            <div className="h-12 w-12 rounded-full bg-muted/40 flex items-center justify-center text-muted-foreground mb-3">
              <Search className="h-6 w-6 opacity-40" />
            </div>
            <h4 className="text-sm font-semibold text-foreground">No matches found</h4>
            <p className="text-xs text-muted-foreground mt-1 max-w-[220px]">
              We couldn&apos;t find any notes matching &ldquo;{query}&rdquo;. Try another term.
            </p>
          </div>
        ) : (
          <div className="space-y-2 pb-6">
            {results.map((note) => {
              const isActive = selectedNoteId === note.id;
              const relativeTime = formatRelativeTime(note.updatedTime || note.createdTime);

              // Use snippet matches if available from API
              const snippetMatch = note.matches?.find((m) => m.snippet)?.snippet;
              const displaySnippet = snippetMatch || note.preview;

              return (
                <div
                  key={note.id}
                  onClick={() => onSelectNote(note.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectNote(note.id);
                    }
                  }}
                  className={cn(
                    "group relative flex flex-col gap-1.5 p-3.5 rounded-xl border text-left transition-all duration-150 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary",
                    isActive
                      ? "bg-accent/80 border-primary/50 shadow-sm"
                      : "bg-card/40 border-border/50 hover:bg-muted/40 hover:border-border/80"
                  )}
                >
                  {isActive && (
                    <span className="absolute left-0 top-3 bottom-3 w-1 bg-primary rounded-r-full" />
                  )}

                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <FileText
                        className={cn(
                          "h-4 w-4 shrink-0 transition-colors",
                          isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
                        )}
                      />
                      <h4 className="font-semibold text-sm leading-snug truncate">
                        <HighlightedText
                          text={note.title || "Untitled Note"}
                          query={query}
                          className={isActive ? "text-foreground font-bold" : "text-foreground/90"}
                        />
                      </h4>
                    </div>

                    {relativeTime && (
                      <span className="text-[11px] shrink-0 text-muted-foreground font-mono">
                        {relativeTime}
                      </span>
                    )}
                  </div>

                  {displaySnippet && (
                    <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                      <HighlightedText text={displaySnippet} query={query} />
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
