import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Note } from "@/lib/types";
import { resetConnection } from "@/lib/connection";
import { draftOwner, loadDraft, setDraftOwner } from "@/lib/drafts";
import { FetchCall, jsonResponse, mockFetch } from "@/test/fetch-mock";
import { WRITE_STATE_QUERY_KEY } from "@/hooks/use-write-state";
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
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

const NOTE_ID = "0123456789abcdef0123456789abcdef";
const note: Note = {
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
const REFUSAL = "This account uses end-to-end encryption. Joplin Web cannot encrypt data, so it is read-only here";

let calls: FetchCall[];

beforeEach(() => {
  localStorage.clear();
  resetConnection();
  setDraftOwner(draftOwner("me@example.com", "notes.example.com"));
  calls = mockFetch(({ method, path }) => {
    if (method === "PUT" && path === `/api/notes/${NOTE_ID}`) return jsonResponse({ error: REFUSAL, status: 422 }, 422);
    if (path === "/api/account/write-state") return jsonResponse({ writable: false, reason: REFUSAL });
    return undefined;
  });
});

afterEach(cleanup);

describe("NoteEditor save refused as read-only (422)", () => {
  it("shows the server's reason in the editor, keeps the text and re-checks the write state", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(WRITE_STATE_QUERY_KEY, { writable: true, reason: null });
    const onDone = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <NoteEditor note={note} onDone={onDone} />
        </MemoryRouter>
      </QueryClientProvider>
    );

    fireEvent.change(screen.getByLabelText("Note body"), { target: { value: "Milk\nBread" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(REFUSAL);
    expect(alert.textContent).toContain("Not saved.");
    expect(onDone).not.toHaveBeenCalled();
    expect(loadDraft(NOTE_ID)?.body).toBe("Milk\nBread");
    // A 422 is not a connection problem: no automatic retries
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    // The account may have turned read-only elsewhere: the write state is asked again
    await waitFor(() => expect(queryClient.getQueryState(WRITE_STATE_QUERY_KEY)?.isInvalidated).toBe(true));
  });
});
