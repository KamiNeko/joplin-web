import { useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTags } from "@/hooks/use-tags";
import { cn } from "@/lib/utils";

const MAX_SUGGESTIONS = 8;

interface TagAutocompleteInputProps {
  /** Tag ids to omit from suggestions (e.g. tags already linked to the current note) */
  excludeTagIds?: ReadonlySet<string>;
  /** Controlled input value */
  value?: string;
  onValueChange?: (value: string) => void;
  /** Called with the trimmed/picked tag title on Enter or suggestion click */
  onSubmit: (title: string) => void;
  /** Called on Escape, or blur when `closeOnBlur` is enabled */
  onCancel?: () => void;
  isPending?: boolean;
  /** Close on blur after a short delay (for inline TagEditor); disable inside Popovers */
  closeOnBlur?: boolean;
  /** Render suggestion listbox inline below the input rather than absolutely positioned */
  inlineList?: boolean;
  autoFocus?: boolean;
  inputClassName?: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

/**
 * Reusable tag input with keyboard-accessible autocomplete over existing unencrypted tags.
 */
export function TagAutocompleteInput({
  excludeTagIds,
  value: controlledValue,
  onValueChange,
  onSubmit,
  onCancel,
  isPending = false,
  closeOnBlur = false,
  inlineList = false,
  autoFocus = true,
  inputClassName,
  inputRef: externalRef,
}: TagAutocompleteInputProps) {
  const { data: allTags } = useTags();
  const [internalValue, setInternalValue] = useState("");
  const value = controlledValue ?? internalValue;
  const setValue = onValueChange ?? setInternalValue;

  // -1 = no suggestion picked; Enter then adds whatever was typed
  const [highlighted, setHighlighted] = useState(-1);
  const internalRef = useRef<HTMLInputElement>(null);
  const inputRef = externalRef ?? internalRef;

  const suggestions = useMemo(() => {
    const q = value.trim().toLowerCase();
    return (allTags ?? [])
      // An encrypted tag has no readable title to add it by, and the server refuses links to it
      .filter((t) => !(excludeTagIds?.has(t.id)) && !t.encrypted && (!q || t.title.toLowerCase().includes(q)))
      .slice(0, MAX_SUGGESTIONS);
  }, [allTags, excludeTagIds, value]);

  const commit = (rawTitle: string) => {
    const trimmed = rawTitle.trim();
    if (!trimmed) return;
    setHighlighted(-1);
    onSubmit(trimmed);
  };

  return (
    <div className="relative min-w-0">
      <div className="relative">
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setHighlighted(-1);
          }}
          onBlur={
            closeOnBlur
              ? () => {
                  // Let a click on a suggestion land before closing
                  window.setTimeout(() => {
                    if (document.activeElement !== inputRef.current && !isPending) {
                      setHighlighted(-1);
                      onCancel?.();
                    }
                  }, 150);
                }
              : undefined
          }
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setHighlighted(-1);
              onCancel?.();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlighted((i) => Math.min(i + 1, Math.max(suggestions.length - 1, 0)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlighted((i) => Math.max(i - 1, -1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const pick = highlighted >= 0 ? suggestions[highlighted] : undefined;
              commit(pick ? pick.title : value);
            }
          }}
          placeholder="Add tag…"
          aria-label="Add tag"
          className={cn(
            "h-6 w-36 rounded-full border border-primary/50 bg-background px-2.5 text-[11px] text-foreground outline-hidden focus:ring-1 focus:ring-primary/40",
            inputClassName
          )}
        />
        {isPending && (
          <Loader2 className="absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
      </div>
      {suggestions.length > 0 && (
        <ul
          role="listbox"
          className={cn(
            "overflow-hidden rounded-lg border bg-popover py-1 text-xs text-popover-foreground",
            inlineList
              ? "mt-1.5 max-h-44 w-full overflow-y-auto"
              : "absolute left-0 top-7 z-30 w-48 shadow-md"
          )}
        >
          {suggestions.map((tag, i) => (
            <li key={tag.id} role="option" aria-selected={i === highlighted}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHighlighted(i)}
                onClick={() => commit(tag.title)}
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
  );
}
