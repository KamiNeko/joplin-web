import { Notebook } from "./types";

export interface FlatNotebook {
  id: string;
  title: string;
  depth: number;
}

/**
 * Flattens the notebook tree depth-first (for pickers), keeping the nesting depth.
 */
export function flattenNotebooks(notebooks: Notebook[] | undefined, depth = 0): FlatNotebook[] {
  if (!notebooks) return [];
  return notebooks.flatMap((nb) => [
    { id: nb.id, title: nb.title, depth },
    ...flattenNotebooks(nb.children, depth + 1),
  ]);
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Describes what a notebook holds, e.g. "3 notes, 1 sub-notebook" or "empty". Used wherever a
 * notebook's contents are counted (trash confirmation, trash list) so the numbers read the same.
 */
export function notebookContentsLabel(noteCount: number, notebookCount: number): string {
  if (noteCount === 0 && notebookCount === 0) return "empty";
  const parts = [plural(noteCount, "note")];
  if (notebookCount > 0) parts.push(plural(notebookCount, "sub-notebook"));
  return parts.join(", ");
}

/**
 * Counts the notes and sub-notebooks (at any depth) inside a notebook of the tree.
 */
export function countNotebookContents(notebook: Notebook): { notes: number; notebooks: number } {
  return (notebook.children || []).reduce(
    (sum, child) => {
      const inner = countNotebookContents(child);
      return { notes: sum.notes + inner.notes, notebooks: sum.notebooks + 1 + inner.notebooks };
    },
    { notes: notebook.noteCount || 0, notebooks: 0 }
  );
}

/**
 * Recursively locates a notebook by ID in the tree.
 */
export function findNotebookById(notebooks: Notebook[] | undefined, id: string | null | undefined): Notebook | null {
  if (!notebooks || !id) return null;
  for (const nb of notebooks) {
    if (nb.id === id) return nb;
    const found = findNotebookById(nb.children, id);
    if (found) return found;
  }
  return null;
}
