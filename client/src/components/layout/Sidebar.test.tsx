import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { EXPANDED_NOTEBOOKS_STORAGE_KEY, TAGS_EXPANDED_STORAGE_KEY } from "@/lib/ui-constants";
import { Notebook, Tag } from "@/lib/types";
import { FetchCall, jsonResponse, mockFetch } from "@/test/fetch-mock";
import { LocationProbe, renderWithProviders } from "@/test/render";
import { Sidebar } from "./Sidebar";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
// Has its own tests; needs the auth context
vi.mock("./ConnectionStatus", () => ({ ConnectionStatus: () => null }));

const id = (c: string) => c.repeat(32);
const notebook = (c: string, title: string, children: Notebook[] = [], noteCount = 0, parentId = ""): Notebook => ({
  id: id(c),
  title,
  parentId,
  children,
  noteCount,
});
const projects = notebook("2", "Projects", [], 3, id("1"));
const meetings = notebook("3", "Meeting Notes", [], 1, id("1"));
const work = notebook("1", "Work", [projects, meetings], 0);
const reading = notebook("4", "Reading List", [], 2);
const notebooks = [work, reading];
const tags: Tag[] = [
  { id: id("a"), title: "planning", noteCount: 2 },
  { id: id("b"), title: "ideas", noteCount: 1 },
];

/** Backend stub for the sidebar's lists; `override` answers a request first */
function mockSidebarApi(override?: (call: FetchCall) => Response | undefined) {
  return mockFetch((call) => {
    const answer = override?.(call);
    if (answer) return answer;
    if (call.path === "/api/notebooks") return jsonResponse(notebooks);
    if (call.path === "/api/tags") return jsonResponse(tags);
    return undefined;
  });
}

function renderSidebar(props: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const handlers = {
    onSelectAllNotes: vi.fn(),
    onSelectTrash: vi.fn(),
    onSelectNotebook: vi.fn(),
    onSelectTag: vi.fn(),
    onSearchChange: vi.fn(),
  };
  renderWithProviders(<Sidebar searchQuery="" {...handlers} {...props} />);
  return handlers;
}

/** Opens a Radix dropdown menu the way a keyboard user does (jsdom has no pointer capture) */
function openMenu(label: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: label }), { key: "Enter" });
  return screen.findByRole("menu");
}

const writes = (calls: FetchCall[]) => calls.filter((c) => c.method !== "GET");

beforeEach(() => {
  localStorage.clear();
});

afterEach(cleanup);

