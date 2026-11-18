import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/browser";

/**
 * Checks whether the current browser context supports WebAuthn passkeys.
 * Note: browsers disallow IP literals (such as 127.0.0.1) as RP IDs and require a secure
 * context (https:// or http://localhost).
 */
export function isWebAuthnSupported(): boolean {
  if (typeof window === "undefined") return false;
  if (!window.isSecureContext) return false;
  const host = window.location?.hostname ?? "";
  if (!host || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")) {
    return false;
  }
  return browserSupportsWebAuthn();
}

export async function startPasskeyRegistration(
  optionsJSON: PublicKeyCredentialCreationOptionsJSON
): Promise<RegistrationResponseJSON> {
  return startRegistration({ optionsJSON });
}

export async function startPasskeyAuthentication(
  optionsJSON: PublicKeyCredentialRequestOptionsJSON
): Promise<AuthenticationResponseJSON> {
  return startAuthentication({ optionsJSON });
}

/**
 * Maps browser WebAuthn / DOMException errors to concise user-facing messages.
 */
export function formatWebAuthnError(err: unknown): string {
  if (err && typeof err === "object" && "name" in err) {
    const name = String((err as { name: unknown }).name);
    if (name === "NotAllowedError") {
      return "Passkey prompt was cancelled or timed out. Try again or use another method.";
    }
    if (name === "InvalidStateError") {
      return "This passkey is already registered on this account.";
    }
    if (name === "SecurityError") {
      return "Passkeys are not allowed on this address.";
    }
  }
  return err instanceof Error ? err.message : "Passkey verification failed.";
}
