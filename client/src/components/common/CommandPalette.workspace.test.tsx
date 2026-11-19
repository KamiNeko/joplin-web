import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { jsonResponse, mockFetch } from "@/test/fetch-mock";
import { LocationProbe, renderWithProviders } from "@/test/render";
import { CommandPalette } from "./CommandPalette";
import { AskNotesDrawer } from "@/components/ai/AskNotesDrawer";

const id = (c: string) => c.repeat(32);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CommandPalette", () => {
  it("lists shortcuts/views, runs debounced search, navigates, and opens Ask AI", async () => {
    mockFetch((call) => {
      if (call.path === "/api/notebooks") {
        return jsonResponse([{ id: id("1"), title: "Engineering", parentId: "", children: [], noteCount: 4 }]);
      }
      if (call.path === "/api/tags") {
        return jsonResponse([{ id: id("a"), title: "urgent", noteCount: 2 }]);
      }
      if (call.path === "/api/preferences") {
        return jsonResponse({
          favoriteNoteIds: [id("n")],
          favoriteNotebookIds: [],
          savedSearches: [{ id: "s1", name: "Open Invoices", query: "tag:invoice", createdAt: 1000 }],
          recentReads: [],
          scratchpad: "",
          favoriteNotes: [{ id: id("n"), title: "Pinned Brief", preview: "", createdTime: 10, updatedTime: 20 }],
          favoriteNotebooks: [],
        });
      }
      if (call.path === "/api/notes/recent") {
        return jsonResponse({ recentRead: [], recentCreated: [] });
      }
      if (call.path.startsWith("/api/search")) {
        return jsonResponse([
          { id: id("9"), title: "Deploy Runbook", preview: "Production steps", createdTime: 10, updatedTime: 20 },
        ]);
      }
      return undefined;
    });

    const onOpenChange = vi.fn();
    const onOpenAskAi = vi.fn();
    renderWithProviders(
      <>
        <CommandPalette open onOpenChange={onOpenChange} aiEnabled onOpenAskAi={onOpenAskAi} />
        <LocationProbe />
      </>,
      { route: "/notes" }
    );

    expect(await screen.findByRole("option", { name: /Pinned Brief/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Open Invoices/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Engineering/ })).toBeTruthy();

    // Selecting Ask AI closes palette and notifies parent
    fireEvent.click(screen.getByRole("option", { name: /Ask My Notes/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenAskAi).toHaveBeenCalledTimes(1);

    // Search >= 2 chars surfaces matched notes and pressing Enter navigates
    const combobox = screen.getByRole("combobox", { name: "Command palette search" });
    fireEvent.change(combobox, { target: { value: "Deploy" } });
    expect(await screen.findByRole("option", { name: /Deploy Runbook/ }, { timeout: 2000 })).toBeTruthy();

    fireEvent.keyDown(combobox, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe(`/notes/${id("9")}`));
  });
});

describe("AskNotesDrawer", () => {
  it("submits scoped Q&A query and navigates when clicking a citation", async () => {
    const nbId = id("1");
    const tagId = id("a");
    const citedId = id("8");

    const calls = mockFetch((call) => {
      if (call.path === "/api/notebooks") {
        return jsonResponse([{ id: nbId, title: "Work", parentId: "", children: [], noteCount: 2 }]);
      }
      if (call.path === "/api/tags") {
        return jsonResponse([{ id: tagId, title: "project", noteCount: 1 }]);
      }
      if (call.method === "POST" && call.path === "/api/ai/ask") {
        return jsonResponse({
          answer: "You need to **finalize the release checklist**.",
          citations: [
            {
              id: citedId,
              title: "Release Checklist",
              notebookTitle: "Work",
              updatedTime: 1_700_000_000_000,
              excerpt: "- [ ] Verify backups",
            },
          ],
          usage: { promptTokens: 50, completionTokens: 15, totalTokens: 65 },
        });
      }
      return undefined;
    });

    const onOpenChange = vi.fn();
    renderWithProviders(
      <>
        <AskNotesDrawer open onOpenChange={onOpenChange} />
        <LocationProbe />
      </>,
      { route: "/home" }
    );

    await screen.findByRole("option", { name: "Work" });
    await screen.findByRole("option", { name: "#project" });
    fireEvent.change(screen.getByLabelText("Filter AI scope by notebook"), { target: { value: nbId } });
    fireEvent.change(screen.getByLabelText("Filter AI scope by tag"), { target: { value: tagId } });
    fireEvent.change(screen.getByLabelText("Question for Ask My Notes"), {
      target: { value: "What tasks remain?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    expect(await screen.findByText(/finalize the release checklist/)).toBeTruthy();
    expect(screen.getByText("65 tokens used")).toBeTruthy();

    const askCall = calls.find((c) => c.method === "POST" && c.path === "/api/ai/ask")!;
    expect(askCall.body).toEqual({
      question: "What tasks remain?",
      scopeNotebookId: nbId,
      scopeTagId: tagId,
    });

    fireEvent.click(screen.getByRole("button", { name: /Release Checklist/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByTestId("location").textContent).toBe(`/notes/${citedId}`);
  });
});
