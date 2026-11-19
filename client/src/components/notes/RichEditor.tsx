import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Editor, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table/kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import {
  Bold,
  Code,
  FileCode2,
  FileSymlink,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Plus,
  Quote,
  Redo2,
  Strikethrough,
  Table,
  Trash2,
  Undo2,
  Unlink,
} from "lucide-react";
import { toast } from "sonner";
import { uploadResource } from "@/lib/api";
import { announceWrite } from "@/lib/cross-tab";
import { joplinToRichMarkdown, richMarkdownToJoplin } from "@/lib/note-stats";
import { cn } from "@/lib/utils";
import { PromptDialog } from "@/components/common/Dialogs";
import { NoteLinkPicker } from "./NoteLinkPicker";

interface RichEditorProps {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  className?: string;
  onUploadsChange?: (pending: number) => void;
  noteId?: string;
}

export interface RichEditorHandle {
  insertFiles: (files: File[]) => void;
  insertText: (text: string) => void;
}

const toolButtonClass = (active = false) =>
  cn(
    "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
    active && "bg-muted text-foreground"
  );

export const RichEditor = forwardRef<RichEditorHandle, RichEditorProps>(function RichEditor(
  { value, onChange, autoFocus = false, className, onUploadsChange, noteId },
  ref
) {
  const [notePickerOpen, setNotePickerOpen] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [, setSelectionTick] = useState(0);

  const onChangeRef = useRef(onChange);
  const onUploadsChangeRef = useRef(onUploadsChange);
  const editorInstanceRef = useRef<Editor | null>(null);
  const pendingRef = useRef(0);
  const lastEmittedRef = useRef(value);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onUploadsChangeRef.current = onUploadsChange;
  }, [onUploadsChange]);

  const uploadAndInsertFiles = useCallback(async (files: File[]) => {
    const activeEditor = editorInstanceRef.current;
    if (!activeEditor || files.length === 0) return;

    for (const file of files) {
      pendingRef.current += 1;
      onUploadsChangeRef.current?.(pendingRef.current);
      try {
        const resource = await uploadResource(file);
        announceWrite();
        const ed = editorInstanceRef.current;
        if (!ed || ed.isDestroyed) continue;
        if (file.type.startsWith("image/")) {
          ed.chain()
            .focus()
            .setImage({ src: `/api/resources/${resource.id}`, alt: resource.title || file.name })
            .run();
        } else {
          ed.chain()
            .focus()
            .insertContent([
              {
                type: "text",
                text: resource.title || file.name,
                marks: [{ type: "link", attrs: { href: `/joplin-item/${resource.id}` } }],
              },
              { type: "text", text: " " },
            ])
            .run();
        }
      } catch (err) {
        toast.error(`Could not upload "${file.name}"`, {
          description: err instanceof Error ? err.message : undefined,
        });
      } finally {
        pendingRef.current = Math.max(0, pendingRef.current - 1);
        onUploadsChangeRef.current?.(pendingRef.current);
      }
    }
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: {
          openOnClick: false,
          autolink: true,
        },
      }),
      TableKit.configure({
        table: { resizable: false },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Highlight,
      Image.configure({
        HTMLAttributes: { class: "rounded-lg max-h-[32rem] my-3 border border-border/50" },
      }),
      Placeholder.configure({
        placeholder: "Start writing in rich mode...",
      }),
      Markdown,
    ],
    content: joplinToRichMarkdown(value),
    contentType: "markdown",
    autofocus: autoFocus,
    onUpdate: ({ editor: ed }) => {
      const md = richMarkdownToJoplin(ed.getMarkdown());
      lastEmittedRef.current = md;
      onChangeRef.current(md);
    },
    onSelectionUpdate: () => {
      setSelectionTick((t) => t + 1);
    },
    editorProps: {
      attributes: {
        class: "rich-editor-content min-h-[18rem] outline-hidden pb-32 text-[0.9375rem] leading-[1.75]",
        "aria-label": "Rich note editor",
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length === 0) return false;
        event.preventDefault();
        void uploadAndInsertFiles(files);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length === 0) return false;
        event.preventDefault();
        void uploadAndInsertFiles(files);
        return true;
      },
    },
  });

  useEffect(() => {
    editorInstanceRef.current = editor;
  }, [editor]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (value === lastEmittedRef.current) return;
    lastEmittedRef.current = value;
    editor.commands.setContent(joplinToRichMarkdown(value), { emitUpdate: false, contentType: "markdown" });
  }, [editor, value]);

  useImperativeHandle(
    ref,
    () => ({
      insertFiles: (files) => {
        void uploadAndInsertFiles(files);
      },
      insertText: (text) => {
        if (!editor || editor.isDestroyed) return;
        editor.chain().focus().insertContent(joplinToRichMarkdown(text), { contentType: "markdown" }).run();
      },
    }),
    [editor, uploadAndInsertFiles]
  );

  const inTable = editor?.isActive("table") ?? false;

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      {/* Rich formatting bar */}
      <div
        role="toolbar"
        aria-label="Rich formatting"
        className="shrink-0 flex flex-wrap items-center gap-0.5 border-b border-border/40 pb-1.5 mb-3"
      >
        <button
          type="button"
          aria-label="Heading 1"
          title="Heading 1"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
          className={toolButtonClass(editor?.isActive("heading", { level: 1 }))}
        >
          <Heading1 className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Heading 2"
          title="Heading 2"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
          className={toolButtonClass(editor?.isActive("heading", { level: 2 }))}
        >
          <Heading2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Heading 3"
          title="Heading 3"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
          className={toolButtonClass(editor?.isActive("heading", { level: 3 }))}
        >
          <Heading3 className="h-4 w-4" />
        </button>

        <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />

        <button
          type="button"
          aria-label="Bold"
          title="Bold (Ctrl+B)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor?.chain().focus().toggleBold().run()}
          className={toolButtonClass(editor?.isActive("bold"))}
        >
          <Bold className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Italic"
          title="Italic (Ctrl+I)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
          className={toolButtonClass(editor?.isActive("italic"))}
        >
          <Italic className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Strikethrough"
          title="Strikethrough"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor?.chain().focus().toggleStrike().run()}
          className={toolButtonClass(editor?.isActive("strike"))}
        >
          <Strikethrough className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Highlight"
          title="Highlight"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor?.chain().focus().toggleHighlight().run()}
          className={toolButtonClass(editor?.isActive("highlight"))}
        >
          <Highlighter className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Inline code"
          title="Inline code"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor?.chain().focus().toggleCode().run()}
          className={toolButtonClass(editor?.isActive("code"))}
        >
          <Code className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Code block"
          title="Code block"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
          className={toolButtonClass(editor?.isActive("codeBlock"))}
        >
          <FileCode2 className="h-4 w-4" />
        </button>

        <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />

        <button
          type="button"
          aria-label="Bulleted list"
          title="Bulleted list"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
          className={toolButtonClass(editor?.isActive("bulletList"))}
        >
          <List className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Numbered list"
          title="Numbered list"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          className={toolButtonClass(editor?.isActive("orderedList"))}
        >
          <ListOrdered className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Checklist"
          title="Checklist"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor?.chain().focus().toggleTaskList().run()}
          className={toolButtonClass(editor?.isActive("taskList"))}
        >
          <ListChecks className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Blockquote"
          title="Blockquote"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
          className={toolButtonClass(editor?.isActive("blockquote"))}
        >
          <Quote className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Horizontal rule"
          title="Horizontal rule"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor?.chain().focus().setHorizontalRule().run()}
          className={toolButtonClass(false)}
        >
          <Minus className="h-4 w-4" />
        </button>

        <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />

        <button
          type="button"
          aria-label="Insert table"
          title="Insert 3x3 table"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
          className={toolButtonClass(inTable)}
        >
          <Table className="h-4 w-4" />
        </button>
        {inTable && (
          <>
            <button
              type="button"
              aria-label="Add table row"
              title="Add row below"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor?.chain().focus().addRowAfter().run()}
              className="flex h-7 items-center gap-0.5 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Plus className="h-3 w-3" /> Row
            </button>
            <button
              type="button"
              aria-label="Add table column"
              title="Add column after"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor?.chain().focus().addColumnAfter().run()}
              className="flex h-7 items-center gap-0.5 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Plus className="h-3 w-3" /> Col
            </button>
            <button
              type="button"
              aria-label="Delete table"
              title="Delete table"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor?.chain().focus().deleteTable().run()}
              className={toolButtonClass(false)}
            >
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </button>
          </>
        )}

        <button
          type="button"
          aria-label="Insert link"
          title="Insert URL link"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setLinkDialogOpen(true)}
          className={toolButtonClass(editor?.isActive("link"))}
        >
          <Link className="h-4 w-4" />
        </button>
        {editor?.isActive("link") && (
          <button
            type="button"
            aria-label="Remove link"
            title="Remove link"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => editor.chain().focus().unsetLink().run()}
            className={toolButtonClass(false)}
          >
            <Unlink className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          aria-label="Link to note"
          title="Link to another note"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setNotePickerOpen(true)}
          className={toolButtonClass(false)}
        >
          <FileSymlink className="h-4 w-4" />
        </button>

        <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />

        <button
          type="button"
          aria-label="Undo"
          title="Undo"
          disabled={!editor?.can().undo()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor?.chain().focus().undo().run()}
          className={toolButtonClass(false)}
        >
          <Undo2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Redo"
          title="Redo"
          disabled={!editor?.can().redo()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor?.chain().focus().redo().run()}
          className={toolButtonClass(false)}
        >
          <Redo2 className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto pr-1">
        <EditorContent editor={editor} />
      </div>

      <PromptDialog
        open={linkDialogOpen}
        onOpenChange={setLinkDialogOpen}
        title="Insert link"
        placeholder="https://example.com"
        initialValue={String(editor?.getAttributes("link")?.href ?? "")}
        confirmLabel="Apply"
        onSubmit={(url) => {
          const trimmed = url.trim();
          if (trimmed && editor && !editor.isDestroyed) {
            if (editor.state.selection.empty) {
              editor
                .chain()
                .focus()
                .insertContent([
                  { type: "text", text: trimmed, marks: [{ type: "link", attrs: { href: trimmed } }] },
                ])
                .run();
            } else {
              editor.chain().focus().setLink({ href: trimmed }).run();
            }
          }
          setLinkDialogOpen(false);
        }}
      />

      <NoteLinkPicker
        open={notePickerOpen}
        onOpenChange={setNotePickerOpen}
        excludeId={noteId}
        onSelect={(picked) => {
          if (!editor || editor.isDestroyed) return;
          editor
            .chain()
            .focus()
            .insertContent([
              {
                type: "text",
                text: picked.title || "Untitled",
                marks: [{ type: "link", attrs: { href: `/joplin-item/${picked.id}` } }],
              },
              { type: "text", text: " " },
            ])
            .run();
        }}
        onCloseAutoFocus={() => editor?.commands.focus()}
      />
    </div>
  );
});
