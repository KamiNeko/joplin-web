import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { jsonResponse, mockFetch } from "@/test/fetch-mock";
import { MarkdownEditor } from "./MarkdownEditor";

const self = "0123456789abcdef0123456789abcdef";
const other = "fedcba9876543210fedcba9876543210";

function renderEditor(value: string) {
  const onChange = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MarkdownEditor value={value} onChange={onChange} noteId={self} />
    </QueryClientProvider>
  );
  return onChange;
}

// jsdom has no layout; CodeMirror measures text ranges when it scrolls the cursor into view
beforeAll(() => {
  const empty = { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] } as unknown as DOMRectList;
  Range.prototype.getClientRects = () => empty;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MarkdownEditor formatting", () => {
  it("formats the text from the toolbar", () => {
    const onChange = renderEditor("hello");
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    expect(onChange).toHaveBeenLastCalledWith("**hello**", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Checklist" }));
    expect(onChange).toHaveBeenLastCalledWith("- [ ] **hello**", expect.anything());
  });

  it("formats with shortcuts and keeps Ctrl+K from reaching the header search", () => {
    const onChange = renderEditor("hello");
    const content = document.querySelector(".cm-content")!;
    fireEvent.keyDown(content, { key: "b", code: "KeyB", keyCode: 66, ctrlKey: true });
    expect(onChange).toHaveBeenLastCalledWith("**hello**", expect.anything());
    // fireEvent returns false when the event was cancelled, which the header's listener checks
    expect(fireEvent.keyDown(content, { key: "k", code: "KeyK", keyCode: 75, ctrlKey: true })).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith("**[]()hello**", expect.anything());
  });

  it("is one tab stop that arrow keys move through", () => {
    renderEditor("");
    const toolbar = screen.getByRole("toolbar", { name: "Formatting" });
    const focusable = toolbar.querySelectorAll('button[tabindex="0"]');
    expect(focusable).toHaveLength(1);
    const heading = screen.getByRole("button", { name: "Heading" });
    heading.focus();
    fireEvent.keyDown(heading, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Bold" }));
    fireEvent.keyDown(toolbar, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Link to note" }));
  });

  it("links to a note picked through search, leaving out the note being edited", async () => {
    const calls = mockFetch((call) => {
      if (call.path.startsWith("/api/search")) {
        return jsonResponse([
          { id: self, title: "This note", preview: "", updatedTime: 1, createdTime: 1 },
          { id: other, title: "Trip [2026]", preview: "Packing list", updatedTime: 1, createdTime: 1 },
        ]);
      }
    });
    const onChange = renderEditor("");
    fireEvent.click(screen.getByRole("button", { name: "Link to note" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "Search notes" }), { target: { value: "trip" } });

    const option = await screen.findByRole("option", { name: /Trip \[2026\]/ });
    expect(screen.queryByRole("option", { name: /This note/ })).toBeNull();
    expect(calls.some((c) => c.path === "/api/search?q=trip")).toBe(true);

    fireEvent.click(option);
    expect(onChange).toHaveBeenLastCalledWith(`[Trip \\[2026\\]](:/${other})`, expect.anything());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
