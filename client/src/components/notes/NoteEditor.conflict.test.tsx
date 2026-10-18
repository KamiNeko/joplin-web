import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Note } from "@/lib/types";
import { resetConnection } from "@/lib/connection";
import { draftOwner, loadDraft, setDraftOwner } from "@/lib/drafts";
import { FetchCall, jsonResponse, mockFetch } from "@/test/fetch-mock";
import { NoteEditor } from "./NoteEditor";

// CodeMirror needs layout APIs jsdom lacks; a textarea stands in for it
vi.mock("./MarkdownEditor", async () => {
  const { forwardRef } = await import("react");
  return {
    UPLOAD_PLACEHOLDER: /$^/g,
    MarkdownEditor: forwardRef<unknown, { value: string; onChange: (v: string) => void }>(function MarkdownEditor(
      { value, onChange },
      ref
    ) {
      void ref;
      return <textarea aria-label="Note body" value={value} onChange={(e) => onChange(e.target.value)} />;
    }),
  };
});
// jsdom has no matchMedia; desktop width
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

const NOTE_ID = "0123456789abcdef0123456789abcdef";
const base: Note = {
  id: NOTE_ID,
  title: "Shopping",
  body: "Milk",
  updatedTime: 1000,
  createdTime: 500,
  parentId: "f".repeat(32),
  notebookId: "f".repeat(32),
  notebookTitle: "Personal",
  tags: [],
  isTodo: false,
  todoCompleted: false,
};
const theirs: Note = { ...base, title: "Shopping (phone)", body: "Milk\nEggs", updatedTime: 3000 };

let calls: FetchCall[];
let writeText: ReturnType<typeof vi.fn>;

const noteSaves = () => calls.filter((c) => c.method === "PUT" && c.path === `/api/notes/${NOTE_ID}`);

function renderEditor(onDone = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <NoteEditor note={base} onDone={onDone} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return onDone;
}

/** Edits the body and presses Done; the save hits a 409 */
async function editAndHitConflict() {
  fireEvent.change(screen.getByLabelText("Note body"), { target: { value: "Milk\nBread" } });
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  return screen.findByRole("dialog", { name: "This note was changed elsewhere" });
}

beforeEach(() => {
  localStorage.clear();
  resetConnection();
  setDraftOwner(draftOwner("me@example.com", "notes.example.com"));
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  calls = mockFetch(({ method, path, body }) => {
    if (method === "PUT" && path === `/api/notes/${NOTE_ID}`) {
      const changes = body as { force?: boolean; title: string; body: string };
      if (!changes.force) {
        return jsonResponse({ error: "Note was changed elsewhere", details: { current: theirs } }, 409);
      }
      return jsonResponse({ ...base, ...changes, updatedTime: 4000 });
    }
    return undefined;
  });
});

afterEach(cleanup);

describe("NoteEditor conflict dialog", () => {
  it("opens on a 409 and blocks Done", async () => {
    const onDone = renderEditor();
    await editAndHitConflict();

    expect(noteSaves()[0].body).toMatchObject({ body: "Milk\nBread", baseUpdatedTime: 1000, force: false });
    expect(onDone).not.toHaveBeenCalled();
    // The modal hides the rest of the page from the accessibility tree
    expect(screen.getByText("Done").closest("button")?.disabled).toBe(true);
    // The unsaved text is still on this device
    expect(loadDraft(NOTE_ID)?.body).toBe("Milk\nBread");
  });

  it('"Load their version" copies my text to the clipboard first, then shows theirs without saving', async () => {
    renderEditor();
    await editAndHitConflict();

    fireEvent.click(screen.getByRole("button", { name: "Load their version" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(writeText).toHaveBeenCalledWith("# Shopping\n\nMilk\nBread");
    expect((screen.getByLabelText("Note title") as HTMLInputElement).value).toBe("Shopping (phone)");
    expect((screen.getByLabelText("Note body") as HTMLTextAreaElement).value).toBe("Milk\nEggs");
    expect(noteSaves()).toHaveLength(1);
    expect(loadDraft(NOTE_ID)).toBeNull();
  });

  it('"Load their version" replaces the text only after the clipboard write finished', async () => {
    let finishCopy!: () => void;
    writeText.mockReturnValueOnce(new Promise<void>((resolve) => (finishCopy = resolve)));
    renderEditor();
    await editAndHitConflict();

    fireEvent.click(screen.getByRole("button", { name: "Load their version" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect((screen.getByLabelText("Note body", { selector: "textarea" }) as HTMLTextAreaElement).value).toBe(
      "Milk\nBread"
    );

    finishCopy();
    await waitFor(() =>
      expect((screen.getByLabelText("Note body") as HTMLTextAreaElement).value).toBe("Milk\nEggs")
    );
  });

  it('"Keep mine" saves again with force and closes the dialog', async () => {
    renderEditor();
    await editAndHitConflict();

    fireEvent.click(screen.getByRole("button", { name: "Keep mine (overwrite)" }));

    await waitFor(() => expect(noteSaves()).toHaveLength(2));
    expect(noteSaves()[1].body).toMatchObject({ title: "Shopping", body: "Milk\nBread", force: true });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(writeText).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Note body") as HTMLTextAreaElement).value).toBe("Milk\nBread");
    await waitFor(() => expect(loadDraft(NOTE_ID)).toBeNull());
  });

  it("after Keep mine, the next save is based on the overwritten version", async () => {
    renderEditor();
    await editAndHitConflict();
    fireEvent.click(screen.getByRole("button", { name: "Keep mine (overwrite)" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.change(screen.getByLabelText("Note body"), { target: { value: "Milk\nBread\nButter" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(noteSaves()).toHaveLength(3));
    expect(noteSaves()[2].body).toMatchObject({ baseUpdatedTime: 4000, force: false });
  });
});