describe("Sidebar", () => {
  it("starts with nested notebooks and tags collapsed, showing tag count badge until expanded", async () => {
    mockSidebarApi();
    renderSidebar();

    expect(await screen.findByRole("button", { name: "Work" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reading List, 2 notes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Expand Work" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Projects, 3 notes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Meeting Notes, 1 note" })).toBeNull();

    const tagsHeader = screen.getByRole("button", { name: /^Tags\b/i });
    expect(tagsHeader.getAttribute("aria-expanded")).toBe("false");
    expect(within(tagsHeader).getByText("2")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "planning, 2 notes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "ideas, 1 note" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand Work" }));
    fireEvent.click(tagsHeader);

    expect(screen.getByRole("button", { name: "Projects, 3 notes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Meeting Notes, 1 note" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "planning, 2 notes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ideas, 1 note" })).toBeTruthy();
  });

  it("marks the selected view and reports navigation", async () => {
    mockSidebarApi();
    const handlers = renderSidebar({ selectedNotebookId: projects.id });

    // Selecting a nested notebook auto-expands its ancestor
    const selected = await screen.findByRole("button", { name: "Projects, 3 notes" });
    expect(selected.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "All Notes" }).getAttribute("aria-current")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reading List, 2 notes" }));
    fireEvent.click(screen.getByRole("button", { name: "All Notes" }));
    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    fireEvent.click(screen.getByRole("button", { name: /^Tags\b/i }));
    fireEvent.click(await screen.findByRole("button", { name: "planning, 2 notes" }));

    expect(handlers.onSelectNotebook).toHaveBeenCalledWith(reading.id);
    expect(handlers.onSelectAllNotes).toHaveBeenCalled();
    expect(handlers.onSelectTrash).toHaveBeenCalled();
    expect(handlers.onSelectTag).toHaveBeenCalledWith(tags[0].id);
  });

  it("expands and collapses notebooks and persists explicit choices in localStorage", async () => {
    mockSidebarApi();
    const view = renderWithProviders(
      <Sidebar
        searchQuery=""
        onSelectAllNotes={vi.fn()}
        onSelectTrash={vi.fn()}
        onSelectNotebook={vi.fn()}
        onSelectTag={vi.fn()}
        onSearchChange={vi.fn()}
      />
    );
    const expand = await screen.findByRole("button", { name: "Expand Work" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(expand);
    expect(screen.getByRole("button", { name: "Projects, 3 notes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Collapse Work" }).getAttribute("aria-expanded")).toBe("true");
    expect(JSON.parse(localStorage.getItem(EXPANDED_NOTEBOOKS_STORAGE_KEY) ?? "[]")).toEqual([work.id]);

    // Persisted expand survives remounting (e.g. reload or mobile drawer reopen)
    view.unmount();
    renderSidebar();
    expect(await screen.findByRole("button", { name: "Projects, 3 notes" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Collapse Work" }));
    expect(screen.queryByRole("button", { name: "Projects, 3 notes" })).toBeNull();
    expect(screen.getByRole("button", { name: "Expand Work" }).getAttribute("aria-expanded")).toBe("false");
    expect(JSON.parse(localStorage.getItem(EXPANDED_NOTEBOOKS_STORAGE_KEY) ?? "[]")).toEqual([]);
  });

  it("ignores and prunes stale notebook IDs stored in localStorage", async () => {
    const staleId = id("f");
    localStorage.setItem(EXPANDED_NOTEBOOKS_STORAGE_KEY, JSON.stringify([staleId, work.id]));
    mockSidebarApi();
    renderSidebar();

    expect(await screen.findByRole("button", { name: "Projects, 3 notes" })).toBeTruthy();
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(EXPANDED_NOTEBOOKS_STORAGE_KEY) ?? "[]")).toEqual([work.id]);
    });
  });

  it("auto-expands ancestors of selectedNotebookId and openNoteNotebookId", async () => {
    const deep = notebook("6", "Sprint 1", [], 1, id("5"));
    const nestedProjects = notebook("5", "Backend", [deep], 0, id("1"));
    const nestedWork = notebook("1", "Work", [nestedProjects], 0);
    mockSidebarApi((call) =>
      call.path === "/api/notebooks" ? jsonResponse([nestedWork, reading]) : undefined
    );

    const view = renderWithProviders(
      <Sidebar
        selectedNotebookId={null}
        openNoteNotebookId={deep.id}
        searchQuery=""
        onSelectAllNotes={vi.fn()}
        onSelectTrash={vi.fn()}
        onSelectNotebook={vi.fn()}
        onSelectTag={vi.fn()}
        onSearchChange={vi.fn()}
      />
    );

    // Ancestors of the open note's notebook expand automatically even on All Notes
    expect(await screen.findByRole("button", { name: "Sprint 1, 1 note" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Collapse Work" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Collapse Backend" }).getAttribute("aria-expanded")).toBe("true");

    // In-session collapse still works, and switching active path re-applies auto-expansion
    fireEvent.click(screen.getByRole("button", { name: "Collapse Backend" }));
    expect(screen.queryByRole("button", { name: "Sprint 1, 1 note" })).toBeNull();

    view.rerender(
      <Sidebar
        selectedNotebookId={reading.id}
        openNoteNotebookId={null}
        searchQuery=""
        onSelectAllNotes={vi.fn()}
        onSelectTrash={vi.fn()}
        onSelectNotebook={vi.fn()}
        onSelectTag={vi.fn()}
        onSearchChange={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: "Backend" })).toBeNull();

    view.rerender(
      <Sidebar
        selectedNotebookId={deep.id}
        openNoteNotebookId={null}
        searchQuery=""
        onSelectAllNotes={vi.fn()}
        onSelectTrash={vi.fn()}
        onSelectNotebook={vi.fn()}
        onSelectTag={vi.fn()}
        onSearchChange={vi.fn()}
      />
    );
    expect(await screen.findByRole("button", { name: "Sprint 1, 1 note" })).toBeTruthy();
  });

  it("persists Tags collapse/expand toggle and auto-expands when selectedTagId is active", async () => {
    mockSidebarApi();
    const view = renderWithProviders(
      <Sidebar
        searchQuery=""
        onSelectAllNotes={vi.fn()}
        onSelectTrash={vi.fn()}
        onSelectNotebook={vi.fn()}
        onSelectTag={vi.fn()}
        onSearchChange={vi.fn()}
      />
    );

    const tagsHeader = await screen.findByRole("button", { name: /^Tags\b/i });
    expect(tagsHeader.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(within(tagsHeader).getByText("2")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "planning, 2 notes" })).toBeNull();

    fireEvent.click(tagsHeader);
    expect(tagsHeader.getAttribute("aria-expanded")).toBe("true");
    expect(localStorage.getItem(TAGS_EXPANDED_STORAGE_KEY)).toBe("true");
    expect(await screen.findByRole("button", { name: "planning, 2 notes" })).toBeTruthy();

    view.unmount();
    renderSidebar();
    expect(await screen.findByRole("button", { name: "planning, 2 notes" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Tags\b/i }));
    expect(localStorage.getItem(TAGS_EXPANDED_STORAGE_KEY)).toBe("false");
    expect(screen.queryByRole("button", { name: "planning, 2 notes" })).toBeNull();
    cleanup();

    // Even when collapsed in localStorage, selecting a tag (via URL) expands Tags
    const tagView = renderWithProviders(
      <Sidebar
        selectedTagId={tags[0].id}
        searchQuery=""
        onSelectAllNotes={vi.fn()}
        onSelectTrash={vi.fn()}
        onSelectNotebook={vi.fn()}
        onSelectTag={vi.fn()}
        onSearchChange={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: /^Tags\b/i }).getAttribute("aria-expanded")).toBe("true");
    const selectedTag = await screen.findByRole("button", { name: "planning, 2 notes" });
    expect(selectedTag.getAttribute("aria-current")).toBe("page");

    // In-session collapse works, and returning to the tag later auto-expands again
    fireEvent.click(screen.getByRole("button", { name: /^Tags\b/i }));
    expect(screen.queryByRole("button", { name: "planning, 2 notes" })).toBeNull();
    tagView.rerender(
      <Sidebar
        selectedTagId={null}
        searchQuery=""
        onSelectAllNotes={vi.fn()}
        onSelectTrash={vi.fn()}
        onSelectNotebook={vi.fn()}
        onSelectTag={vi.fn()}
        onSearchChange={vi.fn()}
      />
    );
    tagView.rerender(
      <Sidebar
        selectedTagId={tags[0].id}
        searchQuery=""
        onSelectAllNotes={vi.fn()}
        onSelectTrash={vi.fn()}
        onSelectNotebook={vi.fn()}
        onSelectTag={vi.fn()}
        onSearchChange={vi.fn()}
      />
    );
    expect(await screen.findByRole("button", { name: "planning, 2 notes" })).toBeTruthy();
  });

  it("creates a top-level notebook and opens it", async () => {
    const created = notebook("9", "Garden", [], 0);
    const calls = mockSidebarApi((call) =>
      call.method === "POST" && call.path === "/api/notebooks" ? jsonResponse(created, 201) : undefined
    );
    const handlers = renderSidebar();

    fireEvent.click(await screen.findByRole("button", { name: "New notebook" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByPlaceholderText("Notebook name"), { target: { value: "  Garden " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(handlers.onSelectNotebook).toHaveBeenCalledWith(created.id));
    expect(writes(calls)).toEqual([{ method: "POST", path: "/api/notebooks", body: { title: "Garden" } }]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("creates a sub-notebook from a notebook's menu", async () => {
    const calls = mockSidebarApi((call) =>
      call.method === "POST" ? jsonResponse(notebook("9", "Ideas", [], 0, work.id), 201) : undefined
    );
    renderSidebar();
    await screen.findByRole("button", { name: "Work" });

    fireEvent.click(within(await openMenu("Actions for Work")).getByRole("menuitem", { name: "New sub-notebook" }));
    const dialog = await screen.findByRole("dialog", { name: 'New notebook in "Work"' });
    fireEvent.change(within(dialog).getByPlaceholderText("Notebook name"), { target: { value: "Ideas" } });
    fireEvent.submit(within(dialog).getByRole("button", { name: "Create" }).closest("form")!);

    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0].body).toEqual({ title: "Ideas", parentId: work.id });
  });

  it("renames a notebook, starting from its current title", async () => {
    const calls = mockSidebarApi((call) =>
      call.method === "PUT" ? jsonResponse({ ...reading, title: "Books" }) : undefined
    );
    renderSidebar();
    await screen.findByRole("button", { name: "Work" });

    fireEvent.click(within(await openMenu("Actions for Reading List")).getByRole("menuitem", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename notebook" });
    const input = within(dialog).getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("Reading List");
    fireEvent.change(input, { target: { value: "Books" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));

    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toEqual({ method: "PUT", path: `/api/notebooks/${reading.id}`, body: { title: "Books" } });
  });

  it("moves a notebook, offering neither itself nor its current parent", async () => {
    const calls = mockSidebarApi((call) =>
      call.method === "PUT" ? jsonResponse({ ...projects, parentId: reading.id }) : undefined
    );
    renderSidebar();
    fireEvent.click(await screen.findByRole("button", { name: "Expand Work" }));

    fireEvent.click(within(await openMenu("Actions for Projects")).getByRole("menuitem", { name: "Move to…" }));
    const dialog = await screen.findByRole("dialog", { name: "Move notebook" });
    const destinations = within(within(dialog).getByRole("list", { name: "Destination" })).getAllByRole("button");
    expect(destinations.map((b) => b.textContent)).toEqual(["Top level", "WorkCurrent", "Meeting Notes", "Reading List"]);
    expect((destinations[1] as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(destinations[3]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Move" }));

    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toEqual({ method: "PUT", path: `/api/notebooks/${projects.id}`, body: { parentId: reading.id } });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Moved "Projects" to "Reading List"'));
  });

  it("trashes a notebook after confirmation and leaves it when it was selected", async () => {
    const calls = mockSidebarApi((call) => (call.method === "DELETE" ? jsonResponse(null, 204) : undefined));
    const handlers = renderSidebar({ selectedNotebookId: projects.id });
    await screen.findByRole("button", { name: "Work" });

    fireEvent.click(within(await openMenu("Actions for Work")).getByRole("menuitem", { name: "Move to trash" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain('"Work" and everything in it (4 notes, 2 sub-notebooks)');
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to trash" }));

    await waitFor(() => expect(handlers.onSelectAllNotes).toHaveBeenCalled());
    expect(writes(calls)).toEqual([{ method: "DELETE", path: `/api/notebooks/${work.id}`, body: undefined }]);
  });

  it("reports a failed rename and keeps the dialog open", async () => {
    mockSidebarApi((call) => (call.method === "PUT" ? jsonResponse({ error: "Notebook is encrypted" }, 409) : undefined));
    renderSidebar();
    await screen.findByRole("button", { name: "Work" });

    fireEvent.click(within(await openMenu("Actions for Work")).getByRole("menuitem", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename notebook" });
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Job" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Could not rename notebook", { description: "Notebook is encrypted" })
    );
    expect(screen.getByRole("dialog", { name: "Rename notebook" })).toBeTruthy();
  });

  it("renames and deletes tags from the tag menu", async () => {
    const calls = mockSidebarApi((call) => {
      if (call.method === "PUT") return jsonResponse({ ...tags[0], title: "plans" });
      if (call.method === "DELETE") return jsonResponse(null, 204);
      return undefined;
    });
    const handlers = renderSidebar({ selectedTagId: tags[1].id });
    await screen.findByRole("button", { name: "planning, 2 notes" });

    fireEvent.click(within(await openMenu("Actions for tag planning")).getByRole("menuitem", { name: /Rename/ }));
    const rename = await screen.findByRole("dialog", { name: "Rename tag" });
    fireEvent.change(within(rename).getByRole("textbox"), { target: { value: "plans" } });
    fireEvent.click(within(rename).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(within(await openMenu("Actions for tag ideas")).getByRole("menuitem", { name: /Delete/ }));
    const confirm = await screen.findByRole("dialog");
    expect(confirm.textContent).toContain('"ideas" will be removed from 1 note.');
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete tag" }));

    // The deleted tag was the selected list
    await waitFor(() => expect(handlers.onSelectAllNotes).toHaveBeenCalled());
    expect(writes(calls)).toEqual([
      { method: "PUT", path: `/api/tags/${tags[0].id}`, body: { title: "plans" } },
      { method: "DELETE", path: `/api/tags/${tags[1].id}`, body: undefined },
    ]);
  });

  it("shows load errors per section with Retry", async () => {
    let failNotebooks = true;
    const calls = mockSidebarApi((call) => {
      if (call.path === "/api/notebooks" && failNotebooks) return jsonResponse({ error: "Boom" }, 500);
      if (call.path === "/api/tags") return jsonResponse([]);
      return undefined;
    });
    renderSidebar();

    expect(await screen.findByText("Couldn't load notebooks")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Tags\b/i }));
    expect(await screen.findByText("No tags")).toBeTruthy();

    failNotebooks = false;
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByRole("button", { name: "Work" })).toBeTruthy();
    expect(calls.filter((c) => c.path === "/api/notebooks")).toHaveLength(2);
  });

  it("has a search field only in the mobile menu", async () => {
    const onCloseMobile = vi.fn();
    const handlers = renderSidebar({ searchQuery: "road", onCloseMobile });

    const search = screen.getByRole("searchbox", { name: "Search notes" });
    fireEvent.change(search, { target: { value: "roadmap" } });
    fireEvent.keyDown(search, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Clear search text" }));

    expect(handlers.onSearchChange.mock.calls).toEqual([["roadmap"], [""]]);
    expect(onCloseMobile).toHaveBeenCalledTimes(1);
    cleanup();

    renderSidebar();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("renders Shortcuts for favorited notes, pinned notebooks, and saved searches and supports removing & pinning", async () => {
    const starredNoteId = id("c");
    const prefs = {
      favoriteNoteIds: [starredNoteId],
      favoriteNotebookIds: [reading.id],
      savedSearches: [{ id: "ss-1", name: "Unread invoices", query: "tag:invoice iscompleted:0", createdAt: 1000 }],
      recentReads: [],
      scratchpad: "",
      favoriteNotes: [
        {
          id: starredNoteId,
          title: "Pinned Spec",
          preview: "Spec body",
          createdTime: 1000,
          updatedTime: 2000,
          parentId: work.id,
        },
      ],
      favoriteNotebooks: [
        { id: reading.id, title: reading.title, parentId: "", noteCount: 2, encrypted: false },
      ],
    };
    const calls = mockSidebarApi((call) => {
      if (call.method === "GET" && call.path === "/api/preferences") return jsonResponse(prefs);
      if (call.method === "DELETE" && call.path.startsWith("/api/preferences/")) {
        return jsonResponse({
          ...prefs,
          favoriteNoteIds: [],
          favoriteNotes: [],
          favoriteNotebookIds: [],
          favoriteNotebooks: [],
          savedSearches: [],
        });
      }
      if (call.method === "POST" && call.path === `/api/preferences/favorites/notebooks/${work.id}`) {
        return jsonResponse({ ...prefs, favoriteNotebookIds: [...prefs.favoriteNotebookIds, work.id] });
      }
      return undefined;
    });

    const onOpenNote = vi.fn();
    const onSelectNotebook = vi.fn();
    const onApplySavedSearch = vi.fn();
    renderWithProviders(
      <>
        <Sidebar
          searchQuery=""
          onSelectAllNotes={vi.fn()}
          onSelectTrash={vi.fn()}
          onSelectNotebook={onSelectNotebook}
          onSelectTag={vi.fn()}
          onSearchChange={vi.fn()}
          onOpenNote={onOpenNote}
          onApplySavedSearch={onApplySavedSearch}
        />
        <LocationProbe />
      </>
    );

    const shortcutsHeader = await screen.findByRole("button", { name: /^Shortcuts/ });
    expect(shortcutsHeader.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Pinned Spec" }));
    expect(onOpenNote).toHaveBeenCalledWith(starredNoteId);

    fireEvent.click(screen.getByRole("button", { name: "Unread invoices" }));
    expect(onApplySavedSearch).toHaveBeenCalledWith("tag:invoice iscompleted:0");

    // Collapsing hides the shortcut list
    fireEvent.click(shortcutsHeader);
    expect(screen.queryByRole("button", { name: "Pinned Spec" })).toBeNull();
    fireEvent.click(shortcutsHeader);
    expect(screen.getByRole("button", { name: "Pinned Spec" })).toBeTruthy();

    // Remove note shortcut
    fireEvent.click(screen.getByRole("button", { name: "Remove shortcut for Pinned Spec" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.path === `/api/preferences/favorites/notes/${starredNoteId}`)).toBe(true)
    );

    // Pin another notebook via menu
    fireEvent.click(within(await openMenu("Actions for Work")).getByRole("menuitem", { name: "Pin to shortcuts" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path === `/api/preferences/favorites/notebooks/${work.id}`)).toBe(true)
    );
  });

  it("navigates to Home, Recent, Tasks, Hygiene, Clip & Import and opens Ask AI", async () => {
    mockSidebarApi();
    const onOpenAskAi = vi.fn();
    renderWithProviders(
      <>
        <Sidebar
          searchQuery=""
          aiEnabled
          onOpenAskAi={onOpenAskAi}
          onSelectAllNotes={vi.fn()}
          onSelectTrash={vi.fn()}
          onSelectNotebook={vi.fn()}
          onSelectTag={vi.fn()}
          onSearchChange={vi.fn()}
        />
        <LocationProbe />
      </>,
      { route: "/notes" }
    );

    await screen.findByRole("button", { name: "Home" });
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    expect(screen.getByTestId("location").textContent).toBe("/home");

    fireEvent.click(screen.getByRole("button", { name: "Recent" }));
    expect(screen.getByTestId("location").textContent).toBe("/recent");

    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(screen.getByTestId("location").textContent).toBe("/tasks");

    fireEvent.click(screen.getByRole("button", { name: "Hygiene" }));
    expect(screen.getByTestId("location").textContent).toBe("/hygiene");

    fireEvent.click(screen.getByRole("button", { name: "Clip & Import" }));
    expect(screen.getByTestId("location").textContent).toBe("/clip");

    fireEvent.click(screen.getByRole("button", { name: "Ask AI" }));
    expect(onOpenAskAi).toHaveBeenCalledTimes(1);
  });
});
