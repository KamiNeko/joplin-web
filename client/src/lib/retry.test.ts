import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRetryScheduler, RETRY_MAX_ATTEMPTS, retryDelay } from "./retry";

describe("retryDelay", () => {
  it("backs off exponentially up to the maximum, then stops", () => {
    expect([0, 1, 2, 3, 4, 5].map(retryDelay)).toEqual([5000, 10000, 20000, 40000, 60000, 60000]);
    expect(retryDelay(RETRY_MAX_ATTEMPTS)).toBeNull();
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
