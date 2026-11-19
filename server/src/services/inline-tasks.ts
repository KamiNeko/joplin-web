/**
 * Extracts and toggles GFM `- [ ]` / `- [x]` inline checklist items in Markdown notes.
 * Line and 1-based column coordinates match `client/src/lib/tasks.ts` (`TaskLocation`).
 */

export interface ExtractedInlineTask {
  line: number;
  column: number;
  text: string;
  checked: boolean;
}

const FENCE_RE = /^[ ]{0,3}(`{3,}|~{3,})/;
const INLINE_TASK_RE = /^([ \t>]*)(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\][ \t]+(.*)$/;
const TASK_AT_ITEM = /(?:[-*+]|\d{1,9}[.)])[ \t]*(?:(?:\r\n|\r|\n)[ \t>]*)?\[([ xX])\]/y;

/**
 * Extracts inline checklist tasks from a Markdown body, ignoring fenced code blocks and HTML
 * comment blocks. Coordinates are 1-based (`line`, `column` pointing at the list marker).
 */
export function extractInlineTasks(markdown: string): ExtractedInlineTask[] {
  if (!markdown || !markdown.includes('[')) return [];

  const lines = markdown.split(/\r\n|\r|\n/);
  const tasks: ExtractedInlineTask[] = [];
  let activeFence: { char: string; len: number } | null = null;
  let inHtmlComment = false;

  for (let idx = 0; idx < lines.length; idx++) {
    const lineText = lines[idx];

    if (inHtmlComment) {
      if (lineText.includes('-->')) inHtmlComment = false;
      continue;
    }

    const fenceMatch = FENCE_RE.exec(lineText);
    if (fenceMatch) {
      const seq = fenceMatch[1];
      const char = seq[0];
      if (!activeFence) {
        activeFence = { char, len: seq.length };
        continue;
      }
      if (activeFence.char === char && seq.length >= activeFence.len && lineText.slice(fenceMatch[0].length).trim() === '') {
        activeFence = null;
        continue;
      }
    }
    if (activeFence) continue;

    if (lineText.trimStart().startsWith('<!--')) {
      if (!lineText.includes('-->')) inHtmlComment = true;
      continue;
    }

    const taskMatch = INLINE_TASK_RE.exec(lineText);
    if (!taskMatch) continue;
    const text = taskMatch[3].trim();
    if (!text) continue;

    tasks.push({
      line: idx + 1,
      column: taskMatch[1].length + 1,
      text,
      checked: taskMatch[2].toLowerCase() === 'x',
    });
  }

  return tasks;
}

function toOffset(markdown: string, line: number, column: number): number | null {
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
 * Sets the checked state of the task at `(line, column)`. Returns updated Markdown or null if missing.
 */
export function setInlineTaskChecked(
  markdown: string,
  line: number,
  column: number,
  checked: boolean
): string | null {
  const offset = toOffset(markdown, line, column);
  if (offset === null) return null;
  TASK_AT_ITEM.lastIndex = offset;
  const match = TASK_AT_ITEM.exec(markdown);
  if (!match) return null;
  const markIndex = match.index + match[0].length - 2;
  return markdown.slice(0, markIndex) + (checked ? 'x' : ' ') + markdown.slice(markIndex + 1);
}
