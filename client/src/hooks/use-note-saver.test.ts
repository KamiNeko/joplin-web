import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { ApiError, updateNote } from "@/lib/api";
import { Note, NoteListItem, SearchResult } from "@/lib/types";
import { createNoteSaver } from "./use-note-saver";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  updateNote: vi.fn(),
}));

const NOTE_ID = "0123456789abcdef0123456789abcdef";
const note = (updatedTime: number, body = "text"): Note => ({
  id: NOTE_ID,
  title: "Title",
  body,
  updatedTime,
  createdTime: 1,
  parentId: "f".repeat(32),
  notebookId: "f".repeat(32),
  notebookTitle: "Personal",
  tags: [],
  isTodo: false,
  todoCompleted: false,
});

const mockedUpdate = vi.mocked(updateNote);
let queryClient: QueryClient;

beforeEach(() => {
  mockedUpdate.mockReset();
  queryClient = new QueryClient();
});

describe("createNoteSaver", () => {
  it("sends the base, adopts the returned updatedTime and caches the saved note", async () => {
    mockedUpdate.mockResolvedValueOnce(note(2000, "new"));
    const onSaved = vi.fn();
    const saver = createNoteSaver(queryClient, NOTE_ID, 1000);

    await expect(saver.send({ body: "new", force: false }, { onSaved })).resolves.toBe(true);

    expect(mockedUpdate).toHaveBeenCalledWith(NOTE_ID, { body: "new", force: false, baseUpdatedTime: 1000 });
    expect(saver.baseUpdatedTime).toBe(2000);
    expect(queryClient.getQueryData<Note>(["note", NOTE_ID])?.body).toBe("new");
    expect(onSaved).toHaveBeenCalledWith(note(2000, "new"));
  });

  it("sends no base while none is known", async () => {
    mockedUpdate.mockResolvedValueOnce(note(2000));
    await createNoteSaver(queryClient, NOTE_ID).send({ body: "x" });
    expect(mockedUpdate.mock.calls[0][1].baseUpdatedTime).toBeUndefined();
  });

  it("is in flight until the handlers have run", async () => {
    let resolve!: (n: Note) => void;
    mockedUpdate.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const saver = createNoteSaver(queryClient, NOTE_ID, 1000);
    let inflightDuringHandler: unknown;

    const run = saver.send({ body: "x" }, { onSaved: () => (inflightDuringHandler = saver.inflight) });
    expect(saver.inflight).toBe(run);
    resolve(note(2000));
    await run;

    expect(inflightDuringHandler).toBe(run);
    expect(saver.inflight).toBeNull();
  });

  it("puts what toCache returns into the query cache", async () => {
    mockedUpdate.mockResolvedValueOnce(note(2000, "server"));
    const saver = createNoteSaver(queryClient, NOTE_ID, 1000);
    await saver.send({ body: "server" }, { toCache: (saved) => ({ ...saved, body: "optimistic" }) });
    expect(queryClient.getQueryData<Note>(["note", NOTE_ID])).toEqual(note(2000, "optimistic"));
  });

  it("reports a conflict without touching the base or the cache", async () => {
    const conflict = new ApiError(409, "Conflict", { details: { current: note(3000, "theirs") } });
    mockedUpdate.mockRejectedValueOnce(conflict);
    const onError = vi.fn();
    const onSaved = vi.fn();
    const saver = createNoteSaver(queryClient, NOTE_ID, 1000);

    await expect(saver.send({ body: "mine" }, { onSaved, onError })).resolves.toBe(false);

    expect(onError).toHaveBeenCalledWith(conflict);
    expect(onSaved).not.toHaveBeenCalled();
    expect(saver.baseUpdatedTime).toBe(1000);
    expect(queryClient.getQueryData(["note", NOTE_ID])).toBeUndefined();
    expect(saver.inflight).toBeNull();
  });

  it("treats a failing success handler as a failed save", async () => {
    mockedUpdate.mockResolvedValueOnce(note(2000));
    const failure = new Error("storage full");
    const onError = vi.fn();
    const saver = createNoteSaver(queryClient, NOTE_ID, 1000);
    const ok = await saver.send(
      { body: "x" },
      {
        onSaved: () => {
          throw failure;
        },
        onError,
      }
    );
    expect(ok).toBe(false);
    expect(onError).toHaveBeenCalledWith(failure);
  });
});

