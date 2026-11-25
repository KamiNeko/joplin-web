import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from "react";
import { flushSync } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  login as apiLogin,
  logout as apiLogout,
  checkSession,
  clearResourceCache,
  getStoredEmail,
  setStoredEmail,
  clearStoredSession,
  waitForPendingWrites,
} from "@/lib/api";
import { getConnectionSnapshot, resetConnection } from "@/lib/connection";
import { onRemoteWrite, setCrossTabUser } from "@/lib/cross-tab";
import { clearAllDrafts, draftOwner, setDraftOwner } from "@/lib/drafts";
import { invalidateAllExceptUnsaved } from "./use-connection";
import type { LoginResponse, TwoFactorChallenge } from "@/lib/types";

export interface AuthContextType {
  isAuthenticated: boolean;
  email: string | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<LoginResponse>;
  logout: () => Promise<void>;
  /** Active two-factor challenge when login needs a second step or mandatory enrollment */
  pendingChallenge: TwoFactorChallenge | null;
  pendingEmail: string | null;
  /** Promotes the client auth state after a two-factor verification or enrollment succeeds */
  completeTwoFactorLogin: (overrideEmail?: string) => Promise<void>;
  /** Cancels an in-progress two-factor login and ends the pending server session */
  cancelTwoFactor: (clearChallengeOnly?: boolean) => Promise<void>;
  /** Host of the connected Joplin Server, for display */
  serverHost: string | null;
  /** Leaves an expired session for the login page; unsaved drafts are kept */
  signInAgain: () => void;
  /** Leaves an expired session and deletes all drafts on this device */
  discardAndSignOut: () => void;
  /** Email of the expired session, to pre-fill the login form */
  lastEmail: string | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export interface AuthProviderProps {
  children: React.ReactNode;
}

/**
 * Holds the sign-in state. The session token is an httpOnly cookie the client can't read, so the
 * session is checked with the server on startup.
 */
export function AuthProvider({ children }: AuthProviderProps) {
  const queryClient = useQueryClient();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [serverHost, setServerHost] = useState<string | null>(null);
  const [lastEmail, setLastEmail] = useState<string | null>(null);
  const [pendingChallenge, setPendingChallenge] = useState<TwoFactorChallenge | null>(null);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    checkSession()
      .then((session) => {
        if (cancelled) return;
        if (session) {
          const storedEmail = getStoredEmail();
          const owner = draftOwner(storedEmail, session.serverHost);
          setDraftOwner(owner);
          setCrossTabUser(owner);
          setIsAuthenticated(true);
          setEmail(storedEmail);
          setServerHost(session.serverHost);
        } else {
          setCrossTabUser(null);
          clearStoredSession();
        }
      })
      .catch(() => {
        // Server unreachable: show the login page, which reports the error on submit
      })
      .finally(() => !cancelled && setIsLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    return onRemoteWrite(() => {
      if (getConnectionSnapshot().sessionExpired) return;
      void invalidateAllExceptUnsaved(queryClient);
    });
  }, [isAuthenticated, queryClient]);

  const finalizeSession = useCallback(
    async (userEmail: string) => {
      // The server host is part of the draft owner; a failed check doesn't fail the login
      const host = (await checkSession().catch(() => null))?.serverHost ?? null;
      // Never show data cached for a previous session
      queryClient.clear();
      clearResourceCache();
      resetConnection();
      // Drafts of another account (or server) are dropped, not offered
      const owner = draftOwner(userEmail, host);
      setDraftOwner(owner);
      setCrossTabUser(owner);
      setStoredEmail(userEmail);
      setEmail(userEmail);
      setServerHost(host);
      setLastEmail(null);
      setPendingChallenge(null);
      setPendingEmail(null);
      setIsAuthenticated(true);
    },
    [queryClient]
  );

  const login = useCallback(
    async (userEmail: string, password: string): Promise<LoginResponse> => {
      const response = await apiLogin(userEmail, password);
      if ("twoFactor" in response && response.twoFactor) {
        setPendingChallenge(response.twoFactor);
        setPendingEmail(userEmail);
        return response;
      }
      await finalizeSession(userEmail);
      return response;
    },
    [finalizeSession]
  );

  const completeTwoFactorLogin = useCallback(
    async (overrideEmail?: string) => {
      const activeEmail = overrideEmail ?? pendingEmail ?? email ?? "";
      await finalizeSession(activeEmail);
    },
    [email, finalizeSession, pendingEmail]
  );

  const cancelTwoFactor = useCallback(async (clearChallengeOnly = false) => {
    if (!clearChallengeOnly) {
      await apiLogout().catch(() => undefined);
    }
    setPendingChallenge(null);
    setPendingEmail(null);
  }, []);

  const endSession = useCallback(() => {
    queryClient.clear();
    clearResourceCache();
    clearStoredSession();
    setCrossTabUser(null);
    setPendingChallenge(null);
    setPendingEmail(null);
    // Unmount the pages now: open editors close (their drafts are already stored)
    flushSync(() => {
      setIsAuthenticated(false);
      setEmail(null);
    });
  }, [queryClient]);

  const signInAgain = useCallback(() => {
    // Drafts stay in localStorage and are offered again after signing in as the same user
    setLastEmail(email);
    endSession();
  }, [email, endSession]);

  const discardAndSignOut = useCallback(() => {
    setLastEmail(null);
    endSession();
    clearAllDrafts();
    setDraftOwner(null);
    setServerHost(null);
    // Clears the (already invalid) session cookie; failures don't matter here
    void apiLogout();
  }, [endSession]);

  const logout = useCallback(async () => {
    // isLoading unmounts the protected pages right away; open editors flush unsaved changes
    // while the session is still valid, and logout waits for those saves.
    flushSync(() => setIsLoading(true));
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await waitForPendingWrites();
      await apiLogout();
    } finally {
      queryClient.clear();
      clearResourceCache();
      clearStoredSession();
      // Drafts of unsaved text must not outlive the session on a shared device
      clearAllDrafts();
      setDraftOwner(null);
      setCrossTabUser(null);
      setLastEmail(null);
      setPendingChallenge(null);
      setPendingEmail(null);
      setIsAuthenticated(false);
      setEmail(null);
      setServerHost(null);
      setIsLoading(false);
    }
  }, [queryClient]);

  const value: AuthContextType = {
    isAuthenticated,
    email,
    isLoading,
    login,
    logout,
    pendingChallenge,
    pendingEmail,
    completeTwoFactorLogin,
    cancelTwoFactor,
    serverHost,
    signInAgain,
    discardAndSignOut,
    lastEmail,
  };

  return React.createElement(AuthContext.Provider, { value }, children);
}

/**
 * Hook to access Joplin auth context.
 */
export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
