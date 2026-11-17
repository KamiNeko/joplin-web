import type { DocumentInitParameters, PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { fetchResourceBytes, onClearResourceCache } from "./api";

/** Target display width on phones (largest collapsed card width); desktop cards scale down cleanly. */
const THUMBNAIL_TARGET_WIDTH = 360;
const MAX_CANVAS_DIMENSION = 4096;
const MAX_DEVICE_PIXEL_RATIO = 3;

export interface PdfThumbnail {
  url: string;
  pageCount: number;
  width: number;
  height: number;
}

type PdfJs = typeof import("pdfjs-dist");

let pdfjsPromise: Promise<PdfJs> | null = null;
const resolvedThumbnails = new Map<string, PdfThumbnail>();
const pendingThumbnails = new Map<string, Promise<PdfThumbnail>>();
let cacheGeneration = 0;

/**
 * Lazily loads pdf.js and wires its Vite-bundled module worker on first PDF render so notes
 * without PDFs never download the library.
 */
function loadPdfJs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ])
      .then(([pdfjs, worker]) => {
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        return pdfjs;
      })
      .catch((err) => {
        pdfjsPromise = null;
        throw err;
      });
  }
  return pdfjsPromise;
}

/**
 * Revokes and forgets all rendered PDF thumbnail `blob:` URLs (called on logout via `clearResourceCache`).
 */
export function clearPdfThumbnailCache(): void {
  cacheGeneration += 1;
  for (const thumb of resolvedThumbnails.values()) {
    if (thumb.url.startsWith("blob:")) URL.revokeObjectURL(thumb.url);
  }
  resolvedThumbnails.clear();
  pendingThumbnails.clear();
}

onClearResourceCache(clearPdfThumbnailCache);

/**
 * Returns a cached PDF thumbnail synchronously when already rendered during this session.
 */
export function getCachedPdfThumbnail(resourceId: string): PdfThumbnail | null {
  return resolvedThumbnails.get(resourceId) ?? null;
}

async function renderFirstPage(resourceId: string): Promise<PdfThumbnail> {
  const [pdfjs, data] = await Promise.all([
    loadPdfJs(),
    // Same `?view=pdf` URL as the iframe so the browser HTTP cache can reuse the response
    fetchResourceBytes(resourceId, "?view=pdf"),
  ]);

  const initParams = {
    data,
    // Keep pdf.js free of dynamic eval / runtime Wasm compilation under strict `script-src 'self'` CSP
    isEvalSupported: false,
    useWasm: false,
    verbosity: pdfjs.VerbosityLevel?.ERRORS ?? 0,
  } as DocumentInitParameters & { isEvalSupported: boolean };

  const loadingTask = pdfjs.getDocument(initParams);
  let pdfDoc: PDFDocumentProxy | null = null;
  const canvas = document.createElement("canvas");

  try {
    pdfDoc = await loadingTask.promise;
    const pageCount = pdfDoc.numPages;
    const page = await pdfDoc.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    if (!baseViewport.width || !baseViewport.height) {
      throw new Error("PDF page has invalid dimensions");
    }

    const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), MAX_DEVICE_PIXEL_RATIO);
    const scale = Math.min(
      (THUMBNAIL_TARGET_WIDTH * dpr) / baseViewport.width,
      MAX_CANVAS_DIMENSION / baseViewport.width,
      MAX_CANVAS_DIMENSION / baseViewport.height
    );
    const viewport = page.getViewport({ scale });

    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Could not create 2D canvas context");
    }

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({
      canvas,
      canvasContext: ctx,
      viewport,
      background: "#ffffff",
    }).promise;
    page.cleanup?.();

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) {
      throw new Error("Could not encode PDF thumbnail");
    }

    return {
      url: URL.createObjectURL(blob),
      pageCount,
      width: baseViewport.width,
      height: baseViewport.height,
    };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    await pdfDoc?.cleanup?.().catch(() => undefined);
    await loadingTask.destroy?.().catch(() => undefined);
  }
}

/**
 * Fetches a PDF resource, renders its first page to a `blob:` image URL at device pixel ratio,
 * and memoizes the result per resource id for the current session.
 */
export function getPdfThumbnail(resourceId: string): Promise<PdfThumbnail> {
  const cached = resolvedThumbnails.get(resourceId);
  if (cached) return Promise.resolve(cached);

  let pending = pendingThumbnails.get(resourceId);
  if (!pending) {
    const generation = cacheGeneration;
    pending = renderFirstPage(resourceId)
      .then((thumb) => {
        if (generation !== cacheGeneration) {
          if (thumb.url.startsWith("blob:")) URL.revokeObjectURL(thumb.url);
          throw new Error("Resource cache cleared");
        }
        resolvedThumbnails.set(resourceId, thumb);
        pendingThumbnails.delete(resourceId);
        return thumb;
      })
      .catch((err) => {
        pendingThumbnails.delete(resourceId);
        throw err;
      });
    pendingThumbnails.set(resourceId, pending);
  }
  return pending;
}
