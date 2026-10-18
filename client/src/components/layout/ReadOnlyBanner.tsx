import { Lock } from "lucide-react";
import { asSentence } from "@/lib/format";

/**
 * Banner above the main view while the account is read-only (end-to-end encryption). `reason` is
 * the server's explanation; without one a generic E2EE note is shown.
 */
export function ReadOnlyBanner({ reason }: { reason: string | null }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2 px-4 py-1.5 text-xs border-b border-primary/30 bg-primary/10 text-foreground"
    >
      <Lock className="h-3.5 w-3.5 mt-px shrink-0 text-primary" aria-hidden="true" />
      <p className="min-w-0">
        <strong className="font-semibold">Read-only.</strong>{" "}
        {reason ? asSentence(reason) : "This account uses end-to-end encryption, which Joplin Web can't write."}{" "}
        <span className="text-muted-foreground">Use the Joplin desktop or mobile app to make changes.</span>
      </p>
    </div>
  );
}
