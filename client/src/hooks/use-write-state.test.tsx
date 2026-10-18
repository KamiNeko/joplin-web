import { afterEach, describe, expect, it } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ApiError, getWriteState, isReadOnlyError } from "@/lib/api";
import { resetConnection } from "@/lib/connection";
import { jsonResponse, mockFetch } from "@/test/fetch-mock";
import { useWriteState } from "./use-write-state";

const REASON = "This account uses end-to-end encryption. Joplin Web cannot encrypt data, so it is read-only here";

afterEach(() => {
  cleanup();
  resetConnection();
});

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

describe("getWriteState", () => {
  it("passes on a read-only answer with its reason", async () => {
    mockFetch(() => jsonResponse({ writable: false, reason: REASON }));
    expect(await getWriteState()).toEqual({ writable: false, reason: REASON });
  });

  it("counts anything but an explicit writable: false as writable", async () => {
    mockFetch(() => jsonResponse({ writable: true }));
    expect(await getWriteState()).toEqual({ writable: true, reason: null });
    mockFetch(() => jsonResponse([]));
    expect(await getWriteState()).toEqual({ writable: true, reason: null });
  });

  it("drops a reason that is not text", async () => {
    mockFetch(() => jsonResponse({ writable: false, reason: { html: "<b>x</b>" } }));
    expect(await getWriteState()).toEqual({ writable: false, reason: null });
  });
});

describe("isReadOnlyError", () => {
  it("is true for a 422 refusal only", () => {
    expect(isReadOnlyError(new ApiError(422, REASON))).toBe(true);
    expect(isReadOnlyError(new ApiError(409, "conflict"))).toBe(false);
    expect(isReadOnlyError(new Error("x"))).toBe(false);
  });
});

describe("useWriteState", () => {
  it("reports a read-only account", async () => {
    const calls = mockFetch(() => jsonResponse({ writable: false, reason: REASON }));
    const { result } = renderHook(() => useWriteState(), { wrapper });
    expect(result.current.readOnly).toBe(false);
    await waitFor(() => expect(result.current).toEqual({ readOnly: true, reason: REASON }));
    expect(calls.map((c) => c.path)).toEqual(["/api/account/write-state"]);
  });

  it("stays writable when the state can't be loaded", async () => {
    const calls = mockFetch(() => jsonResponse({ error: "Joplin Server refused this request" }, 403));
    const { result } = renderHook(() => useWriteState(), { wrapper });
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(result.current).toEqual({ readOnly: false, reason: null });
  });
});
