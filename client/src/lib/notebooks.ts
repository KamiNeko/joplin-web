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
