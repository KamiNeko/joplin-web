import { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { joplinApi, JoplinAuthError, JoplinConnectionError } from '../services/joplin-api.js';

interface SessionValidationEntry {
  isValid: boolean;
  validatedAt: number;
}

// In-memory cache for session validation results
const sessionValidationCache = new Map<string, SessionValidationEntry>();

/** Above this size, expired entries are dropped before a new one is added */
const MAX_CACHED_VALIDATIONS = 1000;

/**
 * Drops expired validation results, so random tokens sent by a client can't grow the cache forever
 */
function pruneSessionValidationCache(now: number): void {
  if (sessionValidationCache.size < MAX_CACHED_VALIDATIONS) return;
  for (const [id, entry] of sessionValidationCache) {
    if (now - entry.validatedAt >= config.authCacheTtlMs) sessionValidationCache.delete(id);
  }
}

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
 * Marks a session as logged out: it is rejected without asking Joplin Server until the validation
 * cache entry expires, even if ending it on Joplin Server failed.
 */
export function invalidateSessionValidation(sessionId: string): void {
  cacheSessionValidation(sessionId, false);
}

/** httpOnly cookie that carries the session for the browser client */
export const SESSION_COOKIE = 'joplin_web_session';

/** Joplin Server session ids are short ASCII tokens; anything else is rejected before use */
const TOKEN_PATTERN = /^[\x21-\x7e]{1,256}$/;

/**
 * Reads a cookie from the request's Cookie header (no cookie-parser dependency needed for one value)
 */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Returns the session token sent in a header (Authorization: Bearer or X-API-AUTH), if any.
 * Header tokens are never sent automatically by browsers, so they need no CSRF protection.
 */
export function getHeaderSessionToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.substring(7).trim();
    if (token) return token;
  }
  const apiAuth = req.headers['x-api-auth'];
  if (typeof apiAuth === 'string' && apiAuth.trim()) return apiAuth.trim();
  return undefined;
}

/**
 * Returns the session token of a request: a header token (API clients) or the session cookie
 * (browser client).
 *
 * Tokens in the query string (e.g. ?auth=) are deliberately not accepted: URLs end up in access
 * logs, browser history and Referer headers.
 */
export function getSessionToken(req: Request): string | undefined {
  return getHeaderSessionToken(req) ?? (readCookie(req, SESSION_COOKIE) || undefined);
}

/**
 * Authentication middleware that verifies the session token against Joplin Server.
 * Accepts Authorization: Bearer <sessionId>, X-API-AUTH: <sessionId> or the session cookie.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const sessionId = getSessionToken(req);

    if (!sessionId) {
      res.status(401).json({ error: 'Unauthorized: Missing session. Please sign in.' });
      return;
    }

    if (!TOKEN_PATTERN.test(sessionId)) {
      res.status(401).json({ error: 'Unauthorized: Session has expired or is invalid' });
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
    pruneSessionValidationCache(now);
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
      console.error('[AuthMiddleware] Joplin Server unreachable:', error.message);
      res.status(503).json({ error: 'Cannot connect to Joplin Server' });
      return;
    }

    console.error('[AuthMiddleware] Error during session validation:', error);
    res.status(500).json({ error: 'Internal server error validating session' });
  }
}
