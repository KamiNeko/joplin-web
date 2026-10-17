import type { IncomingMessage } from 'http';
import morgan from 'morgan';

/** Query parameters whose values must never reach the logs */
const SENSITIVE_QUERY_PARAMS = new Set(['auth', 'token', 'session', 'sessionid', 'password', 'api_key', 'apikey']);

/**
 * Replaces the values of sensitive query parameters (session tokens, passwords) in a request URL,
 * e.g. "/api/resources/x?auth=abc" -> "/api/resources/x?auth=[REDACTED]".
 */
export function redactUrl(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return url;
  const hashStart = url.indexOf('#', queryStart);
  const query = url.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart);
  const redacted = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const rawKey = eq === -1 ? pair : pair.slice(0, eq);
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      } catch {
        // keep the raw key
      }
      return SENSITIVE_QUERY_PARAMS.has(key.trim().toLowerCase()) ? `${rawKey}=[REDACTED]` : pair;
    })
    .join('&');
  const fragment = hashStart === -1 ? '' : url.slice(hashStart);
  return `${url.slice(0, queryStart)}?${redacted}${fragment}`;
}

// Override morgan's built-in :url token, which every predefined format uses
morgan.token('url', (req: IncomingMessage) =>
  redactUrl((req as IncomingMessage & { originalUrl?: string }).originalUrl || req.url || '')
);

/**
 * HTTP request logger. Uses morgan's formats with the URL token redacted, so session tokens passed
 * in query strings never end up in log files.
 */
export function requestLogger(production: boolean) {
  return morgan(production ? 'combined' : 'dev');
}
