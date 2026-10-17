/**
 * Helpers for GFM task lists ("- [ ] item") in note Markdown.
 */

// List item with a task marker, optionally inside blockquotes: "- [ ] ", "  1. [x] ", "> * [ ] "
const TASK_LINE = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])(?=\s|$)/;
const FENCE = /^\s*(?:>\s*)*(`{3,}|~{3,})/;

/**
 * Sets the checked state of the n-th task-list item (0-based, document order, ignoring fenced
 * code blocks). Returns the updated Markdown, or null if there is no such task item.
 */
export function setTaskChecked(markdown: string, index: number, checked: boolean): string | null {
  const lines = markdown.split("\n");
  let fence: string | null = null;
  let count = 0;

  for (let i = 0; i < lines.length; i++) {
    const fenceMatch = FENCE.exec(lines[i]);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const match = TASK_LINE.exec(lines[i]);
    if (!match) continue;
    if (count === index) {
      lines[i] = lines[i].replace(TASK_LINE, `$1${checked ? "x" : " "}$3`);
      return lines.join("\n");
    }
    count++;
  }
  return null;
}
