import { config } from '../config.js';
import type { AttachmentOcrStatus } from '../types/index.js';
import { joplinApi } from './joplin-api.js';
import { noteCache } from './note-cache.js';
import { assertValidId, noteWriter, WriteValidationError } from './note-writer.js';
import { deserialize } from './serializer.js';

const OCR_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/bmp',
  'image/tiff',
  'image/gif',
  'image/avif',
]);

const MAX_CONCURRENCY = 2;
const BRIDGE_TIMEOUT_MS = 120_000;
const STATUS_TTL_MS = 15 * 60 * 1000;
const MAX_STATUS_ENTRIES = 500;

export function isOcrSupportedMime(mime: string | undefined | null): boolean {
  const clean = (mime ?? '').split(';')[0].trim().toLowerCase();
  return clean === 'application/pdf' || OCR_IMAGE_MIMES.has(clean);
}

export interface OcrCallResult {
  ocrStatus: 'done' | 'failed';
  ocrText: string;
}

export interface OcrUploadOutcome {
  ocrStatus: AttachmentOcrStatus;
  ocrText?: string;
}

export interface OcrBridgeFn {
  (input: { data: Buffer; mime: string; name: string }): Promise<string>;
}

export interface OcrBridgeDeps {
  ocrServiceUrl?: string | null;
  ocrServiceSecret?: string | null;
  ocrInlineWaitMs?: number;
  ocrFn?: OcrBridgeFn;
}

export class OcrBridgeService {
  private readonly deps: OcrBridgeDeps;
  private activeCount = 0;
  private readonly waitQueue: Array<() => void> = [];
  private readonly inFlight = new Map<string, Promise<OcrCallResult>>();
  private readonly liveStatus = new Map<string, { status: AttachmentOcrStatus; updatedAt: number }>();

  constructor(deps: OcrBridgeDeps = {}) {
    this.deps = deps;
  }

  private resolvedConfig() {
    return {
      url: this.deps.ocrServiceUrl !== undefined ? this.deps.ocrServiceUrl : config.ocrServiceUrl,
      secret: this.deps.ocrServiceSecret !== undefined ? this.deps.ocrServiceSecret : config.ocrServiceSecret,
      inlineWaitMs:
        this.deps.ocrInlineWaitMs !== undefined ? this.deps.ocrInlineWaitMs : config.ocrInlineWaitMs,
    };
  }

  public isEnabled(): boolean {
    if (this.deps.ocrFn) return true;
    return Boolean(this.resolvedConfig().url);
  }

  public getStatus(resourceId: string): AttachmentOcrStatus | undefined {
    const entry = this.liveStatus.get(resourceId);
    if (!entry) return undefined;
    if (Date.now() - entry.updatedAt > STATUS_TTL_MS) {
      this.liveStatus.delete(resourceId);
      return undefined;
    }
    return entry.status;
  }

