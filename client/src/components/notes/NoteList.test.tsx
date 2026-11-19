import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { Notebook, NoteListItem as NoteListItemType, Tag } from "@/lib/types";
import { jsonResponse, mockFetch } from "@/test/fetch-mock";
import { renderWithProviders } from "@/test/render";
import { NOTE_LIST_PAGE_SIZE, NoteList } from "./NoteList";
import { NOTE_LIST_VIEW_STORAGE_KEY } from "@/lib/ui-constants";

const nbId = (c: string) => c.repeat(32);
const noteId = (n: number) => n.toString(16).padStart(32, "0");

const notebooks: Notebook[] = [
  { id: nbId("1"), title: "Projects", parentId: "", children: [], noteCount: 3 },
  {
    id: nbId("2"),
    title: "Personal",
    parentId: "",
    children: [{ id: nbId("3"), title: "Travel", parentId: nbId("2"), children: [], noteCount: 0 }],
    noteCount: 1,
  },
  { id: nbId("4"), title: "Secret", parentId: "", children: [], noteCount: 1, encrypted: true },
];

const tags: Tag[] = [
  { id: nbId("a"), title: "planning", noteCount: 2 },
  { id: nbId("b"), title: "reading", noteCount: 1 },
];

const makeNotes = (count: number, baseTime = 1_700_000_000_000): NoteListItemType[] =>
  Array.from({ length: count }, (_, i) => ({
    id: noteId(i + 1),
    title: `Note ${i + 1}`,
    preview: `Preview ${i + 1}`,
    createdTime: baseTime - i * 1000,
    updatedTime: baseTime - i * 1000,
    parentId: nbId("1"),
    notebookId: nbId("1"),
  }));

afterEach(cleanup);

