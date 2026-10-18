import { startMockJoplinServer } from './mock-joplin-server.js';
import { buildDemoItems, buildEncryptedDemoItems, DEMO_EMAIL, DEMO_PASSWORD } from './seed.js';

/**
 * Starts the mock Joplin Server with sample notes and the Joplin Web backend pointed at it.
 * Nothing leaves your machine; all changes live in memory until the process stops.
 *
 *   MOCK_JOPLIN_PORT  mock Joplin Server port (default 22300)
 *   PORT              Joplin Web backend port (default 3001)
 *   DEMO_E2EE=1       an account with end-to-end encryption on (read-only in Joplin Web)
 */
const mockPort = Number(process.env.MOCK_JOPLIN_PORT || 22300);
const e2ee = process.env.DEMO_E2EE === '1';
const items = e2ee ? buildEncryptedDemoItems() : buildDemoItems();
const mock = await startMockJoplinServer({ email: DEMO_EMAIL, password: DEMO_PASSWORD, items }, mockPort);

// Must be set before the backend's config module is loaded
process.env.JOPLIN_SERVER_URL = mock.url;
await import('../src/index.js');

console.log(`[Demo] Mock Joplin Server running at ${mock.url}`);
if (e2ee) console.log('[Demo] Account with end-to-end encryption: Joplin Web shows it read-only');
console.log(`[Demo] Sign in with ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
