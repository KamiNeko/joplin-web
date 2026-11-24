import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { toast } from "sonner";
import { Notebook, OrganizeJobResponse, OrganizeJobSummary, Tag } from "@/lib/types";
import { jsonResponse, mockFetch } from "@/test/fetch-mock";
import { LocationProbe, renderWithProviders } from "@/test/render";
import { OrganizePage } from "./OrganizePage";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ email: "me@example.com", serverHost: "notes.example.com", logout: vi.fn() }),
}));

const id = (c: string) => c.repeat(32);

const notebooks: Notebook[] = [
  { id: id("1"), title: "Pending to sort", parentId: "", children: [], noteCount: 2 },
  {
    id: id("2"),
    title: "Personal",
    parentId: "",
    children: [{ id: id("3"), title: "Bank", parentId: id("2"), children: [], noteCount: 4 }],
    noteCount: 1,
  },
  { id: id("4"), title: "Projects", parentId: "", children: [], noteCount: 3 },
  { id: id("5"), title: "Secret Vault", parentId: "", children: [], noteCount: 1, encrypted: true },
];

const tags: Tag[] = [
  { id: id("a"), title: "invoice", noteCount: 4 },
  { id: id("b"), title: "bank", noteCount: 2 },
  { id: id("c"), title: "ideas", noteCount: 5 },
];

function makeJob(overrides: Partial<OrganizeJobResponse> = {}): OrganizeJobResponse {
  return {
    id: "job1234567890abcdef1234567890ab",
    status: "done",
    excludeNotebookIds: [id("1")],
    progress: { total: 3, done: 2, failed: 1 },
    usage: { promptTokens: 410, completionTokens: 95, totalTokens: 505 },
    offset: 0,
    limit: 200,
    totalItems: 3,
    canUndo: false,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_005_000,
    items: [
      {
        noteId: id("d"),
        currentTitle: "2024_03_11.pdf",
        currentNotebookId: id("1"),
        currentNotebookPath: "Pending to sort",
        updatedTime: 1001,
        status: "done",
        suggestion: {
          title: "2024-03-11 HSBC – Monthly Bank Statement",
          notebookId: id("3"),
          tags: ["bank", "statement"],
          confidence: 0.94,
          documentDate: "2024-03-11",
          reason: "OCR contains HSBC statement header for March 2024.",
        },
      },
      {
        noteId: id("e"),
        currentTitle: "Loose scratchpad",
        currentNotebookId: id("1"),
        currentNotebookPath: "Pending to sort",
        updatedTime: 1002,
        status: "done",
        suggestion: {
          title: "Loose scratchpad",
          notebookId: id("4"),
          tags: ["ideas"],
          confidence: 0.52,
          documentDate: null,
          reason: "Short note with ambiguous destination.",
        },
      },
      {
        noteId: id("f"),
        currentTitle: "Encrypted scan",
        currentNotebookId: id("1"),
        currentNotebookPath: "Pending to sort",
        updatedTime: 1003,
        status: "failed",
        error: "Encrypted notes cannot be read or organized",
      },
    ],
    ...overrides,
  };
}

function stubMatchMedia(isDesktop: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("min-width") ? isDesktop : !isDesktop,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  );
}

function renderOrganizePage(route = "/organize/job1234567890abcdef1234567890ab") {
  return renderWithProviders(
    <>
      <Routes>
        <Route path="/organize" element={<OrganizePage />} />
        <Route path="/organize/:jobId" element={<OrganizePage />} />
        <Route path="/notebooks/:notebookId/notes/:id" element={<div>Opened note route</div>} />
      </Routes>
      <LocationProbe />
    </>,
    { route: route.startsWith("/") ? route : `/organize/${route}` }
  );
}

