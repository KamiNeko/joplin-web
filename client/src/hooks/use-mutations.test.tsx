import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Note } from "@/lib/types";
import { resetConnection } from "@/lib/connection";
import { FetchCall, jsonResponse, mockFetch } from "@/test/fetch-mock";
import {
  useAddTag,
  useCreateNote,
  useCreateNotebook,
  useDeleteNote,
  useDeleteNotebook,
  useDeleteTag,
  usePurgeNotebook,
  useRemoveTag,
  useRenameTag,
  useRestoreNote,
  useRestoreNotebook,
  useUpdateNote,
  useUpdateNotebook,
} from "./use-mutations";

const NOTE_ID = "0123456789abcdef0123456789abcdef";
const OTHER_ID = "fedcba9876543210fedcba9876543210";
const NB_ID = "f".repeat(32);
const TAG_ID = "a".repeat(32);

const note = (changes: Partial<Note> = {}): Note => ({
  id: NOTE_ID,
  title: "Title",
  body: "Body",
  updatedTime: 2000,
  createdTime: 1,
  parentId: NB_ID,
  notebookId: NB_ID,
  notebookTitle: "Personal",
  tags: [],
  isTodo: false,
  todoCompleted: false,
  ...changes,
});

const LIST_KEYS = [["notes"], ["notebooks"], ["tags"], ["search"]];

let queryClient: QueryClient;
let calls: FetchCall[];
let invalidated: unknown[];

/** Seeds every query a write can touch, so we can see which ones were invalidated or removed */
function seedCache() {
  for (const key of [...LIST_KEYS, ["notes", { notebookId: NB_ID }], ["search", "milk"]]) {
    queryClient.setQueryData(key, []);
  }
  queryClient.setQueryData(["note", NOTE_ID], note({ updatedTime: 1000 }));
  queryClient.setQueryData(["note", OTHER_ID], note({ id: OTHER_ID }));
}

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  resetConnection();
  queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  seedCache();
  invalidated = [];
  const original = queryClient.invalidateQueries.bind(queryClient);
  vi.spyOn(queryClient, "invalidateQueries").mockImplementation((filters, options) => {
    invalidated.push(filters?.queryKey);
    return original(filters, options);
  });
  calls = mockFetch(({ method, path }) => {
    if (method === "DELETE" && path.includes("/tags/") && path.startsWith("/api/notes/")) return jsonResponse(note());
    if (method === "DELETE") return jsonResponse(null, 204);
    if (path.startsWith("/api/notebooks") && method !== "GET") return jsonResponse({ id: NB_ID, title: "Work" });
    if (path.startsWith("/api/tags/")) return jsonResponse({ id: TAG_ID, title: "renamed", noteCount: 1 });
    if (method !== "GET") return jsonResponse(note({ title: "Saved", tags: [{ id: TAG_ID, title: "t", noteCount: 1 }] }));
    return undefined;
  });
});

const last = () => calls[calls.length - 1];
const isStale = (key: unknown[]) => queryClient.getQueryState(key)?.isInvalidated === true;

function expectListsInvalidated() {
  for (const key of LIST_KEYS) expect(invalidated).toContainEqual(key);
  // Prefix matching: filtered lists and search results are refreshed too
  expect(isStale(["notes", { notebookId: NB_ID }])).toBe(true);
  expect(isStale(["search", "milk"])).toBe(true);
}

async function run<TVars>(hook: () => { mutateAsync: (v: TVars) => Promise<unknown> }, vars: TVars) {
  const { result } = renderHook(hook, { wrapper });
  await act(() => result.current.mutateAsync(vars));
}

