import { useEffect, useRef, useState } from "react";
import { Download, ExternalLink, FileText, Maximize2, Minimize2 } from "lucide-react";
import { toast } from "sonner";
import { ApiError, downloadResource, getResourceUrl } from "@/lib/api";
import { getCachedPdfThumbnail, getPdfThumbnail, type PdfThumbnail } from "@/lib/pdf-thumbnail";
import { cn } from "@/lib/utils";

interface PdfEmbedProps {
  resourceId: string;
  fileName: string;
}

type ThumbnailState =
  | { resourceId: string; status: "loading" }
  | { resourceId: string; status: "ready"; thumbnail: PdfThumbnail }
  | { resourceId: string; status: "error" };

function formatPageCount(pageCount: number): string {
  return pageCount === 1 ? "1 page" : `${pageCount} pages`;
}

const ACTION_CLASS =
  "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors";

/**
 * Evernote-style PDF attachment card for `:/id` links whose label ends in `.pdf`.
 * Uses `<span>` containers so it remains valid inside Markdown paragraphs (`<p>`).
 * Starts collapsed as a client-rendered first-page thumbnail (lazy-loaded near the viewport) and
 * expands on click to the inline iframe when `navigator.pdfViewerEnabled !== false`; on browsers
 * without an inline viewer (e.g. Android Chrome), clicking the thumbnail opens it in a new tab.
 */
