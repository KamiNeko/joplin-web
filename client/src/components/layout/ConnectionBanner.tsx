import { useEffect, useRef, useState } from "react";
import { CheckCircle2, WifiOff } from "lucide-react";
import { useOnline } from "@/hooks/use-connection";

const BACK_ONLINE_MS = 3000;

/**
 * Slim banner above the main view while the browser is offline, and briefly "Back online" after.
 * Unreachable servers (while online) are shown by the sidebar status instead.
 */
export function ConnectionBanner() {
  const online = useOnline();
  const [showBackOnline, setShowBackOnline] = useState(false);
  const wasOffline = useRef(!online);

  useEffect(() => {
    if (!online) {
      wasOffline.current = true;
      setShowBackOnline(false);
      return;
    }
    if (!wasOffline.current) return;
    wasOffline.current = false;
    setShowBackOnline(true);
    const id = window.setTimeout(() => setShowBackOnline(false), BACK_ONLINE_MS);
    return () => window.clearTimeout(id);
  }, [online]);

  return (
    <div role="status" aria-live="polite">
      {!online ? (
        <div className="flex items-center gap-2 px-4 py-1.5 text-xs border-b border-warning/30 bg-warning/10 text-foreground">
          <WifiOff className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
          <span>You're offline. Changes can't be saved right now.</span>
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
