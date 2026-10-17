import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef } from "react";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { toast } from "sonner";
import { uploadResource } from "@/lib/api";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  className?: string;
  /** Called with the number of uploads in progress whenever it changes */
  onUploadsChange?: (pending: number) => void;
}

export interface MarkdownEditorHandle {
  /** Uploads files and inserts links to them at the cursor */
  insertFiles: (files: File[]) => void;
}

/** Placeholder links inserted while a file uploads (never meant to be saved) */
export const UPLOAD_PLACEHOLDER = /!?\[Uploading [^\]\n]*\]\(uploading-[a-z0-9]+\)/g;

function escapeLinkText(text: string) {
  return text.replace(/[[\]]/g, (c) => (c === "[" ? "(" : ")"));
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
  { tag: [t.string, t.attributeValue], color: "#7c9a4a" },
  { tag: [t.number, t.bool, t.atom], color: "#a86ab5" },
  { tag: t.comment, color: "hsl(var(--muted-foreground))", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#4f8ac2" },
]);

/**
 * CodeMirror 6 Markdown editor with syntax highlighting for fenced code blocks.
 * Files dropped or pasted into it are uploaded as Joplin resources and linked at that position.
 */
export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(function MarkdownEditor(
  { value, onChange, autoFocus, className, onUploadsChange },
  ref
) {
  const viewRef = useRef<EditorView | null>(null);
  const pendingRef = useRef(0);
  const onUploadsChangeRef = useRef(onUploadsChange);
  onUploadsChangeRef.current = onUploadsChange;

  const uploadFiles = useCallback((files: File[], at?: number) => {
    const view = viewRef.current;
    if (!view || files.length === 0) return;

    let pos = at ?? view.state.selection.main.head;
    for (const file of files) {
      const isImage = file.type.startsWith("image/");
      const name = escapeLinkText(file.name || (isImage ? "image" : "file"));
      const token = `${isImage ? "!" : ""}[Uploading ${name}…](uploading-${Math.random().toString(36).slice(2, 10)})`;
      const insert = files.length > 1 ? `${token}\n` : token;
      view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length } });
      pos += insert.length;

      pendingRef.current++;
      onUploadsChangeRef.current?.(pendingRef.current);

      uploadResource(file)
        .then((resource) => {
          const link = `${isImage ? "!" : ""}[${escapeLinkText(resource.title)}](:/${resource.id})`;
          replaceToken(token, link);
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

  /** Swaps a placeholder for its final text, wherever edits have moved it */
  const replaceToken = (token: string, text: string) => {
    const view = viewRef.current;
    if (!view) return;
    const from = view.state.doc.toString().indexOf(token);
    if (from < 0) return;
    view.dispatch({ changes: { from, to: from + token.length, insert: text } });
  };

  useImperativeHandle(ref, () => ({ insertFiles: (files) => uploadFiles(files) }), [uploadFiles]);

  const extensions = useMemo(
    () => [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      syntaxHighlighting(markdownHighlight),
      EditorView.lineWrapping,
      appTheme,
      EditorView.domEventHandlers({
        paste(event) {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length === 0) return false;
          event.preventDefault();
          uploadFiles(files);
          return true;
        },
        drop(event, view) {
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (files.length === 0) return false;
          event.preventDefault();
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? undefined;
          uploadFiles(files, pos);
          return true;
        },
      }),
    ],
    [uploadFiles]
  );

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      onCreateEditor={(view) => {
        viewRef.current = view;
      }}
      autoFocus={autoFocus}
      theme="none"
      height="100%"
      className={className}
      placeholder="Start writing in Markdown..."
      extensions={extensions}
      basicSetup={{
        lineNumbers: false,
        foldGutter: false,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
        autocompletion: false,
      }}
    />
  );
});
