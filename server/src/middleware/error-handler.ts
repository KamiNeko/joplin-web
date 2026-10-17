import { NextFunction, Request, Response } from 'express';
import { JoplinApiError } from '../services/joplin-api.js';

/**
 * Global Express error handling middleware
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
    res.status(err.status).json({
      error: err.message,
      status: err.status,
      details: err.details,
    });
    return;
  }

  if (err instanceof Error) {
    res.status(500).json({
      error: err.message,
    });
    return;
  }

  res.status(500).json({
    error: 'An unexpected internal error occurred',
  });
}