describe("note mutations", () => {
  it("useCreateNote posts the note, caches it and invalidates the lists", async () => {
    await run(useCreateNote, { parentId: NB_ID, title: "New" });
    expect(calls).toContainEqual({ method: "POST", path: "/api/notes", body: { parentId: NB_ID, title: "New" } });
    expect(queryClient.getQueryData<Note>(["note", NOTE_ID])?.title).toBe("Saved");
    expectListsInvalidated();
  });

  it("useUpdateNote replaces the cached note and invalidates the lists, but not other notes", async () => {
    await run(useUpdateNote, { id: NOTE_ID, changes: { parentId: OTHER_ID } });
    expect(calls).toContainEqual({ method: "PUT", path: `/api/notes/${NOTE_ID}`, body: { parentId: OTHER_ID } });
    expect(queryClient.getQueryData<Note>(["note", NOTE_ID])?.updatedTime).toBe(2000);
    expectListsInvalidated();
    expect(isStale(["note", OTHER_ID])).toBe(false);
  });

  it("useDeleteNote (trash) invalidates the note so it shows as trashed", async () => {
    await run(useDeleteNote, { id: NOTE_ID });
    expect(calls).toContainEqual({ method: "DELETE", path: `/api/notes/${NOTE_ID}`, body: undefined });
    expect(isStale(["note", NOTE_ID])).toBe(true);
    expect(isStale(["note", OTHER_ID])).toBe(false);
    expectListsInvalidated();
  });

  it("useDeleteNote (permanent) removes the note from the cache", async () => {
    await run(useDeleteNote, { id: NOTE_ID, permanent: true });
    expect(last()?.path).toBe(`/api/notes/${NOTE_ID}?permanent=true`);
    expect(queryClient.getQueryState(["note", NOTE_ID])).toBeUndefined();
    expect(queryClient.getQueryData(["note", OTHER_ID])).toBeDefined();
    expectListsInvalidated();
  });

  it("useRestoreNote caches the restored note and invalidates the lists", async () => {
    await run(useRestoreNote, NOTE_ID);
    expect(last()).toMatchObject({ method: "POST", path: `/api/notes/${NOTE_ID}/restore` });
    expect(queryClient.getQueryData<Note>(["note", NOTE_ID])?.title).toBe("Saved");
    expectListsInvalidated();
  });

  it("a failed write invalidates nothing and keeps the cached note", async () => {
    mockFetch(() => jsonResponse({ error: "Note not found" }, 404));
    const { result } = renderHook(useUpdateNote, { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ id: NOTE_ID, changes: { title: "x" } })).rejects.toMatchObject({
        status: 404,
        message: "Note not found",
      });
    });
    expect(invalidated).toEqual([]);
    expect(queryClient.getQueryData<Note>(["note", NOTE_ID])?.updatedTime).toBe(1000);
  });
});

describe("notebook mutations", () => {
  it("useCreateNotebook invalidates the lists only", async () => {
    await run(useCreateNotebook, { title: "Work" });
    expect(last()).toEqual({ method: "POST", path: "/api/notebooks", body: { title: "Work" } });
    expectListsInvalidated();
    expect(isStale(["note", NOTE_ID])).toBe(false);
  });

  // These change notebookTitle / deleted state of notes inside the notebook
  it.each([
    ["useUpdateNotebook", () => run(useUpdateNotebook, { id: NB_ID, changes: { title: "Renamed" } }), "PUT", `/api/notebooks/${NB_ID}`],
    ["useDeleteNotebook", () => run(useDeleteNotebook, NB_ID), "DELETE", `/api/notebooks/${NB_ID}`],
    ["useRestoreNotebook", () => run(useRestoreNotebook, NB_ID), "POST", `/api/notebooks/${NB_ID}/restore`],
    ["usePurgeNotebook", () => run(usePurgeNotebook, NB_ID), "DELETE", `/api/notebooks/${NB_ID}?permanent=true`],
  ])("%s invalidates the lists and every open note", async (_name, mutate, method, path) => {
    await mutate();
    expect(last()).toMatchObject({ method, path });
    expectListsInvalidated();
    expect(invalidated).toContainEqual(["note"]);
    expect(isStale(["note", NOTE_ID])).toBe(true);
    expect(isStale(["note", OTHER_ID])).toBe(true);
  });
});

describe("tag mutations", () => {
  it("useAddTag posts the title and caches the returned note", async () => {
    await run(useAddTag, { noteId: NOTE_ID, title: "groceries" });
    expect(last()).toEqual({ method: "POST", path: `/api/notes/${NOTE_ID}/tags`, body: { title: "groceries" } });
    expect(queryClient.getQueryData<Note>(["note", NOTE_ID])?.tags).toHaveLength(1);
    expectListsInvalidated();
    expect(isStale(["note", OTHER_ID])).toBe(false);
  });

  it("useRemoveTag deletes the link and caches the returned note", async () => {
    await run(useRemoveTag, { noteId: NOTE_ID, tagId: TAG_ID });
    expect(last()).toMatchObject({ method: "DELETE", path: `/api/notes/${NOTE_ID}/tags/${TAG_ID}` });
    expectListsInvalidated();
  });

  it.each([
    ["useRenameTag", () => run(useRenameTag, { id: TAG_ID, title: "renamed" }), "PUT"],
    ["useDeleteTag", () => run(useDeleteTag, TAG_ID), "DELETE"],
  ])("%s invalidates the lists and every open note (their tag chips)", async (_name, mutate, method) => {
    await mutate();
    expect(last()).toMatchObject({ method, path: `/api/tags/${TAG_ID}` });
    expectListsInvalidated();
    expect(isStale(["note", NOTE_ID])).toBe(true);
    expect(isStale(["note", OTHER_ID])).toBe(true);
  });
});
