/**
 * Pure Markdown formatting transforms used by the editor's shortcuts and toolbar.
 *
 * Every transform takes the document text and the selection and returns the changes to apply
 * (positions in the original text, non-overlapping and sorted) plus the new selection (positions
 * in the changed text). They know nothing about CodeMirror, so they are easy to test.
 */

/** A selection; `from` <= `to` (an empty selection is a cursor) */
export interface TextSelection {
  from: number;
  to: number;
}

/** Replace `from`..`to` of the original text with `insert` */
export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

export interface FormatResult {
  changes: TextChange[];
  selection: TextSelection;
}

export type WrapMarker = "**" | "*" | "~~" | "`";
export type ListKind = "bullet" | "numbered" | "checkbox";

/** Applies changes to a text (for tests and callers without an editor) */
export function applyChanges(text: string, changes: TextChange[]): string {
  let out = "";
  let last = 0;
  for (const c of changes) {
    out += text.slice(last, c.from) + c.insert;
    last = c.to;
  }
  return out + text.slice(last);
}

/**
 * Maps a position in the original text through the changes. A position at an insertion point or
 * inside a replaced range moves after the inserted text (a removed range collapses to its start).
 */
function mapPos(changes: TextChange[], pos: number): number {
  let delta = 0;
  for (const c of changes) {
    if (c.from > pos) break;
    if (c.to > pos) return c.from + delta + c.insert.length;
    delta += c.insert.length - (c.to - c.from);
  }
  return pos + delta;
}

/** Length of the run of `char` ending at `end` (exclusive) */
function runBefore(text: string, end: number, char: string): number {
  let n = 0;
  while (end - n - 1 >= 0 && text[end - n - 1] === char) n++;
  return n;
}

/** Length of the run of `char` starting at `start` */
function runAfter(text: string, start: number, char: string): number {
  let n = 0;
  while (start + n < text.length && text[start + n] === char) n++;
  return n;
}

/**
 * Whether a run of marker characters on both sides contains this marker. Italic `*` counts only
 * on odd runs, so `**bold**` is not taken for italic, while `***both***` is.
 */
function runHasMarker(run: number, marker: WrapMarker): boolean {
  if (marker === "*") return run % 2 === 1;
  return run >= marker.length;
}

const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);

/**
 * Toggles an inline marker (`**` bold, `*` italic, `~~` strikethrough, `` ` `` code) around the
 * selection. Removes it when the selection is already wrapped (markers inside or just outside the
 * selection). A cursor inside a word wraps that word; elsewhere an empty pair is inserted with the
 * cursor between. Whitespace at the ends of the selection stays outside the markers.
 */
export function toggleWrap(text: string, sel: TextSelection, marker: WrapMarker): FormatResult {
  const char = marker[0];
  const m = marker.length;
  let { from, to } = sel;

  if (from === to) {
    const left = runBefore(text, from, char);
    const right = runAfter(text, from, char);
    // Cursor between an empty pair: remove it
    if (left === right && runHasMarker(left, marker)) {
      const changes = [{ from: from - m, to: from + m, insert: "" }];
      return { changes, selection: { from: from - m, to: from - m } };
    }
    // Inside a word: wrap the word
    let start = from;
    let end = from;
    while (isWordChar(text[start - 1])) start--;
    while (isWordChar(text[end])) end++;
    if (start === end) {
      const changes = [{ from, to: from, insert: marker + marker }];
      return { changes, selection: { from: from + m, to: from + m } };
    }
    return toggleWrapRange(text, start, end, marker, from);
  }

  // Keep surrounding whitespace (e.g. from a double-click) outside the markers
  while (from < to && /\s/.test(text[from])) from++;
  while (to > from && /\s/.test(text[to - 1])) to--;
  if (from === to) return { changes: [], selection: sel };
  return toggleWrapRange(text, from, to, marker);
}

