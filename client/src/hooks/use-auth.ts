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
import { resetConnection } from "@/lib/connection";
import { clearAllDrafts } from "@/lib/drafts";

export interface AuthContextType {
  isAuthenticated: boolean;
  email: string | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Host of the connected Joplin Server, for display */
  serverHost: string | null;
  /** Leaves an expired session for the login page; unsaved drafts are kept */
  signInAgain: () => void;
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

  useEffect(() => {
    let cancelled = false;
    checkSession()
      .then((session) => {
        if (cancelled) return;
        if (session) {
          setIsAuthenticated(true);
          setEmail(getStoredEmail());
          setServerHost(session.serverHost);
        } else {
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

  const login = useCallback(
    async (email: string, password: string) => {
      setIsLoading(true);
      try {
        await apiLogin(email, password);
        // Never show data cached for a previous session
        queryClient.clear();
        clearResourceCache();
        resetConnection();
        setStoredEmail(email);
        setEmail(email);
        setIsAuthenticated(true);
        // Only for display: not awaited, and a failure doesn't fail the login
        void checkSession()
          .then((session) => setServerHost(session?.serverHost ?? null))
          .catch(() => undefined);
      } finally {
        setIsLoading(false);
      }
    },
    [queryClient]
  );

  const signInAgain = useCallback(() => {
    // Unmounting the pages closes open editors; their drafts stay in localStorage for restore
    queryClient.clear();
    clearResourceCache();
    clearStoredSession();
    setIsAuthenticated(false);
    setEmail(null);
  }, [queryClient]);

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
    serverHost,
    signInAgain,
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
