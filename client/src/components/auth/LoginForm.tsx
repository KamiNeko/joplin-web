import React, { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import {
  confirmTotp,
  getAuthOptions,
  getPasskeyAuthOptions,
  getPasskeyRegisterOptions,
  isPendingExpiredError,
  setupTotp,
  verifyPasskeyLogin,
  verifyPasskeyRegistration,
  verifyRecoveryLogin,
  verifyTotpLogin,
} from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import type { TotpSetupResponse } from "@/lib/types";
import {
  formatWebAuthnError,
  isWebAuthnSupported,
  startPasskeyAuthentication,
  startPasskeyRegistration,
} from "@/lib/webauthn";
import { RecoveryCodesPanel } from "@/components/auth/RecoveryCodesPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AlertCircle,
  BookOpen,
  Check,
  Copy,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  ShieldCheck,
  Smartphone,
} from "lucide-react";

interface LoginFormProps {
  onSuccess?: () => void;
}

export function LoginForm({ onSuccess }: LoginFormProps) {
  const {
    login,
    lastEmail,
    pendingChallenge,
    completeTwoFactorLogin,
    cancelTwoFactor,
  } = useAuth();

  // Step 1 credentials
  const [email, setEmail] = useState(lastEmail ?? "");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [rememberMeAvailable, setRememberMeAvailable] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Step 2 (verify) & mustEnroll state
  const [verifyModeOverride, setVerifyModeOverride] = useState<"passkey" | "totp" | "recovery" | null>(null);
  const [enrollTabOverride, setEnrollTabOverride] = useState<"totp" | "passkey" | null>(null);
  const [codeInput, setCodeInput] = useState("");
  const [passkeyName, setPasskeyName] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [totpSetup, setTotpSetup] = useState<TotpSetupResponse | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const webAuthnBrowserSupported = isWebAuthnSupported();
  const canUsePasskeys = Boolean(pendingChallenge?.passkeysAvailable) && webAuthnBrowserSupported;
  const activeEnrollTab = enrollTabOverride ?? "totp";
  const enrolledMethods = pendingChallenge?.methods ?? [];
  const hasTotp = enrolledMethods.includes("totp");
  const hasPasskey = enrolledMethods.includes("passkey") && canUsePasskeys;
  const hasRecovery = enrolledMethods.includes("recovery");
  const defaultVerifyMode: "passkey" | "totp" | "recovery" = hasTotp
    ? "totp"
    : hasPasskey
      ? "passkey"
      : "recovery";
  const activeVerifyMode = verifyModeOverride ?? defaultVerifyMode;

  useEffect(() => {
    let cancelled = false;
    void getAuthOptions().then((opts) => {
      if (!cancelled) setRememberMeAvailable(opts.rememberMeAvailable);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!pendingChallenge?.mustEnroll || activeEnrollTab !== "totp" || totpSetup || recoveryCodes) {
      return;
    }
    let cancelled = false;
    setupTotp(true)
      .then((res) => {
        if (!cancelled) setTotpSetup(res);
      })
      .catch((err) => {
        if (!cancelled) {
          setErrorMessage(err instanceof Error ? err.message : "Could not start authenticator setup.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pendingChallenge?.mustEnroll, activeEnrollTab, totpSetup, recoveryCodes]);

  const resetTwoFactorLocalState = () => {
    setVerifyModeOverride(null);
    setEnrollTabOverride(null);
    setCodeInput("");
    setPasskeyName("");
    setTrustDevice(false);
    setTotpSetup(null);
    setSecretCopied(false);
    setRecoveryCodes(null);
  };

  const handlePendingError = async (err: unknown, fallback: string) => {
    const msg = err instanceof Error ? err.message : fallback;
    if (isPendingExpiredError(err)) {
      await cancelTwoFactor(true);
      resetTwoFactorLocalState();
      setPassword("");
    }
    setErrorMessage(msg);
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setErrorMessage("Please enter your email address.");
      return;
    }
    if (!password) {
      setErrorMessage("Please enter your password.");
      return;
    }

    try {
      setIsSubmitting(true);
      resetTwoFactorLocalState();
      const result = await login(trimmedEmail, password, rememberMeAvailable && rememberMe);
      if (!("twoFactor" in result) || !result.twoFactor) {
        onSuccess?.();
      }
    } catch (err: unknown) {
      setErrorMessage(
        err instanceof Error ? err.message : "Authentication failed. Please check your credentials."
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancelTwoFactor = async () => {
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      await cancelTwoFactor(false);
      resetTwoFactorLocalState();
      setPassword("");
      setRememberMe(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleVerifyCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    const trimmed = codeInput.trim();
    if (!trimmed) {
      setErrorMessage(
        activeVerifyMode === "recovery"
          ? "Please enter a recovery code."
          : "Please enter the 6-digit verification code."
      );
      return;
    }

    try {
      setIsSubmitting(true);
      if (activeVerifyMode === "recovery") {
        await verifyRecoveryLogin(trimmed, trustDevice);
      } else {
        await verifyTotpLogin(trimmed, trustDevice);
      }
      await completeTwoFactorLogin(email.trim());
      onSuccess?.();
    } catch (err) {
      await handlePendingError(err, "Verification failed.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePasskeyLogin = async () => {
    setErrorMessage(null);
    try {
      setIsSubmitting(true);
      const options = await getPasskeyAuthOptions();
      const assertion = await startPasskeyAuthentication(options);
      await verifyPasskeyLogin(assertion, trustDevice);
      await completeTwoFactorLogin(email.trim());
      onSuccess?.();
    } catch (err) {
      if (isPendingExpiredError(err)) {
        await handlePendingError(err, "Two-factor verification timed out. Please sign in again.");
      } else {
        setErrorMessage(formatWebAuthnError(err));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirmEnrollTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    const trimmed = codeInput.trim();
    if (!trimmed) {
      setErrorMessage("Enter the 6-digit code from your authenticator app.");
      return;
    }

    try {
      setIsSubmitting(true);
      const result = await confirmTotp(trimmed, { trustDevice, skipAuthRedirect: true });
      setPassword("");
      setCodeInput("");
      if (result.recoveryCodes && result.recoveryCodes.length > 0) {
        setRecoveryCodes(result.recoveryCodes);
      } else {
        await completeTwoFactorLogin(email.trim());
        onSuccess?.();
      }
    } catch (err) {
      await handlePendingError(err, "Could not verify the 6-digit code.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEnrollPasskey = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    try {
      setIsSubmitting(true);
      const options = await getPasskeyRegisterOptions(true);
      const registration = await startPasskeyRegistration(options);
      const result = await verifyPasskeyRegistration(
        {
          response: registration,
          name: passkeyName.trim() || "Passkey",
          trustDevice,
        },
        true
      );
      setPassword("");
      if (result.recoveryCodes && result.recoveryCodes.length > 0) {
        setRecoveryCodes(result.recoveryCodes);
      } else {
        await completeTwoFactorLogin(email.trim());
        onSuccess?.();
      }
    } catch (err) {
      if (isPendingExpiredError(err)) {
        await handlePendingError(err, "Enrollment session timed out. Please sign in again.");
      } else {
        setErrorMessage(formatWebAuthnError(err));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFinishAfterCodes = async () => {
    try {
      setIsSubmitting(true);
      await completeTwoFactorLogin(email.trim());
      onSuccess?.();
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCopyManualSecret = async () => {
    if (!totpSetup) return;
    if (await copyText(totpSetup.secret)) {
      setSecretCopied(true);
      setTimeout(() => setSecretCopied(false), 2000);
    }
  };

  // Header copy tailored to active login step
  const headerTitle = recoveryCodes
    ? "Save your recovery codes"
    : pendingChallenge?.mustEnroll
      ? "Set up two-factor authentication"
      : pendingChallenge
        ? "Two-step verification"
        : "Joplin Web";

  const headerDescription = recoveryCodes
    ? "Store these one-time backup codes before opening your notes"
    : pendingChallenge?.mustEnroll
      ? "Your server requires a second factor before accessing your account"
      : pendingChallenge
        ? "Verify your identity to finish signing in"
        : "Sign in to access your synchronized notes and notebooks";

  return (
    <Card className="w-full max-w-md border-border/60 bg-card/95 backdrop-blur-md shadow-2xl relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-1 bg-primary/80" />

      <CardHeader className="space-y-3 text-center pb-5 pt-7">
        <div className="mx-auto flex h-13 w-13 items-center justify-center rounded-2xl bg-primary/10 text-primary border border-primary/20 shadow-inner">
          {pendingChallenge || recoveryCodes ? (
            <ShieldCheck className="h-7 w-7 text-primary" />
          ) : (
            <BookOpen className="h-7 w-7 text-primary" />
          )}
        </div>
        <div className="space-y-1">
          <CardTitle className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">
            {headerTitle}
          </CardTitle>
          <CardDescription className="text-xs sm:text-sm text-muted-foreground">
            {headerDescription}
          </CardDescription>
        </div>
      </CardHeader>

      {recoveryCodes ? (
        <CardContent className="pb-7">
          <RecoveryCodesPanel
            codes={recoveryCodes}
            onDone={handleFinishAfterCodes}
            doneLabel="I saved them"
            isSubmitting={isSubmitting}
          />
        </CardContent>
      ) : pendingChallenge?.mustEnroll ? (
        <CardContent className="space-y-4 pb-7">
          {errorMessage && (
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive animate-in fade-in-50 duration-200"
            >
              <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
              <div className="leading-snug">{errorMessage}</div>
            </div>
          )}

          {canUsePasskeys && (
            <div role="tablist" aria-label="Choose two-factor method" className="grid grid-cols-2 gap-1.5 rounded-lg bg-muted p-1">
              <button
                type="button"
                role="tab"
                aria-selected={activeEnrollTab === "totp"}
                onClick={() => {
                  setErrorMessage(null);
                  setEnrollTabOverride("totp");
                }}
                className={`flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  activeEnrollTab === "totp"
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Smartphone className="h-3.5 w-3.5" />
                <span>Authenticator app</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeEnrollTab === "passkey"}
                onClick={() => {
                  setErrorMessage(null);
                  setEnrollTabOverride("passkey");
                }}
                className={`flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  activeEnrollTab === "passkey"
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <KeyRound className="h-3.5 w-3.5" />
                <span>Passkey</span>
              </button>
            </div>
          )}

          {activeEnrollTab === "passkey" && canUsePasskeys ? (
            <form onSubmit={handleEnrollPasskey} className="space-y-4">
              <p className="text-xs text-muted-foreground leading-relaxed">
                Use your device biometrics, screen lock, or a hardware security key to protect your account.
              </p>

              <div className="space-y-2">
                <Label htmlFor="enroll-passkey-name" className="text-sm font-medium">
                  Passkey name (optional)
                </Label>
                <Input
                  id="enroll-passkey-name"
                  type="text"
                  placeholder="e.g. Work laptop"
                  value={passkeyName}
                  onChange={(e) => setPasskeyName(e.target.value)}
                  maxLength={64}
                  disabled={isSubmitting}
                />
              </div>

              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                <input
                  id="enroll-trust-device"
                  type="checkbox"
                  checked={trustDevice}
                  onChange={(e) => setTrustDevice(e.target.checked)}
                  className="h-4 w-4 rounded border-border accent-primary"
                  disabled={isSubmitting}
                />
                <span>Trust this device for 30 days</span>
              </label>

              <div className="flex flex-col gap-2 pt-1">
                <Button type="submit" className="w-full" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Waiting for passkey...
                    </>
                  ) : (
                    <>
                      <KeyRound className="mr-2 h-4 w-4" />
                      Add a passkey
                    </>
                  )}
                </Button>
                <Button type="button" variant="ghost" onClick={handleCancelTwoFactor} disabled={isSubmitting}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleConfirmEnrollTotp} className="space-y-4">
              {totpSetup ? (
                <div className="space-y-3">
                  <div className="flex justify-center">
                    <img
                      src={totpSetup.qrDataUrl}
                      alt="Authenticator app QR code"
                      className="h-44 w-44 rounded-lg border border-border bg-white p-2 shadow-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Or enter this setup key manually:</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={handleCopyManualSecret}
                        className="h-7 px-2 text-xs"
                        aria-label="Copy setup key"
                      >
                        {secretCopied ? (
                          <Check className="mr-1 h-3 w-3 text-success" />
                        ) : (
                          <Copy className="mr-1 h-3 w-3" />
                        )}
                        {secretCopied ? "Copied" : "Copy"}
                      </Button>
                    </div>
                    <code
                      data-testid="totp-manual-secret"
                      className="block w-full break-all rounded-md border border-border bg-muted/50 px-2.5 py-2 text-center font-mono text-xs tracking-wider text-foreground select-all"
                    >
                      {totpSetup.secret}
                    </code>
                  </div>
                </div>
              ) : errorMessage ? (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    setErrorMessage(null);
                    setTotpSetup(null);
                    void setupTotp(true)
                      .then(setTotpSetup)
                      .catch((err) => setErrorMessage(err instanceof Error ? err.message : "Setup failed."));
                  }}
                >
                  Retry generating QR code
                </Button>
              ) : (
                <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  <span>Generating authenticator QR code...</span>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="enroll-totp-code" className="text-sm font-medium">
                  Enter the 6-digit code
                </Label>
                <Input
                  id="enroll-totp-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="000000"
                  maxLength={12}
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value)}
                  className="text-center font-mono text-base tracking-[0.25em] bg-background/60"
                  disabled={isSubmitting || !totpSetup}
                  autoFocus
                />
              </div>

              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                <input
                  id="enroll-totp-trust"
                  type="checkbox"
                  checked={trustDevice}
                  onChange={(e) => setTrustDevice(e.target.checked)}
                  className="h-4 w-4 rounded border-border accent-primary"
                  disabled={isSubmitting}
                />
                <span>Trust this device for 30 days</span>
              </label>

              <div className="flex flex-col gap-2 pt-1">
                <Button type="submit" className="w-full" disabled={isSubmitting || !totpSetup}>
                  {isSubmitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Verifying...
                    </>
                  ) : (
                    "Verify and continue"
                  )}
                </Button>
                <Button type="button" variant="ghost" onClick={handleCancelTwoFactor} disabled={isSubmitting}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      ) : pendingChallenge ? (
        <CardContent className="space-y-4 pb-7">
          {errorMessage && (
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive animate-in fade-in-50 duration-200"
            >
              <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
              <div className="leading-snug">{errorMessage}</div>
            </div>
          )}

          {hasPasskey && activeVerifyMode !== "recovery" && (
            <div className="space-y-3">
              {!hasTotp && (
                <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                  <input
                    id="trust-device"
                    type="checkbox"
                    checked={trustDevice}
                    onChange={(e) => setTrustDevice(e.target.checked)}
                    className="h-4 w-4 rounded border-border accent-primary"
                    disabled={isSubmitting}
                  />
                  <span>Trust this device for 30 days</span>
                </label>
              )}

              <Button
                type="button"
                variant={hasTotp ? "outline" : "default"}
                className="w-full h-10"
                onClick={handlePasskeyLogin}
                disabled={isSubmitting}
              >
                {isSubmitting && !codeInput ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <KeyRound className="mr-2 h-4 w-4" />
                )}
                Use a passkey
              </Button>
              {hasTotp && (
                <div className="relative flex items-center text-[11px] uppercase tracking-wider text-muted-foreground">
                  <div className="flex-1 border-t border-border" />
                  <span className="px-2">or</span>
                  <div className="flex-1 border-t border-border" />
                </div>
              )}
            </div>
          )}

          {enrolledMethods.includes("passkey") && !hasTotp && !canUsePasskeys && (
            <p className="rounded-md border border-border bg-muted/40 p-2.5 text-xs text-muted-foreground">
              Passkeys are not available in this browser context. Enter a one-time recovery code to sign in.
            </p>
          )}

          {(activeVerifyMode === "totp" || activeVerifyMode === "recovery") && (
            <form onSubmit={handleVerifyCodeSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="two-factor-code" className="text-sm font-medium">
                  {activeVerifyMode === "recovery" ? "Recovery code" : "Enter the 6-digit code"}
                </Label>
                <Input
                  id="two-factor-code"
                  type="text"
                  inputMode={activeVerifyMode === "recovery" ? "text" : "numeric"}
                  autoComplete={activeVerifyMode === "recovery" ? "off" : "one-time-code"}
                  placeholder={activeVerifyMode === "recovery" ? "XXXX-XXXX-XXXX-XXXX" : "000000"}
                  maxLength={32}
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value)}
                  className={`text-center font-mono text-base bg-background/60 ${
                    activeVerifyMode === "recovery" ? "tracking-wider uppercase" : "tracking-[0.25em]"
                  }`}
                  disabled={isSubmitting}
                  autoFocus
                />
              </div>

              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                <input
                  id="trust-device"
                  type="checkbox"
                  checked={trustDevice}
                  onChange={(e) => setTrustDevice(e.target.checked)}
                  className="h-4 w-4 rounded border-border accent-primary"
                  disabled={isSubmitting}
                />
                <span>Trust this device for 30 days</span>
              </label>

              <div className="flex flex-col gap-2">
                <Button type="submit" className="w-full h-10" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Verifying...
                    </>
                  ) : (
                    "Verify"
                  )}
                </Button>

                {hasRecovery && hasTotp && (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-8 text-xs text-muted-foreground"
                    onClick={() => {
                      setErrorMessage(null);
                      setCodeInput("");
                      setVerifyModeOverride(activeVerifyMode === "recovery" ? "totp" : "recovery");
                    }}
                    disabled={isSubmitting}
                  >
                    {activeVerifyMode === "recovery" ? "Use authenticator code instead" : "Use a recovery code"}
                  </Button>
                )}

                {hasPasskey && !hasTotp && activeVerifyMode === "recovery" && (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-8 text-xs text-muted-foreground"
                    onClick={() => {
                      setErrorMessage(null);
                      setCodeInput("");
                      setVerifyModeOverride("passkey");
                    }}
                    disabled={isSubmitting}
                  >
                    Use passkey instead
                  </Button>
                )}

                <Button type="button" variant="ghost" onClick={handleCancelTwoFactor} disabled={isSubmitting}>
                  Cancel
                </Button>
              </div>
            </form>
          )}

          {activeVerifyMode === "passkey" && (
            <div className="flex flex-col gap-1">
              {hasRecovery && (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-8 text-xs text-muted-foreground"
                  onClick={() => {
                    setErrorMessage(null);
                    setCodeInput("");
                    setVerifyModeOverride("recovery");
                  }}
                  disabled={isSubmitting}
                >
                  Use a recovery code
                </Button>
              )}
              <Button type="button" variant="ghost" onClick={handleCancelTwoFactor} disabled={isSubmitting}>
                Cancel
              </Button>
            </div>
          )}
        </CardContent>
      ) : (
        <form onSubmit={handlePasswordSubmit}>
          <CardContent className="space-y-4">
            {errorMessage && (
              <div
                role="alert"
                className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive animate-in fade-in-50 duration-200"
              >
                <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
                <div className="leading-snug">{errorMessage}</div>
              </div>
            )}

            <div className="space-y-2">
              <div>
                <Label htmlFor="email" className="text-sm font-medium">
                  Email Address
                </Label>
              </div>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="email"
                  type="email"
                  placeholder="name@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  autoFocus={!lastEmail}
                  className="pl-9 bg-background/60 focus-visible:ring-primary"
                  disabled={isSubmitting}
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password" className="text-sm font-medium">
                  Password
                </Label>
              </div>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="password"
                  type="password"
                  autoFocus={Boolean(lastEmail)}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="pl-9 bg-background/60 focus-visible:ring-primary"
                  disabled={isSubmitting}
                />
              </div>
            </div>

            {rememberMeAvailable && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                <input
                  id="remember-me"
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="h-4 w-4 rounded border-border accent-primary"
                  disabled={isSubmitting}
                />
                <span>Remember me for 30 days</span>
              </label>
            )}
          </CardContent>

          <CardFooter className="pt-2 pb-8">
            <Button
              type="submit"
              className="w-full font-medium h-10 transition-all duration-200"
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Signing in...
                </>
              ) : (
                "Sign In"
              )}
            </Button>
          </CardFooter>
        </form>
      )}
    </Card>
  );
}
