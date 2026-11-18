import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { Notebook } from "@/lib/types";
import { StartOrganizeDialog } from "./StartOrganizeDialog";
import { renderWithProviders } from "@/test/render";

const id = (c: string) => c.repeat(32);

const notebooks: Notebook[] = [
  { id: id("1"), title: "Pending to sort", parentId: "", children: [], noteCount: 12 },
  {
    id: id("2"),
    title: "Personal",
    parentId: "",
    children: [
      { id: id("3"), title: "Bank", parentId: id("2"), children: [], noteCount: 5 },
      { id: id("4"), title: "Bills", parentId: id("2"), children: [], noteCount: 8 },
    ],
    noteCount: 1,
  },
  { id: id("5"), title: "Purchase Invoice", parentId: "", children: [], noteCount: 4 },
  { id: id("6"), title: "Vault", parentId: "", children: [], noteCount: 2, encrypted: true },
  { id: id("7"), title: "Projects", parentId: "", children: [], noteCount: 3 },
];

afterEach(cleanup);

describe("StartOrganizeDialog", () => {
  it("pre-selects the uniform source notebook, allows filtering/toggling exclusions, and discloses provider data", () => {
    const onConfirm = vi.fn();

    renderWithProviders(
      <StartOrganizeDialog
        open
        onOpenChange={vi.fn()}
        selectedCount={3}
        notebooks={notebooks}
        defaultExcludedNotebookId={id("1")}
        onConfirm={onConfirm}
      />
    );

    expect(screen.getByText("Auto-organize 3 notes")).toBeTruthy();
    expect(screen.getByText("1 excluded")).toBeTruthy();

    // Encrypted notebook is omitted from target exclusions list
    expect(screen.queryByRole("checkbox", { name: /Vault/ })).toBeNull();

    const pendingBox = screen.getByRole("checkbox", { name: /Pending to sort/ }) as HTMLInputElement;
    expect(pendingBox.checked).toBe(true);
    expect(screen.getByText("Source")).toBeTruthy();

    // Privacy disclosure notes note contents & taxonomy sent to the AI provider
    const note = screen.getByRole("note");
    expect(note.textContent).toMatch(/title, plain text/i);
    expect(note.textContent).toMatch(/OCR text/i);
    expect(note.textContent).toMatch(/notebook names/i);

    // Filter notebooks and exclude Personal / Bank too
    fireEvent.change(screen.getByLabelText("Filter excluded notebooks"), { target: { value: "Bank" } });
    const bankBox = screen.getByRole("checkbox", { name: /Bank/ }) as HTMLInputElement;
    expect(bankBox.checked).toBe(false);
    fireEvent.click(bankBox);

    expect(screen.getByText("2 excluded")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start organizing (3)" }));
    expect(onConfirm).toHaveBeenCalledWith([id("1"), id("3")]);
  });

  it("shows Previous jobs (N) and running-job warning with Cancel and start option", () => {
    const onViewJobs = vi.fn();
    const onViewRunningJob = vi.fn();
    const onCancelAndStart = vi.fn();

    renderWithProviders(
      <StartOrganizeDialog
        open
        onOpenChange={vi.fn()}
        selectedCount={4}
        notebooks={notebooks}
        defaultExcludedNotebookId={id("1")}
        previousJobsCount={3}
        onViewJobs={onViewJobs}
        runningJob={{
          id: "runjob1234567890abcdef1234567890",
          status: "running",
          progress: { total: 100, done: 42, failed: 3 },
          appliedCount: 0,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          canUndo: false,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_010_000,
        }}
        onViewRunningJob={onViewRunningJob}
        onCancelAndStart={onCancelAndStart}
        onConfirm={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Previous jobs (3)" }));
    expect(onViewJobs).toHaveBeenCalledTimes(1);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Another Auto-organize job is currently running.");
    expect(alert.textContent).toContain("45 / 100 notes analysed");

    fireEvent.click(screen.getByRole("button", { name: "View running job" }));
    expect(onViewRunningJob).toHaveBeenCalledWith("runjob1234567890abcdef1234567890");

    fireEvent.click(screen.getByRole("button", { name: "Cancel the running job and start" }));
    expect(onCancelAndStart).toHaveBeenCalledWith("runjob1234567890abcdef1234567890", [id("1")]);
  });
});
