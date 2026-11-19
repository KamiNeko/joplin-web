import React, { useState } from "react";
import {
  useAddPasskeyMutation,
  useConfirmTotpMutation,
  useDeletePasskeyMutation,
  usePasskeys,
  useRegenerateRecoveryCodesMutation,
  useRemoveTotpMutation,
  useRenamePasskeyMutation,
  useRevokeAllTrustedDevicesMutation,
  useRevokeTrustedDeviceMutation,
  useSetupTotpMutation,
  useStepUpPasskeyMutation,
  useStepUpRecoveryMutation,
  useStepUpTotpMutation,
  useTrustedDevices,
  useTwoFactorStatus,
} from "@/hooks/use-two-factor";
import { getStepUpMethodsFromError, isStepUpRequiredError } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import type { TotpSetupResponse, TwoFactorMethod } from "@/lib/types";
import { formatWebAuthnError, isWebAuthnSupported } from "@/lib/webauthn";
import { RecoveryCodesPanel } from "@/components/auth/RecoveryCodesPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertCircle,
  Check,
  Copy,
  KeyRound,
  Laptop,
  Loader2,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Trash2,
} from "lucide-react";

interface SecurityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type ConfirmAction =
  | { type: "removeTotp" }
  | { type: "removePasskey"; id: string; name: string }
  | { type: "regenRecovery" }
  | { type: "revokeAllDevices" };

