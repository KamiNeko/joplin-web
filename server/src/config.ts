import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
dotenv.config();

export interface AppConfig {
  port: number;
  joplinServerUrl: string;
  corsOrigin: string | string[];
  nodeEnv: string;
  cacheTtlMs: number;
  authCacheTtlMs: number;
  clientDistPath: string;
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

const parseCorsOrigin = (origin?: string): string | string[] => {
  if (!origin || origin === '*') return '*';
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
 * Builds the application config from environment variables. Throws ConfigError when
 * JOPLIN_SERVER_URL is missing or invalid.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: parseInt(env.PORT || '3001', 10),
    joplinServerUrl: parseJoplinServerUrl(env.JOPLIN_SERVER_URL),
    corsOrigin: parseCorsOrigin(env.CORS_ORIGIN || 'http://localhost:5173'),
    nodeEnv: env.NODE_ENV || 'development',
    cacheTtlMs: parseInt(env.CACHE_TTL_MS || '30000', 10),
    authCacheTtlMs: parseInt(env.AUTH_CACHE_TTL_MS || '300000', 10),
    clientDistPath: path.resolve(process.cwd(), '../client/dist'),
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
