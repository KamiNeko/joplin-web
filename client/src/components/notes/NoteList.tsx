import { useState, useMemo } from "react";
import { NoteListItem as NoteListItemType } from "@/lib/types";
import { NoteListItem } from "./NoteListItem";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowDownUp, FileQuestion, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

interface NoteListProps {
  notes?: NoteListItemType[];
  isLoading?: boolean;
  selectedNoteId?: string | null;
  onSelectNote: (id: string) => void;
  title?: string;
  subtitle?: string;
}

type SortField = "updated" | "created" | "title";
type SortOrder = "asc" | "desc";

export function NoteList({
  notes = [],
  isLoading = false,
  selectedNoteId,
  onSelectNote,
  title = "Notes",
  subtitle,
}: NoteListProps) {
  const [filterText, setFilterText] = useState("");
  const [sortField, setSortField] = useState<SortField>("updated");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");

  const filteredAndSortedNotes = useMemo(() => {
    let result = [...notes];

    if (filterText.trim()) {
      const q = filterText.toLowerCase();
      result = result.filter(
        (n) =>
          n.title.toLowerCase().includes(q) ||
          (n.preview && n.preview.toLowerCase().includes(q))
      );
    }

    result.sort((a, b) => {
      if (sortField === "title") {
        const comp = a.title.localeCompare(b.title);
        return sortOrder === "asc" ? comp : -comp;
      }
      const timeA = (sortField === "created" ? a.createdTime : a.updatedTime) || 0;
      const timeB = (sortField === "created" ? b.createdTime : b.updatedTime) || 0;
      return sortOrder === "asc" ? timeA - timeB : timeB - timeA;
    });

    return result;
  }, [notes, filterText, sortField, sortOrder]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortOrder("desc");
    }
  };

  const sortLabel = useMemo(() => {
    if (sortField === "updated") return "Updated Date";
    if (sortField === "created") return "Created Date";
    return "Title";
  }, [sortField]);

  return (
    <div className="flex flex-col h-full bg-background border-r border-border/50">
      {/* Top bar with Title & Sort */}
      <div className="p-3.5 border-b border-border/40 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-foreground truncate">{title}</h2>
            {subtitle && (
              <p className="text-xs text-muted-foreground truncate">{subtitle}</p>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-xs text-muted-foreground font-mono">
              {filteredAndSortedNotes.length} {filteredAndSortedNotes.length === 1 ? "note" : "notes"}
            </span>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  aria-label={`Sort notes (currently by ${sortLabel})`}
                  title={`Sorted by ${sortLabel} (${sortOrder === "desc" ? "newest first" : "oldest first"})`}
                >
                  <ArrowDownUp className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40 text-xs">
                <DropdownMenuItem onClick={() => toggleSort("updated")}>
                  Updated Date {sortField === "updated" && (sortOrder === "desc" ? "↓" : "↑")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => toggleSort("created")}>
                  Created Date {sortField === "created" && (sortOrder === "desc" ? "↓" : "↑")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => toggleSort("title")}>
                  Title {sortField === "title" && (sortOrder === "desc" ? "↓" : "↑")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Filter input */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Filter notes..."
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            className="h-8 pl-8 text-xs bg-muted/40 border-border/40 focus-visible:ring-primary/70"
          />
        </div>
      </div>

      {/* Content Area */}
      <ScrollArea className="flex-1 p-3">
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="p-3.5 rounded-xl border border-border/40 bg-card/20 space-y-2.5"
              >
                <div className="flex justify-between items-center">
                  <Skeleton className="h-4 w-3/5" />
                  <Skeleton className="h-3 w-12" />
                </div>
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            ))}
          </div>
        ) : filteredAndSortedNotes.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-center px-4">
            <div className="h-12 w-12 rounded-full bg-muted/50 flex items-center justify-center text-muted-foreground mb-3">
              <FileQuestion className="h-6 w-6 opacity-60" />
            </div>
            <h4 className="text-sm font-semibold text-foreground">No notes found</h4>
            <p className="text-xs text-muted-foreground mt-1 max-w-[200px]">
              {filterText
                ? "No notes matched your search keyword."
                : "This notebook or tag has no notes yet."}
            </p>
          </div>
        ) : (
          <div className="space-y-2 pb-6">
            {filteredAndSortedNotes.map((note) => (
              <NoteListItem
                key={note.id}
                note={note}
                isActive={selectedNoteId === note.id}
                onClick={() => onSelectNote(note.id)}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
