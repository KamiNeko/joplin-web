import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Plus, Tag as TagIcon, X } from "lucide-react";
import { Tag } from "@/lib/types";
import { useAddTag, useRemoveTag } from "@/hooks/use-mutations";
import { cn } from "@/lib/utils";
import { TagAutocompleteInput } from "./TagAutocompleteInput";

interface TagEditorProps {
  noteId: string;
  tags: Pick<Tag, "id" | "title">[];
  /** Read-only display (e.g. for notes in the trash) */
  readOnly?: boolean;
  onTagClick?: (tagId: string) => void;
}

/**
 * Tag chips for a note with inline add (autocomplete from existing tags) and remove.
 */
export function TagEditor({ noteId, tags, readOnly = false, onTagClick }: TagEditorProps) {
  const addTag = useAddTag();
  const removeTag = useRemoveTag();
  const [isAdding, setIsAdding] = useState(false);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const excludeTagIds = useMemo(() => new Set(tags.map((t) => t.id)), [tags]);

  const close = () => {
    setIsAdding(false);
    setValue("");
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
          <TagAutocompleteInput
            excludeTagIds={excludeTagIds}
            value={value}
            onValueChange={setValue}
            onSubmit={submit}
            onCancel={close}
            isPending={addTag.isPending}
            closeOnBlur
            inputRef={inputRef}
          />
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
