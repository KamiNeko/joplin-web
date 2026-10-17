import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { joplinApi, JoplinNotFoundError } from '../services/joplin-api.js';
import { noteCache } from '../services/note-cache.js';

const router = Router();

// Resources require authentication
router.use(requireAuth);

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
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');

    if (metadata?.filename) {
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${encodeURIComponent(metadata.filename)}"`
      );
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

export const resourcesRouter = router;
