import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables from .env file
dotenv.config();

export interface AppConfig {
  /** Interface/IP to bind (undefined listens on Node's default) */
  host?: string;
  port: number;
  joplinServerUrl: string;
  /** Allowed cross-origin callers; false means same-origin only (no CORS headers) */
  corsOrigin: string | string[] | false;
  nodeEnv: string;
  cacheTtlMs: number;
  /** Directory the note caches are kept in across restarts (CACHE_DIR), null keeps them in memory only */
  cacheDir: string | null;
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
  /** Base URL of an OpenAI-compatible Chat Completions endpoint (AI_BASE_URL), null when unset */
  aiBaseUrl: string | null;
  /** Optional API key sent as Bearer token to AI_BASE_URL (AI_API_KEY) */
  aiApiKey: string | null;
  /** Model name sent to AI_BASE_URL (AI_MODEL), null when unset */
  aiModel: string | null;
  /** Maximum concurrent LLM classification calls per organize job (AI_CONCURRENCY, default 4) */
  aiConcurrency: number;
  /** Built-in deterministic fake organizer flag for demo/tests (AI_FAKE) */
  aiFake: boolean;
  /** Optional artificial per-note delay in ms when using the fake organizer (AI_FAKE_DELAY_MS) */
  aiFakeDelayMs: number;
  /** Whether every login must pass a second factor (REQUIRE_2FA, default false) */
  require2fa: boolean;
  /** Optional webhook shared secret for POST /api/webhooks/email (EMAIL_INGEST_WEBHOOK_SECRET) */
  emailIngestWebhookSecret: string | null;
  /** Service Joplin credentials used by EMAIL_INGEST webhook when enabled */
  emailIngestJoplinEmail: string | null;
  emailIngestJoplinPassword: string | null;
  emailIngestNotebookId: string | null;
  /** Optional local OCR bridge service URL (OCR_SERVICE_URL), null when unset */
  ocrServiceUrl: string | null;
  /** Shared secret header X-Ocr-Secret sent to OCR_SERVICE_URL (OCR_SERVICE_SECRET) */
  ocrServiceSecret: string | null;
  /** How long POST /api/resources waits for inline OCR before returning pending (OCR_INLINE_WAIT_MS) */
  ocrInlineWaitMs: number;
  /** Transcription model name used via AI_BASE_URL (AI_TRANSCRIBE_MODEL; 'off'/'none'/'false' disables) */
  aiTranscribeModel: string | null;
  /** Allowed Chrome extension IDs for the browser clipper (CLIPPER_EXTENSION_IDS, comma-separated) */
  clipperExtensionIds: string[];
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
 * Parses a positive whole number config setting.
 */
function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value) || parseInt(value, 10) < 1) {
    throw new ConfigError(`${name} must be a positive whole number, got: ${raw}`);
  }
  return parseInt(value, 10);
}

function parseNonNegativeInt(name: string, raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(`${name} must be a non-negative whole number, got: ${raw}`);
  }
  return parseInt(value, 10);
}

/**
 * Validates an optional HTTP/HTTPS service URL without embedded credentials.
 */
function parseOptionalHttpUrl(name: string, raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} is not a valid URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${name} must start with http:// or https://, got: ${value}`);
  }
  if (url.username || url.password) {
    throw new ConfigError(`${name} must not contain credentials`);
  }
  return value.replace(/\/+$/, '');
}

/**
 * Validates AI_BASE_URL (when set) as http/https without embedded credentials.
 */
function parseAiBaseUrl(raw: string | undefined): string | null {
  return parseOptionalHttpUrl('AI_BASE_URL', raw);
}

/**
 * Resolves AI_TRANSCRIBE_MODEL: defaults to 'gemini-3.8-flash' whenever AI_BASE_URL & AI_MODEL
 * are set; setting 'off'/'none'/'false'/'0' disables audio transcription.
 */
function parseAiTranscribeModel(
  raw: string | undefined,
  aiBaseUrl: string | null,
  aiModel: string | null
): string | null {
  const trimmed = raw?.trim();
  if (trimmed) {
    if (['off', 'none', 'false', '0'].includes(trimmed.toLowerCase())) return null;
    return trimmed;
  }
  return aiBaseUrl && aiModel ? 'gemini-3.8-flash' : null;
}

/**
 * Parses RATE_LIMIT_MAX, the general request limit per client address and 15 minutes. Unset means
 * 1000; anything but a positive whole number is rejected.
 */
export function parseRateLimitMax(raw: string | undefined): number {
  return parsePositiveInt('RATE_LIMIT_MAX', raw, 1000);
}

function parseCacheDir(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value ? path.resolve(value) : null;
}

const CHROME_EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

/**
 * Parses CLIPPER_EXTENSION_IDS (comma-separated 32-character Chrome extension IDs).
 * Unset or blank means no browser extension origins are allowed.
 */
export function parseClipperExtensionIds(raw: string | undefined): string[] {
  const value = raw?.trim();
  if (!value) return [];
  const ids = value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const invalid = ids.find((id) => !CHROME_EXTENSION_ID_PATTERN.test(id));
  if (invalid) {
    throw new ConfigError(
      `CLIPPER_EXTENSION_IDS must be a comma-separated list of 32-character Chrome extension IDs (a-p), got: ${invalid}`
    );
  }
  return Array.from(new Set(ids));
}

