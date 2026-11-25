import compression from 'compression';
import cors from 'cors';
import express, { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import helmet from 'helmet';
import path from 'path';

import type { AppConfig } from './config.js';
import { createAppAuthState } from './middleware/auth.js';
import { errorHandler } from './middleware/error-handler.js';
import { createOriginCheck } from './middleware/origin-check.js';
import { requestLogger } from './middleware/request-logger.js';
import { accountRouter } from './routes/account.js';
import { askRouter } from './routes/ask.js';
import { createAuthRouter } from './routes/auth.js';
import { createClipRouter, createEmailWebhookRouter } from './routes/clip.js';
import type { fetchAndClipUrl } from './services/web-clipper.js';
import { notebooksRouter } from './routes/notebooks.js';
import { notesRouter } from './routes/notes.js';
import { createOrganizeRouter } from './routes/organize.js';
import { createPreferencesRouter } from './routes/preferences.js';
import { resourcesRouter } from './routes/resources.js';
import { searchRouter } from './routes/search.js';
import { tagsRouter } from './routes/tags.js';
import { tasksRouter } from './routes/tasks.js';
import { organizerService, OrganizerService } from './services/organizer.js';
import { PreferencesStore } from './services/preferences-store.js';
import { TwoFactorStore } from './services/two-factor-store.js';
import { noteCache } from './services/note-cache.js';

/**
 * Builds the Content-Security-Policy directives that differ from helmet's defaults.
 *
 * - img-src: attachments are shown through blob: URLs (SVG through data: URLs); remote https:
 *   images only with ALLOW_REMOTE_IMAGES, because loading them tells the image host who read the
 *   note and when.
 * - upgrade-insecure-requests only when PUBLIC_URL is https: on a plain-HTTP LAN it would rewrite
 *   the app's own requests to https:// and break it.
 * - script-src stays 'self' (helmet's default) and must never allow 'unsafe-inline': blob: URLs of
 *   attachments run in this origin if opened directly.
 */
export function cspDirectives(
  config: Pick<AppConfig, 'allowRemoteImages' | 'publicUrl'>
): Record<string, string[] | null> {
  return {
    'img-src': ["'self'", 'data:', 'blob:', ...(config.allowRemoteImages ? ['https:'] : [])],
    'media-src': ["'self'", 'blob:'],
    'style-src': ["'self'", "'unsafe-inline'"],
    'font-src': ["'self'", 'data:'],
    'object-src': ["'none'"],
    'frame-src': ["'self'", 'blob:'],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'upgrade-insecure-requests': config.publicUrl?.startsWith('https:') ? [] : null,
  };
}

/**
 * Creates the Express application (API, static client, security middleware) for a configuration
 */
export function createApp(
  config: AppConfig,
  deps: { organizer?: OrganizerService; fetchClip?: typeof fetchAndClipUrl } = {}
): Express {
  const organizer = deps.organizer ?? organizerService;
  if (organizer.isEnabled()) {
    organizer.resumeFromDiskOnStartup();
  }
  // Every signed-in session joins its user's shared note cache (CACHE_DIR), whichever login path it took
  const twoFactorStore = new TwoFactorStore(config.cacheDir, (sessionId, userId) =>
    noteCache.bindSession(sessionId, userId)
  );
  if (config.require2fa) {
    twoFactorStore.ensureAuthDir();
  }
  const preferencesStore = new PreferencesStore(config.cacheDir);
  const authState = createAppAuthState();

  const app = express();

  // Behind a reverse proxy, req.ip/req.secure come from X-Forwarded-* only when configured
  app.set('trust proxy', config.trustProxy);

  // Security HTTP headers
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: config.corsOrigin ? 'cross-origin' : 'same-origin' },
      contentSecurityPolicy: { directives: cspDirectives(config) },
      // Never send page URLs to other sites (helmet's default, stated explicitly)
      referrerPolicy: { policy: 'no-referrer' },
    })
  );

  // Cross-Origin Resource Sharing
  app.use(
    cors({
      origin: config.corsOrigin,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-API-AUTH', 'X-File-Name', 'X-File-Type'],
    })
  );

  // Gzip/deflate compression
  app.use(compression());

  // HTTP request logging
  app.use(requestLogger(config.nodeEnv === 'production'));

  // Body parsing
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // General Rate Limiting
  const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: config.rateLimitMax, // Requests per client address and window (RATE_LIMIT_MAX, default 1000)
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests from this IP, please try again later.' },
  });
  app.use('/api/', generalLimiter);

  // Specific Rate Limiting for Auth
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 30, // Limit login attempts
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts, please try again later.' },
  });
  app.use('/api/auth/login', authLimiter);

  const twoFactorLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    skip: (req) => req.method === 'GET',
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many two-factor authentication requests, please try again later.' },
  });
  app.use('/api/auth/2fa', twoFactorLimiter);

  // CSRF protection for cookie-authenticated writes
  app.use('/api/', createOriginCheck(config));

  // Attach per-instance configuration, 2FA store, preferences store, and session validation cache
  app.use('/api/', (req, _res, next) => {
    req.appConfig = config;
    req.twoFactorStore = twoFactorStore;
    req.preferencesStore = preferencesStore;
    req.authState = authState;
    next();
  });

  // Health check endpoint (public: build metadata only, never configuration or secrets)
  app.get('/api/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      version: config.appVersion,
      commit: config.gitSha,
    });
  });

  // API Routes
  app.use('/api/auth', createAuthRouter(config, twoFactorStore));
  app.use('/api/account', accountRouter);
  app.use('/api/notebooks', notebooksRouter);
  app.use('/api/notes', notesRouter);
  app.use('/api/organize', createOrganizeRouter(organizer));
  app.use('/api/preferences', createPreferencesRouter(preferencesStore));
  app.use('/api/tasks', tasksRouter);
  app.use('/api/ai', askRouter);
  app.use(
    '/api/webhooks',
    express.raw({
      type: ['message/rfc822', 'text/plain', 'application/octet-stream'],
      limit: '25mb',
    }),
    createEmailWebhookRouter(config)
  );
  app.use('/api/tags', tagsRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/resources', resourcesRouter);
  app.use('/api', createClipRouter({ fetchClip: deps.fetchClip }));

  // Serve frontend static assets if available (production mode)
  if (fs.existsSync(config.clientDistPath)) {
    console.log(`[Server] Serving static client build from: ${config.clientDistPath}`);
    app.use(
      express.static(config.clientDistPath, {
        setHeaders: (res, filePath) => {
          // Vite puts a content hash into every file name under assets/, so they never change
          if (path.relative(config.clientDistPath, filePath).startsWith(`assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      })
    );

    // SPA fallback for frontend client routing
    app.get('/{*splat}', (req: Request, res: Response) => {
      if (!req.path.startsWith('/api/')) {
        // `root` keeps the dotfiles check to the relative name, so a build path such as .claude/worktrees/... still works
        // index.html names the current asset hashes, so browsers must revalidate it on every load
        res.setHeader('Cache-Control', 'no-cache');
        res.sendFile('index.html', { root: config.clientDistPath });
      } else {
        res.status(404).json({ error: `Cannot ${req.method} ${req.path}` });
      }
    });
  } else {
    console.log(`[Server] No client build at ${config.clientDistPath}, serving the API only`);
    // Catch 404 for unmatched API routes
    app.use('/api/*splat', (req: Request, res: Response) => {
      res.status(404).json({ error: `Endpoint not found: ${req.method} ${req.originalUrl}` });
    });
  }

  // Global error handler
  app.use(errorHandler);

  return app;
}
