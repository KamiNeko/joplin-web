import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, getNotes } from "./api";
import { getConnectionSnapshot, resetConnection } from "./connection";
import { jsonResponse } from "@/test/fetch-mock";

afterEach(() => {
  vi.unstubAllGlobals();
  resetConnection();
});

/** What fetch returns for a redirect with `redirect: "manual"` (no constructor can build one) */
function opaqueRedirect(): Response {
  return Object.defineProperty(Response.error(), "type", { value: "opaqueredirect" });
}

describe("sign-in proxy redirects", () => {
  it("are not followed, and fail the request with a sign-in hint", async () => {
    const fetchStub = vi.fn(async () => opaqueRedirect());
    vi.stubGlobal("fetch", fetchStub);
    const err = await getNotes().catch((e: unknown) => e);
    expect(fetchStub.mock.calls[0]).toEqual([expect.any(String), expect.objectContaining({ redirect: "manual" })]);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(0);
    expect((err as ApiError).message).toMatch(/^Sign-in required/);
    expect(getConnectionSnapshot().signInRedirect).toBe(true);
  });

  it("are cleared by the next answer from the server", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => opaqueRedirect()));
    await getNotes().catch(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));
    await getNotes();
    expect(getConnectionSnapshot().signInRedirect).toBe(false);
  });
});
