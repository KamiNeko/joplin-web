import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import type { ViewUpdate } from "@codemirror/view";
import { toast } from "sonner";
import { uploadResource } from "@/lib/api";
import { announceWrite } from "@/lib/cross-tab";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import {
  AlertCircle,
  AlertTriangle,
  ChevronRight,
  Code2,
  FileSymlink,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  Info,
  Lightbulb,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  Table,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useNotes } from "@/hooks/use-notes";
import { useSearch } from "@/hooks/use-search";
import { FormattingToolbar } from "./FormattingToolbar";
import { NoteLinkPicker } from "./NoteLinkPicker";
import { formattingKeymap, insertNoteLinkCommand, runFormatCommand } from "./editor-commands";

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  className?: string;
  /** Called with the number of uploads in progress whenever it changes */
  onUploadsChange?: (pending: number) => void;
  /** The text is HTML (an HTML note): uploaded files are inserted as `<img>` / `<a>` instead of Markdown */
  html?: boolean;
  /** The note being edited; the "Link to note" picker leaves it out */
  noteId?: string;
}

export interface MarkdownEditorHandle {
  /** Uploads files and inserts links to them at the cursor */
  insertFiles: (files: File[]) => void;
  /** Inserts raw markup/text at the current cursor position */
  insertText: (text: string) => void;
}

/** Placeholder links inserted while a file uploads (never meant to be saved) */
export const UPLOAD_PLACEHOLDER = /!?\[Uploading [^\]\n]*\]\(uploading-[a-z0-9]+\)/g;

function escapeLinkText(text: string) {
  return text.replace(/[[\]]/g, (c) => (c === "[" ? "\\[" : "\\]"));
}

