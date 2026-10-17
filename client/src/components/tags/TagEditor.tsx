import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Tag as TagIcon, X } from "lucide-react";
import { Tag } from "@/lib/types";
import { useTags } from "@/hooks/use-tags";
import { useAddTag, useRemoveTag } from "@/hooks/use-mutations";
import { cn } from "@/lib/utils";

interface TagEditorProps {
  noteId: string;
  tags: Pick<Tag, "id" | "title">[];
  /** Read-only display (e.g. for notes in the trash) */
  readOnly?: boolean;
  onTagClick?: (tagId: string) => void;
}

const MAX_SUGGESTIONS = 8;

/**
 * Tag chips for a note with inline add (autocomplete from existing tags) and remove.
 */
export function TagEditor({ noteId, tags, readOnly = false, onTagClick }: TagEditorProps) {
  const { data: allTags } = useTags();
  const addTag = useAddTag();
  const removeTag = useRemoveTag();
  const [isAdding, setIsAdding] = useState(false);
  const [value, setValue] = useState("");
  // -1 = no suggestion picked; Enter then adds exactly what was typed
  const [highlighted, setHighlighted] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const suggestions = useMemo(() => {
    const onNote = new Set(tags.map((t) => t.id));
    const q = value.trim().toLowerCase();
    return (allTags ?? [])
      .filter((t) => !onNote.has(t.id) && (!q || t.title.toLowerCase().includes(q)))
      .slice(0, MAX_SUGGESTIONS);
  }, [allTags, tags, value]);

  const close = () => {
    setIsAdding(false);
    setValue("");
    setHighlighted(-1);
  };

  const submit = (title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    if (tags.some((t) => t.title.toLowerCase() === trimmed.toLowerCase())) {
      close();
      return;
    }
    addTag.mutate(
      { noteId, title: trimmed },
      {
        onSuccess: () => {
          setValue("");
          setHighlighted(-1);
          inputRef.current?.focus();
        },
        onError: (err) => toast.error("Could not add tag", { description: err.message }),
      }
    );
  };

  const handleRemove = (tag: Pick<Tag, "id" | "title">) => {
    removeTag.mutate(
      { noteId, tagId: tag.id },
      { onError: (err) => toast.error(`Could not remove "${tag.title}"`, { description: err.message }) }
    );
  };

  if (readOnly && tags.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <TagIcon className="h-3.5 w-3.5 shrink-0" />
      {tags.map((tag) => (
        <span
          key={tag.id}
          className="group/tag inline-flex items-center rounded-full bg-muted/60 text-muted-foreground text-[11px] font-medium"
        >
          <button
            type="button"
            onClick={() => onTagClick?.(tag.id)}
            className={cn("py-0.5 hover:text-foreground transition-colors", readOnly ? "px-2" : "pl-2 pr-1")}
          >
            #{tag.title}
          </button>
          {!readOnly && (
            <button
              type="button"
              onClick={() => handleRemove(tag)}
              disabled={removeTag.isPending}
              className="mr-1 rounded-full p-0.5 opacity-60 hover:opacity-100 hover:bg-muted hover:text-foreground"
              aria-label={`Remove tag ${tag.title}`}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}

      {!readOnly &&
        (isAdding ? (
          <div className="relative">
            <input
              ref={inputRef}
              autoFocus
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setHighlighted(-1);
              }}
              onBlur={() => {
                // Let a click on a suggestion land before closing
                window.setTimeout(() => {
                  if (document.activeElement !== inputRef.current && !addTag.isPending) close();
                }, 150);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  close();
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setHighlighted((i) => Math.min(i + 1, Math.max(suggestions.length - 1, 0)));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setHighlighted((i) => Math.max(i - 1, -1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const pick = highlighted >= 0 ? suggestions[highlighted] : undefined;
                  submit(pick ? pick.title : value);
                }
              }}
              placeholder="Add tag…"
              aria-label="Add tag"
              className="h-6 w-36 rounded-full border border-primary/50 bg-background px-2.5 text-[11px] text-foreground outline-none focus:ring-1 focus:ring-primary/40"
            />
            {addTag.isPending && (
              <Loader2 className="absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 animate-spin text-muted-foreground" />
            )}
            {suggestions.length > 0 && (
              <ul
                role="listbox"
                className="absolute left-0 top-7 z-30 w-48 overflow-hidden rounded-lg border bg-popover py-1 text-xs text-popover-foreground shadow-md"
              >
                {suggestions.map((tag, i) => (
                  <li key={tag.id} role="option" aria-selected={i === highlighted}>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setHighlighted(i)}
                      onClick={() => submit(tag.title)}
                      className={cn(
                        "flex w-full items-center justify-between px-2.5 py-1.5 text-left",
                        i === highlighted && "bg-accent text-accent-foreground"
                      )}
                    >
                      <span className="truncate">#{tag.title}</span>
                      <span className="ml-2 font-mono text-[10px] text-muted-foreground">{tag.noteCount}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setIsAdding(true)}
            className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-primary/50 hover:text-foreground transition-colors"
          >
            <Plus className="h-3 w-3" />
            Tag
          </button>
        ))}
    </div>
  );
}
