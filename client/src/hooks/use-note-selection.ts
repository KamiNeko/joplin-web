import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface SelectionModifiers {
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

export interface UseNoteSelectionOptions {
  /** Resets selection mode and selected ids whenever this value changes (e.g. list scope or search toggle) */
  scopeKey?: string;
}

export interface NoteSelection {
  isSelecting: boolean;
  selectedIds: ReadonlySet<string>;
  anchorId: string | null;
  enterSelectionMode: () => void;
  exitSelectionMode: () => void;
  toggleSelectionMode: () => void;
  toggle: (id: string) => void;
  selectRange: (toId: string, orderedIds: readonly string[]) => void;
  selectAll: (orderedIds: readonly string[]) => void;
  clear: () => void;
  /**
   * Handles a click/key activation on a note item.
   * Returns `"selected"` when the selection state was updated, or `"open"` when the caller
   * should open the note normally.
   */
  handleItemAction: (
    id: string,
    modifiers: SelectionModifiers,
    orderedIds: readonly string[]
  ) => "selected" | "open";
}

/**
 * Reusable multi-note selection state with click toggle, Shift-click range selection,
 * Ctrl/Cmd-click entry, select-all over the full id list and scope-change reset.
 */
export function useNoteSelection(options: UseNoteSelectionOptions = {}): NoteSelection {
  const { scopeKey } = options;
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);

  // Reset synchronously on scope changes during render (matches MoveNotebookDialog, avoids setState in effects)
  const [prevScopeKey, setPrevScopeKey] = useState(scopeKey);
  if (scopeKey !== prevScopeKey) {
    setPrevScopeKey(scopeKey);
    if (isSelecting) setIsSelecting(false);
    if (selectedIds.size > 0) setSelectedIds(new Set());
    if (anchorId !== null) setAnchorId(null);
  }

  const isSelectingRef = useRef(isSelecting);
  const anchorIdRef = useRef(anchorId);
  useEffect(() => {
    isSelectingRef.current = isSelecting;
    anchorIdRef.current = anchorId;
  }, [isSelecting, anchorId]);

  const enterSelectionMode = useCallback(() => {
    isSelectingRef.current = true;
    setIsSelecting(true);
  }, []);

  const exitSelectionMode = useCallback(() => {
    isSelectingRef.current = false;
    anchorIdRef.current = null;
    setIsSelecting(false);
    setSelectedIds(new Set());
    setAnchorId(null);
  }, []);

  const toggleSelectionMode = useCallback(() => {
    if (isSelectingRef.current) {
      exitSelectionMode();
    } else {
      enterSelectionMode();
    }
  }, [exitSelectionMode, enterSelectionMode]);

  const clear = useCallback(() => {
    anchorIdRef.current = null;
    setSelectedIds(new Set());
    setAnchorId(null);
  }, []);

  const toggle = useCallback((id: string) => {
    anchorIdRef.current = id;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    setAnchorId(id);
  }, []);

  const selectRange = useCallback(
    (toId: string, orderedIds: readonly string[]) => {
      const targetIndex = orderedIds.indexOf(toId);
      const currentAnchor = anchorIdRef.current;
      const anchorIndex = currentAnchor !== null ? orderedIds.indexOf(currentAnchor) : -1;
      if (anchorIndex === -1 || targetIndex === -1) {
        toggle(toId);
        return;
      }
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (let i = start; i <= end; i++) {
          next.add(orderedIds[i]);
        }
        return next;
      });
    },
    [toggle]
  );

  const selectAll = useCallback((orderedIds: readonly string[]) => {
    const firstAnchor = orderedIds[0] ?? null;
    isSelectingRef.current = true;
    anchorIdRef.current = firstAnchor;
    setIsSelecting(true);
    setSelectedIds(new Set(orderedIds));
    setAnchorId(firstAnchor);
  }, []);

  const handleItemAction = useCallback(
    (id: string, modifiers: SelectionModifiers, orderedIds: readonly string[]): "selected" | "open" => {
      const modifierEntry = Boolean(modifiers.ctrlKey || modifiers.metaKey);
      if (!isSelectingRef.current) {
        if (!modifierEntry) return "open";
        isSelectingRef.current = true;
        anchorIdRef.current = id;
        setIsSelecting(true);
        setSelectedIds(new Set([id]));
        setAnchorId(id);
        return "selected";
      }

      if (modifiers.shiftKey) {
        selectRange(id, orderedIds);
      } else {
        toggle(id);
      }
      return "selected";
    },
    [selectRange, toggle]
  );

  return useMemo(
    () => ({
      isSelecting,
      selectedIds,
      anchorId,
      enterSelectionMode,
      exitSelectionMode,
      toggleSelectionMode,
      toggle,
      selectRange,
      selectAll,
      clear,
      handleItemAction,
    }),
    [
      isSelecting,
      selectedIds,
      anchorId,
      enterSelectionMode,
      exitSelectionMode,
      toggleSelectionMode,
      toggle,
      selectRange,
      selectAll,
      clear,
      handleItemAction,
    ]
  );
}
