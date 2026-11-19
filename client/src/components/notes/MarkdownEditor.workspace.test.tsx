import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { useState } from "react";
import { EditorView } from "@uiw/react-codemirror";
import { Note } from "@/lib/types";
import { draftOwner, setDraftOwner } from "@/lib/drafts";
import { resetConnection } from "@/lib/connection";
import { FetchCall, jsonResponse, mockFetch } from "@/test/fetch-mock";
import { MarkdownEditor } from "./MarkdownEditor";
import { NoteEditor } from "./NoteEditor";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
}));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

const selfId = "0123456789abcdef0123456789abcdef";
const targetId = "fedcba9876543210fedcba9876543210";
const resourceId = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";

function renderControlledMarkdown(initial = "", html = false) {
  const state = { value: initial };
  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <MarkdownEditor
        value={value}
        html={html}
        noteId={selfId}
        onChange={(next) => {
          state.value = next;
          setValue(next);
        }}
      />
    );
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MarkdownEditorWrapper>
        <Harness />
      </MarkdownEditorWrapper>
    </QueryClientProvider>
  );
  return state;
}

function MarkdownEditorWrapper({ children }: { children: React.ReactNode }) {
  return <div style={{ height: "500px" }}>{children}</div>;
}

function cmView(): EditorView {
  return EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
}

beforeAll(() => {
  const empty = { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] } as unknown as DOMRectList;
  Range.prototype.getClientRects = () => empty;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Element.prototype.scrollIntoView = vi.fn();
  if (!("elementFromPoint" in document)) {
    Object.defineProperty(document, "elementFromPoint", {
      value: () => null,
      configurable: true,
    });
  }
});

beforeEach(() => {
  localStorage.clear();
  resetConnection();
  setDraftOwner(draftOwner("me@example.com", "notes.example.com"));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MarkdownEditor workspace slash commands & wiki-links", () => {
  it("opens slash commands menu on '/', filters commands, inserts callout block, and dismisses on Escape", async () => {
    const state = renderControlledMarkdown("");
    const view = cmView();

    view.dispatch({
      changes: { from: 0, to: 0, insert: "/" },
      selection: { anchor: 1 },
    });

    const listbox = await screen.findByRole("listbox", { name: "Slash commands" });
    expect(listbox).toBeTruthy();
    expect(screen.getByRole("option", { name: /Heading 1/ })).toBeTruthy();

    fireEvent.keyDown(document.querySelector(".cm-content")!, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Slash commands" })).toBeNull();

    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "/warning" },
      selection: { anchor: 8 },
    });
    const option = await screen.findByRole("option", { name: /Callout: Warning/ });
    fireEvent.click(option);

    expect(state.value).toBe("> [!WARNING]\n> ");
    expect(screen.queryByRole("listbox", { name: "Slash commands" })).toBeNull();
  });

  it("opens NoteLinkPicker when selecting 'Link to note' slash command", async () => {
    mockFetch((call) => {
      if (call.path.startsWith("/api/search")) {
        return jsonResponse([{ id: targetId, title: "Design Spec", preview: "", updatedTime: 1, createdTime: 1 }]);
      }
      return undefined;
    });

    const state = renderControlledMarkdown("");
    const view = cmView();
    view.dispatch({
      changes: { from: 0, to: 0, insert: "/link" },
      selection: { anchor: 5 },
    });

    fireEvent.click(await screen.findByRole("option", { name: /Link to note/ }));
    expect(await screen.findByRole("dialog", { name: "Link to note" })).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox", { name: "Search notes" }), { target: { value: "Design" } });
    fireEvent.click(await screen.findByRole("option", { name: /Design Spec/ }));
    expect(state.value).toBe(`[Design Spec](:/${targetId})`);
  });

  it("does not open slash or wiki popups for HTML notes", () => {
    renderControlledMarkdown("", true);
    const view = cmView();
    view.dispatch({ changes: { from: 0, to: 0, insert: "/" }, selection: { anchor: 1 } });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("shows wiki-link note suggestions on '[[' excluding the current note and inserts Joplin link", async () => {
    mockFetch((call) => {
      const url = new URL(call.path, "http://localhost");
      if (url.pathname === "/api/notes") {
        return jsonResponse([
          { id: selfId, title: "Self Note", preview: "", updatedTime: 1, createdTime: 1 },
          { id: targetId, title: "Target Architecture", preview: "", updatedTime: 1, createdTime: 1 },
        ]);
      }
      if (url.pathname === "/api/search") {
        return jsonResponse([
          { id: selfId, title: "Self Note", preview: "", updatedTime: 1, createdTime: 1 },
          { id: targetId, title: "Target Architecture", preview: "", updatedTime: 1, createdTime: 1 },
        ]);
      }
      return undefined;
    });

    const state = renderControlledMarkdown("See ");
    const view = cmView();
    view.dispatch({
      changes: { from: 4, to: 4, insert: "[[tar" },
      selection: { anchor: 9 },
    });

    const listbox = await screen.findByRole("listbox", { name: "Wiki-link note suggestions" });
    expect(listbox).toBeTruthy();
    const picked = await screen.findByRole("option", { name: "Target Architecture" });
    expect(screen.queryByRole("option", { name: "Self Note" })).toBeNull();

    fireEvent.click(picked);
    expect(state.value).toBe(`See [Target Architecture](:/${targetId})`);
  });
});

describe("NoteEditor Rich WYSIWYG mode", () => {
  const mdNote: Note = {
    id: selfId,
    title: "Rich Mode Note",
    body: `Hello world\n\n![diagram](:/${resourceId})`,
    updatedTime: 1000,
    createdTime: 500,
    parentId: "f".repeat(32),
    notebookId: "f".repeat(32),
    notebookTitle: "Work",
    tags: [],
    isTodo: false,
    todoCompleted: false,
    markupLanguage: 1,
  };

  it("offers Rich mode for Markdown notes, hides it for HTML notes, persists preference, and saves Joplin links", async () => {
    const calls = mockFetch((call: FetchCall) => {
      if (call.method === "PUT" && call.path === `/api/notes/${selfId}`) {
        return jsonResponse({ ...mdNote, ...(call.body as object), updatedTime: 2000 });
      }
      return undefined;
    });

    const onDone = vi.fn();
    const { rerender } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <NoteEditor note={mdNote} onDone={onDone} />
        </MemoryRouter>
      </QueryClientProvider>
    );

    const richBtn = screen.getByRole("button", { name: "Rich" });
    expect(richBtn).toBeTruthy();

    fireEvent.click(richBtn);
    expect(localStorage.getItem("joplin-editor-mode")).toBe("rich");

    const richBox = await waitFor(() => {
      const el = document.querySelector(".rich-editor-content");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(richBox.textContent).toContain("Hello world");

    // Trigger formatting via rich toolbar and append text via bold toolbar + Done
    fireEvent.click(screen.getByRole("button", { name: "Heading 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === `/api/notes/${selfId}`)).toBe(true));
    const saved = calls.find((c) => c.method === "PUT" && c.path === `/api/notes/${selfId}`)!.body as { body: string };
    expect(saved.body).toContain(`![diagram](:/${resourceId})`);

    // HTML note hides the Rich mode button
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <NoteEditor note={{ ...mdNote, id: targetId, markupLanguage: 2 }} onDone={onDone} />
        </MemoryRouter>
      </QueryClientProvider>
    );
    expect(screen.queryByRole("button", { name: "Rich" })).toBeNull();
  });
});
