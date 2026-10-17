import { NextFunction, Request, Response } from 'express';
import { JoplinApiError, JoplinConnectionError } from '../services/joplin-api.js';

/**
 * Global Express error handling middleware. Details are logged, but responses only carry messages
 * meant for the client: no stack traces, internal error text or raw Joplin Server responses.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error('[ErrorHandler] Unhandled error:', err);

  if ((err as { type?: string })?.type === 'entity.too.large') {
    res.status(413).json({ error: 'The file is too large to upload' });
    return;
  }

  if (err instanceof JoplinApiError) {
    // 5xx messages can contain internal details (Joplin Server URL, upstream error text)
    const message =
      err.status < 500
        ? err.message
        : err instanceof JoplinConnectionError
          ? 'Cannot connect to Joplin Server'
          : 'The request to Joplin Server failed';
    const body: Record<string, unknown> = { error: message, status: err.status };
    // Conflicts carry the current version of the note for the client's conflict dialog
    if (err.status === 409) body.details = err.details;
    res.status(err.status).json(body);
    return;
  }

  // Client errors raised by body parsers etc. (malformed JSON, unsupported encoding, ...)
  const status = (err as { status?: unknown; statusCode?: unknown })?.status ?? (err as { statusCode?: unknown })?.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ error: 'Invalid request' });
    return;
  }

  res.status(500).json({
    error: 'An unexpected internal error occurred',
  });
}
