import { useQuery } from "@tanstack/react-query";
import { getNotebooks, getTrashedNotebooks } from "@/lib/api";
import { Notebook, TrashedNotebook } from "@/lib/types";

export const NOTEBOOKS_QUERY_KEY = ["notebooks"] as const;
/** Nested under the notebooks key, so every notebook invalidation refreshes the trash too */
export const TRASHED_NOTEBOOKS_QUERY_KEY = ["notebooks", "trash"] as const;

/**
 * Hook to retrieve the trashed notebooks shown in the trash view.
 */
export function useTrashedNotebooks(enabled = true) {
  return useQuery<TrashedNotebook[], Error>({
    queryKey: TRASHED_NOTEBOOKS_QUERY_KEY,
    queryFn: getTrashedNotebooks,
    staleTime: 30 * 1000,
    enabled,
  });
}

/**
 * Hook to retrieve notebook hierarchical tree structure.
 */
export function useNotebooks() {
  return useQuery<Notebook[], Error>({
    queryKey: NOTEBOOKS_QUERY_KEY,
    queryFn: getNotebooks,
    staleTime: 30 * 1000, // 30 seconds
  });
}
