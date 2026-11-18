import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applyOrganizeJob,
  cancelOrganizeJob,
  createOrganizeJob,
  getOrganizeJob,
  getOrganizeStatus,
  undoOrganizeJob,
} from "@/lib/api";
import { OrganizeApplyItemInput, OrganizeJobResponse } from "@/lib/types";
import { invalidateLists } from "./use-mutations";

export const ORGANIZE_STATUS_QUERY_KEY = ["organize", "status"] as const;
export const ORGANIZE_PAGE_SIZE = 200;

/**
 * Checks whether Auto-organize is enabled on the server.
 */
export function useOrganizeStatus() {
  return useQuery({
    queryKey: ORGANIZE_STATUS_QUERY_KEY,
    queryFn: getOrganizeStatus,
    staleTime: 60_000,
  });
}

/**
 * Loads one page of an Auto-organize job and polls while the job is still running.
 */
export function useOrganizeJob(
  jobId: string | undefined,
  options: { offset?: number; limit?: number } = {}
) {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? ORGANIZE_PAGE_SIZE;

  return useQuery({
    queryKey: ["organize", "job", jobId, offset, limit],
    queryFn: () => getOrganizeJob(jobId!, { offset, limit }),
    enabled: Boolean(jobId),
    refetchInterval: (query) => {
      const data = query.state.data as OrganizeJobResponse | undefined;
      return data?.status === "running" ? 750 : false;
    },
  });
}

export function useCreateOrganizeJob() {
  return useMutation({
    mutationFn: createOrganizeJob,
  });
}

export function useCancelOrganizeJob(jobId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => cancelOrganizeJob(jobId!),
    onSuccess: () => {
      if (jobId) {
        queryClient.invalidateQueries({ queryKey: ["organize", "job", jobId] });
      }
    },
  });
}

export function useApplyOrganizeJob(jobId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (items: OrganizeApplyItemInput[]) => applyOrganizeJob(jobId!, items),
    onSuccess: () => {
      if (jobId) {
        queryClient.invalidateQueries({ queryKey: ["organize", "job", jobId] });
      }
      invalidateLists(queryClient);
      queryClient.invalidateQueries({ queryKey: ["note"] });
    },
  });
}

export function useUndoOrganizeJob(jobId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => undoOrganizeJob(jobId!),
    onSuccess: () => {
      if (jobId) {
        queryClient.invalidateQueries({ queryKey: ["organize", "job", jobId] });
      }
      invalidateLists(queryClient);
      queryClient.invalidateQueries({ queryKey: ["note"] });
    },
  });
}
