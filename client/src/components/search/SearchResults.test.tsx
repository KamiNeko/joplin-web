import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HighlightedText, SearchResults } from "./SearchResults";
import { SEARCH_RESULTS_PAGE_SIZE } from "@/lib/ui-constants";
import type { SearchResult } from "@/lib/types";

afterEach(cleanup);

const marks = (container: HTMLElement) => Array.from(container.querySelectorAll("mark")).map((m) => m.textContent);

const result = (overrides: Partial<SearchResult> = {}): SearchResult => ({
  id: "0123456789abcdef0123456789abcdef",
  title: "List for shopping",
  preview: "Milk, eggs and bread",
  createdTime: 0,
  updatedTime: 0,
  ...overrides,
});

describe("HighlightedText", () => {
  it("highlights every term, case-insensitively, wherever it occurs", () => {
    const { container } = render(<HighlightedText text="List for Shopping lists" terms={["shopping", "list"]} />);
    expect(marks(container)).toEqual(["List", "Shopping", "list"]);
    expect(container.textContent).toBe("List for Shopping lists");
  });

  it("prefers a phrase over a word it contains and escapes regex characters", () => {
    const { container } = render(<HighlightedText text="a shopping list (c++)" terms={["list", "shopping list", "c++"]} />);
    expect(marks(container)).toEqual(["shopping list", "c++"]);
  });

  it("renders plain text without terms", () => {
    const { container } = render(<HighlightedText text="Plain" terms={[]} />);
    expect(marks(container)).toEqual([]);
    expect(container.textContent).toBe("Plain");
  });
});

