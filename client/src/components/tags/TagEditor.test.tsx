import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { Note, Tag } from "@/lib/types";
import { FetchCall, jsonResponse, mockFetch } from "@/test/fetch-mock";
import { renderWithProviders } from "@/test/render";
import { TagEditor } from "./TagEditor";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const noteId = "0123456789abcdef0123456789abcdef";
const tag = (id: string, title: string, noteCount = 1): Tag => ({ id: id.repeat(32), title, noteCount });
const allTags = [tag("a", "planning", 3), tag("b", "ideas", 2), tag("c", "travel", 1), tag("d", "important", 4)];

function noteWith(tags: Tag[]): Note {
  return {
    id: noteId,
    title: "Roadmap",
    body: "",
    updatedTime: 2,
    createdTime: 1,
    parentId: "f".repeat(32),
    notebookId: "f".repeat(32),
    notebookTitle: "Projects",
    tags,
    isTodo: false,
    todoCompleted: false,
  };
}

/** Backend stub for the tag list and the add/remove endpoints */
function mockTagApi(onWrite?: (call: FetchCall) => Response | undefined) {
  return mockFetch((call) => {
    if (call.path === "/api/tags") return jsonResponse(allTags);
    const written = onWrite?.(call);
    if (written) return written;
    if (call.method === "POST" && call.path === `/api/notes/${noteId}/tags`) {
      const title = (call.body as { title: string }).title;
      return jsonResponse(noteWith([allTags.find((t) => t.title === title) ?? tag("e", title)]));
    }
    if (call.method === "DELETE") return jsonResponse(noteWith([]));
    return undefined;
  });
}

function openInput() {
  fireEvent.click(screen.getByRole("button", { name: "Tag" }));
  return screen.getByLabelText("Add tag") as HTMLInputElement;
}

const tagWrites = (calls: FetchCall[]) => calls.filter((c) => c.method !== "GET");

afterEach(cleanup);

describe("TagEditor", () => {
  it("shows the note's tags and reports clicks on them", () => {
    mockTagApi();
    const onTagClick = vi.fn();
    renderWithProviders(<TagEditor noteId={noteId} tags={[allTags[0]]} onTagClick={onTagClick} />);

    fireEvent.click(screen.getByRole("button", { name: "#planning" }));
    expect(onTagClick).toHaveBeenCalledWith(allTags[0].id);
  });

  it("is read-only without add or remove controls, and hidden without tags", () => {
    mockTagApi();
    const { rerender } = renderWithProviders(<TagEditor noteId={noteId} tags={[allTags[0]]} readOnly />);
    expect(screen.getByRole("button", { name: "#planning" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Tag" })).toBeNull();
    expect(screen.queryByLabelText("Remove tag planning")).toBeNull();

    rerender(<TagEditor noteId={noteId} tags={[]} readOnly />);
    expect(screen.queryByRole("button", { name: "#planning" })).toBeNull();
  });

  it("suggests existing tags that are not on the note, filtered by the typed text", async () => {
    mockTagApi();
    renderWithProviders(<TagEditor noteId={noteId} tags={[allTags[0]]} />);
    const input = openInput();

    const listbox = await screen.findByRole("listbox");
    const options = within(listbox).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["#ideas2", "#travel1", "#important4"]);

    fireEvent.change(input, { target: { value: "TRA" } });
    expect(within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.textContent)).toEqual(["#travel1"]);
  });

  it("adds exactly what was typed on Enter", async () => {
    const calls = mockTagApi();
    renderWithProviders(<TagEditor noteId={noteId} tags={[]} />);
    const input = openInput();

    fireEvent.change(input, { target: { value: "  someday  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(tagWrites(calls)).toHaveLength(1));
    expect(tagWrites(calls)[0]).toMatchObject({ method: "POST", path: `/api/notes/${noteId}/tags`, body: { title: "someday" } });
    // The input stays open and empty for the next tag
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("adds the suggestion picked with the arrow keys", async () => {
    const calls = mockTagApi();
    renderWithProviders(<TagEditor noteId={noteId} tags={[]} />);
    const input = openInput();
    await screen.findByRole("listbox");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(tagWrites(calls)).toHaveLength(1));
    expect(tagWrites(calls)[0].body).toEqual({ title: "ideas" });
  });

  it("adds a suggestion on click", async () => {
    const calls = mockTagApi();
    renderWithProviders(<TagEditor noteId={noteId} tags={[]} />);
    openInput();

    fireEvent.click(await screen.findByRole("button", { name: /#travel/ }));

    await waitFor(() => expect(tagWrites(calls)).toHaveLength(1));
    expect(tagWrites(calls)[0].body).toEqual({ title: "travel" });
  });

  it("does not add a tag the note already has (case-insensitive) and closes the input", () => {
    const calls = mockTagApi();
    renderWithProviders(<TagEditor noteId={noteId} tags={[allTags[0]]} />);
    const input = openInput();

    fireEvent.change(input, { target: { value: "Planning" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(tagWrites(calls)).toHaveLength(0);
    expect(screen.queryByLabelText("Add tag")).toBeNull();
  });

  it("closes on Escape without saving", () => {
    const calls = mockTagApi();
    renderWithProviders(<TagEditor noteId={noteId} tags={[]} />);
    const input = openInput();

    fireEvent.change(input, { target: { value: "draft" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByLabelText("Add tag")).toBeNull();
    expect(tagWrites(calls)).toHaveLength(0);
  });

  it("removes a tag from the note", async () => {
    const calls = mockTagApi();
    renderWithProviders(<TagEditor noteId={noteId} tags={[allTags[0]]} />);

    fireEvent.click(screen.getByLabelText("Remove tag planning"));

    await waitFor(() => expect(tagWrites(calls)).toHaveLength(1));
    expect(tagWrites(calls)[0]).toMatchObject({ method: "DELETE", path: `/api/notes/${noteId}/tags/${allTags[0].id}` });
  });

  it("reports a failed add with the server's message", async () => {
    mockTagApi((call) => (call.method === "POST" ? jsonResponse({ error: "Note is encrypted" }, 409) : undefined));
    renderWithProviders(<TagEditor noteId={noteId} tags={[]} />);
    const input = openInput();

    fireEvent.change(input, { target: { value: "x1" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Could not add tag", { description: "Note is encrypted" })
    );
  });
});
