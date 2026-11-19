import type { CookieOptions, Request, Response } from 'express';
import type { AppConfig } from '../config.js';
import {
  cacheSessionValidation,
  PENDING_COOKIE,
  SECURE_PENDING_COOKIE,
  SECURE_SESSION_COOKIE,
  SECURE_TRUSTED_DEVICE_COOKIE,
  SESSION_COOKIE,
  TRUSTED_DEVICE_COOKIE,
} from '../middleware/auth.js';
import { joplinApi } from './joplin-api.js';
import { PendingLogin, TwoFactorStore } from './two-factor-store.js';

export function isSecureCookieRequest(
  config: Pick<AppConfig, 'cookieSecure' | 'publicUrl'>,
  req: Request
): boolean {
  return config.cookieSecure === 'auto'
    ? req.secure || Boolean(config.publicUrl?.startsWith('https:'))
    : config.cookieSecure;
}

/**
 * Cookie attributes for the session cookie. httpOnly keeps it away from scripts, SameSite=Strict
 * keeps it off cross-site requests. It is a browser-session cookie (no Max-Age): closing the browser
 * ends it, and Joplin Server expires the session on its own anyway.
 */
export function sessionCookie(
  config: Pick<AppConfig, 'cookieSecure' | 'publicUrl'>,
  req: Request
): { name: string; options: CookieOptions } {
  const secure = isSecureCookieRequest(config, req);
  // __Host- requires Secure and Path=/; without HTTPS the cookie is limited to /api instead
  return secure
    ? { name: SECURE_SESSION_COOKIE, options: { httpOnly: true, sameSite: 'strict', secure: true, path: '/' } }
    : { name: SESSION_COOKIE, options: { httpOnly: true, sameSite: 'strict', secure: false, path: '/api' } };
}

/** Clears both session cookie variants (the deployment may have switched between HTTP and HTTPS). */
export function clearSessionCookies(res: Response, keep?: string): void {
  if (keep !== SESSION_COOKIE) {
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', path: '/api' });
  }
  if (keep !== SECURE_SESSION_COOKIE) {
    res.clearCookie(SECURE_SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure: true, path: '/' });
  }
}

/** Short-lived httpOnly cookie attributes for pending 2FA login state (5 min Max-Age). */
export function pendingCookie(
  config: Pick<AppConfig, 'cookieSecure' | 'publicUrl'>,
  req: Request
): { name: string; options: CookieOptions } {
  const secure = isSecureCookieRequest(config, req);
  const maxAge = 5 * 60 * 1000;
  return secure
    ? { name: SECURE_PENDING_COOKIE, options: { httpOnly: true, sameSite: 'strict', secure: true, path: '/', maxAge } }
    : { name: PENDING_COOKIE, options: { httpOnly: true, sameSite: 'strict', secure: false, path: '/api', maxAge } };
}

/** Clears both pending cookie variants. */
export function clearPendingCookies(res: Response, keep?: string): void {
  if (keep !== PENDING_COOKIE) {
    res.clearCookie(PENDING_COOKIE, { httpOnly: true, sameSite: 'strict', path: '/api' });
  }
  if (keep !== SECURE_PENDING_COOKIE) {
    res.clearCookie(SECURE_PENDING_COOKIE, { httpOnly: true, sameSite: 'strict', secure: true, path: '/' });
  }
}

/** 30-day httpOnly cookie attributes for "Trust this device". */
export function trustedDeviceCookie(
  config: Pick<AppConfig, 'cookieSecure' | 'publicUrl'>,
  req: Request
): { name: string; options: CookieOptions } {
  const secure = isSecureCookieRequest(config, req);
  const maxAge = 30 * 24 * 60 * 60 * 1000;
  return secure
    ? {
        name: SECURE_TRUSTED_DEVICE_COOKIE,
        options: { httpOnly: true, sameSite: 'strict', secure: true, path: '/', maxAge },
      }
    : {
        name: TRUSTED_DEVICE_COOKIE,
        options: { httpOnly: true, sameSite: 'strict', secure: false, path: '/api', maxAge },
      };
}

/** Clears both trusted-device cookie variants. */
export function clearTrustedDeviceCookies(res: Response, keep?: string): void {
  if (keep !== TRUSTED_DEVICE_COOKIE) {
    res.clearCookie(TRUSTED_DEVICE_COOKIE, { httpOnly: true, sameSite: 'strict', path: '/api' });
  }
  if (keep !== SECURE_TRUSTED_DEVICE_COOKIE) {
    res.clearCookie(SECURE_TRUSTED_DEVICE_COOKIE, { httpOnly: true, sameSite: 'strict', secure: true, path: '/' });
  }
}

/**
 * Best-effort termination of an upstream Joplin Server session; logs warnings on failure without throwing.
 */
export async function endJoplinSessionSafe(sessionId: string): Promise<void> {
  try {
    await joplinApi.deleteSession(sessionId);
  } catch (error) {
    console.warn(
      '[AuthRoute] Could not end the session on Joplin Server:',
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Promotes a verified pending login into a full Joplin Web session: deletes the pending record,
 * records the session, sets the httpOnly session cookie, clears the pending cookie, and optionally
 * issues a 30-day trusted-device cookie.
 */
export async function promotePendingLogin(
  req: Request,
  res: Response,
  config: Pick<AppConfig, 'cookieSecure' | 'publicUrl' | 'authCacheTtlMs' | 'cacheDir'>,
  store: TwoFactorStore,
  pending: PendingLogin,
  options: { trustDevice?: boolean } = {}
): Promise<void> {
  store.deletePendingByHash(pending.tokenHash);
  cacheSessionValidation(pending.joplinSessionId, true, req.authState, config.authCacheTtlMs);
  store.recordSession(pending.joplinSessionId, {
    userId: pending.userId,
    email: pending.email,
    twoFactorPassed: true,
    lastSecondFactorAt: Date.now(),
  });

  const sCookie = sessionCookie(config, req);
  clearSessionCookies(res, sCookie.name);
  res.cookie(sCookie.name, pending.joplinSessionId, sCookie.options);
  clearPendingCookies(res);

  if (options.trustDevice && config.cacheDir) {
    const { token } = await store.createTrustedDevice(pending.userId, req.headers['user-agent']);
    const tdCookie = trustedDeviceCookie(config, req);
    clearTrustedDeviceCookies(res, tdCookie.name);
    res.cookie(tdCookie.name, token, tdCookie.options);
  }
}
