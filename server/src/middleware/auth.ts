import { NextFunction, Request, Response } from 'express';
import { config, type AppConfig } from '../config.js';
import {
  clearRememberCookies,
  clearSessionCookies,
  endJoplinSessionSafe,
  PENDING_COOKIE,
  REMEMBER_COOKIE,
  SECURE_PENDING_COOKIE,
  SECURE_REMEMBER_COOKIE,
  SECURE_SESSION_COOKIE,
  SECURE_TRUSTED_DEVICE_COOKIE,
  SESSION_COOKIE,
  sessionCookie,
  TRUSTED_DEVICE_COOKIE,
} from '../services/auth-cookies.js';
import { joplinApi, JoplinAuthError, JoplinConnectionError } from '../services/joplin-api.js';
import { noteCache } from '../services/note-cache.js';
import {
  decryptRememberEntry,
  hasPrimaryFactor,
  parseRememberCookie,
  TwoFactorStore,
} from '../services/two-factor-store.js';
import type { AppAuthState, RestoredSessionResult } from '../types/index.js';

export {
  PENDING_COOKIE,
  REMEMBER_COOKIE,
  SECURE_PENDING_COOKIE,
  SECURE_REMEMBER_COOKIE,
  SECURE_SESSION_COOKIE,
  SECURE_TRUSTED_DEVICE_COOKIE,
  SESSION_COOKIE,
  TRUSTED_DEVICE_COOKIE,
};

interface SessionValidationEntry {
  isValid: boolean;
  validatedAt: number;
}

// Fallback in-memory state when middleware is called without createApp's per-app authState
const sessionValidationCache = new Map<string, SessionValidationEntry>();
const fallbackRememberRestoreInFlight = new Map<string, Promise<RestoredSessionResult>>();

/** Above this size, expired entries are dropped before a new one is added */
const MAX_CACHED_VALIDATIONS = 1000;

