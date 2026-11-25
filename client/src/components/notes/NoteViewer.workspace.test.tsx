import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { Note } from "@/lib/types";
import { draftOwner, setDraftOwner } from "@/lib/drafts";
import { FetchCall, jsonResponse, mockFetch } from "@/test/fetch-mock";
import { renderWithProviders } from "@/test/render";
import { NoteViewer } from "./NoteViewer";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const id = (c: string) => c.repeat(32);

const baseNote: Note = {
  id: id("1"),
  title: "Quarterly Architecture Plan",
  body: "# Overview\n\nInitial system summary with key milestones.\n\n## Next Steps\n\nShip tests.",
  updatedTime: 1_700_000_000_000,
  createdTime: 1_699_000_000_000,
  parentId: id("a"),
  notebookId: id("a"),
  notebookTitle: "Work",
  tags: [{ id: id("t"), title: "existing", noteCount: 1 }],
  isTodo: false,
  todoCompleted: false,
  properties: {
    author: "Jimmy",
    source_url: "https://example.com/spec",
  },
  backlinks: [
    {
      id: id("2"),
      title: "Team Sync",
      parentId: id("a"),
      updatedTime: 1_700_000_100_000,
      snippet: "Referenced Quarterly Architecture Plan for Q4",
    },
  ],
};