describe("SearchResults", () => {
  it("highlights the matched terms in title and snippet, not the raw query", () => {
    const note = result({
      matches: { inTitle: true, inBody: true, snippet: "...need milk from the shopping trip", terms: ["shopping", "list"] },
    });
    const { container } = render(
      <SearchResults query='shopping list tag:home' results={[note]} onSelectNote={vi.fn()} />
    );
    expect(marks(container)).toEqual(["List", "shopping", "shopping"]);
  });

  it("shows the preview without highlight for filter-only queries", () => {
    const note = result({ matches: { inTitle: false, inBody: false, snippet: "", terms: [] } });
    const { container } = render(<SearchResults query="tag:home" results={[note]} onSelectNote={vi.fn()} />);
    expect(screen.getByText("Milk, eggs and bread")).toBeTruthy();
    expect(marks(container)).toEqual([]);
  });

  it("explains the search syntax when nothing matches", () => {
    render(<SearchResults query="nothing" results={[]} onSelectNote={vi.fn()} />);
    expect(screen.getByText(/No matches found/)).toBeTruthy();
    expect(screen.getByText("0 found")).toBeTruthy();
    expect(screen.getByText(/tag:name, notebook:name/)).toBeTruthy();
  });

  const listed = [
    result({ id: "a".repeat(32), title: "Website Relaunch Roadmap", matches: { inTitle: true, inBody: true, snippet: "…the roadmap for Q3…", terms: ["road"] } }),
    result({ id: "b".repeat(32), title: "Weekly Sync", preview: "Discussed the road ahead" }),
  ];

  it("lists the matches with a count; the snippet wins over the preview", () => {
    const { container } = render(<SearchResults query="road" results={listed} onSelectNote={() => {}} />);

    expect(screen.getByText("2 found")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Website Relaunch Roadmap/ })).toBeTruthy();
    const snippets = Array.from(container.querySelectorAll("p.line-clamp-2")).map((p) => p.textContent);
    expect(snippets).toEqual(["…the roadmap for Q3…", "Discussed the road ahead"]);
    expect(marks(container)).toEqual(["Road", "road"]);
  });

  it("opens a result on click and with Enter or Space", () => {
    const onSelectNote = vi.fn();
    render(<SearchResults query="road" results={listed} onSelectNote={onSelectNote} />);
    const [first, second] = screen.getAllByRole("button").filter((b) => b.hasAttribute("tabindex"));

    fireEvent.click(first);
    fireEvent.keyDown(second, { key: "Enter" });
    fireEvent.keyDown(second, { key: " " });
    fireEvent.keyDown(second, { key: "a" });

    expect(onSelectNote.mock.calls).toEqual([[listed[0].id], [listed[1].id], [listed[1].id]]);
  });

  it("shows a failed search with Retry instead of “No matches”", () => {
    const onRetry = vi.fn();
    render(
      <SearchResults query="road" results={[]} error={new Error("Server down")} onRetry={onRetry} onSelectNote={() => {}} />
    );

    expect(screen.getByText("Search failed")).toBeTruthy();
    expect(screen.queryByText("No matches found")).toBeNull();
    expect(screen.queryByText(/found$/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("shows no count while loading, and clears the query on request", () => {
    const onClearQuery = vi.fn();
    render(<SearchResults query="road" results={[]} isLoading onSelectNote={() => {}} onClearQuery={onClearQuery} />);

    expect(screen.queryByText(/found$/)).toBeNull();
    expect(screen.queryByText("No matches found")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onClearQuery).toHaveBeenCalled();
  });

  const makeManyResults = (count: number, prefix = "Match"): SearchResult[] =>
    Array.from({ length: count }, (_, i) =>
      result({
        id: (i + 1).toString(16).padStart(32, "0"),
        title: `${prefix} ${i + 1}`,
        preview: `Preview ${i + 1}`,
      })
    );

  const renderedCards = (container: HTMLElement) => container.querySelectorAll('[role="button"][tabindex="0"]');

  it("renders large result lists progressively, loads more via button or scroll, and resets on query/results change", () => {
    const many = makeManyResults(250);
    const { container, rerender } = render(<SearchResults query="ba" results={many} onSelectNote={() => {}} />);

    expect(screen.getByText("250 found")).toBeTruthy();
    expect(renderedCards(container)).toHaveLength(SEARCH_RESULTS_PAGE_SIZE);
    expect(screen.getByRole("button", { name: "Show more (150 remaining)" })).toBeTruthy();

    // Button loads the next page
    fireEvent.click(screen.getByRole("button", { name: "Show more (150 remaining)" }));
    expect(renderedCards(container)).toHaveLength(200);
    expect(screen.getByRole("button", { name: "Show more (50 remaining)" })).toBeTruthy();

    // Scrolling near the bottom loads the remaining items
    const viewport = container.querySelector("[data-radix-scroll-area-viewport]") as HTMLElement;
    Object.defineProperty(viewport, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(viewport, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(viewport, "scrollTop", { value: 500, configurable: true });
    fireEvent.scroll(viewport);
    expect(renderedCards(container)).toHaveLength(250);
    expect(screen.queryByRole("button", { name: /^Show more/ })).toBeNull();

    // Changing query resets the visible slice back to one page
    rerender(<SearchResults query="bank" results={many} onSelectNote={() => {}} />);
    expect(renderedCards(container)).toHaveLength(SEARCH_RESULTS_PAGE_SIZE);

    // Expand again, then replace results array for the same query -> also resets
    fireEvent.click(screen.getByRole("button", { name: "Show more (150 remaining)" }));
    expect(renderedCards(container)).toHaveLength(200);
    rerender(<SearchResults query="bank" results={makeManyResults(250, "Refreshed")} onSelectNote={() => {}} />);
    expect(renderedCards(container)).toHaveLength(SEARCH_RESULTS_PAGE_SIZE);
  });

  it("extends the rendered slice to include a selected note beyond the first page", () => {
    const many = makeManyResults(250);
    const target = many[149]; // 150th result (index 149)
    const { container } = render(
      <SearchResults query="ba" results={many} selectedNoteId={target.id} onSelectNote={() => {}} />
    );

    expect(screen.getByText("250 found")).toBeTruthy();
    expect(renderedCards(container)).toHaveLength(150);
    expect(screen.getByText("Match 150")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show more (100 remaining)" })).toBeTruthy();
  });
});
