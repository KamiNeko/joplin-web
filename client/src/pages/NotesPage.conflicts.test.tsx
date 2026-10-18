import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { Note, NoteListItem } from "@/lib/types";
import { resetConnection } from "@/lib/connection";
import { FetchCall, jsonResponse, mockFetch } from "@/test/fetch-mock";
import { NotesPage } from "./NotesPage";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ email: "me@example.com", logout: vi.fn() }),
}));

const NB_ID = "f".repeat(32);
const ORIGINAL_ID = "0123456789abcdef0123456789abcdef";
const CONFLICT_ID = "fedcba9876543210fedcba9876543210";

const conflictItem: NoteListItem = {
  id: CONFLICT_ID,
  title: "Roadmap",
  preview: "Their version",
  createdTime: 1,
  updatedTime: 2000,
  deletedTime: 0,
  parentId: NB_ID,
  isConflict: true,
};

const conflictNote: Note = {
  id: CONFLICT_ID,
  title: "Roadmap",
  body: "Their version",
  createdTime: 1,
  updatedTime: 2000,
  deletedTime: 0,
  parentId: NB_ID,
  notebookId: NB_ID,
  notebookTitle: "Projects",
  tags: [],
  isTodo: false,
  todoCompleted: false,
  isConflict: true,
  conflictOriginalId: ORIGINAL_ID,
};

let calls: FetchCall[];
let conflicts: NoteListItem[];
function LocationProbe() {
  const { pathname } = useLocation();
  return <output data-testid="location">{pathname}</output>;
}

/** The whole page renders on first use, which can take a while on a busy test run */
const slow = { timeout: 5000 };

const currentPath = () => screen.getByTestId("location").textContent;

function renderAt(path: string) {
  const routes = ["/notes", "/notes/:id", "/notebooks/:id", "/notebooks/:notebookId/notes/:id", "/conflicts", "/conflicts/:id", "/trash", "/trash/:id"];
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          {routes.map((route) => (
            <Route key={route} path={route} element={<NotesPage />} />
          ))}
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  resetConnection();
  conflicts = [conflictItem];
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  );
  calls = mockFetch(({ method, path }) => {
    if (method === "GET" && path === "/api/notes?is_conflict=true") return jsonResponse(conflicts);
    if (method === "GET" && path === `/api/notes/${CONFLICT_ID}`) return jsonResponse(conflictNote);
    if (method === "DELETE" && path === `/api/notes/${CONFLICT_ID}`) {
      conflicts = [];
      return jsonResponse(null, 204);
    }
    return undefined;
  });
});

afterEach(cleanup);

describe("Conflicts list", () => {
  it("shows the Conflicts entry in the sidebar only when there are conflicts", async () => {
    renderAt("/notes");
    const entry = await screen.findByRole("button", { name: /Conflicts/ }, slow);
    expect(within(entry).getByLabelText("1 conflict")).toBeTruthy();

    fireEvent.click(entry);
    await waitFor(() => expect(currentPath()).toBe("/conflicts"), slow);
  });

  it("hides the entry when there are no conflicts", async () => {
    conflicts = [];
    renderAt("/notes");
    await waitFor(() => expect(calls.some((c) => c.path === "/api/notes?is_conflict=true")).toBe(true), slow);
    await screen.findByRole("button", { name: /All Notes/ }, slow);
    expect(screen.queryByRole("button", { name: /Conflicts/ })).toBeNull();
  });

  it("lists the conflict copies on /conflicts without loading the regular list", async () => {
    renderAt("/conflicts");
    expect(await screen.findByText("Their version", {}, slow)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Conflicts/ }).getAttribute("aria-current")).toBe("page");
    expect(calls.some((c) => c.method === "GET" && c.path === "/api/notes")).toBe(false);
    // No new notes or to-dos from the conflicts list
    expect(screen.queryByRole("button", { name: "Create new note" })).toBeNull();
  });

  it("opens a conflict copy from /conflicts/:id, trashes it and returns to the list", async () => {
    renderAt(`/conflicts/${CONFLICT_ID}`);
    expect(await screen.findByText(/Conflict copy\./, {}, slow)).toBeTruthy();

    fireEvent.pointerDown(screen.getByRole("button", { name: "More note actions" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Move to trash/ }));

    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === `/api/notes/${CONFLICT_ID}`)).toBe(true), slow);
    await waitFor(() => expect(currentPath()).toBe("/conflicts"), slow);
  });

  it("sends a plain /notes/:id link to a conflict copy to /conflicts/:id", async () => {
    renderAt(`/notes/${CONFLICT_ID}`);
    await waitFor(() => expect(currentPath()).toBe(`/conflicts/${CONFLICT_ID}`), slow);
  });
});
