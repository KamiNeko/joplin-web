import compression from 'compression';
import cors from 'cors';
import express, { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';

import { config } from './config.js';
import { errorHandler } from './middleware/error-handler.js';
import { authRouter } from './routes/auth.js';
import { notebooksRouter } from './routes/notebooks.js';
import { notesRouter } from './routes/notes.js';
import { resourcesRouter } from './routes/resources.js';
import { searchRouter } from './routes/search.js';
import { tagsRouter } from './routes/tags.js';

const app = express();

// Security HTTP headers
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

// Cross-Origin Resource Sharing
app.use(
  cors({
    origin: config.corsOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-AUTH'],
  })
);

// Gzip/deflate compression
app.use(compression());

// HTTP request logging
app.use(morgan(config.nodeEnv === 'production' ? 'combined' : 'dev'));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// General Rate Limiting
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per windowMs
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

// Health check endpoint
app.get('/api/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    joplinServer: config.joplinServerUrl,
    environment: config.nodeEnv,
  });
});

// API Routes
app.use('/api/auth', authRouter);
app.use('/api/notebooks', notebooksRouter);
app.use('/api/notes', notesRouter);
app.use('/api/tags', tagsRouter);
app.use('/api/search', searchRouter);
app.use('/api/resources', resourcesRouter);

// Serve frontend static assets if available (production mode)
if (fs.existsSync(config.clientDistPath)) {
  console.log(`[Server] Serving static client build from: ${config.clientDistPath}`);
  app.use(express.static(config.clientDistPath));

  // SPA fallback for frontend client routing
  app.get('*', (req: Request, res: Response) => {
    if (!req.path.startsWith('/api/')) {
      res.sendFile(path.join(config.clientDistPath, 'index.html'));
    } else {
      res.status(404).json({ error: `Cannot ${req.method} ${req.path}` });
    }
  });
} else {
  // Catch 404 for unmatched API routes
  app.use('/api/*', (req: Request, res: Response) => {
    res.status(404).json({ error: `Endpoint not found: ${req.method} ${req.originalUrl}` });
  });
}

// Global error handler
app.use(errorHandler);

// Start server
const server = app.listen(config.port, () => {
  console.log('====================================================');
  console.log(` Joplin Web Backend Server running on port ${config.port}`);
  console.log(` Mode: ${config.nodeEnv}`);
  console.log(` Joplin Server: ${config.joplinServerUrl}`);
  console.log(` CORS Origin: ${JSON.stringify(config.corsOrigin)}`);
  console.log('====================================================');
});

// Graceful shutdown handling
const shutdown = (signal: string) => {
  console.log(`\n[Server] Received ${signal}. Shutting down gracefully...`);
  server.close(() => {
    console.log('[Server] HTTP server closed.');
    process.exit(0);
  });

  // Force shutdown if taking too long
  setTimeout(() => {
    console.error('[Server] Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
