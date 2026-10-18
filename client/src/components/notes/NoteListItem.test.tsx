import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NoteListItem, formatRelativeTime } from "./NoteListItem";

const NOW = new Date("2026-06-15T12:00:00Z").getTime();

const baseNote = {
  id: "0123456789abcdef0123456789abcdef",
  title: "Shopping list",
  preview: "Milk, eggs",
  createdTime: NOW - 3 * 3600 * 1000,
  updatedTime: NOW - 2 * 3600 * 1000,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("NoteListItem", () => {
  it("shows title, preview, relative time and up to three tags", () => {
    const tags = ["a", "b", "c", "d", "e"].map((title, i) => ({ id: `tag${i}`, title, noteCount: 1 }));
    render(<NoteListItem note={{ ...baseNote, tags }} />);
    expect(screen.getByRole("heading", { name: "Shopping list" })).toBeTruthy();
    expect(screen.getByText("Milk, eggs")).toBeTruthy();
    expect(screen.getByText("2 hours ago")).toBeTruthy();
    expect(screen.getByText("#a")).toBeTruthy();
    expect(screen.getByText("#c")).toBeTruthy();
    expect(screen.queryByText("#d")).toBeNull();
    expect(screen.getByText("+2")).toBeTruthy();
  });

  it("falls back for an empty title and body", () => {
    render(<NoteListItem note={{ ...baseNote, title: "", preview: "" }} />);
    expect(screen.getByRole("heading", { name: "Untitled Note" })).toBeTruthy();
    expect(screen.getByText("Empty note")).toBeTruthy();
  });

  it("opens the note on click, Enter and Space", () => {
    const onClick = vi.fn();
    render(<NoteListItem note={baseNote} onClick={onClick} />);
    const item = screen.getByRole("button");
    fireEvent.click(item);
    fireEvent.keyDown(item, { key: "Enter" });
    fireEvent.keyDown(item, { key: " " });
    fireEvent.keyDown(item, { key: "a" });
    expect(onClick).toHaveBeenCalledTimes(3);
  });

  it("toggles a to-do without opening the note", () => {
    const onClick = vi.fn();
    const onToggleTodo = vi.fn();
    render(<NoteListItem note={{ ...baseNote, isTodo: true }} onClick={onClick} onToggleTodo={onToggleTodo} />);
    const checkbox = screen.getByRole("button", { name: "Mark as done" });
    fireEvent.click(checkbox);
    fireEvent.keyDown(checkbox, { key: "Enter" });
    expect(onToggleTodo).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("strikes through a completed to-do and disables the checkbox without a handler", () => {
    render(<NoteListItem note={{ ...baseNote, isTodo: true, todoCompleted: true }} />);
    const checkbox = screen.getByRole("button", { name: "Mark as not done" }) as HTMLButtonElement;
    expect(checkbox.disabled).toBe(true);
    expect(screen.getByRole("heading").className).toContain("line-through");
  });
});

describe("formatRelativeTime", () => {
  it("accepts milliseconds, seconds and date strings", () => {
    expect(formatRelativeTime(NOW - 10_000)).toBe("just now");
    expect(formatRelativeTime(Math.floor((NOW - 5 * 60_000) / 1000))).toBe("5 mins ago");
    expect(formatRelativeTime(new Date(NOW - 26 * 3600_000).toISOString())).toBe("yesterday");
    expect(formatRelativeTime(NOW - 3 * 86400_000)).toBe("3 days ago");
  });

  it("returns an empty string for missing or invalid timestamps", () => {
    expect(formatRelativeTime(undefined)).toBe("");
    expect(formatRelativeTime(0)).toBe("");
    expect(formatRelativeTime("not a date")).toBe("");
  });
});
