import { NextFunction, Request, Response } from 'express';
import { JoplinApiError, JoplinAuthError, JoplinConnectionError, joplinApi } from '../services/joplin-api.js';
import { invalidateSessionValidation } from './auth.js';

/**
 * Tells an expired session apart from a refused request after Joplin Server answered 401/403.
 * Joplin Server answers 403 for both, so the session is checked again.
 */
async function isSessionGone(err: JoplinAuthError, sessionId: string | undefined): Promise<boolean> {
  if (err.status === 401 || !sessionId) return true;
  try {
    return !(await joplinApi.checkSession(sessionId));
  } catch {
    return false;
  }
}

/**
 * Global Express error handling middleware. Details are logged, but responses only carry messages
 * meant for the client: no stack traces, internal error text or raw Joplin Server responses.
 */
export async function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  console.error('[ErrorHandler] Unhandled error:', err);

  // The session expired or was revoked after requireAuth accepted it: answer 401, so the
  // client signs in again, and stop accepting the session from the validation cache
  if (err instanceof JoplinAuthError) {
    if (await isSessionGone(err, req.sessionId)) {
      if (req.sessionId) invalidateSessionValidation(req.sessionId);
      res.status(401).json({ error: 'Unauthorized: Session has expired or is invalid', status: 401 });
    } else {
      res.status(403).json({ error: 'Joplin Server refused this request', status: 403 });
    }
    return;
  }

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
