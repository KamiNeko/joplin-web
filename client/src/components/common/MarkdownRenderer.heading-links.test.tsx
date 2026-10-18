import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom";
import { resetConnection } from "@/lib/connection";
import { MarkdownRenderer } from "./MarkdownRenderer";

const NOTE_ID = "fedcba9876543210fedcba9876543210";
const TARGET_BODY = "# Intro\n\ntext\n\n## Shopping List\n\nmilk\n\n## Café Crème\n\n## Notes\n\n## Notes";

/** The linked note, rendered like NoteViewer does */
function OpenedNote() {
  const { id } = useParams();
  const { hash } = useLocation();
  return (
    <>
      <p>
        Opened note {id}
        {hash}
      </p>
      <MarkdownRenderer content={TARGET_BODY} />
    </>
  );
}

let scrolled: string[];

function renderMarkdown(content: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<MarkdownRenderer content={content} />} />
          <Route path="/notes/:id" element={<OpenedNote />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  ).container;
}

beforeEach(() => {
  resetConnection();
  scrolled = [];
  // jsdom doesn't implement scrolling
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
    scrolled.push(`${this.tagName} ${this.textContent}`);
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      String(input) === `/api/notes/${NOTE_ID}`
        ? new Response(JSON.stringify({ id: NOTE_ID, title: "Other", body: TARGET_BODY }), { status: 200 })
        : new Response(JSON.stringify({ error: "Not found" }), { status: 404 })
    )
  );
});

afterEach(cleanup);

describe(":/id#heading links (#93)", () => {
  it.each([
    ["Markdown", `[Other note](:/${NOTE_ID}#shopping-list)`],
    ["Markdown with a title", `[Other note](:/${NOTE_ID}#shopping-list "Go")`],
    ["upper-case Markdown", `[Other note](:/${NOTE_ID.toUpperCase()}#shopping-list)`],
    ["HTML", `<a href=":/${NOTE_ID}#shopping-list">Other note</a>`],
    ["single-quoted HTML", `<a href=':/${NOTE_ID}#shopping-list'>Other note</a>`],
  ])("opens the note and scrolls to the heading (%s)", async (_kind, markdown) => {
    renderMarkdown(markdown);
    fireEvent.click(screen.getByRole("button", { name: "Other note" }));
    expect(await screen.findByText(`Opened note ${NOTE_ID}#shopping-list`)).toBeTruthy();
    await waitFor(() => expect(scrolled).toEqual(["H2 Shopping List"]));
  });

  it("matches non-ASCII headings through percent-encoding", async () => {
    renderMarkdown(`[Other note](:/${NOTE_ID}#café-crème)`);
    fireEvent.click(screen.getByRole("button", { name: "Other note" }));
    await waitFor(() => expect(scrolled).toEqual(["H2 Café Crème"]));
  });

  it("scrolls to the second of two equal headings for <slug>-1", async () => {
    renderMarkdown(`[Other note](:/${NOTE_ID}#notes-1)`);
    fireEvent.click(screen.getByRole("button", { name: "Other note" }));
    await waitFor(() => expect(scrolled).toHaveLength(1));
    const second = screen.getAllByRole("heading", { name: "Notes" })[1];
    expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts[0]).toBe(second);
  });

  it("still opens the note when the heading doesn't exist", async () => {
    renderMarkdown(`[Other note](:/${NOTE_ID}#nope)`);
    fireEvent.click(screen.getByRole("button", { name: "Other note" }));
    expect(await screen.findByText(`Opened note ${NOTE_ID}#nope`)).toBeTruthy();
    expect(scrolled).toEqual([]);
  });

  it("keeps plain :/id links without a fragment", async () => {
    renderMarkdown(`[Other note](:/${NOTE_ID})`);
    fireEvent.click(screen.getByRole("button", { name: "Other note" }));
    expect(await screen.findByText(`Opened note ${NOTE_ID}`)).toBeTruthy();
    expect(scrolled).toEqual([]);
  });

  it("does not rewrite ids that aren't 32 hex characters", () => {
    const container = renderMarkdown(`[Bad](:/${"g".repeat(32)}#x) [Short](:/abc#x)`);
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.innerHTML).not.toContain("joplin-item");
    expect(container.querySelector("a[href^=':']")).toBeNull();
  });

  it("does not let the fragment break out of the attribute or URL", () => {
    const container = renderMarkdown(
      `<a href=":/${NOTE_ID}#x" onclick="window.pwned=1">A</a>\n\n<a href=":/${NOTE_ID}#x&quot; onmouseover=&quot;alert(1)">B</a>\n\n[C](:/${NOTE_ID}#x"onerror=alert(1))`
    );
    expect(container.innerHTML).not.toMatch(/onclick|onmouseover|onerror=/);
    expect(container.querySelector("script, [onclick], [onmouseover]")).toBeNull();
  });

  it("rewrites HTML links quickly even with huge unterminated tags", () => {
    const start = performance.now();
    renderMarkdown(`${"<a ".repeat(2000)}${"x".repeat(20000)}\n\n<a title="t" href=":/${NOTE_ID}#intro">Other note</a>`);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(screen.getByRole("button", { name: "Other note" })).toBeTruthy();
  });

  it("scrolls in the current note when the route already has a heading fragment, once", async () => {
    const { rerender } = render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={[`/notes/${NOTE_ID}#intro`]}>
          <MarkdownRenderer content={TARGET_BODY} />
        </MemoryRouter>
      </QueryClientProvider>
    );
    await waitFor(() => expect(scrolled).toEqual(["H1 Intro"]));

    // Typing in the editor preview re-renders with new content: no scrolling again
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={[`/notes/${NOTE_ID}#intro`]}>
          <MarkdownRenderer content={`${TARGET_BODY}\n\nmore`} />
        </MemoryRouter>
      </QueryClientProvider>
    );
    expect(scrolled).toEqual(["H1 Intro"]);
  });
});
