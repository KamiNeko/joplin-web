import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { getNotes } from "@/lib/api";
import { recordNetworkError, recordResponse, resetConnection, setNoteUnsaved } from "@/lib/connection";
import { FetchCall, jsonResponse, mockFetch } from "@/test/fetch-mock";
import { ConnectionStatus } from "./ConnectionStatus";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ email: "me@example.com", serverHost: "notes.example.com" }),
}));

const NOTE_ID = "0123456789abcdef0123456789abcdef";
const OTHER_ID = "fedcba9876543210fedcba9876543210";

let calls: FetchCall[];
let refreshResponse: () => Response | Promise<Response>;
let queryFns: Record<string, ReturnType<typeof vi.fn>>;

/** Active queries the Refresh button should refetch */
function ActiveQueries() {
  useQuery({ queryKey: ["notes"], queryFn: queryFns.notes });
  useQuery({ queryKey: ["note", NOTE_ID], queryFn: queryFns.edited });
  useQuery({ queryKey: ["note", OTHER_ID], queryFn: queryFns.other });
  return null;
}

function renderStatus() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ActiveQueries />
      <ConnectionStatus />
    </QueryClientProvider>
  );
}

const trigger = () => screen.getByRole("button", { name: /^Connection status:/ });

async function openDetails() {
  fireEvent.click(trigger());
  return screen.findByRole("dialog");
}

beforeEach(() => {
  resetConnection();
  setNoteUnsaved(NOTE_ID, false);
  // Radix popper measures its content
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  queryFns = { notes: vi.fn(async () => []), edited: vi.fn(async () => ({})), other: vi.fn(async () => ({})) };
  refreshResponse = () => jsonResponse(null, 204);
  calls = mockFetch(({ path }) => {
    if (path === "/api/notebooks/refresh") return refreshResponse();
    if (path === "/api/notes") return jsonResponse({ error: "Internal error" }, 500);
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ConnectionStatus label", () => {
  it("starts as Connected and shows Updated after a successful read", async () => {
    renderStatus();
    await waitFor(() => expect(trigger().textContent).toBe("Connected"));

    act(() => recordResponse(200, true, ""));
    expect(trigger().textContent).toBe("Updated just now");
  });

  it("reports a 5xx as a server error and a network failure as unreachable, then recovers", async () => {
    renderStatus();
    await act(async () => {
      await expect(getNotes()).rejects.toMatchObject({ status: 500 });
    });
    expect(trigger().textContent).toBe("Server error");
    expect(screen.getByRole("status").textContent).toBe("Server error");

    act(() => recordNetworkError("Can't reach the server"));
    expect(trigger().textContent).toBe("Can't reach server");

    act(() => recordResponse(200, true, ""));
    expect(trigger().textContent).toBe("Updated just now");
    expect(screen.getByRole("status").textContent).toBe("Connection restored");
  });

  it("shows Session expired after a 401", async () => {
    renderStatus();
    act(() => recordResponse(401, true, "Invalid session"));
    expect(trigger().textContent).toBe("Session expired");
  });

  it("a 4xx rejection is not a connection problem", async () => {
    renderStatus();
    await waitFor(() => expect(trigger().textContent).toBe("Connected"));
    act(() => recordResponse(404, true, "Not found"));
    expect(trigger().textContent).toBe("Connected");
  });

  it("shows Offline when the browser goes offline", async () => {
    renderStatus();
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    act(() => void window.dispatchEvent(new Event("offline")));
    expect(trigger().textContent).toBe("Offline");

    onLine.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event("online")));
    expect(trigger().textContent).not.toBe("Offline");
  });

  it("lists server, account and the last error in the details", async () => {
    renderStatus();
    act(() => recordNetworkError("Can't reach the server"));
    const details = await openDetails();
    expect(details.textContent).toContain("notes.example.com");
    expect(details.textContent).toContain("me@example.com");
    expect(details.textContent).toContain("Last error");
    expect(details.textContent).toContain("Can't reach the server");
  });
});

describe("Refresh button", () => {
  it("reloads the backend cache, then refetches active queries except notes with unsaved edits", async () => {
    renderStatus();
    await waitFor(() => expect(queryFns.other).toHaveBeenCalledTimes(1));
    setNoteUnsaved(NOTE_ID, true);
    await openDetails();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(queryFns.other).toHaveBeenCalledTimes(2));
    expect(calls).toContainEqual({ method: "POST", path: "/api/notebooks/refresh", body: undefined });
    expect(queryFns.notes).toHaveBeenCalledTimes(2);
    expect(queryFns.edited).toHaveBeenCalledTimes(1);
    // A refresh is a read: it updates the timestamp and isn't counted as a pending write
    await waitFor(() => expect(trigger().textContent).toBe("Updated just now"));
  });

  it("shows Refreshing… and is disabled while the refresh runs", async () => {
    let finish!: () => void;
    refreshResponse = () => new Promise<Response>((resolve) => (finish = () => resolve(jsonResponse(null, 204))));
    renderStatus();
    await openDetails();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    const busy = await screen.findByRole("button", { name: "Refreshing…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(trigger().textContent).toBe("Refreshing…");

    await act(async () => finish());
    expect(await screen.findByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  it("does not refetch when the backend refresh fails, and shows the error", async () => {
    refreshResponse = () => jsonResponse({ error: "Joplin Server unreachable" }, 502);
    renderStatus();
    await waitFor(() => expect(queryFns.notes).toHaveBeenCalledTimes(1));
    await openDetails();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(trigger().textContent).toBe("Can't reach server"));
    expect(queryFns.notes).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog").textContent).toContain("Joplin Server unreachable");
  });
});
