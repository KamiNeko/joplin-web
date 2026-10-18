import { NextFunction, Request, Response } from 'express';
import type { AppConfig } from '../config.js';
import { getHeaderSessionToken, readSessionCookies } from './auth.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function headerValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value ?? '').split(',')[0].trim().toLowerCase();
}

/**
 * CSRF protection for state-changing requests, on top of the SameSite=Strict session cookie.
 *
 * Browsers always send an Origin header on POST/PUT/DELETE. It must name this instance: the host the
 * request was sent to (Host or X-Forwarded-Host, which a cross-site page can't set), PUBLIC_URL or
 * one of the CORS_ORIGIN entries. Requests without Origin come from non-browser clients and are only
 * accepted when they don't rely on the session cookie. "Origin: null" (sandboxed frames, data: URLs)
 * is always rejected.
 */
export function createOriginCheck(config: Pick<AppConfig, 'corsOrigin' | 'publicUrl'>) {
  const configured = new Set<string>();
  for (const origin of [config.corsOrigin, config.publicUrl].flat()) {
    if (!origin || origin === '*') continue;
    try {
      configured.add(new URL(origin).origin);
    } catch {
      // not a valid origin, can never match
    }
  }

  const isAllowed = (origin: string, req: Request): boolean => {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (configured.has(url.origin)) return true;
    const host = url.host.toLowerCase();
    return host === headerValue(req.headers.host) || host === headerValue(req.headers['x-forwarded-host']);
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) return next();

    const origin = req.headers.origin;
    if (origin === undefined) {
      if (getHeaderSessionToken(req) || readSessionCookies(req).length === 0) return next();
    } else if (isAllowed(origin, req)) {
      return next();
    }

    res.status(403).json({
      error:
        'Request origin not allowed. If Joplin Web runs behind a reverse proxy, set PUBLIC_URL to the address you open it at.',
    });
  };
}
