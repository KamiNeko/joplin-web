import { createApp } from './app.js';
import { config } from './config.js';

const app = createApp(config);

// Start server
export const server = app.listen(config.port, () => {
  console.log('====================================================');
  console.log(` Joplin Web Backend Server running on port ${config.port}`);
  console.log(` Version: ${config.appVersion}${config.gitSha ? ` (${config.gitSha.slice(0, 7)})` : ''}`);
  console.log(` Mode: ${config.nodeEnv}`);
  console.log(` Joplin Server: ${config.joplinServerUrl}`);
  console.log(` CORS Origin: ${JSON.stringify(config.corsOrigin)}`);
  console.log(` Public URL: ${config.publicUrl ?? '(not set)'}`);
  console.log(` Trust proxy: ${JSON.stringify(config.trustProxy)}`);
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
