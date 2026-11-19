import { useState } from "react";
import { Check, Copy, Download, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";

interface RecoveryCodesPanelProps {
  codes: string[];
  onDone: () => void | Promise<void>;
  doneLabel?: string;
  isSubmitting?: boolean;
}

/**
 * Displays single-use recovery codes once with Copy and Download (.txt) actions.
 */
export function RecoveryCodesPanel({
  codes,
  onDone,
  doneLabel = "I saved them",
  isSubmitting = false,
}: RecoveryCodesPanelProps) {
  const [copied, setCopied] = useState(false);

  const codesText = codes.join("\n") + "\n";

  const handleCopy = async () => {
    const ok = await copyText(codesText);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownload = () => {
    const blob = new Blob([`Joplin Web recovery codes\nKeep these somewhere safe. Each code works once.\n\n${codesText}`], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "joplin-web-recovery-codes.txt";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-foreground">
        <ShieldAlert className="h-4 w-4 shrink-0 text-warning mt-0.5" />
        <p className="leading-relaxed">
          Save these recovery codes somewhere safe. Each code works once if you lose access to your authenticator app or passkey, and they will not be shown again.
        </p>
      </div>

      <ul
        aria-label="Recovery codes"
        className="grid grid-cols-1 sm:grid-cols-2 gap-2 rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs"
      >
        {codes.map((code) => (
          <li
            key={code}
            className="rounded border border-border/60 bg-background/80 px-2 py-1.5 text-center whitespace-nowrap select-all tracking-normal text-foreground"
          >
            {code}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={handleCopy} className="flex-1 min-w-[130px]">
          {copied ? <Check className="mr-1.5 h-3.5 w-3.5 text-success" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy codes"}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={handleDownload} className="flex-1 min-w-[130px]">
          <Download className="mr-1.5 h-3.5 w-3.5" />
          Download .txt
        </Button>
      </div>

      <Button type="button" className="w-full" onClick={() => void onDone()} disabled={isSubmitting}>
        {doneLabel}
      </Button>
    </div>
  );
}
