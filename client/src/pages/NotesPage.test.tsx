import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { toast } from "sonner";
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

  it("switches to a notebook from the sidebar and opens its top note on desktop", async () => {
    const calls = mockNotesApi();
    renderPage(`/notes/${notes[0].id}?tag=${planning.id}`);
    await viewerTitle("Roadmap");

    fireEvent.click(await sidebar().findByRole("button", { name: "Personal, 1 note" }));

    await waitFor(() => expect(location()).toBe(`/notebooks/${personal.id}/notes/${notes[2].id}`));
    expect(await viewerTitle("Lisbon trip")).toBeTruthy();
    expect(await noteRow("Lisbon trip")).toBeTruthy();
    expect(screen.queryByText("Meeting minutes", { selector: "h3" })).toBeNull();
    expect(calls.some((c) => c.path === `/api/notes?notebookId=${personal.id}`)).toBe(true);
  });

  it("keeps the open note when the shown notebook is picked again", async () => {
    mockNotesApi();
    renderPage(`/notebooks/${work.id}/notes/${notes[1].id}`);
    await viewerTitle("Meeting minutes");

    fireEvent.click(await sidebar().findByRole("button", { name: "Work, 2 notes" }));

    await waitFor(() => expect(location()).toBe(`/notebooks/${work.id}/notes/${notes[1].id}`));
    expect(await viewerTitle("Meeting minutes")).toBeTruthy();
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

describe("bulk selection and actions", () => {
  it("resets selection when switching notebooks, tags, or entering search", async () => {
    mockNotesApi();
    renderPage("/notes");
    await noteRow("Roadmap");

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Roadmap" }));
    expect(screen.getByText("1 selected")).toBeTruthy();

    // Switch notebook in sidebar -> selection resets once the new list finishes loading too
    fireEvent.click(await sidebar().findByRole("button", { name: "Work, 2 notes" }));
    await waitFor(() => expect(location()).toBe(`/notebooks/${work.id}`));
    await noteRow("Roadmap");
    expect(screen.queryByRole("checkbox", { name: /^Select / })).toBeNull();
    expect(screen.queryByRole("region", { name: "Bulk actions" })).toBeNull();

    // Select again, then search -> selection resets on search & stays reset on clear
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Roadmap" }));
    expect(screen.getByText("1 selected")).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search notes" }), { target: { value: "alfama" } });
    expect(await screen.findByText("Search Results", {}, { timeout: 2000 })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Clear search" })[0]);

    await noteRow("Roadmap");
    expect(screen.queryByRole("checkbox", { name: /^Select / })).toBeNull();
  });

  it("moves selected notes with conflict skipping and restores each note to its previous notebook on Undo", async () => {
    const successSpy = vi.spyOn(toast, "success").mockReturnValue("t1");
    const warningSpy = vi.spyOn(toast, "warning").mockReturnValue("t2");
    const batchCalls = mockNotesApi((call) => {
      if (call.method === "POST" && call.path === "/api/notes/batch") {
        const body = call.body as { items: Array<{ id: string }> };
        if (body.items.length === 2) {
          return jsonResponse([
            { id: notes[0].id, status: "ok", updatedTime: 9001 },
            { id: notes[2].id, status: "conflict", error: "Changed elsewhere" },
          ]);
        }
        return jsonResponse(body.items.map((item) => ({ id: item.id, status: "ok", updatedTime: 9002 })));
      }
      return undefined;
    });

    renderPage("/notes");
    await noteRow("Roadmap");

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Roadmap" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Lisbon trip" }));
    fireEvent.click(screen.getByRole("button", { name: "Move to…" }));
    const destList = await screen.findByRole("list", { name: "Destination" });
    fireEvent.click(within(destList).getByRole("button", { name: "Personal" }));

    await waitFor(() => expect(warningSpy).toHaveBeenCalled());
    const [warnMsg, warnOpts] = warningSpy.mock.calls[0];
    expect(warnMsg).toBe("Moved 1 note, 1 skipped: changed elsewhere");
    expect(warnOpts?.description).toBe('to "Personal"');

    const firstPost = batchCalls.find((c) => c.method === "POST" && c.path === "/api/notes/batch")!;
    expect(firstPost.body).toEqual({
      items: [
        { id: notes[0].id, baseUpdatedTime: notes[0].updatedTime },
        { id: notes[2].id, baseUpdatedTime: notes[2].updatedTime },
      ],
      parentId: personal.id,
    });

    // Trigger Undo from the toast action: only the 1 moved note reverts to Work
    const undoAction = warnOpts?.action as { label: string; onClick: () => void };
    expect(undoAction.label).toBe("Undo");
    undoAction.onClick();

    await waitFor(() => expect(successSpy).toHaveBeenCalledWith("Moved back 1 note"));
    const allBatchPosts = batchCalls.filter((c) => c.method === "POST" && c.path === "/api/notes/batch");
    expect(allBatchPosts).toHaveLength(2);
    expect(allBatchPosts[1].body).toEqual({
      items: [{ id: notes[0].id, baseUpdatedTime: 9001, parentId: work.id }],
    });
  });

  it("adds tags in bulk and only removes newly added tags on Undo", async () => {
    const successSpy = vi.spyOn(toast, "success").mockReturnValue("t1");
    const batchCalls = mockNotesApi((call) => {
      if (call.method === "POST" && call.path === "/api/notes/batch") {
        const body = call.body as { addTags?: string[]; removeTags?: string[] };
        if (body.addTags) {
          return jsonResponse([
            { id: notes[0].id, status: "ok", updatedTime: notes[0].updatedTime, addedTags: [] },
            { id: notes[1].id, status: "ok", updatedTime: notes[1].updatedTime, addedTags: ["planning"] },
          ]);
        }
        return jsonResponse([{ id: notes[1].id, status: "ok", updatedTime: notes[1].updatedTime }]);
      }
      return undefined;
    });

    renderPage(`/notebooks/${work.id}`);
    await noteRow("Roadmap");

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("button", { name: "Select all (2)" }));
    fireEvent.click(screen.getByRole("button", { name: "Add tag…" }));
    const tagInput = await screen.findByLabelText("Add tag");
    fireEvent.change(tagInput, { target: { value: "planning" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });

    await waitFor(() => expect(successSpy).toHaveBeenCalled());
    const [msg, opts] = successSpy.mock.calls[0];
    expect(msg).toBe("Added #planning to 1 note");
    expect(opts?.description).toBe("1 already had #planning");

    const undoAction = opts?.action as { label: string; onClick: () => void };
    undoAction.onClick();

    await waitFor(() => expect(successSpy).toHaveBeenCalledWith("Removed #planning from 1 note"));
    const allBatchPosts = batchCalls.filter((c) => c.method === "POST" && c.path === "/api/notes/batch");
    expect(allBatchPosts[1].body).toEqual({
      items: [{ id: notes[1].id, baseUpdatedTime: notes[1].updatedTime }],
      removeTags: ["planning"],
    });
  });

  it("moves selected notes to trash, closes an affected open note, and restores on Undo", async () => {
    const successSpy = vi.spyOn(toast, "success").mockReturnValue("t1");
    const batchCalls = mockNotesApi((call) => {
      if (call.method === "POST" && call.path === "/api/notes/batch") {
        const body = call.body as { items: Array<{ id: string }> };
        return jsonResponse(body.items.map((item) => ({ id: item.id, status: "ok", updatedTime: 9500 })));
      }
      return undefined;
    });

    renderPage(`/notebooks/${work.id}/notes/${notes[0].id}`);
    await viewerTitle("Roadmap");

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("button", { name: "Select all (2)" }));
    fireEvent.click(within(screen.getByRole("region", { name: "Bulk actions" })).getByRole("button", { name: "Move to trash" }));

    await waitFor(() => expect(location()).toBe(`/notebooks/${work.id}`));
    await waitFor(() => expect(successSpy).toHaveBeenCalled());
    const [msg, opts] = successSpy.mock.calls[0];
    expect(msg).toBe("Moved 2 notes to trash");

    const undoAction = opts?.action as { label: string; onClick: () => void };
    undoAction.onClick();

    await waitFor(() => expect(successSpy).toHaveBeenCalledWith("Restored 2 notes from trash"));
    const allBatchPosts = batchCalls.filter((c) => c.method === "POST" && c.path === "/api/notes/batch");
    expect(allBatchPosts[0].body).toEqual({
      items: [
        { id: notes[0].id, baseUpdatedTime: notes[0].updatedTime },
        { id: notes[1].id, baseUpdatedTime: notes[1].updatedTime },
      ],
      trash: true,
    });
    expect(allBatchPosts[1].body).toEqual({
      items: [
        { id: notes[0].id, baseUpdatedTime: 9500 },
        { id: notes[1].id, baseUpdatedTime: 9500 },
      ],
      restore: true,
    });
  });

  it("shows Auto-organize only when enabled, pre-excludes uniform source notebook, and navigates to /organize/:jobId", async () => {
    let organizeEnabled = false;
    const calls = mockNotesApi((call) => {
      if (call.path === "/api/organize/status") {
        return jsonResponse(organizeEnabled ? { enabled: true, model: "deepseek-flash" } : { enabled: false });
      }
      if (call.method === "POST" && call.path === "/api/organize/jobs") {
        return jsonResponse({ jobId: "abc1234567890abcdef1234567890abc" }, 201);
      }
      return undefined;
    });

    const first = renderPage(`/notebooks/${work.id}`);
    await noteRow("Roadmap");
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("button", { name: "Select all (2)" }));
    const barDisabled = screen.getByRole("region", { name: "Bulk actions" });
    expect(within(barDisabled).queryByRole("button", { name: "Auto-organize" })).toBeNull();
    first.unmount();

    organizeEnabled = true;
    renderWithProviders(
      <>
        <Routes>
          <Route path="/notebooks/:id" element={<NotesPage />} />
          <Route path="/notebooks/:notebookId/notes/:id" element={<NotesPage />} />
          <Route path="/organize/:jobId" element={<div>Organize View</div>} />
        </Routes>
        <LocationProbe />
      </>,
      { route: `/notebooks/${work.id}` }
    );
    await noteRow("Roadmap");
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("button", { name: "Select all (2)" }));

    const barEnabled = screen.getByRole("region", { name: "Bulk actions" });
    const btn = await within(barEnabled).findByRole("button", { name: "Auto-organize" });
    fireEvent.click(btn);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Auto-organize 2 notes")).toBeTruthy();
    expect((within(dialog).getByRole("checkbox", { name: /Work/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Start organizing (2)" }));

    await waitFor(() => expect(location()).toBe("/organize/abc1234567890abcdef1234567890abc"));
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/organize/jobs")!;
    expect(post.body).toEqual({
      noteIds: [notes[0].id, notes[1].id],
      excludeNotebookIds: [work.id],
    });
  });
});
