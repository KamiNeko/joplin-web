import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Note } from "@/lib/types";
import { draftOwner, loadDraft, saveDraft, setDraftOwner } from "@/lib/drafts";
import { NoteViewer } from "./NoteViewer";

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

function renderViewer(props: Partial<Parameters<typeof NoteViewer>[0]> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <NoteViewer note={note} {...props} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  setDraftOwner(draftOwner("me@example.com", "notes.example.com"));
});

afterEach(cleanup);

describe("NoteViewer restore offer", () => {
  it("blocks editing until the stored draft is restored or discarded", () => {
    saveDraft(note.id, { title: note.title, body: "Unsaved text", baseUpdatedTime: 900 });
    renderViewer({ startInEdit: true });

    expect(screen.getByText(/stored on this device/)).toBeTruthy();
    // Even with startInEdit, no editor opens that could overwrite the draft
    expect(screen.queryByLabelText("Note title")).toBeNull();
    expect((screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the draft untouched until Discard, then allows editing", () => {
    saveDraft(note.id, { title: note.title, body: "Unsaved text", baseUpdatedTime: 900 });
    renderViewer();
    expect(loadDraft(note.id)?.body).toBe("Unsaved text");
    expect((screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(loadDraft(note.id)).toBeNull();
    expect((screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows no offer when there is no draft", () => {
    renderViewer();
    expect(screen.queryByText(/stored on this device/)).toBeNull();
    expect((screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
