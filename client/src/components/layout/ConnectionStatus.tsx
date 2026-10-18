import { useState } from "react";
import { AlertCircle, Loader2, RefreshCw, WifiOff } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useConnectionState, useConnectionStatus, useRefresh } from "@/hooks/use-connection";
import { ConnectionState } from "@/lib/connection";
import { formatVersion } from "@/lib/version";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

function StatusIcon({ state }: { state: ConnectionState }) {
  if (state === "saving" || state === "refreshing") {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden="true" />;
  }
  if (state === "offline") return <WifiOff className="h-3.5 w-3.5 text-warning" aria-hidden="true" />;
  if (state === "error" || state === "expired") {
    return <AlertCircle className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />;
  }
  return <span className="h-2 w-2 mx-[3px] rounded-full bg-success/80" aria-hidden="true" />;
}

/**
 * Connection status at the bottom of the sidebar. Every state comes from real request data; the
 * popover shows server, account, last refresh and error, a Refresh button and the app version.
 */
export function ConnectionStatus() {
  const { email, serverHost } = useAuth();
  const { refresh, isRefreshing } = useRefresh();
  const status = useConnectionStatus(isRefreshing);
  const { lastError, lastUpdatedAt } = useConnectionState();
  const isProblem = status.state === "error" || status.state === "expired" || status.state === "offline";

  // Screen readers hear problems and the recovery, not every routine "Refreshing…"
  // (adjusted while rendering, React re-renders right away with the new state)
  const [announcement, setAnnouncement] = useState("");
  const [hadProblem, setHadProblem] = useState(false);
  if (isProblem) {
    if (!hadProblem) setHadProblem(true);
    if (announcement !== status.label) setAnnouncement(status.label);
  } else if (hadProblem && (status.state === "updated" || status.state === "connected")) {
    setHadProblem(false);
    setAnnouncement("Connection restored");
  }

  return (
    <div className="border-t border-border/40 px-3 py-2">
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-left transition-colors hover:bg-sidebar-accent/60 outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
              isProblem ? "text-foreground" : "text-muted-foreground"
            )}
            title={lastUpdatedAt ? `Last updated ${formatTime(lastUpdatedAt)}` : undefined}
            aria-label={`Connection status: ${status.label}. Show details`}
          >
            <StatusIcon state={status.state} />
            <span className="truncate">{status.label}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-64 p-3 text-xs space-y-3">
          <div className="flex items-center gap-2 font-semibold text-foreground">
            <StatusIcon state={status.state} />
            {status.label}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
            <dt className="text-muted-foreground">Server</dt>
            <dd className="truncate text-foreground" title={serverHost ?? undefined}>
              {serverHost ?? "Unknown"}
            </dd>
            <dt className="text-muted-foreground">Account</dt>
            <dd className="truncate text-foreground" title={email ?? undefined}>
              {email ?? "Unknown"}
            </dd>
            <dt className="text-muted-foreground">Updated</dt>
            <dd className="text-foreground">{lastUpdatedAt ? formatTime(lastUpdatedAt) : "Not yet"}</dd>
            {lastError && (
              <>
                <dt className="text-muted-foreground">Last error</dt>
                <dd className="text-destructive wrap-break-word">
                  {lastError.message}
                  <span className="block text-muted-foreground">{formatTime(lastError.at)}</span>
                </dd>
              </>
            )}
          </dl>
          <Button
            size="sm"
            variant="outline"
            className="w-full h-8 gap-1.5"
            onClick={() => void refresh()}
            disabled={isRefreshing}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
            {isRefreshing ? "Refreshing…" : "Refresh"}
          </Button>
          <p className="text-[11px] text-muted-foreground">Joplin Web {formatVersion()}</p>
        </PopoverContent>
      </Popover>
    </div>
  );
}
