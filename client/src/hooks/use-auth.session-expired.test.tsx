import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, getNotes } from "@/lib/api";
import { getConnectionSnapshot, resetConnection } from "@/lib/connection";
import { draftOwner, loadDraft, saveDraft, setDraftOwner } from "@/lib/drafts";
import { SessionExpiredDialog } from "@/components/common/Dialogs";
import { FetchCall, jsonResponse, mockFetch } from "@/test/fetch-mock";
import { AuthProvider, useAuth } from "./use-auth";
import { useConnectionState } from "./use-connection";

const NOTE_ID = "0123456789abcdef0123456789abcdef";
const EMAIL = "me@example.com";
const HOST = "notes.example.com";

/** Same wiring as SessionExpiredPrompt in App.tsx */
function Harness() {
  const { isAuthenticated, email, lastEmail, signInAgain, discardAndSignOut } = useAuth();
  const { sessionExpired } = useConnectionState();
  return (
    <>
      <p>{isAuthenticated ? `Signed in as ${email}` : `Signed out (last: ${lastEmail ?? "none"})`}</p>
      <SessionExpiredDialog open={isAuthenticated && sessionExpired} onSignIn={signInAgain} onDiscard={discardAndSignOut} />
    </>
  );
}

let calls: FetchCall[];
let queryClient: QueryClient;

async function renderSignedIn() {
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Harness />
      </AuthProvider>
    </QueryClientProvider>
  );
  await screen.findByText(`Signed in as ${EMAIL}`);
}

/** Any API request rejected with 401 */
async function expireSession() {
  await act(async () => {
    await expect(getNotes()).rejects.toMatchObject({ status: 401 });
  });
  return screen.findByRole("dialog", { name: "Session expired" });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("joplin_user_email", EMAIL);
  resetConnection();
  queryClient = new QueryClient();
  calls = mockFetch(({ path }) => {
    if (path === "/api/auth/check") return jsonResponse({ serverHost: HOST });
    if (path === "/api/auth/logout") return jsonResponse(null, 204);
    if (path.startsWith("/api/notes")) return jsonResponse({ error: "Invalid session" }, 401);
    return undefined;
  });
});

afterEach(cleanup);

describe("session expiry", () => {
  it("a 401 throws a session-expired error and opens the dialog", async () => {
    await renderSignedIn();
    expect(screen.queryByRole("dialog")).toBeNull();

    const err = await getNotes().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, message: "Your session has expired. Please sign in again." });
    expect(await screen.findByRole("dialog", { name: "Session expired" })).toBeTruthy();
    expect(screen.getByText(/Unsaved changes are kept on this device/)).toBeTruthy();
  });

  it("login and the startup check don't open the dialog on 401", async () => {
    calls = mockFetch(({ path }) =>
      path === "/api/auth/check" ? jsonResponse({ error: "No session" }, 401) : jsonResponse({ error: "Wrong password" }, 401)
    );
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Harness />
        </AuthProvider>
      </QueryClientProvider>
    );
    expect(await screen.findByText("Signed out (last: none)")).toBeTruthy();
    expect(getConnectionSnapshot().sessionExpired).toBe(false);
    // The stale email is cleared when the startup check finds no session
    expect(localStorage.getItem("joplin_user_email")).toBeNull();
  });

  it('"Sign out and discard" deletes all drafts, clears cached data and logs out', async () => {
    await renderSignedIn();
    setDraftOwner(draftOwner(EMAIL, HOST));
    saveDraft(NOTE_ID, { title: "T", body: "unsaved", baseUpdatedTime: 1 });
    queryClient.setQueryData(["note", NOTE_ID], { id: NOTE_ID });
    await expireSession();

    fireEvent.click(screen.getByRole("button", { name: "Sign out and discard" }));

    expect(await screen.findByText("Signed out (last: none)")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(Object.keys(localStorage).filter((k) => k.startsWith("joplin-draft:"))).toEqual([]);
    expect(localStorage.getItem("joplin_user_email")).toBeNull();
    expect(queryClient.getQueryData(["note", NOTE_ID])).toBeUndefined();
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/auth/logout")).toBe(true));
  });

  it('"Sign in again" keeps the drafts and remembers the email for the login form', async () => {
    await renderSignedIn();
    setDraftOwner(draftOwner(EMAIL, HOST));
    saveDraft(NOTE_ID, { title: "T", body: "unsaved", baseUpdatedTime: 1 });
    await expireSession();

    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));

    expect(await screen.findByText(`Signed out (last: ${EMAIL})`)).toBeTruthy();
    expect(loadDraft(NOTE_ID)?.body).toBe("unsaved");
    expect(calls.some((c) => c.path === "/api/auth/logout")).toBe(false);
  });
});
