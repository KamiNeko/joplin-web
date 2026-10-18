import { Component, ErrorInfo, ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Rendered instead of the children once one of them threw while rendering */
  fallback: (error: Error) => ReactNode;
}

/**
 * Catches render errors (including a failed React.lazy import) below it. Give it a new `key` to
 * try the children again.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Render error", error, info.componentStack);
  }

  render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}

/**
 * Last-resort screen when the app itself failed to render.
 */
export function AppCrashScreen() {
  return (
    <div role="alert" className="flex h-screen w-full items-center justify-center bg-background p-6 text-center">
      <div className="flex max-w-sm flex-col items-center gap-3">
        <AlertTriangle className="h-8 w-8 text-destructive" aria-hidden="true" />
        <h1 className="text-lg font-semibold text-foreground">Something went wrong</h1>
        <p className="text-sm text-muted-foreground">
          Joplin Web hit an unexpected error. Unsaved changes are kept on this device; reload to continue.
        </p>
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </div>
    </div>
  );
}
