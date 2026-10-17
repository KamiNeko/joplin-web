import { useQuery } from "@tanstack/react-query";
import { getTags } from "@/lib/api";
import { Tag } from "@/lib/types";

export const TAGS_QUERY_KEY = ["tags"] as const;

/**
 * Hook to retrieve all tags with note counts.
 */
export function useTags() {
  return useQuery<Tag[], Error>({
    queryKey: TAGS_QUERY_KEY,
    queryFn: getTags,
    staleTime: 60 * 1000, // 60 seconds
  });
}
