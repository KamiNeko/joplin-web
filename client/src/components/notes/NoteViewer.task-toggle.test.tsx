import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { updateNote } from "@/lib/api";
import { Note } from "@/lib/types";
import { draftOwner, setDraftOwner } from "@/lib/drafts";
import { NoteViewer } from "./NoteViewer";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  updateNote: vi.fn(),
}));

const note: Note = {
  id: "0123456789abcdef0123456789abcdef",
  title: "Packing",
  body: "- [ ] Shoes\n- [ ] Adapter\n",
  updatedTime: 1000,
  createdTime: 500,
  parentId: "f".repeat(32),
  notebookId: "f".repeat(32),
  notebookTitle: "Travel",
  tags: [],
  isTodo: false,
  todoCompleted: false,
};

const mockedUpdate = vi.mocked(updateNote);

beforeEach(() => {
  localStorage.clear();
  setDraftOwner(draftOwner("me@example.com", "notes.example.com"));
  mockedUpdate.mockReset();
});

afterEach(cleanup);

describe("NoteViewer checkbox toggle", () => {
  it("bases each save on the latest version in the cache, including one the editor saved", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["note", note.id], note);
    mockedUpdate.mockImplementation(async (_id, changes) => ({
      ...note,
      body: changes.body ?? note.body,
      updatedTime: mockedUpdate.mock.calls.length === 1 ? 2000 : 4000,
    }));
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <NoteViewer note={note} />
        </MemoryRouter>
      </QueryClientProvider>
    );

    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(mockedUpdate.mock.calls[0][1]).toEqual({ body: "- [x] Shoes\n- [ ] Adapter\n", baseUpdatedTime: 1000 });
    await waitFor(() => expect(queryClient.getQueryData<Note>(["note", note.id])?.updatedTime).toBe(2000));

    // The editor saved a newer version in between (it writes the saved note into the cache)
    queryClient.setQueryData<Note>(["note", note.id], (n) => ({ ...n!, title: "Packing list", updatedTime: 3000 }));

    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(mockedUpdate.mock.calls[1][1].baseUpdatedTime).toBe(3000);
  });
});
