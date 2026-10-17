import { useQuery } from "@tanstack/react-query";
import { getNotebooks } from "@/lib/api";
import { Notebook } from "@/lib/types";

export const NOTEBOOKS_QUERY_KEY = ["notebooks"] as const;

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
