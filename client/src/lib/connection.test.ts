import { beforeEach, describe, expect, it } from "vitest";
import {
  changePendingWrites,
  deriveConnectionStatus,
  formatAgo,
  getConnectionSnapshot,
  hasUnsavedChanges,
  isConnectionFailure,
  isTemporaryFailure,
  recordNetworkError,
  recordResponse,
  resetConnection,
  setNoteUnsaved,
  StatusInput,
} from "./connection";

const NOW = 1_700_000_000_000;
const base: StatusInput = {
  online: true,
  sessionExpired: false,
  isFetching: false,
  isSaving: false,
  lastError: null,
  lastUpdatedAt: null,
  now: NOW,
};

describe("deriveConnectionStatus", () => {
  it("says Connected before anything loaded", () => {
    expect(deriveConnectionStatus(base)).toEqual({ state: "connected", label: "Connected" });
  });

  it("shows the time of the last successful refresh", () => {
    expect(deriveConnectionStatus({ ...base, lastUpdatedAt: NOW - 5000 }).label).toBe("Updated just now");
    expect(deriveConnectionStatus({ ...base, lastUpdatedAt: NOW - 3 * 60000 }).label).toBe("Updated 3 min ago");
  });

  it("reports activity", () => {
    expect(deriveConnectionStatus({ ...base, isFetching: true }).state).toBe("refreshing");
    expect(deriveConnectionStatus({ ...base, isSaving: true, isFetching: true }).state).toBe("saving");
  });

  it("distinguishes an unreachable server from a server error", () => {
    const unreachable = { message: "x", status: 0, at: NOW };
    expect(deriveConnectionStatus({ ...base, lastError: unreachable })).toEqual({
      state: "error",
      label: "Can't reach server",
    });
    expect(deriveConnectionStatus({ ...base, lastError: { ...unreachable, status: 502 } }).label).toBe(
      "Can't reach server"
    );
    expect(deriveConnectionStatus({ ...base, lastError: { ...unreachable, status: 500 } }).label).toBe("Server error");
  });

  it("shows a retry in flight instead of the old error", () => {
    const lastError = { message: "x", status: 0, at: NOW };
    expect(deriveConnectionStatus({ ...base, lastError, isFetching: true }).state).toBe("refreshing");
  });

  it("puts offline and session expiry above everything else", () => {
    const busy = { ...base, isSaving: true, lastError: { message: "x", status: 0, at: NOW } };
    expect(deriveConnectionStatus({ ...busy, online: false, sessionExpired: true }).state).toBe("offline");
    expect(deriveConnectionStatus({ ...busy, sessionExpired: true }).state).toBe("expired");
  });
});

describe("formatAgo", () => {
  it("switches to the time of day after an hour", () => {
    expect(formatAgo(NOW - 59 * 60000, NOW)).toBe("59 min ago");
    expect(formatAgo(NOW - 61 * 60000, NOW)).toMatch(/^at /);
  });
});

describe("connection store", () => {
  beforeEach(() => resetConnection());

  it("treats only network errors and 5xx as connection failures", () => {
    expect(isConnectionFailure(0)).toBe(true);
    expect(isConnectionFailure(503)).toBe(true);
    expect(isConnectionFailure(404)).toBe(false);
    expect(isConnectionFailure(409)).toBe(false);
    expect(isConnectionFailure(429)).toBe(false);
  });

  it("treats connection failures and 429 as temporary (worth retrying)", () => {
    expect(isTemporaryFailure(0)).toBe(true);
    expect(isTemporaryFailure(502)).toBe(true);
    expect(isTemporaryFailure(429)).toBe(true);
    expect(isTemporaryFailure(400)).toBe(false);
    expect(isTemporaryFailure(409)).toBe(false);
  });

  it("records failures and clears them on the next answer", () => {
    recordNetworkError("Can't reach the server");
    expect(getConnectionSnapshot().lastError?.status).toBe(0);
    recordResponse(200, true, "");
    expect(getConnectionSnapshot().lastError).toBeNull();
    expect(getConnectionSnapshot().lastUpdatedAt).not.toBeNull();
  });

  it("does not count writes or failed reads as an update", () => {
    recordResponse(200, false, "");
    recordResponse(404, true, "Not found");
    expect(getConnectionSnapshot().lastUpdatedAt).toBeNull();
    expect(getConnectionSnapshot().lastError).toBeNull();
  });

  it("flags an expired session on 401", () => {
    recordResponse(401, true, "Unauthorized");
    expect(getConnectionSnapshot().sessionExpired).toBe(true);
    resetConnection();
    expect(getConnectionSnapshot().sessionExpired).toBe(false);
  });

  it("counts pending writes", () => {
    changePendingWrites(1);
    changePendingWrites(1);
    changePendingWrites(-1);
    expect(getConnectionSnapshot().pendingWrites).toBe(1);
    changePendingWrites(-1);
    changePendingWrites(-1);
    expect(getConnectionSnapshot().pendingWrites).toBe(0);
  });

  it("tracks notes with unsaved edits", () => {
    setNoteUnsaved("a", true);
    expect(hasUnsavedChanges("a")).toBe(true);
    expect(hasUnsavedChanges(undefined)).toBe(false);
    setNoteUnsaved("a", false);
    expect(hasUnsavedChanges("a")).toBe(false);
  });
});
