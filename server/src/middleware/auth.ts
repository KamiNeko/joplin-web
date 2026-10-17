import { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { joplinApi, JoplinAuthError, JoplinConnectionError } from '../services/joplin-api.js';

interface SessionValidationEntry {
  isValid: boolean;
  validatedAt: number;
}

// In-memory cache for session validation results
const sessionValidationCache = new Map<string, SessionValidationEntry>();

/**
 * Caches session validity status
 */
export function cacheSessionValidation(sessionId: string, isValid: boolean): void {
  sessionValidationCache.set(sessionId, {
    isValid,
    validatedAt: Date.now(),
  });
}

/**
 * Removes a session from the validation cache (e.g. upon logout)
 */
export function invalidateSessionValidation(sessionId: string): void {
  sessionValidationCache.delete(sessionId);
}

/**
 * Authentication middleware that verifies session token against Joplin Server
 * Checks for:
 * 1. Authorization: Bearer <sessionId>
 * 2. X-API-AUTH: <sessionId>
 * 3. ?auth=<sessionId> query param (supports browser image requests)
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    let sessionId: string | undefined;

    // Check Authorization: Bearer <token>
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
      sessionId = authHeader.substring(7).trim();
    }

    // Check X-API-AUTH header
    if (!sessionId && typeof req.headers['x-api-auth'] === 'string') {
      sessionId = req.headers['x-api-auth'].trim();
    }

    // Check ?auth= query param
    if (!sessionId && typeof req.query.auth === 'string') {
      sessionId = req.query.auth.trim();
    }

    if (!sessionId) {
      res.status(401).json({
        error: 'Unauthorized: Missing session token. Please provide Authorization: Bearer <token>',
      });
      return;
    }

    // Check in-memory session validation cache
    const cached = sessionValidationCache.get(sessionId);
    const now = Date.now();

    if (cached && now - cached.validatedAt < config.authCacheTtlMs) {
      if (!cached.isValid) {
        res.status(401).json({ error: 'Unauthorized: Session has expired or is invalid' });
        return;
      }
      req.sessionId = sessionId;
      return next();
    }

    // Validate session with Joplin Server
    const isValid = await joplinApi.checkSession(sessionId);
    sessionValidationCache.set(sessionId, {
      isValid,
      validatedAt: now,
    });

    if (!isValid) {
      res.status(401).json({ error: 'Unauthorized: Session has expired or is invalid' });
      return;
    }

    req.sessionId = sessionId;
    next();
  } catch (error) {
    if (error instanceof JoplinAuthError) {
      res.status(401).json({ error: error.message });
      return;
    }

    if (error instanceof JoplinConnectionError) {
      res.status(503).json({ error: error.message });
      return;
    }

    console.error('[AuthMiddleware] Error during session validation:', error);
    res.status(500).json({ error: 'Internal server error validating session' });
  }
}
