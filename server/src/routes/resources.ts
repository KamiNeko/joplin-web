import express, { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { joplinApi, JoplinNotFoundError } from '../services/joplin-api.js';
import { noteCache } from '../services/note-cache.js';
import { noteWriter } from '../services/note-writer.js';

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
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
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
    } catch (error) {
      next(error);
    }
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
 * GET /api/resources/:id
 * Proxies binary resource files (images, attachments) from Joplin Server
 */
router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const sessionId = req.sessionId!;
    const resourceId = req.params.id;

    if (!resourceId) {
      res.status(400).json({ error: 'Resource ID is required' });
      return;
    }

    // Attempt to lookup cached metadata for filename and MIME type
    const metadata = await noteCache.getResourceMetadata(sessionId, resourceId);

    // Fetch binary from Joplin Server
    const { data: buffer, contentType: rawContentType } = await joplinApi.getResourceBinary(
      sessionId,
      resourceId
    );

    let contentType = metadata?.mime || rawContentType;

    // If generic or octet-stream, try sniffing the binary buffer
    if (!contentType || contentType === 'application/octet-stream' || contentType === 'text/plain') {
      const detected = detectMimeType(buffer);
      if (detected) {
        contentType = detected;
      }
    }

    // Set caching and content headers
    // Joplin resources are immutable and content-addressed by 32-character hex ID
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    // Attachments are user content served from our origin: never let them run scripts
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");

    const downloadName = metadata?.filename || metadata?.title;
    if (downloadName) {
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
    }

    res.status(200).send(buffer);
  } catch (error) {
    if (error instanceof JoplinNotFoundError) {
      res.status(404).json({ error: 'Resource not found on Joplin Server' });
      return;
    }
    next(error);
  }
});

/**
 * DELETE /api/resources/:id
 * Permanently deletes an attachment (metadata and file). Notes linking to it are not changed.
 */
router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await noteWriter.deleteResource(req.sessionId!, req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

export const resourcesRouter = router;
