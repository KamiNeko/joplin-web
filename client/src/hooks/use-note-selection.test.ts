import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useNoteSelection } from "./use-note-selection";

const ORDERED = ["a", "b", "c", "d", "e"];

describe("useNoteSelection", () => {
  it("opens on plain click outside selection mode and enters selection mode on Ctrl/Cmd click", () => {
    const { result } = renderHook(() => useNoteSelection());
    expect(result.current.isSelecting).toBe(false);
    expect(result.current.selectedIds.size).toBe(0);

    let outcome: "selected" | "open" = "selected";
    act(() => {
      outcome = result.current.handleItemAction("b", {}, ORDERED);
    });
    expect(outcome).toBe("open");
    expect(result.current.isSelecting).toBe(false);

    act(() => {
      outcome = result.current.handleItemAction("b", { ctrlKey: true }, ORDERED);
    });
    expect(outcome).toBe("selected");
    expect(result.current.isSelecting).toBe(true);
    expect([...result.current.selectedIds]).toEqual(["b"]);

    act(() => {
      result.current.exitSelectionMode();
    });
    expect(result.current.isSelecting).toBe(false);
    expect(result.current.selectedIds.size).toBe(0);

    act(() => {
      outcome = result.current.handleItemAction("d", { metaKey: true }, ORDERED);
    });
    expect(outcome).toBe("selected");
    expect(result.current.isSelecting).toBe(true);
    expect([...result.current.selectedIds]).toEqual(["d"]);
  });

  it("toggles items and selects forward/backward ranges from the preserved anchor", () => {
    const { result } = renderHook(() => useNoteSelection());

    act(() => {
      result.current.enterSelectionMode();
      result.current.handleItemAction("b", {}, ORDERED);
    });
    expect([...result.current.selectedIds]).toEqual(["b"]);
    expect(result.current.anchorId).toBe("b");

    // Forward Shift-click b -> d preserves anchor "b"
    act(() => {
      result.current.handleItemAction("d", { shiftKey: true }, ORDERED);
    });
    expect([...result.current.selectedIds]).toEqual(["b", "c", "d"]);
    expect(result.current.anchorId).toBe("b");

    // Backward Shift-click from preserved anchor "b" -> "a"
    act(() => {
      result.current.handleItemAction("a", { shiftKey: true }, ORDERED);
    });
    expect([...result.current.selectedIds].sort()).toEqual(["a", "b", "c", "d"]);

    // Plain click toggles individual item off and updates anchor
    act(() => {
      result.current.handleItemAction("c", {}, ORDERED);
    });
    expect(result.current.selectedIds.has("c")).toBe(false);
    expect(result.current.anchorId).toBe("c");
  });

  it("selects thousands of ids with selectAll and resets when scopeKey changes", () => {
    const thousands = Array.from({ length: 5500 }, (_, i) => `note-${i}`);
    const { result, rerender } = renderHook(
      ({ scopeKey }: { scopeKey: string }) => useNoteSelection({ scopeKey }),
      { initialProps: { scopeKey: "nb-1:list" } }
    );

    act(() => {
      result.current.selectAll(thousands);
    });
    expect(result.current.isSelecting).toBe(true);
    expect(result.current.selectedIds.size).toBe(5500);
    expect(result.current.selectedIds.has("note-5499")).toBe(true);

    rerender({ scopeKey: "nb-2:list" });
    expect(result.current.isSelecting).toBe(false);
    expect(result.current.selectedIds.size).toBe(0);
    expect(result.current.anchorId).toBeNull();
  });
});