function makePrefs(favoriteNoteIds: string[] = []) {
  return {
    favoriteNoteIds,
    favoriteNotebookIds: [],
    savedSearches: [],
    recentReads: [],
    scratchpad: "",
    favoriteNotes: [],
    favoriteNotebooks: [],
  };
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
  setDraftOwner(draftOwner("me@example.com", "notes.example.com"));
  if (typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("NoteViewer workspace panels & actions", () => {
  it("toggles shortcut star, shows backlinks, expands sanitized properties, and scrolls outline headings", async () => {
    let favs: string[] = [];
    const calls = mockFetch((call: FetchCall) => {
      if (call.method === "GET" && call.path === "/api/preferences") return jsonResponse(makePrefs(favs));
      if (call.method === "POST" && call.path === `/api/preferences/favorites/notes/${baseNote.id}`) {
        favs = [baseNote.id];
        return jsonResponse(makePrefs(favs));
      }
      if (call.method === "DELETE" && call.path === `/api/preferences/favorites/notes/${baseNote.id}`) {
        favs = [];
        return jsonResponse(makePrefs(favs));
      }
      if (call.path === "/api/ai/status") return jsonResponse({ enabled: false });
      return undefined;
    });

    const onOpenNote = vi.fn();
    renderWithProviders(<NoteViewer note={baseNote} onOpenNote={onOpenNote} />);

    // Favorite toggle
    const starBtn = await screen.findByRole("button", { name: "Add to shortcuts" });
    fireEvent.click(starBtn);
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path === `/api/preferences/favorites/notes/${baseNote.id}`)).toBe(true)
    );
    expect(await screen.findByRole("button", { name: "Remove from shortcuts" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove from shortcuts" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.path === `/api/preferences/favorites/notes/${baseNote.id}`)).toBe(true)
    );

    // Properties panel (word stats + author + safe source_url)
    fireEvent.click(screen.getByRole("button", { name: /Properties/i }));
    expect(screen.getByText(baseNote.id)).toBeTruthy();
    expect(screen.getByText("Jimmy")).toBeTruthy();
    const link = screen.getByRole("link", { name: "https://example.com/spec" }) as HTMLAnchorElement;
    expect(link.href).toBe("https://example.com/spec");

    // Outline popover
    const scrollSpy = vi.fn();
    const h2 = screen.getByRole("heading", { level: 2, name: "Next Steps" });
    h2.scrollIntoView = scrollSpy;
    fireEvent.click(screen.getByRole("button", { name: "Document outline" }));
    fireEvent.click(await screen.findByRole("button", { name: "Next Steps" }));
    expect(scrollSpy).toHaveBeenCalled();

    // Backlinks navigation
    const backlinks = screen.getByRole("region", { name: "Backlinks" });
    fireEvent.click(within(backlinks).getByRole("button", { name: /Team Sync/ }));
    expect(onOpenNote).toHaveBeenCalledWith(id("2"));
  });

  it("drops unsafe non-http source_url values in Properties", () => {
    mockFetch((call) => {
      if (call.path === "/api/preferences") return jsonResponse(makePrefs());
      if (call.path === "/api/ai/status") return jsonResponse({ enabled: false });
      return undefined;
    });
    renderWithProviders(
      <NoteViewer note={{ ...baseNote, properties: { source_url: "javascript:alert(1)" } }} />
    );

    fireEvent.click(screen.getByRole("button", { name: /Properties/i }));
    expect(screen.queryByRole("link", { name: /javascript:/ })).toBeNull();
  });

  it("opens Attachments & OCR drawer and toggles extracted OCR text", async () => {
    const audioId = id("9");
    mockFetch((call) => {
      if (call.path === "/api/preferences") return jsonResponse(makePrefs());
      if (call.path === "/api/ai/status") return jsonResponse({ enabled: false });
      if (call.path === `/api/notes/${baseNote.id}/attachments`) {
        return jsonResponse([
          {
            id: audioId,
            title: "receipt.pdf",
            mime: "application/pdf",
            filename: "receipt.pdf",
            fileExtension: "pdf",
            size: 2048,
            updatedTime: 1000,
            ocrText: "Invoice Total: $42.50",
            kind: "pdf",
          },
          {
            id: id("8"),
            title: "memo.webm",
            mime: "audio/webm",
            filename: "memo.webm",
            fileExtension: "webm",
            size: 1024,
            updatedTime: 1000,
            ocrText: "",
            kind: "audio",
          },
        ]);
      }
      return undefined;
    });

    renderWithProviders(<NoteViewer note={baseNote} />);
    fireEvent.click(screen.getByRole("button", { name: "Attachments" }));

    expect(await screen.findByText("Attachments & OCR (2)")).toBeTruthy();
    expect(screen.getByText("receipt.pdf")).toBeTruthy();
    expect(document.querySelector("audio")?.getAttribute("src")).toBe(`/api/resources/${id("8")}`);

    fireEvent.click(screen.getByRole("button", { name: "Show OCR text" }));
    expect(await screen.findByText("Invoice Total: $42.50")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide OCR text" }));
    expect(screen.queryByText("Invoice Total: $42.50")).toBeNull();
  });

  it("opens Version History drawer, previews diff, and restores selected revision", async () => {
    const revId = id("7");
    const calls = mockFetch((call) => {
      if (call.path === "/api/preferences") return jsonResponse(makePrefs());
      if (call.path === "/api/ai/status") return jsonResponse({ enabled: false });
      if (call.path === `/api/notes/${baseNote.id}/revisions`) {
        return jsonResponse([
          { id: revId, itemId: baseNote.id, titleUpdatedTime: 1000, updatedTime: 1_699_500_000_000, createdTime: 1_699_000_000_000 },
        ]);
      }
      if (call.path === `/api/notes/${baseNote.id}/revisions/${revId}`) {
        return jsonResponse({
          id: revId,
          itemId: baseNote.id,
          title: baseNote.title,
          body: "# Overview\n\nOlder paragraph before rewrite.",
          updatedTime: 1_699_500_000_000,
          createdTime: 1_699_000_000_000,
        });
      }
      if (call.method === "POST" && call.path === `/api/notes/${baseNote.id}/revisions/${revId}/restore`) {
        return jsonResponse({ ...baseNote, body: "# Overview\n\nOlder paragraph before rewrite." });
      }
      return undefined;
    });

    renderWithProviders(<NoteViewer note={baseNote} />);
    fireEvent.click(screen.getByRole("button", { name: "Version history" }));

    expect(await screen.findByText("Changes vs current note")).toBeTruthy();
    expect(screen.getByText(/\+ rev: Older paragraph before rewrite\./)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path === `/api/notes/${baseNote.id}/revisions/${revId}/restore`)).toBe(true)
    );
    expect(toast.success).toHaveBeenCalledWith("Note restored to selected revision");
  });

  it("runs AI Note Assist actions to append summary and apply suggested tags", async () => {
    const calls = mockFetch((call) => {
      if (call.path === "/api/preferences") return jsonResponse(makePrefs());
      if (call.path === "/api/ai/status") return jsonResponse({ enabled: true, model: "deepseek-flash" });
      if (call.method === "POST" && call.path === "/api/ai/note-assist") {
        const body = call.body as { action: string };
        if (body.action === "summarize") {
          return jsonResponse({ result: "- Concise bullet summary" });
        }
        return jsonResponse({ result: "Suggested: existing, roadmap", tags: ["existing", "roadmap"] });
      }
      if (call.method === "PUT" && call.path === `/api/notes/${baseNote.id}`) {
        return jsonResponse({ ...baseNote, body: (call.body as { body: string }).body });
      }
      if (call.method === "POST" && call.path === `/api/notes/${baseNote.id}/tags`) {
        return jsonResponse({ id: id("e"), title: "roadmap" });
      }
      return undefined;
    });

    renderWithProviders(<NoteViewer note={baseNote} />);
    const aiTrigger = await screen.findByRole("button", { name: "AI Note Assist" });

    fireEvent.keyDown(aiTrigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Summarize note" }));

    expect(await screen.findByText("- Concise bullet summary")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Append to note" }));

    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === `/api/notes/${baseNote.id}`)).toBe(true));
    const put = calls.find((c) => c.method === "PUT" && c.path === `/api/notes/${baseNote.id}`)!;
    expect((put.body as { body: string }).body).toContain("## Summary\n\n- Concise bullet summary");

    // Suggest tags only adds missing tags ("roadmap", skipping "existing")
    fireEvent.keyDown(aiTrigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Suggest tags" }));
    expect(await screen.findByRole("button", { name: "Apply tags" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply tags" }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path === `/api/notes/${baseNote.id}/tags`)).toBe(true)
    );
    const tagCalls = calls.filter((c) => c.method === "POST" && c.path === `/api/notes/${baseNote.id}/tags`);
    expect(tagCalls).toHaveLength(1);
    expect(tagCalls[0].body).toEqual({ title: "roadmap" });
  });

  it("shows OCR pending, failed retry, and manual Run OCR actions in AttachmentsDrawer", async () => {
    const imgPendingId = id("5");
    const imgFailedId = id("6");
    let retried = false;
    const calls = mockFetch((call) => {
      if (call.path === "/api/preferences") return jsonResponse(makePrefs());
      if (call.path === "/api/ai/status") return jsonResponse({ enabled: false });
      if (call.path === `/api/notes/${baseNote.id}/attachments` && call.method === "GET") {
        return jsonResponse([
          {
            id: imgPendingId,
            title: "scanning.png",
            mime: "image/png",
            filename: "scanning.png",
            fileExtension: "png",
            size: 1500,
            updatedTime: 1000,
            ocrText: "",
            ocrStatus: "pending",
            kind: "image",
          },
          {
            id: imgFailedId,
            title: "receipt.jpg",
            mime: "image/jpeg",
            filename: "receipt.jpg",
            fileExtension: "jpg",
            size: 2048,
            updatedTime: 1000,
            ocrText: retried ? "Total $19.95" : "",
            ocrStatus: retried ? "done" : "failed",
            kind: "image",
          },
        ]);
      }
      if (call.method === "POST" && call.path === `/api/resources/${imgFailedId}/ocr`) {
        retried = true;
        return jsonResponse({ id: imgFailedId, ocrStatus: "done", ocrText: "Total $19.95" });
      }
      return undefined;
    });

    renderWithProviders(<NoteViewer note={baseNote} />);
    fireEvent.click(screen.getByRole("button", { name: "Attachments" }));

    expect(await screen.findByText("OCR Pending")).toBeTruthy();
    expect(screen.getByText("OCR Failed")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry OCR" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path === `/api/resources/${imgFailedId}/ocr`)).toBe(true)
    );
    expect(await screen.findByRole("button", { name: "Show OCR text" })).toBeTruthy();
  });

  it("opens editor on prose body click while ignoring links, details toggles, non-collapsed selections, and locked states", async () => {
    const richBodyNote: Note = {
      ...baseNote,
      body: [
        "Click this paragraph to edit.",
        "",
        `See [External Link](https://example.com) or [Wiki Note](:/${id("2")})`,
        "",
        "<details><summary>Toggle Section</summary>\n\nInside details\n\n</details>",
      ].join("\n"),
    };

    mockFetch((call) => {
      if (call.path === "/api/preferences") return jsonResponse(makePrefs());
      if (call.path === "/api/ai/status") return jsonResponse({ enabled: false });
      return undefined;
    });

    const onOpenNote = vi.fn();
    renderWithProviders(<NoteViewer note={richBodyNote} onOpenNote={onOpenNote} />);

    // 1. Clicking an external link does not enter edit mode
    fireEvent.click(screen.getByRole("link", { name: "External Link" }));
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();

    // 2. Clicking a summary toggle inside <details> does not enter edit mode
    fireEvent.click(screen.getByText("Toggle Section"));
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();

    // 3. Non-collapsed text selection suppresses click-to-edit
    const getSelSpy = vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      toString: () => "paragraph",
    } as unknown as Selection);
    fireEvent.click(screen.getByText("Click this paragraph to edit."));
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    getSelSpy.mockRestore();

    // 4. Read-only note ignores click-to-edit
    cleanup();
    renderWithProviders(<NoteViewer note={richBodyNote} readOnly />);
    fireEvent.click(screen.getByText("Click this paragraph to edit."));
    expect(screen.queryByLabelText("Note title")).toBeNull();

    // 5. Writable collapsed click on prose body enters edit mode
    cleanup();
    renderWithProviders(<NoteViewer note={richBodyNote} />);
    fireEvent.click(screen.getByText("Click this paragraph to edit."));
    expect(await screen.findByLabelText("Note title")).toBeTruthy();
  });
});