function escapePlaceholderLabel(text: string) {
  return text.replace(/[[\]]/g, (c) => (c === "[" ? "(" : ")"));
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

function escapeHtml(text: string) {
  return text.replace(/[&<>"]/g, (c) => HTML_ESCAPES[c]);
}

/** Link to an uploaded resource in the note's markup (Markdown, or HTML for HTML notes) */
function resourceLink(resource: { id: string; title: string }, isImage: boolean, html: boolean) {
  if (html) {
    const title = escapeHtml(resource.title);
    return isImage ? `<img src=":/${resource.id}" alt="${title}">` : `<a href=":/${resource.id}">${title}</a>`;
  }
  return `${isImage ? "!" : ""}[${escapePlaceholderLabel(resource.title)}](:/${resource.id})`;
}

interface SlashCommandDef {
  id: string;
  label: string;
  description: string;
  keywords: string;
  icon: typeof Heading1;
  insert?: string;
  cursorBackOffset?: number;
  action?: "note-link";
}

const SLASH_COMMANDS: SlashCommandDef[] = [
  { id: "h1", label: "Heading 1", description: "Large section heading", keywords: "h1 heading title", icon: Heading1, insert: "# " },
  { id: "h2", label: "Heading 2", description: "Medium section heading", keywords: "h2 heading subtitle", icon: Heading2, insert: "## " },
  { id: "h3", label: "Heading 3", description: "Small section heading", keywords: "h3 heading", icon: Heading3, insert: "### " },
  { id: "todo", label: "Checklist", description: "Track tasks with checkboxes", keywords: "todo task checklist checkbox", icon: ListChecks, insert: "- [ ] " },
  { id: "bullet", label: "Bulleted list", description: "Simple bulleted list", keywords: "bullet list ul", icon: List, insert: "- " },
  { id: "numbered", label: "Numbered list", description: "Ordered numbered list", keywords: "numbered ordered list ol", icon: ListOrdered, insert: "1. " },
  { id: "callout-note", label: "Callout: Note", description: "Blue informational callout", keywords: "callout note info", icon: Info, insert: "> [!NOTE]\n> " },
  { id: "callout-tip", label: "Callout: Tip", description: "Green helpful tip callout", keywords: "callout tip hint", icon: Lightbulb, insert: "> [!TIP]\n> " },
  { id: "callout-warning", label: "Callout: Warning", description: "Amber warning callout", keywords: "callout warning alert", icon: AlertTriangle, insert: "> [!WARNING]\n> " },
  { id: "callout-important", label: "Callout: Important", description: "Highlighted important block", keywords: "callout important", icon: AlertCircle, insert: "> [!IMPORTANT]\n> " },
  {
    id: "toggle",
    label: "Toggle section",
    description: "Collapsible details block",
    keywords: "toggle details collapse accordion",
    icon: ChevronRight,
    insert: "<details>\n<summary>Toggle title</summary>\n\nDetails...\n\n</details>",
  },
  {
    id: "table",
    label: "Table",
    description: "3-column Markdown table",
    keywords: "table grid columns",
    icon: Table,
    insert: "| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |",
  },
  {
    id: "codeblock",
    label: "Code block",
    description: "Fenced syntax-highlighted code",
    keywords: "code block fence snippet",
    icon: Code2,
    insert: "```\n\n```",
    cursorBackOffset: 4,
  },
  { id: "quote", label: "Blockquote", description: "Capture a quote", keywords: "quote blockquote", icon: Quote, insert: "> " },
  { id: "divider", label: "Divider", description: "Horizontal separator line", keywords: "divider hr separator line", icon: Minus, insert: "---\n" },
  { id: "note-link", label: "Link to note", description: "Insert link to another note", keywords: "link note wiki", icon: FileSymlink, action: "note-link" },
];

type TriggerState =
  | { kind: "slash"; from: number; to: number; query: string }
  | { kind: "wiki"; from: number; to: number; query: string };

interface PopupCoords {
  top: number;
  left: number;
}

/**
 * Editor chrome built from the app's CSS tokens, so it follows light and dark mode
 * without a separate CodeMirror theme per mode.
 */
const appTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "0.9375rem",
    backgroundColor: "transparent",
    color: "hsl(var(--foreground))",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    lineHeight: "1.7",
  },
  ".cm-content": {
    padding: "0 0 40vh 0",
    caretColor: "hsl(var(--primary))",
    maxWidth: "56rem",
  },
  ".cm-line": { padding: "0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "hsl(var(--primary))", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
    { backgroundColor: "hsl(var(--primary) / 0.22) !important" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-gutters": { display: "none" },
  ".cm-placeholder": { color: "hsl(var(--muted-foreground))" },
  ".cm-panels": {
    backgroundColor: "hsl(var(--popover))",
    color: "hsl(var(--popover-foreground))",
    borderColor: "hsl(var(--border))",
  },
  ".cm-searchMatch": { backgroundColor: "hsl(var(--primary) / 0.25)" },
  ".cm-tooltip": {
    backgroundColor: "hsl(var(--popover))",
    border: "1px solid hsl(var(--border))",
  },
});

const markdownHighlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: "700", fontSize: "1.35em" },
  { tag: t.heading2, fontWeight: "700", fontSize: "1.2em" },
  { tag: t.heading3, fontWeight: "650", fontSize: "1.08em" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "650" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "hsl(var(--primary))" },
  { tag: t.monospace, color: "hsl(var(--primary))" },
  { tag: t.quote, color: "hsl(var(--muted-foreground))", fontStyle: "italic" },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: "hsl(var(--muted-foreground))" },
  { tag: t.list, color: "hsl(var(--primary))" },
  { tag: [t.keyword, t.tagName], color: "hsl(var(--primary))" },
  { tag: [t.string, t.attributeValue], color: "hsl(var(--syntax-string))" },
  { tag: [t.number, t.bool, t.atom], color: "hsl(var(--syntax-number))" },
  { tag: t.comment, color: "hsl(var(--muted-foreground))", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "hsl(var(--syntax-function))" },
]);

/**
 * CodeMirror 6 Markdown editor with syntax highlighting for fenced code blocks, a formatting
 * toolbar with shortcuts (Ctrl+B/I/E/K), `/` slash commands, `[[` wiki-link autocomplete,
 * and a picker for links to other notes.
 * Files dropped or pasted into it are uploaded as Joplin resources and linked at that position.
 */
