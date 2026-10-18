import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { ApiError, updateNote } from "@/lib/api";
import { Note } from "@/lib/types";
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
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const onSaved = vi.fn();
    const saver = createNoteSaver(queryClient, NOTE_ID, 1000);

    await expect(saver.send({ body: "new", force: false }, { onSaved })).resolves.toBe(true);

    expect(mockedUpdate).toHaveBeenCalledWith(NOTE_ID, { body: "new", force: false, baseUpdatedTime: 1000 });
    expect(saver.baseUpdatedTime).toBe(2000);
    expect(queryClient.getQueryData<Note>(["note", NOTE_ID])?.body).toBe("new");
    expect(invalidate).toHaveBeenCalled();
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
