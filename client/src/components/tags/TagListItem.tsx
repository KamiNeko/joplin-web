import { useState } from "react";
import { Hash, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Tag } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

interface TagListItemProps {
  tag: Tag;
  isSelected: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}

/**
 * Sidebar row for a tag with a hover actions menu (rename, delete).
 */
export function TagListItem({ tag, isSelected, onSelect, onRename, onDelete }: TagListItemProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-sm transition-all duration-150 cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-ring",
        isSelected
          ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <Hash className={cn("h-3.5 w-3.5 shrink-0", isSelected ? "text-primary" : "text-muted-foreground")} />
        <span className="truncate">{tag.title}</span>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              aria-label={`Actions for tag ${tag.title}`}
              className={cn(
                "p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted",
                menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              )}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-44" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem onClick={onRename}>
              <Pencil className="h-4 w-4" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
              <Trash2 className="h-4 w-4" />
              Delete tag
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Badge
          variant="secondary"
          className={cn(
            "px-1.5 py-0 text-[10px] font-mono h-4 min-w-[18px] flex items-center justify-center",
            isSelected ? "bg-primary/20 text-primary border-primary/30" : "bg-muted text-muted-foreground"
          )}
        >
          {tag.noteCount}
        </Badge>
      </div>
    </div>
  );
}
