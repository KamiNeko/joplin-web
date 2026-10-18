import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";
import { APP_VERSION, GIT_SHA_SHORT } from "@/lib/version";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  isPending?: boolean;
  onConfirm: () => void;
}

/**
 * Yes/no confirmation dialog for irreversible actions.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  destructive = false,
  isPending = false,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={isPending}
          >
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface PromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  isPending?: boolean;
  onSubmit: (value: string) => void;
}

/**
 * Single text field dialog (e.g. notebook name).
 */
export function PromptDialog({
  open,
  onOpenChange,
  title,
  description,
  initialValue = "",
  placeholder,
  confirmLabel = "Save",
  isPending = false,
  onSubmit,
}: PromptDialogProps) {
  const [value, setValue] = useState(initialValue);

  // Reset to initialValue whenever the dialog opens or it changes (adjusted while rendering)
  const [synced, setSynced] = useState({ open, initialValue });
  if (synced.open !== open || synced.initialValue !== initialValue) {
    setSynced({ open, initialValue });
    if (open) setValue(initialValue);
  }

  const trimmed = value.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed && !isPending) onSubmit(trimmed);
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <Input
            autoFocus
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!trimmed || isPending}>
              {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const REPO_URL = "https://github.com/KamiNeko/joplin-web";

/**
 * "About Joplin Web": version and commit of this build, with links for release notes and bug reports.
 */
export function AboutDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const links = [
    { label: "GitHub", href: REPO_URL },
    { label: "Changelog", href: `${REPO_URL}/blob/main/CHANGELOG.md` },
    { label: "Report an issue", href: `${REPO_URL}/issues` },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>About Joplin Web</DialogTitle>
          <DialogDescription>A web client for self-hosted Joplin Server.</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">Version</dt>
          <dd className="font-mono text-foreground">{APP_VERSION}</dd>
          <dt className="text-muted-foreground">Commit</dt>
          <dd className="font-mono text-foreground">{GIT_SHA_SHORT ?? "unknown"}</dd>
        </dl>
        <p className="text-xs text-muted-foreground">Please include the version when you report a bug.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline-offset-4 hover:underline rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {link.label}
            </a>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Shown when a request was rejected with 401. Not dismissible: nothing works until the user signs
 * in again. Unsaved editor text stays on this device and is offered for restore afterwards.
 */
export function SessionExpiredDialog({
  open,
  onSignIn,
  onDiscard,
}: {
  open: boolean;
  onSignIn: () => void;
  /** Signs out and deletes unsaved changes stored on this device (shared computers) */
  onDiscard: () => void;
}) {
  return (
    <Dialog open={open}>
      <DialogContent
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        className="sm:max-w-sm [&>button:last-child]:hidden"
      >
        <DialogHeader>
          <DialogTitle>Session expired</DialogTitle>
          <DialogDescription>Sign in again to continue. Unsaved changes are kept on this device.</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onDiscard}>
            Sign out and discard
          </Button>
          <Button autoFocus onClick={onSignIn}>
            Sign in again
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
