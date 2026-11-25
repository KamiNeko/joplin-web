import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applyOrganizeJob,
  cancelOrganizeJob,
  createOrganizeJob,
  deleteOrganizeJob,
  getOrganizeJob,
  getOrganizeStatus,
  listOrganizeJobs,
  retryOrganizeJob,
  undoOrganizeJob,
} from "@/lib/api";
import { OrganizeApplyItemInput, OrganizeJobResponse, OrganizeJobSummary } from "@/lib/types";
import { invalidateLists } from "./use-mutations";

export const ORGANIZE_STATUS_QUERY_KEY = ["organize", "status"] as const;
export const ORGANIZE_JOBS_QUERY_KEY = ["organize", "jobs"] as const;
export const ORGANIZE_PAGE_SIZE = 200;

/**
 * Checks whether Auto-organize is configured and enabled on the server.
 */
export function useOrganizeStatus() {
  return useQuery({
    queryKey: ORGANIZE_STATUS_QUERY_KEY,
    queryFn: getOrganizeStatus,
    staleTime: 60_000,
  });
}

/**
 * Lists the user's Auto-organize jobs and polls while any job is running.
 */
export function useOrganizeJobs(enabled = true) {
  return useQuery({
    queryKey: ORGANIZE_JOBS_QUERY_KEY,
    queryFn: listOrganizeJobs,
    enabled,
    refetchInterval: (query) => {
      const data = query.state.data as { jobs: OrganizeJobSummary[] } | undefined;
      return data?.jobs.some((j) => j.status === "running") ? 1500 : false;
    },
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
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createOrganizeJob,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ORGANIZE_JOBS_QUERY_KEY });
    },
  });
}

export function useCancelOrganizeJob(jobId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (overrideJobId?: string) => cancelOrganizeJob(overrideJobId ?? jobId!),
    onSuccess: (_data, overrideJobId) => {
      const targetId = overrideJobId ?? jobId;
      if (targetId) {
        queryClient.invalidateQueries({ queryKey: ["organize", "job", targetId] });
      }
      queryClient.invalidateQueries({ queryKey: ORGANIZE_JOBS_QUERY_KEY });
    },
  });
}

export function useDeleteOrganizeJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (targetJobId: string) => deleteOrganizeJob(targetJobId),
    onSuccess: (_data, targetJobId) => {
      queryClient.removeQueries({ queryKey: ["organize", "job", targetJobId] });
      queryClient.invalidateQueries({ queryKey: ORGANIZE_JOBS_QUERY_KEY });
    },
  });
}

export function useRetryOrganizeJob(jobId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => retryOrganizeJob(jobId!),
    onSuccess: () => {
      if (jobId) {
        queryClient.invalidateQueries({ queryKey: ["organize", "job", jobId] });
      }
      queryClient.invalidateQueries({ queryKey: ORGANIZE_JOBS_QUERY_KEY });
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
      queryClient.invalidateQueries({ queryKey: ORGANIZE_JOBS_QUERY_KEY });
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
      queryClient.invalidateQueries({ queryKey: ORGANIZE_JOBS_QUERY_KEY });
      invalidateLists(queryClient);
      queryClient.invalidateQueries({ queryKey: ["note"] });
    },
  });
}