function formatDate(ms: number | null): string {
  if (!ms) return "Never";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function SecurityDialog({ open, onOpenChange }: SecurityDialogProps) {
  const statusQuery = useTwoFactorStatus(open);
  const status = statusQuery.data;
  const persistenceEnabled = Boolean(status?.persistenceEnabled);

  const passkeysQuery = usePasskeys(open && persistenceEnabled);
  const devicesQuery = useTrustedDevices(open && persistenceEnabled);

  const setupTotpMutation = useSetupTotpMutation();
  const confirmTotpMutation = useConfirmTotpMutation();
  const removeTotpMutation = useRemoveTotpMutation();
  const addPasskeyMutation = useAddPasskeyMutation();
  const renamePasskeyMutation = useRenamePasskeyMutation();
  const deletePasskeyMutation = useDeletePasskeyMutation();
  const regenRecoveryMutation = useRegenerateRecoveryCodesMutation();
  const revokeAllMutation = useRevokeAllTrustedDevicesMutation();
  const revokeOneMutation = useRevokeTrustedDeviceMutation();
  const stepUpTotpMutation = useStepUpTotpMutation();
  const stepUpPasskeyMutation = useStepUpPasskeyMutation();
  const stepUpRecoveryMutation = useStepUpRecoveryMutation();

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recoveryCodesShown, setRecoveryCodesShown] = useState<string[] | null>(null);

  // TOTP enrollment state
  const [totpSetup, setTotpSetup] = useState<TotpSetupResponse | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [secretCopied, setSecretCopied] = useState(false);

  // Passkey enrollment/rename state
  const [showAddPasskey, setShowAddPasskey] = useState(false);
  const [newPasskeyName, setNewPasskeyName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingValue, setRenamingValue] = useState("");

  // Step-up inline verification state
  const [stepUpMethods, setStepUpMethods] = useState<TwoFactorMethod[] | null>(null);
  const [stepUpMode, setStepUpMode] = useState<"totp" | "recovery">("totp");
  const [stepUpCode, setStepUpCode] = useState("");

  // Inline confirmation state
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  const browserSupported = isWebAuthnSupported();
  const canAddPasskey = Boolean(status?.passkeysAvailable) && browserSupported;
  const passkeys = passkeysQuery.data ?? [];
  const devices = devicesQuery.data ?? [];
  const hasPrimary = Boolean(status?.enrolled.totp) || (status?.enrolled.passkeysCount ?? 0) > 0;
  const isLastFactorLocked = Boolean(status?.require2fa);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setError(null);
      setNotice(null);
      setRecoveryCodesShown(null);
      setTotpSetup(null);
      setTotpCode("");
      setShowAddPasskey(false);
      setNewPasskeyName("");
      setRenamingId(null);
      setStepUpMethods(null);
      setStepUpCode("");
      setConfirmAction(null);
    }
    onOpenChange(nextOpen);
  };

  const handleMutationError = (err: unknown, fallback: string) => {
    if (isStepUpRequiredError(err)) {
      const methods = getStepUpMethodsFromError(err);
      setStepUpMethods(methods.length > 0 ? methods : status?.methods ?? []);
      setStepUpMode(methods.includes("totp") ? "totp" : "recovery");
      setStepUpCode("");
      setConfirmAction(null);
      setError("Please verify your identity before changing security settings.");
      return;
    }
    setError(err instanceof Error ? err.message : fallback);
  };

  const openStepUpPrompt = () => {
    const methods = status?.methods ?? [];
    setError(null);
    setNotice(null);
    setStepUpMethods(methods);
    setStepUpMode(methods.includes("totp") ? "totp" : "recovery");
    setStepUpCode("");
  };

  const handleStartTotpSetup = async () => {
    setError(null);
    setNotice(null);
    try {
      const data = await setupTotpMutation.mutateAsync();
      setTotpSetup(data);
      setTotpCode("");
    } catch (err) {
      handleMutationError(err, "Could not start authenticator setup.");
    }
  };

  const handleConfirmTotpSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await confirmTotpMutation.mutateAsync(totpCode.trim());
      setTotpSetup(null);
      setTotpCode("");
      setNotice("Authenticator app enabled.");
      if (res.recoveryCodes && res.recoveryCodes.length > 0) {
        setRecoveryCodesShown(res.recoveryCodes);
      }
    } catch (err) {
      handleMutationError(err, "Could not verify the 6-digit code.");
    }
  };

  const handleAddPasskey = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const res = await addPasskeyMutation.mutateAsync(newPasskeyName.trim() || "Passkey");
      setShowAddPasskey(false);
      setNewPasskeyName("");
      setNotice("Passkey added.");
      if (res.recoveryCodes && res.recoveryCodes.length > 0) {
        setRecoveryCodesShown(res.recoveryCodes);
      }
    } catch (err) {
      if (isStepUpRequiredError(err)) {
        handleMutationError(err, "Verification required.");
      } else {
        setError(formatWebAuthnError(err));
      }
    }
  };

  const handleSaveRename = async (id: string) => {
    const trimmed = renamingValue.trim();
    if (!trimmed) return;
    setError(null);
    try {
      await renamePasskeyMutation.mutateAsync({ id, name: trimmed });
      setRenamingId(null);
      setRenamingValue("");
      setNotice("Passkey renamed.");
    } catch (err) {
      handleMutationError(err, "Could not rename passkey.");
    }
  };

  const handleConfirmAction = async () => {
    if (!confirmAction) return;
    setError(null);
    setNotice(null);
    const action = confirmAction;
    setConfirmAction(null);
    try {
      if (action.type === "removeTotp") {
        await removeTotpMutation.mutateAsync();
        setNotice("Authenticator app removed.");
      } else if (action.type === "removePasskey") {
        await deletePasskeyMutation.mutateAsync(action.id);
        setNotice(`Removed passkey "${action.name}".`);
      } else if (action.type === "regenRecovery") {
        const codes = await regenRecoveryMutation.mutateAsync();
        setRecoveryCodesShown(codes);
      } else if (action.type === "revokeAllDevices") {
        await revokeAllMutation.mutateAsync();
        setNotice("All trusted devices have been revoked.");
      }
    } catch (err) {
      handleMutationError(err, "Action failed.");
    }
  };

  const handleStepUpCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = stepUpCode.trim();
    if (!trimmed) {
      setError("Enter a verification code.");
      return;
    }
    try {
      if (stepUpMode === "recovery") {
        await stepUpRecoveryMutation.mutateAsync(trimmed);
      } else {
        await stepUpTotpMutation.mutateAsync(trimmed);
      }
      setStepUpMethods(null);
      setStepUpCode("");
      setNotice("Identity verified for 5 minutes.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed.");
    }
  };

  const handleStepUpPasskey = async () => {
    setError(null);
    try {
      await stepUpPasskeyMutation.mutateAsync();
      setStepUpMethods(null);
      setStepUpCode("");
      setNotice("Identity verified for 5 minutes.");
    } catch (err) {
      setError(formatWebAuthnError(err));
    }
  };

  const handleCopySecret = async () => {
    if (!totpSetup) return;
    if (await copyText(totpSetup.secret)) {
      setSecretCopied(true);
      setTimeout(() => setSecretCopied(false), 2000);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            <span>Security settings</span>
          </DialogTitle>
          <DialogDescription>
            Manage two-factor authentication, passkeys, recovery codes, and trusted devices.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
          >
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {notice && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-lg border border-success/40 bg-success/10 p-3 text-xs text-foreground"
          >
            <Check className="h-4 w-4 shrink-0 text-success mt-0.5" />
            <span>{notice}</span>
          </div>
        )}

        {statusQuery.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span>Loading security settings...</span>
          </div>
        ) : recoveryCodesShown ? (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">New recovery codes</h3>
            <RecoveryCodesPanel
              codes={recoveryCodesShown}
              doneLabel="Done"
              onDone={() => setRecoveryCodesShown(null)}
            />
          </div>
        ) : !persistenceEnabled ? (
          <div className="rounded-lg border border-border bg-muted/40 p-4 text-xs text-muted-foreground leading-relaxed">
            Two-factor authentication is unavailable because persistent storage (<code>CACHE_DIR</code>) is not configured on this server.
          </div>
        ) : (
          <div className="space-y-5 text-sm">
            {/* Step-up prompt */}
            {stepUpMethods && (
              <section
                aria-label="Verify your identity"
                className="rounded-lg border border-primary/40 bg-primary/5 p-3.5 space-y-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-primary">
                    Identity verification required
                  </h3>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => setStepUpMethods(null)}
                  >
                    Dismiss
                  </Button>
                </div>

                {stepUpMethods.includes("passkey") && canAddPasskey && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="w-full"
                    onClick={handleStepUpPasskey}
                    disabled={stepUpPasskeyMutation.isPending}
                  >
                    {stepUpPasskeyMutation.isPending ? (
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <KeyRound className="mr-2 h-3.5 w-3.5" />
                    )}
                    Verify with a passkey
                  </Button>
                )}

                {(stepUpMethods.includes("totp") || stepUpMethods.includes("recovery")) && (
                  <form onSubmit={handleStepUpCodeSubmit} className="space-y-2">
                    <Label htmlFor="stepup-code" className="text-xs">
                      {stepUpMode === "recovery" ? "Recovery code" : "Authenticator 6-digit code"}
                    </Label>
                    <div className="flex flex-wrap gap-2">
                      <Input
                        id="stepup-code"
                        value={stepUpCode}
                        onChange={(e) => setStepUpCode(e.target.value)}
                        placeholder={stepUpMode === "recovery" ? "XXXX-XXXX-XXXX-XXXX" : "000000"}
                        className="flex-1 min-w-[160px] font-mono text-sm"
                        autoFocus
                      />
                      <Button
                        type="submit"
                        size="sm"
                        disabled={stepUpTotpMutation.isPending || stepUpRecoveryMutation.isPending}
                      >
                        Verify
                      </Button>
                    </div>
                    {stepUpMethods.includes("totp") && stepUpMethods.includes("recovery") && (
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        className="h-6 px-0 text-xs text-muted-foreground"
                        onClick={() => {
                          setStepUpCode("");
                          setStepUpMode(stepUpMode === "recovery" ? "totp" : "recovery");
                        }}
                      >
                        {stepUpMode === "recovery" ? "Use authenticator code instead" : "Use a recovery code"}
                      </Button>
                    )}
                  </form>
                )}
              </section>
            )}

            {/* Step-up readiness bar when 2FA is active and step-up isn't cached yet */}
            {hasPrimary && !status?.stepUpValid && !stepUpMethods && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs">
                <span className="text-muted-foreground">
                  Recent verification required before changing factors.
                </span>
                <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={openStepUpPrompt}>
                  Verify identity
                </Button>
              </div>
            )}

            {/* Inline destructive/sensitive confirmation bar */}
            {confirmAction && (
              <div
                role="alertdialog"
                aria-label="Confirm security change"
                className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 space-y-2.5 text-xs"
              >
                <p className="font-medium text-foreground">
                  {confirmAction.type === "removeTotp" && "Remove authenticator app from this account?"}
                  {confirmAction.type === "removePasskey" && `Remove passkey "${confirmAction.name}"?`}
                  {confirmAction.type === "regenRecovery" &&
                    "Generate 10 new recovery codes? All previous unused recovery codes will stop working."}
                  {confirmAction.type === "revokeAllDevices" &&
                    "Revoke all trusted devices? All browsers will ask for a second factor on next sign-in."}
                </p>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmAction(null)}>
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant={confirmAction.type === "regenRecovery" ? "default" : "destructive"}
                    size="sm"
                    onClick={handleConfirmAction}
                  >
                    Confirm
                  </Button>
                </div>
              </div>
            )}

            {/* Authenticator app */}
            <section className="rounded-lg border border-border p-3.5 space-y-3" aria-label="Authenticator app">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Smartphone className="h-4 w-4 text-primary" />
                  <h3 className="font-medium text-foreground">Authenticator app</h3>
                  <Badge variant={status?.enrolled.totp ? "secondary" : "outline"} className="text-[11px]">
                    {status?.enrolled.totp ? "Enabled" : "Not set up"}
                  </Badge>
                </div>
                {status?.enrolled.totp ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmAction({ type: "removeTotp" })}
                    disabled={
                      removeTotpMutation.isPending || (isLastFactorLocked && status.enrolled.passkeysCount === 0)
                    }
                    title={
                      isLastFactorLocked && status.enrolled.passkeysCount === 0
                        ? "Add a passkey first while REQUIRE_2FA is enabled"
                        : undefined
                    }
                  >
                    Remove
                  </Button>
                ) : !totpSetup ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleStartTotpSetup}
                    disabled={setupTotpMutation.isPending}
                  >
                    {setupTotpMutation.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                    Set up
                  </Button>
                ) : null}
              </div>

              {totpSetup && (
                <form onSubmit={handleConfirmTotpSetup} className="space-y-3 pt-1 border-t border-border">
                  <div className="flex justify-center pt-2">
                    <img
                      src={totpSetup.qrDataUrl}
                      alt="Authenticator QR code"
                      className="h-40 w-40 rounded-lg border border-border bg-white p-2"
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Manual setup key:</span>
                      <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={handleCopySecret}>
                        {secretCopied ? <Check className="mr-1 h-3 w-3 text-success" /> : <Copy className="mr-1 h-3 w-3" />}
                        {secretCopied ? "Copied" : "Copy"}
                      </Button>
                    </div>
                    <code className="block break-all rounded border border-border bg-muted/50 px-2.5 py-1.5 text-center font-mono text-xs select-all">
                      {totpSetup.secret}
                    </code>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="settings-totp-code" className="text-xs">
                      Enter the 6-digit code
                    </Label>
                    <div className="flex flex-wrap gap-2">
                      <Input
                        id="settings-totp-code"
                        inputMode="numeric"
                        placeholder="000000"
                        value={totpCode}
                        onChange={(e) => setTotpCode(e.target.value)}
                        className="flex-1 min-w-[140px] font-mono text-center tracking-widest"
                      />
                      <Button type="submit" size="sm" disabled={confirmTotpMutation.isPending}>
                        Verify & enable
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setTotpSetup(null);
                          setTotpCode("");
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                </form>
              )}
            </section>

            {/* Passkeys */}
            {(canAddPasskey || passkeys.length > 0) && (
              <section className="rounded-lg border border-border p-3.5 space-y-3" aria-label="Passkeys">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <KeyRound className="h-4 w-4 text-primary" />
                    <h3 className="font-medium text-foreground">Passkeys</h3>
                    <Badge variant="outline" className="text-[11px]">
                      {passkeys.length}
                    </Badge>
                  </div>
                  {canAddPasskey && !showAddPasskey && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setError(null);
                        setShowAddPasskey(true);
                      }}
                    >
                      Add passkey
                    </Button>
                  )}
                </div>

                {canAddPasskey && showAddPasskey && (
                  <form onSubmit={handleAddPasskey} className="space-y-2 pt-2 border-t border-border">
                    <Label htmlFor="settings-passkey-name" className="text-xs">
                      Passkey name
                    </Label>
                    <div className="flex flex-wrap gap-2">
                      <Input
                        id="settings-passkey-name"
                        placeholder="e.g. Hardware key"
                        value={newPasskeyName}
                        onChange={(e) => setNewPasskeyName(e.target.value)}
                        maxLength={64}
                        className="flex-1 min-w-[160px]"
                        autoFocus
                      />
                      <Button type="submit" size="sm" disabled={addPasskeyMutation.isPending}>
                        {addPasskeyMutation.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                        Register
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setShowAddPasskey(false);
                          setNewPasskeyName("");
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}

                {passkeys.length > 0 ? (
                  <ul className="divide-y divide-border">
                    {passkeys.map((pk) => {
                      const cannotRemoveLast =
                        isLastFactorLocked && !status?.enrolled.totp && passkeys.length === 1;
                      return (
                        <li key={pk.id} className="py-2.5 first:pt-1 last:pb-0 space-y-2">
                          {renamingId === pk.id ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <Input
                                aria-label="New passkey name"
                                value={renamingValue}
                                onChange={(e) => setRenamingValue(e.target.value)}
                                maxLength={64}
                                className="flex-1 min-w-[150px] h-8 text-xs"
                                autoFocus
                              />
                              <Button
                                type="button"
                                size="sm"
                                className="h-8"
                                onClick={() => void handleSaveRename(pk.id)}
                                disabled={renamePasskeyMutation.isPending}
                              >
                                Save
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-8"
                                onClick={() => setRenamingId(null)}
                              >
                                Cancel
                              </Button>
                            </div>
                          ) : (
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="min-w-0">
                                <p className="font-medium text-foreground truncate">{pk.name}</p>
                                <p className="text-[11px] text-muted-foreground">
                                  Added {formatDate(pk.createdAt)} · Last used {formatDate(pk.lastUsedAt)}
                                </p>
                              </div>
                              <div className="flex items-center gap-1">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-xs"
                                  aria-label={`Rename passkey ${pk.name}`}
                                  onClick={() => {
                                    setRenamingId(pk.id);
                                    setRenamingValue(pk.name);
                                  }}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                                  aria-label={`Remove passkey ${pk.name}`}
                                  disabled={cannotRemoveLast || deletePasskeyMutation.isPending}
                                  title={
                                    cannotRemoveLast
                                      ? "Add another factor first while REQUIRE_2FA is enabled"
                                      : undefined
                                  }
                                  onClick={() =>
                                    setConfirmAction({ type: "removePasskey", id: pk.id, name: pk.name })
                                  }
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">No passkeys registered yet.</p>
                )}
              </section>
            )}

            {/* Recovery codes */}
            {hasPrimary && (
              <section className="rounded-lg border border-border p-3.5 space-y-2" aria-label="Recovery codes">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <RefreshCw className="h-4 w-4 text-primary" />
                    <h3 className="font-medium text-foreground">Recovery codes</h3>
                    <Badge variant="outline" className="text-[11px]">
                      {status?.enrolled.recoveryCodesRemaining ?? 0} remaining
                    </Badge>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmAction({ type: "regenRecovery" })}
                    disabled={regenRecoveryMutation.isPending}
                  >
                    Regenerate codes
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  One-time codes let you sign in if you lose access to your authenticator app or passkeys.
                </p>
              </section>
            )}

            {/* Trusted devices */}
            {(hasPrimary || devices.length > 0) && (
              <section className="rounded-lg border border-border p-3.5 space-y-3" aria-label="Trusted devices">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Laptop className="h-4 w-4 text-primary" />
                    <h3 className="font-medium text-foreground">Trusted devices</h3>
                  </div>
                  {devices.length > 0 && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setConfirmAction({ type: "revokeAllDevices" })}
                      disabled={revokeAllMutation.isPending}
                    >
                      Revoke all
                    </Button>
                  )}
                </div>

                {devices.length > 0 ? (
                  <ul className="divide-y divide-border">
                    {devices.map((device) => (
                      <li
                        key={device.id}
                        className="py-2 first:pt-0 last:pb-0 flex flex-wrap items-center justify-between gap-2"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium text-foreground truncate">{device.label}</span>
                            {device.current && (
                              <Badge variant="secondary" className="text-[10px]">
                                This device
                              </Badge>
                            )}
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            Last used {formatDate(device.lastUsedAt)} · Expires {formatDate(device.expiresAt)}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                          aria-label={`Revoke trusted device ${device.label}`}
                          disabled={revokeOneMutation.isPending}
                          onClick={async () => {
                            setError(null);
                            try {
                              await revokeOneMutation.mutateAsync(device.id);
                            } catch (err) {
                              handleMutationError(err, "Could not revoke trusted device.");
                            }
                          }}
                        >
                          Revoke
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">No trusted devices remembered.</p>
                )}
              </section>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
