import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Note } from "@/lib/types";
import { NoteViewer } from "./NoteViewer";

const ORIGINAL_ID = "0123456789abcdef0123456789abcdef";

const copy: Note = {
  id: "fedcba9876543210fedcba9876543210",
  title: "Roadmap",
  body: "Their version",
  updatedTime: 1000,
  createdTime: 500,
  parentId: "f".repeat(32),
  notebookId: "f".repeat(32),
  notebookTitle: "Projects",
  tags: [{ id: "a".repeat(32), title: "planning", noteCount: 1 }],
  isTodo: false,
  todoCompleted: false,
  isConflict: true,
  conflictOriginalId: ORIGINAL_ID,
};

function renderViewer(note: Note, props: Partial<Parameters<typeof NoteViewer>[0]> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <NoteViewer note={note} {...props} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(cleanup);

describe("NoteViewer with a conflict copy", () => {
  it("explains the copy and opens the original", () => {
    const onOpenNote = vi.fn();
    renderViewer(copy, { onOpenNote });
    expect(screen.getByText(/Conflict copy\./)).toBeTruthy();
    expect(screen.getByText("Conflict")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open original" }));
    expect(onOpenNote).toHaveBeenCalledWith(ORIGINAL_ID);
  });

  it("offers no link when the original is unknown", () => {
    renderViewer({ ...copy, conflictOriginalId: "" }, { onOpenNote: vi.fn() });
    expect(screen.getByText(/Conflict copy\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open original" })).toBeNull();
  });

  it("keeps tags read-only, since tags of conflict copies are not listed anywhere", () => {
    renderViewer(copy);
    expect(screen.getByText(/planning/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /add tag/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /remove tag/i })).toBeNull();
  });

  it("shows the trash notice instead once the copy is trashed", () => {
    renderViewer({ ...copy, deletedTime: 3000 });
    expect(screen.queryByText(/Conflict copy\./)).toBeNull();
    expect(screen.getByText(/This note is in the trash\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy();
  });

  it("shows nothing of this for a regular note", () => {
    renderViewer({ ...copy, isConflict: false, conflictOriginalId: "" });
    expect(screen.queryByText(/Conflict copy\./)).toBeNull();
    expect(screen.queryByText("Conflict")).toBeNull();
  });
});
