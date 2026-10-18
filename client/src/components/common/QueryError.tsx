import { AlertCircle, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface QueryErrorProps {
  /** Short summary, e.g. "Couldn't load notes" */
  message: string;
  /** Underlying error; its message is shown as detail */
  error?: Error | null;
  onRetry?: () => void;
  isRetrying?: boolean;
  /** Small inline variant for sidebar sections */
  compact?: boolean;
  className?: string;
}

/**
 * Small hint for a refetch that failed while earlier data stays on screen, so stale data isn't
 * mistaken for current data.
 */
export function StaleDataHint({
  onRetry,
  isRetrying = false,
  className,
}: {
  onRetry?: () => void;
  isRetrying?: boolean;
  className?: string;
}) {
  return (
    <div role="status" className={cn("flex items-center gap-1.5 text-[11px] text-muted-foreground", className)}>
      <AlertCircle className="h-3 w-3 shrink-0 text-warning" aria-hidden="true" />
      <span className="min-w-0">Couldn't refresh. Showing earlier data.</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={isRetrying}
          className="shrink-0 rounded-sm font-medium text-foreground underline-offset-2 hover:underline disabled:opacity-60 outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {isRetrying ? "Retrying…" : "Retry"}
        </button>
      )}
    </div>
  );
}

/**
 * Error state for a failed query, with a Retry button. Used wherever a failed load would
 * otherwise look like an empty list.
 */
export function QueryError({ message, error, onRetry, isRetrying = false, compact = false, className }: QueryErrorProps) {
  const retryButton = onRetry && (
    <Button
      variant="outline"
      size="sm"
      className={cn("gap-1.5", compact ? "h-7 px-2 text-xs" : "h-8 mt-3")}
      onClick={onRetry}
      disabled={isRetrying}
    >
      {isRetrying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
      Retry
    </Button>
  );

  if (compact) {
    return (
      <div role="alert" className={cn("px-2 py-1 space-y-1.5", className)}>
        <p className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {message}
        </p>
        {retryButton}
      </div>
    );
  }

  return (
    <div role="alert" className={cn("flex flex-col items-center justify-center h-64 text-center px-4", className)}>
      <div className="h-12 w-12 rounded-full bg-destructive/10 text-destructive flex items-center justify-center mb-3">
        <AlertCircle className="h-6 w-6" />
      </div>
      <h4 className="text-sm font-semibold text-foreground">{message}</h4>
      {error?.message && (
        <p className="text-xs text-muted-foreground mt-1 max-w-[260px] wrap-break-word">{error.message}</p>
      )}
      {retryButton}
    </div>
  );
}
