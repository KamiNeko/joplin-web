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
  const now = Date.now();
  pruneSessionValidationCache(now);
  sessionValidationCache.set(sessionId, { isValid, validatedAt: now });
}

/**
 * Marks a session as logged out: it is rejected without asking Joplin Server until the validation
 * cache entry expires, even if ending it on Joplin Server failed.
 */
export function invalidateSessionValidation(sessionId: string): void {
  cacheSessionValidation(sessionId, false);
}

/** httpOnly cookie that carries the session for the browser client over plain HTTP */
export const SESSION_COOKIE = 'joplin_web_session';
/**
 * Name used when the cookie is Secure. The __Host- prefix makes browsers refuse versions of it set
 * with a Domain or another Path, so sibling hosts and other apps on this host can't plant one.
 */
export const SECURE_SESSION_COOKIE = '__Host-joplin_web_session';

/** Joplin Server session ids are short ASCII tokens; anything else is rejected before use */
const TOKEN_PATTERN = /^[\x21-\x7e]{1,256}$/;

/**
 * Whether a token looks like a Joplin Server session id (before it is cached or sent upstream)
 */
export function isWellFormedToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

/**
 * Returns the values of all session cookies (either name) in the request's Cookie header. More than
 * one means another app on this host planted a cookie (e.g. with a longer Path) to ride on.
 */
export function readSessionCookies(req: Request): string[] {
  const header = req.headers.cookie;
  if (!header) return [];
  const values: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== SESSION_COOKIE && name !== SECURE_SESSION_COOKIE) continue;
    let value: string;
    try {
      value = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      value = '';
    }
    values.push(value);
  }
  return values;
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
export function getSessionToken(req: Request): { token: string | undefined; duplicateCookies: boolean } {
  const headerToken = getHeaderSessionToken(req);
  if (headerToken) return { token: headerToken, duplicateCookies: false };
  const cookies = readSessionCookies(req);
  if (cookies.length > 1) return { token: undefined, duplicateCookies: true };
  return { token: cookies[0] || undefined, duplicateCookies: false };
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
    const { token: sessionId, duplicateCookies } = getSessionToken(req);

    if (duplicateCookies) {
      res.status(401).json({ error: 'Unauthorized: Conflicting session cookies. Please sign in again.' });
      return;
    }

    if (!sessionId) {
      res.status(401).json({ error: 'Unauthorized: Missing session. Please sign in.' });
      return;
    }

    if (!isWellFormedToken(sessionId)) {
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
