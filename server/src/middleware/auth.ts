import { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { joplinApi, JoplinAuthError, JoplinConnectionError } from '../services/joplin-api.js';
import { noteCache } from '../services/note-cache.js';
import { hasPrimaryFactor, TwoFactorStore } from '../services/two-factor-store.js';
import type { AppAuthState } from '../types/index.js';

interface SessionValidationEntry {
  isValid: boolean;
  validatedAt: number;
}

// Fallback in-memory cache when middleware is called without createApp's per-app authState
const sessionValidationCache = new Map<string, SessionValidationEntry>();

/** Above this size, expired entries are dropped before a new one is added */
const MAX_CACHED_VALIDATIONS = 1000;

/** Creates an isolated session validation cache for one createApp() instance */
export function createAppAuthState(): AppAuthState {
  return { validationCache: new Map() };
}

/**
 * Drops expired validation results, so random tokens sent by a client can't grow the cache forever
 */
function pruneSessionValidationCache(
  cache: Map<string, SessionValidationEntry>,
  ttlMs: number,
  now: number
): void {
  if (cache.size < MAX_CACHED_VALIDATIONS) return;
  for (const [id, entry] of cache) {
    if (now - entry.validatedAt >= ttlMs) cache.delete(id);
  }
}

/**
 * Caches session validity status
 */
export function cacheSessionValidation(
  sessionId: string,
  isValid: boolean,
  authState?: AppAuthState,
  ttlMs = config.authCacheTtlMs
): void {
  const cache = authState?.validationCache ?? sessionValidationCache;
  const now = Date.now();
  pruneSessionValidationCache(cache, ttlMs, now);
  cache.set(sessionId, { isValid, validatedAt: now });
}

/**
 * Marks a session as logged out or expired: it is rejected without asking Joplin Server until the
 * validation cache entry expires, even if ending it on Joplin Server failed. Its note cache is freed.
 */
export function invalidateSessionValidation(
  sessionId: string,
  authState?: AppAuthState,
  twoFactorStore?: TwoFactorStore
): void {
  cacheSessionValidation(sessionId, false, authState);
  noteCache.clearCache(sessionId);
  twoFactorStore?.removeSession(sessionId);
}

/** httpOnly cookie that carries the session for the browser client over plain HTTP */
export const SESSION_COOKIE = 'joplin_web_session';
/**
 * Name used when the cookie is Secure. The __Host- prefix makes browsers refuse versions of it set
 * with a Domain or another Path, so sibling hosts and other apps on this host can't plant one.
 */
export const SECURE_SESSION_COOKIE = '__Host-joplin_web_session';

/** Short-lived httpOnly cookie holding the pending-2FA login identifier */
export const PENDING_COOKIE = 'joplin_web_2fa_pending';
export const SECURE_PENDING_COOKIE = '__Host-joplin_web_2fa_pending';

/** 30-day httpOnly cookie holding the "Trust this device" token */
export const TRUSTED_DEVICE_COOKIE = 'joplin_web_trusted_device';
export const SECURE_TRUSTED_DEVICE_COOKIE = '__Host-joplin_web_trusted_device';

/** Joplin Server session ids are short ASCII tokens; anything else is rejected before use */
const TOKEN_PATTERN = /^[\x21-\x7e]{1,256}$/;

/**
 * Whether a token looks like a Joplin Server session id (before it is cached or sent upstream)
 */
export function isWellFormedToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

function readNamedCookies(req: Request, names: ReadonlySet<string>): string[] {
  const header = req.headers.cookie;
  if (!header) return [];
  const values: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!names.has(name)) continue;
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

const SESSION_COOKIE_NAMES = new Set([SESSION_COOKIE, SECURE_SESSION_COOKIE]);
const PENDING_COOKIE_NAMES = new Set([PENDING_COOKIE, SECURE_PENDING_COOKIE]);
const TRUSTED_DEVICE_COOKIE_NAMES = new Set([TRUSTED_DEVICE_COOKIE, SECURE_TRUSTED_DEVICE_COOKIE]);

/**
 * Returns the values of all session cookies (either name) in the request's Cookie header. More than
 * one means another app on this host planted a cookie (e.g. with a longer Path) to ride on.
 */
export function readSessionCookies(req: Request): string[] {
  return readNamedCookies(req, SESSION_COOKIE_NAMES);
}

/** Returns the values of all pending-2FA cookies in the Cookie header. */
export function readPendingCookies(req: Request): string[] {
  return readNamedCookies(req, PENDING_COOKIE_NAMES);
}

/** Returns the values of all trusted-device cookies in the Cookie header. */
export function readTrustedDeviceCookies(req: Request): string[] {
  return readNamedCookies(req, TRUSTED_DEVICE_COOKIE_NAMES);
}

/** Whether the request carries any authentication-related cookie (session, pending 2FA, or trusted device). */
export function hasAuthCookies(req: Request): boolean {
  return (
    readSessionCookies(req).length > 0 ||
    readPendingCookies(req).length > 0 ||
    readTrustedDeviceCookies(req).length > 0
  );
}

/** Reads the single pending-2FA cookie token, flagging duplicate cookies. */
export function getPendingToken(req: Request): { token: string | undefined; duplicateCookies: boolean } {
  const cookies = readPendingCookies(req);
  if (cookies.length > 1) return { token: undefined, duplicateCookies: true };
  return { token: cookies[0] || undefined, duplicateCookies: false };
}

/** Reads the single trusted-device cookie token, flagging duplicate cookies. */
export function getTrustedDeviceToken(req: Request): { token: string | undefined; duplicateCookies: boolean } {
  const cookies = readTrustedDeviceCookies(req);
  if (cookies.length > 1) return { token: undefined, duplicateCookies: true };
  return { token: cookies[0] || undefined, duplicateCookies: false };
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
 * Validates the current request's session and populates `req.sessionId`, `req.userId`, and
 * `req.userEmail`. Returns true when authorized; otherwise writes an error response and returns false.
 */
export async function authenticateSession(req: Request, res: Response): Promise<boolean> {
  try {
    const activeConfig = req.appConfig ?? config;
    const validationCache = req.authState?.validationCache ?? sessionValidationCache;
    const { token: sessionId, duplicateCookies } = getSessionToken(req);

    if (duplicateCookies) {
      res.status(401).json({ error: 'Unauthorized: Conflicting session cookies. Please sign in again.' });
      return false;
    }

    if (!sessionId) {
      res.status(401).json({ error: 'Unauthorized: Missing session. Please sign in.' });
      return false;
    }

    if (!isWellFormedToken(sessionId)) {
      res.status(401).json({ error: 'Unauthorized: Session has expired or is invalid' });
      return false;
    }

    // Check in-memory session validation cache
    const cached = validationCache.get(sessionId);
    const now = Date.now();
    let isValid: boolean;

    if (cached && now - cached.validatedAt < activeConfig.authCacheTtlMs) {
      isValid = cached.isValid;
    } else {
      // Validate session with Joplin Server
      isValid = await joplinApi.checkSession(sessionId);
      pruneSessionValidationCache(validationCache, activeConfig.authCacheTtlMs, now);
      validationCache.set(sessionId, {
        isValid,
        validatedAt: now,
      });
    }

    if (!isValid) {
      noteCache.clearCache(sessionId);
      req.twoFactorStore?.removeSession(sessionId);
      res.status(401).json({ error: 'Unauthorized: Session has expired or is invalid' });
      return false;
    }

    // Enforce 2FA completion when CACHE_DIR / REQUIRE_2FA is active so raw Joplin Server tokens
    // cannot bypass Joplin Web's second factor.
    const store = req.twoFactorStore;
    if (store) {
      const sessionRecord = store.getSession(sessionId);
      if (activeConfig.cacheDir) {
        if (!sessionRecord) {
          res.status(401).json({ error: 'Unauthorized: Session has expired or is invalid' });
          return false;
        }
        if (activeConfig.require2fa && !sessionRecord.twoFactorPassed) {
          res.status(401).json({ error: 'Unauthorized: Two-factor authentication required' });
          return false;
        }
        const userRecord = store.getUserRecord(sessionRecord.userId);
        if (hasPrimaryFactor(userRecord) && !sessionRecord.twoFactorPassed) {
          res.status(401).json({ error: 'Unauthorized: Two-factor authentication required' });
          return false;
        }
        req.userId = sessionRecord.userId;
        req.userEmail = sessionRecord.email;
      } else if (sessionRecord) {
        req.userId = sessionRecord.userId;
        req.userEmail = sessionRecord.email;
      }
    }

    req.sessionId = sessionId;
    return true;
  } catch (error) {
    if (error instanceof JoplinAuthError) {
      res.status(401).json({ error: error.message });
      return false;
    }

    if (error instanceof JoplinConnectionError) {
      console.error('[AuthMiddleware] Joplin Server unreachable:', error.message);
      res.status(503).json({ error: 'Cannot connect to Joplin Server' });
      return false;
    }

    console.error('[AuthMiddleware] Error during session validation:', error);
    res.status(500).json({ error: 'Internal server error validating session' });
    return false;
  }
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
  if (await authenticateSession(req, res)) {
    next();
  }
}
