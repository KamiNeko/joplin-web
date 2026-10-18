import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  FormatResult,
  insertLink,
  insertNoteLink,
  TextSelection,
  toggleCode,
  toggleHeading,
  toggleList,
  toggleWrap,
} from "@/lib/markdown-format";

type Transform = (text: string, sel: TextSelection) => FormatResult;

/** Formatting commands offered by the toolbar and (some of them) by shortcuts */
export type FormatCommand =
  | "bold"
  | "italic"
  | "strikethrough"
  | "code"
  | "link"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bullet"
  | "numbered"
  | "checkbox";

const transforms: Record<FormatCommand, Transform> = {
  bold: (t, s) => toggleWrap(t, s, "**"),
  italic: (t, s) => toggleWrap(t, s, "*"),
  strikethrough: (t, s) => toggleWrap(t, s, "~~"),
  code: toggleCode,
  link: insertLink,
  heading1: (t, s) => toggleHeading(t, s, 1),
  heading2: (t, s) => toggleHeading(t, s, 2),
  heading3: (t, s) => toggleHeading(t, s, 3),
  bullet: (t, s) => toggleList(t, s, "bullet"),
  numbered: (t, s) => toggleList(t, s, "numbered"),
  checkbox: (t, s) => toggleList(t, s, "checkbox"),
};

/** Shortcut per command, in CodeMirror notation (`Mod` is Ctrl, or Cmd on macOS) */
export const FORMAT_SHORTCUTS: Partial<Record<FormatCommand, string>> = {
  bold: "Mod-b",
  italic: "Mod-i",
  code: "Mod-e",
  link: "Mod-k",
};

/** Applies a transform to the main selection as one undoable change */
function applyTransform(view: EditorView, transform: Transform): boolean {
  if (view.state.readOnly) return false;
  const { from, to } = view.state.selection.main;
  const result = transform(view.state.doc.toString(), { from, to });
  view.dispatch({
    changes: result.changes,
    selection: { anchor: result.selection.from, head: result.selection.to },
    scrollIntoView: true,
    userEvent: "input.format",
  });
  return true;
}

/**
 * Runs a formatting command on the editor and gives it focus again (toolbar buttons take it).
 */
export function runFormatCommand(view: EditorView, command: FormatCommand): void {
  applyTransform(view, transforms[command]);
  view.focus();
}

/** Inserts a link to another note at the selection */
export function insertNoteLinkCommand(view: EditorView, note: { id: string; title: string }): void {
  applyTransform(view, (t, s) => insertNoteLink(t, s, note));
  view.focus();
}

/**
 * Formatting shortcuts. They take precedence over CodeMirror's defaults (Mod-i would otherwise
 * select the parent syntax node). Ctrl+S stays with the note editor, which saves on it.
 */
export function formattingKeymap() {
  return Prec.high(
    keymap.of(
      (Object.entries(FORMAT_SHORTCUTS) as Array<[FormatCommand, string]>).map(([command, key]) => ({
        key,
        run: (view: EditorView) => applyTransform(view, transforms[command]),
        preventDefault: true,
      }))
    )
  );
}

const isApple = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Formats a CodeMirror key like `Mod-b` for display: `Ctrl+B`, or `⌘B` on Apple devices */
export function shortcutLabel(key: string): string {
  const apple = isApple();
  const parts = key.split("-");
  const last = parts.pop()!.toUpperCase();
  const mods = parts.map((p) => {
    if (p === "Mod") return apple ? "⌘" : "Ctrl";
    if (p === "Shift") return apple ? "⇧" : "Shift";
    if (p === "Alt") return apple ? "⌥" : "Alt";
    return p;
  });
  return apple ? mods.join("") + last : [...mods, last].join("+");
}

/** Formats a CodeMirror key like `Mod-b` for `aria-keyshortcuts`: `Control+B` or `Meta+B` */
export function ariaShortcut(key: string): string {
  const parts = key.split("-");
  const last = parts.pop()!.toUpperCase();
  return [...parts.map((p) => (p === "Mod" ? (isApple() ? "Meta" : "Control") : p)), last].join("+");
}
