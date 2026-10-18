import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables from .env file
dotenv.config();

export interface AppConfig {
  port: number;
  joplinServerUrl: string;
  /** Allowed cross-origin callers; false means same-origin only (no CORS headers) */
  corsOrigin: string | string[] | false;
  nodeEnv: string;
  cacheTtlMs: number;
  authCacheTtlMs: number;
  clientDistPath: string;
  /** Value for Express' "trust proxy" setting; false means X-Forwarded-* headers are ignored */
  trustProxy: boolean | number | string[];
  /** Origin users open Joplin Web at (e.g. https://notes-web.example.com), if configured */
  publicUrl: string | null;
  /** Allow notes to load images from any https: URL (CSP img-src) */
  allowRemoteImages: boolean;
  /** Secure flag of the session cookie; 'auto' sets it when the request came in over HTTPS */
  cookieSecure: boolean | 'auto';
  /** Release version from APP_VERSION (set at image build time), "dev" otherwise */
  appVersion: string;
  /** Git commit the build was made from (GIT_SHA), or null when unknown */
  gitSha: string | null;
  /** Requests per client address and 15 minutes allowed on /api/ (RATE_LIMIT_MAX) */
  rateLimitMax: number;
}

/**
 * Thrown when the environment doesn't describe a usable configuration
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Parses CORS_ORIGIN. Unset means same-origin only in production (the bundled UI needs no CORS)
 * and the Vite dev server origin otherwise.
 */
const parseCorsOrigin = (raw: string | undefined, nodeEnv: string): string | string[] | false => {
  const origin = raw?.trim();
  if (!origin) return nodeEnv === 'production' ? false : 'http://localhost:5173';
  if (origin === '*') return '*';
  if (origin.includes(',')) {
    return origin.split(',').map((o) => o.trim());
  }
  return origin.trim();
};

/**
 * Validates JOPLIN_SERVER_URL. There is deliberately no default: falling back to some server would
 * send users' credentials to a host they never configured.
 */
function parseJoplinServerUrl(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) {
    throw new ConfigError(
      'JOPLIN_SERVER_URL is not set. Set it to the base URL of your Joplin Server ' +
        '(e.g. JOPLIN_SERVER_URL=https://notes.example.com in server/.env or the container environment). ' +
        'To try Joplin Web without a Joplin Server, run "npm --prefix server run demo".'
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`JOPLIN_SERVER_URL is not a valid URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`JOPLIN_SERVER_URL must start with http:// or https://, got: ${value}`);
  }
  if (url.username || url.password) {
    throw new ConfigError('JOPLIN_SERVER_URL must not contain credentials');
  }
  // Strip trailing slash if present
  return value.replace(/\/+$/, '');
}

/**
 * Parses TRUST_PROXY: unset/false/0 (default, X-Forwarded-* is ignored), true (trust every proxy:
 * only safe if Joplin Web can't be reached except through the proxy), a hop count, or a
 * comma-separated list of proxy addresses/subnets (e.g. "loopback, 10.0.0.0/8").
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string[] {
  const value = raw?.trim().toLowerCase();
  if (!value || value === 'false' || value === '0') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  const list = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (list.some((entry) => !/^[0-9a-f.:/]+$|^(loopback|linklocal|uniquelocal)$/.test(entry))) {
    throw new ConfigError(
      `TRUST_PROXY must be true, false, a hop count or a comma-separated list of IP addresses/subnets, got: ${raw}`
    );
  }
  return list;
}

function parseBoolean(name: string, raw: string | undefined, fallback: boolean): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return fallback;
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  throw new ConfigError(`${name} must be true or false, got: ${raw}`);
}

function parseCookieSecure(raw: string | undefined): boolean | 'auto' {
  if (!raw?.trim() || raw.trim().toLowerCase() === 'auto') return 'auto';
  return parseBoolean('COOKIE_SECURE', raw, false);
}

/** Validates PUBLIC_URL and reduces it to its origin */
function parsePublicUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`PUBLIC_URL is not a valid URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`PUBLIC_URL must start with http:// or https://, got: ${value}`);
  }
  return url.origin;
}

/**
 * Build metadata is public (GET /api/health), so only plain version strings are accepted.
 */
function parseAppVersion(raw: string | undefined): string {
  const value = raw?.trim();
  return value && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(value) ? value : 'dev';
}

/**
 * Accepts a hex commit hash (7-40 characters); anything else means unknown.
 */
function parseGitSha(raw: string | undefined): string | null {
  const value = raw?.trim().toLowerCase();
  return value && /^[0-9a-f]{7,40}$/.test(value) ? value : null;
}

/**
 * Parses RATE_LIMIT_MAX, the general request limit per client address and 15 minutes. Unset means
 * 1000; anything but a positive whole number is rejected.
 */
export function parseRateLimitMax(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) return 1000;
  if (!/^\d+$/.test(value) || parseInt(value, 10) < 1) {
    throw new ConfigError(`RATE_LIMIT_MAX must be a positive whole number, got: ${raw}`);
  }
  return parseInt(value, 10);
}

// Resolved from this module, not process.cwd(): src/config.ts (tsx) and dist/config.js (compiled)
// both sit two levels below the repo root, so this finds client/dist wherever the server is started.
const defaultClientDistPath = fileURLToPath(new URL('../../client/dist', import.meta.url));

/**
 * Builds the application config from environment variables. Throws ConfigError when
 * JOPLIN_SERVER_URL is missing or invalid.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV || 'development';
  return {
    port: parseInt(env.PORT || '3001', 10),
    joplinServerUrl: parseJoplinServerUrl(env.JOPLIN_SERVER_URL),
    corsOrigin: parseCorsOrigin(env.CORS_ORIGIN, nodeEnv),
    nodeEnv,
    cacheTtlMs: parseInt(env.CACHE_TTL_MS || '30000', 10),
    authCacheTtlMs: parseInt(env.AUTH_CACHE_TTL_MS || '300000', 10),
    clientDistPath: defaultClientDistPath,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    publicUrl: parsePublicUrl(env.PUBLIC_URL),
    allowRemoteImages: parseBoolean('ALLOW_REMOTE_IMAGES', env.ALLOW_REMOTE_IMAGES, false),
    cookieSecure: parseCookieSecure(env.COOKIE_SECURE),
    appVersion: parseAppVersion(env.APP_VERSION),
    gitSha: parseGitSha(env.GIT_SHA),
    rateLimitMax: parseRateLimitMax(env.RATE_LIMIT_MAX),
  };
}

function loadConfigOrExit(): AppConfig {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[Config] ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

export const config: AppConfig = loadConfigOrExit();
