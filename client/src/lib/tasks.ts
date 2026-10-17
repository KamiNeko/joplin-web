/**
 * Helpers for GFM task lists ("- [ ] item") in note Markdown.
 *
 * Which list items are tasks is decided by the Markdown parser that renders the note (remark-gfm),
 * not by a separate line scanner: the renderer reports the source position of each rendered
 * task item, and toggling edits the "[ ]" of exactly that item. Code blocks, HTML comments,
 * HTML blocks and empty "- [ ]" items are therefore never touched.
 */

/** Source position (1-based line and column) where a task list item starts, i.e. its list marker */
export interface TaskLocation {
  line: number;
  column: number;
}

// The list marker, then whitespace (the item may continue on the next line, possibly inside
// blockquotes), then the task marker. Matched sticky at the item's start position.
const TASK_AT_ITEM = /(?:[-*+]|\d{1,9}[.)])[ \t]*(?:(?:\r\n|\r|\n)[ \t>]*)?\[([ xX])\]/y;

/** Offset of a 1-based line/column, counting line endings the way the Markdown parser does */
function toOffset(markdown: string, { line, column }: TaskLocation): number | null {
  if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1) return null;
  const lineEnding = /\r\n|\r|\n/g;
  let start = 0;
  for (let current = 1; current < line; current++) {
    const match = lineEnding.exec(markdown);
    if (!match) return null;
    start = match.index + match[0].length;
  }
  const offset = start + column - 1;
  return offset <= markdown.length ? offset : null;
}

/**
 * Sets the checked state of the task list item that starts at `location` (as reported by the
 * Markdown renderer). Returns the updated Markdown, or null if there is no task item at that
 * position (e.g. the text changed in the meantime), so a stale click never edits the wrong line.
 */
export function setTaskChecked(markdown: string, location: TaskLocation, checked: boolean): string | null {
  const offset = toOffset(markdown, location);
  if (offset === null) return null;
  TASK_AT_ITEM.lastIndex = offset;
  const match = TASK_AT_ITEM.exec(markdown);
  if (!match) return null;
  // Position of the character between the brackets
  const markIndex = match.index + match[0].length - 2;
  return markdown.slice(0, markIndex) + (checked ? "x" : " ") + markdown.slice(markIndex + 1);
}
