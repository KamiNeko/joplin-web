import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { setTaskChecked, type TaskLocation } from "@/lib/tasks";
import { MarkdownRenderer } from "./MarkdownRenderer";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));
vi.mock("mermaid", () => ({ default: mermaid }));

function renderMarkdown(content: string, onToggleTask?: (location: TaskLocation, checked: boolean) => void) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <MarkdownRenderer content={content} onToggleTask={onToggleTask} />
      </MemoryRouter>
    </QueryClientProvider>
  ).container;
}

beforeEach(() => {
  mermaid.initialize.mockReset();
  mermaid.render.mockReset();
});

afterEach(cleanup);

describe("Joplin inline markup", () => {
  it("renders ==mark==, ++insert++, ~sub~ and ^sup^", () => {
    const container = renderMarkdown("==marked **bold**== ++added++ H~2~O x^2^");
    expect(container.querySelector("mark")?.innerHTML).toBe("marked <strong>bold</strong>");
    expect(container.querySelector("ins")?.textContent).toBe("added");
    expect(container.querySelector("sub")?.textContent).toBe("2");
    expect(container.querySelector("sup")?.textContent).toBe("2");
  });

  it("keeps ~~strikethrough~~ and leaves single markers with spaces as text", () => {
    const container = renderMarkdown("~~gone~~ a ~ b ~ c, 1 == 2, C++ and C++, ^ x ^");
    expect(container.querySelector("del")?.textContent).toBe("gone");
    expect(container.querySelector("sub, sup, mark, ins")).toBeNull();
    expect(container.textContent).toContain("a ~ b ~ c, 1 == 2, C++ and C++, ^ x ^");
  });

  it("allows escaped spaces in sub/superscript and ignores markers in code and escapes", () => {
    const container = renderMarkdown("~a\\ b~ `==code==` \\==text== H\\~2~");
    expect(container.querySelector("sub")?.textContent).toBe("a b");
    expect(container.querySelector("mark")).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe("==code==");
  });
});

describe("math", () => {
  it("renders inline and display formulas with KaTeX", async () => {
    const container = renderMarkdown("Inline $E = mc^2$ here.\n\n$$\n\\frac{a}{b}\n$$\n");
    await waitFor(() => expect(container.querySelectorAll(".katex")).toHaveLength(2), { timeout: 5000 });
    expect(container.querySelector(".math-inline .katex annotation")?.textContent).toBe("E = mc^2");
    expect(container.querySelector(".math-display .katex-display")).not.toBeNull();
    expect(container.querySelector("pre")).toBeNull();
  });

  it("leaves amounts of money as text", async () => {
    const container = renderMarkdown("It costs $5 and $10, or $x$.");
    await waitFor(() => expect(container.querySelector(".katex")).not.toBeNull(), { timeout: 5000 });
    expect(container.querySelectorAll(".katex")).toHaveLength(1);
    expect(container.textContent).toContain("It costs $5 and $10, or");
  });

  it("does not let formulas create links or HTML", async () => {
    const container = renderMarkdown("$\\href{javascript:alert(1)}{x}$ $\\htmlClass{fixed}{y}$");
    await waitFor(() => expect(container.querySelectorAll(".katex")).toHaveLength(2), { timeout: 5000 });
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector(".fixed")).toBeNull();
  });

  it("drops math classes on raw HTML spans", () => {
    const container = renderMarkdown('<span class="math-inline fixed">x</span>');
    expect(container.querySelector(".fixed")).toBeNull();
  });
});

describe("Mermaid diagrams", () => {
  it("renders the diagram in strict mode and strips script from the SVG", async () => {
    mermaid.render.mockResolvedValue({
      svg: '<svg id="d" onload="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)"><text>A</text></a><g onclick="x()"></g></svg>',
    });
    const container = renderMarkdown("```mermaid\ngraph TD\n  A --> B\n```\n");
    await waitFor(() => expect(container.querySelector(".mermaid-diagram svg")).not.toBeNull());
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: "strict", startOnLoad: false }));
    expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), "graph TD\n  A --> B");
    const svg = container.querySelector(".mermaid-diagram svg")!;
    expect(svg.querySelector("script")).toBeNull();
    expect(svg.getAttribute("onload")).toBeNull();
    expect(svg.querySelector("[onclick]")).toBeNull();
    expect(svg.querySelector("a")?.getAttribute("href")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
  });

  it("shows the error and the source when the diagram is invalid", async () => {
    mermaid.render.mockRejectedValue(new Error("Parse error on line 1"));
    renderMarkdown("```mermaid\nnot a diagram\n```\n");
    expect(await screen.findByText(/Parse error on line 1/)).toBeTruthy();
    expect(screen.getByText("not a diagram")).toBeTruthy();
  });
});

describe("task checkboxes next to extensions", () => {
  it("toggles the task that was clicked", () => {
    const markdown = [
      "$$",
      "x^2",
      "$$",
      "",
      "```mermaid",
      "graph TD",
      "- [ ] not a task",
      "```",
      "",
      "- [ ] ==first== $a$",
      "- [x] H~2~O ^2^ ++new++",
      "  - [ ] nested ~~old~~",
      "",
    ].join("\n");
    mermaid.render.mockResolvedValue({ svg: "<svg></svg>" });
    const onToggle = vi.fn();
    renderMarkdown(markdown, onToggle);
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(3);

    fireEvent.click(boxes[2]);
    const [location, checked] = onToggle.mock.calls[0];
    expect(location).toEqual({ line: 12, column: 3 });
    expect(setTaskChecked(markdown, location, checked)).toBe(markdown.replace("- [ ] nested", "- [x] nested"));

    fireEvent.click(boxes[1]);
    const [second, secondChecked] = onToggle.mock.calls[1];
    expect(setTaskChecked(markdown, second, secondChecked)).toBe(markdown.replace("- [x] H~2~O", "- [ ] H~2~O"));
  });
});