describe("list updates after a save", () => {
  const OTHER_ID = "fedcba9876543210fedcba9876543210";
  const item = (id: string, updatedTime: number, title = "Item"): NoteListItem => ({
    id,
    title,
    updatedTime,
    createdTime: 1,
    preview: "old preview",
  });
  const NOTES_KEY = ["notes", { notebookId: "f".repeat(32) }];
  const OTHER_LIST_KEY = ["notes", { notebookId: "e".repeat(32) }];
  const SEARCH_KEY = ["search", "title"];

  /** Seeds a notebook list (this note is older than the other one), an unrelated list and a search */
  function seedLists() {
    queryClient.setQueryData<NoteListItem[]>(NOTES_KEY, [item(OTHER_ID, 1500, "Other"), item(NOTE_ID, 1000, "Title")]);
    queryClient.setQueryData<NoteListItem[]>(OTHER_LIST_KEY, [item(OTHER_ID, 1500, "Other")]);
    queryClient.setQueryData<SearchResult[]>(SEARCH_KEY, [
      { ...item(NOTE_ID, 1000, "Title"), matches: { inTitle: true, inBody: false } },
    ]);
  }
  const saved = (changes: Partial<Note> = {}): Note => ({
    ...note(2000, "# New **text**"),
    title: "New title",
    preview: "New text",
    ...changes,
  });

  it("patches title, preview and time in place and keeps the newest first, without refetching", async () => {
    seedLists();
    const otherList = queryClient.getQueryData(OTHER_LIST_KEY);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    mockedUpdate.mockResolvedValueOnce(saved());

    await createNoteSaver(queryClient, NOTE_ID, 1000).send({ title: "New title", body: "# New **text**" });

    expect(queryClient.getQueryData<NoteListItem[]>(NOTES_KEY)).toEqual([
      { ...item(NOTE_ID, 2000, "New title"), preview: "New text" },
      item(OTHER_ID, 1500, "Other"),
    ]);
    expect(queryClient.getQueryData(OTHER_LIST_KEY)).toBe(otherList);
    expect(queryClient.getQueryData<SearchResult[]>(SEARCH_KEY)?.[0]).toMatchObject({
      title: "New title",
      preview: "New text",
      updatedTime: 2000,
      matches: { inTitle: true, inBody: false },
    });
    // Notes, notebooks and tags are not refetched; searches only become stale (their matches may differ)
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["search"], refetchType: "none" });
    expect(queryClient.getQueryState(SEARCH_KEY)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(NOTES_KEY)?.isInvalidated).toBe(false);
  });

  it("refetches the lists when the note moved or its to-do state changed", async () => {
    for (const changes of [{ parentId: "e".repeat(32) }, { todoCompleted: true }]) {
      seedLists();
      const invalidate = vi.spyOn(queryClient, "invalidateQueries");
      mockedUpdate.mockResolvedValueOnce(saved());
      await createNoteSaver(queryClient, NOTE_ID, 1000).send(changes);
      const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey?.[0]);
      expect(keys).toEqual(expect.arrayContaining(["notes", "notebooks", "tags", "search"]));
      invalidate.mockRestore();
    }
  });

  it("refetches the note lists when the server sends no preview", async () => {
    seedLists();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    mockedUpdate.mockResolvedValueOnce(saved({ preview: undefined }));
    await createNoteSaver(queryClient, NOTE_ID, 1000).send({ body: "x" });
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey?.[0]);
    expect(keys).toContain("notes");
    expect(keys).not.toContain("notebooks");
    expect(keys).not.toContain("tags");
  });
});