export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(function MarkdownEditor(
  { value, onChange, autoFocus, className, onUploadsChange, html = false, noteId },
  ref
) {
  const viewRef = useRef<EditorView | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [trigger, setTrigger] = useState<TriggerState | null>(null);
  const [popupCoords, setPopupCoords] = useState<PopupCoords>({ top: 80, left: 40 });
  const [activeIndex, setActiveIndex] = useState(0);

  const pendingRef = useRef(0);
  const onUploadsChangeRef = useRef(onUploadsChange);
  const htmlRef = useRef(html);

  useEffect(() => {
    onUploadsChangeRef.current = onUploadsChange;
  }, [onUploadsChange]);

  useEffect(() => {
    htmlRef.current = html;
  }, [html]);

  const wikiHandlerRef = useRef<{ move: (delta: number) => void; accept: () => boolean } | null>(null);
  const registerWikiHandler = useCallback(
    (handler: { move: (delta: number) => void; accept: () => boolean } | null) => {
      wikiHandlerRef.current = handler;
    },
    []
  );

  const slashItems = useMemo(() => {
    if (trigger?.kind !== "slash") return [];
    const q = trigger.query.trim().toLowerCase();
    if (!q) return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter(
      (cmd) => cmd.label.toLowerCase().includes(q) || cmd.keywords.includes(q)
    );
  }, [trigger]);

  const clampedSlashIndex = slashItems.length > 0 ? Math.min(activeIndex, slashItems.length - 1) : 0;

  const applySlashCommand = useCallback(
    (cmd: SlashCommandDef) => {
      const view = viewRef.current;
      if (!view || !trigger || trigger.kind !== "slash") return;
      if (cmd.action === "note-link") {
        view.dispatch({
          changes: { from: trigger.from, to: trigger.to, insert: "" },
          selection: { anchor: trigger.from },
        });
        setTrigger(null);
        setPickerOpen(true);
        return;
      }
      const insertText = cmd.insert ?? "";
      const anchor = trigger.from + insertText.length - (cmd.cursorBackOffset ?? 0);
      view.dispatch({
        changes: { from: trigger.from, to: trigger.to, insert: insertText },
        selection: { anchor },
        scrollIntoView: true,
        userEvent: "input.format",
      });
      setTrigger(null);
      view.focus();
    },
    [trigger]
  );

  const applyWikiLink = useCallback(
    (picked: { id: string; title: string }) => {
      const view = viewRef.current;
      if (!view || !trigger || trigger.kind !== "wiki") return;
      const linkText = `[${escapeLinkText(picked.title || "Untitled")}](:/${picked.id})`;
      const trailing = view.state.doc.sliceString(trigger.to, trigger.to + 2);
      const replaceTo =
        trailing === "]]" ? trigger.to + 2 : trailing.startsWith("]") ? trigger.to + 1 : trigger.to;
      view.dispatch({
        changes: { from: trigger.from, to: replaceTo, insert: linkText },
        selection: { anchor: trigger.from + linkText.length },
        scrollIntoView: true,
        userEvent: "input.format",
      });
      setTrigger(null);
      view.focus();
    },
    [trigger]
  );

  const popupHandlerRef = useRef<{
    isOpen: boolean;
    move: (delta: number) => void;
    accept: () => boolean;
    dismiss: () => void;
  }>({
    isOpen: false,
    move: () => undefined,
    accept: () => false,
    dismiss: () => undefined,
  });

  useEffect(() => {
    popupHandlerRef.current = {
      isOpen: Boolean(trigger) && !html,
      move: (delta) => {
        if (!trigger) return;
        if (trigger.kind === "wiki") {
          wikiHandlerRef.current?.move(delta);
          return;
        }
        if (slashItems.length === 0) return;
        setActiveIndex((prev) => (prev + delta + slashItems.length) % slashItems.length);
      },
      accept: () => {
        if (!trigger) return false;
        if (trigger.kind === "wiki") {
          return wikiHandlerRef.current?.accept() ?? false;
        }
        if (slashItems.length === 0) return false;
        const item = slashItems[clampedSlashIndex];
        if (!item) return false;
        applySlashCommand(item);
        return true;
      },
      dismiss: () => setTrigger(null),
    };
  }, [trigger, html, slashItems, clampedSlashIndex, applySlashCommand]);

  const uploadFiles = useCallback((files: File[], at?: number) => {
    const view = viewRef.current;
    if (!view || files.length === 0) return;

    /** Swaps a placeholder for its final text, wherever edits have moved it */
    const replaceToken = (token: string, text: string) => {
      const activeView = viewRef.current;
      if (!activeView) return;
      const from = activeView.state.doc.toString().indexOf(token);
      if (from < 0) return;
      activeView.dispatch({ changes: { from, to: from + token.length, insert: text } });
    };

    let pos = at ?? view.state.selection.main.head;
    for (const file of files) {
      const isImage = file.type.startsWith("image/");
      const name = escapePlaceholderLabel(file.name || (isImage ? "image" : "file"));
      const token = `${isImage ? "!" : ""}[Uploading ${name}…](uploading-${Math.random().toString(36).slice(2, 10)})`;
      const insert = files.length > 1 ? `${token}\n` : token;
      view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length } });
      pos += insert.length;

      pendingRef.current++;
      onUploadsChangeRef.current?.(pendingRef.current);

      uploadResource(file)
        .then((resource) => {
          replaceToken(token, resourceLink(resource, isImage, htmlRef.current));
          announceWrite();
        })
        .catch((err) => {
          replaceToken(token, "");
          toast.error(`Could not upload "${file.name}"`, {
            description: err instanceof Error ? err.message : undefined,
          });
        })
        .finally(() => {
          pendingRef.current--;
          onUploadsChangeRef.current?.(pendingRef.current);
        });
    }
  }, []);

  const insertRawText = useCallback((text: string) => {
    const view = viewRef.current;
    if (!view || !text) return;
    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      scrollIntoView: true,
    });
    view.focus();
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      insertFiles: (files) => uploadFiles(files),
      insertText: (text) => insertRawText(text),
    }),
    [uploadFiles, insertRawText]
  );

  const extensions = useMemo(
    () => [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      syntaxHighlighting(markdownHighlight),
      // HTML notes are edited as raw HTML: no Markdown formatting commands
      ...(html ? [] : [formattingKeymap()]),
      EditorView.lineWrapping,
      appTheme,
    ],
    [html]
  );

  const handleEditorUpdate = useCallback(
    (update: ViewUpdate) => {
      if (html) return;
      if (!update.docChanged && !update.selectionSet) return;
      const sel = update.state.selection.main;
      if (!sel.empty) {
        setTrigger(null);
        return;
      }
      const pos = sel.head;
      const line = update.state.doc.lineAt(pos);
      const before = line.text.slice(0, pos - line.from);

      const wikiMatch = /\[\[([^\]\n]*)$/.exec(before);
      if (wikiMatch) {
        const from = pos - wikiMatch[0].length;
        const coords = update.view.coordsAtPos(pos);
        if (coords) {
          setPopupCoords({
            top: Math.min(coords.bottom + 6, Math.max(80, window.innerHeight - 280)),
            left: Math.min(coords.left, Math.max(20, window.innerWidth - 300)),
          });
        }
        setActiveIndex(0);
        setTrigger({ kind: "wiki", from, to: pos, query: wikiMatch[1] });
        return;
      }

      const slashMatch = /(?:^|\s)(\/([a-z0-9-]*))$/i.exec(before);
      if (slashMatch) {
        const from = pos - slashMatch[1].length;
        const coords = update.view.coordsAtPos(pos);
        if (coords) {
          setPopupCoords({
            top: Math.min(coords.bottom + 6, Math.max(80, window.innerHeight - 300)),
            left: Math.min(coords.left, Math.max(20, window.innerWidth - 280)),
          });
        }
        setActiveIndex(0);
        setTrigger({ kind: "slash", from, to: pos, query: slashMatch[2] });
        return;
      }

      setTrigger(null);
    },
    [html]
  );

  const handleKeyDownCapture = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!popupHandlerRef.current.isOpen) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      popupHandlerRef.current.move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      popupHandlerRef.current.move(-1);
    } else if (e.key === "Enter") {
      if (popupHandlerRef.current.accept()) {
        e.preventDefault();
        e.stopPropagation();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      popupHandlerRef.current.dismiss();
    }
  };

  const handlePasteCapture = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    uploadFiles(files);
  };

  const handleDropCapture = (e: React.DragEvent<HTMLDivElement>) => {
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const pos = viewRef.current?.posAtCoords({ x: e.clientX, y: e.clientY }) ?? undefined;
    uploadFiles(files, pos);
  };

  const focusEditor = () => viewRef.current?.focus();

  return (
    <div
      className={cn("relative flex min-h-0 flex-col", className)}
      onKeyDownCapture={handleKeyDownCapture}
      onPasteCapture={handlePasteCapture}
      onDropCapture={handleDropCapture}
    >
      {!html && (
        <div className="shrink-0 border-b border-border/40 mb-2">
          <FormattingToolbar
            onCommand={(command) => viewRef.current && runFormatCommand(viewRef.current, command)}
            onInsertNoteLink={() => setPickerOpen(true)}
            onRestoreFocus={focusEditor}
          />
        </div>
      )}
      <CodeMirror
        value={value}
        onChange={onChange}
        onUpdate={handleEditorUpdate}
        onCreateEditor={(view) => {
          viewRef.current = view;
        }}
        autoFocus={autoFocus}
        theme="none"
        height="100%"
        className="flex-1 min-h-0"
        placeholder="Start writing in Markdown… (type / for blocks or [[ to link notes)"
        extensions={extensions}
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          autocompletion: false,
        }}
      />

      {!html && trigger?.kind === "slash" && (
        <div
          role="listbox"
          aria-label="Slash commands"
          style={{ top: `${popupCoords.top}px`, left: `${popupCoords.left}px` }}
          className="fixed z-50 w-64 max-h-64 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
        >
          {slashItems.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-muted-foreground">No matching block</p>
          ) : (
            slashItems.map((cmd, idx) => {
              const Icon = cmd.icon;
              return (
                <button
                  key={cmd.id}
                  type="button"
                  role="option"
                  aria-selected={idx === clampedSlashIndex}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => setActiveIndex(idx)}
                  onClick={() => applySlashCommand(cmd)}
                  className={cn(
                    "w-full flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                    idx === clampedSlashIndex
                      ? "bg-accent text-accent-foreground"
                      : "text-popover-foreground hover:bg-accent/50"
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{cmd.label}</div>
                    <div className="text-[11px] text-muted-foreground truncate">{cmd.description}</div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      )}

      {!html && trigger?.kind === "wiki" && (
        <WikiLinkListbox
          query={trigger.query}
          noteId={noteId}
          popupCoords={popupCoords}
          activeIndex={activeIndex}
          onActiveIndexChange={setActiveIndex}
          onPick={applyWikiLink}
          onRegisterHandler={registerWikiHandler}
        />
      )}

      <NoteLinkPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        excludeId={noteId}
        onSelect={(note) => viewRef.current && insertNoteLinkCommand(viewRef.current, note)}
        onCloseAutoFocus={focusEditor}
      />
    </div>
  );
});

function WikiLinkListbox({
  query,
  noteId,
  popupCoords,
  activeIndex,
  onActiveIndexChange,
  onPick,
  onRegisterHandler,
}: {
  query: string;
  noteId?: string;
  popupCoords: PopupCoords;
  activeIndex: number;
  onActiveIndexChange: (updater: number | ((prev: number) => number)) => void;
  onPick: (note: { id: string; title: string }) => void;
  onRegisterHandler: (handler: { move: (delta: number) => void; accept: () => boolean } | null) => void;
}) {
  const trimmed = query.trim();
  const wikiSearch = useSearch(trimmed);
  const allNotesQuery = useNotes(undefined, undefined, false, trimmed.length < 2);

  const wikiItems = useMemo(() => {
    if (trimmed.length >= 2) {
      return (wikiSearch.data ?? []).filter((n) => n.id !== noteId).slice(0, 10);
    }
    const list = (allNotesQuery.data ?? []).filter((n) => n.id !== noteId);
    if (!trimmed) return list.slice(0, 10);
    const lower = trimmed.toLowerCase();
    return list.filter((n) => (n.title || "Untitled").toLowerCase().includes(lower)).slice(0, 10);
  }, [trimmed, wikiSearch.data, allNotesQuery.data, noteId]);

  const clampedIndex = wikiItems.length > 0 ? Math.min(activeIndex, wikiItems.length - 1) : 0;

  useEffect(() => {
    onRegisterHandler({
      move: (delta) => {
        if (wikiItems.length === 0) return;
        onActiveIndexChange((prev) => (prev + delta + wikiItems.length) % wikiItems.length);
      },
      accept: () => {
        const picked = wikiItems[clampedIndex];
        if (!picked) return false;
        onPick({ id: picked.id, title: picked.title });
        return true;
      },
    });
    return () => onRegisterHandler(null);
  }, [onRegisterHandler, onActiveIndexChange, onPick, wikiItems, clampedIndex]);

  return (
    <div
      role="listbox"
      aria-label="Wiki-link note suggestions"
      style={{ top: `${popupCoords.top}px`, left: `${popupCoords.left}px` }}
      className="fixed z-50 w-64 max-h-64 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
    >
      {wikiItems.length === 0 ? (
        <p className="px-2.5 py-2 text-xs text-muted-foreground">No matching notes</p>
      ) : (
        wikiItems.map((note, idx) => (
          <button
            key={note.id}
            type="button"
            role="option"
            aria-selected={idx === clampedIndex}
            onMouseDown={(e) => e.preventDefault()}
            onMouseMove={() => onActiveIndexChange(idx)}
            onClick={() => onPick({ id: note.id, title: note.title })}
            className={cn(
              "w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
              idx === clampedIndex
                ? "bg-accent text-accent-foreground"
                : "text-popover-foreground hover:bg-accent/50"
            )}
          >
            <FileText className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
            <span className="truncate font-medium">{note.title || "Untitled Note"}</span>
          </button>
        ))
      )}
    </div>
  );
}
