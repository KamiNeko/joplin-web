import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { Note, NoteListItem, Notebook, Tag } from "@/lib/types";
import { draftOwner, setDraftOwner } from "@/lib/drafts";
import { FetchCall, jsonResponse, mockFetch } from "@/test/fetch-mock";
import { LocationProbe, renderWithProviders } from "@/test/render";
import { NotesPage } from "./NotesPage";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ email: "me@example.com", serverHost: "notes.example.com", logout: vi.fn() }),
}));
// CodeMirror needs layout APIs jsdom lacks; the editor has its own tests
vi.mock("@/components/notes/NoteEditor", () => ({
  NoteEditor: ({ note }: { note: Note }) => <div>Editing {note.id}</div>,
}));

const id = (c: string) => c.repeat(32);
const work: Notebook = { id: id("1"), title: "Work", parentId: "", children: [], noteCount: 2 };
const personal: Notebook = { id: id("2"), title: "Personal", parentId: "", children: [], noteCount: 1 };
const planning: Tag = { id: id("a"), title: "planning", noteCount: 1 };

const fullNote = (c: string, title: string, notebook: Notebook, body: string, tags: Tag[] = []): Note => ({
  id: id(c),
  title,
  body,
  updatedTime: Date.now() - 3_600_000,
  createdTime: Date.now() - 7_200_000,
  parentId: notebook.id,
  notebookId: notebook.id,
  notebookTitle: notebook.title,
  tags,
  isTodo: false,
  todoCompleted: false,
});
const notes = [
  fullNote("b", "Roadmap", work, "## Goals\n\nShip the relaunch.", [planning]),
  fullNote("c", "Meeting minutes", work, "Discussed the budget."),
  fullNote("d", "Lisbon trip", personal, "Visit Alfama."),
];
const listItem = (n: Note): NoteListItem => ({
  id: n.id,
  title: n.title,
  preview: n.body,
  updatedTime: n.updatedTime,
  createdTime: n.createdTime,
  notebookId: n.notebookId,
  parentId: n.parentId,
});

/** Backend stub with three notes in two notebooks; `override` answers a request first */
function mockNotesApi(override?: (call: FetchCall) => Response | undefined) {
  return mockFetch((call) => {
    const answer = override?.(call);
    if (answer) return answer;
    const url = new URL(call.path, "http://localhost");
    if (url.pathname === "/api/notebooks") return jsonResponse([work, personal]);
    if (url.pathname === "/api/tags") return jsonResponse([planning]);
    if (url.pathname === "/api/notes") {
      if (url.searchParams.get("is_trash")) return jsonResponse([]);
      const notebookId = url.searchParams.get("notebookId");
      const tagId = url.searchParams.get("tagId");
      return jsonResponse(
        notes
          .filter((n) => !notebookId || n.notebookId === notebookId)
          .filter((n) => !tagId || n.tags.some((t) => t.id === tagId))
          .map(listItem)
      );
    }
    const note = notes.find((n) => url.pathname === `/api/notes/${n.id}`);
    if (note && call.method === "GET") return jsonResponse(note);
    if (url.pathname === "/api/search") {
      const q = url.searchParams.get("q")!.toLowerCase();
      return jsonResponse(notes.filter((n) => (n.title + n.body).toLowerCase().includes(q)).map(listItem));
    }
    return undefined;
  });
}

function renderPage(route: string) {
  return renderWithProviders(
    <>
      <Routes>
        <Route path="/notes" element={<NotesPage />} />
        <Route path="/notes/:id" element={<NotesPage />} />
        <Route path="/notebooks/:id" element={<NotesPage />} />
        <Route path="/notebooks/:notebookId/notes/:id" element={<NotesPage />} />
        <Route path="/trash" element={<NotesPage />} />
        <Route path="/trash/:id" element={<NotesPage />} />
      </Routes>
      <LocationProbe />
    </>,
    { route }
  );
}

const location = () => screen.getByTestId("location").textContent;
/** The middle column's note list (the first list on the page) */
const noteRow = (title: string) => screen.findByText(title, { selector: "h3" });
/** The open note's title in the viewer */
const viewerTitle = (title: string) => screen.findByRole("heading", { level: 1, name: title });
const sidebar = () => within(screen.getByRole("complementary"));

beforeEach(() => {
  localStorage.clear();
  setDraftOwner(draftOwner("me@example.com", "notes.example.com"));
  // Desktop width: list and note side by side
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("min-width"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  );
});

afterEach(cleanup);

