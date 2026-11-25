import { useMemo, useState } from "react";
import { Folder, FolderTree, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { flattenNotebooks } from "@/lib/notebooks";
import { Notebook } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Value of the "top level" choice (no parent notebook) */
export const TOP_LEVEL = "";

interface NotebookPickerProps {
  notebooks: Notebook[];
  /** Currently highlighted notebook id */
  selectedId?: string | null;
  /** Disabled notebook id marked "Current" (when all target items already live there) */
  currentId?: string | null;
  /** Notebook ids excluded from the list (e.g. a notebook being moved and its descendants) */
  blockedIds?: ReadonlySet<string>;
  /** Include the "Top level" root option (used when moving notebooks, not notes) */
  includeTopLevel?: boolean;
  /** Controlled filter value; manages internal filter state when omitted */
  filter?: string;
  onFilterChange?: (filter: string) => void;
  disabled?: boolean;
  autoFocusFilter?: boolean;
  listClassName?: string;
  /** Called when an enabled notebook is clicked (passing id and display title) */
  onSelect: (notebookId: string, title: string) => void;
  /** Called on double-click (for two-step select+confirm dialogs) */
  onDoubleClick?: (notebookId: string, title: string) => void;
}

/**
 * Searchable indented notebook picker shared by MoveNotebookDialog and bulk note move.
 * Encrypted notebooks are omitted because Joplin Web cannot write cleartext items into them.
 */
export function NotebookPicker({
  notebooks,
  selectedId = null,
  currentId = null,
  blockedIds,
  includeTopLevel = false,
  filter: controlledFilter,
  onFilterChange,
  disabled = false,
  autoFocusFilter = false,
  listClassName,
  onSelect,
  onDoubleClick,
}: NotebookPickerProps) {
  const [internalFilter, setInternalFilter] = useState("");
  const filter = controlledFilter ?? internalFilter;
  const setFilter = onFilterChange ?? setInternalFilter;

  const query = filter.trim().toLowerCase();
  const choices = useMemo(() => {
    const flat = flattenNotebooks(notebooks).filter(
      (nb) => !(blockedIds?.has(nb.id)) && !nb.encrypted
    );
    return query ? flat.filter((nb) => nb.title.toLowerCase().includes(query)) : flat;
  }, [notebooks, blockedIds, query]);

  const option = (id: string, label: string, depth: number, icon: React.ReactNode) => {
    const isCurrent = currentId !== null && id === currentId;
    const isSelected = id === selectedId;
    return (
      <li key={id || "top-level"}>
        <button
          type="button"
          disabled={disabled || isCurrent}
          aria-pressed={isSelected}
          onClick={() => onSelect(id, label)}
          onDoubleClick={() => {
            if (!disabled && !isCurrent) onDoubleClick?.(id, label);
          }}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          className={cn(
            "w-full flex items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
            isSelected ? "bg-primary/15 text-foreground font-medium" : "text-foreground hover:bg-muted",
            isCurrent && "opacity-50 cursor-not-allowed hover:bg-transparent"
          )}
        >
          {icon}
          <span className="truncate">{label}</span>
          {isCurrent && <span className="ml-auto shrink-0 text-xs text-muted-foreground">Current</span>}
        </button>
      </li>
    );
  };

  return (
    <div className="grid gap-2 min-w-0">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          autoFocus={autoFocusFilter}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter notebooks..."
          aria-label="Filter notebooks"
          className="h-8 pl-8 text-sm"
        />
      </div>

      <ul
        aria-label="Destination"
        className={cn("max-h-64 overflow-y-auto rounded-md border border-border p-1 space-y-0.5", listClassName)}
      >
        {includeTopLevel &&
          !query &&
          option(TOP_LEVEL, "Top level", 0, <FolderTree className="h-4 w-4 shrink-0 text-muted-foreground" />)}
        {choices.map((nb) =>
          option(
            nb.id,
            nb.title || "Untitled Folder",
            query ? 0 : nb.depth + (includeTopLevel ? 1 : 0),
            <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
          )
        )}
        {choices.length === 0 && (
          <li className="px-2 py-3 text-center text-xs text-muted-foreground">
            {query ? "No matching notebooks" : "No destination notebooks"}
          </li>
        )}
      </ul>
    </div>
  );
}
