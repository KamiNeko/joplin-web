import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { setTaskChecked, type TaskLocation } from "./tasks";

interface ParsedTask extends TaskLocation {
  checked: boolean;
}

interface MdastNode {
  type: string;
  checked?: boolean | null;
  children?: MdastNode[];
  position?: { start: { line: number; column: number } };
}

/**
 * The task items remark-gfm renders, in document order, with the start position
 * MarkdownRenderer reports for them. This is the single source of truth since #29.
 */
function parseTasks(markdown: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  const walk = (node: MdastNode) => {
    if (node.type === "listItem" && typeof node.checked === "boolean" && node.position) {
      const { line, column } = node.position.start;
      tasks.push({ line, column, checked: node.checked });
    }
    node.children?.forEach(walk);
  };
  walk(unified().use(remarkParse).use(remarkGfm).parse(markdown) as MdastNode);
  return tasks;
}

/** Toggles the `index`-th rendered task and checks that exactly that task changed. */
function toggleRendered(markdown: string, index: number, checked: boolean): string {
  const before = parseTasks(markdown);
  const result = setTaskChecked(markdown, before[index], checked);
  expect(result).not.toBeNull();
  const after = parseTasks(result!);
  expect(after).toEqual(before.map((task, i) => (i === index ? { ...task, checked } : task)));
  return result!;
}

