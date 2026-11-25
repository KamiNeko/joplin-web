import { useState } from "react";
import { Download, ExternalLink, FileText } from "lucide-react";
import { toast } from "sonner";
import { ApiError, downloadResource, getResourceUrl } from "@/lib/api";
import { cn } from "@/lib/utils";

interface PdfEmbedProps {
  resourceId: string;
  fileName: string;
}

/**
 * Inline PDF attachment embed for `:/id` links whose label ends in `.pdf`.
 * Uses `<span>` containers so it remains valid inside Markdown paragraphs (`<p>`).
 * Browsers without an inline viewer (`navigator.pdfViewerEnabled === false`, e.g. Android Chrome)
 * get only the header card with Open and Download actions.
 */
export function PdfEmbed({ resourceId, fileName }: PdfEmbedProps) {
  const [downloading, setDownloading] = useState(false);
  // Own cache key: copies cached (immutable, 1 day) while PDFs were still sent with `sandbox` render blank
  const url = `${getResourceUrl(resourceId)}?view=pdf`;
  const showViewer = typeof navigator === "undefined" || navigator.pdfViewerEnabled !== false;

  const handleDownload = async () => {
    setDownloading(true);
    try {
      await downloadResource(resourceId, fileName);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        toast.error("This link points to a note or attachment that no longer exists");
      } else {
        toast.error("Could not download attachment", {
          description: err instanceof Error ? err.message : undefined,
        });
      }
    } finally {
      setDownloading(false);
    }
  };

  return (
    <span data-no-edit="" className="block my-4 rounded-xl border border-border/60 bg-card overflow-hidden shadow-xs">
      <span
        className={cn(
          "flex items-center justify-between gap-3 px-3 sm:px-4 py-2 bg-muted/40 text-xs text-muted-foreground",
          showViewer && "border-b border-border/50"
        )}
      >
        <span className="flex items-center gap-2 min-w-0 font-medium text-foreground">
          <FileText className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate" title={fileName}>
            {fileName}
          </span>
        </span>
        <span className="flex items-center gap-1 shrink-0">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors no-underline"
            title={`Open ${fileName} in new tab`}
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Open</span>
          </a>
          <button
            type="button"
            onClick={() => void handleDownload()}
            disabled={downloading}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-50"
            title={`Download ${fileName}`}
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Download</span>
          </button>
        </span>
      </span>
      {showViewer && (
        <iframe
          src={url}
          title={fileName}
          loading="lazy"
          className="block w-full h-[75vh] min-h-[480px] border-0 bg-muted/20"
        />
      )}
    </span>
  );
}
