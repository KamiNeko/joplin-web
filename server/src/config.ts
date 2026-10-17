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

const parseCorsOrigin = (origin?: string): string | string[] => {
  if (!origin || origin === '*') return '*';
  if (origin.includes(',')) {
    return origin.split(',').map((o) => o.trim());
  }
  return origin.trim();
};

const rawJoplinUrl = process.env.JOPLIN_SERVER_URL || 'https://notes.alexander-giesler.link';
// Strip trailing slash if present
const cleanJoplinUrl = rawJoplinUrl.replace(/\/+$/, '');

export const config: AppConfig = {
  port: parseInt(process.env.PORT || '3001', 10),
  joplinServerUrl: cleanJoplinUrl,
  corsOrigin: parseCorsOrigin(process.env.CORS_ORIGIN || 'http://localhost:5173'),
  nodeEnv: process.env.NODE_ENV || 'development',
  cacheTtlMs: parseInt(process.env.CACHE_TTL_MS || '30000', 10),
  authCacheTtlMs: parseInt(process.env.AUTH_CACHE_TTL_MS || '300000', 10),
  clientDistPath: path.resolve(process.cwd(), '../client/dist'),
};

if (!process.env.JOPLIN_SERVER_URL) {
  console.warn(`[Config] JOPLIN_SERVER_URL not set in environment, using default: ${config.joplinServerUrl}`);
}
