import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SearchResult } from "@/lib/types";
import { SearchResults } from "./SearchResults";

const result = (id: string, title: string, extra: Partial<SearchResult> = {}): SearchResult => ({
  id: id.repeat(32),
  title,
  preview: "",
  createdTime: Date.now() - 60_000,
  updatedTime: Date.now() - 60_000,
  ...extra,
});

const results = [
  result("a", "Website Relaunch Roadmap", { matches: { inTitle: true, inBody: true, snippet: "…the roadmap for Q3…" } }),
  result("b", "Weekly Sync", { preview: "Discussed the road ahead" }),
];

afterEach(cleanup);

describe("SearchResults", () => {
  it("lists the matches with a count and highlights the query in titles and snippets", () => {
    const { container } = render(<SearchResults query="road" results={results} onSelectNote={() => {}} />);

    expect(screen.getByText("2 found")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Website Relaunch Roadmap/ })).toBeTruthy();
    // The snippet from the API wins over the preview; the preview is the fallback
    const snippets = Array.from(container.querySelectorAll("p.line-clamp-2")).map((p) => p.textContent);
    expect(snippets).toEqual(["…the roadmap for Q3…", "Discussed the road ahead"]);
    const marks = Array.from(container.querySelectorAll("mark")).map((m) => m.textContent);
    expect(marks).toEqual(["Road", "road", "road"]);
  });

  it("treats regex characters in the query literally", () => {
    const { container } = render(
      <SearchResults query="c++ (" results={[result("c", "Notes on C++ (draft)")]} onSelectNote={() => {}} />
    );
    expect(Array.from(container.querySelectorAll("mark")).map((m) => m.textContent)).toEqual(["C++ ("]);
  });

  it("opens a result on click and with Enter or Space", () => {
    const onSelectNote = vi.fn();
    render(<SearchResults query="road" results={results} onSelectNote={onSelectNote} />);
    const [first, second] = screen.getAllByRole("button").filter((b) => b.hasAttribute("tabindex"));

    fireEvent.click(first);
    fireEvent.keyDown(second, { key: "Enter" });
    fireEvent.keyDown(second, { key: " " });
    fireEvent.keyDown(second, { key: "a" });

    expect(onSelectNote.mock.calls).toEqual([[results[0].id], [results[1].id], [results[1].id]]);
  });

  it("explains an empty result", () => {
    render(<SearchResults query="zzz" results={[]} onSelectNote={() => {}} />);
    expect(screen.getByText("No matches found")).toBeTruthy();
    expect(screen.getByText("0 found")).toBeTruthy();
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
});
