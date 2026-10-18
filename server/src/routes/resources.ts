import express, { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { joplinApi, JoplinNotFoundError } from '../services/joplin-api.js';
import { noteCache } from '../services/note-cache.js';
import { assertValidId, noteWriter } from '../services/note-writer.js';

const router = Router();

// Resources require authentication
router.use(requireAuth);

/** Largest attachment accepted for upload */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
};

/**
 * POST /api/resources
 * Uploads an attachment. The request body is the raw file (sent as application/octet-stream, so
 * no other body parser touches it); the original file name is passed URI-encoded in the
 * X-File-Name header and its MIME type in X-File-Type.
 * Responds with { id, title, mime, size }; link it from a note as ":/<id>".
 */
router.post(
  '/',
  express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
  async (req, res) => {
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (data.length === 0) {
      res.status(400).json({ error: 'No file content received' });
      return;
    }

    let name = 'file';
    const rawName = req.headers['x-file-name'];
    if (typeof rawName === 'string' && rawName) {
      try {
        name = decodeURIComponent(rawName);
      } catch {
        name = rawName;
      }
    }
    name = name.replace(/[\\/]/g, '_').slice(0, 255);

    // Prefer a known type for the extension over a generic one from the browser
    const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
    const typeHeader = req.headers['x-file-type'];
    const headerType = (typeof typeHeader === 'string' ? typeHeader : '').split(';')[0].trim().toLowerCase();
    const validHeaderType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(headerType) ? headerType : '';
    const mime =
      validHeaderType && validHeaderType !== 'application/octet-stream'
        ? validHeaderType
        : MIME_BY_EXTENSION[extension] || detectMimeType(data) || 'application/octet-stream';

    const resource = await noteWriter.createResource(req.sessionId!, { name, mime, data });
    res.status(201).json(resource);
  }
);

/**
 * Detects MIME type from buffer magic numbers when Joplin Server returns octet-stream
 */
function detectMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 4) {
    // PNG: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return 'image/png';
    }
    // GIF: GIF8
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
      return 'image/gif';
    }
    // PDF: %PDF
    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
      return 'application/pdf';
    }
  }

  if (buffer.length >= 3) {
    // JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return 'image/jpeg';
    }
  }

  if (buffer.length >= 12) {
    // WEBP: RIFF .... WEBP
    const riff = buffer.toString('ascii', 0, 4);
    const webp = buffer.toString('ascii', 8, 12);
    if (riff === 'RIFF' && webp === 'WEBP') {
      return 'image/webp';
    }
  }

  // SVG: starts with <svg or <?xml ... <svg
  const snippet = buffer.toString('utf8', 0, Math.min(buffer.length, 256)).trim().toLowerCase();
  if (snippet.startsWith('<svg') || (snippet.startsWith('<?xml') && snippet.includes('<svg'))) {
    return 'image/svg+xml';
  }

  return null;
}

/**
 * Types that are shown inline: they can't run script in our origin. Everything else is sent as a
 * download, and types a browser could execute (HTML, XML, JavaScript, ...) lose their real type.
 */
const INLINE_SAFE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'application/pdf',
  'text/plain',
]);
const INLINE_SAFE_PREFIXES = ['audio/', 'video/'];

/**
 * SVG can carry script, but <img> (how notes show it) never runs it. It keeps its type so images in
 * notes still render, and is sent as a download with a sandboxing CSP in case it is opened directly.
 */
const DOWNLOAD_ONLY_TYPES = new Set(['image/svg+xml']);

const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/**
 * Decides how an attachment is served: its Content-Type and whether it may be shown inline.
 * Unknown or malformed types (resource metadata can come from any Joplin client) become
 * application/octet-stream.
 */
export function resourceResponseType(mime: string | undefined | null): { contentType: string; inline: boolean } {
  const type = (mime ?? '').split(';')[0].trim().toLowerCase();
  if (INLINE_SAFE_TYPES.has(type)) return { contentType: type, inline: true };
  if (MIME_PATTERN.test(type) && INLINE_SAFE_PREFIXES.some((prefix) => type.startsWith(prefix))) {
    return { contentType: type, inline: true };
  }
  if (DOWNLOAD_ONLY_TYPES.has(type)) return { contentType: type, inline: false };
  return { contentType: 'application/octet-stream', inline: false };
}

/**
 * Builds a Content-Disposition header value with an ASCII fallback and an RFC 5987 encoded UTF-8
 * file name. Control characters, quotes and backslashes can't break out of the header.
 */
export function contentDisposition(type: 'inline' | 'attachment', fileName: string | undefined | null): string {
  const name = Array.from(fileName ?? '')
    // Drop control characters and lone surrogates (encodeURIComponent throws on the latter)
    .filter((char) => {
      const code = char.codePointAt(0)!;
      return code >= 0x20 && code !== 0x7f && !(code >= 0xd800 && code <= 0xdfff);
    })
    .join('')
    .trim()
    .slice(0, 255);
  if (!name) return type;
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * GET /api/resources/:id
 * Proxies binary resource files (images, attachments) from Joplin Server
 */
router.get('/:id', async (req, res) => {
  try {
    const sessionId = req.sessionId!;
    const resourceId = assertValidId(req.params.id, 'resource id');

    // Attempt to lookup cached metadata for filename and MIME type
    const metadata = await noteCache.getResourceMetadata(sessionId, resourceId);

    // Fetch binary from Joplin Server
    const { data: buffer, contentType: rawContentType } = await joplinApi.getResourceBinary(
      sessionId,
      resourceId
    );

    let mime = metadata?.mime || rawContentType;

    // If generic or octet-stream, try sniffing the binary buffer
    if (!mime || mime === 'application/octet-stream' || mime === 'text/plain') {
      const detected = detectMimeType(buffer);
      if (detected) {
        mime = detected;
      }
    }

    const { contentType, inline } = resourceResponseType(mime);
    const downloadName = metadata?.filename || metadata?.title;

    // Joplin resources are immutable and content-addressed by 32-character hex ID
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Attachments are user content served from our origin: never let them run scripts
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', downloadName));

    res.status(200).send(buffer);
  } catch (error) {
    if (error instanceof JoplinNotFoundError) {
      res.status(404).json({ error: 'Resource not found on Joplin Server' });
      return;
    }
    throw error;
  }
});

/**
 * DELETE /api/resources/:id
 * Permanently deletes an attachment (metadata and file). Notes linking to it are not changed.
 */
router.delete('/:id', async (req, res) => {
  await noteWriter.deleteResource(req.sessionId!, req.params.id);
  res.status(204).end();
});

export const resourcesRouter = router;
