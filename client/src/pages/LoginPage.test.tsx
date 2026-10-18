import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { AuthProvider } from "@/hooks/use-auth";
import { getStoredEmail } from "@/lib/api";
import { jsonResponse, mockFetch } from "@/test/fetch-mock";
import { LocationProbe, renderWithProviders } from "@/test/render";
import { LoginPage } from "./LoginPage";

/** Backend stub: no session until a login with demo/demo succeeds */
function mockBackend() {
  let signedIn = false;
  return mockFetch(({ method, path, body }) => {
    if (path === "/api/auth/check") {
      return signedIn ? jsonResponse({ serverHost: "notes.example.com" }) : jsonResponse({ error: "No session" }, 401);
    }
    if (method === "POST" && path === "/api/auth/login") {
      const { email, password } = body as { email: string; password: string };
      if (email === "demo@example.com" && password === "demo") {
        signedIn = true;
        return jsonResponse({ success: true });
      }
      return jsonResponse({ error: "Invalid email or password" }, 401);
    }
    return undefined;
  });
}

function renderLogin(route: string | { pathname: string; state?: unknown } = "/login") {
  return renderWithProviders(
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<p>Signed-in area</p>} />
      </Routes>
      <LocationProbe />
    </AuthProvider>,
    { route }
  );
}

function signIn(email: string, password: string) {
  fireEvent.change(screen.getByLabelText("Email Address"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("LoginPage", () => {
  it("asks for the missing field without calling the server", async () => {
    const calls = mockBackend();
    renderLogin();
    await waitFor(() => expect(calls.some((c) => c.path === "/api/auth/check")).toBe(true));

    fireEvent.submit(screen.getByRole("button", { name: "Sign In" }).closest("form")!);
    expect(await screen.findByText("Please enter your email address.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Email Address"), { target: { value: "demo@example.com" } });
    fireEvent.submit(screen.getByRole("button", { name: "Sign In" }).closest("form")!);
    expect(await screen.findByText("Please enter your password.")).toBeTruthy();

    expect(calls.some((c) => c.path === "/api/auth/login")).toBe(false);
  });

  it("shows the server's error for wrong credentials and stays on the page", async () => {
    mockBackend();
    renderLogin();

    signIn("demo@example.com", "wrong");

    expect(await screen.findByText("Invalid email or password")).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe("/login");
    expect((screen.getByRole("button", { name: "Sign In" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("signs in with a trimmed email and opens the notes", async () => {
    const calls = mockBackend();
    renderLogin();

    signIn("  demo@example.com ", "demo");

    expect(await screen.findByText("Signed-in area")).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe("/notes");
    expect(calls.find((c) => c.path === "/api/auth/login")?.body).toEqual({ email: "demo@example.com", password: "demo" });
    expect(getStoredEmail()).toBe("demo@example.com");
  });

  it("returns to the page the user came from", async () => {
    mockBackend();
    const from = "/notebooks/0123456789abcdef0123456789abcdef";
    renderLogin({ pathname: "/login", state: { from: { pathname: from } } });

    signIn("demo@example.com", "demo");

    await screen.findByText("Signed-in area");
    expect(screen.getByTestId("location").textContent).toBe(from);
  });

  it("ignores a return path outside the app's note pages", async () => {
    mockBackend();
    renderLogin({ pathname: "/login", state: { from: { pathname: "//evil.example.com" } } });

    signIn("demo@example.com", "demo");

    await screen.findByText("Signed-in area");
    expect(screen.getByTestId("location").textContent).toBe("/notes");
  });

  it("skips the form when a session already exists", async () => {
    mockFetch(({ path }) => (path === "/api/auth/check" ? jsonResponse({ serverHost: null }) : undefined));
    renderLogin();

    expect(await screen.findByText("Signed-in area")).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe("/notes");
  });
});