  private setStatus(resourceId: string, status: AttachmentOcrStatus): void {
    const now = Date.now();
    this.liveStatus.set(resourceId, { status, updatedAt: now });
    if (this.liveStatus.size > MAX_STATUS_ENTRIES) {
      for (const [id, item] of this.liveStatus) {
        if (now - item.updatedAt > STATUS_TTL_MS || this.liveStatus.size > MAX_STATUS_ENTRIES) {
          this.liveStatus.delete(id);
        } else {
          break;
        }
      }
    }
  }

  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeCount >= MAX_CONCURRENCY) {
      await new Promise<void>((resolve) => this.waitQueue.push(resolve));
    }
    this.activeCount += 1;
    try {
      return await fn();
    } finally {
      this.activeCount -= 1;
      const next = this.waitQueue.shift();
      if (next) next();
    }
  }

  private async callBridge(input: { data: Buffer; mime: string; name: string }): Promise<string> {
    if (this.deps.ocrFn) {
      return this.deps.ocrFn(input);
    }
    const cfg = this.resolvedConfig();
    if (!cfg.url) {
      throw new WriteValidationError('OCR bridge service is not configured on this server', 503);
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'X-File-Mime': input.mime,
      'X-File-Name': encodeURIComponent(input.name || 'file'),
    };
    if (cfg.secret) {
      headers['X-Ocr-Secret'] = cfg.secret;
    }
    const res = await fetch(`${cfg.url}/ocr`, {
      method: 'POST',
      headers,
      body: new Uint8Array(input.data),
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      throw new WriteValidationError(
        `OCR bridge returned HTTP ${res.status}${msg ? `: ${msg.slice(0, 160)}` : ''}`,
        502
      );
    }
    const data = (await res.json()) as { ok?: unknown; text?: unknown; error?: unknown };
    if (data.ok === false) {
      throw new WriteValidationError(typeof data.error === 'string' ? data.error : 'OCR extraction failed', 502);
    }
    return typeof data.text === 'string' ? data.text : '';
  }

  private enqueue(
    sessionId: string,
    resourceId: string,
    input: { data: Buffer; mime: string; name: string }
  ): Promise<OcrCallResult> {
    const existing = this.inFlight.get(resourceId);
    if (existing) return existing;

    this.setStatus(resourceId, 'pending');
    const task = this.withSlot(async (): Promise<OcrCallResult> => {
      try {
        const text = (await this.callBridge(input)).trim();
        await noteWriter.updateResourceOcr(sessionId, resourceId, {
          ocrText: text,
          status: 2,
        });
        this.setStatus(resourceId, 'done');
        return { ocrStatus: 'done', ocrText: text };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[OcrBridge] OCR failed for resource ${resourceId}:`, message);
        try {
          await noteWriter.updateResourceOcr(sessionId, resourceId, {
            ocrText: '',
            status: 3,
            error: message,
          });
        } catch {
          // Resource may have been deleted or server unavailable
        }
        this.setStatus(resourceId, 'failed');
        return { ocrStatus: 'failed', ocrText: '' };
      } finally {
        this.inFlight.delete(resourceId);
      }
    });

    this.inFlight.set(resourceId, task);
    return task;
  }

  /**
   * Runs OCR on a newly uploaded image/PDF if enabled, waiting up to `ocrInlineWaitMs`
   * before returning `'pending'` while allowing background OCR to finish.
   */
  public async uploadAndMaybeWait(
    sessionId: string,
    resourceId: string,
    input: { data: Buffer; mime: string; name: string }
  ): Promise<OcrUploadOutcome> {
    if (!this.isEnabled() || !isOcrSupportedMime(input.mime)) {
      return { ocrStatus: 'skipped' };
    }

    const waitMs = this.resolvedConfig().inlineWaitMs;
    const task = this.enqueue(sessionId, resourceId, input);

    if (waitMs <= 0) {
      void task;
      return { ocrStatus: 'pending' };
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race<OcrCallResult | 'timeout'>([
      task,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), waitMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);

    if (result === 'timeout') {
      return { ocrStatus: 'pending' };
    }
    return {
      ocrStatus: result.ocrStatus,
      ...(result.ocrText ? { ocrText: result.ocrText } : {}),
    };
  }

  /**
   * Triggers (or joins an in-flight) OCR extraction for an existing resource ID.
   */
  public async runNow(
    sessionId: string,
    resourceId: string
  ): Promise<{ id: string; ocrStatus: 'done' | 'failed'; ocrText: string }> {
    assertValidId(resourceId, 'resource id');
    if (!this.isEnabled()) {
      throw new WriteValidationError('OCR bridge service is not configured on this server', 503);
    }

    const existing = this.inFlight.get(resourceId);
    if (existing) {
      const outcome = await existing;
      return { id: resourceId, ...outcome };
    }

    const meta = await noteCache.getResourceMetadata(sessionId, resourceId);
    let mime = meta?.mime ?? '';
    let name = meta?.filename || meta?.title || resourceId;
    if (!meta) {
      const raw = await joplinApi.getItemContent(sessionId, `${resourceId}.md`);
      const parsed = deserialize(raw, `${resourceId}.md`);
      if (parsed.properties.encryption_applied === '1') {
        throw new WriteValidationError('Encrypted resources cannot be OCR-processed on the server', 422);
      }
      mime = parsed.properties.mime || '';
      name = parsed.properties.filename || parsed.title || resourceId;
    }

    if (!isOcrSupportedMime(mime)) {
      throw new WriteValidationError(`OCR is only supported for images and PDFs (got ${mime || 'unknown'})`, 400);
    }

    const { data } = await joplinApi.getResourceBinary(sessionId, resourceId);
    const outcome = await this.enqueue(sessionId, resourceId, { data, mime, name });
    return { id: resourceId, ...outcome };
  }
}

export const ocrBridgeService = new OcrBridgeService();
