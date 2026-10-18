/** First retry delay for a save that failed because the server was unreachable */
export const RETRY_BASE_MS = 5000;
/** Longest delay between retries */
export const RETRY_MAX_MS = 60000;
/** Retries before giving up (the user can still retry by hand, and `online` starts over) */
export const RETRY_MAX_ATTEMPTS = 6;

/**
 * Delay before retry number `attempt` (0-based): 5 s, 10 s, 20 s, 40 s, 60 s, 60 s, then null
 * (stop).
 */
export function retryDelay(attempt: number): number | null {
  if (attempt >= RETRY_MAX_ATTEMPTS) return null;
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
}

export interface RetryScheduler {
  /** Schedules the next retry; returns false when the attempts are used up or it was disposed */
  schedule(): boolean;
  /** Cancels a pending retry and starts counting from zero again (after a success or `online`) */
  reset(): void;
  /** Cancels a pending retry for good; later schedule() calls do nothing (editor closed) */
  dispose(): void;
}

/**
 * Backoff timer for failed saves. Owned by one editor: once disposed (editor closed, logout) no
 * retry runs, so text the user discarded meanwhile can't be written by a leftover timer.
 */
export function createRetryScheduler(run: () => void): RetryScheduler {
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    schedule() {
      if (disposed) return false;
      const delay = retryDelay(attempt);
      if (delay === null) return false;
      attempt += 1;
      cancel();
      timer = setTimeout(() => {
        timer = null;
        if (!disposed) run();
      }, delay);
      return true;
    },
    reset() {
      cancel();
      attempt = 0;
    },
    dispose() {
      disposed = true;
      cancel();
    },
  };
}
