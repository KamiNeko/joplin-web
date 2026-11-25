import { useEffect, useId, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bookmark,
  CheckSquare,
  Clock,
  Files,
  Folder,
  Globe,
  Hash,
  Home,
  Loader2,
  ScanSearch,
  Search,
  Sparkles,
  Star,
  FileText,
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useNotebooks } from "@/hooks/use-notebooks";
import { useTags } from "@/hooks/use-tags";
import { useSearch } from "@/hooks/use-search";
import { usePreferences, useRecentNotes } from "@/hooks/use-preferences";
import { findNotebookById, flattenNotebooks } from "@/lib/notebooks";
import { noteDisplayTitle } from "@/lib/format";

interface CommandItem {
  id: string;
  label: string;
  meta?: string;
  icon: typeof FileText;
  iconClassName?: string;
  onSelect: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  aiEnabled?: boolean;
  onOpenAskAi?: () => void;
}

export function CommandPalette({ open, onOpenChange, aiEnabled = false, onOpenAskAi }: CommandPaletteProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[12%] translate-y-0 p-0 gap-0 max-w-xl overflow-hidden sm:top-[16%]">
        <DialogHeader className="sr-only">
          <DialogTitle>Command palette</DialogTitle>
          <DialogDescription>Jump to notes, notebooks, tags, saved searches, or workspace views.</DialogDescription>
        </DialogHeader>
        {open && (
          <CommandPaletteInner
            onClose={() => onOpenChange(false)}
            aiEnabled={aiEnabled}
            onOpenAskAi={onOpenAskAi}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CommandPaletteInner({
  onClose,
  aiEnabled,
  onOpenAskAi,
}: {
  onClose: () => void;
  aiEnabled: boolean;
  onOpenAskAi?: () => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const { data: notebooks } = useNotebooks();
  const { data: tags } = useTags();
  const { data: prefs } = usePreferences(true);
  const { data: recentData } = useRecentNotes(true);
  const search = useSearch(query);

  const go = (path: string) => {
    onClose();
    navigate(path);
  };

  const items = useMemo<CommandItem[]>(() => {
    const q = query.trim().toLowerCase();
    const result: CommandItem[] = [];
    const matches = (label: string, meta?: string) =>
      !q || label.toLowerCase().includes(q) || Boolean(meta && meta.toLowerCase().includes(q));

    // Matched search notes first when typing >= 2 chars
    if (query.trim().length >= 2) {
      for (const note of (search.data ?? []).slice(0, 12)) {
        result.push({
          id: `search-note-${note.id}`,
          label: noteDisplayTitle(note),
          meta: note.matches?.snippet || note.preview || "Note",
          icon: FileText,
          onSelect: () => go(`/notes/${note.id}`),
        });
      }
    } else {
      // Shortcuts & recent reads when idle
      for (const favNote of prefs?.favoriteNotes ?? []) {
        result.push({
          id: `fav-note-${favNote.id}`,
          label: noteDisplayTitle(favNote),
          meta: "Shortcut note",
          icon: Star,
          iconClassName: "text-amber-500",
          onSelect: () => go(`/notes/${favNote.id}`),
        });
      }
      for (const recent of (recentData?.recentRead ?? []).slice(0, 5)) {
        if (result.some((r) => r.id.endsWith(recent.id))) continue;
        result.push({
          id: `recent-${recent.id}`,
          label: noteDisplayTitle(recent),
          meta: "Recently read",
          icon: Clock,
          onSelect: () => go(`/notes/${recent.id}`),
        });
      }
    }

    // Workspace views & quick actions
    const views: CommandItem[] = [
      { id: "view-home", label: "Home Dashboard", meta: "Workspace view", icon: Home, onSelect: () => go("/home") },
      { id: "view-notes", label: "All Notes", meta: "Workspace view", icon: Files, onSelect: () => go("/notes") },
      { id: "view-recent", label: "Recent Notes", meta: "Read & Created", icon: Clock, onSelect: () => go("/recent") },
      { id: "view-tasks", label: "Tasks Hub", meta: "To-dos & Checklists", icon: CheckSquare, onSelect: () => go("/tasks") },
      { id: "view-clip", label: "Web Clipper & Email Import", meta: "Capture tools", icon: Globe, onSelect: () => go("/clip") },
      { id: "view-hygiene", label: "Duplicate & Hygiene Triage", meta: "Cleanup tools", icon: ScanSearch, onSelect: () => go("/hygiene") },
      { id: "view-organize", label: "Auto-organize Jobs", meta: "AI triage", icon: Sparkles, onSelect: () => go("/organize") },
    ];
    if (aiEnabled && onOpenAskAi) {
      views.push({
        id: "action-ask-ai",
        label: "Ask My Notes (AI)",
        meta: "Q&A across notes",
        icon: Sparkles,
        iconClassName: "text-primary",
        onSelect: () => {
          onClose();
          onOpenAskAi();
        },
      });
    }
    for (const v of views) {
      if (matches(v.label, v.meta)) result.push(v);
    }

    // Saved searches
    for (const saved of prefs?.savedSearches ?? []) {
      if (matches(saved.name, saved.query)) {
        result.push({
          id: `saved-${saved.id}`,
          label: saved.name,
          meta: `Saved search: ${saved.query}`,
          icon: Bookmark,
          onSelect: () => go(`/notes?q=${encodeURIComponent(saved.query)}`),
        });
      }
    }

    // Notebooks
    for (const nb of flattenNotebooks(notebooks)) {
      if (matches(nb.title, "Notebook")) {
        const nbObj = findNotebookById(notebooks, nb.id);
        const count = nbObj?.noteCount ?? 0;
        result.push({
          id: `nb-${nb.id}`,
          label: nb.title,
          meta: `Notebook · ${count} ${count === 1 ? "note" : "notes"}`,
          icon: Folder,
          onSelect: () => go(`/notebooks/${nb.id}`),
        });
      }
    }

    // Tags
    for (const tag of tags ?? []) {
      if (matches(tag.title, "Tag")) {
        result.push({
          id: `tag-${tag.id}`,
          label: `#${tag.title}`,
          meta: `Tag · ${tag.noteCount} ${tag.noteCount === 1 ? "note" : "notes"}`,
          icon: Hash,
          onSelect: () => go(`/notes?tag=${encodeURIComponent(tag.id)}`),
        });
      }
    }

    return result.slice(0, 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, search.data, prefs, recentData, notebooks, tags, aiEnabled]);

  const current = items.length > 0 ? Math.min(active, items.length - 1) : -1;
  const optionId = (i: number) => `${listId}-${i}`;

  useEffect(() => {
    if (current >= 0) document.getElementById(optionId(current))?.scrollIntoView?.({ block: "nearest" });
  });

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" && items.length > 0) {
      e.preventDefault();
      setActive((current + 1) % items.length);
    } else if (e.key === "ArrowUp" && items.length > 0) {
      e.preventDefault();
      setActive((current - 1 + items.length) % items.length);
    } else if (e.key === "Enter" && current >= 0 && items[current]) {
      e.preventDefault();
      items[current].onSelect();
    }
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center border-b border-border px-3 py-2.5 gap-2">
        <Search className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
        <Input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Jump to note, notebook, tag, or command…"
          aria-label="Command palette search"
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls={listId}
          aria-activedescendant={current >= 0 ? optionId(current) : undefined}
          className="border-0 bg-transparent shadow-none focus-visible:ring-0 h-8 px-1 text-sm"
        />
        {search.isSearching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />}
      </div>

      <div className="max-h-[min(26rem,60vh)] overflow-y-auto p-2">
        {items.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">No matching notes or commands.</p>
        ) : (
          <ul id={listId} role="listbox" aria-label="Command results" className="space-y-0.5">
            {items.map((item, i) => {
              const Icon = item.icon;
              return (
                <li
                  key={item.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === current}
                  onMouseMove={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={item.onSelect}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                    i === current ? "bg-accent text-accent-foreground" : "text-foreground"
                  )}
                >
                  <Icon className={cn("h-4 w-4 shrink-0 text-muted-foreground", item.iconClassName)} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-xs sm:text-sm">{item.label}</div>
                    {item.meta && <div className="truncate text-[11px] text-muted-foreground">{item.meta}</div>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="border-t border-border bg-muted/30 px-3 py-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>↑↓ Navigate · Enter Open · Esc Close</span>
        <kbd className="font-mono">Ctrl+P</kbd>
      </div>
    </div>
  );
}
