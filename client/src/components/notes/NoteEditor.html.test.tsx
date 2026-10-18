import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Note } from "@/lib/types";
import { resetConnection } from "@/lib/connection";
import { draftOwner, setDraftOwner } from "@/lib/drafts";
import { FetchCall, jsonResponse, mockFetch } from "@/test/fetch-mock";
import { NoteEditor } from "./NoteEditor";

// CodeMirror needs layout APIs jsdom lacks; a textarea stands in for it and exposes the html prop
vi.mock("./MarkdownEditor", async () => {
  const { forwardRef } = await import("react");
  return {
    UPLOAD_PLACEHOLDER: /$^/g,
    MarkdownEditor: forwardRef<unknown, { value: string; html?: boolean; onChange: (v: string) => void }>(
      function MarkdownEditor({ value, html, onChange }, ref) {
        void ref;
        return (
          <textarea
            aria-label="Note body"
            data-html={String(Boolean(html))}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
        );
      }
    ),
  };
});
// jsdom has no matchMedia; desktop width
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

const NOTE_ID = "0123456789abcdef0123456789abcdef";
const markdownNote: Note = {
  id: NOTE_ID,
  title: "Clip",
  body: "Text",
  updatedTime: 1000,
  createdTime: 500,
  parentId: "f".repeat(32),
  notebookId: "f".repeat(32),
  notebookTitle: "Reading",
  tags: [],
  isTodo: false,
  todoCompleted: false,
  markupLanguage: 1,
};
const htmlNote: Note = {
  ...markdownNote,
  markupLanguage: 2,
  body: '<div class="clip">\n  <p>Intro</p>\n\n    <p>After blank line, indented</p>\n</div>',
};

let calls: FetchCall[];

function renderEditor(note: Note) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <NoteEditor note={note} onDone={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>
  ).container;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("joplin-editor-mode", "split");
  resetConnection();
  setDraftOwner(draftOwner("me@example.com", "notes.example.com"));
  calls = mockFetch(({ method, path, body }) => {
    if (method === "PUT" && path === `/api/notes/${NOTE_ID}`) {
      return jsonResponse({ ...htmlNote, ...(body as object), updatedTime: 2000 });
    }
    return undefined;
  });
});

afterEach(cleanup);

// Regression tests for #104
describe("NoteEditor with an HTML note", () => {
  it("edits the raw HTML with a hint and previews it as HTML", () => {
    const container = renderEditor(htmlNote);
    expect(screen.getByRole("note").textContent).toMatch(/This is an HTML note/);
    const body = screen.getByLabelText("Note body") as HTMLTextAreaElement;
    expect(body.value).toBe(htmlNote.body);
    expect(body.dataset.html).toBe("true");
    expect(screen.getByText("After blank line, indented").tagName).toBe("P");
    expect(container.querySelector("pre")).toBeNull();
  });

  it("saves only title and body, so markup_language stays as it is", async () => {
    renderEditor(htmlNote);
    fireEvent.change(screen.getByLabelText("Note body"), { target: { value: `${htmlNote.body}\n<p>More</p>` } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const save = calls.find((c) => c.method === "PUT")!.body as Record<string, unknown>;
    expect(save.body).toBe(`${htmlNote.body}\n<p>More</p>`);
    expect(save).not.toHaveProperty("markupLanguage");
  });

  it("shows no hint for Markdown notes", () => {
    renderEditor(markdownNote);
    expect(screen.queryByRole("note")).toBeNull();
    expect((screen.getByLabelText("Note body") as HTMLTextAreaElement).dataset.html).toBe("false");
  });
});
