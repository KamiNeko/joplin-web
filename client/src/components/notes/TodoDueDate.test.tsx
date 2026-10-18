import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Note } from "@/lib/types";
import { resetConnection } from "@/lib/connection";
import { FetchCall, jsonResponse, mockFetch } from "@/test/fetch-mock";
import { TodoDueDate } from "./TodoDueDate";

const NOW = new Date(2026, 5, 15, 12, 0).getTime();
const DUE = new Date(2026, 5, 20, 9, 30).getTime();

const todo: Note = {
  id: "0123456789abcdef0123456789abcdef",
  title: "Renew passport",
  body: "",
  updatedTime: 1000,
  createdTime: 500,
  parentId: "f".repeat(32),
  notebookId: "f".repeat(32),
  notebookTitle: "Personal",
  tags: [],
  isTodo: true,
  todoCompleted: false,
  todoDue: 0,
};

let queryClient: QueryClient;

function renderDue(note: Note, readOnly = false) {
  return render(
    <QueryClientProvider client={queryClient}>
      <TodoDueDate note={note} readOnly={readOnly} />
    </QueryClientProvider>
  );
}

/** Answers PUT /api/notes/:id with the note plus the sent changes (or a 409) */
function mockSave(conflict?: Note): FetchCall[] {
  return mockFetch(({ method, body }) => {
    if (method !== "PUT") return undefined;
    if (conflict) return jsonResponse({ error: "Note was changed elsewhere", details: { current: conflict } }, 409);
    const { todoDue } = body as { todoDue: number };
    return jsonResponse({ ...todo, todoDue, updatedTime: 2000 });
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  resetConnection();
  queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("TodoDueDate", () => {
  it("renders nothing for plain notes and for read-only to-dos without a due date", () => {
    const { container, rerender } = renderDue({ ...todo, isTodo: false, todoDue: DUE });
    expect(container.textContent).toBe("");
    rerender(
      <QueryClientProvider client={queryClient}>
        <TodoDueDate note={todo} readOnly />
      </QueryClientProvider>
    );
    expect(container.textContent).toBe("");
  });

  it("shows the due date and highlights it when overdue", () => {
    const { rerender } = renderDue({ ...todo, todoDue: DUE });
    const button = screen.getByRole("button", { name: /^Due .*change due date$/ });
    expect(button.className).not.toContain("text-destructive");

    rerender(
      <QueryClientProvider client={queryClient}>
        <TodoDueDate note={{ ...todo, todoDue: NOW - 3600_000 }} />
      </QueryClientProvider>
    );
    expect(screen.getByRole("button", { name: /^Overdue / }).className).toContain("text-destructive");
  });

  it("shows a read-only due date without an editor", () => {
    renderDue({ ...todo, todoDue: DUE }, true);
    expect(screen.getByText(/^Due /)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("sets a due date with conflict detection", async () => {
    const calls = mockSave();
    renderDue(todo);
    fireEvent.click(screen.getByRole("button", { name: "Set due date" }));

    const input = screen.getByLabelText("Due date") as HTMLInputElement;
    expect(input.type).toBe("datetime-local");
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();

    fireEvent.change(input, { target: { value: "2026-06-20T09:30" } });
    fireEvent.click(save);

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.path).toBe(`/api/notes/${todo.id}`);
    expect(put.body).toEqual({ todoDue: DUE, baseUpdatedTime: 1000 });
    await waitFor(() => expect(queryClient.getQueryData<Note>(["note", todo.id])?.todoDue).toBe(DUE));
    await waitFor(() => expect(screen.queryByLabelText("Due date")).toBeNull());
  });

  it("prefills the current due date, changes and clears it", async () => {
    const calls = mockSave();
    renderDue({ ...todo, todoDue: DUE });
    fireEvent.click(screen.getByRole("button", { name: /change due date/ }));
    const input = screen.getByLabelText("Due date") as HTMLInputElement;
    expect(input.value).toBe("2026-06-20T09:30");
    // Unchanged value: nothing to save
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ todoDue: 0, baseUpdatedTime: 1000 }));
  });

  it("shows the latest version after a conflict", async () => {
    const theirs = { ...todo, todoDue: DUE, updatedTime: 3000 };
    mockSave(theirs);
    renderDue(todo);
    fireEvent.click(screen.getByRole("button", { name: "Set due date" }));
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-06-21T10:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(queryClient.getQueryData<Note>(["note", todo.id])).toEqual(theirs));
  });
});
