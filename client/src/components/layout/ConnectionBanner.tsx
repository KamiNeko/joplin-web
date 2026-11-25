import { useEffect, useState } from "react";
import { CheckCircle2, LogIn, WifiOff } from "lucide-react";
import { useConnectionState, useOnline } from "@/hooks/use-connection";
import { Button } from "@/components/ui/button";

const BACK_ONLINE_MS = 3000;

/**
 * Slim banner above the main view while the browser is offline, and briefly "Back online" after.
 * Also while a sign-in proxy in front of the app (e.g. Cloudflare Access) wants its login page: only
 * a reload can show it. Unreachable servers (while online) are shown by the sidebar status instead.
 */
export function ConnectionBanner() {
  const online = useOnline();
  const { signInRedirect } = useConnectionState();
  const [showBackOnline, setShowBackOnline] = useState(false);
  // Going online shows "Back online", going offline hides it (adjusted while rendering)
  const [prevOnline, setPrevOnline] = useState(online);
  if (online !== prevOnline) {
    setPrevOnline(online);
    setShowBackOnline(online);
  }

  useEffect(() => {
    if (!showBackOnline) return;
    const id = window.setTimeout(() => setShowBackOnline(false), BACK_ONLINE_MS);
    return () => window.clearTimeout(id);
  }, [showBackOnline]);

  return (
    <div role="status" aria-live="polite">
      {!online ? (
        <div className="flex items-center gap-2 px-4 py-1.5 text-xs border-b border-warning/30 bg-warning/10 text-foreground">
          <WifiOff className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
          <span>You're offline. Changes can't be saved right now.</span>
        </div>
      ) : signInRedirect ? (
        <div className="flex items-center gap-2 px-4 py-1.5 text-xs border-b border-warning/30 bg-warning/10 text-foreground">
          <LogIn className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
          <span className="flex-1 min-w-0">Your sign-in to this site has expired. Reload to sign in again; unsaved edits are kept.</span>
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      ) : showBackOnline ? (
        <div className="flex items-center gap-2 px-4 py-1.5 text-xs border-b border-success/30 bg-success/10 text-foreground">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
          <span>Back online</span>
        </div>
      ) : null}
    </div>
  );
}