describe("setTaskChecked", () => {
  it("checks and unchecks a task", () => {
    const markdown = "- [ ] one\n- [ ] two\n";
    const checked = toggleRendered(markdown, 1, true);
    expect(checked).toBe("- [ ] one\n- [x] two\n");
    expect(toggleRendered(checked, 1, false)).toBe(markdown);
  });

  it("unchecks an upper-case [X]", () => {
    expect(toggleRendered("- [X] done\n", 0, false)).toBe("- [ ] done\n");
  });

  it("keeps the text unchanged when the task already has the requested state", () => {
    expect(setTaskChecked("- [x] done", { line: 1, column: 1 }, true)).toBe("- [x] done");
  });

  it("supports *, + and ordered list markers", () => {
    const markdown = "* [ ] star\n\n+ [ ] plus\n\n1. [ ] dot\n2) [ ] paren\n";
    expect(parseTasks(markdown)).toHaveLength(4);
    let result = markdown;
    for (let i = 0; i < 4; i++) result = toggleRendered(result, i, true);
    expect(result).toBe("* [x] star\n\n+ [x] plus\n\n1. [x] dot\n2) [x] paren\n");
  });

  // The scenario from #29: only "real one" is rendered as a task
  it("ignores HTML comments, indented code and empty items (#29)", () => {
    const markdown = [
      "Intro",
      "",
      "<!--",
      "- [ ] hidden",
      "-->",
      "",
      "    - [ ] indented code",
      "",
      "- [ ]",
      "- [ ] real one",
      "",
    ].join("\n");
    const tasks = parseTasks(markdown);
    expect(tasks).toEqual([{ line: 10, column: 1, checked: false }]);
    expect(toggleRendered(markdown, 0, true)).toBe(markdown.replace("- [ ] real one", "- [x] real one"));
  });

  it("ignores task syntax inside fenced code blocks", () => {
    const markdown = "```\n- [ ] in code\n```\n\n~~~md\n- [ ] tilde fence\n~~~\n\n- [ ] real\n";
    expect(parseTasks(markdown)).toHaveLength(1);
    const result = toggleRendered(markdown, 0, true);
    expect(result).toContain("- [ ] in code");
    expect(result).toContain("- [ ] tilde fence");
    expect(result).toContain("- [x] real");
  });

  it("ignores task syntax inside HTML blocks", () => {
    const markdown = "<div>\n- [ ] in html\n</div>\n\n- [ ] real\n";
    expect(parseTasks(markdown)).toHaveLength(1);
    expect(toggleRendered(markdown, 0, true)).toBe("<div>\n- [ ] in html\n</div>\n\n- [x] real\n");
  });

  it("preserves CRLF line endings and finds the right line", () => {
    const markdown = "# Title\r\n\r\n```\r\n- [ ] code\r\n```\r\n\r\n- [ ] first\r\n- [ ] second\r\n";
    const result = toggleRendered(markdown, 1, true);
    expect(result).toBe(markdown.replace("- [ ] second", "- [x] second"));
    expect(result.match(/\r\n/g)).toHaveLength(markdown.match(/\r\n/g)!.length);
  });

  it("counts lone CR line endings like the parser", () => {
    const markdown = "a\r\r- [ ] one\r- [ ] two";
    expect(toggleRendered(markdown, 1, true)).toBe("a\r\r- [ ] one\r- [x] two");
  });

  it("toggles only the addressed item in nested lists", () => {
    const markdown = [
      "- [ ] parent",
      "  - [ ] child",
      "    - [ ] grandchild",
      "  - [x] sibling",
      "- [ ] second parent",
      "",
    ].join("\n");
    expect(parseTasks(markdown)).toHaveLength(5);
    const result = toggleRendered(markdown, 2, true);
    expect(result).toBe(markdown.replace("- [ ] grandchild", "- [x] grandchild"));
    expect(toggleRendered(markdown, 3, false)).toBe(markdown.replace("- [x] sibling", "- [ ] sibling"));
  });

  it("toggles a task nested under a plain list item", () => {
    const markdown = "1. step\n   - [ ] sub task\n";
    expect(parseTasks(markdown)).toEqual([{ line: 2, column: 4, checked: false }]);
    expect(toggleRendered(markdown, 0, true)).toBe("1. step\n   - [x] sub task\n");
  });

  it("toggles tasks inside blockquotes", () => {
    const markdown = "> - [ ] quoted\n> - [ ] quoted two\n";
    expect(toggleRendered(markdown, 1, true)).toBe("> - [ ] quoted\n> - [x] quoted two\n");
  });

  it("toggles tasks in loose lists", () => {
    const markdown = "- [ ] one\n\n  more text\n\n- [ ] two\n";
    expect(toggleRendered(markdown, 0, true)).toBe("- [x] one\n\n  more text\n\n- [ ] two\n");
  });

  it("does not touch [ ] later in the item text", () => {
    const markdown = "- [ ] see [ ] and [x]\n";
    expect(toggleRendered(markdown, 0, true)).toBe("- [x] see [ ] and [x]\n");
  });

  describe("stale or invalid locations", () => {
    const markdown = "Intro\n\n- plain item\n- [ ] task\n";

    it("returns null when there is no task at the location", () => {
      expect(setTaskChecked(markdown, { line: 1, column: 1 }, true)).toBeNull();
      // A list item that is not a task
      expect(setTaskChecked(markdown, { line: 3, column: 1 }, true)).toBeNull();
      // Inside the task, not at its marker
      expect(setTaskChecked(markdown, { line: 4, column: 3 }, true)).toBeNull();
    });

    it("returns null when the location is outside the text", () => {
      expect(setTaskChecked(markdown, { line: 99, column: 1 }, true)).toBeNull();
      expect(setTaskChecked(markdown, { line: 4, column: 999 }, true)).toBeNull();
      expect(setTaskChecked("", { line: 1, column: 1 }, true)).toBeNull();
    });

    it("returns null for malformed positions", () => {
      expect(setTaskChecked(markdown, { line: 0, column: 1 }, true)).toBeNull();
      expect(setTaskChecked(markdown, { line: 4, column: 0 }, true)).toBeNull();
      expect(setTaskChecked(markdown, { line: 4.5, column: 1 }, true)).toBeNull();
      expect(setTaskChecked(markdown, { line: Number.NaN, column: 1 }, true)).toBeNull();
    });

    it("returns null after the text changed under the click", () => {
      const location = parseTasks(markdown)[0];
      const edited = "New first line\n" + markdown;
      expect(setTaskChecked(edited, location, true)).toBeNull();
    });
  });
});