/** Wraps or unwraps `from`..`to`; `cursor` keeps a cursor's place in a wrapped word */
function toggleWrapRange(text: string, from: number, to: number, marker: WrapMarker, cursor?: number): FormatResult {
  const char = marker[0];
  const m = marker.length;
  const keep = (changes: TextChange[]): FormatResult => {
    const selection =
      cursor !== undefined
        ? { from: mapPos(changes, cursor), to: mapPos(changes, cursor) }
        : { from: mapPos(changes, from), to: mapPos(changes, to) };
    return { changes, selection };
  };

  // Markers just outside the selection
  const outside = Math.min(runBefore(text, from, char), runAfter(text, to, char));
  if (runHasMarker(outside, marker)) {
    return keep([
      { from: from - m, to: from, insert: "" },
      { from: to, to: to + m, insert: "" },
    ]);
  }

  // Markers selected along with the text
  const inside = to - from >= 2 * m ? Math.min(runAfter(text, from, char), runBefore(text, to, char)) : 0;
  if (inside < to - from && runHasMarker(inside, marker)) {
    const changes = [
      { from, to: from + m, insert: "" },
      { from: to - m, to, insert: "" },
    ];
    return { changes, selection: { from, to: to - 2 * m } };
  }

  const changes = [
    { from, to: from, insert: marker },
    { from: to, to: to, insert: marker },
  ];
  if (cursor !== undefined) return keep(changes);
  // The wrapped text stays selected (without the markers)
  return { changes, selection: { from: from + m, to: to + m } };
}

/** Line boundaries covered by a selection; a selection ending at a line start excludes that line */
function selectedLines(text: string, sel: TextSelection): Array<{ from: number; to: number }> {
  let end = sel.to;
  if (end > sel.from && text[end - 1] === "\n") end--;
  const lines: Array<{ from: number; to: number }> = [];
  let start = text.lastIndexOf("\n", sel.from - 1) + 1;
  for (;;) {
    let lineEnd = text.indexOf("\n", start);
    if (lineEnd < 0) lineEnd = text.length;
    lines.push({ from: start, to: lineEnd });
    if (lineEnd >= end || lineEnd === text.length) break;
    start = lineEnd + 1;
  }
  return lines;
}

/** Maps the selection through line-prefix changes, keeping a cursor after the new prefix */
function lineResult(sel: TextSelection, changes: TextChange[]): FormatResult {
  return { changes, selection: { from: mapPos(changes, sel.from), to: mapPos(changes, sel.to) } };
}

const HEADING = /^#{1,6}[ \t]+/;
const HEADING_EMPTY = /^#{1,6}$/;

/**
 * Toggles a heading of `level` (1–6) on the selected lines: removes it where every line already
 * has that level, otherwise sets that level (replacing another heading level).
 */
export function toggleHeading(text: string, sel: TextSelection, level: number): FormatResult {
  const prefix = "#".repeat(level) + " ";
  const lines = selectedLines(text, sel);
  const current = (line: { from: number; to: number }) => {
    const content = text.slice(line.from, line.to);
    return content.match(HEADING)?.[0] ?? content.match(HEADING_EMPTY)?.[0] ?? "";
  };
  const isLevel = (p: string) => p.replace(/[ \t]+$/, "").length === level && p !== "";
  const remove = lines.every((line) => isLevel(current(line)));
  const changes: TextChange[] = [];
  for (const line of lines) {
    const existing = current(line);
    if (remove) {
      changes.push({ from: line.from, to: line.from + existing.length, insert: "" });
    } else if (existing !== prefix && (line.from !== line.to || lines.length === 1)) {
      changes.push({ from: line.from, to: line.from + existing.length, insert: prefix });
    }
  }
  return lineResult(sel, changes);
}

/** Indentation, then a checkbox, bullet or number marker */
const LIST_ITEM = /^([ \t]*)(?:([-*+][ \t]+\[[ xX]\][ \t]+)|([-*+][ \t]+)|(\d{1,9}[.)][ \t]+))?/;

function listKindOf(match: RegExpMatchArray): ListKind | null {
  if (match[2]) return "checkbox";
  if (match[3]) return "bullet";
  if (match[4]) return "numbered";
  return null;
}

/**
 * Toggles a list marker on the selected lines, keeping their indentation: removes it where every
 * non-empty line already is that kind of item, otherwise turns the lines into items of that kind
 * (converting other list markers). Numbered items are numbered from 1.
 */
