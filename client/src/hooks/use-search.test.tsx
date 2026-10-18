import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ReactNode } from "react";
import { jsonResponse, mockFetch } from "@/test/fetch-mock";
import { testQueryClient } from "@/test/render";
import { useSearch } from "./use-search";

function renderSearch(initial: string) {
  const client = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(({ query }) => useSearch(query), { wrapper, initialProps: { query: initial } });
}

const searches = (calls: { path: string }[]) => calls.filter((c) => c.path.startsWith("/api/search"));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useSearch", () => {
  it("waits 300 ms after the last keystroke and searches the trimmed query once", async () => {
    const calls = mockFetch(({ path }) => (path.startsWith("/api/search") ? jsonResponse([]) : undefined));
    const { result, rerender } = renderSearch("");

    rerender({ query: "r" });
    rerender({ query: "ro" });
    rerender({ query: " road " });
    await act(() => vi.advanceTimersByTimeAsync(299));
    expect(searches(calls)).toHaveLength(0);

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(result.current.debouncedQuery).toBe("road");
    expect(searches(calls).map((c) => c.path)).toEqual(["/api/search?q=road"]);
  });

  it("does not search for fewer than two characters", async () => {
    const calls = mockFetch(() => undefined);
    const { result, rerender } = renderSearch("");

    rerender({ query: " a " });
    await act(() => vi.advanceTimersByTimeAsync(1000));

    expect(result.current.debouncedQuery).toBe("a");
    expect(result.current.isSearching).toBe(false);
    expect(searches(calls)).toHaveLength(0);
  });

  it("returns the results and encodes the query", async () => {
    const hit = { id: "a".repeat(32), title: "Café & Co", preview: "", createdTime: 1, updatedTime: 1 };
    const calls = mockFetch(({ path }) => (path.startsWith("/api/search") ? jsonResponse([hit]) : undefined));
    const { result } = renderSearch("café & co");

    await act(() => vi.advanceTimersByTimeAsync(300));
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(searches(calls)[0].path).toBe("/api/search?q=caf%C3%A9+%26+co");
    expect(result.current.data).toEqual([hit]);
  });
});