export function PdfEmbed({ resourceId, fileName }: PdfEmbedProps) {
  const [downloading, setDownloading] = useState(false);
  const [expandedForId, setExpandedForId] = useState<string | null>(null);
  const cardRef = useRef<HTMLSpanElement>(null);

  const [visibleForId, setVisibleForId] = useState<string | null>(() =>
    typeof IntersectionObserver === "undefined" ? resourceId : null
  );
  const [loadedState, setLoadedState] = useState<ThumbnailState>(() => {
    const cached = getCachedPdfThumbnail(resourceId);
    return cached ? { resourceId, status: "ready", thumbnail: cached } : { resourceId, status: "loading" };
  });

  // Own cache key: copies cached (immutable, 1 day) while PDFs were still sent with `sandbox` render blank
  const url = `${getResourceUrl(resourceId)}?view=pdf`;
  const canInlineView = typeof navigator === "undefined" || navigator.pdfViewerEnabled !== false;
  const expanded = canInlineView && expandedForId === resourceId;

  const cachedThumbnail = getCachedPdfThumbnail(resourceId);
  const state: ThumbnailState = cachedThumbnail
    ? { resourceId, status: "ready", thumbnail: cachedThumbnail }
    : loadedState.resourceId === resourceId
      ? loadedState
      : { resourceId, status: "loading" };

  const isVisible =
    Boolean(cachedThumbnail) || typeof IntersectionObserver === "undefined" || visibleForId === resourceId;

  useEffect(() => {
    if (isVisible) return;
    const element = cardRef.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleForId(resourceId);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [isVisible, resourceId]);

  useEffect(() => {
    if (!isVisible) return;
    if (getCachedPdfThumbnail(resourceId)) return;
    let cancelled = false;
    getPdfThumbnail(resourceId)
      .then((thumbnail) => {
        if (!cancelled) setLoadedState({ resourceId, status: "ready", thumbnail });
      })
      .catch(() => {
        if (!cancelled) setLoadedState({ resourceId, status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [isVisible, resourceId]);

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

  const pageLabel = state.status === "ready" ? formatPageCount(state.thumbnail.pageCount) : null;

  if (expanded) {
    return (
      <span
        ref={cardRef}
        className="block my-4 w-full rounded-xl border border-border/60 bg-card overflow-hidden shadow-xs"
      >
        <span className="flex flex-wrap items-center justify-between gap-2 px-3 sm:px-4 py-2 bg-muted/40 text-xs text-muted-foreground border-b border-border/50">
          <span className="flex items-center gap-2 min-w-0 font-medium text-foreground">
            <FileText className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <span className="truncate" title={fileName}>
              {fileName}
            </span>
            {pageLabel && (
              <span className="shrink-0 font-normal text-muted-foreground hidden sm:inline">· {pageLabel}</span>
            )}
          </span>
          <span className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setExpandedForId(null)}
              className={ACTION_CLASS}
              title={`Collapse ${fileName}`}
            >
              <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Collapse</span>
            </button>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(ACTION_CLASS, "no-underline")}
              title={`Open ${fileName} in new tab`}
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Open</span>
            </a>
            <button
              type="button"
              onClick={() => void handleDownload()}
              disabled={downloading}
              className={cn(ACTION_CLASS, "disabled:opacity-50")}
              title={`Download ${fileName}`}
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Download</span>
            </button>
          </span>
        </span>
        <iframe
          src={url}
          title={fileName}
          loading="lazy"
          className="block w-full h-[75vh] min-h-[480px] border-0 bg-muted/20"
        />
      </span>
    );
  }

  const actions = (
    <span className="mt-2 pt-2 border-t border-border/40 flex flex-wrap items-center gap-1">
      {canInlineView && (
        <button
          type="button"
          onClick={() => setExpandedForId(resourceId)}
          className={ACTION_CLASS}
          title={`Preview ${fileName}`}
        >
          <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Preview</span>
        </button>
      )}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(ACTION_CLASS, "no-underline")}
        title={`Open ${fileName} in new tab`}
      >
        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Open</span>
      </a>
      <button
        type="button"
        onClick={() => void handleDownload()}
        disabled={downloading}
        className={cn(ACTION_CLASS, "disabled:opacity-50")}
        title={`Download ${fileName}`}
      >
        <Download className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Download</span>
      </button>
    </span>
  );

  if (state.status === "error") {
    return (
      <span
        ref={cardRef}
        className="block my-4 w-full max-w-[360px] sm:w-[260px] rounded-xl border border-border/60 bg-card overflow-hidden shadow-xs"
      >
        <span className="block px-3 py-2.5 bg-muted/40">
          <span className="flex items-center gap-2.5 min-w-0">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FileText className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-foreground" title={fileName}>
                {fileName}
              </span>
              <span className="block text-[11px] text-muted-foreground">PDF attachment</span>
            </span>
          </span>
          {actions}
        </span>
      </span>
    );
  }

  const thumbnailImage =
    state.status === "ready" ? (
      <img
        src={state.thumbnail.url}
        alt={`${fileName} — page 1 preview`}
        width={state.thumbnail.width}
        height={state.thumbnail.height}
        style={{ aspectRatio: `${state.thumbnail.width} / ${state.thumbnail.height}` }}
        className="block w-full h-auto bg-white transition-opacity group-hover:opacity-95"
      />
    ) : null;

  return (
    <span
      ref={cardRef}
      className="block my-4 w-full max-w-[360px] sm:w-[260px] rounded-xl border border-border/60 bg-card overflow-hidden shadow-xs"
    >
      {state.status === "loading" ? (
        <span
          className="block w-full aspect-[3/4] animate-pulse bg-muted border-b border-border/50"
          role="img"
          aria-label={`Loading ${fileName}`}
        />
      ) : canInlineView ? (
        <button
          type="button"
          onClick={() => setExpandedForId(resourceId)}
          aria-label={`Preview ${fileName}`}
          title={`Preview ${fileName}`}
          className="group relative block w-full overflow-hidden border-b border-border/50 bg-white p-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {thumbnailImage}
        </button>
      ) : (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${fileName} in new tab`}
          title={`Open ${fileName} in new tab`}
          className="group relative block w-full overflow-hidden border-b border-border/50 bg-white no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {thumbnailImage}
        </a>
      )}
      <span className="block px-3 py-2.5 bg-muted/40">
        <span className="flex items-center gap-2 min-w-0">
          <FileText className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium text-foreground" title={fileName}>
              {fileName}
            </span>
            {pageLabel && <span className="block text-[11px] text-muted-foreground">{pageLabel}</span>}
          </span>
        </span>
        {actions}
      </span>
    </span>
  );
}
