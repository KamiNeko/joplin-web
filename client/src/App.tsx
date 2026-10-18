import React from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
} from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { ThemeProvider } from "@/components/common/ThemeProvider";
import { LoginPage } from "@/pages/LoginPage";
import { NotesPage } from "@/pages/NotesPage";
import { Toaster } from "@/components/ui/sonner";
import { Loader2 } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useConnectionState } from "@/hooks/use-connection";
import { SessionExpiredDialog } from "@/components/common/Dialogs";

// Focus refetches are handled by useAutoRefresh (throttled, skips notes with unsaved edits)
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      // useAutoRefresh handles "online" too, and skips notes with unsaved edits
      refetchOnReconnect: false,
      // Retry once when the server is unreachable or failing; a 4xx won't change on retry
      retry: (failureCount, error) =>
        failureCount < 1 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
    },
  },
});

/**
 * Asks the user to sign in again once a request was rejected with 401.
 */
function SessionExpiredPrompt() {
  const { isAuthenticated, signInAgain, discardAndSignOut } = useAuth();
  const { sessionExpired } = useConnectionState();
  return (
    <SessionExpiredDialog
      open={isAuthenticated && sessionExpired}
      onSignIn={signInAgain}
      onDiscard={discardAndSignOut}
    />
  );
}

/**
 * Route guard that requires an authenticated session.
 */
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-xs text-muted-foreground font-mono">Loading Joplin Web...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="dark" storageKey="joplin-theme">
        <AuthProvider>
          <BrowserRouter>
            <Routes>
              {/* Public route */}
              <Route path="/login" element={<LoginPage />} />

              {/* Protected notes routes */}
              <Route
                path="/notes"
                element={
                  <ProtectedRoute>
                    <NotesPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/notes/:id"
                element={
                  <ProtectedRoute>
                    <NotesPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/notebooks/:id"
                element={
                  <ProtectedRoute>
                    <NotesPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/notebooks/:notebookId/notes/:id"
                element={
                  <ProtectedRoute>
                    <NotesPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/trash"
                element={
                  <ProtectedRoute>
                    <NotesPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/trash/:id"
                element={
                  <ProtectedRoute>
                    <NotesPage />
                  </ProtectedRoute>
                }
              />

              {/* Redirect root and unknown routes to /notes */}
              <Route path="/" element={<Navigate to="/notes" replace />} />
              <Route path="*" element={<Navigate to="/notes" replace />} />
            </Routes>
            <SessionExpiredPrompt />
          </BrowserRouter>
          <Toaster richColors position="bottom-right" />
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