/**
 * Whether WebAuthn passkeys are configured on the server. Requires PUBLIC_URL in production; in
 * development/demo http://localhost origins are allowed.
 */
export function isWebAuthnConfigured(config: Pick<AppConfig, 'publicUrl' | 'nodeEnv'>): boolean {
  return Boolean(config.publicUrl) || config.nodeEnv !== 'production';
}

/**
 * Resolves the WebAuthn Relying Party ID and expected origin for the request.
 * Uses PUBLIC_URL when configured; in non-production environments without PUBLIC_URL, allows only
 * http://localhost origins (any port). Returns null when WebAuthn is not allowed for this request.
 */
export function resolveWebAuthnRp(
  config: Pick<AppConfig, 'publicUrl' | 'nodeEnv'>,
  requestOrigin: string | undefined
): { rpId: string; expectedOrigin: string } | null {
  if (config.publicUrl) {
    const url = new URL(config.publicUrl);
    return { rpId: url.hostname, expectedOrigin: url.origin };
  }
  if (config.nodeEnv !== 'production' && requestOrigin) {
    let url: URL;
    try {
      url = new URL(requestOrigin);
    } catch {
      return null;
    }
    if (url.protocol === 'http:' && url.hostname === 'localhost' && !url.username && !url.password) {
      return { rpId: 'localhost', expectedOrigin: url.origin };
    }
  }
  return null;
}

// Resolved from this module, not process.cwd(): src/config.ts (tsx) and dist/config.js (compiled)
// both sit two levels below the repo root, so this finds client/dist wherever the server is started.
const defaultClientDistPath = fileURLToPath(new URL('../../client/dist', import.meta.url));

/**
 * Builds the application config from environment variables. Throws ConfigError when
 * JOPLIN_SERVER_URL is missing or invalid, or when REQUIRE_2FA is enabled without CACHE_DIR.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV || 'development';
  const cacheDir = parseCacheDir(env.CACHE_DIR);
  const require2fa = parseBoolean('REQUIRE_2FA', env.REQUIRE_2FA, false);
  if (require2fa && !cacheDir) {
    throw new ConfigError(
      'REQUIRE_2FA is true, which requires CACHE_DIR to be set so two-factor authentication state persists across restarts.'
    );
  }
  const aiBaseUrl = parseAiBaseUrl(env.AI_BASE_URL);
  const aiApiKey = env.AI_API_KEY?.trim() || null;
  const aiModel = env.AI_MODEL?.trim() || null;
  return {
    host: env.HOST?.trim() || undefined,
    port: parseInt(env.PORT || '3001', 10),
    joplinServerUrl: parseJoplinServerUrl(env.JOPLIN_SERVER_URL),
    corsOrigin: parseCorsOrigin(env.CORS_ORIGIN, nodeEnv),
    nodeEnv,
    cacheTtlMs: parseInt(env.CACHE_TTL_MS || '30000', 10),
    cacheDir,
    authCacheTtlMs: parseInt(env.AUTH_CACHE_TTL_MS || '300000', 10),
    clientDistPath: defaultClientDistPath,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    publicUrl: parsePublicUrl(env.PUBLIC_URL),
    allowRemoteImages: parseBoolean('ALLOW_REMOTE_IMAGES', env.ALLOW_REMOTE_IMAGES, false),
    cookieSecure: parseCookieSecure(env.COOKIE_SECURE),
    appVersion: parseAppVersion(env.APP_VERSION),
    gitSha: parseGitSha(env.GIT_SHA),
    rateLimitMax: parseRateLimitMax(env.RATE_LIMIT_MAX),
    aiBaseUrl,
    aiApiKey,
    aiModel,
    aiConcurrency: parsePositiveInt('AI_CONCURRENCY', env.AI_CONCURRENCY, 4),
    aiFake: parseBoolean('AI_FAKE', env.AI_FAKE, false),
    aiFakeDelayMs: parseNonNegativeInt('AI_FAKE_DELAY_MS', env.AI_FAKE_DELAY_MS, 0),
    require2fa,
    emailIngestWebhookSecret: env.EMAIL_INGEST_WEBHOOK_SECRET?.trim() || null,
    emailIngestJoplinEmail: env.EMAIL_INGEST_JOPLIN_EMAIL?.trim() || null,
    emailIngestJoplinPassword: env.EMAIL_INGEST_JOPLIN_PASSWORD || null,
    emailIngestNotebookId: env.EMAIL_INGEST_NOTEBOOK_ID?.trim() || null,
    ocrServiceUrl: parseOptionalHttpUrl('OCR_SERVICE_URL', env.OCR_SERVICE_URL),
    ocrServiceSecret: env.OCR_SERVICE_SECRET?.trim() || null,
    ocrInlineWaitMs: parseNonNegativeInt('OCR_INLINE_WAIT_MS', env.OCR_INLINE_WAIT_MS, 4000),
    aiTranscribeModel: parseAiTranscribeModel(env.AI_TRANSCRIBE_MODEL, aiBaseUrl, aiModel),
    clipperExtensionIds: parseClipperExtensionIds(env.CLIPPER_EXTENSION_IDS),
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
