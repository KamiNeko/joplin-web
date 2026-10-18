import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Note } from "@/lib/types";
import { draftOwner, setDraftOwner } from "@/lib/drafts";
import { NoteViewer } from "./NoteViewer";

// Controls whether the dynamic import of the editor chunk fails
const chunk = vi.hoisted(() => ({ fail: true }));
vi.mock("./NoteEditor", () => {
  if (chunk.fail) throw new Error("Failed to fetch dynamically imported module");
  return { NoteEditor: () => <div>Editor loaded</div> };
});

const note: Note = {
  id: "0123456789abcdef0123456789abcdef",
  title: "Shopping list",
  body: "Server text",
  updatedTime: 1000,
  createdTime: 500,
  parentId: "f".repeat(32),
  notebookId: "f".repeat(32),
  notebookTitle: "Personal",
  tags: [],
  isTodo: false,
  todoCompleted: false,
};

function renderEditing() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <NoteViewer note={note} startInEdit />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  setDraftOwner(draftOwner("me@example.com", "notes.example.com"));
  // React logs caught render errors; keep the test output readable
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(cleanup);

// The tests share the module-level lazy editor, so they run in order
describe("NoteViewer when the editor chunk fails to load", () => {
  it("shows an error instead of crashing, and Back to reading returns to the note", async () => {
    chunk.fail = true;
    renderEditing();

    expect(await screen.findByText("Editor could not be loaded")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to reading" }));

    expect(screen.queryByText("Editor could not be loaded")).toBeNull();
    expect(screen.getByRole("heading", { name: "Shopping list" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("reloads the page when the fresh import fails as well", async () => {
    chunk.fail = true;
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    renderEditing();

    await screen.findByText("Editor could not be loaded");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Editor could not be loaded");
    expect(reload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("loads the editor on Retry once the chunk is reachable again", async () => {
    chunk.fail = true;
    renderEditing();
    await screen.findByText("Editor could not be loaded");

    chunk.fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Editor loaded")).toBeTruthy();
  });
});
