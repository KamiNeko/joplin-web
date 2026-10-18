import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { Notebook, Tag } from "@/lib/types";
import { FetchCall, jsonResponse, mockFetch } from "@/test/fetch-mock";
import { renderWithProviders } from "@/test/render";
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

afterEach(cleanup);

describe("Sidebar", () => {
  it("lists the notebook tree with note counts and the tags", async () => {
    mockSidebarApi();
    renderSidebar();

    expect(await screen.findByRole("button", { name: "Work" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Projects, 3 notes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Meeting Notes, 1 note" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reading List, 2 notes" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "planning, 2 notes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ideas, 1 note" })).toBeTruthy();
  });

  it("marks the selected view and reports navigation", async () => {
    mockSidebarApi();
    const handlers = renderSidebar({ selectedNotebookId: projects.id });

    const selected = await screen.findByRole("button", { name: "Projects, 3 notes" });
    expect(selected.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "All Notes" }).getAttribute("aria-current")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reading List, 2 notes" }));
    fireEvent.click(screen.getByRole("button", { name: "All Notes" }));
    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    fireEvent.click(await screen.findByRole("button", { name: "planning, 2 notes" }));

    expect(handlers.onSelectNotebook).toHaveBeenCalledWith(reading.id);
    expect(handlers.onSelectAllNotes).toHaveBeenCalled();
    expect(handlers.onSelectTrash).toHaveBeenCalled();
    expect(handlers.onSelectTag).toHaveBeenCalledWith(tags[0].id);
  });

  it("collapses and expands a notebook with sub-notebooks", async () => {
    mockSidebarApi();
    renderSidebar();
    const toggle = await screen.findByRole("button", { name: "Collapse Work" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(toggle);
    expect(screen.queryByRole("button", { name: "Projects, 3 notes" })).toBeNull();
    expect(screen.getByRole("button", { name: "Expand Work" }).getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Expand Work" }));
    expect(screen.getByRole("button", { name: "Projects, 3 notes" })).toBeTruthy();
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
    await screen.findByRole("button", { name: "Work" });

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
});
