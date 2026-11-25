import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { toast } from "sonner";
import { Note, Notebook } from "@/lib/types";
import { draftOwner, setDraftOwner } from "@/lib/drafts";
import * as clipboard from "@/lib/clipboard";
import { FetchCall, jsonResponse, mockFetch } from "@/test/fetch-mock";
import { LocationProbe, renderWithProviders } from "@/test/render";
import { HomePage } from "./HomePage";
import { RecentPage } from "./RecentPage";
import { TasksPage } from "./TasksPage";
import { HygienePage } from "./HygienePage";
import { ClipPage } from "./ClipPage";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ email: "me@example.com", serverHost: "notes.example.com", logout: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
}));
vi.mock("@/components/notes/NoteEditor", () => ({
  NoteEditor: ({ note }: { note: Note }) => <div>Editing {note.id}</div>,
}));

const id = (c: string) => c.repeat(32);
const inboxNb: Notebook = { id: id("1"), title: "Inbox", parentId: "", children: [], noteCount: 2 };
const workNb: Notebook = { id: id("2"), title: "Work", parentId: "", children: [], noteCount: 3 };
const noteAId = id("a");
const noteBId = id("b");
const noteCId = id("c");

const sampleNoteA: Note = {
  id: noteAId,
  title: "Q4 Architecture Review",
  body: "# Overview\n\nDetailed review body.",
  updatedTime: 1_700_000_000_000,
  createdTime: 1_699_000_000_000,
  parentId: inboxNb.id,
  notebookId: inboxNb.id,
  notebookTitle: inboxNb.title,
  tags: [],
  isTodo: false,
  todoCompleted: false,
};

function mockBaseWorkspace(override?: (call: FetchCall) => Response | undefined) {
  return mockFetch((call) => {
    const custom = override?.(call);
    if (custom) return custom;
    const url = new URL(call.path, "http://localhost");
    if (url.pathname === "/api/notebooks") return jsonResponse([inboxNb, workNb]);
    if (url.pathname === "/api/tags") return jsonResponse([]);
    if (url.pathname === "/api/notes" && url.searchParams.get("conflict")) return jsonResponse([]);
    if (url.pathname === "/api/organize/status") return jsonResponse({ enabled: true, model: "deepseek-flash" });
    if (url.pathname === "/api/organize/jobs" && call.method === "GET") return jsonResponse({ jobs: [] });
    if (url.pathname === "/api/ai/status") return jsonResponse({ enabled: true, model: "deepseek-flash" });
    if (url.pathname === "/api/preferences" && call.method === "GET") {
      return jsonResponse({
        favoriteNoteIds: [noteAId],
        favoriteNotebookIds: [inboxNb.id],
        savedSearches: [{ id: "s1", name: "Unread", query: "tag:unread", createdAt: 1000 }],
        recentReads: [{ noteId: noteAId, readAt: 1_700_000_500_000 }],
        scratchpad: "Call Alice tomorrow",
        favoriteNotes: [
          {
            id: noteAId,
            title: sampleNoteA.title,
            preview: "Detailed review body.",
            updatedTime: sampleNoteA.updatedTime,
            createdTime: sampleNoteA.createdTime,
            parentId: inboxNb.id,
          },
        ],
        favoriteNotebooks: [{ id: inboxNb.id, title: inboxNb.title, parentId: "", noteCount: 2, encrypted: false }],
      });
    }
    return undefined;
  });
}

