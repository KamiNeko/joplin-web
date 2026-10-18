import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRetryScheduler, RETRY_AFTER_MAX_MS, RETRY_MAX_ATTEMPTS, retryDelay } from "./retry";

describe("retryDelay", () => {
  it("backs off exponentially up to the maximum, then stops", () => {
    expect([0, 1, 2, 3, 4, 5].map((attempt) => retryDelay(attempt))).toEqual([5000, 10000, 20000, 40000, 60000, 60000]);
    expect(retryDelay(RETRY_MAX_ATTEMPTS)).toBeNull();
  });

  it("waits at least as long as the server's Retry-After, up to 15 minutes", () => {
    expect(retryDelay(0, 120000)).toBe(120000);
    expect(retryDelay(3, 1000)).toBe(40000);
    expect(retryDelay(0, 24 * 60 * 60 * 1000)).toBe(RETRY_AFTER_MAX_MS);
    expect(retryDelay(RETRY_MAX_ATTEMPTS, 120000)).toBeNull();
  });
});

describe("createRetryScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs a scheduled retry after the delay", () => {
    const run = vi.fn();
    const retry = createRetryScheduler(run);
    expect(retry.schedule()).toBe(true);
    vi.advanceTimersByTime(4999);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs a retry no sooner than the given Retry-After", () => {
    const run = vi.fn();
    const retry = createRetryScheduler(run);
    expect(retry.schedule(90000)).toBe(true);
    vi.advanceTimersByTime(89999);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("gives up after the maximum number of attempts", () => {
    const run = vi.fn();
    const retry = createRetryScheduler(run);
    for (let i = 0; i < RETRY_MAX_ATTEMPTS; i++) {
      expect(retry.schedule()).toBe(true);
      vi.runOnlyPendingTimers();
    }
    expect(retry.schedule()).toBe(false);
    expect(run).toHaveBeenCalledTimes(RETRY_MAX_ATTEMPTS);
  });

  it("starts over after reset", () => {
    const retry = createRetryScheduler(vi.fn());
    for (let i = 0; i < RETRY_MAX_ATTEMPTS; i++) retry.schedule();
    retry.reset();
    expect(retry.schedule()).toBe(true);
  });

  it("never runs once disposed (editor closed or logout)", () => {
    const run = vi.fn();
    const retry = createRetryScheduler(run);
    retry.schedule();
    retry.dispose();
    vi.advanceTimersByTime(120000);
    expect(run).not.toHaveBeenCalled();
    expect(retry.schedule()).toBe(false);
    retry.reset();
    expect(retry.schedule()).toBe(false);
  });
});
