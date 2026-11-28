import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  confirmTotp,
  deletePasskey,
  getPasskeyRegisterOptions,
  getPasskeys,
  getRememberedSignIns,
  getStepUpPasskeyOptions,
  getTrustedDevices,
  getTwoFactorStatus,
  regenerateRecoveryCodes,
  removeTotp,
  renamePasskey,
  revokeAllRememberedSignIns,
  revokeAllTrustedDevices,
  revokeRememberedSignIn,
  revokeTrustedDevice,
  setupTotp,
  stepUpWithPasskey,
  stepUpWithRecovery,
  stepUpWithTotp,
  verifyPasskeyRegistration,
} from "@/lib/api";
import { startPasskeyAuthentication, startPasskeyRegistration } from "@/lib/webauthn";
import type { PasskeyItem, RememberedSignInItem, TrustedDeviceItem, TwoFactorStatus } from "@/lib/types";

export const TWO_FACTOR_KEY_PREFIX = ["auth", "2fa"] as const;
export const TWO_FACTOR_STATUS_KEY = ["auth", "2fa", "status"] as const;
export const PASSKEYS_KEY = ["auth", "2fa", "passkeys"] as const;
export const TRUSTED_DEVICES_KEY = ["auth", "2fa", "trusted-devices"] as const;
export const REMEMBERED_SIGN_INS_KEY = ["auth", "2fa", "remembered"] as const;

export function useTwoFactorStatus(enabled = true) {
  return useQuery<TwoFactorStatus, Error>({
    queryKey: TWO_FACTOR_STATUS_KEY,
    queryFn: getTwoFactorStatus,
    enabled,
    staleTime: 15 * 1000,
  });
}

export function usePasskeys(enabled = true) {
  return useQuery<PasskeyItem[], Error>({
    queryKey: PASSKEYS_KEY,
    queryFn: getPasskeys,
    enabled,
  });
}

export function useTrustedDevices(enabled = true) {
  return useQuery<TrustedDeviceItem[], Error>({
    queryKey: TRUSTED_DEVICES_KEY,
    queryFn: getTrustedDevices,
    enabled,
  });
}

export function useRememberedSignIns(enabled = true) {
  return useQuery<RememberedSignInItem[], Error>({
    queryKey: REMEMBERED_SIGN_INS_KEY,
    queryFn: getRememberedSignIns,
    enabled,
  });
}

export function useSetupTotpMutation() {
  return useMutation({
    mutationFn: () => setupTotp(false),
  });
}

export function useConfirmTotpMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => confirmTotp(code),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TWO_FACTOR_KEY_PREFIX });
    },
  });
}

export function useRemoveTotpMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: removeTotp,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TWO_FACTOR_KEY_PREFIX });
    },
  });
}

export function useAddPasskeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const options = await getPasskeyRegisterOptions(false);
      const response = await startPasskeyRegistration(options);
      return verifyPasskeyRegistration({ response, name }, false);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TWO_FACTOR_KEY_PREFIX });
    },
  });
}

export function useRenamePasskeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => renamePasskey(id, name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PASSKEYS_KEY });
    },
  });
}

export function useDeletePasskeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deletePasskey(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TWO_FACTOR_KEY_PREFIX });
    },
  });
}

export function useRegenerateRecoveryCodesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: regenerateRecoveryCodes,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TWO_FACTOR_KEY_PREFIX });
    },
  });
}

export function useRevokeAllTrustedDevicesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: revokeAllTrustedDevices,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TWO_FACTOR_KEY_PREFIX });
    },
  });
}

export function useRevokeTrustedDeviceMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revokeTrustedDevice(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TRUSTED_DEVICES_KEY });
    },
  });
}

export function useRevokeAllRememberedSignInsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: revokeAllRememberedSignIns,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: REMEMBERED_SIGN_INS_KEY });
    },
  });
}

export function useRevokeRememberedSignInMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revokeRememberedSignIn(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: REMEMBERED_SIGN_INS_KEY });
    },
  });
}

export function useStepUpTotpMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => stepUpWithTotp(code),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TWO_FACTOR_STATUS_KEY });
    },
  });
}

export function useStepUpPasskeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const options = await getStepUpPasskeyOptions();
      const assertion = await startPasskeyAuthentication(options);
      return stepUpWithPasskey(assertion);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TWO_FACTOR_STATUS_KEY });
    },
  });
}

export function useStepUpRecoveryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => stepUpWithRecovery(code),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TWO_FACTOR_KEY_PREFIX });
    },
  });
}