beforeEach(() => {
  localStorage.clear();
  setDraftOwner(draftOwner("me@example.com", "notes.example.com"));
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("min-width"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  );
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("HomePage", () => {
  it("renders shortcuts, recent lists, quick capture to Inbox, and scratchpad promote", async () => {
    let scratchpad = "Initial scratch line\nSecond detail";
    const calls = mockBaseWorkspace((call) => {
      if (call.method === "GET" && call.path === "/api/preferences") {
        return jsonResponse({
          favoriteNoteIds: [noteAId],
          favoriteNotebookIds: [inboxNb.id],
          savedSearches: [{ id: "s1", name: "Unread", query: "tag:unread", createdAt: 1000 }],
          recentReads: [{ noteId: noteAId, readAt: 1_700_000_500_000 }],
          scratchpad,
          favoriteNotes: [
            {
              id: noteAId,
              title: sampleNoteA.title,
              preview: "Detailed review body.",
              updatedTime: sampleNoteA.updatedTime,
              createdTime: sampleNoteA.createdTime,
              parentId: inboxNb.id,
            },
          ],
          favoriteNotebooks: [{ id: inboxNb.id, title: inboxNb.title, parentId: "", noteCount: 2, encrypted: false }],
        });
      }
      if (call.path === "/api/notes/recent") {
        return jsonResponse({
          recentRead: [{ id: noteAId, title: sampleNoteA.title, preview: "Read", updatedTime: 1000, createdTime: 900, readAt: 2000 }],
          recentCreated: [{ id: noteBId, title: "Fresh Note", preview: "New", updatedTime: 3000, createdTime: 3000 }],
        });
      }
      if (call.path === "/api/tasks") {
        return jsonResponse({
          todoNotes: [
            { id: noteCId, title: "Book venue", notebookTitle: "Work", todoCompleted: false, todoDue: 0, updatedTime: 1000 },
          ],
          inlineTasks: [],
        });
      }
      if (call.method === "POST" && call.path === "/api/notes") {
        const body = call.body as { title: string; body: string; parentId: string; isTodo?: boolean };
        return jsonResponse({ ...sampleNoteA, id: id("e"), title: body.title, body: body.body, parentId: body.parentId, isTodo: Boolean(body.isTodo) }, 201);
      }
      if (call.method === "PUT" && call.path === "/api/preferences/scratchpad") {
        scratchpad = (call.body as { scratchpad: string }).scratchpad;
        return jsonResponse({ scratchpad });
      }
      return undefined;
    });

    renderWithProviders(
      <>
        <Routes>
          <Route path="/home" element={<HomePage />} />
          <Route path="/notes/:id" element={<div>Note Route</div>} />
        </Routes>
        <LocationProbe />
      </>,
      { route: "/home" }
    );

    expect(await screen.findByRole("heading", { level: 1, name: "Workspace Home" })).toBeTruthy();
    expect(await screen.findByText("Open Tasks (1)")).toBeTruthy();
    expect(screen.getByText("Fresh Note")).toBeTruthy();
    expect(screen.getAllByText(sampleNoteA.title).length).toBeGreaterThanOrEqual(1);

    // Quick Capture picks Inbox by default and posts note
    const select = screen.getByLabelText("Capture target notebook") as HTMLSelectElement;
    expect(select.value).toBe(inboxNb.id);

    fireEvent.change(screen.getByLabelText("Quick capture title"), { target: { value: "Groceries" } });
    fireEvent.change(screen.getByLabelText("Quick capture body"), { target: { value: "- [ ] Milk" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as To-do" }));

    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/notes")).toBe(true));
    const createCall = calls.find((c) => c.method === "POST" && c.path === "/api/notes")!;
    expect(createCall.body).toEqual({
      parentId: inboxNb.id,
      title: "Groceries",
      body: "- [ ] Milk",
      isTodo: true,
    });

    // Save scratchpad manually then promote to note
    const scratchArea = screen.getByLabelText("Scratchpad") as HTMLTextAreaElement;
    expect(scratchArea.value).toContain("Initial scratch line");
    fireEvent.change(scratchArea, { target: { value: "# Promoted Heading\nLine two" } });
    fireEvent.click(screen.getByRole("button", { name: "Save now" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PUT" && c.path === "/api/preferences/scratchpad")).toBe(true)
    );

    fireEvent.click(screen.getByRole("button", { name: "Promote to Note" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe(`/notes/${id("e")}`));
  });
});

describe("RecentPage", () => {
  it("switches between Recently Read / Recently Created, filters notes, and records read after 500ms", async () => {
    const calls = mockBaseWorkspace((call) => {
      if (call.path === "/api/notes/recent") {
        return jsonResponse({
          recentRead: [
            { id: noteAId, title: sampleNoteA.title, preview: "Read summary", updatedTime: 1000, createdTime: 900, readAt: 5000 },
          ],
          recentCreated: [
            { id: noteBId, title: "Brand New Spec", preview: "Created spec", updatedTime: 6000, createdTime: 6000 },
          ],
        });
      }
      if (call.path === `/api/notes/${noteAId}` && call.method === "GET") {
        return jsonResponse(sampleNoteA);
      }
      if (call.method === "POST" && call.path === `/api/preferences/recent-reads/${noteAId}`) {
        return jsonResponse({ ok: true });
      }
      return undefined;
    });

    renderWithProviders(
      <>
        <Routes>
          <Route path="/recent" element={<RecentPage />} />
          <Route path="/recent/:id" element={<RecentPage />} />
        </Routes>
        <LocationProbe />
      </>,
      { route: "/recent" }
    );

    const main = screen.getByRole("main");
    expect(await within(main).findByText(sampleNoteA.title)).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Recently Created" }));
    expect(await within(main).findByText("Brand New Spec")).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe("/recent?tab=created");

    fireEvent.change(screen.getByLabelText("Filter recent notes"), { target: { value: "nonexistent" } });
    expect(screen.getByText("No matching recent notes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(within(main).getByText("Brand New Spec")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Recently Read" }));
    fireEvent.click(await within(main).findByRole("button", { name: new RegExp(sampleNoteA.title) }));
    expect(screen.getByTestId("location").textContent).toBe(`/recent/${noteAId}`);

    await waitFor(
      () =>
        expect(
          calls.some((c) => c.method === "POST" && c.path === `/api/preferences/recent-reads/${noteAId}`)
        ).toBe(true),
      { timeout: 1500 }
    );
  });
});

describe("TasksPage", () => {
  it("filters task tabs, toggles to-do & inline checklist items, and warns on 409 checklist conflict", async () => {
    const overdueTime = Date.now() - 24 * 60 * 60 * 1000;
    let triggerConflict = false;
    const calls = mockBaseWorkspace((call) => {
      if (call.path === "/api/tasks") {
        return jsonResponse({
          todoNotes: [
            { id: noteAId, title: "Renew cert", notebookTitle: "Work", todoCompleted: false, todoDue: overdueTime, updatedTime: 1000 },
            { id: noteBId, title: "Archived task", notebookTitle: "Inbox", todoCompleted: true, todoDue: 0, updatedTime: 900 },
          ],
          inlineTasks: [
            { noteId: noteCId, noteTitle: "Launch Plan", notebookTitle: "Work", text: "Verify DNS", line: 4, column: 0, checked: false, updatedTime: 2000 },
          ],
        });
      }
      if (call.method === "PUT" && call.path === `/api/notes/${noteAId}`) {
        return jsonResponse({ ...sampleNoteA, todoCompleted: (call.body as { todoCompleted: boolean }).todoCompleted });
      }
      if (call.method === "POST" && call.path === "/api/tasks/toggle") {
        if (triggerConflict) return jsonResponse({ error: "Changed elsewhere" }, 409);
        return jsonResponse({ ...sampleNoteA, id: noteCId, updatedTime: 3000 });
      }
      return undefined;
    });

    renderWithProviders(<TasksPage />, { route: "/tasks" });

    expect(await screen.findByText("Renew cert")).toBeTruthy();
    expect(screen.getByText("Verify DNS")).toBeTruthy();
    expect(screen.queryByText("Archived task")).toBeNull();

    // Check tab filtering
    fireEvent.click(screen.getByRole("button", { name: "Completed (1)" }));
    expect(screen.getByText("Archived task")).toBeTruthy();
    expect(screen.queryByText("Renew cert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Overdue (1)" }));
    expect(screen.getByText("Renew cert")).toBeTruthy();
    expect(screen.queryByText("Verify DNS")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open (2)" }));

    // Toggle to-do
    fireEvent.click(screen.getByRole("checkbox", { name: 'Toggle "Renew cert"' }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === `/api/notes/${noteAId}`)).toBe(true));

    // Toggle inline checklist cleanly, then simulate 409 conflict
    fireEvent.click(screen.getByRole("checkbox", { name: 'Toggle "Verify DNS"' }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/tasks/toggle")).toBe(true));

    triggerConflict = true;
    fireEvent.click(screen.getByRole("checkbox", { name: 'Toggle "Verify DNS"' }));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith("Checklist moved since this list loaded; refreshed.")
    );
  });
});

describe("HygienePage", () => {
  it("displays hygiene clusters, trashes duplicates & empty notes, and triggers Auto-organize for untagged notes", async () => {
    const calls = mockBaseWorkspace((call) => {
      if (call.path === "/api/organize/hygiene") {
        return jsonResponse({
          duplicateClusters: [
            {
              id: "cluster-1",
              reason: "exact-title",
              score: 1,
              notes: [
                {
                  id: noteAId,
                  title: "Meeting Notes",
                  notebookTitle: "Work",
                  preview: "Notes from Monday",
                  previewLength: 17,
                  updatedTime: 2000,
                },
                {
                  id: noteBId,
                  title: "Meeting Notes",
                  notebookTitle: "Inbox",
                  preview: "Old duplicate",
                  previewLength: 13,
                  updatedTime: 1000,
                },
              ],
            },
          ],
          emptyNotes: [{ id: noteCId, title: "Blank Scratch", notebookTitle: "Inbox", updatedTime: 500 }],
          untaggedNotes: [{ id: noteAId, title: "Meeting Notes", notebookTitle: "Work", updatedTime: 2000 }],
        });
      }
      if (call.method === "DELETE" && call.path === `/api/notes/${noteBId}`) {
        return jsonResponse(null, 204);
      }
      if (call.method === "POST" && call.path === "/api/notes/batch") {
        return jsonResponse([{ id: noteCId, ok: true }]);
      }
      if (call.method === "POST" && call.path === "/api/organize/jobs") {
        return jsonResponse({ jobId: "job-99" }, 201);
      }
      return undefined;
    });

    renderWithProviders(
      <>
        <Routes>
          <Route path="/hygiene" element={<HygienePage />} />
          <Route path="/organize/:jobId" element={<div>Job Page</div>} />
        </Routes>
        <LocationProbe />
      </>,
      { route: "/hygiene" }
    );

    expect(await screen.findByText("Possible Duplicates (1)")).toBeTruthy();
    expect(screen.getByText("Empty Notes (1)")).toBeTruthy();
    expect(screen.getByText("Untagged Notes (1)")).toBeTruthy();

    // Trash second duplicate
    const trashButtons = screen.getAllByRole("button", { name: "Move to trash" });
    fireEvent.click(trashButtons[1]);
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.path === `/api/notes/${noteBId}`)).toBe(true)
    );

    // Trash all empty notes
    fireEvent.click(screen.getByRole("button", { name: /Trash all empty \(1\)/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path === "/api/notes/batch")).toBe(true)
    );

    // Auto-organize untagged notes
    fireEvent.click(screen.getByRole("button", { name: "Auto-organize untagged" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path === "/api/organize/jobs")).toBe(true)
    );
    expect(screen.getByTestId("location").textContent).toBe("/organize/job-99");
  });
});

describe("ClipPage", () => {
  it("prefills shared URL/title/text, submits Web Clipper & Email/.eml import, and copies bookmarklet", async () => {
    const copySpy = vi.spyOn(clipboard, "copyText").mockResolvedValue(true);
    const calls = mockBaseWorkspace((call) => {
      if (call.method === "POST" && call.path === "/api/clip") {
        return jsonResponse({
          note: { ...sampleNoteA, id: id("c"), title: "Clipped Article" },
          extractedTitle: "Clipped Article",
        });
      }
      if (call.method === "POST" && call.path === "/api/integrations/email") {
        return jsonResponse({
          note: { ...sampleNoteA, id: id("d"), title: "Monthly Receipt" },
        });
      }
      return undefined;
    });

    renderWithProviders(<ClipPage />, {
      route: "/clip?url=https%3A%2F%2Fexample.com%2Fpost&title=Post%20Title",
    });

    const urlInput = (await screen.findByLabelText("Article URL")) as HTMLInputElement;
    expect(urlInput.value).toBe("https://example.com/post");

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(copySpy).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Clip to Note" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/clip")).toBe(true));
    expect(await screen.findByText("Clipped successfully")).toBeTruthy();

    // Switch to Email / .eml Import tab and submit Compose Fields
    fireEvent.click(screen.getByRole("tab", { name: /Email \/ \.eml Import/ }));
    fireEvent.click(screen.getByRole("button", { name: "Compose Fields" }));

    const subjectInput = screen.getByLabelText("Email subject") as HTMLInputElement;
    expect(subjectInput.value).toBe("Post Title");
    fireEvent.change(subjectInput, { target: { value: "Monthly Receipt" } });
    fireEvent.change(screen.getByLabelText("Email sender"), { target: { value: "billing@example.com" } });
    fireEvent.change(screen.getByLabelText("Email body"), { target: { value: "Amount paid: $15" } });
    fireEvent.click(screen.getByRole("button", { name: "Import Email as Note" }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path === "/api/integrations/email")).toBe(true)
    );
    const emailReq = calls.find((c) => c.method === "POST" && c.path === "/api/integrations/email")!;
    expect(within(document.body).getByText("Email imported")).toBeTruthy();
    expect(emailReq.body).toEqual({
      subject: "Monthly Receipt",
      from: "billing@example.com",
      text: "Amount paid: $15",
      parentId: inboxNb.id,
      tags: ["email"],
    });
  });
});
