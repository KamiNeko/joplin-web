import { vi } from "vitest";

/** A recorded request made through the stubbed fetch */
export interface FetchCall {
  method: string;
  path: string;
  body: unknown;
}

type Handler = (call: FetchCall) => Response | Promise<Response> | undefined;

/** Builds a JSON response like the backend sends. */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Replaces global fetch with a stub. `handler` answers a request or returns undefined, in which
 * case the stub answers 200 with `[]` (lists the components fetch on the side, e.g. tags).
 * Returns the recorded calls.
 */
export function mockFetch(handler: Handler): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), "http://localhost");
      let body: unknown = init.body;
      if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch {
          // not JSON
        }
      }
      const call = { method: (init.method ?? "GET").toUpperCase(), path: url.pathname + url.search, body };
      calls.push(call);
      return (await handler(call)) ?? jsonResponse([]);
    })
  );
  return calls;
}
