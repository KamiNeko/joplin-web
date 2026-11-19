import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  Bookmark,
  Check,
  Copy,
  ExternalLink,
  FileUp,
  Globe,
  Loader2,
  Mail,
  Webhook,
} from "lucide-react";
import { toast } from "sonner";
import { AppLayout } from "@/components/layout/AppLayout";
import { Sidebar } from "@/components/layout/Sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConflictNotes } from "@/hooks/use-notes";
import { useNotebooks } from "@/hooks/use-notebooks";
import { useOrganizeJobs, useOrganizeStatus } from "@/hooks/use-organize";
import { useClipUrl, useIngestEmail } from "@/hooks/use-workspace";
import { useWriteState } from "@/hooks/use-write-state";
import { copyText } from "@/lib/clipboard";
import { flattenNotebooks } from "@/lib/notebooks";
import type { Note } from "@/lib/types";
import { cn } from "@/lib/utils";

type CaptureTab = "web" | "email";
type EmailInputMode = "raw" | "fields";

function extractInitialUrl(params: URLSearchParams): string {
  const direct = params.get("url")?.trim();
  if (direct) return direct;
  const text = params.get("text") ?? "";
  const match = /https?:\/\/\S+/i.exec(text);
  return match ? match[0] : "";
}

function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export function ClipPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialUrl = extractInitialUrl(searchParams);

  const [headerSearch, setHeaderSearch] = useState("");
  const [tab, setTab] = useState<CaptureTab>("web");

  // Web Clipper state
  const [clipUrlValue, setClipUrlValue] = useState(initialUrl);
  const [clipNotebookOverride, setClipNotebookOverride] = useState("");
  const [clipTags, setClipTags] = useState("clipped");
  const [includeSourceBanner, setIncludeSourceBanner] = useState(true);
  const [clippedNote, setClippedNote] = useState<Note | null>(null);
  const [copiedBookmarklet, setCopiedBookmarklet] = useState(false);

  // Email Ingest state
  const [emailMode, setEmailMode] = useState<EmailInputMode>("raw");
  const [rawEml, setRawEml] = useState("");
  const [emailSubject, setEmailSubject] = useState(() => searchParams.get("title") ?? "");
  const [emailFrom, setEmailFrom] = useState("");
  const [emailBody, setEmailBody] = useState(() => (initialUrl ? "" : searchParams.get("text") ?? ""));
  const [emailNotebookOverride, setEmailNotebookOverride] = useState("");
  const [emailTags, setEmailTags] = useState("email");
  const [ingestedNote, setIngestedNote] = useState<Note | null>(null);

  const { readOnly, reason: readOnlyReason } = useWriteState();
  const { data: notebooks } = useNotebooks();
  const { data: conflictNotes } = useConflictNotes();
  const { data: organizeStatus } = useOrganizeStatus();
  const { data: organizeJobsData } = useOrganizeJobs(Boolean(organizeStatus?.enabled));
  const clipMutation = useClipUrl();
  const emailMutation = useIngestEmail();

  const organizeJobs = organizeJobsData?.jobs ?? [];
  const hasRunningJob = organizeJobs.some((j) => j.status === "running");

  const writableNotebooks = useMemo(
    () => flattenNotebooks(notebooks).filter((nb) => !nb.encrypted),
    [notebooks]
  );

  const defaultNotebookId = useMemo(() => {
    const lower = (s: string) => s.trim().toLowerCase();
    const inbox =
      writableNotebooks.find((nb) => lower(nb.title) === "inbox") ??
      writableNotebooks.find((nb) => lower(nb.title) === "pending to sort");
    return inbox?.id ?? writableNotebooks[0]?.id ?? "";
  }, [writableNotebooks]);

  const clipParentId = clipNotebookOverride || defaultNotebookId;
  const emailParentId = emailNotebookOverride || defaultNotebookId;

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const bookmarkletCode = `javascript:(()=>{window.open('${origin}/clip?url='+encodeURIComponent(location.href),'_blank');})();`;

  const handleClipSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const url = clipUrlValue.trim();
    if (!url || readOnly) return;
    try {
      const res = await clipMutation.mutateAsync({
        url,
        ...(clipParentId ? { parentId: clipParentId } : {}),
        tags: parseTags(clipTags),
        includeSourceBanner,
      });
      setClippedNote(res.note);
      toast.success(`Clipped "${res.extractedTitle || res.note.title}"`);
    } catch (err) {
      toast.error("Web clip failed", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const handleEmailFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const content = await file.text();
      setEmailMode("raw");
      setRawEml(content);
      toast.info(`Loaded ${file.name}`);
    } catch (err) {
      toast.error("Could not read .eml file", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (readOnly) return;
    try {
      const tags = parseTags(emailTags);
      const res = await emailMutation.mutateAsync(
        emailMode === "raw"
          ? {
              raw: rawEml,
              ...(emailParentId ? { parentId: emailParentId } : {}),
              tags,
            }
          : {
              subject: emailSubject,
              from: emailFrom,
              text: emailBody,
              ...(emailParentId ? { parentId: emailParentId } : {}),
              tags,
            }
      );
      setIngestedNote(res.note);
      toast.success(`Imported email "${res.note.title}"`);
    } catch (err) {
      toast.error("Email import failed", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const handleCopyBookmarklet = async () => {
    await copyText(bookmarkletCode);
    setCopiedBookmarklet(true);
    toast.success("Bookmarklet copied");
    window.setTimeout(() => setCopiedBookmarklet(false), 2000);
  };

  return (
    <AppLayout
      notebookTitle="Clip & Import"
      searchQuery={headerSearch}
      onSearchChange={(q) => {
        setHeaderSearch(q);
        if (q.trim().length >= 2) {
          navigate(`/notes?q=${encodeURIComponent(q.trim())}`);
        }
      }}
      readOnly={readOnly}
      readOnlyReason={readOnlyReason}
      sidebar={({ onCloseMobile, aiEnabled, onOpenAskAi }) => (
        <Sidebar
          selectedNotebookId={null}
          selectedTagId={null}
          activeView="clip"
          conflictCount={conflictNotes?.length ?? 0}
          organizeJobCount={organizeJobs.length}
          runningOrganizeJob={hasRunningJob}
          aiEnabled={aiEnabled}
          onOpenAskAi={onOpenAskAi}
          onSelectConflicts={() => {
            navigate("/conflicts");
            onCloseMobile?.();
          }}
          onSelectOrganize={() => {
            navigate("/organize");
            onCloseMobile?.();
          }}
          onSelectAllNotes={() => {
            navigate("/notes");
            onCloseMobile?.();
          }}
          onSelectTrash={() => {
            navigate("/trash");
            onCloseMobile?.();
          }}
          onSelectNotebook={(id) => {
            navigate(`/notebooks/${id}`);
            onCloseMobile?.();
          }}
          onSelectTag={(id) => {
            navigate(`/notes?tag=${encodeURIComponent(id)}`);
            onCloseMobile?.();
          }}
          searchQuery={headerSearch}
          onSearchChange={(q) => {
            setHeaderSearch(q);
            if (q.trim().length >= 2) {
              navigate(`/notes?q=${encodeURIComponent(q.trim())}`);
              onCloseMobile?.();
            }
          }}
          onCloseMobile={onCloseMobile}
          readOnly={readOnly}
        />
      )}
    >
      <div className="h-full overflow-y-auto px-4 py-5 sm:px-8 sm:py-6">
        <div className="mx-auto max-w-3xl space-y-6">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
              <Globe className="h-5 w-5 text-primary" aria-hidden="true" />
              Web Clipper & Email Import
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Convert clean readable articles from URLs or import `.eml` messages directly into your notebooks.
            </p>
          </div>

          <div role="tablist" aria-label="Capture method" className="inline-flex rounded-lg bg-muted p-1">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "web"}
              onClick={() => setTab("web")}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                tab === "web" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Globe className="h-3.5 w-3.5" aria-hidden="true" />
              Web Clipper
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "email"}
              onClick={() => setTab("email")}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                tab === "email"
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Mail className="h-3.5 w-3.5" aria-hidden="true" />
              Email / .eml Import
            </button>
          </div>

          {tab === "web" ? (
            <div className="space-y-5">
              <form onSubmit={(e) => void handleClipSubmit(e)} className="rounded-xl border border-border bg-card/50 p-5 space-y-4">
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-foreground">Article URL</span>
                  <Input
                    type="url"
                    required
                    value={clipUrlValue}
                    onChange={(e) => setClipUrlValue(e.target.value)}
                    placeholder="https://example.com/article"
                    aria-label="Article URL"
                    disabled={readOnly || clipMutation.isPending}
                  />
                </label>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-foreground">Target notebook</span>
                    <select
                      value={clipParentId}
                      onChange={(e) => setClipNotebookOverride(e.target.value)}
                      aria-label="Clipper target notebook"
                      disabled={readOnly || clipMutation.isPending}
                      className="w-full h-9 rounded-md border border-input bg-background px-2.5 text-sm text-foreground"
                    >
                      {writableNotebooks.map((nb) => (
                        <option key={nb.id} value={nb.id}>
                          {"— ".repeat(nb.depth)}
                          {nb.title}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-foreground">Tags (comma separated)</span>
                    <Input
                      value={clipTags}
                      onChange={(e) => setClipTags(e.target.value)}
                      placeholder="clipped, reading"
                      aria-label="Clipper tags"
                      disabled={readOnly || clipMutation.isPending}
                    />
                  </label>
                </div>

                <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeSourceBanner}
                    onChange={(e) => setIncludeSourceBanner(e.target.checked)}
                    className="h-4 w-4 rounded border-border accent-primary"
                  />
                  Include source attribution banner & save URL metadata
                </label>

                <div className="flex justify-end">
                  <Button type="submit" disabled={readOnly || clipMutation.isPending || !clipUrlValue.trim()} className="gap-1.5">
                    {clipMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />}
                    Clip to Note
                  </Button>
                </div>
              </form>

              {clippedNote && (
                <div className="rounded-xl border border-success/40 bg-success/10 p-4 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-success">Clipped successfully</div>
                    <div className="text-sm font-medium text-foreground truncate">{clippedNote.title}</div>
                  </div>
                  <Button asChild size="sm" variant="outline" className="shrink-0 gap-1">
                    <Link to={`/notes/${clippedNote.id}`}>
                      Open note <ExternalLink className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </div>
              )}

              {/* Bookmarklet card */}
              <div className="rounded-xl border border-border bg-card/40 p-4 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Bookmark className="h-4 w-4 text-primary" aria-hidden="true" />
                    Browser Bookmarklet
                  </h2>
                  <Button type="button" size="sm" variant="outline" onClick={() => void handleCopyBookmarklet()} className="h-7 text-xs gap-1">
                    {copiedBookmarklet ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                    {copiedBookmarklet ? "Copied" : "Copy code"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Create a new browser bookmark and paste this snippet as its URL to clip any page in one click:
                </p>
                <pre className="rounded-lg border border-border bg-muted/50 p-2.5 text-[11px] font-mono overflow-x-auto text-foreground">
                  {bookmarkletCode}
                </pre>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              <form onSubmit={(e) => void handleEmailSubmit(e)} className="rounded-xl border border-border bg-card/50 p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="inline-flex rounded-md bg-muted p-0.5">
                    <button
                      type="button"
                      onClick={() => setEmailMode("raw")}
                      className={cn(
                        "rounded px-2.5 py-1 text-xs font-medium",
                        emailMode === "raw" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground"
                      )}
                    >
                      Raw .eml / Upload
                    </button>
                    <button
                      type="button"
                      onClick={() => setEmailMode("fields")}
                      className={cn(
                        "rounded px-2.5 py-1 text-xs font-medium",
                        emailMode === "fields" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground"
                      )}
                    >
                      Compose Fields
                    </button>
                  </div>

                  <label className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted cursor-pointer">
                    <FileUp className="h-3.5 w-3.5 text-primary" />
                    Load .eml file
                    <input
                      type="file"
                      accept=".eml,message/rfc822"
                      hidden
                      onChange={(e) => {
                        void handleEmailFile(e.target.files?.[0]);
                        e.target.value = "";
                      }}
                    />
                  </label>
                </div>

                {emailMode === "raw" ? (
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-foreground">Raw RFC-822 / .eml content</span>
                    <textarea
                      value={rawEml}
                      onChange={(e) => setRawEml(e.target.value)}
                      rows={8}
                      placeholder={"Subject: Project status\nFrom: sender@example.com\n\nBody text..."}
                      aria-label="Raw email content"
                      disabled={readOnly || emailMutation.isPending}
                      className="w-full rounded-lg border border-input bg-background px-3 py-2 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                  </label>
                ) : (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <label className="block space-y-1">
                        <span className="text-xs font-medium text-foreground">Subject</span>
                        <Input
                          value={emailSubject}
                          onChange={(e) => setEmailSubject(e.target.value)}
                          placeholder="Receipt / Email Subject"
                          aria-label="Email subject"
                          disabled={readOnly || emailMutation.isPending}
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className="text-xs font-medium text-foreground">From</span>
                        <Input
                          value={emailFrom}
                          onChange={(e) => setEmailFrom(e.target.value)}
                          placeholder="sender@example.com"
                          aria-label="Email sender"
                          disabled={readOnly || emailMutation.isPending}
                        />
                      </label>
                    </div>
                    <label className="block space-y-1">
                      <span className="text-xs font-medium text-foreground">Body text</span>
                      <textarea
                        value={emailBody}
                        onChange={(e) => setEmailBody(e.target.value)}
                        rows={6}
                        placeholder="Email text..."
                        aria-label="Email body"
                        disabled={readOnly || emailMutation.isPending}
                        className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
                      />
                    </label>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-foreground">Target notebook</span>
                    <select
                      value={emailParentId}
                      onChange={(e) => setEmailNotebookOverride(e.target.value)}
                      aria-label="Email target notebook"
                      disabled={readOnly || emailMutation.isPending}
                      className="w-full h-9 rounded-md border border-input bg-background px-2.5 text-sm text-foreground"
                    >
                      {writableNotebooks.map((nb) => (
                        <option key={nb.id} value={nb.id}>
                          {"— ".repeat(nb.depth)}
                          {nb.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-foreground">Tags (comma separated)</span>
                    <Input
                      value={emailTags}
                      onChange={(e) => setEmailTags(e.target.value)}
                      placeholder="email"
                      aria-label="Email tags"
                      disabled={readOnly || emailMutation.isPending}
                    />
                  </label>
                </div>

                <div className="flex justify-end">
                  <Button
                    type="submit"
                    disabled={
                      readOnly ||
                      emailMutation.isPending ||
                      (emailMode === "raw" ? !rawEml.trim() : !emailSubject.trim() && !emailBody.trim())
                    }
                    className="gap-1.5"
                  >
                    {emailMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                    Import Email as Note
                  </Button>
                </div>
              </form>

              {ingestedNote && (
                <div className="rounded-xl border border-success/40 bg-success/10 p-4 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-success">Email imported</div>
                    <div className="text-sm font-medium text-foreground truncate">{ingestedNote.title}</div>
                  </div>
                  <Button asChild size="sm" variant="outline" className="shrink-0 gap-1">
                    <Link to={`/notes/${ingestedNote.id}`}>
                      Open note <ExternalLink className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </div>
              )}

              {/* Webhook automation doc */}
              <div className="rounded-xl border border-border bg-card/40 p-4 space-y-2">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Webhook className="h-4 w-4 text-primary" aria-hidden="true" />
                  Incoming Email Webhook
                </h2>
                <p className="text-xs text-muted-foreground">
                  Configure <code className="font-mono">EMAIL_INGEST_WEBHOOK_SECRET</code> on the server to forward raw RFC-822 messages (<code className="font-mono">Content-Type: message/rfc822</code>) or JSON payloads directly to <code className="font-mono">POST /api/webhooks/email</code>:
                </p>
                <pre className="rounded-lg border border-border bg-muted/50 p-2.5 text-[11px] font-mono overflow-x-auto text-foreground">
                  {`# Raw RFC-822 (.eml) upload (e.g. Cloudflare Email Worker)\ncurl -X POST ${origin}/api/webhooks/email \\\n  -H "X-Webhook-Secret: $EMAIL_INGEST_WEBHOOK_SECRET" \\\n  -H "Content-Type: message/rfc822" \\\n  --data-binary @message.eml\n\n# JSON payload\ncurl -X POST ${origin}/api/webhooks/email \\\n  -H "X-Webhook-Secret: $EMAIL_INGEST_WEBHOOK_SECRET" \\\n  -H "Content-Type: application/json" \\\n  -d '{"subject":"Invoice","from":"billing@example.com","text":"Paid"}'`}
                </pre>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
