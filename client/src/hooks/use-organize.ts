import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import {
  BatchNoteResult,
  OrganizeApplyItemInput,
  OrganizeApplyResponse,
  OrganizeFilter,
  OrganizeJobResponse,
  OrganizeJobSummary,
  OrganizeUndoResponse,
} from "@/lib/types";
import { invalidateLists } from "./use-mutations";

export const ORGANIZE_STATUS_QUERY_KEY = ["organize", "status"] as const;
export const ORGANIZE_JOBS_QUERY_KEY = ["organize", "jobs"] as const;
export const ORGANIZE_PAGE_SIZE = 200;
export const ORGANIZE_APPLY_CHUNK_SIZE = 100;
export const ORGANIZE_UNDO_CHUNK_SIZE = 150;

export interface OrganizeBatchProgress {
  completed: number;
  total: number;
}

export interface ApplyOrganizeVariables {
  items: OrganizeApplyItemInput[];
  onProgress?: (progress: OrganizeBatchProgress) => void;
}

export interface UndoOrganizeVariables {
  totalHint?: number;
  onProgress?: (progress: OrganizeBatchProgress) => void;
}

export class OrganizePartialApplyError extends Error {
  readonly partial: OrganizeApplyResponse;
  readonly causeError: unknown;

  constructor(partial: OrganizeApplyResponse, causeError: unknown) {
    super(causeError instanceof Error ? causeError.message : "Could not finish applying all chunks");
    this.name = "OrganizePartialApplyError";
    this.partial = partial;
    this.causeError = causeError;
  }
}

export class OrganizePartialUndoError extends Error {
  readonly partial: OrganizeUndoResponse;
  readonly causeError: unknown;

  constructor(partial: OrganizeUndoResponse, causeError: unknown) {
    super(causeError instanceof Error ? causeError.message : "Could not finish reverting all chunks");
    this.name = "OrganizePartialUndoError";
    this.partial = partial;
    this.causeError = causeError;
  }
}

function invalidateOrganizeJobAndRelated(queryClient: QueryClient, jobId: string | undefined): Promise<unknown> {
  queryClient.invalidateQueries({ queryKey: ORGANIZE_JOBS_QUERY_KEY });
  invalidateLists(queryClient);
  queryClient.invalidateQueries({ queryKey: ["note"] });
  if (jobId) {
    return queryClient.invalidateQueries({ queryKey: ["organize", "job", jobId] });
  }
  return Promise.resolve();
}

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
  options: { offset?: number; limit?: number; filter?: OrganizeFilter } = {}
) {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? ORGANIZE_PAGE_SIZE;
  const filter = options.filter ?? "all";

  return useQuery({
    queryKey: ["organize", "job", jobId, offset, limit, filter],
    queryFn: () => getOrganizeJob(jobId!, { offset, limit, filter: filter === "all" ? undefined : filter }),
    enabled: Boolean(jobId),
    placeholderData: (previousData, previousQuery) => (previousQuery?.queryKey[2] === jobId ? previousData : undefined),
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
    mutationFn: async (input: OrganizeApplyItemInput[] | ApplyOrganizeVariables): Promise<OrganizeApplyResponse> => {
      const items = Array.isArray(input) ? input : input.items;
      const onProgress = Array.isArray(input) ? undefined : input.onProgress;
      const total = items.length;

      if (total <= ORGANIZE_APPLY_CHUNK_SIZE) {
        const res = await applyOrganizeJob(jobId!, items);
        await invalidateOrganizeJobAndRelated(queryClient, jobId);
        return res;
      }

      const results: BatchNoteResult[] = [];
      let appliedCount = 0;
      let conflictCount = 0;
      let errorCount = 0;
      let canUndo = false;
      let completedChunks = 0;
      let hasStartedUndoBatch = false;

      onProgress?.({ completed: 0, total });

      try {
        for (let offset = 0; offset < total; offset += ORGANIZE_APPLY_CHUNK_SIZE) {
          const chunk = items.slice(offset, offset + ORGANIZE_APPLY_CHUNK_SIZE);
          const chunkRes = await applyOrganizeJob(jobId!, chunk, {
            undoMode: hasStartedUndoBatch ? "append" : "replace",
          });
          completedChunks++;
          if (chunkRes.appliedCount > 0) {
            hasStartedUndoBatch = true;
          }
          results.push(...chunkRes.results);
          appliedCount += chunkRes.appliedCount;
          conflictCount += chunkRes.conflictCount;
          errorCount += chunkRes.errorCount;
          canUndo = chunkRes.canUndo || canUndo;
          onProgress?.({ completed: Math.min(total, offset + chunk.length), total });
        }

        return {
          results,
          appliedCount,
          conflictCount,
          errorCount,
          canUndo,
        };
      } catch (err) {
        if (completedChunks > 0) {
          throw new OrganizePartialApplyError(
            {
              results,
              appliedCount,
              conflictCount,
              errorCount,
              canUndo,
            },
            err
          );
        }
        throw err;
      } finally {
        if (completedChunks > 0) {
          await invalidateOrganizeJobAndRelated(queryClient, jobId);
        }
      }
    },
  });
}

export function useUndoOrganizeJob(jobId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (options?: UndoOrganizeVariables): Promise<OrganizeUndoResponse> => {
      const results: BatchNoteResult[] = [];
      let revertedCount = 0;
      let conflictCount = 0;
      let errorCount = 0;
      let canUndo: boolean;
      let remainingCount = 0;
      let completedChunks = 0;

      if (options?.totalHint && options.totalHint > ORGANIZE_UNDO_CHUNK_SIZE) {
        options.onProgress?.({ completed: 0, total: options.totalHint });
      }

      try {
        while (true) {
          const chunk = await undoOrganizeJob(jobId!, { limit: ORGANIZE_UNDO_CHUNK_SIZE });
          completedChunks++;
          results.push(...chunk.results);
          revertedCount += chunk.revertedCount;
          conflictCount += chunk.conflictCount;
          errorCount += chunk.errorCount;
          canUndo = chunk.canUndo;
          remainingCount = chunk.remainingCount ?? 0;

          const estimatedTotal = options?.totalHint ?? results.length + remainingCount;
          if (estimatedTotal > ORGANIZE_UNDO_CHUNK_SIZE || remainingCount > 0) {
            options?.onProgress?.({ completed: results.length, total: estimatedTotal });
          }

          // Failed reverts stay in the server's undo record; stop once a round makes no progress.
          if (!canUndo || remainingCount <= 0 || chunk.revertedCount + chunk.conflictCount === 0) {
            break;
          }
        }

        return {
          results,
          revertedCount,
          conflictCount,
          errorCount,
          canUndo,
          remainingCount,
        };
      } catch (err) {
        if (completedChunks > 0) {
          throw new OrganizePartialUndoError(
            {
              results,
              revertedCount,
              conflictCount,
              errorCount,
              canUndo: true,
              remainingCount,
            },
            err
          );
        }
        throw err;
      } finally {
        if (completedChunks > 0) {
          await invalidateOrganizeJobAndRelated(queryClient, jobId);
        }
      }
    },
  });
}
