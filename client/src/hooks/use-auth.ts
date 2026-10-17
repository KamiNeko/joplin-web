import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from "react";
import {
  login as apiLogin,
  logout as apiLogout,
  getStoredSessionId,
  getStoredEmail,
  setStoredSession,
  clearStoredSession,
} from "@/lib/api";

export interface AuthContextType {
  isAuthenticated: boolean;
  sessionId: string | null;
  email: string | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export interface AuthProviderProps {
  children: React.ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  useEffect(() => {
    try {
      const stored = getStoredSessionId();
      if (stored) {
        setSessionId(stored);
        setEmail(getStoredEmail());
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setIsLoading(true);
    try {
      const response = await apiLogin(email, password);
      setSessionId(response.sessionId);
      setEmail(email);
      setStoredSession(response.sessionId, response.userId, email);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    setIsLoading(true);
    try {
      await apiLogout();
    } finally {
      clearStoredSession();
      setSessionId(null);
      setEmail(null);
      setIsLoading(false);
    }
  }, []);

  const value: AuthContextType = {
    isAuthenticated: Boolean(sessionId),
    sessionId,
    email,
    isLoading,
    login,
    logout,
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
