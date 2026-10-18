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

// Regression tests for #104
describe("NoteViewer with an HTML note", () => {
  const htmlNote: Note = {
    ...note,
    markupLanguage: 2,
    body: '<div class="clip">\n  <p>Intro</p>\n\n    <p>After blank line, indented</p>\n</div>',
  };

  it("renders the body as HTML and marks it as an HTML note", () => {
    const { container } = renderViewer({ note: htmlNote });
    expect(screen.getByText("HTML note")).toBeTruthy();
    expect(screen.getByText("After blank line, indented").tagName).toBe("P");
    expect(container.querySelector("pre")).toBeNull();
  });

  it("shows no HTML marker for Markdown notes", () => {
    renderViewer();
    expect(screen.queryByText("HTML note")).toBeNull();
  });
});

describe("NoteViewer read-only", () => {
  it("offers no editing, note actions or tag changes on a read-only account", () => {
    renderViewer({ readOnly: true, startInEdit: true, note: { ...note, isTodo: true } });
    expect(screen.getByRole("heading", { name: "Shopping list" })).toBeTruthy();
    expect(screen.getByText("Server text")).toBeTruthy();
    expect(screen.queryByLabelText("Note title")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More note actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Tag" })).toBeNull();
    expect((screen.getByRole("button", { name: /To do/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps a stored draft untouched and does not offer it while read-only", () => {
    saveDraft(note.id, { title: note.title, body: "Unsaved text", baseUpdatedTime: 900 });
    renderViewer({ readOnly: true });
    expect(screen.queryByText(/stored on this device/)).toBeNull();
    expect(loadDraft(note.id)?.body).toBe("Unsaved text");
  });

  it("does not offer to start writing in an empty note", () => {
    renderViewer({ readOnly: true, note: { ...note, body: "" } });
    expect(screen.getByText("This note is empty.").tagName).toBe("P");
  });

  it("shows an encrypted note as encrypted, without editing, even on a writable account", () => {
    renderViewer({ note: { ...note, title: "", body: "", createdTime: 0, encrypted: true } });
    expect(screen.getByRole("heading", { name: "Encrypted note" })).toBeTruthy();
    expect(screen.getByText("Encrypted")).toBeTruthy();
    expect(screen.getByText(/This note is end-to-end encrypted/)).toBeTruthy();
    expect(screen.queryByText(/This note is empty/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More note actions" })).toBeNull();
  });
});
