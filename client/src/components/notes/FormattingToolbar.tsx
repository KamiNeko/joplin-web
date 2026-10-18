import { CSSProperties, Fragment, KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  Bold,
  Code,
  FileSymlink,
  Heading,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  LucideIcon,
  Strikethrough,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ariaShortcut, FORMAT_SHORTCUTS, FormatCommand, shortcutLabel } from "./editor-commands";

interface FormattingToolbarProps {
  onCommand: (command: FormatCommand) => void;
  onInsertNoteLink: () => void;
  /** Called when a menu closes, to give the editor its focus back */
  onRestoreFocus: () => void;
}

interface ToolbarItem {
  id: FormatCommand | "noteLink";
  label: string;
  icon: LucideIcon;
}

const GROUPS: ToolbarItem[][] = [
  [
    { id: "bold", label: "Bold", icon: Bold },
    { id: "italic", label: "Italic", icon: Italic },
    { id: "strikethrough", label: "Strikethrough", icon: Strikethrough },
    { id: "code", label: "Code", icon: Code },
  ],
  [
    { id: "bullet", label: "Bulleted list", icon: List },
    { id: "numbered", label: "Numbered list", icon: ListOrdered },
    { id: "checkbox", label: "Checklist", icon: ListChecks },
  ],
  [
    { id: "link", label: "Link", icon: Link },
    { id: "noteLink", label: "Link to note", icon: FileSymlink },
  ],
];

const HEADINGS = [
  { id: "heading1", label: "Heading 1", icon: Heading1 },
  { id: "heading2", label: "Heading 2", icon: Heading2 },
  { id: "heading3", label: "Heading 3", icon: Heading3 },
] as const;

const buttonClass =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground";

/** Keeps the editor's focus and selection when a button is clicked with the mouse */
const keepEditorFocus = (e: React.MouseEvent) => e.preventDefault();

/**
 * Compact formatting toolbar above the Markdown editor. It scrolls horizontally when it doesn't
 * fit; arrow keys move between its buttons, so it is a single tab stop.
 */
export function FormattingToolbar({ onCommand, onInsertNoteLink, onRestoreFocus }: FormattingToolbarProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  // Which ends have buttons scrolled out of view; those ends fade out as a hint
  const [hidden, setHidden] = useState({ start: false, end: false });

  const updateHidden = () => {
    const el = ref.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setHidden((h) => (h.start === start && h.end === end ? h : { start, end }));
  };

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => updateHidden());
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fade = "1.5rem";
  const mask = `linear-gradient(to right, ${hidden.start ? "transparent" : "black"}, black ${fade}, black calc(100% - ${fade}), ${hidden.end ? "transparent" : "black"})`;
  const maskStyle: CSSProperties | undefined =
    hidden.start || hidden.end ? { maskImage: mask, WebkitMaskImage: mask } : undefined;
  let index = 0;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    let next: number;
    if (e.key === "ArrowRight") next = (current + 1) % buttons.length;
    else if (e.key === "ArrowLeft") next = (current - 1 + buttons.length) % buttons.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = buttons.length - 1;
    else return;
    e.preventDefault();
    setActive(next);
    buttons[next].focus();
  };

  const tooltip = (label: string, shortcut?: string) => (
    <TooltipContent side="bottom">
      {label}
      {shortcut && <span className="ml-2 opacity-70">{shortcutLabel(shortcut)}</span>}
    </TooltipContent>
  );

  const headingIndex = index++;

  return (
    <TooltipProvider delayDuration={500}>
      <div
        ref={ref}
        onScroll={updateHidden}
        style={maskStyle}
        role="toolbar"
        aria-label="Formatting"
        onKeyDown={onKeyDown}
        className="flex items-center overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Heading"
                  tabIndex={active === headingIndex ? 0 : -1}
                  onFocus={() => setActive(headingIndex)}
                  onMouseDown={keepEditorFocus}
                  className={buttonClass}
                >
                  <Heading className="h-4 w-4" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            {tooltip("Heading")}
          </Tooltip>
          <DropdownMenuContent
            align="start"
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              onRestoreFocus();
            }}
          >
            {HEADINGS.map(({ id, label, icon: Icon }) => (
              <DropdownMenuItem key={id} onSelect={() => onCommand(id)}>
                <Icon className="h-4 w-4" aria-hidden="true" />
                {label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {GROUPS.map((group, g) => (
          <Fragment key={g}>
            <span className="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden="true" />
            {group.map(({ id, label, icon: Icon }) => {
              const i = index++;
              const shortcut = id === "noteLink" ? undefined : FORMAT_SHORTCUTS[id];
              return (
                <Tooltip key={id}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={label}
                      aria-keyshortcuts={shortcut ? ariaShortcut(shortcut) : undefined}
                      tabIndex={active === i ? 0 : -1}
                      onFocus={() => setActive(i)}
                      onMouseDown={keepEditorFocus}
                      onClick={() => (id === "noteLink" ? onInsertNoteLink() : onCommand(id))}
                      className={buttonClass}
                    >
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  {tooltip(label, shortcut)}
                </Tooltip>
              );
            })}
          </Fragment>
        ))}
      </div>
    </TooltipProvider>
  );
}
