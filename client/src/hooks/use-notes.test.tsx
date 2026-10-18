import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { resetConnection } from "@/lib/connection";
import { FetchCall, jsonResponse, mockFetch } from "@/test/fetch-mock";
import { useConflictNotes } from "./use-notes";
import { useDeleteNote } from "./use-mutations";

const CONFLICT_ID = "fedcba9876543210fedcba9876543210";

let queryClient: QueryClient;
let calls: FetchCall[];
let conflicts: unknown[];

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  resetConnection();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  conflicts = [{ id: CONFLICT_ID, title: "Copy", preview: "", createdTime: 1, updatedTime: 2, isConflict: true }];
  calls = mockFetch(({ method, path }) => {
    if (method === "GET" && path === "/api/notes?is_conflict=true") return jsonResponse(conflicts);
    if (method === "DELETE") {
      conflicts = [];
      return jsonResponse(null, 204);
    }
    return undefined;
  });
});

describe("useConflictNotes", () => {
  it("loads the conflict copies and refreshes them after a note is trashed", async () => {
    const { result } = renderHook(() => ({ conflicts: useConflictNotes(), del: useDeleteNote() }), { wrapper });
    await waitFor(() => expect(result.current.conflicts.data).toHaveLength(1));

    await act(() => result.current.del.mutateAsync({ id: CONFLICT_ID }));
    await waitFor(() => expect(result.current.conflicts.data).toHaveLength(0));
    expect(calls.filter((c) => c.path === "/api/notes?is_conflict=true")).toHaveLength(2);
  });
});
