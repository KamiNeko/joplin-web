import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Note } from "@/lib/types";
import { resetConnection } from "@/lib/connection";
import { draftOwner, setDraftOwner } from "@/lib/drafts";
import { jsonResponse, mockFetch } from "@/test/fetch-mock";
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

// The editor's retry scheduler is recorded instead of run (its timing is covered in retry.test.ts)
const schedule = vi.hoisted(() => vi.fn<(retryAfterMs?: number) => boolean>(() => true));
vi.mock("@/lib/retry", () => ({
  createRetryScheduler: () => ({ schedule, reset: () => undefined, dispose: () => undefined }),
}));

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

let saveResponse: () => Response;

/** Opens the editor, changes the body and saves right away (Ctrl+S) */
function editAndSave() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <NoteEditor note={note} onDone={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  fireEvent.change(screen.getByLabelText("Note body"), { target: { value: "Milk\nBread" } });
  fireEvent.keyDown(window, { key: "s", ctrlKey: true });
}

beforeEach(() => {
  localStorage.clear();
  resetConnection();
  setDraftOwner(draftOwner("me@example.com", "notes.example.com"));
  schedule.mockClear();
  mockFetch(({ method, path }) => (method === "PUT" && path === `/api/notes/${NOTE_ID}` ? saveResponse() : undefined));
});

afterEach(cleanup);

describe("NoteEditor save retries", () => {
  it("retries a rate-limited save, no sooner than Retry-After", async () => {
    saveResponse = () =>
      new Response(JSON.stringify({ error: "Too many requests from this IP, please try again later." }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "120" },
      });
    editAndSave();
    await waitFor(() => expect(schedule).toHaveBeenCalledWith(120000));
  });

  it("retries a save that failed with a server error", async () => {
    saveResponse = () => jsonResponse({ error: "Bad gateway" }, 502);
    editAndSave();
    await waitFor(() => expect(schedule).toHaveBeenCalledWith(undefined));
  });

  it("does not retry a rejected save", async () => {
    saveResponse = () => jsonResponse({ error: "Note is encrypted" }, 400);
    editAndSave();
    await waitFor(() => expect(screen.getAllByText(/save failed/i).length).toBeGreaterThan(0));
    expect(schedule).not.toHaveBeenCalled();
  });
});
