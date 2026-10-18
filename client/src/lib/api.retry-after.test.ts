import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, parseRetryAfter, updateNote } from "./api";
import { resetConnection } from "./connection";
import { mockFetch } from "@/test/fetch-mock";

const NOTE_ID = "0123456789abcdef0123456789abcdef";

afterEach(() => {
  vi.unstubAllGlobals();
  resetConnection();
});

describe("parseRetryAfter", () => {
  it("reads seconds and HTTP dates", () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    expect(parseRetryAfter("120", now)).toBe(120000);
    expect(parseRetryAfter(" 0 ", now)).toBe(0);
    expect(parseRetryAfter("Sun, 18 Oct 2026 12:01:30 GMT", now)).toBe(90000);
    expect(parseRetryAfter("Sun, 18 Oct 2026 11:00:00 GMT", now)).toBe(0);
  });

  it("ignores a missing or unreadable header", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});

describe("request errors", () => {
  it("carry the Retry-After of a 429", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: "Too many requests" }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "30" },
        })
    );
    const err = await updateNote(NOTE_ID, { body: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(429);
    expect((err as ApiError).retryAfterMs).toBe(30000);
  });
});
