import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startMockJoplinServer, type MockItem, type MockJoplinServer } from '../demo/mock-joplin-server.js';
import { buildDemoItems, DEMO_EMAIL, DEMO_PASSWORD } from '../demo/seed.js';
import { deserialize, serialize } from '../src/services/serializer.js';
import type { RawJoplinItem } from '../src/types/index.js';

/**
 * Shared setup for API tests: boots the real Express app against the in-memory mock Joplin Server.
 *
 * The backend reads its config when `src/index.ts` is first imported, so a test file can start the
 * app only once. Node's test runner runs every test file in its own process, so files don't share state.
 */

export interface ApiResponse {
  status: number;
  data: any;
  headers: Headers;
}

export interface TestApp {
  mock: MockJoplinServer;
  baseUrl: string;
  /** Session sent as Bearer token by `api()`; set by `login()` */
  session: string;
  /** Calls the backend; string bodies are sent as JSON */
  api(path: string, init?: RequestInit, auth?: boolean): Promise<ApiResponse>;
  /** Logs in with the demo account and stores the session for later `api()` calls */
  login(): Promise<string>;
  close(): Promise<void>;
}

/** Returns a free TCP port on the loopback interface */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * Starts the mock Joplin Server (seeded with the demo items unless `items` is given) and the backend.
 *
 * @param options.pageSize Page size of the mock's children listing (small values exercise pagination)
 * @param options.items Initial mock items, defaults to `buildDemoItems()`
 * @param options.cacheTtlMs Backend cache TTL, defaults to 0 (every read re-syncs with the mock)
 */
export async function startTestApp(
  options: { pageSize?: number; items?: Map<string, MockItem>; cacheTtlMs?: number } = {}
): Promise<TestApp> {
  const mock = await startMockJoplinServer({
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    items: options.items ?? buildDemoItems(),
    pageSize: options.pageSize,
  });
  const port = await freePort();
  // Must be set before the backend's config module is loaded
  process.env.JOPLIN_SERVER_URL = mock.url;
  process.env.PORT = String(port);
  process.env.CACHE_TTL_MS = String(options.cacheTtlMs ?? 0);
  const baseUrl = `http://127.0.0.1:${port}`;
  const { server } = (await import('../src/index.js')) as { server: Server };
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));

  const app: TestApp = {
    mock,
    baseUrl,
    session: '',
    async api(path, init = {}, auth = true) {
      const headers = new Headers(init.headers);
      if (auth && app.session) headers.set('Authorization', `Bearer ${app.session}`);
      if (init.body && typeof init.body === 'string') headers.set('Content-Type', 'application/json');
      const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
      const text = await res.text();
      let data: any = text;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        // binary or plain text response
      }
      return { status: res.status, data, headers: res.headers };
    },
    async login() {
      const res = await app.api(
        '/api/auth/login',
        { method: 'POST', body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }) },
        false
      );
      if (res.status !== 200) throw new Error(`Login failed with ${res.status}`);
      app.session = res.data.sessionId;
      return app.session;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await mock.close();
    },
  };
  return app;
}

/** Reads and parses an item as currently stored on the mock Joplin Server, or undefined if missing */
export function mockItem(mock: MockJoplinServer, id: string): RawJoplinItem | undefined {
  const item = mock.items.get(`${id}.md`);
  return item ? deserialize(item.content.toString('utf8'), `${id}.md`) : undefined;
}

/** Writes an item straight into the mock, as if another Joplin client had synced it */
export function putMockItem(
  mock: MockJoplinServer,
  item: Parameters<typeof serialize>[0] & { id: string },
  updatedTime = Date.now()
): void {
  mock.items.set(`${item.id}.md`, {
    content: Buffer.from(serialize(item), 'utf8'),
    contentType: 'text/plain; charset=utf-8',
    updatedTime,
  });
}

/** All items on the mock of the given type, parsed */
export function mockItemsOfType(mock: MockJoplinServer, type: number): RawJoplinItem[] {
  return [...mock.items.entries()]
    .filter(([name]) => name.endsWith('.md'))
    .map(([name, item]) => deserialize(item.content.toString('utf8'), name))
    .filter((item) => item.type_ === type);
}
