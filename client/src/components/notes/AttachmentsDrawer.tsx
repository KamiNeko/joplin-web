import { useState } from "react";
import { Download, FileAudio, FileText, FileVideo, Image as ImageIcon, Loader2, Paperclip, ScanText } from "lucide-react";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { QueryError } from "@/components/common/QueryError";
import { ResourceImage } from "@/components/common/ResourceImage";
import { useNoteAttachments } from "@/hooks/use-workspace";
import { downloadResource, getResourceUrl } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import type { NoteAttachment } from "@/lib/types";

interface AttachmentsDrawerProps {
  noteId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let val = bytes;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val >= 10 || i === 0 ? Math.round(val) : val.toFixed(1)} ${units[i]}`;
}

function KindIcon({ kind }: { kind: NoteAttachment["kind"] }) {
  switch (kind) {
    case "image":
      return <ImageIcon className="h-4 w-4 text-primary shrink-0" />;
    case "audio":
      return <FileAudio className="h-4 w-4 text-primary shrink-0" />;
    case "video":
      return <FileVideo className="h-4 w-4 text-primary shrink-0" />;
    case "pdf":
      return <FileText className="h-4 w-4 text-primary shrink-0" />;
    default:
      return <Paperclip className="h-4 w-4 text-primary shrink-0" />;
  }
}

export function AttachmentsDrawer({ noteId, open, onOpenChange }: AttachmentsDrawerProps) {
  const query = useNoteAttachments(noteId, open);
  const [expandedOcrId, setExpandedOcrId] = useState<string | null>(null);
  const attachments = query.data ?? [];

  const handleDownload = async (att: NoteAttachment) => {
    try {
      await downloadResource(att.id, att.filename || att.title || "attachment");
    } catch {
      toast.error("Could not download attachment");
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg flex flex-col p-0">
        <SheetHeader className="px-6 py-4 border-b border-border shrink-0 text-left">
          <SheetTitle className="flex items-center gap-2 text-base">
            <Paperclip className="h-4 w-4 text-primary" />
            Attachments &amp; OCR ({attachments.length})
          </SheetTitle>
          <SheetDescription className="text-xs">
            Inspect files, media, and extracted OCR text attached to this note.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-3">
          {query.isLoading ? (
            <div className="flex items-center justify-center py-12 text-xs text-muted-foreground gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading attachments...
            </div>
          ) : query.error ? (
            <QueryError
              message="Couldn't load attachments"
              error={query.error}
              onRetry={() => void query.refetch()}
              isRetrying={query.isFetching}
            />
          ) : attachments.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center space-y-2">
              <Paperclip className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm font-medium text-foreground">No attachments</p>
              <p className="text-xs text-muted-foreground max-w-xs">
                Files, images, PDFs, or voice notes embedded in this note appear here.
              </p>
            </div>
          ) : (
            attachments.map((att) => {
              const name = att.filename || att.title || att.id;
              const ocrExpanded = expandedOcrId === att.id;
              return (
                <article key={att.id} className="rounded-xl border border-border bg-card/50 p-3.5 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <div className="mt-0.5">
                        <KindIcon kind={att.kind} />
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-foreground truncate" title={name}>
                          {name}
                        </p>
                        <div className="flex flex-wrap items-center gap-1.5 mt-1">
                          <Badge variant="outline" className="text-[10px] uppercase px-1.5 py-0">
                            {att.kind}
                          </Badge>
                          {att.size > 0 && (
                            <span className="text-[11px] font-mono text-muted-foreground">
                              {formatSize(att.size)}
                            </span>
                          )}
                          {att.ocrText && (
                            <Badge variant="secondary" className="text-[10px] gap-1 px-1.5 py-0">
                              <ScanText className="h-2.5 w-2.5" />
                              OCR
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {att.kind === "pdf" && (
                        <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs">
                          <a href={`${getResourceUrl(att.id)}?view=pdf`} target="_blank" rel="noopener noreferrer">
                            Open
                          </a>
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 px-2 text-xs"
                        onClick={() => void handleDownload(att)}
                      >
                        <Download className="h-3 w-3" />
                        Download
                      </Button>
                    </div>
                  </div>

                  {att.kind === "image" && (
                    <div className="overflow-hidden rounded-lg border border-border/50 bg-muted/20 max-h-48 flex items-center justify-center">
                      <ResourceImage resourceId={att.id} alt={name} className="max-h-48 w-auto object-contain" />
                    </div>
                  )}

                  {att.kind === "audio" && (
                    <audio controls preload="metadata" src={getResourceUrl(att.id)} className="w-full" />
                  )}

                  {att.kind === "video" && (
                    <video controls preload="metadata" src={getResourceUrl(att.id)} className="w-full max-h-56 rounded-lg" />
                  )}

                  {att.ocrText && (
                    <div className="space-y-1.5 pt-1 border-t border-border/40">
                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => setExpandedOcrId(ocrExpanded ? null : att.id)}
                          className="text-[11px] font-medium text-primary hover:underline"
                        >
                          {ocrExpanded ? "Hide OCR text" : "Show OCR text"}
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            if (await copyText(att.ocrText)) toast.success("OCR text copied");
                          }}
                          className="text-[11px] text-muted-foreground hover:text-foreground"
                        >
                          Copy OCR
                        </button>
                      </div>
                      {ocrExpanded && (
                        <pre className="max-h-44 overflow-y-auto rounded-lg bg-muted/40 p-2.5 text-[11px] font-mono whitespace-pre-wrap text-foreground/90">
                          {att.ocrText}
                        </pre>
                      )}
                    </div>
                  )}
                </article>
              );
            })
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
