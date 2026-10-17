import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { searchNotes } from "@/lib/api";
import { SearchResult } from "@/lib/types";

/**
 * Hook to search notes with 300ms debounce and minimum query length of 2 characters.
 */
export function useSearch(query: string) {
  const [debouncedQuery, setDebouncedQuery] = useState(query);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 300);

    return () => clearTimeout(timer);
  }, [query]);

  const enabled = debouncedQuery.length >= 2;

  const queryResult = useQuery<SearchResult[], Error>({
    queryKey: ["search", debouncedQuery],
    queryFn: () => searchNotes(debouncedQuery),
    enabled,
    staleTime: 10 * 1000,
  });

  return {
    ...queryResult,
    debouncedQuery,
    isSearching: enabled && queryResult.isFetching,
  };
}
