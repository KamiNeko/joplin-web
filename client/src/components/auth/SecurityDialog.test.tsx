import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import * as webauthn from "@/lib/webauthn";
import { jsonResponse, mockFetch } from "@/test/fetch-mock";
import { renderWithProviders } from "@/test/render";
import { SecurityDialog } from "./SecurityDialog";

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("SecurityDialog", () => {
  it("hides add-passkey when WebAuthn is unsupported and supports TOTP setup", async () => {
    vi.spyOn(webauthn, "isWebAuthnSupported").mockReturnValue(false);
    let totpEnabled = false;
    mockFetch(({ method, path }) => {
      if (path === "/api/auth/2fa/status") {
        return jsonResponse({
          persistenceEnabled: true,
          require2fa: false,
          passkeysAvailable: true,
          enrolled: { totp: totpEnabled, passkeysCount: 0, recoveryCodesRemaining: totpEnabled ? 10 : 0 },
          methods: totpEnabled ? ["totp", "recovery"] : [],
          stepUpValid: true,
          stepUpExpiresAt: Date.now() + 300_000,
        });
      }
      if (path === "/api/auth/2fa/passkeys") return jsonResponse({ passkeys: [] });
      if (path === "/api/auth/2fa/trusted-devices") return jsonResponse({ devices: [] });
      if (method === "POST" && path === "/api/auth/2fa/totp/setup") {
        return jsonResponse({
          secret: "TESTSECRETKEY23456",
          otpauthUri: "otpauth://totp/Joplin%20Web:u1?secret=TESTSECRETKEY23456",
          qrDataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
        });
      }
      if (method === "POST" && path === "/api/auth/2fa/totp/confirm") {
        totpEnabled = true;
        return jsonResponse({
          enrolled: true,
          recoveryCodes: [
            "1111-1111-1111-1111",
            "2222-2222-2222-2222",
            "3333-3333-3333-3333",
            "4444-4444-4444-4444",
            "5555-5555-5555-5555",
            "6666-6666-6666-6666",
            "7777-7777-7777-7777",
            "8888-8888-8888-8888",
            "9999-9999-9999-9999",
            "AAAA-BBBB-CCCC-DDDD",
          ],
        });
      }
      return undefined;
    });

    renderWithProviders(<SecurityDialog open={true} onOpenChange={() => undefined} />);

    expect(await screen.findByText("Security settings")).toBeTruthy();
    expect(await screen.findByText("Authenticator app")).toBeTruthy();
    // Passkeys creation hidden cleanly when unsupported and zero enrolled
    expect(screen.queryByRole("button", { name: /Add passkey/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Set up" }));
    expect(await screen.findByText("TESTSECRETKEY23456")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Enter the 6-digit code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify & enable" }));

    expect(await screen.findByText("1111-1111-1111-1111")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText("Enabled")).toBeTruthy();
  });

  it("handles passkeys, trusted device revocation, step-up authentication, and REQUIRE_2FA lock", async () => {
    vi.spyOn(webauthn, "isWebAuthnSupported").mockReturnValue(true);
    let stepUpValid = false;
    let passkeys = [
      { id: "pk1", name: "Laptop", createdAt: Date.now() - 86_400_000, lastUsedAt: Date.now() },
    ];
    let devices = [
      {
        id: "dev1",
        label: "Chrome on Linux",
        createdAt: Date.now() - 3600_000,
        lastUsedAt: Date.now(),
        expiresAt: Date.now() + 25 * 86_400_000,
        current: true,
      },
    ];

    const calls = mockFetch(({ method, path, body }) => {
      if (path === "/api/auth/2fa/status") {
        return jsonResponse({
          persistenceEnabled: true,
          require2fa: true,
          passkeysAvailable: true,
          enrolled: { totp: false, passkeysCount: passkeys.length, recoveryCodesRemaining: 10 },
          methods: ["passkey", "recovery"],
          stepUpValid,
          stepUpExpiresAt: stepUpValid ? Date.now() + 300_000 : null,
        });
      }
      if (path === "/api/auth/2fa/passkeys") return jsonResponse({ passkeys });
      if (path === "/api/auth/2fa/trusted-devices") {
        if (method === "DELETE") {
          if (!stepUpValid) {
            return jsonResponse({ error: "Step up", stepUpRequired: true, methods: ["passkey", "recovery"] }, 403);
          }
          devices = [];
          return jsonResponse({ revokedAll: true });
        }
        return jsonResponse({ devices });
      }
      if (method === "PUT" && path === "/api/auth/2fa/passkeys/pk1") {
        passkeys = [{ ...passkeys[0], name: (body as { name: string }).name }];
        return jsonResponse({ passkey: passkeys[0] });
      }
      if (method === "POST" && path === "/api/auth/2fa/step-up/recovery") {
        stepUpValid = true;
        return jsonResponse({ verified: true, stepUpExpiresAt: Date.now() + 300_000, recoveryCodesRemaining: 9 });
      }
      return undefined;
    });

    renderWithProviders(<SecurityDialog open={true} onOpenChange={() => undefined} />);

    expect(await screen.findByText("Laptop")).toBeTruthy();
    expect(screen.getByText("Chrome on Linux")).toBeTruthy();
    expect(screen.getByText("This device")).toBeTruthy();

    // Only 1 factor under REQUIRE_2FA=true -> remove button disabled
    expect((screen.getByRole("button", { name: "Remove passkey Laptop" }) as HTMLButtonElement).disabled).toBe(true);

    // Revoking all trusted devices without step-up triggers inline step-up verification
    fireEvent.click(screen.getByRole("button", { name: "Revoke all" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));

    expect(await screen.findByText("Identity verification required")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Recovery code"), { target: { value: "AAAA-BBBB-CCCC-DDDD" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText("Identity verified for 5 minutes.")).toBeTruthy();

    // Now revoke all succeeds
    fireEvent.click(screen.getByRole("button", { name: "Revoke all" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("No trusted devices remembered.")).toBeTruthy();

    // Rename passkey
    fireEvent.click(screen.getByRole("button", { name: "Rename passkey Laptop" }));
    fireEvent.change(screen.getByLabelText("New passkey name"), { target: { value: "Work MacBook" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/api/auth/2fa/passkeys/pk1")).toBe(true));
    expect(await screen.findByText("Work MacBook")).toBeTruthy();
  });
});