export function toggleList(text: string, sel: TextSelection, kind: ListKind): FormatResult {
  const lines = selectedLines(text, sel);
  const parsed = lines.map((line) => {
    const content = text.slice(line.from, line.to);
    const match = content.match(LIST_ITEM)!;
    return { ...line, indent: match[1], marker: match[0].slice(match[1].length), kind: listKindOf(match) };
  });
  // Empty lines are skipped, unless the selection is only empty lines (start a new item there)
  const targets = parsed.some((l) => l.from !== l.to) ? parsed.filter((l) => l.from !== l.to) : parsed;
  const remove = targets.every((l) => l.kind === kind);
  const changes: TextChange[] = [];
  let number = 1;
  for (const line of targets) {
    const markerFrom = line.from + line.indent.length;
    const markerTo = markerFrom + line.marker.length;
    let insert = "";
    if (!remove) {
      insert = kind === "bullet" ? "- " : kind === "checkbox" ? "- [ ] " : `${number++}. `;
      // An existing checkbox keeps its state
      if (kind === "checkbox" && line.kind === "checkbox") insert = line.marker;
    }
    if (insert !== line.marker) changes.push({ from: markerFrom, to: markerTo, insert });
  }
  return lineResult(sel, changes);
}

/** Escapes text for use inside the brackets of a Markdown link */
export function escapeLinkText(text: string): string {
  return text.replace(/[\\[\]]/g, "\\$&");
}

/** Builds a Markdown link to a Joplin note: `[title](:/id)` */
export function noteMarkdownLink(note: { id: string; title: string }): string {
  return `[${escapeLinkText(note.title.trim() || "Untitled")}](:/${note.id})`;
}

const URL_ONLY = /^(?:https?:\/\/|mailto:|:\/)[^\s()]+$/;

/**
 * Inserts a Markdown link. Selected text becomes the link text with the cursor in the empty
 * URL; a selected URL becomes the target with the cursor in the empty text; with nothing selected
 * `[]()` is inserted with the cursor in the brackets.
 */
export function insertLink(text: string, sel: TextSelection): FormatResult {
  const selected = text.slice(sel.from, sel.to).trim();
  if (selected && !selected.includes("\n") && URL_ONLY.test(selected)) {
    const insert = `[](${selected})`;
    return { changes: [{ from: sel.from, to: sel.to, insert }], selection: { from: sel.from + 1, to: sel.from + 1 } };
  }
  const label = selected ? escapeLinkText(selected) : "";
  const insert = `[${label}]()`;
  const cursor = selected ? sel.from + insert.length - 1 : sel.from + 1;
  return { changes: [{ from: sel.from, to: sel.to, insert }], selection: { from: cursor, to: cursor } };
}

/**
 * Inserts a link to another note at the selection. Selected text becomes the link text, otherwise
 * the note's title. The cursor ends up after the link.
 */
export function insertNoteLink(
  text: string,
  sel: TextSelection,
  note: { id: string; title: string }
): FormatResult {
  const selected = text.slice(sel.from, sel.to).trim();
  const insert = selected && !selected.includes("\n") ? `[${escapeLinkText(selected)}](:/${note.id})` : noteMarkdownLink(note);
  const end = sel.from + insert.length;
  return { changes: [{ from: sel.from, to: sel.to, insert }], selection: { from: end, to: end } };
}

const FENCE = /^[ \t]*(```|~~~)/;

/**
 * Toggles code: inline backticks for a selection within one line, a fenced block for a selection
 * spanning lines (removing the fences when the lines are already enclosed by them).
 */
export function toggleCode(text: string, sel: TextSelection): FormatResult {
  if (!text.slice(sel.from, sel.to).includes("\n")) return toggleWrap(text, sel, "`");
  const lines = selectedLines(text, sel);
  const first = lines[0];
  const last = lines[lines.length - 1];
  const before = first.from > 0 ? text.slice(text.lastIndexOf("\n", first.from - 2) + 1, first.from - 1) : null;
  const afterEnd = text.indexOf("\n", last.to + 1);
  const after = last.to < text.length ? text.slice(last.to + 1, afterEnd < 0 ? text.length : afterEnd) : null;
  if (before !== null && after !== null && FENCE.test(before) && FENCE.test(after)) {
    const changes = [
      { from: first.from - before.length - 1, to: first.from, insert: "" },
      { from: last.to, to: last.to + 1 + after.length, insert: "" },
    ];
    return lineResult(sel, changes);
  }
  const changes = [
    { from: first.from, to: first.from, insert: "```\n" },
    { from: last.to, to: last.to, insert: "\n```" },
  ];
  // mapPos would move a selection end at the line end past the closing fence
  return { changes, selection: { from: sel.from + 4, to: Math.min(sel.to, last.to) + 4 } };
}