/** Creates an isolated session validation cache and remember-me single-flight map for one createApp() instance */
export function createAppAuthState(): AppAuthState {
  return { validationCache: new Map(), rememberRestoreInFlight: new Map() };
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
const REMEMBER_COOKIE_NAMES = new Set([REMEMBER_COOKIE, SECURE_REMEMBER_COOKIE]);

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

/** Returns the values of all remember-me cookies in the Cookie header. */
export function readRememberCookies(req: Request): string[] {
  return readNamedCookies(req, REMEMBER_COOKIE_NAMES);
}

/** Whether the request carries any authentication-related cookie (session, pending 2FA, trusted device, or remember me). */
export function hasAuthCookies(req: Request): boolean {
  return (
    readSessionCookies(req).length > 0 ||
    readPendingCookies(req).length > 0 ||
    readTrustedDeviceCookies(req).length > 0 ||
    readRememberCookies(req).length > 0
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

/** Reads the single remember-me cookie token, flagging duplicate cookies. */
export function getRememberToken(req: Request): { token: string | undefined; duplicateCookies: boolean } {
  const cookies = readRememberCookies(req);
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

class RememberInvalidError extends Error {
  constructor() {
    super('Remember-me entry invalid or revoked');
    this.name = 'RememberInvalidError';
  }
}

/**
 * Restores a Joplin Server session from a single well-formed remember-me cookie.
 * Uses per-`idHash` single-flight so parallel requests at session expiry share one upstream
 * `createSession` call and receive the same new session cookie.
 */
async function restoreSessionFromRememberCookie(
  req: Request,
  res: Response,
  activeConfig: AppConfig,
  store: TwoFactorStore,
  rawCookie: string,
  oldSessionId: string | undefined
): Promise<boolean> {
  const parsed = parseRememberCookie(rawCookie);
  if (!parsed) {
    clearRememberCookies(res);
    res.status(401).json({ error: 'Unauthorized: Session has expired or is invalid' });
    return false;
  }

  const entry = store.getRememberEntry(parsed.idHash);
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) {
      await store.deleteRememberEntry(parsed.idHash);
    }
    clearRememberCookies(res);
    res.status(401).json({ error: 'Unauthorized: Session has expired or is invalid' });
    return false;
  }

  const creds = decryptRememberEntry(entry, parsed.key);
  if (!creds) {
    clearRememberCookies(res);
    res.status(401).json({ error: 'Unauthorized: Session has expired or is invalid' });
    return false;
  }

  const inFlightMap = req.authState?.rememberRestoreInFlight ?? fallbackRememberRestoreInFlight;
  let promise = inFlightMap.get(parsed.idHash);
  if (!promise) {
    promise = (async (): Promise<RestoredSessionResult> => {
      try {
        const session = await joplinApi.createSession(creds.email, creds.password);
        if (session.userId !== entry.userId) {
          await endJoplinSessionSafe(session.sessionId);
          await store.deleteRememberEntry(parsed.idHash);
          throw new RememberInvalidError();
        }
        const stillActive = await store.touchRememberEntry(parsed.idHash);
        if (!stillActive) {
          await endJoplinSessionSafe(session.sessionId);
          throw new RememberInvalidError();
        }
        cacheSessionValidation(session.sessionId, true, req.authState, activeConfig.authCacheTtlMs);
        store.recordSession(session.sessionId, {
          userId: session.userId,
          email: creds.email,
          // Same as trusted-device bypass: Settings mutations still require a fresh step-up
          twoFactorPassed: true,
          lastSecondFactorAt: null,
        });
        if (oldSessionId && oldSessionId !== session.sessionId && isWellFormedToken(oldSessionId)) {
          await endJoplinSessionSafe(oldSessionId);
        }
        return { sessionId: session.sessionId, userId: session.userId, email: creds.email };
      } catch (err) {
        if (err instanceof JoplinAuthError) {
          await store.deleteRememberEntry(parsed.idHash);
          throw new RememberInvalidError();
        }
        throw err;
      } finally {
        inFlightMap.delete(parsed.idHash);
      }
    })();
    inFlightMap.set(parsed.idHash, promise);
  }

  try {
    const restored = await promise;
    const sCookie = sessionCookie(activeConfig, req);
    clearSessionCookies(res, sCookie.name);
    res.cookie(sCookie.name, restored.sessionId, sCookie.options);
    req.sessionId = restored.sessionId;
    req.userId = restored.userId;
    req.userEmail = restored.email;
    return true;
  } catch (err) {
    if (err instanceof RememberInvalidError) {
      clearRememberCookies(res);
      res.status(401).json({ error: 'Unauthorized: Session has expired or is invalid' });
      return false;
    }
    if (err instanceof JoplinConnectionError) {
      console.error('[AuthMiddleware] Joplin Server unreachable during remember-me restore:', err.message);
      res.status(503).json({ error: 'Cannot connect to Joplin Server' });
      return false;
    }
    throw err;
  }
}

/**
 * Validates the current request's session and populates `req.sessionId`, `req.userId`, and
 * `req.userEmail`. Returns true when authorized; otherwise writes an error response and returns false.
 */
export async function authenticateSession(req: Request, res: Response): Promise<boolean> {
  try {
    const activeConfig = req.appConfig ?? config;
    const validationCache = req.authState?.validationCache ?? sessionValidationCache;
    const headerToken = getHeaderSessionToken(req);
    const { token: sessionId, duplicateCookies } = getSessionToken(req);

    if (duplicateCookies) {
      res.status(401).json({ error: 'Unauthorized: Conflicting session cookies. Please sign in again.' });
      return false;
    }

    const tryRememberRestore = async (
      oldSessionId: string | undefined,
      fallbackError: string
    ): Promise<boolean> => {
      if (!headerToken && activeConfig.cacheDir && req.twoFactorStore) {
        const rememberCookies = readRememberCookies(req);
        if (rememberCookies.length > 1) {
          clearRememberCookies(res);
          res.status(401).json({ error: 'Unauthorized: Conflicting remember-me cookies. Please sign in again.' });
          return false;
        }
        if (rememberCookies.length === 1) {
          return restoreSessionFromRememberCookie(
            req,
            res,
            activeConfig,
            req.twoFactorStore,
            rememberCookies[0],
            oldSessionId
          );
        }
      }
      res.status(401).json({ error: fallbackError });
      return false;
    };

    if (!sessionId) {
      return tryRememberRestore(undefined, 'Unauthorized: Missing session. Please sign in.');
    }

    if (!isWellFormedToken(sessionId)) {
      return tryRememberRestore(undefined, 'Unauthorized: Session has expired or is invalid');
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
      return tryRememberRestore(sessionId, 'Unauthorized: Session has expired or is invalid');
    }

    // Enforce 2FA completion when CACHE_DIR / REQUIRE_2FA is active so raw Joplin Server tokens
    // cannot bypass Joplin Web's second factor.
    const store = req.twoFactorStore;
    if (store) {
      const sessionRecord = store.getSession(sessionId);
      if (activeConfig.cacheDir) {
        if (!sessionRecord) {
          noteCache.clearCache(sessionId);
          return tryRememberRestore(sessionId, 'Unauthorized: Session has expired or is invalid');
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
