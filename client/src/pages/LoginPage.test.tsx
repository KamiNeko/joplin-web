import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { AuthProvider } from "@/hooks/use-auth";
import { getStoredEmail } from "@/lib/api";
import * as webauthn from "@/lib/webauthn";
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
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

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

  it("completes the second step with TOTP or recovery code and hides passkeys when unsupported", async () => {
    vi.spyOn(webauthn, "isWebAuthnSupported").mockReturnValue(false);
    let signedIn = false;
    const calls = mockFetch(({ method, path, body }) => {
      if (path === "/api/auth/check") {
        return signedIn ? jsonResponse({ serverHost: "notes.example.com" }) : jsonResponse({ error: "No" }, 401);
      }
      if (method === "POST" && path === "/api/auth/login") {
        return jsonResponse({
          twoFactor: {
            required: true,
            mustEnroll: false,
            methods: ["passkey", "totp", "recovery"],
            passkeysAvailable: true,
          },
        });
      }
      if (method === "POST" && path === "/api/auth/2fa/totp/verify") {
        const { code } = body as { code: string };
        if (code === "123456") {
          signedIn = true;
          return jsonResponse({ verified: true, userId: "u1" });
        }
        return jsonResponse({ error: "Invalid verification code." }, 401);
      }
      if (method === "POST" && path === "/api/auth/2fa/recovery/verify") {
        signedIn = true;
        return jsonResponse({ verified: true, userId: "u1" });
      }
      if (method === "POST" && path === "/api/auth/logout") {
        return jsonResponse({ message: "ok" });
      }
      return undefined;
    });

    renderLogin();
    signIn("demo@example.com", "demo");

    expect(await screen.findByText("Two-step verification")).toBeTruthy();
    // Passkey option must stay hidden when WebAuthn is unsupported
    expect(screen.queryByRole("button", { name: /Use a passkey/i })).toBeNull();

    // Switch to recovery code, trust device, and verify
    fireEvent.click(screen.getByRole("button", { name: "Use a recovery code" }));
    fireEvent.change(screen.getByLabelText("Recovery code"), { target: { value: "ABCD-EFGH-IJKL-MNOP" } });
    fireEvent.click(screen.getByLabelText("Trust this device for 30 days"));
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    expect(await screen.findByText("Signed-in area")).toBeTruthy();
    const verifyCall = calls.find((c) => c.path === "/api/auth/2fa/recovery/verify");
    expect(verifyCall?.body).toEqual({ code: "ABCD-EFGH-IJKL-MNOP", trustDevice: true });
  });

  it("handles passkey login and Cancel during second step", async () => {
    vi.spyOn(webauthn, "isWebAuthnSupported").mockReturnValue(true);
    const authSpy = vi.spyOn(webauthn, "startPasskeyAuthentication").mockResolvedValue({
      id: "cred-1",
      rawId: "cred-1",
      type: "public-key",
      clientExtensionResults: {},
      response: { clientDataJSON: "cd", authenticatorData: "ad", signature: "sig" },
    });

    let signedIn = false;
    const calls = mockFetch(({ method, path }) => {
      if (path === "/api/auth/check") {
        return signedIn ? jsonResponse({ serverHost: "notes.example.com" }) : jsonResponse({ error: "No" }, 401);
      }
      if (method === "POST" && path === "/api/auth/login") {
        return jsonResponse({
          twoFactor: {
            required: true,
            mustEnroll: false,
            methods: ["passkey", "recovery"],
            passkeysAvailable: true,
          },
        });
      }
      if (method === "POST" && path === "/api/auth/2fa/passkey/auth/options") {
        return jsonResponse({ challenge: "ch1", rpId: "localhost" });
      }
      if (method === "POST" && path === "/api/auth/2fa/passkey/auth/verify") {
        signedIn = true;
        return jsonResponse({ verified: true, userId: "u1" });
      }
      if (method === "POST" && path === "/api/auth/logout") {
        return jsonResponse({ message: "ok" });
      }
      return undefined;
    });

    renderLogin();
    signIn("demo@example.com", "demo");

    const passkeyBtn = await screen.findByRole("button", { name: /Use a passkey/i });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByLabelText("Email Address")).toBeTruthy();
    expect(calls.some((c) => c.path === "/api/auth/logout")).toBe(true);

    // Re-enter password and authenticate with passkey
    signIn("demo@example.com", "demo");
    fireEvent.click(await screen.findByRole("button", { name: /Use a passkey/i }));
    expect(await screen.findByText("Signed-in area")).toBeTruthy();
    expect(authSpy).toHaveBeenCalledTimes(1);
    expect(passkeyBtn).toBeTruthy();
  });

  it("walks through mandatory TOTP enrollment and one-time recovery codes before entering notes", async () => {
    vi.spyOn(webauthn, "isWebAuthnSupported").mockReturnValue(true);
    let signedIn = false;
    const recoveryCodes = [
      "AAAA-AAAA-AAAA-AAAA",
      "BBBB-BBBB-BBBB-BBBB",
      "CCCC-CCCC-CCCC-CCCC",
      "DDDD-DDDD-DDDD-DDDD",
      "EEEE-EEEE-EEEE-EEEE",
      "FFFF-FFFF-FFFF-FFFF",
      "GGGG-GGGG-GGGG-GGGG",
      "HHHH-HHHH-HHHH-HHHH",
      "IIII-IIII-IIII-IIII",
      "JJJJ-JJJJ-JJJJ-JJJJ",
    ];
    mockFetch(({ method, path, body }) => {
      if (path === "/api/auth/check") {
        return signedIn ? jsonResponse({ serverHost: "notes.example.com" }) : jsonResponse({ error: "No" }, 401);
      }
      if (method === "POST" && path === "/api/auth/login") {
        return jsonResponse({
          twoFactor: { required: true, mustEnroll: true, methods: [], passkeysAvailable: true },
        });
      }
      if (method === "POST" && path === "/api/auth/2fa/totp/setup") {
        return jsonResponse({
          secret: "JBSWY3DPEHPK3PXP",
          otpauthUri: "otpauth://totp/Joplin%20Web:demo?secret=JBSWY3DPEHPK3PXP",
          qrDataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
        });
      }
      if (method === "POST" && path === "/api/auth/2fa/totp/confirm") {
        const { code } = body as { code: string };
        expect(code).toBe("654321");
        signedIn = true;
        return jsonResponse({ verified: true, userId: "u1", recoveryCodes });
      }
      return undefined;
    });

    renderLogin();
    signIn("demo@example.com", "demo");

    expect(await screen.findByText("Set up two-factor authentication")).toBeTruthy();
    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeTruthy();
    expect(screen.getByAltText("Authenticator app QR code")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Enter the 6-digit code"), { target: { value: "654321" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and continue" }));

    // Recovery codes screen shown once before entering app
    expect(await screen.findByText("Save your recovery codes")).toBeTruthy();
    expect(screen.getByText("AAAA-AAAA-AAAA-AAAA")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy codes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download .txt" })).toBeTruthy();
    // Not yet navigated until user acknowledges saving recovery codes
    expect(screen.getByTestId("location").textContent).toBe("/login");

    fireEvent.click(screen.getByRole("button", { name: "I saved them" }));
    expect(await screen.findByText("Signed-in area")).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe("/notes");
  });

  it("hides Remember me checkbox when server reports rememberMeAvailable=false", async () => {
    const calls = mockFetch(({ path }) => {
      if (path === "/api/auth/check") return jsonResponse({ error: "No session" }, 401);
      if (path === "/api/auth/options") return jsonResponse({ rememberMeAvailable: false });
      return undefined;
    });

    renderLogin();
    await waitFor(() => expect(calls.some((c) => c.path === "/api/auth/options")).toBe(true));
    expect(screen.queryByLabelText("Remember me for 30 days")).toBeNull();
  });

  it("shows Remember me checkbox unchecked by default and sends rememberMe: true when checked", async () => {
    let signedIn = false;
    const calls = mockFetch(({ method, path }) => {
      if (path === "/api/auth/check") {
        return signedIn ? jsonResponse({ serverHost: "notes.example.com" }) : jsonResponse({ error: "No session" }, 401);
      }
      if (path === "/api/auth/options") return jsonResponse({ rememberMeAvailable: true });
      if (method === "POST" && path === "/api/auth/login") {
        signedIn = true;
        return jsonResponse({ userId: "u1" });
      }
      return undefined;
    });

    renderLogin();
    const checkbox = (await screen.findByLabelText("Remember me for 30 days")) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);

    signIn("demo@example.com", "demo");
    expect(await screen.findByText("Signed-in area")).toBeTruthy();
    expect(calls.find((c) => c.path === "/api/auth/login")?.body).toEqual({
      email: "demo@example.com",
      password: "demo",
      rememberMe: true,
    });
  });
});