beforeEach(() => {
  stubMatchMedia(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("OrganizePage", () => {
  it("renders suggestions table, defaults low-confidence unticked, supports inline editing, filters, apply and undo", async () => {
    const successSpy = vi.spyOn(toast, "success").mockReturnValue("t1");
    const warningSpy = vi.spyOn(toast, "warning").mockReturnValue("t2");

    let jobState = makeJob();
    const calls = mockFetch((call) => {
      const url = new URL(call.path, "http://localhost");
      if (url.pathname === "/api/notebooks") return jsonResponse(notebooks);
      if (url.pathname === "/api/tags") return jsonResponse(tags);
      if (url.pathname === `/api/organize/jobs/${jobState.id}` && call.method === "GET") {
        return jsonResponse(jobState);
      }
      if (url.pathname === `/api/organize/jobs/${jobState.id}/apply` && call.method === "POST") {
        jobState = makeJob({
          canUndo: true,
          items: [
            {
              ...jobState.items[0],
              applied: true,
              applyStatus: "ok",
              updatedTime: 2001,
            },
            {
              ...jobState.items[1],
              applyStatus: "conflict",
              applyError: "The note was changed elsewhere since you opened it",
            },
            jobState.items[2],
          ],
        });
        return jsonResponse({
          results: [
            { id: id("d"), status: "ok", updatedTime: 2001, addedTags: ["invoice"] },
            { id: id("e"), status: "conflict", error: "The note was changed elsewhere since you opened it" },
          ],
          appliedCount: 1,
          conflictCount: 1,
          errorCount: 0,
          canUndo: true,
        });
      }
      if (url.pathname === `/api/organize/jobs/${jobState.id}/undo` && call.method === "POST") {
        jobState = makeJob({ canUndo: false });
        return jsonResponse({
          results: [{ id: id("d"), status: "ok", updatedTime: 3001 }],
          revertedCount: 1,
          conflictCount: 0,
          errorCount: 0,
          canUndo: false,
        });
      }
      return undefined;
    });

    renderOrganizePage();

    expect(await screen.findByText("Analysed 3 / 3 (1 failed)")).toBeTruthy();
    expect(screen.getByText(/505 tokens/)).toBeTruthy();

    const table = screen.getByRole("table", { name: "Organize suggestions" });
    const row1Box = within(table).getByRole("checkbox", { name: "Select 2024_03_11.pdf" }) as HTMLInputElement;
    const row2Box = within(table).getByRole("checkbox", { name: "Select Loose scratchpad" }) as HTMLInputElement;
    const row3Box = within(table).getByRole("checkbox", { name: "Select Encrypted scan" }) as HTMLInputElement;

    expect(row1Box.checked).toBe(true);
    expect(row2Box.checked).toBe(false); // < 0.7 starts unticked
    expect(row3Box.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Apply selected (1)" })).toBeTruthy();

    // Filter to High confidence and back to All
    fireEvent.click(screen.getByRole("button", { name: "High confidence (1)" }));
    expect(within(table).queryByDisplayValue("Loose scratchpad")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All (3)" }));
    expect(within(table).getByDisplayValue("Loose scratchpad")).toBeTruthy();

    // Edit row 1 title, change notebook via picker (verifying excluded notebook omitted), remove & add tag
    const titleInput = screen.getByLabelText("Suggested title for 2024_03_11.pdf");
    fireEvent.change(titleInput, { target: { value: "2024-03-11 HSBC – Statement Edited" } });

    fireEvent.click(screen.getByRole("button", { name: "Target notebook for 2024_03_11.pdf" }));
    const pickerList = await screen.findByRole("list", { name: "Destination" });
    expect(within(pickerList).queryByText("Pending to sort")).toBeNull();
    expect(within(pickerList).queryByText("Secret Vault")).toBeNull();
    fireEvent.click(within(pickerList).getByRole("button", { name: "Projects" }));

    fireEvent.click(screen.getByRole("button", { name: "Remove tag statement from 2024_03_11.pdf" }));
    fireEvent.click(screen.getByRole("button", { name: "Add tag to 2024_03_11.pdf" }));
    const tagInput = await screen.findByLabelText("Add tag");
    fireEvent.change(tagInput, { target: { value: "inv" } });
    fireEvent.keyDown(tagInput, { key: "ArrowDown" });
    fireEvent.keyDown(tagInput, { key: "Enter" });

    // Also tick row 2 manually (re-queried since filter toggle remounted rows) to test conflict reporting + Undo
    fireEvent.click(within(table).getByRole("checkbox", { name: "Select Loose scratchpad" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply selected (2)" }));

    await waitFor(() => expect(warningSpy).toHaveBeenCalled());
    const [warnMsg, warnOpts] = warningSpy.mock.calls[0];
    expect(warnMsg).toBe("Applied changes to 1 note (1 conflict)");

    const applyPost = calls.find((c) => c.path.endsWith("/apply") && c.method === "POST")!;
    expect(applyPost.body).toEqual({
      items: [
        {
          noteId: id("d"),
          title: "2024-03-11 HSBC – Statement Edited",
          notebookId: id("4"),
          addTags: ["bank", "invoice"],
          baseUpdatedTime: 1001,
        },
        {
          noteId: id("e"),
          title: "Loose scratchpad",
          notebookId: id("4"),
          addTags: ["ideas"],
          baseUpdatedTime: 1002,
        },
      ],
    });

    // Click Undo on the toast
    const undoAction = warnOpts?.action as { label: string; onClick: () => void };
    expect(undoAction.label).toBe("Undo");
    undoAction.onClick();

    await waitFor(() => expect(successSpy).toHaveBeenCalledWith("Reverted 1 note"));
    expect(calls.some((c) => c.path.endsWith("/undo") && c.method === "POST")).toBe(true);
  }, 15_000);

  it("renders stacked card layout on narrow screens and cancels running jobs", async () => {
    stubMatchMedia(false);
    const infoSpy = vi.spyOn(toast, "info").mockReturnValue("t-info");

    let jobState = makeJob({
      status: "running",
      progress: { total: 3, done: 1, failed: 0 },
      items: [
        makeJob().items[0],
        {
          noteId: id("e"),
          currentTitle: "Pending receipt",
          currentNotebookId: id("1"),
          currentNotebookPath: "Pending to sort",
          updatedTime: 1002,
          status: "pending",
        },
      ],
      totalItems: 2,
    });

    const calls = mockFetch((call) => {
      const url = new URL(call.path, "http://localhost");
      if (url.pathname === "/api/notebooks") return jsonResponse(notebooks);
      if (url.pathname === "/api/tags") return jsonResponse(tags);
      if (url.pathname === `/api/organize/jobs/${jobState.id}` && call.method === "GET") {
        return jsonResponse(jobState);
      }
      if (url.pathname === `/api/organize/jobs/${jobState.id}` && call.method === "DELETE") {
        jobState = { ...jobState, status: "cancelled" };
        return jsonResponse({ id: jobState.id, status: "cancelled" });
      }
      return undefined;
    });

    renderOrganizePage();

    expect(await screen.findByText("Analysed 1 / 3")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Organize suggestions" })).toBeNull();
    // Single checkbox per card in DOM
    expect(screen.getAllByRole("checkbox", { name: /^Select / })).toHaveLength(2);
    expect(screen.getByText("Pending receipt")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(infoSpy).toHaveBeenCalledWith("Auto-organize cancelled"));
    expect(calls.some((c) => c.method === "DELETE" && c.path === `/api/organize/jobs/${jobState.id}`)).toBe(true);
  });

  it("filters Very high (>= 0.85), keeps >= 0.7 pre-ticked, and switches selection with Select all very-high", async () => {
    const jobState = makeJob({
      progress: { total: 3, done: 3, failed: 0 },
      items: [
        {
          ...makeJob().items[0],
          noteId: id("d"),
          currentTitle: "Very High Note",
          suggestion: {
            title: "2024-03-11 HSBC – Statement",
            notebookId: id("3"),
            tags: ["statement"],
            confidence: 0.92,
            documentDate: "2024-03-11",
            reason: "Clear match.",
          },
        },
        {
          noteId: id("e"),
          currentTitle: "Moderate High Note",
          currentNotebookId: id("1"),
          currentNotebookPath: "Pending to sort",
          updatedTime: 1002,
          status: "done",
          suggestion: {
            title: "2024-03-12 Draft – Notes",
            notebookId: id("4"),
            tags: ["other"],
            confidence: 0.74,
            documentDate: "2024-03-12",
            reason: "Probable match.",
          },
        },
        {
          ...makeJob().items[1],
          noteId: id("g"),
          currentTitle: "Low Note",
          suggestion: {
            title: "Low Note",
            notebookId: id("4"),
            tags: ["ideas"],
            confidence: 0.51,
            documentDate: null,
            reason: "Uncertain.",
          },
        },
      ],
    });

    mockFetch((call) => {
      const url = new URL(call.path, "http://localhost");
      if (url.pathname === "/api/notebooks") return jsonResponse(notebooks);
      if (url.pathname === "/api/tags") return jsonResponse(tags);
      if (url.pathname === `/api/organize/jobs/${jobState.id}` && call.method === "GET") {
        return jsonResponse(jobState);
      }
      return undefined;
    });

    renderOrganizePage();

    const table = await screen.findByRole("table", { name: "Organize suggestions" });
    expect(screen.getByText("Very high 92%")).toBeTruthy();
    expect(screen.getByText("High 74%")).toBeTruthy();
    expect(screen.getByText("Low 51%")).toBeTruthy();

    // >= 0.7 starts ticked (0.92 and 0.74)
    expect((within(table).getByRole("checkbox", { name: "Select Very High Note" }) as HTMLInputElement).checked).toBe(
      true
    );
    expect(
      (within(table).getByRole("checkbox", { name: "Select Moderate High Note" }) as HTMLInputElement).checked
    ).toBe(true);
    expect((within(table).getByRole("checkbox", { name: "Select Low Note" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("button", { name: "Apply selected (2)" })).toBeTruthy();

    // "Select all very-high" narrows selection exclusively to >= 0.85
    fireEvent.click(screen.getByRole("button", { name: "Select all very-high" }));
    expect((within(table).getByRole("checkbox", { name: "Select Very High Note" }) as HTMLInputElement).checked).toBe(
      true
    );
    expect(
      (within(table).getByRole("checkbox", { name: "Select Moderate High Note" }) as HTMLInputElement).checked
    ).toBe(false);
    expect(screen.getByRole("button", { name: "Apply selected (1)" })).toBeTruthy();

    // Filter to Very high (>= 0.85)
    fireEvent.click(screen.getByRole("button", { name: "Very high (>= 0.85) (1)" }));
    expect(within(table).getByDisplayValue("2024-03-11 HSBC – Statement")).toBeTruthy();
    expect(within(table).queryByDisplayValue("2024-03-12 Draft – Notes")).toBeNull();
    expect(within(table).queryByDisplayValue("Low Note")).toBeNull();
  });

  it("shows Retry failed (N) excluding skipped items and triggers POST /retry", async () => {
    const successSpy = vi.spyOn(toast, "success").mockReturnValue("t-retry");

    let jobState = makeJob({
      progress: { total: 3, done: 1, failed: 2 },
      retryableFailedCount: 1,
      items: [
        makeJob().items[0],
        {
          noteId: id("e"),
          currentTitle: "Timed out invoice",
          currentNotebookId: id("1"),
          currentNotebookPath: "Pending to sort",
          updatedTime: 1002,
          status: "failed",
          error: "AI provider returned HTTP 503",
        },
        {
          noteId: id("f"),
          currentTitle: "Duplicate scanned copy",
          currentNotebookId: id("1"),
          currentNotebookPath: "Pending to sort",
          updatedTime: 1003,
          status: "failed",
          skipped: true,
          error: "Duplicate copy (trashed)",
        },
      ],
    });

    const calls = mockFetch((call) => {
      const url = new URL(call.path, "http://localhost");
      if (url.pathname === "/api/notebooks") return jsonResponse(notebooks);
      if (url.pathname === "/api/tags") return jsonResponse(tags);
      if (url.pathname === `/api/organize/jobs/${jobState.id}` && call.method === "GET") {
        return jsonResponse(jobState);
      }
      if (url.pathname === `/api/organize/jobs/${jobState.id}/retry` && call.method === "POST") {
        jobState = makeJob({
          ...jobState,
          status: "running",
          progress: { total: 3, done: 1, failed: 1 },
          retryableFailedCount: 0,
          items: [
            jobState.items[0],
            { ...jobState.items[1], status: "pending", error: undefined },
            jobState.items[2],
          ],
        });
        return jsonResponse({ id: jobState.id, status: "running", requeuedCount: 1 });
      }
      return undefined;
    });

    renderOrganizePage();

    const retryBtn = await screen.findByRole("button", { name: "Retry failed (1)" });
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Skipped")).toBeTruthy();

    fireEvent.click(retryBtn);

    await waitFor(() => expect(successSpy).toHaveBeenCalledWith("Retrying 1 failed note"));
    expect(calls.some((c) => c.method === "POST" && c.path === `/api/organize/jobs/${jobState.id}/retry`)).toBe(true);
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Retry failed/ })).toBeNull());
  });

  it("lists jobs on /organize newest first and supports Cancel and Delete with confirmation", async () => {
    const successSpy = vi.spyOn(toast, "success").mockReturnValue("t-del");
    const infoSpy = vi.spyOn(toast, "info").mockReturnValue("t-cancel");

    let jobsList: OrganizeJobSummary[] = [
      {
        id: "22222222222222222222222222222222",
        status: "running",
        progress: { total: 10, done: 4, failed: 0 },
        appliedCount: 0,
        usage: { promptTokens: 200, completionTokens: 50, totalTokens: 250 },
        canUndo: false,
        createdAt: 1_700_000_020_000,
        updatedAt: 1_700_000_025_000,
      },
      {
        id: "11111111111111111111111111111111",
        status: "done",
        progress: { total: 5, done: 5, failed: 0 },
        appliedCount: 3,
        usage: { promptTokens: 500, completionTokens: 120, totalTokens: 620 },
        canUndo: true,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_005_000,
      },
    ];

    const calls = mockFetch((call) => {
      const url = new URL(call.path, "http://localhost");
      if (url.pathname === "/api/notebooks") return jsonResponse(notebooks);
      if (url.pathname === "/api/tags") return jsonResponse(tags);
      if (url.pathname === "/api/organize/jobs" && call.method === "GET") {
        return jsonResponse({ jobs: jobsList });
      }
      if (
        url.pathname === "/api/organize/jobs/22222222222222222222222222222222" &&
        call.method === "DELETE" &&
        !url.searchParams.get("remove")
      ) {
        jobsList = jobsList.map((j) =>
          j.id === "22222222222222222222222222222222" ? { ...j, status: "cancelled" as const } : j
        );
        return jsonResponse({ id: "22222222222222222222222222222222", status: "cancelled" });
      }
      if (
        url.pathname === "/api/organize/jobs/11111111111111111111111111111111" &&
        call.method === "DELETE" &&
        url.searchParams.get("remove") === "1"
      ) {
        jobsList = jobsList.filter((j) => j.id !== "11111111111111111111111111111111");
        return jsonResponse({ id: "11111111111111111111111111111111", deleted: true });
      }
      return undefined;
    });

    renderOrganizePage("/organize");

    expect(await screen.findByRole("heading", { name: "Auto-organize jobs" })).toBeTruthy();
    const links = await screen.findAllByRole("link", { name: /^Job / });
    expect(links.map((el) => el.textContent)).toEqual(["Job 22222222", "Job 11111111"]);
    expect(screen.getByText(/3 applied/)).toBeTruthy();
    expect(screen.getByText(/Undo available/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(infoSpy).toHaveBeenCalledWith("Auto-organize cancelled"));
    expect(
      calls.some(
        (c) => c.method === "DELETE" && c.path === "/api/organize/jobs/22222222222222222222222222222222"
      )
    ).toBe(true);

    const deleteButtons = screen.getAllByRole("button", { name: "Delete" });
    fireEvent.click(deleteButtons[deleteButtons.length - 1]);
    const confirmDialog = await screen.findByRole("dialog", { name: "Delete Auto-organize job?" });
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "Delete job" }));

    await waitFor(() => expect(successSpy).toHaveBeenCalledWith("Auto-organize job deleted"));
    expect(
      calls.some(
        (c) => c.method === "DELETE" && c.path === "/api/organize/jobs/11111111111111111111111111111111?remove=1"
      )
    ).toBe(true);
  });

  it("supports job-wide Select all very-high when page 1 has only applied very-high items, cross-page edits, server filters, chunked apply and chunked undo", async () => {
    const successSpy = vi.spyOn(toast, "success").mockReturnValue("t-ok");
    const infoSpy = vi.spyOn(toast, "info").mockReturnValue("t-info");

    const hexId = (prefix: string, n: number) => `${prefix}${n.toString(16).padStart(32 - prefix.length, "0")}`;
    const jobId = "36600ecfac374bbf927c6d484a43cc70";

    // Build 365 items:
    // - 0..41 (42 items on page 1): very-high (0.92), already applied
    // - 42..45 (4 items on page 1): moderate high (0.78), unapplied
    // - 46..199 (154 items on page 1): low (0.50), unapplied
    // - 200..364 (165 items on page 2): very-high (0.92), unapplied
    const allItems = Array.from({ length: 365 }, (_, i) => {
      const isPage1AppliedVh = i < 42;
      const isPage1High = i >= 42 && i < 46;
      const isPage2Vh = i >= 200;
      const confidence = isPage1AppliedVh || isPage2Vh ? 0.92 : isPage1High ? 0.78 : 0.5;
      return {
        noteId: hexId("aa", i + 1),
        currentTitle: `Scan_${i + 1}.pdf`,
        currentNotebookId: id("1"),
        currentNotebookPath: "Pending to sort",
        updatedTime: 1000 + i,
        status: "done" as const,
        ...(isPage1AppliedVh ? { applied: true, applyStatus: "ok" as const } : {}),
        suggestion: {
          title: `2025-01-01 Doc ${i + 1}`,
          notebookId: id("3"),
          tags: ["statement"],
          confidence,
          documentDate: "2025-01-01",
          reason: `Reason ${i + 1}`,
        },
      };
    });

    let canUndo = false;
    let remainingUndoIds: string[] = [];

    const computeFilterCounts = () => {
      let veryHigh = 0;
      let veryHighUnapplied = 0;
      let high = 0;
      let highUnapplied = 0;
      let moves = 0;
      let movesUnapplied = 0;
      for (const item of allItems) {
        const conf = item.suggestion.confidence;
        if (conf >= 0.85) {
          veryHigh++;
          if (!item.applied) veryHighUnapplied++;
        }
        if (conf >= 0.7) {
          high++;
          if (!item.applied) highUnapplied++;
        }
        moves++;
        if (!item.applied) movesUnapplied++;
      }
      return {
        all: allItems.length,
        veryHigh,
        veryHighUnapplied,
        high,
        highUnapplied,
        moves,
        movesUnapplied,
      };
    };

    const calls = mockFetch((call) => {
      const url = new URL(call.path, "http://localhost");
      if (url.pathname === "/api/notebooks") return jsonResponse(notebooks);
      if (url.pathname === "/api/tags") return jsonResponse(tags);
      if (url.pathname === `/api/organize/jobs/${jobId}` && call.method === "GET") {
        const filterParam = (url.searchParams.get("filter") ?? "all") as "all" | "very-high" | "high" | "moves";
        const offsetParam = Number(url.searchParams.get("offset") ?? "0");
        const limitParam = Number(url.searchParams.get("limit") ?? "200");
        const matching = allItems.filter((item) => {
          if (filterParam === "very-high") return item.suggestion.confidence >= 0.85;
          if (filterParam === "high") return item.suggestion.confidence >= 0.7;
          return true;
        });
        const slice = matching.slice(offsetParam, offsetParam + limitParam);
        return jsonResponse({
          id: jobId,
          status: "done",
          excludeNotebookIds: [id("1")],
          progress: { total: allItems.length, done: allItems.length, failed: 0 },
          appliedCount: allItems.filter((it) => it.applied).length,
          retryableFailedCount: 0,
          filter: filterParam,
          filterCounts: computeFilterCounts(),
          usage: { promptTokens: 1000, completionTokens: 250, totalTokens: 1250 },
          offset: offsetParam,
          limit: limitParam,
          totalItems: matching.length,
          canUndo,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_010_000,
          items: slice,
        });
      }
      if (url.pathname === `/api/organize/jobs/${jobId}/targets` && call.method === "GET") {
        const mode = url.searchParams.get("mode");
        const threshold = mode === "very-high" ? 0.85 : 0.7;
        return jsonResponse({
          noteIds: allItems
            .filter((it) => !it.applied && it.suggestion.confidence >= threshold)
            .map((it) => it.noteId),
        });
      }
      if (url.pathname === `/api/organize/jobs/${jobId}/apply` && call.method === "POST") {
        const body = call.body as {
          items: Array<{ noteId: string; title?: string }>;
          undoMode?: "replace" | "append";
        };
        if (body.undoMode !== "append") {
          remainingUndoIds = [];
        }
        const results = body.items.map((inp) => {
          const item = allItems.find((it) => it.noteId === inp.noteId)!;
          item.applied = true;
          item.applyStatus = "ok";
          remainingUndoIds.push(inp.noteId);
          return { id: inp.noteId, status: "ok" as const, updatedTime: item.updatedTime + 100 };
        });
        canUndo = true;
        return jsonResponse({
          results,
          appliedCount: results.length,
          conflictCount: 0,
          errorCount: 0,
          canUndo: true,
        });
      }
      if (url.pathname === `/api/organize/jobs/${jobId}/undo` && call.method === "POST") {
        const body = (call.body ?? {}) as { limit?: number };
        const takeCount = body.limit ?? remainingUndoIds.length;
        const batchIds = remainingUndoIds.slice(0, takeCount);
        remainingUndoIds = remainingUndoIds.slice(batchIds.length);
        // Split response at <= 60 per chunk to test multi-chunk undo loop
        const results = batchIds.map((noteId) => {
          const item = allItems.find((it) => it.noteId === noteId)!;
          item.applied = false;
          delete item.applyStatus;
          return { id: noteId, status: "ok" as const, updatedTime: item.updatedTime + 200 };
        });
        canUndo = remainingUndoIds.length > 0;
        return jsonResponse({
          results,
          revertedCount: results.length,
          conflictCount: 0,
          errorCount: 0,
          canUndo,
          remainingCount: remainingUndoIds.length,
        });
      }
      return undefined;
    });

    renderOrganizePage(`/organize/${jobId}`);

    expect(await screen.findByText("Analysed 365 / 365")).toBeTruthy();
    // Initial default selection is high-confidence unapplied across all pages (4 on page 1 + 165 on page 2 = 169)
    expect(screen.getByRole("button", { name: "Apply selected (169)" })).toBeTruthy();

    // Select all very-high works even when page 1's 42 very-high items are already applied
    const selectVhBtn = screen.getByRole("button", { name: "Select all very-high" }) as HTMLButtonElement;
    expect(selectVhBtn.disabled).toBe(false);
    fireEvent.click(selectVhBtn);

    expect(infoSpy).toHaveBeenCalledWith(
      "Selected 165 very-high suggestions across all pages (none unapplied on this page)"
    );
    expect(screen.getByRole("button", { name: "Apply selected (165)" })).toBeTruthy();

    // Server-side filter resets offset and fetches ?filter=very-high
    // Tab labels count what is left, not just the total (42 of the 207 very-high are applied)
    fireEvent.click(screen.getByRole("button", { name: "Very high (>= 0.85) (165 left of 207)" }));
    await waitFor(() => {
      expect(
        calls.some(
          (c) =>
            c.method === "GET" &&
            c.path === `/api/organize/jobs/${jobId}?offset=0&limit=200&filter=very-high`
        )
      ).toBe(true);
    });
    expect(screen.getByText(/42 applied · 323 left/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All (323 left of 365)" }));

    // Navigate to Page 2, edit row 201's title and untick row 202
    await screen.findByText("Page 1 of 2 (365 notes)");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const editedInput = await screen.findByLabelText("Suggested title for Scan_201.pdf");
    fireEvent.change(editedInput, { target: { value: "Edited Page 2 Invoice" } });
    const uncheckedBox = screen.getByRole("checkbox", { name: "Select Scan_202.pdf" }) as HTMLInputElement;
    expect(uncheckedBox.checked).toBe(true);
    fireEvent.click(uncheckedBox);
    expect(screen.getByRole("button", { name: "Apply selected (164)" })).toBeTruthy();

    // Return to Page 1 -> cross-page count and edit remain intact
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await screen.findByText("Page 1 of 2 (365 notes)");
    expect(screen.getByRole("button", { name: "Apply selected (164)" })).toBeTruthy();

    // Apply selected (164) -> fetches /targets?mode=very-high and sends 2 chunks (100 replace, 64 append)
    fireEvent.click(screen.getByRole("button", { name: "Apply selected (164)" }));

    await waitFor(() => expect(successSpy).toHaveBeenCalled());
    expect(successSpy.mock.calls[0][0]).toBe("Applied changes to 164 notes");

    expect(
      calls.some((c) => c.method === "GET" && c.path === `/api/organize/jobs/${jobId}/targets?mode=very-high`)
    ).toBe(true);
    interface ApplyRequestBody {
      undoMode?: "replace" | "append";
      items: Array<{
        noteId: string;
        title?: string;
        notebookId?: string;
        addTags?: string[];
        baseUpdatedTime?: number;
        useSuggestion?: boolean;
      }>;
    }

    const applyCalls = calls.filter((c) => c.method === "POST" && c.path.endsWith("/apply"));
    expect(applyCalls).toHaveLength(2);
    expect((applyCalls[0].body as ApplyRequestBody).undoMode).toBe("replace");
    expect((applyCalls[0].body as ApplyRequestBody).items).toHaveLength(100);
    expect((applyCalls[1].body as ApplyRequestBody).undoMode).toBe("append");
    expect((applyCalls[1].body as ApplyRequestBody).items).toHaveLength(64);

    const allAppliedInputs = applyCalls.flatMap((c) => (c.body as ApplyRequestBody).items);
    const editedPayload = allAppliedInputs.find((it) => it.noteId === hexId("aa", 201));
    expect(editedPayload).toEqual({
      noteId: hexId("aa", 201),
      title: "Edited Page 2 Invoice",
      notebookId: id("3"),
      addTags: ["statement"],
      baseUpdatedTime: 1200,
    });
    expect(allAppliedInputs.some((it) => it.noteId === hexId("aa", 202))).toBe(false);
    const uneditedPayload = allAppliedInputs.find((it) => it.noteId === hexId("aa", 203));
    expect(uneditedPayload).toEqual({
      noteId: hexId("aa", 203),
      useSuggestion: true,
    });

    // Scan_202 stays unapplied, so 1 veryHighUnapplied remains
    expect((screen.getByRole("button", { name: "Select all very-high" }) as HTMLButtonElement).disabled).toBe(false);

    // Trigger Undo from toolbar -> reverts in 2 chunks (150 then 14)
    fireEvent.click(screen.getByRole("button", { name: "Undo last apply" }));
    await waitFor(() => expect(successSpy).toHaveBeenCalledWith("Reverted 164 notes"));
    const undoCalls = calls.filter((c) => c.method === "POST" && c.path.endsWith("/undo"));
    expect(undoCalls).toHaveLength(2);
    expect(undoCalls[0].body).toEqual({ limit: 150 });
    expect(undoCalls[1].body).toEqual({ limit: 150 });
  }, 40_000);
});