describe("NoteList bulk selection", () => {
  it("enters selection mode via header toggle, toggles items, and selects ranges with Shift", () => {
    mockFetch((c) => (c.path === "/api/tags" ? jsonResponse(tags) : undefined));
    const notes = makeNotes(4);
    const onSelectNote = vi.fn();

    renderWithProviders(
      <NoteList notes={notes} notebooks={notebooks} onSelectNote={onSelectNote} />
    );

    expect(screen.queryByRole("checkbox", { name: /^Select / })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    expect(screen.getByRole("button", { name: "Select" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getAllByRole("checkbox", { name: /^Select / })).toHaveLength(4);

    // Clicking first note selects it instead of opening it
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Note 1" }));
    expect(onSelectNote).not.toHaveBeenCalled();
    expect(screen.getByText("1 selected")).toBeTruthy();

    // Shift-clicking note 4 selects range Note 1..Note 4
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Note 4" }), { shiftKey: true });
    expect(screen.getByText("4 selected")).toBeTruthy();
    for (const n of notes) {
      expect(screen.getByRole("checkbox", { name: `Select ${n.title}` }).getAttribute("aria-checked")).toBe("true");
    }

    // Cancel exits selection mode and clears checkboxes
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("checkbox", { name: /^Select / })).toBeNull();
    expect(screen.queryByRole("region", { name: "Bulk actions" })).toBeNull();
  });

  it("enters selection mode on Ctrl/Cmd-click and exits on Escape", () => {
    mockFetch((c) => (c.path === "/api/tags" ? jsonResponse(tags) : undefined));
    const notes = makeNotes(3);
    const onSelectNote = vi.fn();

    renderWithProviders(
      <NoteList notes={notes} notebooks={notebooks} onSelectNote={onSelectNote} />
    );

    const secondItem = screen.getByRole("heading", { name: "Note 2" }).closest("[role='button']")!;
    fireEvent.click(secondItem, { ctrlKey: true });

    expect(onSelectNote).not.toHaveBeenCalled();
    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Select Note 2" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("checkbox", { name: /^Select / })).toBeNull();
    expect(screen.queryByRole("region", { name: "Bulk actions" })).toBeNull();

    // Meta-click (Cmd on macOS) also enters selection mode
    fireEvent.click(screen.getByRole("heading", { name: "Note 3" }).closest("[role='button']")!, { metaKey: true });
    expect(screen.getByText("1 selected")).toBeTruthy();
  });

  it("renders slices progressively for large notebooks while Select all selects every note", () => {
    mockFetch((c) => (c.path === "/api/tags" ? jsonResponse(tags) : undefined));
    const notes = makeNotes(250);
    const onBulkTrash = vi.fn();

    const { container } = renderWithProviders(
      <NoteList
        notes={notes}
        notebooks={notebooks}
        onSelectNote={vi.fn()}
        onBulkTrash={onBulkTrash}
      />
    );

    const renderedCheckboxes = () =>
      container.querySelectorAll<HTMLButtonElement>('button[role="checkbox"][aria-label^="Select "]');

    fireEvent.click(screen.getByText("Select"));
    expect(renderedCheckboxes()).toHaveLength(NOTE_LIST_PAGE_SIZE);

    fireEvent.click(screen.getByText("Select all (250)"));
    expect(screen.getByText("250 selected")).toBeTruthy();

    fireEvent.click(within(screen.getByRole("region", { name: "Bulk actions" })).getByText("Move to trash"));
    expect(onBulkTrash).toHaveBeenCalledTimes(1);
    expect(onBulkTrash.mock.calls[0][0]).toHaveLength(250);

    fireEvent.click(screen.getByText("Show more (150 remaining)"));
    expect(renderedCheckboxes()).toHaveLength(200);
  });

  it("supports Move to picker (skipping encrypted & uniform current), Add tag autocomplete, and Esc priority", async () => {
    mockFetch((c) => (c.path === "/api/tags" ? jsonResponse(tags) : undefined));
    const notes = makeNotes(2);
    const onBulkMove = vi.fn();
    const onBulkAddTag = vi.fn();

    renderWithProviders(
      <NoteList
        notes={notes}
        notebooks={notebooks}
        onSelectNote={vi.fn()}
        onBulkMove={onBulkMove}
        onBulkAddTag={onBulkAddTag}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("button", { name: "Select all (2)" }));

    // Open Move to… popover and verify encrypted notebook omitted and uniform current disabled
    fireEvent.click(screen.getByRole("button", { name: "Move to…" }));
    const destList = await screen.findByRole("list", { name: "Destination" });
    expect(within(destList).queryByText("Secret")).toBeNull();
    const projectsBtn = within(destList).getByRole("button", { name: /Projects/ }) as HTMLButtonElement;
    expect(projectsBtn.disabled).toBe(true);

    // Filter notebooks and pick nested Travel
    fireEvent.change(screen.getByLabelText("Filter notebooks"), { target: { value: "Trav" } });
    fireEvent.click(within(destList).getByRole("button", { name: "Travel" }));
    expect(onBulkMove).toHaveBeenCalledWith(notes, nbId("3"), "Travel");

    // Open Add tag… popover, pick suggestion, and verify Esc closes popover without exiting selection mode
    fireEvent.click(screen.getByRole("button", { name: "Add tag…" }));
    const tagInput = await screen.findByLabelText("Add tag");
    expect(await screen.findByRole("listbox")).toBeTruthy();

    fireEvent.keyDown(tagInput, { key: "Escape" });
    expect(screen.queryByLabelText("Add tag")).toBeNull();
    expect(screen.getByText("2 selected")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add tag…" }));
    const tagInput2 = await screen.findByLabelText("Add tag");
    fireEvent.change(tagInput2, { target: { value: "plan" } });
    fireEvent.keyDown(tagInput2, { key: "ArrowDown" });
    fireEvent.keyDown(tagInput2, { key: "Enter" });
    expect(onBulkAddTag).toHaveBeenCalledWith(notes, "planning");
  });

  it("hides Select when read-only or trash, and hides Add tag on conflicts", () => {
    mockFetch((c) => (c.path === "/api/tags" ? jsonResponse(tags) : undefined));
    const notes = makeNotes(2);

    const { rerender } = renderWithProviders(
      <NoteList notes={notes} notebooks={notebooks} onSelectNote={vi.fn()} canSelect={false} />
    );
    expect(screen.queryByRole("button", { name: "Select" })).toBeNull();

    rerender(
      <NoteList notes={notes} notebooks={notebooks} onSelectNote={vi.fn()} canSelect canBulkTag={false} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("button", { name: "Select all (2)" }));
    const bar = screen.getByRole("region", { name: "Bulk actions" });
    expect(within(bar).getByRole("button", { name: "Move to…" })).toBeTruthy();
    expect(within(bar).queryByRole("button", { name: "Add tag…" })).toBeNull();
    expect(within(bar).getByRole("button", { name: "Move to trash" })).toBeTruthy();
  });
});

describe("NoteList collection views & favorites", () => {
  it("switches between List, Gallery, Table, and Board views and persists layout choice", () => {
    localStorage.clear();
    mockFetch((c) => (c.path === "/api/tags" ? jsonResponse(tags) : undefined));
    const notes: NoteListItemType[] = [
      ...makeNotes(2),
      {
        id: noteId(3),
        title: "Pay invoice",
        preview: "Due soon",
        createdTime: 1_700_000_000_000,
        updatedTime: 1_700_000_000_000,
        parentId: nbId("1"),
        isTodo: true,
        todoCompleted: false,
      },
      {
        id: noteId(4),
        title: "Book flight",
        preview: "Done",
        createdTime: 1_700_000_000_000,
        updatedTime: 1_700_000_000_000,
        parentId: nbId("1"),
        isTodo: true,
        todoCompleted: true,
      },
    ];
    const onSelectNote = vi.fn();
    const onToggleTodo = vi.fn();

    renderWithProviders(
      <NoteList
        notes={notes}
        notebooks={notebooks}
        onSelectNote={onSelectNote}
        onToggleTodo={onToggleTodo}
        favoriteNoteIds={new Set([notes[0].id])}
      />
    );

    // Gallery view
    fireEvent.click(screen.getByRole("button", { name: "Gallery view" }));
    expect(localStorage.getItem(NOTE_LIST_VIEW_STORAGE_KEY)).toBe("gallery");
    expect(screen.getByText("Pay invoice")).toBeTruthy();

    // Table view
    fireEvent.click(screen.getByRole("button", { name: "Table view" }));
    expect(localStorage.getItem(NOTE_LIST_VIEW_STORAGE_KEY)).toBe("table");
    expect(screen.getByRole("columnheader", { name: "Title" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Type" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Updated" })).toBeTruthy();

    // Board view groups into Open To-dos, Completed, and Notes
    fireEvent.click(screen.getByRole("button", { name: "Board view" }));
    expect(localStorage.getItem(NOTE_LIST_VIEW_STORAGE_KEY)).toBe("board");
    expect(screen.getByRole("heading", { level: 4, name: "Open To-dos" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 4, name: "Completed" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 4, name: "Notes" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Toggle Pay invoice" }));
    expect(onToggleTodo).toHaveBeenCalledWith(notes[2].id, true);

    fireEvent.click(screen.getByRole("button", { name: "List view" }));
    expect(localStorage.getItem(NOTE_LIST_VIEW_STORAGE_KEY)).toBe("list");
  });
});