describe("NotesPage", () => {
  it("lists all notes and opens one from the list", async () => {
    mockNotesApi();
    renderPage("/notes");

    expect(await noteRow("Roadmap")).toBeTruthy();
    expect(await noteRow("Lisbon trip")).toBeTruthy();
    expect(screen.getByText("Every note in your collection")).toBeTruthy();

    fireEvent.click(await noteRow("Meeting minutes"));

    await waitFor(() => expect(location()).toBe(`/notes/${notes[1].id}`));
    expect(await viewerTitle("Meeting minutes")).toBeTruthy();
  });

  it("shows a note opened by its plain URL inside its notebook", async () => {
    mockNotesApi();
    renderPage(`/notes/${notes[2].id}`);

    await waitFor(() => expect(location()).toBe(`/notebooks/${personal.id}/notes/${notes[2].id}`));
    expect(await viewerTitle("Lisbon trip")).toBeTruthy();
    expect(await screen.findByText("Notebook notes")).toBeTruthy();
  });

  it("switches to a notebook from the sidebar and keeps the open note on desktop", async () => {
    const calls = mockNotesApi();
    renderPage(`/notes/${notes[0].id}?tag=${planning.id}`);
    await viewerTitle("Roadmap");

    fireEvent.click(await sidebar().findByRole("button", { name: "Personal, 1 note" }));

    await waitFor(() => expect(location()).toBe(`/notebooks/${personal.id}/notes/${notes[0].id}`));
    expect(await noteRow("Lisbon trip")).toBeTruthy();
    expect(screen.queryByText("Meeting minutes", { selector: "h3" })).toBeNull();
    expect(calls.some((c) => c.path === `/api/notes?notebookId=${personal.id}`)).toBe(true);
  });

  it("filters by tag from the URL and from a tag on the open note", async () => {
    const calls = mockNotesApi();
    renderPage(`/notebooks/${work.id}/notes/${notes[0].id}`);
    await viewerTitle("Roadmap");

    // Tag chip in the note viewer
    fireEvent.click(await screen.findByRole("button", { name: "#planning" }));

    await waitFor(() => expect(location()).toBe(`/notes/${notes[0].id}?tag=${planning.id}`));
    expect(await screen.findByText("Notes with tag")).toBeTruthy();
    expect(calls.some((c) => c.path === `/api/notes?tagId=${planning.id}`)).toBe(true);
    await waitFor(() => expect(screen.queryByText("Meeting minutes", { selector: "h3" })).toBeNull());
  });

  it("shows search results after typing and returns to the list when cleared", async () => {
    mockNotesApi();
    renderPage("/notes");
    await noteRow("Roadmap");

    // The header search field (the mobile menu's field is not rendered on desktop)
    fireEvent.change(screen.getByRole("searchbox", { name: "Search notes" }), { target: { value: "alfama" } });

    expect(await screen.findByText("Search Results", {}, { timeout: 2000 })).toBeTruthy();
    expect(await screen.findByText("1 found")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Lisbon trip/ }));
    await waitFor(() => expect(location()).toBe(`/notes/${notes[2].id}`));

    fireEvent.click(screen.getAllByRole("button", { name: "Clear search" })[0]);
    await waitFor(() => expect(screen.queryByText("Search Results")).toBeNull());
  });

  it("creates a note in the selected notebook and opens it in the editor", async () => {
    const created = fullNote("e", "", work, "");
    const calls = mockNotesApi((call) => {
      if (call.method === "POST" && call.path === "/api/notes") return jsonResponse(created, 201);
      if (call.path === `/api/notes/${created.id}`) return jsonResponse(created);
      return undefined;
    });
    renderPage(`/notebooks/${work.id}`);
    await noteRow("Roadmap");

    fireEvent.keyDown(screen.getByRole("button", { name: "Create new note" }), { key: "Enter" });
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Note" }));

    await waitFor(() => expect(location()).toBe(`/notebooks/${work.id}/notes/${created.id}`));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ parentId: work.id, title: "", body: "", isTodo: false });
    expect(await screen.findByText(`Editing ${created.id}`)).toBeTruthy();
  });

  it("shows the empty trash without a create button", async () => {
    mockNotesApi((call) => (call.path === "/api/notebooks/trash" ? jsonResponse([]) : undefined));
    renderPage("/trash");

    expect(await screen.findByText("Trash is empty")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create new note" })).toBeNull();
    expect(sidebar().getByRole("button", { name: "Trash" }).getAttribute("aria-current")).toBe("page");
  });

  it("closes the note and goes back to the list", async () => {
    mockNotesApi();
    renderPage(`/notebooks/${work.id}/notes/${notes[1].id}`);
    await viewerTitle("Meeting minutes");

    fireEvent.click(screen.getByRole("button", { name: "Close note view" }));

    await waitFor(() => expect(location()).toBe(`/notebooks/${work.id}`));
  });
});
