import { QueryClient, useQuery } from "@tanstack/react-query";
import { getWriteState, isReadOnlyError } from "@/lib/api";
import { WriteState } from "@/lib/types";

export const WRITE_STATE_QUERY_KEY = ["account", "write-state"] as const;

/**
 * Whether the account accepts writes (accounts with end-to-end encryption are read-only). Refetched
 * with every other query on refresh, so E2EE turned on or off elsewhere shows up the same way.
 * While the answer is loading or failed to load, the account counts as writable: the server still
 * refuses each write it can't take.
 */
export function useWriteState(): { readOnly: boolean; reason: string | null } {
  const { data } = useQuery<WriteState, Error>({
    queryKey: WRITE_STATE_QUERY_KEY,
    queryFn: getWriteState,
    staleTime: 30 * 1000,
  });
  return { readOnly: data?.writable === false, reason: data?.writable === false ? data.reason : null };
}

/**
 * After a write was refused with 422, asks the server again whether the account is writable, so
 * the UI turns read-only as soon as one save hits E2EE turned on elsewhere.
 */
export function recheckWriteStateAfter(queryClient: QueryClient, error: unknown): void {
  if (isReadOnlyError(error)) void queryClient.invalidateQueries({ queryKey: WRITE_STATE_QUERY_KEY });
}
