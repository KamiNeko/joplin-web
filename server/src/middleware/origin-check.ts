import { NextFunction, Request, Response } from 'express';
import type { AppConfig } from '../config.js';
import { getHeaderSessionToken, hasAuthCookies } from './auth.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function headerValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value ?? '').split(',')[0].trim().toLowerCase();
}

/**
 * CSRF protection for state-changing requests, on top of the SameSite=Strict session cookie.
 *
 * Browsers always send an Origin header on POST/PUT/DELETE. It must name this instance: the host the
 * request was sent to (Host — or X-Forwarded-Host only when TRUST_PROXY trusts the peer),
 * PUBLIC_URL or one of the CORS_ORIGIN entries. Requests without Origin come from non-browser
 * clients and are only accepted when they don't rely on the session cookie. "Origin: null"
 * (sandboxed frames, data: URLs) is always rejected.
 */
export function createOriginCheck(
  config: Pick<AppConfig, 'corsOrigin' | 'publicUrl' | 'trustProxy'> & {
    clipperExtensionIds?: string[];
  }
) {
  const configured = new Set<string>();
  for (const origin of [config.corsOrigin, config.publicUrl].flat()) {
    if (!origin || origin === '*') continue;
    try {
      configured.add(new URL(origin).origin);
    } catch {
      // not a valid origin, can never match
    }
  }

  const allowedExtensions = new Set<string>(
    (config.clipperExtensionIds ?? [])
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean)
      .map((id) => `chrome-extension://${id}`)
  );

  const trustsForwardedHost = (req: Request): boolean => {
    if (config.trustProxy === false) return false;
    const trustProxyFn = req.app?.get('trust proxy fn') as
      | ((addr: string, hop: number) => boolean)
      | undefined;
    if (typeof trustProxyFn !== 'function') return Boolean(config.trustProxy);
    return Boolean(req.socket?.remoteAddress && trustProxyFn(req.socket.remoteAddress, 0));
  };

  const isAllowed = (origin: string, req: Request): boolean => {
    const lowerOrigin = origin.toLowerCase();
    if (lowerOrigin.startsWith('chrome-extension://')) {
      return allowedExtensions.has(lowerOrigin);
    }
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (configured.has(url.origin)) return true;
    const host = url.host.toLowerCase();
    if (host === headerValue(req.headers.host)) return true;
    return trustsForwardedHost(req) && host === headerValue(req.headers['x-forwarded-host']);
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) return next();

    const origin = req.headers.origin;
    if (origin === undefined) {
      if (getHeaderSessionToken(req) || !hasAuthCookies(req)) return next();
    } else if (isAllowed(origin, req)) {
      return next();
    }

    const isExtensionOrigin = typeof origin === 'string' && origin.toLowerCase().startsWith('chrome-extension://');
    res.status(403).json({
      error: isExtensionOrigin
        ? 'Request origin not allowed. To allow the browser clipper extension, set CLIPPER_EXTENSION_IDS on the server.'
        : 'Request origin not allowed. If Joplin Web runs behind a reverse proxy, set PUBLIC_URL to the address you open it at.',
    });
  };
}
