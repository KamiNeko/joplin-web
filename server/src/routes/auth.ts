import { CookieOptions, Request, Response, Router } from 'express';
import type { AppConfig } from '../config.js';
import { joplinApi, JoplinAuthError } from '../services/joplin-api.js';
import { noteCache } from '../services/note-cache.js';
import {
  cacheSessionValidation,
  getSessionToken,
  invalidateSessionValidation,
  isWellFormedToken,
  requireAuth,
  SECURE_SESSION_COOKIE,
  SESSION_COOKIE,
} from '../middleware/auth.js';

/**
 * Cookie attributes for the session cookie. httpOnly keeps it away from scripts, SameSite=Strict
 * keeps it off cross-site requests. It is a browser-session cookie (no Max-Age): closing the browser
 * ends it, and Joplin Server expires the session on its own anyway.
 */
export function sessionCookie(
  config: Pick<AppConfig, 'cookieSecure' | 'publicUrl'>,
  req: Request
): { name: string; options: CookieOptions } {
  const secure =
    config.cookieSecure === 'auto'
      ? req.secure || Boolean(config.publicUrl?.startsWith('https:'))
      : config.cookieSecure;
  // __Host- requires Secure and Path=/; without HTTPS the cookie is limited to /api instead
  return secure
    ? { name: SECURE_SESSION_COOKIE, options: { httpOnly: true, sameSite: 'strict', secure: true, path: '/' } }
    : { name: SESSION_COOKIE, options: { httpOnly: true, sameSite: 'strict', secure: false, path: '/api' } };
}

/** Clears both cookie variants (the deployment may have switched between HTTP and HTTPS) */
function clearSessionCookies(res: Response, keep?: string): void {
  if (keep !== SESSION_COOKIE) {
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', path: '/api' });
  }
  if (keep !== SECURE_SESSION_COOKIE) {
    res.clearCookie(SECURE_SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure: true, path: '/' });
  }
}

/**
 * Builds the /api/auth router
 */
export function createAuthRouter(
  config: Pick<AppConfig, 'cookieSecure' | 'publicUrl' | 'joplinServerUrl'>
): Router {
  // Shown in the client's connection status; only sent to signed-in users
  const serverHost = new URL(config.joplinServerUrl).host;
  const router = Router();

  /**
   * POST /api/auth/login
   * Authenticates with Joplin Server using email and password and sets the session cookie.
   * The token is only included in the JSON body for non-browser API clients (requests without an
   * Origin header); browsers only ever get the httpOnly cookie.
   */
  router.post('/login', async (req, res) => {
    try {
      const { email, password } = req.body ?? {};

      if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
        res.status(400).json({ error: 'Email and password are required' });
        return;
      }

      const session = await joplinApi.createSession(email, password);

      // Cache the new session as valid
      cacheSessionValidation(session.sessionId, true);
      console.log(`[AuthRoute] Login succeeded, session ${session.sessionId.substring(0, 8)}...`);

      const cookie = sessionCookie(config, req);
      clearSessionCookies(res, cookie.name);
      res.cookie(cookie.name, session.sessionId, cookie.options);
      res.status(200).json({
        userId: session.userId,
        ...(req.headers.origin === undefined ? { sessionId: session.sessionId } : {}),
      });
    } catch (error) {
      if (error instanceof JoplinAuthError) {
        console.log('[AuthRoute] Login failed: invalid credentials');
        res.status(401).json({ error: 'Invalid email or password' });
        return;
      }
      throw error;
    }
  });

  /**
   * POST /api/auth/logout
   * Ends the session on Joplin Server, drops all cached state for it and clears the cookie.
   * Succeeds even if Joplin Server can't be reached; the session is then still rejected locally.
   */
  router.post('/logout', async (req, res) => {
    // With duplicate cookies there is no trustworthy token to end; just clear them
    const { token: sessionId } = getSessionToken(req);
    clearSessionCookies(res);

    // Malformed tokens are never cached or sent upstream (unauthenticated callers could flood both)
    if (sessionId && isWellFormedToken(sessionId)) {
      console.log(`[AuthRoute] Logging out session: ${sessionId.substring(0, 8)}...`);
      invalidateSessionValidation(sessionId);
      noteCache.clearCache(sessionId);
      try {
        await joplinApi.deleteSession(sessionId);
      } catch (error) {
        console.warn(
          '[AuthRoute] Could not end the session on Joplin Server:',
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    res.status(200).json({ message: 'Successfully logged out' });
  });

  /**
   * GET /api/auth/check
   * Validates the current session and returns the Joplin Server host for display. The token itself
   * is never echoed back.
   */
  router.get('/check', requireAuth, (_req, res) => {
    res.status(200).json({ valid: true, serverHost });
  });

  return router;
}
