import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ReactNode } from "react";
import { getConnectionSnapshot, resetConnection } from "@/lib/connection";
import { jsonResponse, mockFetch, type FetchCall } from "@/test/fetch-mock";
import { testQueryClient } from "@/test/render";
import { useSearch } from "./use-search";

function renderSearch(initial: string) {
  const client = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(({ query }) => useSearch(query), { wrapper, initialProps: { query: initial } });
}

const searches = (calls: FetchCall[]) => calls.filter((c) => c.path.startsWith("/api/search"));

beforeEach(() => {
  vi.useFakeTimers();
  resetConnection();
});
afterEach(() => {
  vi.useRealTimers();
  resetConnection();
});

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

  it("aborts a superseded in-flight search without flagging a network or session error", async () => {
    const hit = { id: "b".repeat(32), title: "Bank statement", preview: "", createdTime: 1, updatedTime: 1 };
    const calls = mockFetch(({ path, signal }) => {
      if (path === "/api/search?q=ba") {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      }
      if (path === "/api/search?q=bank") {
        return jsonResponse([hit]);
      }
      return undefined;
    });

    const { result, rerender } = renderSearch("ba");
    await act(() => vi.advanceTimersByTimeAsync(300));

    expect(searches(calls)).toHaveLength(1);
    const firstSignal = searches(calls)[0].signal;
    expect(firstSignal).toBeInstanceOf(AbortSignal);
    expect(firstSignal?.aborted).toBe(false);

    // Supersede the slow query with a more specific one
    rerender({ query: "bank" });
    await act(() => vi.advanceTimersByTimeAsync(300));
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(firstSignal?.aborted).toBe(true);
    expect(result.current.data).toEqual([hit]);
    expect(result.current.error).toBeNull();
    expect(getConnectionSnapshot().lastError).toBeNull();
    expect(getConnectionSnapshot().sessionExpired).toBe(false);
  });
});
